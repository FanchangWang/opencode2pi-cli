/**
 * opencode2pi-cli — OpenCode Zen's free models as an omp/pi provider.
 *
 * The whole chain lives inside the omp process: this extension locates the
 * user's `opencode` CLI, launches an isolated `opencode serve`, opens a local
 * OpenAI-compatible proxy on 127.0.0.1, and registers it as a provider. Nothing
 * is written to `models.yml` — `registerProvider` carries the model table in
 * memory, so removing this plugin removes the provider with no leftover file.
 *
 * The factory is async on purpose: `registerProvider` is queued until the session
 * initializes, so the provider can only carry a `baseUrl` that is already
 * listening. Probing, by contrast, is never awaited here — it takes minutes per
 * sweep and must not hold up startup. It runs later, from a slash command, and
 * writes its verdicts back into the registry.
 */

import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'

import { COMMAND, handleCommand } from './commands.ts'
import { applyProvider, PROVIDER } from './provider.ts'
import { acquire, apiKey, killOnExit, onProviderRefresh, release, state, type RuntimeState } from './runtime-host.ts'

/**
 * Write the provider registry: the catalog minus what the user hid.
 *
 * This is the only place the model list is written, and it writes the whole list
 * every time — re-registering a provider name replaces its entire model slice,
 * which is what makes a filter choice reach `/model` and `--model`. Filtering
 * inside `fetchDynamicModels` cannot work here: the host caches a dynamic result
 * for 24 h under a fingerprint of its own (empty) static list, so a warm cache
 * never calls the fetcher again (docs/FINDINGS.md §8).
 */
function publishRoster(pi: ExtensionAPI, current: Readonly<RuntimeState>): void {
  if (current.catalog.length > 0 && current.hidden.size >= current.catalog.length) {
    // Everything is hidden. `registerProvider` ignores an empty model list and
    // the host keeps the one it already has, so this would silently do nothing.
    // Say so rather than let it look applied.
    pi.logger.warn(`[${PROVIDER}] 过滤规则隐藏了全部模型，/model 里的列表不会变小；用 /${COMMAND} filter 放宽`)
    return
  }
  applyProvider(pi, { endpoint: current.endpoint, key: apiKey(), catalog: current.catalog, chatOnly: current.chatOnly, hidden: current.hidden })
}

export default async function opencodeZenCli(pi: ExtensionAPI): Promise<void> {
  pi.setLabel('OpenCode Zen CLI')

  // The provider is re-registered whenever a probe changes a model's tool
  // support or the user changes what to hide, so this callback is the single
  // place that knows how to write the registry. Re-registering a provider name
  // replaces its whole model list, which is the only thing that reaches `/model`.
  onProviderRefresh(() => {
    const current = state()
    publishRoster(pi, current)
  })

  try {
    await acquire()
    publishRoster(pi, state())
  } catch (error) {
    // A broken chain must not take omp down with it: omp starts normally, just
    // without this provider, and the user is pointed at the diagnostic command.
    pi.logger.warn(`[${PROVIDER}] 启动失败：${(error as Error).message}`)
  }

  pi.registerCommand(COMMAND, {
    description: `${COMMAND} 诊断：doctor 检查本地链路，status 显示上次探测结果，probe 重新探测全部模型，filter 设置隐藏规则`,
    handler: handleCommand,
  })

  pi.on('session_start', async (_event, ctx) => {
    const current = state()
    if (current.phase === 'ready') {
      ctx.ui.notify(`${PROVIDER} 已就绪 · ${current.catalog.length} 个免费模型 · ${current.endpoint}`, 'info')
    } else if (current.phase === 'error') {
      ctx.ui.notify(`${PROVIDER} 启动失败：${current.message}（用 /${COMMAND} doctor 查看详情）`, 'error')
    }
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    // Task/eval/advisor subagents each emit `session_shutdown` too. Without this
    // filter the first subagent to exit would tear down the parent's server.
    if (ctx.agent.kind === 'main') await release()
  })

  killOnExit()
}