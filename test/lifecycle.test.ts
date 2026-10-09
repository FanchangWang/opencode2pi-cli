import { expect, mock, test } from 'bun:test';

import { createLifecycle } from '../src/runtime-host.ts';

test('the chain starts once however many sessions acquire it', async () => {
  let starts = 0, stops = 0;
  const lifecycle = createLifecycle(async () => {
    starts++;
    return async () => { stops++; };
  });

  await Promise.all([lifecycle.acquire(), lifecycle.acquire(), lifecycle.acquire()]);
  expect(starts).toBe(1);
  expect(stops).toBe(0);
});

test('only the last release stops the chain', async () => {
  let stops = 0, starts = 0;
  const lifecycle = createLifecycle(async () => {
    starts++;
    return async () => { stops++; };
  });

  await lifecycle.acquire();
  await lifecycle.acquire();
  await lifecycle.release();
  expect(stops).toBe(0);
  await lifecycle.release();
  expect(stops).toBe(1);
  expect(starts).toBe(1);
});

test('a failed boot is not memoized: the next acquire retries from scratch', async () => {
  let attempts = 0;
  const lifecycle = createLifecycle(async () => {
    attempts++;
    if (attempts === 1) throw new Error('OpenCode exited: 1');
    return async () => {};
  });

  await expect(lifecycle.acquire()).rejects.toThrow(/OpenCode exited/);
  await lifecycle.acquire();
  expect(attempts).toBe(2);
});

test('releasing more often than acquiring never runs the teardown twice', async () => {
  let stops = 0;
  const lifecycle = createLifecycle(async () => async () => { stops++; });
  await lifecycle.acquire();
  await lifecycle.release();
  await lifecycle.release();
  expect(stops).toBe(1);
});

/**
 * The subagent filter, exercised through the real extension entry.
 *
 * `session_shutdown` fires for every session, so a task or eval subagent closing
 * would otherwise stop the parent session's server. The fake `pi` captures the
 * registered handlers and the runtime is stubbed out, because what is under test
 * is the branch in the entry point, not the runtime behind it.
 */
test('only a main session shuts the chain down', async () => {
  const released: string[] = [];
  const notifications: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
  const registered: { name: string; config: unknown }[] = [];

  mock.module('../src/runtime-host.ts', () => ({
    acquire: async () => {},
    release: async () => { released.push('release'); },
    apiKey: () => 'test-key',
    killOnExit: () => {},
    onProviderRefresh: () => {},
    state: () => ({ phase: 'ready', message: 'ok', endpoint: 'http://127.0.0.1:41980/v1', port: 41980, opencodeVersion: '2.0.23', v2: true, catalog: [{ id: 'oc-a', name: 'A' }], health: {}, chatOnly: new Set<string>(), filters: { hideRegionBlocked: false, hideFailed: false }, hidden: new Set<string>() }),
  }));

  // Loaded after the mock is installed: a static import would evaluate the real
  // runtime-host — and its module-level state — before `mock.module` ran.
  const { default: extension } = await import('../src/index.ts');
  await extension({
    setLabel: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerProvider: (name: string, config: unknown) => registered.push({ name, config }),
    registerCommand: (name: string) => { registered.push({ name, config: name }); },
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => handlers.set(event, handler),
  } as never);

  // Two names on purpose: the provider it registers, and the plugin's own
  // command. Conflating them is exactly the confusion this guards.
  expect(registered[0]!.name).toBe('opencode-zen-cli');
  expect(registered[1]!.name).toBe('opencode2pi-cli');
  expect((registered[0]!.config as { baseUrl: string }).baseUrl).toBe('http://127.0.0.1:41980/v1');

  const shutdown = handlers.get('session_shutdown')!;
  const notify = { ui: { notify: (message: string) => notifications.push(message) } };
  await shutdown({}, { agent: { kind: 'sub' } });
  expect(released).toEqual([]);
  await shutdown({}, { agent: { kind: 'main' } });
  expect(released).toEqual(['release']);

  const start = handlers.get('session_start')!;
  await start({}, notify);
  expect(notifications[0]).toContain('已就绪');
  expect(notifications[0]).toContain('1 个免费模型');
});

test('a hidden model is absent from every registration the host sees', async () => {
  // `/model` shows the last thing `registerProvider` was told. The hidden set
  // travels into that call and nowhere else, so a roster registered with it is
  // the only way a filter choice can reach the user at all.
  const registered: { models: { id: string }[] }[] = [];
  let refresh: (() => void) | undefined;
  const current = {
    phase: 'ready', message: 'ok', endpoint: 'http://127.0.0.1:41980/v1', port: 41980,
    opencodeVersion: '2.0.23', v2: true, filters: { hideRegionBlocked: false, hideFailed: false },
    catalog: [{ id: 'oc-a', name: 'A' }, { id: 'oc-b', name: 'B' }], health: {}, chatOnly: new Set<string>(),
    hidden: new Set(['oc-b']),
  };

  mock.module('../src/runtime-host.ts', () => ({
    acquire: async () => {},
    release: async () => {},
    apiKey: () => 'test-key',
    killOnExit: () => {},
    onProviderRefresh: (callback: () => void) => { refresh = callback; },
    state: () => current,
  }));

  const { default: extension } = await import('../src/index.ts');
  const pi = {
    setLabel: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerProvider: (_name: string, config: { models: { id: string }[] }) => registered.push(config),
    registerCommand: () => {},
    on: () => {},
  };
  await extension(pi as never);

  // Re-registering is what a probe or a filter choice triggers; the hidden id
  // must be gone from that second write too, not just the first.
  refresh!();
  expect(registered.length).toBe(2);
  for (const config of registered) expect(config.models.map(model => model.id)).toEqual(['oc-a']);
});