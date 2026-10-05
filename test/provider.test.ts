import { expect, test } from 'bun:test';

import { freeModels, v2FreeModels, type CatalogModel } from '../src/backend.ts';
import { toProviderModels } from '../src/provider.ts';

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