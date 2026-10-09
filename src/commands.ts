/**
 * `/opencode2pi-cli` — the extension's only interface.
 *
 * omp has no settings page for extensions, so a slash command plus the TUI is
 * the whole surface. Three capabilities, each answering a question the user
 * cannot answer any other way once the chain lives inside omp:
 *
 *   doctor — five links (CLI, serve, proxy, catalog, inference) that fail
 *            independently, so each is named separately instead of as one error.
 *   status — report the last sweep: models it has never asked about are probed
 *            on the spot, and aged verdicts are flagged rather than re-run.
 *   probe  — sweep the whole roster, write chat-only verdicts back into the
 *            model registry as `supportsTools: false`, and ask about hiding.
 */

import type { ExtensionCommandContext } from '@oh-my-pi/pi-coding-agent'

import type { CatalogModel } from './backend.ts'
import { runDoctor } from './doctor.ts'
import { saveFilters, type ProbeFilters } from './filters.ts'
import {
  HEALTH_MARK,
  HEALTH_TTL_MS,
  isStale,
  loadHealth,
  probeAll,
  saveHealth,
  summarizeHealth,
  type HealthRecord,
  type ProbeResult,
} from './health.ts'
import { apiKey, publishChatOnly, publishFilters, publishHealth, refreshProvider, state } from './runtime-host.ts'

/**
 * The slash command, named after the plugin rather than the provider.
 *
 * Two names are in play and confusing them is the fastest way to send someone
 * to the wrong place: `opencode2pi-cli` is the plugin (npm package, command,
 * repository) and `opencode-zen-cli` is the *provider* it registers, which only
 * ever appears in `--model opencode-zen-cli/<id>` and in `/model`.
 */
export const COMMAND = 'opencode2pi-cli';

const USAGE = `用法：/${COMMAND} <doctor|status|probe|filter>`;

const AGE = (record: HealthRecord): string => {
  const minutes = Math.max(0, Math.round((Date.now() - record.checkedAt) / 60_000))
  if (minutes < 1) return '刚刚探测'
  if (minutes < 60) return `${minutes} 分钟前探测`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} 小时前探测` : `${Math.round(hours / 24)} 天前探测`
}

/**
 * Render one roster line. Every model appears, whatever its verdict, and every
 * line carries the reason: a mark alone leaves the reader to guess whether
 * `⚠️` means a 503, a 400 or a timeout, and those have different remedies.
 *
 * A model we hold no record for says so in words instead of borrowing a verdict
 * mark. `·` is not one of the four verdicts — it says we have not asked, which is
 * a fact about the last probe, not about the model.
 */
function rosterLine(model: CatalogModel, record: HealthRecord | undefined): string {
  if (!record) return `· ${model.id} — ${model.name} · 未探测`
  const stale = isStale(record) ? '（已过期）' : ''
  return `${HEALTH_MARK[record.health]} ${model.id} — ${model.name} · ${record.detail} · ${AGE(record)}${stale}`
}

/**
 * Render one finished probe.
 *
 * The two rounds are reported separately because they answer different
 * questions: `工具` is what omp would pay for a real turn, `纯文本` is what the
 * same model does with no tools at all. A model that is only slow with tools is
 * a very different problem from one that is slow either way.
 */
function resultLine(result: ProbeResult, done: number, total: number): string {
  const timing = result.textMs === undefined
    ? `${(result.toolsMs / 1000).toFixed(1)}s`
    : `工具 ${(result.toolsMs / 1000).toFixed(1)}s / 纯文本 ${(result.textMs / 1000).toFixed(1)}s`
  return `[${done}/${total}] ${HEALTH_MARK[result.health]} ${result.modelId} — ${result.detail} · ${timing}`
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
    ctx.ui.setWorkingMessage(`正在探测 ${done}/${total}：${result.modelId}`)
    ctx.ui.notify(resultLine(result, done, total))
  })
  ctx.ui.setWorkingMessage()
  // Two verdicts reach the registry through the model rows: a model that cannot
  // carry tool calls, and a model the user's filters now hide. Both need the
  // provider rewritten, or `/model` keeps showing the list from before the probe.
  const rosterMoved = publishHealth(await saveHealth(results))
  if (rosterMoved || publishChatOnly(new Set(results.filter(result => result.chatOnly).map(result => result.modelId))))
    refreshProvider()
  return results
}

/**
 * Report the roster, probing only what we have never asked about.
 *
 * `status` answers "what does the last probe say", and the store is that answer:
 * re-probing the whole roster on every `status` would burn minutes of real
 * inference to redraw a picture the user already has. Two cases are exceptions,
 * because they are gaps rather than pictures — a model that has never been probed
 * (which includes every model added to the catalog since the last sweep) gets
 * probed right here, because showing "未探测" for something we could have asked
 * about is a worse answer than asking. A verdict that has merely aged out is not
 * a gap: it is a real result that has stopped being current, so it is reported
 * with its age and one line telling the user that `probe` exists. Re-probing on
 * age would make `status` a `probe` with extra steps, which is what `probe` is for.
 */
async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
  const current = state()
  if (current.phase !== 'ready') {
    ctx.ui.notify(`${COMMAND} 未就绪（${current.message}）。用 /${COMMAND} doctor 查看详情。`, 'error')
    return
  }

  const roster = current.catalog
  const stored = current.health && Object.keys(current.health).length ? current.health : await loadHealth()
  const unprobed = roster.filter(model => !stored[model.id])
  const aged = roster.filter(model => stored[model.id] && isStale(stored[model.id]))

  let chatOnly: readonly ProbeResult[] = []
  if (unprobed.length) {
    if (!ctx.hasUI) {
      // Print mode cannot render a progress indicator for minutes at a time; say
      // so rather than hang a headless run on a dialog nobody can see.
      ctx.ui.notify(`有 ${unprobed.length} 个模型从未探测（${unprobed.map(model => model.id).join(', ')}）。`
        + '逐模型探测需要交互式 TUI，请在 TUI 里运行 status 或 probe。', 'warning')
    } else {
      ctx.ui.notify(`正在探测 ${unprobed.length} 个尚未探测过的模型（${unprobed.map(model => model.id).join(', ')}）…`)
      chatOnly = await sweep(unprobed, ctx)
    }
  }

  const merged = state().health
  const fresh = chatOnly.filter(result => result.chatOnly).map(result => result.modelId)
  ctx.ui.notify(`模型状态：${summarizeHealth(roster, merged)}\n${roster.map(model => rosterLine(model, merged[model.id])).join('\n')}`
    + (fresh.length ? `\n仅对话模型（已写回为不支持工具）：${fresh.join(', ')}` : '')
    + hiddenNote()
    + staleNote(aged.map(model => model.id)))
}

/** A trailing line pointing at `probe` when the report it just showed has aged. */
function staleNote(aged: readonly string[]): string {
  if (!aged.length) return ''
  return `\n⚠️ ${aged.length} 个模型的结果已超过 ${HEALTH_TTL_MS / 3_600_000} 小时（${aged.join(', ')}）。`
    + `免费池波动很快，运行 /${COMMAND} probe 重新探测全部模型。`
}

/** Probe the whole roster, report it, and ask about hiding. */
async function runProbe(ctx: ExtensionCommandContext): Promise<void> {
  const current = state()
  if (current.phase !== 'ready') {
    ctx.ui.notify(`${COMMAND} 未就绪（${current.message}）。用 /${COMMAND} doctor 查看详情。`, 'error')
    return
  }
  if (!ctx.hasUI) {
    ctx.ui.notify('逐模型探测需要交互式 TUI（打印模式下不可用）。')
    return
  }

  const roster = current.catalog
  ctx.ui.notify(`正在探测 ${roster.length} 个模型（每个模型一条结果，陆续输出；全部结束后给出汇总与完整列表）…`)
  const results = await sweep(roster, ctx)
  const merged = state().health
  const chatOnly = results.filter(result => result.chatOnly).map(result => result.modelId)
  // The per-model lines stream in completion order; this closing block is the
  // canonical snapshot — every model, in catalog order, with verdict and reason.
  ctx.ui.notify(`探测完成：${summarizeHealth(roster, merged)}\n${roster.map(model => rosterLine(model, merged[model.id])).join('\n')}`
    + (chatOnly.length ? `\n仅对话模型（已写回为不支持工具）：${chatOnly.join(', ')}` : '')
    + hiddenNote())
  // The verdicts are only useful if they can change something, and whether to
  // hide is the one decision we refuse to make on the user's behalf.
  await chooseFilters(ctx)
}

/** A trailing line saying what the current filters remove, or that they do not. */
function hiddenNote(): string {
  const hidden = [...state().hidden];
  return hidden.length ? `\n已从列表隐藏：${hidden.join(', ')}（用 /${COMMAND} filter 调整）` : '';
}

/**
 * Ask what the roster should hide, and apply the answer.
 *
 * This is the user's call, not ours: the same model can answer ✅ on one lane
 * and be region-blocked on another, so an automatic rule would be wrong half
 * the time. Cancelling changes nothing — the default is to hide nothing.
 */
async function chooseFilters(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify('过滤设置需要交互式 TUI（打印模式下不可用）。')
    return
  }
  const choice = await ctx.ui.select(`${COMMAND} · 模型过滤`, [
    { label: '全部保留（只标注，不隐藏）', description: '默认：任何模型都不从列表里移除' },
    { label: '隐藏地区封锁的', description: '上游按当前出口拒绝的模型（403 · not available in your country）' },
    { label: '隐藏所有探测失败的', description: '下线、地区封锁、请求被拒、上游故障；配额与本地链路问题不算' },
  ])
  const next = choice === '隐藏地区封锁的' ? { hideRegionBlocked: true, hideFailed: false }
    : choice === '隐藏所有探测失败的' ? { hideRegionBlocked: true, hideFailed: true }
      : choice === '全部保留（只标注，不隐藏）' ? { hideRegionBlocked: false, hideFailed: false }
        : undefined
  if (!next) return
  await saveFilters(next)
  publishFilters(next)
  // Always re-register: that call is what replaces the whole model list, and it
  // is cheap. Deciding to skip it meant deciding whether the registry already
  // matched, and getting that wrong is how `/model` kept showing models the user
  // had just hidden.
  refreshProvider()
  const hidden = state().hidden
  ctx.ui.notify(hidden.size
    ? `过滤已生效：隐藏 ${hidden.size} 个模型（${[...hidden].join(', ')}），/model 与 --model 里不再出现`
    : '当前没有任何模型被隐藏（探测结论里还没有符合条件的模型）。')
}


async function showMenu(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(USAGE)
    return
  }
  const choice = await ctx.ui.select(COMMAND, [
    { label: 'doctor', description: '逐项检查 CLI、serve、本地代理、模型目录与一次真实推理' },
    { label: 'status', description: '显示上次探测的结果；从未探测过的模型会自动补测' },
    { label: 'probe', description: '重新探测全部模型，并把仅对话结论写回模型列表' },
    { label: 'filter', description: '选择要在 /model 里隐藏哪些模型（默认一个都不隐藏）' },
  ])
  // `select` resolves to the chosen label, so the labels double as the keys.
  if (choice === 'doctor') await runDoctorCommand(ctx)
  else if (choice === 'status') await showStatus(ctx)
  else if (choice === 'probe') await runProbe(ctx)
  else if (choice === 'filter') await chooseFilters(ctx)
}

async function runDoctorCommand(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.hasUI) ctx.ui.notify('正在检查本地链路…')
  const report = await runDoctor()
  ctx.ui.notify(`${report.headline}\n${report.detail}`, report.ok ? 'info' : 'error')
}

export async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (sub === 'doctor') return runDoctorCommand(ctx)
  if (sub === 'status') return showStatus(ctx)
  if (sub === 'probe') return runProbe(ctx)
  if (sub === 'filter') return chooseFilters(ctx)
  if (sub === '') return showMenu(ctx)
  ctx.ui.notify(USAGE, 'warning')
}