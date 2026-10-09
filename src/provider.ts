import type { ExtensionAPI, ProviderModelConfig } from '@oh-my-pi/pi-coding-agent';

import type { CatalogModel } from './backend.ts';
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

/** Only a positive integer limit is worth publishing; anything else is a host default. */
function limit(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

/**
 * A model row handed to `registerProvider`.
 *
 * `supportsTools` is missing from the extension-facing `ProviderModelConfig`
 * declaration but honored by the registry's custom-model builder, and it is the
 * only way to keep omp from dispatching tools to a chat-only model. Declaring it
 * here keeps that a checked property rather than an accidental extra key.
 */
export interface ProviderModelDefinition extends ProviderModelConfig {
  supportsTools?: boolean;
}

export function toProviderModels(catalog: readonly CatalogModel[], chatOnly: ReadonlySet<string> = new Set(), hidden: ReadonlySet<string> = new Set()): ProviderModelDefinition[] {
  return catalog.filter(m => !hidden.has(m.id)).map(m => {
    const efforts = EFFORT_ORDER.filter(effort => Object.hasOwn(reasoningEfforts(m), effort));
    return {
      id: m.id,
      name: m.name,
      reasoning: m.reasoning === true,
      ...(efforts.length ? { thinking: { mode: 'effort', efforts: [...efforts], defaultLevel: efforts[0]! } } : {}),
      input: m.images === true ? ['text', 'image'] : ['text'],
      supportsTools: m.toolcall === true && !chatOnly.has(m.id),
      // The free pool is zero-priced by definition; a stale upstream cost must not reach omp.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: limit(m.input ?? m.context, DEFAULT_CONTEXT_WINDOW),
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
  pi.registerProvider(PROVIDER, {
    baseUrl: endpoint,
    api: API,
    apiKey: key,
    authHeader: true,
    models: toProviderModels(catalog, chatOnly, hidden),
  });
}