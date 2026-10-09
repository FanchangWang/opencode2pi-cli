import { expect, test } from 'bun:test';

import type { CatalogModel } from '../src/backend.ts';
import { DEFAULT_FILTERS, hiddenChanged, hiddenFromStore, hiddenModels, type ProbeFilters } from '../src/filters.ts'
import type { HealthStore, ProbeResult } from '../src/health.ts';
import { toProviderModels } from '../src/provider.ts';

function verdict(modelId: string, kind: ProbeResult['kind']): ProbeResult {
  return { modelId, kind, health: 'ok', detail: '', checkedAt: Date.now(), terminalFailures: 0, transientFailures: 0, latencyMs: 1, toolsMs: 1, chatOnly: false };
}

const ALL_OFF: ProbeFilters = { hideRegionBlocked: false, hideFailed: false };
const REGION_ONLY: ProbeFilters = { hideRegionBlocked: true, hideFailed: false };
const FAILED_TOO: ProbeFilters = { hideRegionBlocked: true, hideFailed: true };

test('the default hides nothing, whatever the verdicts are', () => {
  const results = [verdict('oc-a', 'REGION_BLOCKED'), verdict('oc-b', 'MODEL_GONE'), verdict('oc-c', 'UPSTREAM')];
  expect([...hiddenModels(results, DEFAULT_FILTERS)]).toEqual([]);
  expect([...hiddenFromStore({}, DEFAULT_FILTERS)]).toEqual([]);
});

test('a quota pause or an unreachable local server never hides a model', () => {
  // Measured 2026-10-06: a 429 hit one model while its neighbours answered 200
  // in the same minute. Hiding on that empties the roster during a transient.
  const results = [verdict('oc-a', 'RATE_LIMIT'), verdict('oc-b', 'RUNTIME_MISSING'), verdict('oc-c', 'UNKNOWN')];
  expect([...hiddenModels(results, FAILED_TOO)]).toEqual([]);
});

test('region-blocked alone hides exactly the region-blocked ids', () => {
  const results = [verdict('oc-a', 'REGION_BLOCKED'), verdict('oc-b', 'MODEL_GONE'), verdict('oc-c', 'OK')];
  expect([...hiddenModels(results, REGION_ONLY)]).toEqual(['oc-a']);
});

test('hiding every failure covers what belongs to the model, not the lane', () => {
  const results = [
    verdict('oc-a', 'REGION_BLOCKED'), verdict('oc-b', 'MODEL_GONE'),
    verdict('oc-c', 'REQUEST_REJECTED'), verdict('oc-d', 'UPSTREAM'),
    verdict('oc-e', 'RATE_LIMIT'), verdict('oc-f', 'OK'),
  ];
  expect([...hiddenModels(results, FAILED_TOO)].sort()).toEqual(['oc-a', 'oc-b', 'oc-c', 'oc-d']);
});

test('the stored store yields the same answer as a fresh sweep', () => {
  const store: HealthStore = {
    'oc-a': { health: 'dead', kind: 'REGION_BLOCKED', detail: '', checkedAt: Date.now(), terminalFailures: 0, transientFailures: 0 },
    'oc-b': { health: 'limited', kind: 'RATE_LIMIT', detail: '', checkedAt: Date.now(), terminalFailures: 0, transientFailures: 0 },
  };
  expect([...hiddenFromStore(store, REGION_ONLY)]).toEqual(['oc-a']);
  expect([...hiddenFromStore(store, FAILED_TOO)]).toEqual(['oc-a']);
});

test('the roster is judged by what it hides, not by which switches moved', () => {
  // `/model` shows the list that was last registered. Re-picking the option
  // already in force moves no switch, yet it is the only way a user can get a
  // registry that predates their choice rewritten — so "same filters" must not
  // be able to answer "nothing to do".
  expect(hiddenChanged(new Set(['oc-a']), hiddenFromStore({}, FAILED_TOO))).toBe(true);
  expect(hiddenChanged(new Set<string>(), hiddenFromStore({}, FAILED_TOO))).toBe(false);
  expect(hiddenChanged(new Set(['oc-a']), new Set(['oc-b']))).toBe(true);
  expect(hiddenChanged(new Set(['oc-a']), new Set(['oc-a']))).toBe(false);
});

test('a hidden id leaves the registered model list, the rest are untouched', () => {
  const catalog: CatalogModel[] = [
    { id: 'oc-a', name: 'A', toolcall: true },
    { id: 'oc-b', name: 'B', toolcall: true },
    { id: 'oc-c', name: 'C', toolcall: true },
  ];
  const ids = toProviderModels(catalog, new Set(), new Set(['oc-b'])).map(row => row.id);
  expect(ids).toEqual(['oc-a', 'oc-c']);
  // Hiding must not disturb capability flags for the models that stay.
  expect(toProviderModels(catalog, new Set(), new Set(['oc-b']))[0]!.supportsTools).toBe(true);
});