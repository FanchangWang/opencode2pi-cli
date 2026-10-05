import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { Backend, nativePermissions, v2NativePermissions, v2Ruleset } from './backend.ts';

const exec = promisify(execFile);

// Accept `2.0.22`, `v2.0.22` and `opencode v2.0.22` — whatever the CLI prints.
export function parseVersion(output: string | undefined | null): string | null {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(output ?? '');
  return m?.[1] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(/[+-]/, 1)[0]!.split('.').map(Number);
  const right = b.split(/[+-]/, 1)[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return (left[i] ?? 0) - (right[i] ?? 0);
  }
  return 0;
}

// Where an installed OpenCode is looked up: only what `opencode` resolves to on PATH. No
// directory scanning — if `opencode --version` answers, the user's own install is used as-is.
export function runtimeCandidates(): string[] {
  return ['opencode'];
}

export interface LocateOptions {
  candidates?: readonly string[];
  probe?: (file: string) => Promise<string>;
}

export interface LocatedOpencode {
  file: string;
  version: string;
}

// opencode-zen-cli never installs OpenCode itself: the user owns that install. A candidate only
// counts when `opencode --version` actually answers with a version, and the highest one wins.
export async function locateOpencode(options: LocateOptions = {}): Promise<LocatedOpencode> {
  const candidates = options.candidates ?? runtimeCandidates();
  // Shell resolution, so `opencode` on PATH works whatever its form (npm .cmd wrapper included).
  // The command is a fixed literal (no user input), so the shell-concatenation form carries no
  // injection surface, and it avoids Node's DEP0190 (shell:true with an args array) warning.
  const probe = options.probe ?? (async file => (await exec(`"${file}" --version`, { timeout: 15000, windowsHide: true, shell: true })).stdout.trim());
  const found: LocatedOpencode[] = [], rejected: string[] = [];
  for (const file of candidates) {
    try {
      const version = await probe(file);
      const parsed = parseVersion(version);
      if (!parsed) { rejected.push(`${file}: 无法识别的版本输出（${version || '空'}）`); continue; }
      found.push({ file, version: parsed });
    } catch (e) { rejected.push(`${file}: ${(e as { code?: string; message: string }).code || (e as Error).message}`); }
  }
  found.sort((a, b) => compareVersions(b.version, a.version));
  if (!found.length)
    throw new Error(`未找到可用的 OpenCode。请先安装 OpenCode 并确认 \`opencode -v\` 能输出版本号。已尝试：\n${(rejected.length ? rejected : candidates).map(r => `  - ${r}`).join('\n')}`);
  return found[0]!;
}

export const isolatedConfig = {
  permission: nativePermissions, autoupdate: false, share: 'disabled',
  agent: { 'buddy-chat': { mode: 'primary', description: 'Text-only external conversation', prompt: 'Reply in plain text to the external conversation. No tool use or local actions. Never claim to have executed an action.', permission: nativePermissions }, 'buddy-bridge': { mode: 'primary', description: 'External client inference only',
    prompt: 'You are the reasoning component of an external assistant. Never invoke native OpenCode tools. Describe external tool calls only in the requested JSON response. The external client owns execution and supplies tool results on the next request.',
    permission: nativePermissions } },
};

// OpenCode v2 replaced the v1 agent `prompt`/`permission` map with `system`/`permissions`
// rules, and the global `permission` map with a top-level `permissions` rule list.
export const v2IsolatedConfig = {
  permissions: v2Ruleset(v2NativePermissions), share: 'disabled',
  agents: {
    'buddy-chat': { mode: 'primary', description: 'Text-only external conversation',
      system: 'Reply in plain text to the external conversation. No tool use or local actions. Never claim to have executed an action.',
      permissions: v2Ruleset(v2NativePermissions) },
    'buddy-bridge': { mode: 'primary', description: 'External client inference only',
      system: 'You are the reasoning component of an external assistant. Never invoke native OpenCode tools. Describe external tool calls only in the requested JSON response. The external client owns execution and supplies tool results on the next request.',
      permissions: v2Ruleset(v2NativePermissions) },
  },
};

export interface BackendRuntime {
  backend: Backend;
  stop: () => Promise<void>;
  child: ChildProcess;
  version: string;
  v2: boolean;
}

/** The environment variables a child process inherits: normal OS/network settings only. */
const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC'];

/** Terminate a Windows process tree and wait for `taskkill` to report back. */
function taskkillTree(pid: number | undefined): Promise<void> {
  return new Promise<void>(resolve => {
    if (pid === undefined) return resolve();
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    killer.on('exit', () => resolve());
    killer.on('error', () => resolve());
  });
}

/**
 * Synchronous last resort for a `process.on('exit')` hook, where nothing can be
 * awaited. On Windows this still goes through `taskkill`: a signal would only
 * end the cmd.exe wrapper and orphan the server.
 */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    if (child.pid !== undefined) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).unref();
    return;
  }
  child.kill('SIGKILL');
}

export async function startBackend(binary: string, dataDir: string, logStream: WriteStream, proxyEnv: Record<string, string> = {}): Promise<BackendRuntime> {
  const actualVersion = parseVersion((await exec(`"${binary}" --version`, { timeout: 15000, windowsHide: true, shell: true })).stdout.trim());
  const v2 = Number(actualVersion?.split('.')[0] ?? '0') >= 2;
  const root = path.join(dataDir, 'opencode');
  for (const d of ['config', 'data', 'cache', 'state', 'project']) await fs.mkdir(path.join(root, d), { recursive: true, mode: 0o700 });
  // Preserve only normal OS/network settings, never other providers' keys or OpenCode auth overrides.
  const env: Record<string, string> = {};
  for (const k of INHERITED_ENV) if (process.env[k]) env[k] = process.env[k];
  for (const name of ['config', 'data', 'cache', 'state']) env[`XDG_${name.toUpperCase()}_HOME`] = path.join(root, name);
  Object.assign(env, proxyEnv);
  const password = randomBytes(24).toString('hex');
  Object.assign(env, { OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(v2 ? v2IsolatedConfig : isolatedConfig) });
  // v1 keeps a stale embedded model catalog and needs a forced refresh before the long-lived
  // server starts. v2 fetches the model catalog itself at startup (unless disabled), so the
  // refresh command — which v2 does not recognize — is skipped entirely.
  if (!v2) {
    await exec(`"${binary}" models opencode --refresh --pure`, { cwd: path.join(root, 'project'), env, windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024, shell: true });
  }
  const port = await new Promise<number>((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const n = (s.address() as net.AddressInfo).port; s.close(() => resolve(n)); });
  });
  // v2 dropped the v1 `--pure` serve flag; isolation is carried entirely by the XDG and
  // config-content environment above. A single command string avoids Node's DEP0190 warning;
  // every token is a fixed literal, so there is nothing user-controlled to inject.
  const serveArgs = v2 ? ['serve', '--hostname', '127.0.0.1', '--port', String(port)] : ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)];
  const child = spawn(`"${binary}" ${serveArgs.join(' ')}`, { cwd: path.join(root, 'project'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });
  let failure: Error | undefined;
  child.on('error', e => { failure = e; });
  const backend = new Backend(`http://127.0.0.1:${port}`, password, undefined, message => logStream.write(`${new Date().toISOString()} ${message}\n`), v2);
  const stop = async (): Promise<void> => {
    backend.stopEvents();
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      // `opencode` on Windows is a `.cmd` shim, so `shell: true` puts a cmd.exe
      // wrapper in front of the real server. Signalling the wrapper ends it and
      // leaves the server running: nothing then reports the child as alive, so
      // the tree is torn down by pid instead of by signal.
      await taskkillTree(child.pid);
      return;
    }
    child.kill('SIGTERM');
    await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 4000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  try {
    for (let i = 0; i < 120; i++) {
      if (failure || child.exitCode !== null) throw failure || new Error(`OpenCode exited: ${child.exitCode}`);
      try {
        // v2 readiness is conveyed by the HTTP status of GET /api/info (there is no v1
        // `healthy` field); v1 keeps its health endpoint.
        const health = v2
          ? await backend.request('/api/info', 'GET', undefined, undefined, 1000)
          : await backend.request('/global/health', 'GET', undefined, undefined, 1000);
        const record = (health && typeof health === 'object' ? health : {}) as { version?: string; healthy?: boolean };
        const version = v2 ? record.version : record.healthy ? record.version : undefined;
        if (version) {
          if (parseVersion(version) !== actualVersion) throw new Error('Unexpected OpenCode server version');
          return { backend, stop, child, version, v2 };
        }
      } catch (e) { if ((e as Error).message === 'Unexpected OpenCode server version') throw e; }
      await new Promise<void>(r => setTimeout(r, 500));
    }
    throw new Error('OpenCode startup timed out');
  } catch (e) { await stop(); throw e; }
}

/** Open a log stream on the data directory, rotating a log past the size cap. */
export async function openLog(dataDir: string): Promise<WriteStream> {
  const logFile = path.join(dataDir, 'opencode.log');
  try { if ((await fs.stat(logFile)).size > 5 * 1024 * 1024) await fs.rename(logFile, `${logFile}.previous`); } catch { /* no previous log to rotate */ }
  return createWriteStream(logFile, { flags: 'a', mode: 0o600 });
}