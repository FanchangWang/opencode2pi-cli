import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';

import type { Backend, CatalogModel } from './backend.ts';
import { atomicWrite } from './atomic.ts';
import { MODEL_PREFIX } from './backend.ts';
import { DEFAULT_FILTERS, hiddenFromStore, loadFilters, sameFilters, type ProbeFilters } from './filters.ts';
import { loadHealth, type HealthStore } from './health.ts';
import { resolveDataDirectory } from './platform.ts';
import { killTree, locateOpencode, openLog, startBackend, type BackendRuntime } from './runtime.ts';
import { createServer, type LocalProxyServer } from './server.ts';
import { systemProxyEnvironment } from './system-proxy.ts';

const DEFAULT_PORT = 41980;

/** How long the dedicated agent may take to appear in a freshly started v2 server. */
const AGENT_POLL_ATTEMPTS = 120;
const AGENT_POLL_GAP_MS = 500;

/** Models trusted to repair another model's malformed envelope, best first. */
const TRANSLATOR_ORDER = ['oc-big-pickle', 'oc-nemotron-3.5-lightning-free', 'oc-space-bunny-free', 'oc-mimo-v2.6-flash-free'];

export type RuntimePhase = 'starting' | 'ready' | 'error' | 'stopped';

export interface RuntimeState {
  readonly phase: RuntimePhase;
  readonly message: string;
  readonly endpoint: string;
  readonly port: number;
  readonly opencodeVersion: string;
  readonly v2: boolean;
  readonly catalog: readonly CatalogModel[];
  readonly health: HealthStore;
  readonly chatOnly: ReadonlySet<string>;
  /** What the user chose to keep out of the roster. Empty by default. */
  readonly filters: ProbeFilters;
  /** Ids the current filters remove from the roster. */
  readonly hidden: ReadonlySet<string>;
}

interface Runtime {
  child: ChildProcess;
  backend: Backend;
  server: LocalProxyServer;
  stop: () => Promise<void>;
}

let runtime: Runtime | undefined;
let key = '';
let refCount = 0;
let boot: Promise<void> | undefined;

const listeners: ((state: Readonly<RuntimeState>) => void)[] = [];

let current: RuntimeState = {
  phase: 'starting',
  message: '正在启动',
  endpoint: '',
  port: 0,
  opencodeVersion: '',
  v2: false,
  catalog: [],
  health: {},
  chatOnly: new Set(),
  filters: DEFAULT_FILTERS,
  hidden: new Set(),
};


/** Publish a state change to every subscriber (doctor, status, the TUI). */
function update(patch: Partial<RuntimeState>): void {
  current = { ...current, ...patch };
  for (const listener of listeners) listener(current);
}

export function state(): Readonly<RuntimeState> {
  return current;
}

export function subscribe(callback: (state: Readonly<RuntimeState>) => void): () => void {
  listeners.push(callback);
  return () => {
    const index = listeners.indexOf(callback);
    if (index >= 0) listeners.splice(index, 1);
  };
}

/**
 * The bearer token for the local proxy.
 *
 * In-process and never written to disk: the listener binds to 127.0.0.1 and dies
 * with omp, so a persisted token would only ever outlive the thing it guards.
 */
export function apiKey(): string {
  if (!key) key = randomBytes(32).toString('hex');
  return key;
}

/**
 * Whether the isolated `opencode serve` process is still running.
 *
 * A crashed child is a real state, not a hypothetical: the model list stays on
 * disk but every request now fails, and doctor has to be able to say so.
 */
export function serveAlive(): boolean {
  return runtime !== undefined && runtime.child.exitCode === null && runtime.child.signalCode === null;
}

/**
 * Health records, published so `doctor` and `status` read one source of truth.
 *
 * The hidden set is recomputed here rather than at each call site: it is a
 * function of health and filters only, and deriving it in one place is what
 * keeps "quota never hides a model" true everywhere.
 */
export function publishHealth(health: HealthStore): void {
  update({ health, hidden: hiddenFromStore(health, current.filters) });
}

/**
 * Publish a chat-only set decided by a probe, and report whether it changed.
 *
 * A change is what forces the provider to be rewritten: `supportsTools` is
 * baked into the registered model rows, so only a second `registerProvider` call
 * can carry the new verdict into the model registry.
 */
export function publishChatOnly(chatOnly: ReadonlySet<string>): boolean {
  const changed = current.chatOnly.size !== chatOnly.size
    || [...chatOnly].some(id => !current.chatOnly.has(id));
  update({ chatOnly });
  return changed;
}

/**
 * Adopt the user's filter choice, and report whether the roster changed.
 *
 * Nothing here decides anything: the caller has already asked, and this only
 * records the answer and recomputes what it hides.
 */
export function publishFilters(filters: ProbeFilters): boolean {
  const changed = !sameFilters(current.filters, filters);
  update({ filters, hidden: hiddenFromStore(current.health, filters) });
  return changed;
}

let publishProvider: (() => void) | undefined;

/** Install the callback that re-registers the provider after a probe changed it. */
export function onProviderRefresh(callback: () => void): void {
  publishProvider = callback;
}

/** Re-register the provider from the current state. A no-op until the host installs one. */
export function refreshProvider(): void {
  publishProvider?.();
}

function validPort(value: string | undefined): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined;
}

function isAddressInUse(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === 'EADDRINUSE';
}

function listen(server: LocalProxyServer, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}

/**
 * Confirm this runtime serves *our* agent, not a user's build agent.
 *
 * v2 registers config agents asynchronously shortly after startup, so the check
 * polls instead of reading once; v1 answers immediately.
 */
async function assertDedicatedAgent(backend: Backend, v2: boolean): Promise<void> {
  const hasAgent = (agents: unknown) => Array.isArray(agents)
    && (agents as { name?: string }[]).some(agent => agent.name === 'buddy-bridge');
  if (!v2) {
    if (!hasAgent(await backend.request('/agent'))) throw new Error('Dedicated approval-gated agent missing');
    return;
  }
  let agents: unknown = [];
  for (let attempt = 0; attempt < AGENT_POLL_ATTEMPTS; attempt++) {
    try {
      const payload = await backend.request('/api/agent');
      agents = payload && typeof payload === 'object' && 'data' in payload ? (payload as { data: unknown }).data : [];
    } catch { agents = []; }
    if (hasAgent(agents)) return;
    await new Promise<void>(resolve => setTimeout(resolve, AGENT_POLL_GAP_MS));
  }
  if (!hasAgent(agents)) throw new Error('Dedicated approval-gated agent missing');
}

/**
 * The free-model catalog: live when OpenCode answers, cached otherwise.
 *
 * The cache is a set of facts about the catalog only — the OpenCode runtime is
 * always (re)started here, so a stale cache never serves live traffic. Only
 * caches written with the current `oc-` ids are accepted; anything else is
 * treated as absent.
 */
async function loadCatalog(backend: Backend, dataDir: string): Promise<CatalogModel[]> {
  const cacheFile = `${dataDir}/models-cache.json`;
  const readCache = async (): Promise<CatalogModel[] | null> => {
    try {
      const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')) as { models?: CatalogModel[] };
      if (!Array.isArray(cache.models) || !cache.models.length) return null;
      if (!String(cache.models[0]?.id ?? '').startsWith(MODEL_PREFIX)) return null;
      return cache.models;
    } catch { return null; }
  };
  try {
    const catalog = await backend.models();
    if (catalog.length) {
      await atomicWrite(cacheFile, JSON.stringify({ savedAt: new Date().toISOString(), models: catalog })).catch(() => {});
      return catalog;
    }
    throw new Error('No free text models found; existing list preserved');
  } catch (error) {
    const cached = await readCache();
    if (cached?.length) return cached;
    throw error;
  }
}

/**
 * Start the local chain: locate OpenCode, launch its isolated server, read the
 * catalog, then open the local proxy.
 *
 * The order is the contract. `baseUrl` must be a real listening port before the
 * provider is registered, and the provider is registered by the caller — so this
 * resolves only once a working endpoint exists, or throws with the reason why.
 */
async function boot_(): Promise<void> {
  const dataDir = resolveDataDirectory();
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  // The stored filter choice is part of what the roster is, so it is read before
  // the provider is registered rather than applied on the next probe.
  update({ filters: await loadFilters(), health: await loadHealth() });

  update({ phase: 'starting', message: '正在检查 OpenCode' });

  // The model catalog refresh at startup still needs the upstream, but a machine
  // without a manual proxy must not be blocked by one. An explicit
  // OPENCODE_ZEN_CLI_PROXY=1 stays strict.
  const override = process.env.OPENCODE_ZEN_CLI_PROXY;
  const settingsFile = `${dataDir}/settings.json`;
  let saved: { useSystemProxy?: unknown } = {};
  try { saved = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as { useSystemProxy?: unknown }; } catch { /* no saved settings */ }
  const useSystemProxy = override === '0' ? false
    : override === '1' ? true
    : saved.useSystemProxy === true || (process.platform === 'win32' && saved.useSystemProxy !== false);
  let proxyEnv: Record<string, string>;
  try {
    proxyEnv = await systemProxyEnvironment(useSystemProxy);
  } catch (error) {
    if (useSystemProxy && override === '1') throw error;
    proxyEnv = await systemProxyEnvironment(false);
    update({ message: `未检测到可用的系统代理，改为直连：${(error as Error).message}` });
  }

  const found = await locateOpencode();
  update({ message: `使用 OpenCode ${found.version}` });

  const log = await openLog(dataDir);
  let backendRuntime: BackendRuntime;
  try {
    update({ message: '正在启动隔离模型服务' });
    backendRuntime = await startBackend(found.file, dataDir, log, proxyEnv);
    await assertDedicatedAgent(backendRuntime.backend, backendRuntime.v2);
  } catch (error) {
    log.end();
    throw error;
  }
  const server = createServer({
    key: apiKey(),
    backend: { complete: (request, signal, meta) => backendRuntime.backend.complete(request, signal, meta) },
    getModels: () => current.catalog,
    status: () => current,
  });
  const stop = async (): Promise<void> => {
    server.abortAll();
    server.closeAllConnections();
    server.close();
    await backendRuntime.stop();
    log.end();
  };

  try {
    const catalog = await loadCatalog(backendRuntime.backend, dataDir);
    if (!catalog.length) throw new Error('免费模型目录为空，且没有可用的缓存');
    // Translation runs a second model whose only job is the response shape. A
    // chat-only model cannot help, and the failing model itself must not be asked
    // twice in a row, so the order below is a preference, not a requirement.
    backendRuntime.backend.translator = failed => {
      const usable = catalog.filter(m => m.toolcall === true && !current.chatOnly.has(m.id)).map(m => m.id);
      const candidates = usable.filter(id => id !== failed);
      return TRANSLATOR_ORDER.find(id => candidates.includes(id)) ?? candidates[0] ?? null;
    };
    const requested = validPort(process.env.OPENCODE_ZEN_CLI_PORT);
    let bound: number;
    try {
      bound = await listen(server, requested ?? DEFAULT_PORT);
    } catch (error) {
      // An explicit port is a promise: a conflict there is a startup failure the
      // user must see. The default port yields instead, so a leftover proxy
      // never keeps omp from starting.
      if (requested || !isAddressInUse(error)) throw error;
      bound = await listen(server, 0);
    }
    runtime = { child: backendRuntime.child, backend: backendRuntime.backend, server, stop };
    update({
      phase: 'ready',
      message: `运行中 · ${catalog.length} 个免费模型`,
      endpoint: `http://127.0.0.1:${bound}/v1`,
      port: bound,
      opencodeVersion: backendRuntime.version,
      v2: backendRuntime.v2,
      catalog,
    });
  } catch (error) {
    await stop();
    throw error;
  }
}

export interface Lifecycle {
  /** Start the chain if it is not already up; join the existing one otherwise. */
  acquire: () => Promise<void>;
  /** Drop one reference; stop the chain when the last one is gone. */
  release: () => Promise<void>;
}

/**
 * Reference-counted ownership of one shared runtime.
 *
 * Every main session acquires once; the chain stops when the last one releases,
 * because a subagent closing must not take the parent's server down. Concurrent
 * callers share one boot promise, and a failed boot is not memoized — the next
 * `acquire` retries from scratch instead of inheriting a dead handle.
 */
export function createLifecycle(start: () => Promise<() => Promise<void>>): Lifecycle {
  let stop: (() => Promise<void>) | undefined;
  let boot: Promise<void> | undefined;
  let refs = 0;
  return {
    async acquire(): Promise<void> {
      if (boot) { await boot; refs += 1; return; }
      refs = 1;
      boot = start().then(teardown => { stop = teardown; }, error => { boot = undefined; throw error; });
      await boot;
    },
 async release(): Promise<void> {
      if (refs > 0) refs -= 1;
      if (refs > 0) return;
      boot = undefined;
      const teardown = stop;
      stop = undefined;
      if (teardown) await teardown();
    },
 };
}

const lifecycle = createLifecycle(async () => {
  await boot_();
  const active = runtime;
  if (!active) throw new Error('runtime not started');
  return async () => {
    try { await active.stop(); }
    catch (error) { console.error(`opencode-zen-cli shutdown: ${(error as Error).message}`); }
  };
});

export async function acquire(): Promise<void> {
  try {
    await lifecycle.acquire();
  } catch (error) {
    update({ phase: 'error', message: (error as Error).message, endpoint: '', port: 0 });
    throw error;
  }
}

/** Release one reference; the chain stops when the last one is gone. */
export async function release(): Promise<void> {
  if (state().phase === 'error' || state().phase === 'stopped') return;
  await lifecycle.release();
  if (state().phase === 'ready') update({ phase: 'stopped', message: '已停止' });
}

/** Synchronous last resort for `process.on('exit')`: kill the child, nothing else. */
export function killOnExit(): void {
  process.once('exit', () => {
    const child = runtime?.child;
    if (child) killTree(child);
  });
}