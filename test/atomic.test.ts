import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { atomicWrite, replaceWithRetry } from '../src/atomic.ts';

test('a transient sharing violation is retried before the replacement fails', async () => {
  const waits: number[] = [];
  let calls = 0;
  const rename = async () => { if (++calls < 3) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
  await replaceWithRetry('temp', 'target', { rename, sleep: ms => { waits.push(ms); return Promise.resolve(); } });
  expect(calls).toBe(3);
  expect(waits).toEqual([50, 100]);
});

test('permanent failures are not retried and a persistent conflict eventually gives up', async () => {
  let calls = 0;
  const rename = (code: string) => async () => { calls++; throw Object.assign(new Error(code), { code }); };
  await expect(replaceWithRetry('temp', 'target', { rename: rename('ENOENT'), sleep: async () => {} })).rejects.toMatchObject({ code: 'ENOENT' });
  expect(calls).toBe(1);
  calls = 0;
  await expect(replaceWithRetry('temp', 'target', { rename: rename('EPERM'), sleep: async () => {} })).rejects.toMatchObject({ code: 'EPERM' });
  expect(calls).toBe(6); // one attempt plus five retries
});

test('a reader holding the file open does not fail the write', async () => {
  // On Windows a second handle blocks the replacement (EPERM) even when it was opened by this very
  // process, which is the normal situation for health.json: a status refresh reads it while the
  // next one rewrites it. The write has to outlast that window instead of failing.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cli-atomic-'));
  const file = path.join(root, 'health.json');
  try {
    await fs.writeFile(file, 'old');
    const held = await fs.open(file, 'r');
    const release = setTimeout(() => held.close(), 120);
    try {
      await atomicWrite(file, 'new');
      expect(await fs.readFile(file, 'utf8')).toBe('new');
    } finally { clearTimeout(release); await held.close().catch(() => {}); }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});