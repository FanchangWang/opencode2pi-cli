/**
 * Per-model health, annotated onto the roster and never used to remove a model
 * from it.
 *
 * The probe talks to the local proxy rather than to OpenCode directly, so what
 * it measures is exactly what omp will do: an OpenAI-shaped request carrying
 * tools, through the same completion path a real turn takes. That is also why
 * `chatOnly` can be read straight out of the verdict — a model that cannot carry
 * a tool call is marked `supportsTools: false` in the registry rather than
 * withdrawn.
 *
 * Two verdicts, deliberately kept apart:
 *
 *   dead  — upstream will never serve this id again. Sticky across transient
 *           re-probes, but only ever reached by repetition.
 *   flaky — unavailable *right now*. Never promoted to dead on one verdict.
 */

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { CatalogModel } from './backend.ts';
import { atomicWrite } from './atomic.ts';
import { classifyFailure, type UpstreamFailure } from './errors.ts'
import { resolveDataDirectory } from './platform.ts'
import { BridgeError } from './protocol.ts'
import { formatUnsupported, probeBody, probeFailure, probeModel as probeUpstream, PROBE_TIMEOUT, type ProbeCompletion } from './probe.ts'

/**
 * Probe pacing.
 *
 * Each probe is a real inference round against a free, rate-limited upstream, so
 * a sweep fired all at once spends the quota its own follow-up needs.
 */
const PROBE_CONCURRENCY = 2
const PROBE_GAP_MS = 500

/**
 * How many times the tool round may come back chat-shaped before a model is
 * demoted to chat-only. Two, because one bad round is a known occurrence.
 */
const TOOL_ROUND_ATTEMPTS = 2

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * How long a verdict may be shown before `status` stops treating it as current.
 *
 * Six hours, not a day: the free pool churns on the order of hours (measured
 * 2026-10-06 — one model read ✅ and a neighbour ❌ within the same session), so
 * a day-old row is a memory of a roster that no longer exists. Six also keeps a
 * working day covered without nagging, and expiry is a reminder rather than a
 * silent re-probe: a sweep costs minutes of real inference, which is the user's
 * call to make via `probe`, not `status`'s.
 */
export const HEALTH_TTL_MS = 6 * 60 * 60 * 1000

/** A verdict is always about the model and keeps the upstream's words in `detail`. */
export type ModelHealth = 'ok' | 'flaky' | 'dead' | 'limited'

export const HEALTH_MARK: Readonly<Record<ModelHealth, string>> = {
  ok: '✅',
  flaky: '⚠️',
  dead: '❌',
  limited: '🚧',
}

export interface HealthRecord {
  readonly health: ModelHealth
  readonly kind: UpstreamFailure | 'OK'
  readonly detail: string
  readonly checkedAt: number
  /** Consecutive `MODEL_GONE` verdicts; two are required before ❌. */
  readonly terminalFailures: number
  /** Consecutive transient failures; hints at an outage, never at death. */
  readonly transientFailures: number
}

/** Consecutive terminal verdicts required before a model is called dead. */
export const TERMINAL_FAILURES_TO_CONDEMN = 2

/**
 * Map a classified failure onto a provisional health verdict.
 *
 * `MODEL_GONE` starts as ⚠️ rather than ❌: a single probe losing the race with a
 * transient catalog hiccup is not evidence about the model, and
 * {@link mergeHealth} is where the second, confirming verdict is demanded.
 *
 * `RUNTIME_MISSING` is limited rather than flaky because it says nothing about
 * any model at all — the local server was not reachable, so no model was asked.
 */
export function healthFor(kind: UpstreamFailure | 'OK'): ModelHealth {
  switch (kind) {
    case 'OK':
      return 'ok'
    case 'MODEL_GONE':
      return 'flaky'
    // A geo block is deterministic for a given egress: retrying the same
    // request from the same network will keep saying no.
    case 'REGION_BLOCKED':
      return 'dead'
    case 'RATE_LIMIT':
      return 'limited'
    // `RUNTIME_MISSING` is limited rather than flaky because it says nothing about
    // any model at all — the local server was not reachable, so no model was asked.
    case 'RUNTIME_MISSING':
      return 'limited'
    // A request the upstream rejected is the model refusing this particular
    // shape, which is evidence about the round, not about the model.
    case 'REQUEST_REJECTED':
      return 'flaky'
    case 'UPSTREAM':
      return 'flaky'
    // An unclassified failure carries no more evidence against the model than a
    // 5xx does — the classifier simply did not recognize the text. Giving it a
    // verdict of its own invented a fifth state that only ever showed up in
    // `status`, for failures that are transient like any other.
    case 'UNKNOWN':
      return 'flaky'
  }
}

export interface ProbeResult extends HealthRecord {
  readonly modelId: string
  /** Wall time for the whole probe, both rounds included. */
  readonly latencyMs: number
  /** The tool round: what omp would actually send. Always present. */
  readonly toolsMs: number
  /** The plain-text round: only when the tool round came back chat-shaped. */
  readonly textMs?: number
  /** The model answered, but its response format cannot carry tool calls. */
  readonly chatOnly: boolean
}

export interface ProbeOptions {
  /** Local OpenAI-compatible base URL, including the `/v1` suffix. */
  readonly endpoint: string
  /** The in-memory bearer token of the local proxy. */
  readonly key: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/**
 * Probe one model in two rounds, and time them separately.
 *
 * The tool round is the real question — it is the request omp actually sends.
 * When the model answers that with prose instead of an action, that is not a
 * failure: it is a chat model. A second, tool-free round then proves the
 * conversation works, and its duration is what tells the user whether the model
 * is merely chatty-slow or genuinely broken. Collapsing both into one number
 * would hide exactly the distinction the two rounds exist to make.
 */
async function probeModel(model: CatalogModel, options: ProbeOptions): Promise<ProbeResult> {
  const started = Date.now()
  const base = { modelId: model.id, checkedAt: Date.now(), terminalFailures: 0, transientFailures: 0 }
  const finish = (verdict: Pick<ProbeResult, 'health' | 'kind' | 'detail' | 'chatOnly' | 'toolsMs' | 'textMs'>): ProbeResult =>
    ({ ...base, latencyMs: Date.now() - started, ...verdict })

  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT
  let timedOut = false;
  const deadline = new AbortController();
  const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, timeoutMs);

  // The same OpenAI-shaped request omp sends, down the same completion path —
  // so a verdict describes the model as omp will actually meet it.
  const send = async (body: Record<string, unknown>): Promise<ProbeCompletion> => {
    const response = await fetch(`${options.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.key}` },
      body: JSON.stringify({ ...body, stream: false }),
      signal: options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal,
    });
    if (!response.ok) {
      // The local proxy relays OpenCode's own error code inside the body
      // (`native_tool_activity`, `invalid_tool_call`, …). Dropping it would
      // flatten every refusal into one verdict and lose the chat-only path,
      // which is precisely what that code selects.
      const raw = await response.text()
      throw Object.assign(new Error(`HTTP ${response.status} · ${upstreamMessage(raw) ?? raw.slice(0, 200)}`), {
        status: response.status,
        code: upstreamCode(raw),
      });
    }
    return await response.json() as ProbeCompletion;
  };

  const toolsStart = Date.now()
  // A chat-shaped refusal is sometimes one bad round: measured 2026-10-06,
  // `oc-big-pickle` answered a valid action call in one sweep and a native
  // tool attempt in the next. Demoting on a single round costs a capable model
  // its tools until the following sweep, so the tool round gets two chances
  // before any of that is concluded.
  let chatShaped = false
  let toolError = new BridgeError('no tool round was attempted', 500, 'probe_error') as Error & { status?: number; code?: string }
  for (let attempt = 0; attempt < TOOL_ROUND_ATTEMPTS; attempt++) {
    try {
      await probeUpstream({ complete: token => send(probeBody(model, token)), retries: 1 })
      return finish({ health: 'ok', kind: 'OK', chatOnly: false, toolsMs: Date.now() - toolsStart, detail: '可用 · 支持工具调用' })
    } catch (cause) {
      toolError = probeFailure(cause, timedOut) as Error & { status?: number; code?: string }
      // Three outcomes all mean "this model talks, but not in the tool shape":
      // a format the model cannot produce, prose where an action was asked for,
      // and a model that tried to run the action locally. Only the plain round
      // below can tell a usable chat model from one that refuses both.
      chatShaped = formatUnsupported(toolError) || toolError.code === 'no_action' || toolError.code === 'native_tool_activity'
      if (!chatShaped || timedOut) break
    }
  }
  const toolsMs = Date.now() - toolsStart
  if (!chatShaped || timedOut) {
    const classification = classifyFailure(toolError.status, toolError.message)
    return finish({ health: healthFor(classification.kind), kind: classification.kind, chatOnly: false, toolsMs,
      detail: timedOut ? `探测超时（${Math.round(timeoutMs / 1000)}s）` : toolError.message })
  }

  const textStart = Date.now()
  try {
    await send({ model: model.id, messages: [{ role: 'user', content: 'Reply only OK.' }] })
    return finish({ health: 'ok', kind: 'OK', chatOnly: true, toolsMs, textMs: Date.now() - textStart,
      detail: '可用 · 仅对话（不支持工具调用）' })
  } catch (textCause) {
    const textError = probeFailure(textCause, timedOut) as Error & { status?: number }
    const classification = classifyFailure(textError.status, textError.message)
    return finish({ health: healthFor(classification.kind), kind: classification.kind, chatOnly: false,
      toolsMs, textMs: Date.now() - textStart, detail: `纯文本也失败：${textError.message}` })
  }
}

/**
 * Read the upstream's own error code out of a failed proxy response.
 *
 * The local proxy answers `{"error":{"message":…,"code":…}}`, and that code is
 * what distinguishes a chat-shaped refusal from a genuine outage.
 */
function upstreamCode(body: string): string {
  const parsed = errorBody(body);
  return parsed?.code ?? 'model_error';
}

function upstreamMessage(body: string): string | undefined {
  return errorBody(body)?.message;
}

function errorBody(body: string): { message?: string; code?: string } | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown; code?: unknown };
    const error = parsed.error && typeof parsed.error === 'object' ? parsed.error as Record<string, unknown> : parsed;
    return {
      ...(typeof error.message === 'string' ? { message: error.message } : {}),
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
    };
  } catch { return undefined; }
}
/** Probe every model with a bounded, paced worker pool, reporting progress as it goes. */
export async function probeAll(
  catalog: readonly CatalogModel[],
  options: ProbeOptions,
  onProgress?: (done: number, total: number, result: ProbeResult) => void,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < catalog.length) {
      const model = catalog[cursor++]
      if (!model) return
      const result = await probeModel(model, options)
      results.push(result)
      onProgress?.(results.length, catalog.length, result)
      await delay(PROBE_GAP_MS)
    }
  }

  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, catalog.length) }, worker))
  results.sort((a, b) => a.modelId.localeCompare(b.modelId))
  return results
}

export type HealthStore = Readonly<Record<string, HealthRecord>>

function storeFile(): string {
  return path.join(resolveDataDirectory(), 'health.json')
}

export async function loadHealth(): Promise<HealthStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(storeFile(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const out: Record<string, HealthRecord> = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null) continue
      if (!('health' in value) || !('checkedAt' in value)) continue
      const record = value as Partial<HealthRecord>
      if (typeof record.checkedAt !== 'number') continue
      if (
        record.health !== 'ok' &&
        record.health !== 'flaky' &&
        record.health !== 'dead' &&
        record.health !== 'limited'
      )
        continue
      out[id] = {
        health: record.health,
        kind: record.kind ?? 'UNKNOWN',
        detail: typeof record.detail === 'string' ? record.detail : '',
        checkedAt: record.checkedAt,
        terminalFailures: typeof record.terminalFailures === 'number' ? record.terminalFailures : 0,
        transientFailures: typeof record.transientFailures === 'number' ? record.transientFailures : 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Merge fresh probe results into the store.
 *
 * A single `MODEL_GONE` is not enough to condemn: it is promoted to ❌ only after
 * {@link TERMINAL_FAILURES_TO_CONDEMN} consecutive terminal verdicts, and any
 * success clears both counters. A model already marked dead keeps the verdict
 * across a *transient* re-probe, but a success always clears it.
 */
export function mergeHealth(previous: HealthStore, results: readonly ProbeResult[]): HealthStore {
  const merged: Record<string, HealthRecord> = { ...previous }

  for (const result of results) {
    // Read the accumulating map, not the pre-call snapshot: two terminal
    // verdicts for the same id within one batch must count as consecutive.
    const before = merged[result.modelId]
    const terminalFailures = result.kind === 'MODEL_GONE' ? (before?.terminalFailures ?? 0) + 1 : 0
    const transientFailures = result.health === 'ok' ? 0 : (before?.transientFailures ?? 0) + 1

    let health = result.health
    if (result.kind === 'MODEL_GONE' && terminalFailures >= TERMINAL_FAILURES_TO_CONDEMN) {
      health = 'dead'
    } else if (before?.health === 'dead' && result.health !== 'ok') {
      health = 'dead'
    }

    merged[result.modelId] = {
      health,
      kind: result.kind,
      detail: result.detail,
      checkedAt: result.checkedAt,
      terminalFailures,
      transientFailures,
    }
  }
  return merged
}

/**
 * Drop every model the current roster no longer contains.
 *
 * The free lane follows upstream: models get added and withdrawn, so a
 * merge-only store accumulates the whole history of ids and grows without
 * bound. A probe covers exactly the current roster, so the ids in `results` *are*
 * the roster, and anything else is a model upstream retired.
 */
export function pruneHealth(store: HealthStore, keep: ReadonlySet<string>): HealthStore {
  const pruned: Record<string, HealthRecord> = {}
  for (const [id, record] of Object.entries(store)) {
    if (keep.has(id)) pruned[id] = record
  }
  return pruned
}

export async function saveHealth(results: readonly ProbeResult[]): Promise<HealthStore> {
  const merged = pruneHealth(mergeHealth(await loadHealth(), results), new Set(results.map((result) => result.modelId)))

  try {
    await mkdir(resolveDataDirectory(), { recursive: true, mode: 0o700 })
    await atomicWrite(storeFile(), JSON.stringify(merged))
  } catch {
    // An unwritable store only costs a re-probe.
  }
  return merged
}

/**
 * Whether a verdict still describes the model as it is now.
 *
 * A missing record is stale by definition: there is nothing to show but the
 * fact of the gap, which is what makes `status` go and probe those models.
 */
export function isStale(record: HealthRecord | undefined): boolean {
  return record === undefined || Date.now() - record.checkedAt > HEALTH_TTL_MS
}

/** Canonical order, so the summary reads the same way on every run. */
const VERDICT_ORDER: readonly ModelHealth[] = ['ok', 'flaky', 'limited', 'dead']

/**
 * Summarize the roster's verdicts as they are *displayed*.
 *
 * The store, never the raw probe results, is the source of truth here: the second
 * consecutive `MODEL_GONE` promotes ⚠️ to ❌ in {@link mergeHealth} only, so
 * counting raw results would contradict the lines right below it. A model with no
 * record is not a fifth verdict and is not counted as one — its roster line says
 * "未探测", which is a statement about our coverage, not about the model.
 */
export function summarizeHealth(roster: readonly { readonly id: string }[], store: HealthStore): string {
  const counts: Record<ModelHealth, number> = { ok: 0, flaky: 0, dead: 0, limited: 0 }
  for (const model of roster) {
    const health = store[model.id]?.health
    if (health) counts[health]++
  }
  return VERDICT_ORDER.filter((health) => counts[health] > 0)
    .map((health) => `${HEALTH_MARK[health]} ${counts[health]}`)
    .join('  ')
}