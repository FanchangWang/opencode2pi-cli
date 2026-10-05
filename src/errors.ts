/**
 * Upstream failure classification, rewritten for the local OpenCode chain.
 *
 * The user-visible difference matters as much here as it did for the direct Zen
 * lane: without it a 429, a withdrawn model and a dead local proxy all arrive as
 * `Error from provider (OpenAI): ...`, and each sends the user somewhere
 * different to look. `RUNTIME_MISSING` in particular is *this machine's* fault,
 * not the model's — the extension's own `opencode serve` never came up.
 *
 * Ordered by how expensive the distinction is to miss: a quota pause, a retired
 * model and an unreachable local server each have one correct remedy.
 */

export type UpstreamFailure =
  /** opencode CLI missing, serve never became ready, local proxy unreachable. */
  | 'RUNTIME_MISSING'
  /** The model is no longer in the catalog, or the upstream answers 404. */
  | 'MODEL_GONE'
  /** 429 or an exhausted quota. */
  | 'RATE_LIMIT'
  /** 400, including formatUnsupported on a chat-only model handed tools. */
  | 'REQUEST_REJECTED'
  /** 5xx or a transport failure upstream of the local server. */
  | 'UPSTREAM'
  | 'UNKNOWN'

export interface Classification {
  readonly kind: UpstreamFailure
  /** Operator-facing explanation; this replaces the raw provider string. */
  readonly summary: string
}

const ADVICE: Readonly<Record<UpstreamFailure, string>> = {
  RUNTIME_MISSING: '本地链路未就绪（opencode CLI 缺失、serve 未启动或本地代理不可达）：先运行 /opencode2pi-cli doctor 查看具体哪一项失败。',
  MODEL_GONE: '模型已不可用（目录中已无该模型或上游返回 404）：用 /opencode2pi-cli status 查看当前目录。',
  RATE_LIMIT: '上游限流或配额耗尽（429）：稍后重试，或换一个模型；本插件无法绕过上游配额。',
  REQUEST_REJECTED: '上游拒绝了这次请求（400）：通常是给只支持对话的模型派发了工具，先用 /opencode2pi-cli probe 重新确认能力。',
  UPSTREAM: '上游暂时不可用（5xx 或传输失败）：稍后重试。',
  UNKNOWN: '未分类的上游错误。',
}

/**
 * Classify a failed response.
 *
 * `status` is the HTTP status the local proxy reported, and the marker strings
 * are checked where a status cannot decide on its own: the quota phrases and the
 * model-gone phrases come from the provider's own error text, which outlives any
 * change in how the status is surfaced.
 */
export function classifyFailure(status: number | undefined, message: string): Classification {
  const text = message.toLowerCase()

  // Quota first: it is the verdict that a 429 status would otherwise hide behind
  // a phrase like "quota exceeded", which reads like a generic error otherwise.
  if (status === 429
    || text.includes('rate limit') || text.includes('rate_limit') || text.includes('too many requests')
    || /insufficient[_ ]quota|quota.{0,30}(exceed|exhaust|deplet)|out of credits|insufficient.{0,20}(credit|balance)|额度.{0,10}(不足|用尽)/.test(text)) {
    return { kind: 'RATE_LIMIT', summary: ADVICE.RATE_LIMIT }
  }
  if (status === 404 || text.includes('modelerror') || text.includes('model is unavailable') || text.includes('not supported')) {
    return { kind: 'MODEL_GONE', summary: ADVICE.MODEL_GONE }
  }
  if (status === 400) return { kind: 'REQUEST_REJECTED', summary: ADVICE.REQUEST_REJECTED }
  if ((status !== undefined && status >= 500)
    || text.includes('endpoint is unavailable') || text.includes('service unavailable') || text.includes('bad gateway')) {
    return { kind: 'UPSTREAM', summary: ADVICE.UPSTREAM }
  }
  // The local server answers 401 when the in-memory token does not match and 403
  // for a browser origin. Neither says anything about a model, and both mean the
  // extension is talking to itself incorrectly.
  if (status === 401) return { kind: 'UNKNOWN', summary: '本地代理令牌不匹配，属内部错误。' }
  if (status === 403) return { kind: 'UNKNOWN', summary: '本地代理拒绝了请求（浏览器来源被禁用），属内部错误。' }
  if (text.includes('econnrefused') || text.includes('fetch failed') || text.includes('timeout') || text.includes('timed out')) {
    return { kind: 'RUNTIME_MISSING', summary: ADVICE.RUNTIME_MISSING }
  }
  return { kind: 'UNKNOWN', summary: `${ADVICE.UNKNOWN} ${message}` }
}