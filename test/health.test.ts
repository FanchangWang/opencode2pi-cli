import { expect, test } from 'bun:test';

import {
  HEALTH_TTL_MS,
  healthFor,
  isStale,
  mergeHealth,
  pruneHealth,
  summarizeHealth,
  TERMINAL_FAILURES_TO_CONDEMN,
  type HealthStore,
  type ProbeResult,
} from '../src/health.ts';

function result(modelId: string, kind: ProbeResult['kind'], health: ProbeResult['health']): ProbeResult {
  return { modelId, kind, health, detail: `${modelId}: ${kind}`, checkedAt: Date.now(), terminalFailures: 0, transientFailures: 0, latencyMs: 1, toolsMs: 1, chatOnly: false };
}

test('one terminal verdict is only a warning; the second one condemns', () => {
  const first = mergeHealth({}, [result('oc-a', 'MODEL_GONE', 'flaky')]);
  expect(first['oc-a']!.health).toBe('flaky');
  expect(first['oc-a']!.terminalFailures).toBe(1);

  const second = mergeHealth(first, [result('oc-a', 'MODEL_GONE', 'flaky')]);
  expect(second['oc-a']!.health).toBe('dead');
  expect(second['oc-a']!.terminalFailures).toBe(TERMINAL_FAILURES_TO_CONDEMN);
});

test('a success clears both counters and revives a condemned model', () => {
  const dead: HealthStore = mergeHealth(mergeHealth({}, [result('oc-a', 'MODEL_GONE', 'flaky')]), [result('oc-a', 'MODEL_GONE', 'flaky')]);
  const revived = mergeHealth(dead, [result('oc-a', 'OK', 'ok')]);
  expect(revived['oc-a']!.health).toBe('ok');
  expect(revived['oc-a']!.terminalFailures).toBe(0);
  expect(revived['oc-a']!.transientFailures).toBe(0);
});

test('a dead verdict survives a transient re-probe but never a fresh transient streak', () => {
  const dead: HealthStore = mergeHealth(mergeHealth({}, [result('oc-a', 'MODEL_GONE', 'flaky')]), [result('oc-a', 'MODEL_GONE', 'flaky')]);
  const afterOutage = mergeHealth(dead, [result('oc-a', 'UPSTREAM', 'flaky')]);
  expect(afterOutage['oc-a']!.health).toBe('dead');
  const afterSuccess = mergeHealth(afterOutage, [result('oc-a', 'OK', 'ok')]);
  expect(afterSuccess['oc-a']!.health).toBe('ok');
});

test('transient failures accumulate without ever reaching dead', () => {
  const store = mergeHealth({}, [
    result('oc-a', 'UPSTREAM', 'flaky'),
    result('oc-a', 'RATE_LIMIT', 'limited'),
    result('oc-a', 'RUNTIME_MISSING', 'limited'),
  ]);
  expect(store['oc-a']!.health).toBe('limited');
  expect(store['oc-a']!.terminalFailures).toBe(0);
  expect(store['oc-a']!.transientFailures).toBe(3);
});

test('a rate limit is a lane fact, not a verdict about the model', () => {
  const store = mergeHealth({}, [result('oc-a', 'RATE_LIMIT', 'limited')]);
  expect(store['oc-a']!.health).toBe('limited');
  expect(store['oc-a']!.health).not.toBe('dead');
});

test('pruning drops every id the current roster no longer carries', () => {
  const store: HealthStore = { 'oc-a': mergeHealth({}, [result('oc-a', 'OK', 'ok')])['oc-a']!, 'oc-retired': mergeHealth({}, [result('oc-retired', 'OK', 'ok')])['oc-retired']! };
  expect(Object.keys(pruneHealth(store, new Set(['oc-a'])))).toEqual(['oc-a']);
});

test('a model the store says nothing about is not counted as a verdict', () => {
  // `status` reports what the last probe found and prints "未探测" for the rest,
  // so a missing record must stay outside the tally rather than becoming a
  // state of its own the roster lines cannot produce.
  expect(summarizeHealth([{ id: 'oc-a' }, { id: 'oc-b' }], mergeHealth({}, [result('oc-a', 'OK', 'ok')])))
    .toBe('✅ 1');
});

test('a verdict goes stale after the TTL, and a missing one is stale at once', () => {
  const fresh = mergeHealth({}, [result('oc-a', 'OK', 'ok')])['oc-a']!;
  expect(isStale(fresh)).toBe(false);
  expect(isStale({ ...fresh, checkedAt: Date.now() - HEALTH_TTL_MS - 1 })).toBe(true);
  // A model added to the catalog since the last sweep is the case `status`
  // probes on the spot rather than reporting a gap.
  expect(isStale(undefined)).toBe(true);
});

test('the summary counts the roster as displayed, not the raw verdicts', () => {
  const roster = [{ id: 'oc-a' }, { id: 'oc-b' }];
  const store: HealthStore = {
    'oc-a': mergeHealth({}, [result('oc-a', 'OK', 'ok')])['oc-a']!,
    'oc-b': mergeHealth(mergeHealth({}, [result('oc-b', 'MODEL_GONE', 'flaky')]), [result('oc-b', 'MODEL_GONE', 'flaky')])['oc-b']!,
  };

  expect(summarizeHealth(roster, store)).toBe('✅ 1  ❌ 1');
});

test('a region block is fatal on the first verdict, unlike a retired model', () => {
  // A geo block is deterministic for one egress: retrying from the same
  // network keeps saying no, so waiting for a second strike would only delay
  // the same answer.
  expect(healthFor('REGION_BLOCKED')).toBe('dead');
  const store = mergeHealth({}, [result('oc-a', 'REGION_BLOCKED', 'dead')]);
  expect(store['oc-a']!.health).toBe('dead');
  expect(store['oc-a']!.terminalFailures).toBe(0);
});

test('an unclassified failure is a transient, not a separate fifth verdict', () => {
  // A 401 from the local proxy is our own token mismatch, and an unrecognised
  // upstream text is an unrecognised 5xx. Neither is evidence about the model,
  // and neither may print as a state of its own in the roster.
  expect(healthFor('UNKNOWN')).toBe('flaky');
  expect(mergeHealth({}, [result('oc-a', 'UNKNOWN', 'flaky')])['oc-a']!.health).toBe('flaky');
});
