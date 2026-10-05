/**
 * `/opencode2pi-cli` — the extension's only interface.
 *
 * omp has no settings page for extensions, so a slash command plus the TUI is
 * the whole surface. Three capabilities, each answering a question the user
 * cannot answer any other way once the chain lives inside omp:
 *
 *   doctor — five links (CLI, serve, proxy, catalog, inference) that fail
 *            independently, so each is named separately instead of as one error.
 *   status — per-model health, annotated onto the roster and never used to
 *            remove a model from it.
 *   probe  — force a fresh sweep, and write chat-only verdicts back into the
 *            model registry as `supportsTools: false`.
 */

import type { ExtensionCommandContext } from '@oh-my-pi/pi-coding-agent'

import type { CatalogModel } from './backend.ts'
import { runDoctor } from './doctor.ts'
import {
  HEALTH_MARK,
  isStale,
  loadHealth,
  probeAll,
  saveHealth,
  summarizeHealth,
  type HealthRecord,
  type ModelHealth,
  type ProbeResult,
} from './health.ts'
import { apiKey, publishChatOnly, publishHealth, refreshProvider, state } from './runtime-host.ts'

/**
 * The slash command, named after the plugin rather than the provider.
 *
 * Two names are in play and confusing them is the fastest way to send someone
 * to the wrong place: `opencode2pi-cli` is the plugin (npm package, command,
 * repository) and `opencode-zen-cli` is the *provider* it registers, which only
 * ever appears in `--model opencode-zen-cli/<id>` and in `/model`.
 */
export const COMMAND = 'opencode2pi-cli';

const USAGE = `用法：/${COMMAND} <doctor|status|probe>`;

const AGE = (record: HealthRecord): string => {
  const minutes = Math.round((Date.now() - record.checkedAt) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`
}

/** Render one roster line. Every model appears, whatever its verdict. */
function rosterLine(model: CatalogModel, record: HealthRecord | undefined): string {
  const health: ModelHealth = record?.health ?? 'unknown'
  const suffix = record ? ` · ${AGE(record)}` : ''
  return `${HEALTH_MARK[health]} ${model.id} — ${model.name}${suffix}`
}

/**
 * Render one finished probe.
 *
 * The two rounds are reported separately because they answer different
 * questions: `工具` is what omp would pay for a real turn, `纯文本` is what the
 * same model does with no tools at all. A model that is only slow with tools is
 * a very different problem from one that is slow either way.
 */
function resultLine(result: ProbeResult): string {
  const timing = result.textMs === undefined
    ? `${(result.toolsMs / 1000).toFixed(1)}s`
    : `工具 ${(result.toolsMs / 1000).toFixed(1)}s / 纯文本 ${(result.textMs / 1000).toFixed(1)}s`
  return `${HEALTH_MARK[result.health]} ${result.modelId} — ${result.detail} · ${timing}`
}

/**
 * Probe the whole roster, printing each verdict as it lands, then fold the
 * outcome back into the runtime.
 *
 * A sweep takes minutes, so batching the output until the end means a user who
 * has been staring at an unchanged screen has no way to tell "slow model" from
 * "hung". One line per model, immediately, answers that as it goes.
 *
 * A model that answers but cannot carry tool calls is the point of the sweep:
 * publishing it as tool-capable would hand omp a model whose every turn ends in a
 * 400, so the verdict is written back into the registry, not just the report.
 */
async function sweep(catalog: readonly CatalogModel[], ctx: ExtensionCommandContext): Promise<readonly ProbeResult[]> {
  const endpoint = state().endpoint
  if (!endpoint) throw new Error('本地代理未启动，无法探测')
  const results = await probeAll(catalog, { endpoint, key: apiKey() }, (done, total, result) => {
    ctx.ui.setWorkingMessage(`正在探测 ${done}/${total}`)
    ctx.ui.notify(resultLine(result))
  })
  ctx.ui.setWorkingMessage()
  publishHealth(await saveHealth(results))
  if (publishChatOnly(new Set(results.filter(result => result.chatOnly).map(result => result.modelId))))
    refreshProvider()
  return results
}

async function showStatus(ctx: ExtensionCommandContext, runProbe: boolean): Promise<void> {
  const current = state()
  if (current.phase !== 'ready') {
    ctx.ui.notify(`${COMMAND} 未就绪（${current.message}）。用 /${COMMAND} doctor 查看详情。`, 'error')
    return
  }
  const roster = current.catalog
  const stored = current.health && Object.keys(current.health).length ? current.health : await loadHealth()
  const stale = roster.some(model => isStale(stored[model.id]))

  if (!runProbe && !stale) {
    ctx.ui.notify(`${COMMAND} 模型状态：\n${roster.map(model => rosterLine(model, stored[model.id])).join('\n')}`)
    return
  }

  if (!ctx.hasUI) {
    // Print mode cannot render a progress indicator for minutes at a time; say so
    // rather than hang a headless run on a dialog nobody can see.
    ctx.ui.notify('逐模型探测需要交互式 TUI（打印模式下不可用）。')
    return
  }

  ctx.ui.notify(`正在探测 ${roster.length} 个模型（每个模型一条结果，陆续输出）…`)
  const results = await sweep(roster, ctx)
  const summary = summarizeHealth(roster, state().health)
  const chatOnly = results.filter(result => result.chatOnly).map(result => result.modelId)
  // The per-model lines are already on screen; the closing block only carries
  // what a reader cannot reconstruct from them.
  ctx.ui.notify(`探测完成：${summary}`
    + (chatOnly.length ? `\n仅对话模型（已写回为不支持工具）：${chatOnly.join(', ')}` : ''))
}


async function showMenu(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(USAGE)
    return
  }
  const choice = await ctx.ui.select(COMMAND, [
    { label: 'doctor', description: '逐项检查 CLI、serve、本地代理、模型目录与一次真实推理' },
    { label: 'status', description: '查看模型健康状态（必要时自动重新探测）' },
    { label: 'probe', description: '重新探测全部模型，并把仅对话结论写回模型列表' },
  ])
  // `select` resolves to the chosen label, so the labels double as the keys.
  if (choice === 'doctor') await runDoctorCommand(ctx)
  else if (choice === 'status') await showStatus(ctx, false)
  else if (choice === 'probe') await showStatus(ctx, true)
}

async function runDoctorCommand(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.hasUI) ctx.ui.notify('正在检查本地链路…')
  const report = await runDoctor()
  ctx.ui.notify(`${report.headline}\n${report.detail}`, report.ok ? 'info' : 'error')
}

export async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (sub === 'doctor') return runDoctorCommand(ctx)
  if (sub === 'status') return showStatus(ctx, false)
  if (sub === 'probe') return showStatus(ctx, true)
  if (sub === '') return showMenu(ctx)
  ctx.ui.notify(USAGE, 'warning')
}