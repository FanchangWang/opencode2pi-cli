import type { ExtensionAPI, ProviderModelConfig } from '@oh-my-pi/pi-coding-agent';

import type { CatalogModel } from './backend.ts';
import { host } from './host.ts';
import { reasoningEfforts } from './reasoning.ts';

export const PROVIDER = 'opencode-zen-cli';
export const API = 'openai-completions';

type EffortLevel = NonNullable<ProviderModelConfig['thinking']>['efforts'][number];

/**
 * Effort levels, weakest first.
 *
 * `none` is excluded on purpose: it selects "do not reason", which is not a
 * thinking level the host can render or bill differently.
 *
 * `Effort` is a `const enum` in @oh-my-pi/pi-catalog — the same six strings, but
 * the compiler will not read a plain string as an enum member. This is the one
 * place the two vocabularies meet.
 */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as unknown as readonly EffortLevel[];

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Catalog fields this extension knowingly overrides, with the reason.
 *
 * `oc-mimo-v2.6-flash-free` is the audited case: the feed (models.dev, mirrored
 * by the local OpenCode catalog) publishes `limit.context: 200000`, while the
 * MiMo model card and the official OpenCode CLI config both declare 1048576 —
 * opencode2dsh 0.3.11 and opencode2pi 0.3.4 made the same call on 2026-10-14
 * (docs/FINDINGS.md §15).
 *
 * `oc-deepseek-v4.1-flash-free` is the same shape, merged from opencode2pi
 * 0.6.1 and corrected by 0.6.2 (opencode2dsh #81 → #99): models.dev gives the
 * free and paid twins of one canonical model different windows — the free id
 * says 200000 while `deepseek-v4.1-flash` says 1000000. #81's 2026-10-16 probe
 * recalled a needle at 1,011,668 tokens, but the same lane re-probed on
 * 2026-10-20 recalls only at 315,596 and refuses ~326k with
 * `context_length_exceeded`; 1M is no longer served. Declaring 1M is actively
 * harmful: the host compacts at 0.8 × contextWindow (=800k), so a long session
 * grows past the real ceiling without ever compacting. 300000 makes it compact
 * at 240k, and 240k + the 32k output budget is 272k, still below 315,596. Only
 * `contextWindow` is overridden; the feed's 32000 output limit is published
 * unchanged.
 *
 * Applied in {@link publishedContextWindow}; once the feed itself publishes the
 * corrected value the values match and the entry stops firing — it stays as a
 * regression guard rather than being deleted. Every application is recorded in
 * the notes so the override is never silent.
 *
 * Keyed by catalog id, which carries the `oc-` prefix (backend.ts MODEL_PREFIX).
 */
const LOCAL_MODEL_OVERRIDES: Readonly<Record<string, { readonly contextWindow: number; readonly reason: string }>> = {
  'oc-mimo-v2.6-flash-free': {
    contextWindow: 1_048_576,
    reason: 'MiMo model card and official CLI config declare 1048576; the feed publishes 200000',
  },
  'oc-deepseek-v4.1-flash-free': {
    contextWindow: 300_000,
    reason: 'free lane recalls a needle at 315,596 tokens and refuses ~326k with context_length_exceeded (2026-10-20); the feed publishes 200000',
  },
};

/** Only a positive integer limit is worth publishing; anything else is a host default. */
function limit(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

/**
 * The context window the catalog states for one row: the input cap when it
 * publishes one (it is the tighter of the two), otherwise the context limit.
 * `undefined` when it states nothing usable.
 */
function statedWindow(model: CatalogModel): number | undefined {
  const stated = model.input ?? model.context;
  return Number.isInteger(stated) && (stated ?? 0) > 0 ? stated : undefined;
}

export interface ContextWindowDecision {
  /** The window to publish. `undefined` only when nothing was stated and no override fires. */
  readonly contextWindow: number | undefined;
  /** Set exactly when a local override fired — every application leaves a trace. */
  readonly note?: string;
}

/**
 * The context window to publish for one catalog row.
 *
 * Starts from what the catalog states and lets `LOCAL_MODEL_OVERRIDES` correct
 * ids whose published value is known to be wrong. `fallback` stands in when the
 * catalog states nothing usable: the registry passes the host's generic default
 * so `/model` shows a number, while the proxy listing passes nothing and omits
 * the key so omp keeps its own default. An override fires either way — when the
 * feed under-reports, a corrected number beats silence.
 */
export function publishedContextWindow(model: CatalogModel, fallback: number): { readonly contextWindow: number; readonly note?: string };
export function publishedContextWindow(model: CatalogModel): { readonly contextWindow: number | undefined; readonly note?: string };
export function publishedContextWindow(model: CatalogModel, fallback?: number): ContextWindowDecision {
  const base = statedWindow(model) ?? fallback;
  const override = LOCAL_MODEL_OVERRIDES[model.id];
  if (override !== undefined && override.contextWindow !== base) {
    return {
      contextWindow: override.contextWindow,
      note: `limit.context ${base ?? '缺失'} → ${override.contextWindow} (local override: ${override.reason})`,
    };
  }
  return { contextWindow: base };
}

/**
 * A model row handed to `registerProvider`.
 *
 * `supportsTools` is missing from the extension-facing `ProviderModelConfig`
 * declaration but honored by the registry's custom-model builder, and it is the
 * only way to keep omp from dispatching tools to a chat-only model. Declaring it
 * here keeps that a checked property rather than an accidental extra key.
 *
 * `thinkingLevelMap` is the same situation for the other host, which takes a
 * level-to-level map where omp takes a mode block. Only one host's key is ever
 * present in a given row — `host().modelProjection` decides which.
 */
export interface ProviderModelDefinition extends ProviderModelConfig {
  supportsTools?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

export function toProviderModels(catalog: readonly CatalogModel[], chatOnly: ReadonlySet<string> = new Set(), hidden: ReadonlySet<string> = new Set(), notes?: string[]): ProviderModelDefinition[] {
  return catalog.filter(m => !hidden.has(m.id)).map(m => {
    const efforts = EFFORT_ORDER.filter(effort => Object.hasOwn(reasoningEfforts(m), effort));
    const published = publishedContextWindow(m, DEFAULT_CONTEXT_WINDOW);
    if (published.note !== undefined) notes?.push(published.note);
    return {
      id: m.id,
      name: m.name,
      reasoning: m.reasoning === true,
      // The effort axis and the tool flag are the two keys whose shape and
      // meaning differ per host; everything else below is common.
      ...host().modelProjection(efforts, m.toolcall === true && !chatOnly.has(m.id)),
      input: m.images === true ? ['text', 'image'] : ['text'],
      // The free pool is zero-priced by definition; a stale upstream cost must not reach omp.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: published.contextWindow,
      maxTokens: limit(m.output, DEFAULT_MAX_TOKENS),
    };
  });
}

export interface ApplyProviderInput {
  endpoint: string;
  key: string;
  catalog: readonly CatalogModel[];
  chatOnly: ReadonlySet<string>;
  /** Ids the user chose to keep out of the roster. Never applied on our own. */
  hidden?: ReadonlySet<string>;
}

/**
 * Register (or replace) the local provider in omp's model registry.
 *
 * Re-registering the same provider id replaces its whole model list, so this is
 * also how a probe result gets written back: calling it again with a wider
 * `chatOnly` set flips the affected models to `supportsTools: false`.
 *
 * No `fetchDynamicModels`: the catalog is read from the local OpenCode server at
 * boot, and the host's 24h dynamic-model cache would only ever hide it.
 */
export function applyProvider(pi: ExtensionAPI, { endpoint, key, catalog, chatOnly, hidden }: ApplyProviderInput): void {
  // Local overrides fire during the projection above, and every firing is
  // logged here: an override nobody can see is an override nobody can revert
  // once the feed publishes the corrected value on its own.
  const notes: string[] = [];
  const models = toProviderModels(catalog, chatOnly, hidden, notes);
  if (notes.length > 0) host().logger.info(`[${PROVIDER}] 模型目录本地覆盖：${notes.join('；')}`);
  if (!host().honoursToolFlag && chatOnly.size > 0) {
    // The verdict has nowhere to go on this host: its model config has no tool
    // capability field, so a chat-only model keeps being offered tools. Say it
    // once at registration rather than let the write-back look applied.
    host().logger.warn(`[${PROVIDER}] 本宿主不识别 supportsTools，${chatOnly.size} 个仅对话模型无法写回：${[...chatOnly].join(', ')}`);
  }
  pi.registerProvider(PROVIDER, {
    baseUrl: endpoint,
    api: API,
    apiKey: key,
    authHeader: true,
    models,
  });
}
