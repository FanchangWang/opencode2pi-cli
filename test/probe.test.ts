import { expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { CatalogModel } from '../src/backend.ts';
import { probeAll, type ProbeResult } from '../src/health.ts';

interface Round {
  readonly model: string;
  readonly withTools: boolean;
}

/** A tool round must echo back the token the request asked it to read. */
function toolReply(body: { messages?: { content?: unknown }[] }): string {
  const prompt = String(body.messages?.[0]?.content ?? '');
  const token = /probe-([0-9a-f]+)\.txt/.exec(prompt)?.[1] ?? '';
  return JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: `/external/probe-${token}.txt` }) } }] } }] });
}

function textReply(): string {
  return JSON.stringify({ choices: [{ message: { content: 'OK' } }] });
}

/**
 * A stand-in local proxy with one scripted behaviour per model.
 *
 * The probe is exercised end to end through real HTTP, which is the only way to
 * prove the two rounds are actually two requests: a chat-only verdict costs a
 * tool round *and* a plain one, and only the request log shows that.
 */
function fakeProxy(handlers: Record<string, (round: Round, body: { messages?: { content?: unknown }[] }) => { status?: number; body: string }>) {
  const rounds: Round[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; tools?: unknown[]; messages?: { content?: unknown }[] };
      const round: Round = { model: body.model, withTools: Array.isArray(body.tools) && body.tools.length > 0 };
      rounds.push(round);
      const reply = handlers[body.model]?.(round, body) ?? { status: 500, body: 'no handler' };
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(reply.body);
    });
  });
  return { rounds, listen: () => new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`))), close: () => server.close() };
}

function models(): CatalogModel[] {
  return [
    { id: 'oc-tools', name: 'Tools', toolcall: true },
    { id: 'oc-chat', name: 'Chat', toolcall: true },
    { id: 'oc-broken', name: 'Broken', toolcall: true },
  ];
}

test('a tool round that answers with an action reports only the tool time', async () => {
  const proxy = fakeProxy({ 'oc-tools': (_round, body) => ({ body: toolReply(body) }) });
  const endpoint = await proxy.listen();
  try {
    const [only] = await probeAll([{ id: 'oc-tools', name: 'Tools', toolcall: true }], { endpoint, key: 'k' });
    expect(only!.health).toBe('ok');
    expect(only!.chatOnly).toBe(false);
    expect(only!.toolsMs).toBeGreaterThanOrEqual(0);
    // A tool-capable model never pays for the plain round.
    expect(only!.textMs).toBeUndefined();
    expect(proxy.rounds.every(round => round.withTools)).toBe(true);
  } finally { proxy.close(); }
});

test('a model that answers prose is chat-only, and both rounds are timed separately', async () => {
  const proxy = fakeProxy({
    'oc-chat': round => ({ body: round.withTools ? textReply() : textReply() }),
  });
  const endpoint = await proxy.listen();
  try {
    const [result] = await probeAll([{ id: 'oc-chat', name: 'Chat', toolcall: true }], { endpoint, key: 'k' });
    expect(result!.health).toBe('ok');
    expect(result!.chatOnly).toBe(true);
    expect(result!.textMs).toBeGreaterThanOrEqual(0);
    expect(result!.toolsMs).toBeGreaterThanOrEqual(0);
    expect(result!.detail).toContain('仅对话');
    // The plain round happens exactly once, and it carries no tools.
    expect(proxy.rounds.filter(round => !round.withTools)).toHaveLength(1);
  } finally { proxy.close(); }
});

test('an upstream refusal carries its own code through the proxy body', async () => {
  // The chat-only path is selected by that code; flattened to a generic error,
  // a merely-chatty model would be reported as broken instead of demoted.
  const proxy = fakeProxy({
    'oc-chat': round => round.withTools
      ? { status: 502, body: JSON.stringify({ error: { message: 'Unexpected native tool activity; response rejected', code: 'native_tool_activity' } }) }
      : { body: textReply() },
  });
  const endpoint = await proxy.listen();
  try {
    const [result] = await probeAll([{ id: 'oc-chat', name: 'Chat', toolcall: true }], { endpoint, key: 'k' });
    expect(result!.health).toBe('ok');
    expect(result!.chatOnly).toBe(true);
    expect(result!.detail).toContain('仅对话');
  } finally { proxy.close(); }
});

test('a failing model never gets a second round, and its verdict is the classified failure', async () => {
  const proxy = fakeProxy({ 'oc-broken': () => ({ status: 500, body: 'upstream exploded' }) });
  const endpoint = await proxy.listen();
  try {
    const [result] = await probeAll([{ id: 'oc-broken', name: 'Broken', toolcall: true }], { endpoint, key: 'k' });
    expect(result!.kind).toBe('UPSTREAM');
    expect(result!.health).toBe('flaky');
    expect(result!.chatOnly).toBe(false);
    expect(result!.detail).toContain('500');
    expect(proxy.rounds).toHaveLength(1);
  } finally { proxy.close(); }
});

test('progress arrives per model, in completion order, before the sweep resolves', async () => {
  const proxy = fakeProxy({
    'oc-tools': (_round, body) => ({ body: toolReply(body) }),
    'oc-chat': () => ({ body: textReply() }),
    'oc-broken': () => ({ status: 500, body: 'upstream exploded' }),
  });
  const endpoint = await proxy.listen();
  const seen: { done: number; total: number; id: string }[] = [];
  try {
    const results = await probeAll(models(), { endpoint, key: 'k' }, (done, total, result: ProbeResult) => {
      seen.push({ done, total, id: result.modelId });
      // Every progress callback must already carry the model's own timing, so a
      // caller can print it without waiting for the sweep.
      expect(result.toolsMs).toBeGreaterThanOrEqual(0);
    });
    expect(seen).toHaveLength(3);
    expect(seen.map(entry => entry.done)).toEqual([1, 2, 3]);
    expect(seen.every(entry => entry.total === 3)).toBe(true);
    expect(results.map(result => result.modelId)).toEqual(['oc-broken', 'oc-chat', 'oc-tools']);
  } finally { proxy.close(); }
});