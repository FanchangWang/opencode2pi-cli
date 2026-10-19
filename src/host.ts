/**
 * The host boundary.
 *
 * This extension is loaded by two hosts, and their extension APIs are not the
 * same object — checked against the hosts' own sources, not assumed:
 *
 *   omp (`@oh-my-pi/pi-coding-agent`, `extensibility/extensions/`)
 *     `logger` on the API, `setLabel(label)`, `ctx.agent.kind`, `ui.select` with
 *     `{label, description}`, per-model `thinking: { mode: 'effort', efforts }`,
 *     and `supportsTools` honored by the registry's custom-model builder.
 *
 *   pi (`@earendil-works/pi-coding-agent` 1.3.0, `core/extensions/`)
 *     **no logger at all**, `setLabel(entryId, label)` (a session-entry label,
 *     not an extension one), **no `agent` on the context**, `ui.select` with bare
 *     `string[]`, per-model `thinkingLevelMap`, and no tool-capability field.
 *
 * Everything that differs is named here so the sharing layer stays host-blind.
 * The one thing that does *not* differ is `registerProvider`: both hosts accept
 * the same `{ baseUrl, api, apiKey, authHeader, models }` shape, which is why this
 * boundary is a handful of small functions rather than an abstraction.
 */

import type { ExtensionAPI, ProviderModelConfig } from '@oh-my-pi/pi-coding-agent';

export type HostName = 'omp' | 'pi';

/**
 * The per-model config keys whose shape or meaning differs between hosts.
 *
 * `thinking` is omp's effort block; `thinkingLevelMap` is pi's level-to-level
 * map, and a level it omits is one it does not offer. `supportsTools` is omp-only
 * (see `honoursToolFlag`), so a host that ignores it must leave the key out
 * rather than hand pi's schema a property it does not declare.
 */
export interface ModelProjection {
  readonly thinking?: ProviderModelConfig['thinking'];
  readonly thinkingLevelMap?: Record<string, string | null>;
  readonly supportsTools?: boolean;
}

/** A log sink that never throws: a diagnostic must not fail the thing it reports on. */
export interface HostLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** One row of a single-choice menu. Normalized to the richer shape, on purpose. */
export interface SelectItem {
  readonly label: string;
  readonly description?: string;
}

export interface Host {
  readonly name: HostName;
  readonly logger: HostLogger;
  /** Name the extension in the host's UI. pi has no extension label to set. */
  labelExtension(label: string): void;
  /**
   * Whether this session is the top-level one.
   *
   * `session_shutdown` fires for task/eval/advisor sub-sessions too, and the
   * first one to exit must not take the parent's server down. omp states the
   * agent identity; pi's context has none, and its shutdown reasons are session
   * lifecycle events (`quit`/`reload`/`new`/`resume`/`fork`), so every pi
   * shutdown counts as the top-level one.
   */
  isMainSession(ctx: unknown): boolean;
  /** Single-choice menu, resolving to the chosen item's `label`. */
  select(ctx: unknown, title: string, items: readonly SelectItem[]): Promise<string | undefined>;
  /**
   * One model's host-specific config keys.
   *
   * `efforts` are the levels the model actually offers, weakest first, and the
   * caller passes an empty list when the model has no effort axis at all.
   * `supportsTools` is the verdict the registry is meant to carry.
   */
  modelProjection(efforts: readonly string[], supportsTools: boolean): ModelProjection;
  /** Whether a per-model `supportsTools: false` actually reaches the registry. */
  readonly honoursToolFlag: boolean;
  /** Replay notes buffered because the host has no logger. A no-op on omp. */
  flushNotes(ctx: unknown): void;
}

/** omp's `ui.select`, which already takes the richer row shape. */
type OmpSelect = (title: string, items: readonly SelectItem[], opts?: unknown) => Promise<string | undefined>;

/** pi's `ui.select`, which takes bare labels. */
type PiSelect = (title: string, options: string[], opts?: unknown) => Promise<string | undefined>;

/**
 * `ctx.ui.select` off an opaque host context.
 *
 * Both hosts hand the extension an untyped context, so the two hops are narrowed
 * with `in`/`typeof` rather than cast; what comes back is the untyped function
 * itself, because its *signature* is the one part a guard cannot check.
 */
function rawUiSelect(ctx: unknown): unknown {
  if (ctx === null || typeof ctx !== 'object' || !('ui' in ctx)) return undefined;
  const ui = ctx.ui;
  if (ui === null || typeof ui !== 'object' || !('select' in ui)) return undefined;
  const select = ui.select;
  return typeof select === 'function' ? select : undefined;
}

/** `ctx.agent.kind`, or `undefined` on a host that carries no agent identity. */
function agentKind(ctx: unknown): unknown {
  if (ctx === null || typeof ctx !== 'object' || !('agent' in ctx)) return undefined;
  const agent = ctx.agent;
  if (agent === null || typeof agent !== 'object' || !('kind' in agent)) return undefined;
  return agent.kind;
}

function ompHost(api: ExtensionAPI | undefined): Host {
  // No API object at all (a module imported on its own, as the tests do): a note
  // still has to land somewhere a human will see it.
  const logger: HostLogger = api?.logger
    ?? { info: message => console.error(message), warn: message => console.error(message) };
  return {
    name: 'omp',
    logger,
    // omp's `setLabel(label)` names the extension itself. A label is decoration:
    // a host that refuses it must not take the startup path down with it.
    labelExtension: label => {
      try { api?.setLabel(label); } catch { /* decoration, never fatal */ }
    },
    isMainSession: ctx => agentKind(ctx) === 'main',
    select: async (ctx, title, items) => {
      const select = rawUiSelect(ctx);
      if (select === undefined) return undefined;
      // The guard proved a function; the parameter shape is omp's declaration.
      const call = select as OmpSelect;
      return call(title, items);
    },
    modelProjection: (efforts, supportsTools) => {
      // omp renders the effort axis as a mode block. The six strings are the
      // enum's own members, but a plain string is not readable as a `const enum`
      // member, so this is the one place the two vocabularies meet (provider.ts).
      const thinking = efforts.length
        ? ({ mode: 'effort', efforts: [...efforts], defaultLevel: efforts[0]! } as ProviderModelConfig['thinking'])
        : undefined;
      return { ...(thinking ? { thinking } : {}), supportsTools };
    },
    honoursToolFlag: true,
    flushNotes: () => { /* omp has a real logger; nothing is buffered */ },
  };
}

function piHost(): Host {
  const lines: string[] = [];
  // pi 1.3.0 gives extensions no logging sink, and dropping the startup summary
  // would leave a silent extension that registers a provider and says nothing.
  // Notes are replayed through the first command invocation, which is the only
  // surface pi offers; failures are kept rather than thrown.
  const logger: HostLogger = {
    info: message => { lines.push(message); },
    warn: message => { lines.push(message); },
  };
  return {
    name: 'pi',
    logger,
    // pi's `setLabel(entryId, label)` labels a session entry, which is a
    // different concept entirely; there is no extension label to set.
    labelExtension: () => {},
    isMainSession: () => true,
    select: async (ctx, title, items) => {
      const select = rawUiSelect(ctx);
      if (select === undefined) return undefined;
      const call = select as PiSelect;
      // The label doubles as the key the callers dispatch on, so it stays the
      // prefix and the answer is folded back to it before being returned.
      const choice = await call(
        title,
        items.map(item => (item.description ? `${item.label} — ${item.description}` : item.label)),
      );
      if (choice === undefined) return undefined;
      const matched = items.find(
        item => choice === item.label || choice === `${item.label} — ${item.description}`,
      );
      return matched?.label ?? choice;
    },
    modelProjection: (efforts, _supportsTools) => {
      // pi's provider config has no `thinking` block; it takes a level-to-level
      // map, and a level it does not list is simply not offered. `supportsTools`
      // is deliberately absent: pi's schema does not declare it.
      return efforts.length
        ? { thinkingLevelMap: Object.fromEntries(efforts.map(effort => [effort, effort])) }
        : {};
    },
    honoursToolFlag: false,
    flushNotes: ctx => {
      const pending = lines.splice(0, lines.length);
      if (pending.length === 0 || ctx === null || typeof ctx !== 'object' || !('ui' in ctx)) return;
      const ui = ctx.ui;
      if (ui === null || typeof ui !== 'object' || !('notify' in ui) || typeof ui.notify !== 'function') return;
      for (const line of pending) ui.notify(line);
    },
  };
}

/**
 * Pick the adapter for the API object the host handed the factory.
 *
 * Feature detection rather than a host name: omp is the only one that carries a
 * logger, and the object itself is the only thing that knows. An unattributable
 * caller (a test importing a module directly) gets the omp shape, which is the
 * shape this extension is typed against.
 */
export function detectHost(api: unknown): Host {
  // Nothing to read at all is not evidence of pi; it is the absent case, and it
  // takes the same shape `host()` falls back to.
  if (api === null || typeof api !== 'object') return ompHost(undefined);
  // omp carries a logger on the API object; pi carries none at all. That single
  // feature is the whole discriminator, so there is no second guess to make.
  const logger = 'logger' in api ? api.logger : undefined;
  if (logger !== null && logger !== undefined && typeof logger === 'object') {
    return ompHost(api as ExtensionAPI);
  }
  return piHost();
}

let active: Host | undefined;

/** Adopt the host, once, at the top of the extension factory. */
export function installHost(api: unknown): Host {
  active = detectHost(api);
  return active;
}

/**
 * The host in play.
 *
 * Falls back to the omp shape when nothing installed one, so a module can be
 * imported and exercised on its own — the unit tests do exactly that.
 */
export function host(): Host {
  return active ?? ompHost(undefined);
}
