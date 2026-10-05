import type { CatalogModel } from './backend.ts';
import { locateOpencode } from './runtime.ts';
import { apiKey, serveAlive, state } from './runtime-host.ts';

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly headline: string;
  readonly detail: string;
  readonly checks: readonly DoctorCheck[];
}

/** One check that cannot complete is a failed check, never a broken report. */
async function attempt(name: string, probe: () => Promise<{ ok: boolean; detail: string }>): Promise<DoctorCheck> {
  try {
    const result = await probe();
    return { name, ok: result.ok, detail: result.detail };
  } catch (error) {
    return { name, ok: false, detail: (error as Error).message };
  }
}

/** One minimal chat round through the local proxy: the only proof that works end to end. */
async function inferenceCheck(catalog: readonly CatalogModel[]): Promise<{ ok: boolean; detail: string }> {
  const model = catalog.find(m => m.toolcall === true) ?? catalog[0];
  if (!model) return { ok: false, detail: '目录中没有可用模型' };
  const endpoint = state().endpoint;
  if (!endpoint) return { ok: false, detail: '本地代理尚未监听（omp 启动时链路失败）' };
  const started = Date.now();
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'Reply with exactly OK.' }], stream: false }),
    signal: AbortSignal.timeout(30000),
  });
  const elapsed = Date.now() - started;
  const body = await response.text();
  if (!response.ok) return { ok: false, detail: `HTTP ${response.status} · ${elapsed}ms · ${body.slice(0, 200)}` };
  const payload = JSON.parse(body) as { choices?: { message?: { content?: string | null } }[] };
  const content = payload.choices?.[0]?.message?.content ?? '';
  return { ok: Boolean(content.trim()), detail: `${model.id} · HTTP ${response.status} · ${elapsed}ms · ${JSON.stringify(content.slice(0, 80))}` };
}

/**
 * `/opencode2pi-cli doctor` — the whole local chain, itemized.
 *
 * The chain has five links and they fail independently: the CLI is not installed,
 * `serve` never became ready, the proxy is not listening, the catalog is empty,
 * or inference itself is broken. A single "it does not work" would send the user
 * to the wrong one every time, so each link is checked and named on its own.
 */
export async function runDoctor(): Promise<DoctorReport> {
  const current = state();

  const cli = await attempt('opencode CLI', async () => {
    const found = await locateOpencode();
    const major = Number(found.version.split('.')[0] ?? '0');
    return { ok: true, detail: `${found.file} · v${found.version}（${major >= 2 ? 'v2' : 'v1'}）` };
  });

  const serve = await attempt('opencode serve', async () => {
    if (!serveAlive()) return { ok: false, detail: '子进程未运行（见 dataDir 下的 opencode.log）' };
    const version = current.opencodeVersion;
    if (!version) return { ok: false, detail: '子进程在运行，但未报告就绪版本' };
    return { ok: true, detail: `就绪 · v${version} · ${current.v2 ? 'v2' : 'v1'} 接口` };
  });

  const proxy = await attempt('本地代理', async () => {
    if (!current.endpoint) return { ok: false, detail: '本地代理未启动' };
    const response = await fetch(`${current.endpoint.replace(/\/v1$/, '')}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey()}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    const payload = JSON.parse(await response.text()) as { object?: string; data?: unknown[] };
    const count = Array.isArray(payload.data) ? payload.data.length : 0;
    return { ok: payload.object === 'list' && count > 0, detail: `${current.endpoint} · ${count} 个条目` };
  });

  const catalog = await attempt('免费模型目录', async () => {
    const count = current.catalog.length;
    if (!count) return { ok: false, detail: '目录为空' };
    return { ok: true, detail: `${count} 个：${current.catalog.map(m => m.id).join(', ')}` };
  });

  const inference = await attempt('推理连通', () => inferenceCheck(current.catalog));

  const checks = [cli, serve, proxy, catalog, inference];
  const failed = checks.filter(check => !check.ok).length;
  return {
    ok: failed === 0,
    headline: failed === 0 ? '✅ 环境正常' : `🚨 ${failed} 项检查未通过`,
    detail: checks.map(check => `${check.ok ? '✅' : '❌'} ${check.name}：${check.detail}`).join('\n'),
    checks,
  };
}