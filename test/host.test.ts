import { describe, expect, test } from 'bun:test';

import { detectHost } from '../src/host.ts';

/** The one feature that tells the two hosts apart: only omp carries a logger. */
const OMP_API = { logger: { info: () => {}, warn: () => {} } };

describe('host detection', () => {
  test('an API with a logger is omp, and an API without one is pi', () => {
    expect(detectHost(OMP_API).name).toBe('omp');
    expect(detectHost({ registerProvider: () => {} }).name).toBe('pi');
    // A caller that hands over nothing at all still gets the shape this
    // extension is typed against, rather than a crash on `.logger`.
    expect(detectHost(undefined).name).toBe('omp');
    expect(detectHost(null).name).toBe('omp');
  });

  test('omp projects the effort axis as a mode block and keeps the tool flag', () => {
    const projection = detectHost(OMP_API).modelProjection(['low', 'high'], false);
    // The effort list is a `const enum` on the host side (src/host.ts), so the
    // block is read field by field rather than compared against a literal.
    const thinking = projection.thinking as unknown as {
      mode: string;
      efforts: readonly string[];
      defaultLevel: string;
    };
    expect(thinking.mode).toBe('effort');
    expect(thinking.efforts).toEqual(['low', 'high']);
    expect(thinking.defaultLevel).toBe('low');
    expect(projection.supportsTools).toBe(false);
    expect(detectHost(OMP_API).honoursToolFlag).toBe(true);
  });

  test('pi projects the effort axis as a level map and drops the tool flag it cannot carry', () => {
    const host = detectHost({});
    expect(host.modelProjection(['low', 'high'], false).thinkingLevelMap).toEqual({ low: 'low', high: 'high' });
    // pi's model schema declares no tool capability, so the key must be absent
    // rather than present-but-ignored.
    expect('supportsTools' in host.modelProjection(['low', 'high'], true)).toBe(false);
    expect(host.honoursToolFlag).toBe(false);
  });

  test('a model with no effort axis gets neither a mode block nor a level map', () => {
    expect(detectHost(OMP_API).modelProjection([], true).thinking).toBeUndefined();
    expect(detectHost({}).modelProjection([], true).thinkingLevelMap).toBeUndefined();
  });
});

describe('the session and menu boundary', () => {
  test('only a top-level omp session is main, while pi has no agent identity to check', () => {
    const omp = detectHost(OMP_API);
    expect(omp.isMainSession({ agent: { kind: 'main' } })).toBe(true);
    expect(omp.isMainSession({ agent: { kind: 'task' } })).toBe(false);
    // A context that states nothing is not evidence of a top-level session, so
    // the subagent case and the unknown case are treated alike.
    expect(omp.isMainSession({})).toBe(false);
    expect(detectHost({}).isMainSession({})).toBe(true);
  });

  test('pi folds the description into the label and returns the bare label again', async () => {
    const host = detectHost({});
    const items = [{ label: 'doctor', description: '检查链路' }, { label: 'status' }];
    let offered: readonly string[] = [];
    const menu = (answer: string | undefined) => ({
      ui: {
        select: async (_title: string, options: string[]) => {
          offered = options;
          return answer;
        },
      },
    });

    expect(await host.select(menu('doctor — 检查链路'), '标题', items)).toBe('doctor');
    // The description really was folded in, and a bare label survives untouched.
    expect(offered).toEqual(['doctor — 检查链路', 'status']);
    expect(await host.select(menu('status'), '标题', items)).toBe('status');
    // Cancelling stays cancelled.
    expect(await host.select(menu(undefined), '标题', items)).toBeUndefined();
  });

  test('omp passes the richer rows straight through', async () => {
    const items = [{ label: 'doctor', description: '检查链路' }];
    let seen: unknown;
    const choice = await detectHost(OMP_API).select({
      ui: {
        select: async (_title: string, options: unknown) => {
          seen = options;
          return 'doctor';
        },
      },
    }, '标题', items);
    expect(choice).toBe('doctor');
    expect(seen).toEqual(items);
  });
});

describe('the logger boundary', () => {
  test('pi buffers what it cannot log and replays it once, through the UI it was given', () => {
    const host = detectHost({});
    host.logger.info('第一行');
    host.logger.warn('第二行');
    const seen: string[] = [];
    host.flushNotes({ ui: { notify: (message: string) => { seen.push(message); } } });
    expect(seen).toEqual(['第一行', '第二行']);
    // Replaying again must not repeat them: the buffer is drained, not read.
    host.flushNotes({ ui: { notify: (message: string) => { seen.push(message); } } });
    expect(seen).toEqual(['第一行', '第二行']);
  });

  test('a note survives a context with no UI, and one with no context at all', () => {
    const host = detectHost({});
    host.logger.warn('没有界面');
    expect(() => host.flushNotes({})).not.toThrow();
    expect(() => host.flushNotes(undefined)).not.toThrow();
  });
});
