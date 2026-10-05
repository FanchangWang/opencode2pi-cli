import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Replacing a path that another process still holds is a Windows-specific failure: the POSIX
// rename is atomic and unconditional, while Windows refuses the replacement with EPERM/EACCES/
// EBUSY when the destination is open without delete sharing (antivirus real-time scanning, sync
// clients, an editor, or the reader of the configuration being rewritten) or mapped as a running
// image. Those conflicts are short-lived, so retry briefly instead of failing the write.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const DELAYS = [50, 100, 200, 400, 800];

export interface ReplaceRetryOptions {
  rename?: (temp: string, target: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  delays?: readonly number[];
}

export async function replaceWithRetry(temp: string, target: string, {
  rename = fs.rename, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), delays = DELAYS,
}: ReplaceRetryOptions = {}): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(temp, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (!code || !TRANSIENT.has(code) || attempt >= delays.length) throw error;
      await sleep(delays[attempt]!);
    }
  }
}

// health.json and settings.json land here, so a Windows sharing conflict must not turn a
// routine refresh into a failed write.
export async function atomicWrite(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await replaceWithRetry(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}