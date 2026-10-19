import { expect, test } from 'bun:test';

import { freeModels, v2FreeModels, type CatalogModel } from '../src/backend.ts';
import { publishedContextWindow, toProviderModels } from '../src/provider.ts';

/** One free v1 model entry, overridable per field by the fixture under test. */
function v1Model(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Big Pickle',
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: { output: { text: true }, input: { image: false }, toolcall: true, reasoning: true },
    limit: { context: 200000, input: 32000, output: 64000 },
    variants: { high: { reasoningEffort: 'high' }, low: { reasoningEffort: 'low' } },
    ...overrides,
  };
}

function v1Catalog(models: Record<string, unknown>) {
  return { all: [{ id: 'opencode', models }] };
}

test('the v1 free pool drops every model that costs anything or cannot answer with text', () => {
  const catalog = freeModels(v1Catalog({
    free: v1Model(),
    paid: v1Model({ cost: { input: 1, output: 0 } }),
    cached: v1Model({ cost: { input: 0, output: 0, cache: { read: 1, write: 0 } } }),
    noText: v1Model({ capabilities: { output: { text: false } } }),
    deprecated: v1Model({ status: 'deprecated' }),
  }));
  expect(catalog.map(m => m.id)).toEqual(['oc-free']);
});

test('the v1 projection carries prefix, limits, tools, images and reasoning variants', () => {
  const [model] = freeModels(v1Catalog({ 'big-pickle': v1Model({ capabilities: { output: { text: true }, input: { image: true }, toolcall: true, reasoning: true } }) }));
  expect(model).toEqual({
    id: 'oc-big-pickle', name: 'Big Pickle', context: 200000, input: 32000,
    images: true, output: 64000, toolcall: true, reasoning: true,
    variants: { high: { reasoningEffort: 'high' }, low: { reasoningEffort: 'low' } },
  });
});

/** One v2 model row, matching the array-typed shape `GET /api/model` returns. */
function v2Model(overrides: Record<string, unknown> = {}) {
  return {
    providerID: 'opencode', modelID: 'space-bunny-free', name: 'Space Bunny Free',
    status: 'active', enabled: true,
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    capabilities: { output: ['text'], input: ['text'], tools: true },
    limit: { context: 128000, output: 8192 },
    variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }],
    ...overrides,
  };
}

test('the v2 free pool requires provider, status, enabled, a zero cost tier and text output', () => {
  const catalog = v2FreeModels([
    v2Model(),
    v2Model({ providerID: 'openai' }),
    v2Model({ modelID: 'deprecated', status: 'deprecated' }),
    v2Model({ modelID: 'disabled', enabled: false }),
    v2Model({ modelID: 'paid', cost: [{ input: 2, output: 0 }] }),
    v2Model({ modelID: 'no-text', capabilities: { output: ['image'], tools: true } }),
  ]);
  expect(catalog.map(m => m.id)).toEqual(['oc-space-bunny-free']);
  // v2 states no reasoning capability: it is reported false rather than guessed.
  expect(catalog[0]!.reasoning).toBe(false);
});

test('the provider projection keeps ids, tools, images and zero cost exactly as the catalog says', () => {
  const catalog: CatalogModel[] = [
    { id: 'oc-a', name: 'A', toolcall: true, images: true, input: 32000, output: 64000, context: 200000, reasoning: true, variants: { high: { reasoningEffort: 'high' }, low: { reasoningEffort: 'low' } } },
    { id: 'oc-b', name: 'B', toolcall: false, images: false, context: 200000 },
  ];
  const [a, b] = toProviderModels(catalog);
  expect(a!.id).toBe('oc-a');
  expect(a!.input).toEqual(['text', 'image']);
  expect(a!.supportsTools).toBe(true);
  expect(a!.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  expect(a!.contextWindow).toBe(32000);
  expect(a!.maxTokens).toBe(64000);
  expect(b!.input).toEqual(['text']);
  expect(b!.supportsTools).toBe(false);
});

test('a chat-only verdict removes tool support without touching the rest of the row', () => {
  const catalog: CatalogModel[] = [{ id: 'oc-a', name: 'A', toolcall: true }, { id: 'oc-b', name: 'B', toolcall: true }];
  const rows = toProviderModels(catalog, new Set(['oc-a']));
  expect(rows.map(row => row.supportsTools)).toEqual([false, true]);
});

test('efforts ascend, exclude none, and default to the weakest level present', () => {
  const catalog: CatalogModel[] = [{
    id: 'oc-a', name: 'A', reasoning: true,
    variants: {
      off: { reasoningEffort: 'none' },
      max: { reasoningEffort: 'max' },
      low: { reasoningEffort: 'low' },
      high: { reasoningEffort: 'high' },
      medium: { reasoningEffort: 'medium' },
    },
  }];
  const [row] = toProviderModels(catalog);
  expect(row!.thinking?.efforts as readonly string[]).toEqual(['low', 'medium', 'high', 'max']);
  expect(row!.thinking?.defaultLevel as string).toBe('low');
  expect(row!.thinking?.mode).toBe('effort');
});

test('a model without effort variants gets no thinking block and no default level', () => {
  const catalog: CatalogModel[] = [
    { id: 'oc-a', name: 'A', reasoning: true, variants: { off: { reasoningEffort: 'none' } } },
    { id: 'oc-b', name: 'B', reasoning: true, variants: { high: { reasoningEffort: 'high', disabled: true } } },
    { id: 'oc-c', name: 'C', reasoning: false, variants: { high: { reasoningEffort: 'high' } } },
  ];
  for (const row of toProviderModels(catalog)) expect(row.thinking).toBeUndefined();
});

test('an unusable context or output limit falls back instead of publishing a zero', () => {
  const catalog: CatalogModel[] = [
    { id: 'oc-a', name: 'A', context: 0, output: -1 },
    { id: 'oc-b', name: 'B', context: 1.5 as unknown as number, output: undefined },
    { id: 'oc-c', name: 'C', input: 4096 },
  ];
  const rows = toProviderModels(catalog);
  expect(rows[0]).toMatchObject({ contextWindow: 128000, maxTokens: 8192 });
  expect(rows[1]).toMatchObject({ contextWindow: 128000, maxTokens: 8192 });
  // The input limit is the tighter of the two, so it wins over the context window.
  expect(rows[2]!.contextWindow).toBe(4096);
});

test('the mimo context override fires on the feed value, and never silently', () => {
  // The local catalog (a models.dev mirror) publishes 200000 for
  // oc-mimo-v2.6-flash-free; the MiMo model card and the official OpenCode CLI
  // config both declare 1048576 (docs/FINDINGS.md §15, 2026-10-14 改判).
  const notes: string[] = [];
  const [row] = toProviderModels([{ id: 'oc-mimo-v2.6-flash-free', name: 'MiMo', context: 200_000 }], new Set(), new Set(), notes);
  expect(row!.contextWindow).toBe(1_048_576);
  expect(notes.join(' ')).toContain('200000 → 1048576');
  expect(notes.join(' ')).toContain('local override');
});

test('the deepseek-v4.1 override is per id, not per 200000 bucket', () => {
  // opencode2pi 0.6.1 / opencode2dsh #81: the free id publishes 200000 while
  // its paid twin declares 1000000, and a live needle probe recalled at
  // 1,011,668 tokens. Only contextWindow changes; the output cap stays 32000.
  const notes: string[] = [];
  const [row] = toProviderModels(
    [{ id: 'oc-deepseek-v4.1-flash-free', name: 'DeepSeek', context: 200_000, output: 32_000 }],
    new Set(), new Set(), notes,
  );
  expect(row!.contextWindow).toBe(1_048_576);
  expect(row!.maxTokens).toBe(32_000);
  expect(notes.join(' ')).toContain('200000 → 1048576');

  // Another model in the same 200000 bucket has no measurement of its own, so
  // the feed still speaks unchanged.
  const controlNotes: string[] = [];
  const [control] = toProviderModels(
    [{ id: 'oc-glm-5.3-flash-free', name: 'GLM', context: 200_000, output: 32_000 }],
    new Set(), new Set(), controlNotes,
  );
  expect(control!.contextWindow).toBe(200_000);
  expect(controlNotes).toEqual([]);
});

test('the mimo override stops firing once the feed publishes the corrected value', () => {
  // Values match → no note. The entry is not deleted; it stays as a regression
  // guard should the feed drift back to 200000.
  const notes: string[] = [];
  const [row] = toProviderModels([{ id: 'oc-mimo-v2.6-flash-free', name: 'MiMo', context: 1_048_576 }], new Set(), new Set(), notes);
  expect(row!.contextWindow).toBe(1_048_576);
  expect(notes).toEqual([]);
});

test('the override fires even when the feed states nothing usable', () => {
  // Silence is not better than a known-wrong number: the corrected window stands.
  const notes: string[] = [];
  const [row] = toProviderModels([{ id: 'oc-mimo-v2.6-flash-free', name: 'MiMo', context: 0 }], new Set(), new Set(), notes);
  expect(row!.contextWindow).toBe(1_048_576);
  expect(notes).toHaveLength(1);
});

test('no other model is overridden, and no note is written for them', () => {
  const notes: string[] = [];
  const [row] = toProviderModels([{ id: 'oc-other', name: 'Other', context: 200_000 }], new Set(), new Set(), notes);
  expect(row!.contextWindow).toBe(200_000);
  expect(notes).toEqual([]);
});

test('the proxy listing omits the context key unless the catalog states one or an override fires', () => {
  // publishedContextWindow without a fallback keeps the listing's
  // "omit, don't fabricate" rule (server.ts modelList).
  expect(publishedContextWindow({ id: 'oc-a', name: 'A', context: 0 }).contextWindow).toBeUndefined();
  expect(publishedContextWindow({ id: 'oc-a', name: 'A', context: 200_000 }).contextWindow).toBe(200_000);
  expect(publishedContextWindow({ id: 'oc-mimo-v2.6-flash-free', name: 'MiMo', context: 200_000 }).contextWindow).toBe(1_048_576);
});