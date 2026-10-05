import { expect, test } from 'bun:test';

import { classifyFailure } from '../src/errors.ts';

const CASES: { name: string; status: number | undefined; message: string; kind: string }[] = [
  { name: 'a 429 is a rate limit', status: 429, message: 'HTTP 429', kind: 'RATE_LIMIT' },
  { name: 'a rate-limit phrase without a status still reads as quota pressure', status: undefined, message: 'Too Many Requests from upstream', kind: 'RATE_LIMIT' },
  { name: 'an exhausted quota is a rate limit, not a generic error', status: 502, message: 'insufficient_quota for this key', kind: 'RATE_LIMIT' },
  { name: 'a 404 is a retired model', status: 404, message: 'HTTP 404', kind: 'MODEL_GONE' },
  { name: 'a ModelError without a status is a retired model', status: undefined, message: 'ModelError: provider has no such model', kind: 'MODEL_GONE' },
  { name: 'a country block is a region verdict, not a proxy refusal', status: 403, message: 'HTTP 403 · Error from provider (Console): This model is not available in your country', kind: 'REGION_BLOCKED' },
  { name: 'a 400 is a rejected request', status: 400, message: 'HTTP 400 unsupported content', kind: 'REQUEST_REJECTED' },
  { name: 'a 500 is an upstream outage', status: 500, message: 'HTTP 500', kind: 'UPSTREAM' },
  { name: 'a fetch transport failure is a missing runtime', status: undefined, message: 'TypeError: fetch failed', kind: 'RUNTIME_MISSING' },
  { name: 'an unreachable local server is a missing runtime', status: undefined, message: 'connect ECONNREFUSED 127.0.0.1:41980', kind: 'RUNTIME_MISSING' },

  { name: 'anything else is unknown', status: undefined, message: 'something else entirely', kind: 'UNKNOWN' },
  { name: 'a 401 says the local token mismatched, not that a model failed', status: 401, message: 'Local proxy API key required', kind: 'UNKNOWN' },
  { name: 'a 403 is a browser-origin refusal, also internal', status: 403, message: 'Browser-origin requests are disabled', kind: 'UNKNOWN' },
];

test('every failure mode maps to its own verdict', () => {
  for (const entry of CASES) {
    const classification = classifyFailure(entry.status, entry.message);
    expect(`${entry.name}: ${classification.kind}`).toBe(`${entry.name}: ${entry.kind}`);
    expect(classification.summary.length).toBeGreaterThan(0);
  }
});

test('a rate limit outranks a model-gone phrase in the same message', () => {
  // Both phrases arrive together from the provider's quota errors; the quota is
  // the actionable fact, and blaming the model would strike it off the roster.
  expect(classifyFailure(429, 'ModelError: quota exhausted').kind).toBe('RATE_LIMIT');
});

test('the advice names the one thing to do next', () => {
  expect(classifyFailure(401, 'Local proxy API key required').summary).toContain('内部错误');
  expect(classifyFailure(undefined, 'connect ECONNREFUSED').summary).toContain('doctor');
});

test('a country block beats the 403 proxy-refusal branch', () => {
  // Both arrive as 403. Blaming the local proxy sends the user to debug the
  // wrong machine, which is the failure this ordering exists to prevent.
  expect(classifyFailure(403, 'This model is not available in your country').kind).toBe('REGION_BLOCKED');
  expect(classifyFailure(403, 'Browser-origin requests are disabled').kind).toBe('UNKNOWN');
});
