import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { buildHandoff, handoffInput, rejectFeedback, validateAction, type ExternalAction } from './handoff.ts';
import { BridgeError, completion, decode, type CompletionResult, type DecodedMessage, type FunctionTool, type ImageAttachment, type PreparedRequest, type TokenUsage } from './protocol.ts';
import { rawMaterial, repair, resendPrompt, type RepairMeta, type TranslatorRequest } from './repair.ts';

// Keep official approval gates active. No native operation is ever approved.
export const nativePermissions = { '*': 'ask', question: 'deny', websearch: 'deny', codesearch: 'deny', webfetch: 'deny', task: 'deny', plan_enter: 'deny', plan_exit: 'deny', todowrite: 'deny' };

// The same gates in v2's action vocabulary. v1 actions were renamed on migration:
// `bash` -> `shell`, `task` -> `subagent`; `todowrite` was removed (REMOVED_TOOLS),
// and `codesearch` / `plan_enter` / `plan_exit` are not v2 actions at all, so those
// entries are dropped rather than carried over as rules that can never match.
// Order is preserved verbatim: v2's Permission.evaluate picks the last matching rule,
// so the catch-all `'*': 'ask'` must stay first.
export const v2NativePermissions = { '*': 'ask', question: 'deny', websearch: 'deny', webfetch: 'deny', subagent: 'deny' };

export interface V2Rule { action: string; resource: string; effect: string }

// OpenCode v2 expresses the same gates as an ordered rule list. '*' resources cover every
// path, exactly like the v1 `pattern: '*'` rows the bridge used to send.
export function v2Ruleset(permissions: Record<string, string>): V2Rule[] {
  return Object.entries(permissions).map(([action, effect]) => ({ action, resource: '*', effect }));
}

// Model ids are exposed to omp as `oc-<name>`: short, and without the `/` that reads like a
// namespace separator. stripModelPrefix recovers the bare name when talking to OpenCode.
export const MODEL_PREFIX = 'oc-';
export const stripModelPrefix = (id: string | undefined): string => String(id ?? '').replace(/^oc-/, '');

export interface VariantOptions {
  disabled?: boolean;
  reasoningEffort?: string;
  [key: string]: unknown;
}

export interface CatalogModel {
  id: string;
  name: string;
  context?: number;
  input?: number;
  images?: boolean;
  output?: number;
  toolcall?: boolean;
  reasoning?: boolean;
  variants?: Record<string, VariantOptions>;
  /** Set for models that answered but cannot carry tool calls. */
  chatOnly?: boolean;
}

interface V1Cost { input: number; output: number; cache?: { read?: number; write?: number } }
interface V1Model {
  name?: string;
  cost?: V1Cost;
  capabilities?: { output?: { text?: boolean }; input?: { image?: boolean }; toolcall?: boolean; reasoning?: boolean };
  status?: string;
  limit?: { context?: number; input?: number; output?: number };
  variants?: Record<string, VariantOptions>;
}
interface V1Provider { id: string; models: Record<string, V1Model> }

export function freeModels(providers: unknown): CatalogModel[] {
  const record = providers && typeof providers === 'object' ? providers as { all?: unknown } : {};
  const all = Array.isArray(record.all) ? record.all : [];
  const provider = all.find(entry => entry && typeof entry === 'object' && (entry as V1Provider).id === 'opencode') as V1Provider | undefined;
  if (!provider) throw new Error('OpenCode provider missing');
  const models = provider.models && typeof provider.models === 'object' ? provider.models : {};
  return Object.entries(models).filter(([, m]) => {
    const c = m?.cost;
    return c && c.input === 0 && c.output === 0 && (c.cache?.read ?? 0) === 0 && (c.cache?.write ?? 0) === 0
      && m.capabilities?.output?.text !== false && m.status !== 'deprecated';
  }).map(([id, m]) => ({ id: `${MODEL_PREFIX}${id}`, name: m.name || id, context: m.limit?.context, input: m.limit?.input,
    images: m.capabilities?.input?.image === true, output: m.limit?.output,
    toolcall: m.capabilities?.toolcall === true, reasoning: m.capabilities?.reasoning === true, variants: m.variants ?? {} }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

interface V2Cost { input: number; output: number; cache?: { read?: number; write?: number } }
interface V2Model {
  providerID?: string;
  modelID?: string;
  name?: string;
  status?: string;
  enabled?: boolean;
  cost?: V2Cost[];
  capabilities?: { output?: unknown; input?: unknown; tools?: boolean };
  limit?: { context?: number; input?: number; output?: number };
  variants?: { id: string; settings?: VariantOptions }[];
}

// OpenCode v2 keeps models as their own resource (GET /api/model). Model.Info uses an
// array of cost tiers, array-typed capability modalities, and status/enabled flags.
export function v2FreeModels(models: unknown): CatalogModel[] {
  const list = Array.isArray(models) ? models as V2Model[] : [];
  return list.filter(m => m?.providerID === 'opencode' && m.status !== 'deprecated' && m.enabled !== false)
    .filter(m => {
      const costs = Array.isArray(m.cost) ? m.cost : [];
      const free = costs.some(c => c && c.input === 0 && c.output === 0 && (c.cache?.read ?? 0) === 0 && (c.cache?.write ?? 0) === 0);
      if (!free) return false;
      return Array.isArray(m.capabilities?.output) && (m.capabilities!.output as unknown[]).includes('text');
    })
    .map(m => ({
      id: `${MODEL_PREFIX}${m.modelID}`, name: m.name || String(m.modelID), context: m.limit?.context, input: m.limit?.input,
      images: Array.isArray(m.capabilities?.input) && (m.capabilities!.input as unknown[]).includes('image'), output: m.limit?.output,
      toolcall: m.capabilities?.tools === true,
      // v2 exposes no reasoning capability flag; keep reasoning off rather than guess.
      reasoning: false,
      variants: Object.fromEntries((m.variants ?? []).map(v => [v.id, v.settings ?? {}])),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Approval payloads can carry file content; keep the shape but bound long strings.
export function shrinkPermission<T>(value: T, limit = 400): T {
  if (typeof value === 'string') return (value.length > limit ? `${value.slice(0, limit)}…[${value.length} chars]` : value) as T;
  if (Array.isArray(value)) return value.map(item => shrinkPermission(item, limit)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrinkPermission(item, limit)])) as T;
  return value;
}

function allowedTools(request: PreparedRequest): FunctionTool[] {
  return request.choice === 'none' ? [] : request.tools.filter(t => !request.forced || t.function.name === request.forced);
}

// The v2 rejection message must not name StructuredOutput: that tool no longer exists.
function v2RejectFeedback(native: string, reason: string): string {
  return `Native tool "${native}" was blocked: ${reason}. Native execution is forbidden; the external client owns execution. `
    + 'Return the requested external action inside the calls array as JSON '
    + '({"content":"text or empty","calls":[{"name":"offered tool name","arguments":{}}]}). '
    + 'The external client will execute it and supply results. Do not call any other native tools.';
}

function conversation(request: Partial<PreparedRequest> = {}): unknown[] {
  try {
    const messages = JSON.parse(request.text ?? '[]');
    return Array.isArray(messages) ? messages : [];
  } catch { return []; }
}

// Turn a completed v2 assistant message into the same material shape the repair pipeline
// consumes for v1 responses. A v2 tool part names itself `name` and identifies itself `id`
// (there is no `tool`/`callID`); both match what `Permission.Source.id` carries.
function v2RawMaterial(message: unknown, request: Partial<PreparedRequest>, adapterError?: { code?: string; message?: string }): Record<string, unknown> {
  const record = (message && typeof message === 'object' ? message : {}) as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content as Record<string, unknown>[] : [];
  return {
    finish: record.finish ?? null,
    error: record.error ?? null,
    ...(adapterError ? { adapterError: { code: adapterError.code, message: adapterError.message } } : {}),
    structured: null,
    parts: content.map(p => p?.type === 'tool'
      ? { type: 'tool', tool: p.name, callID: p.id, state: p.state }
      : p),
    conversation: conversation(request),
  };
}

export interface ProgressReport {
  sessionID?: string;
  model?: string;
  type: string;
  at?: number;
  status?: string;
  content?: boolean;
  error?: string;
  attempt?: number;
  message?: unknown;
  next?: unknown;
  repairModel?: string;
  [key: string]: unknown;
}

export interface CompletionMeta extends RepairMeta {
  tools?: number;
  model?: string;
  probe?: boolean;
  sessionID?: string;
  calls?: number;
  nativeAttempts?: number;
  steps?: number;
  handoff?: string;
  permissions?: unknown[];
  handoffCheck?: unknown;
  handoffMiss?: { native: string; input: Record<string, unknown>; offeredTools: number } | null;
  stage?: string;
  v2Handoff?: ExternalAction | null;
  v2WatchError?: unknown;
  v2Outcome?: string | null;
  activity?: (progress: ProgressReport) => void;
}

interface ToolPart { tool: string | null; input: Record<string, unknown> }

interface PermissionEntry {
  id?: string;
  sessionID?: string;
  pending?: boolean;
  requestID?: string;
  tool?: { callID?: string };
  source?: { id?: string; type?: string };
  action?: string;
  metadata?: Record<string, unknown>;
  permission?: string;
  [key: string]: unknown;
}

export class Backend {
  readonly base: string;
  readonly password: string;
  readonly timeout: number | undefined;
  readonly log: (message: string) => void;
  readonly v2: boolean;
  translator: ((failed: string | undefined) => string | null) | null = null;

  // Live session bookkeeping. Public only so a test can stand in for the event
  // stream: `request` is overridable for the same reason, and the repair tests
  // drive the whole correction path through it.
  activeRequests = new Map<string, CompletionMeta>();
  eventStream: AbortController | null = null;
  toolParts = new Map<string, ToolPart>();
  pendingApprovals = new Map<string, PermissionEntry>();
  usageBySession = new Map<string, TokenUsage | undefined>();

  constructor(base: string, password: string, timeout: number | undefined, log: (message: string) => void = () => {}, v2 = false) {
    this.base = base;
    this.password = password;
    this.timeout = timeout;
    this.log = log;
    this.v2 = v2;
  }

  headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}` };
  }

  async request(route: string, method = 'GET', body?: unknown, signal?: AbortSignal, timeout: number | null | undefined = this.timeout): Promise<unknown> {
    const requestSignal = timeout == null ? signal : AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    return new Promise((resolve, reject) => {
      // Local inference has no proxy-owned deadline or HTTP client's implicit response timeout.
      const req = httpRequest(this.base + route, {
        method, signal: requestSignal, headers: this.headers(),
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          const status = response.statusCode ?? 502;
          if (status < 200 || status >= 300)
            return reject(new BridgeError(`OpenCode HTTP ${status}: ${text.slice(0, 600)}`, status >= 500 ? 502 : status, 'upstream_error'));
          if (status === 204 || !text) return resolve(null);
          try { resolve(JSON.parse(text)); }
          catch { reject(new BridgeError('OpenCode returned non-JSON response', 502, 'upstream_error')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(0);
      req.end(body !== undefined ? JSON.stringify(body) : undefined);
    });
  }

  // One event-stream connection serves every in-flight request: OpenCode reports its own
  // upstream retries there, which the request/response path never exposes.
  watchEvents(): void {
    if (this.eventStream) return;
    const controller = new AbortController();
    this.eventStream = controller;
    (async () => {
      while (!controller.signal.aborted) {
        try { await this.streamEvents(controller.signal); }
        catch (e) { if (controller.signal.aborted) return; this.log(`Event stream error: ${(e as Error).message}`); }
        await delay(1000, undefined, { signal: controller.signal, ref: false }).catch(() => {});
      }
    })().catch(() => {});
  }

  stopEvents(): void {
    this.eventStream?.abort();
    this.eventStream = null;
  }

  streamEvents(signal: AbortSignal): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const req = httpRequest(this.base + (this.v2 ? '/api/event' : '/event'), { method: 'GET', signal, headers: { ...this.headers(), Accept: 'text/event-stream' } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new BridgeError(`Event stream HTTP ${response.statusCode}`, 502, 'event_stream_error')); return; }
      let buffer = '';
      response.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try { this.handleEvent(JSON.parse(line.slice(5).trim())); } catch { /* a malformed frame is not fatal to the stream */ }
        }
      });
      response.on('error', reject);
      response.on('end', resolve);
    });
    req.on('error', reject);
    req.end();
    return promise;
  }

  handleEvent(wrapper: unknown): void {
    if (this.v2) return this.handleV2Event(wrapper ?? {});
    const root = (wrapper && typeof wrapper === 'object' ? wrapper : {}) as Record<string, unknown>;
    const event = (root.payload && typeof root.payload === 'object' ? root.payload : root) as Record<string, unknown>;
    const properties = (event.properties && typeof event.properties === 'object' ? event.properties : {}) as Record<string, unknown>;
    if (['permission.asked', 'permission.updated'].includes(String(event.type)) && properties.id)
      this.pendingApprovals.set(String(properties.id), properties as PermissionEntry);
    if (event.type === 'permission.replied') this.pendingApprovals.delete(String(properties.requestID));
    // The tool part carries the name and arguments of a call that an approval gate blocked.
    // It arrives here before the approval does, and the HTTP listing of messages does not.
    const part = (event.type === 'message.part.updated' ? properties.part : undefined) as Record<string, unknown> | undefined;
    if (part?.type === 'tool' && part.callID) {
      const state = (part.state && typeof part.state === 'object' ? part.state : {}) as Record<string, unknown>;
      this.toolParts.set(String(part.callID), { tool: (part.tool as string) ?? null, input: (state.input as Record<string, unknown>) ?? {} });
      if (this.toolParts.size > 50) this.toolParts.delete(this.toolParts.keys().next().value!);
    }
    const info = (event.type === 'message.updated' ? properties.info : undefined) as Record<string, unknown> | undefined;
    if (info?.role === 'assistant' && info.tokens && this.usageBySession.has(String(info.sessionID)))
      this.usageBySession.set(String(info.sessionID), info.tokens as TokenUsage);
    const sessionID = properties.sessionID ? String(properties.sessionID) : undefined;
    const meta = sessionID ? this.activeRequests.get(sessionID) : undefined;
    if (!meta || typeof meta.activity !== 'function') return;
    const status = properties.status as Record<string, unknown> | undefined;
    const progress: ProgressReport = { sessionID, model: meta.model, type: String(event.type), at: Date.now() };
    if (event.type === 'session.status' && status) {
      if (status.type === 'retry' || (status.type === 'busy' && (!meta.stage || meta.stage === 'retry'))) progress.status = status.type === 'busy' ? 'waiting' : 'retry';
      if (status.type === 'retry') Object.assign(progress, { attempt: status.attempt as number, message: status.message, next: status.next });
    }
    if (event.type === 'session.error') {
      const error = (properties.error && typeof properties.error === 'object' ? properties.error : {}) as Record<string, unknown>;
      const data = (error.data && typeof error.data === 'object' ? error.data : {}) as Record<string, unknown>;
      progress.error = String(data.message ?? error.name ?? '上游错误');
    }
    if (part && ['text', 'reasoning'].includes(String(part.type)) && part.text) {
      progress.content = true; progress.status = part.type === 'reasoning' ? 'reasoning' : 'receiving';
    }
    if (event.type === 'message.part.delta' && properties.delta) {
      progress.content = true; progress.status = 'receiving';
    }
    if (['permission.asked', 'permission.updated'].includes(String(event.type))) progress.status = 'permission';
    if (progress.status) meta.stage = progress.status;
    meta.activity(progress);
  }

  // OpenCode v2 event names and payload layout differ from v1: fields live under `data`
  // and execution/text/tool events are namespaced under `session/`. Permission asks carry
  // no request id here (it is only known through the permission list), so the event merely
  // signals activity; the poll loop attaches the per_ id.
  handleV2Event(event: unknown): void {
    const root = (event && typeof event === 'object' ? event : {}) as Record<string, unknown>;
    const type = String(root.type ?? '');
    const fields = (root.data && typeof root.data === 'object' ? root.data : {}) as Record<string, unknown>;
    if (type === 'permission.asked') {
      const key = `${String(fields.sessionID)}:${String(fields.source && typeof fields.source === 'object' && 'id' in (fields.source as object) ? (fields.source as Record<string, unknown>).id : fields.action)}`;
      this.pendingApprovals.set(key, { ...fields, pending: true });
      if (this.pendingApprovals.size > 200) {
        for (const [k, v] of this.pendingApprovals) if (v.pending) { this.pendingApprovals.delete(k); break; }
      }
    }
    if (type === 'permission.replied') {
      for (const [k, v] of this.pendingApprovals)
        if (v.requestID === fields.requestID || v.id === fields.requestID) this.pendingApprovals.delete(k);
    }
    if (type === 'session.tool.called') {
      this.toolParts.set(String(fields.id), { tool: null, input: (fields.input as Record<string, unknown>) ?? {} });
      if (this.toolParts.size > 50) this.toolParts.delete(this.toolParts.keys().next().value!);
    }
    if (type === 'session.tool.input.started') this.toolParts.set(String(fields.id), { tool: String(fields.name), input: {} });
    if (type === 'session.usage.updated') {
      if (fields.sessionID && fields.tokens && this.usageBySession.has(String(fields.sessionID)))
        this.usageBySession.set(String(fields.sessionID), fields.tokens as TokenUsage);
    }
    const sessionID = fields.sessionID ? String(fields.sessionID) : undefined;
    const meta = sessionID ? this.activeRequests.get(sessionID) : undefined;
    // The turn outcome is per request, not per Backend: four requests share one instance.
    if (meta && ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(type))
      meta.v2Outcome = type.slice('session.execution.'.length);
    if (!meta || typeof meta.activity !== 'function') return;
    const progress: ProgressReport = { sessionID, model: meta.model, type, at: Date.now() };
    if (['session.text.started', 'session.text.delta', 'session.text.ended'].includes(type)) {
      progress.content = true; progress.status = 'receiving';
    }
    if (['session.reasoning.started', 'session.reasoning.delta', 'session.reasoning.ended'].includes(type)) {
      progress.content = true; progress.status = 'reasoning';
    }
    if (type === 'permission.asked') progress.status = 'permission';
    if (type === 'session.retry.scheduled') {
      progress.status = 'retry';
      progress.attempt = fields.attempt as number;
      const error = (fields.error && typeof fields.error === 'object' ? fields.error : {}) as Record<string, unknown>;
      progress.message = error.message ?? error.type ?? null;
    }
    if (type === 'session.execution.failed') {
      const error = (fields.error && typeof fields.error === 'object' ? fields.error : {}) as Record<string, unknown>;
      progress.error = String(error.message ?? error.type ?? '上游错误');
    }
    if (progress.status) meta.stage = progress.status;
    meta.activity(progress);
  }

  progress(meta: CompletionMeta, status: string, extra: Record<string, unknown> = {}): void {
    meta.stage = status;
    meta.activity?.({ sessionID: meta.sessionID, model: meta.model, type: 'bridge.phase', status, ...extra });
  }

  async reject(permission: PermissionEntry, message: string, signal?: AbortSignal): Promise<unknown> {
    if (this.v2) {
      const result = await this.request(`/api/session/${encodeURIComponent(String(permission.sessionID))}/permission/${encodeURIComponent(String(permission.id))}/reply`, 'POST', { decision: 'reject', message }, signal, 5000);
      for (const [k, v] of this.pendingApprovals)
        if (v.id === permission.id || v.requestID === permission.id) this.pendingApprovals.delete(k);
      return result;
    }
    const result = await this.request(`/permission/${encodeURIComponent(String(permission.id))}/reply`, 'POST', { reply: 'reject', message }, signal, 5000);
    this.pendingApprovals.delete(String(permission.id));
    return result;
  }

  // The name of the blocked call comes from the event stream; the arguments may still be
  // empty while the part is pending, and handoffInput() then fills them from the approval.
  async blockedAction(callID: string, signal?: AbortSignal): Promise<(ToolPart & { failure?: string }) | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const part = this.toolParts.get(callID);
      if (part?.tool || part?.input) return part;
      await delay(120, undefined, { signal, ref: false }).catch(() => {});
    }
    return { tool: null, input: {}, failure: 'no event carried this call ID' };
  }

  async pendingPermissions(sessionID: string, signal?: AbortSignal): Promise<PermissionEntry[]> {
    const cached = () => [...this.pendingApprovals.values()].filter(p => p.sessionID === sessionID);
    let pending: unknown;
    try {
      if (this.v2) {
        const payload = await this.request(`/api/session/${encodeURIComponent(sessionID)}/permission`, 'GET', undefined, signal, 5000);
        pending = payload && typeof payload === 'object' && 'data' in payload ? (payload as { data: unknown }).data : undefined;
      } else pending = await this.request('/permission', 'GET', undefined, signal, 5000);
    } catch (error) {
      const e = error as { code?: string; name?: string; status?: number; message?: string };
      if (!signal?.aborted) this.log(`Permission monitor query failed: ${e.code || e.name}${e.status ? ` (HTTP ${e.status})` : ''}: ${e.message}`);
      return cached();
    }
    if (!Array.isArray(pending)) { this.log('Permission monitor query failed: non-array response'); return cached(); }
    return (pending as PermissionEntry[]).filter(p => p.sessionID === sessionID);
  }

  // v2 lists a session's messages newest-first: the `order` parameter defaults to desc and the
  // page size is 50, so the first assistant entry is the newest one. Asking for the oldest page
  // instead would drop the answer of any long session; this read never reverses or re-orders.
  async v2Messages(sessionID: string, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const payload = await this.request(`/api/session/${encodeURIComponent(sessionID)}/message`, 'GET', undefined, signal, 5000);
    const data = payload && typeof payload === 'object' && 'data' in payload ? (payload as { data: unknown }).data : undefined;
    return Array.isArray(data) ? data as Record<string, unknown>[] : [];
  }

  async handoffUsage(sessionID: string, signal?: AbortSignal): Promise<TokenUsage | undefined> {
    // Abort finishes the interrupted assistant message before session cleanup removes it.
    try {
      if (this.v2) {
        const tokens = (await this.v2Messages(sessionID, signal)).reverse().find(m => m?.type === 'assistant')?.tokens;
        if (tokens) return tokens as TokenUsage;
      } else {
        const messages = await this.request(`/session/${encodeURIComponent(sessionID)}/message?limit=1`, 'GET', undefined, signal, 5000);
        const list = Array.isArray(messages) ? messages as Record<string, unknown>[] : [];
        const entry = list.findLast(m => (m.info as Record<string, unknown> | undefined)?.role === 'assistant');
        const info = (entry?.info ?? undefined) as Record<string, unknown> | undefined;
        if (info?.tokens) return info.tokens as TokenUsage;
      }
    } catch (error) {
      const e = error as { code?: string; name?: string };
      if (!signal?.aborted) this.log(`Usage lookup failed: ${e.code || e.name}`);
    }
    return this.usageBySession.get(sessionID);
  }

  // Refuse one native approval, or hand it to the external client. Returns { handoff } when
  // the action was handed over, so the caller can stop this generation and answer with it.
  async handlePermission(p: PermissionEntry, request: PreparedRequest, signal: AbortSignal | undefined, rejected: Set<string>, meta: CompletionMeta): Promise<{ handoff: ExternalAction } | null> {
    // v1 identifies the call through p.tool.callID; v2 through p.source.id.
    const callID = p.tool?.callID ?? p.source?.id;
    if (callID && rejected.has(callID)) return null;
    if (callID) rejected.add(callID);
    meta.nativeAttempts = (meta.nativeAttempts ?? 0) + 1;
    // Keep the approval request verbatim: OpenCode's field names differ from the SDK
    // types, so cherry-picking fields silently loses the useful ones.
    meta.permissions ??= [];
    if (meta.permissions.length < 5) meta.permissions.push(shrinkPermission(p));
    const action = callID ? await this.blockedAction(callID, signal) : null;
    // v2 names the requested native operation directly on the permission; v1 infers it
    // from the tool part or the command metadata.
    const native = this.v2 ? (p.action || null) : (action?.tool ?? (p.metadata?.command ? 'bash' : null));
    const handoff = native ? buildHandoff({ native, input: handoffInput(action, p), tools: allowedTools(request) }) : null;
    if (!handoff) {
      meta.handoffCheck = { native: native ?? null, offeredTools: request.tools.length, detail: action?.failure ?? 'arguments incomplete for the external schema' };
      // The action exists and only its expression is missing: keep it for the translator.
      if (native) meta.handoffMiss = { native, input: handoffInput(action, p), offeredTools: request.tools.length };
    }
    if (handoff) {
      this.progress(meta, 'handoff');
      await this.reject(p, 'This native action is executed by the external client instead.', signal).catch(() => {});
      return { handoff };
    }
    const reason = !callID ? 'the approval request carries no call ID, so it cannot be matched to the external tool list'
      : action ? 'its arguments cannot be mapped onto an external tool schema supplied in this request'
        : 'the call could not be read back from the session';
    // Without the tool part, name what can be known instead of blaming the permission kind.
    const label = native || (p.metadata?.filepath ? `a file operation on ${String(p.metadata.filepath)}` : (this.v2 ? p.action || 'native tool' : p.permission || 'native tool'));
    const feedback = this.v2 ? v2RejectFeedback(label, reason) : rejectFeedback(label, reason);
    // A permission may already be gone (session aborted, duplicate reply): never let that
    // failing reply take the whole request down with it.
    await this.reject(p, feedback, signal).catch(() => {});
    return null;
  }

  async models(): Promise<CatalogModel[]> {
    if (this.v2) {
      const payload = await this.request('/api/model');
      const data = payload && typeof payload === 'object' && 'data' in payload ? (payload as { data: unknown }).data : undefined;
      if (!Array.isArray(data)) throw new BridgeError('OpenCode v2 model list malformed', 502, 'upstream_error');
      const result = v2FreeModels(data);
      if (!result.length) throw new Error('No free text models found; existing list preserved');
      return result;
    }
    const result = freeModels(await this.request('/provider'));
    if (!result.length) throw new Error('No free text models found; existing list preserved');
    return result;
  }

  // One bounded job for a second model: turn the material into the shape the receiver expects.
  // The result is validated by the receiver's own rules, so a translation can never widen what is
  // allowed; anything else falls back to the original error.
  translate(request: PreparedRequest, shape: 'envelope' | 'action', material: unknown, meta: CompletionMeta, blocked: unknown, signal?: AbortSignal): Promise<DecodedMessage | ExternalAction | null> {
    const deadline = AbortSignal.timeout(20000);
    const translatorSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
    // The translator request is already chat-only, system-set and tool-free: promote it to the
    // shape `complete` consumes with a stub catalog entry that only ever supplies its id.
    const asPrepared = (inner: TranslatorRequest): PreparedRequest => ({
      model: { id: inner.model.id, name: inner.model.id },
      images: inner.images, chatOnly: true, tools: [], choice: 'none', forced: null,
      system: inner.system, text: inner.text,
    });
    // What the client would run is still decided by the client's own rules: a name it did not offer,
    // or arguments that break its schema, are refused no matter how the translation was reached.
    const validate = (candidate: unknown): DecodedMessage | ExternalAction => {
      if (shape !== 'action') return decode(JSON.stringify(candidate), request);
      const action = validateAction(candidate, allowedTools(request));
      decode(JSON.stringify({ content: '', calls: [action] }), request);
      return action;
    };
    return repair<DecodedMessage | ExternalAction>({
      complete: inner => this.complete(asPrepared(inner), translatorSignal, {
        model: inner.model.id,
        ...(meta.activity ? { activity: progress => {
          if (progress.type !== 'request.done') meta.activity!({ sessionID: meta.sessionID, model: meta.model,
            type: 'bridge.repair', status: 'repair', repairModel: inner.model.id, ...(progress.content ? { content: true } : {}) });
        } } : {}),
      }),
      translator: (modelId, shape) => {
        const model = this.translator?.(modelId);
        this.progress(meta, 'repair', { repairModel: model || null });
        return model;
      }, request: { ...request, tools: allowedTools(request) }, shape, material, blocked, meta, log: this.log, validate,
    });
  }

  complete(request: PreparedRequest, signal: AbortSignal | undefined, meta: CompletionMeta = {}): Promise<CompletionResult> {
    return this.v2 ? this.v2Complete(request, signal, meta) : this.v1Complete(request, signal, meta);
  }

  async v1Complete(request: PreparedRequest, signal: AbortSignal | undefined, meta: CompletionMeta = {}): Promise<CompletionResult> {
    meta.steps = 0; meta.nativeAttempts = 0; meta.permissions = [];
    // Native tools require approval; the bridge aborts any attempted native action.
    const session = await this.request('/session', 'POST', { title: 'opencode2pi-cli', permission: Object.entries(nativePermissions).map(([permission, action]) => ({ permission, pattern: '*', action })) }, signal);
    const sessionID = String((session as { id: string }).id);
    const route = `/session/${encodeURIComponent(sessionID)}`;
    meta.sessionID = sessionID;
    this.usageBySession.set(sessionID, undefined);
    if (typeof meta.activity === 'function') this.activeRequests.set(sessionID, meta);
    this.watchEvents();
    this.progress(meta, 'waiting');
    const guard = new AbortController();
    const rejected = new Set<string>();
    const guardSignal = AbortSignal.any([guard.signal, ...(signal ? [signal] : [])]);
    const watch = (async () => {
      while (!guardSignal.aborted) {
        const pending = await this.pendingPermissions(sessionID, guardSignal);
        // A failed poll does not grant approval: native actions remain waiting.
        // Keep polling while inference runs; cancellation and inference errors still propagate.
        for (const p of pending ?? []) {
          if (request.chatOnly) throw new BridgeError('Chat-only model attempted native tool use; execution blocked', 502, 'native_tool_activity');
          const result = await this.handlePermission(p, request, guardSignal, rejected, meta);
          if (result?.handoff) return result;
        }
        await delay(250, undefined, { signal: guardSignal, ref: false }).catch(() => {});
      }
    })();
    let successful = false;
    try {
      const tools = allowedTools(request);
      const callsSchema = { type: 'array', ...(request.parallel ? {} : { maxItems: 1 }),
        ...(request.choice === 'required' || request.forced ? { minItems: 1 } : {}),
        ...(tools.length ? { items: { anyOf: tools.map(({ function: tool }) => ({
          type: 'object', properties: { name: { type: 'string', const: tool.name }, arguments: tool.parameters || { type: 'object' } },
          required: ['name', 'arguments'], additionalProperties: false,
        })) } } : { maxItems: 0, items: { type: 'object' } }),
      };
      const payload: Record<string, unknown> = {
        model: { providerID: 'opencode', modelID: stripModelPrefix(request.model.id) },
        ...(request.variant ? { variant: request.variant } : {}),
        agent: request.chatOnly ? 'buddy-chat' : 'buddy-bridge',
        system: request.chatOnly ? request.system : request.system + '\nUse StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.',
        ...(request.chatOnly ? {} : { format: { type: 'json_schema', retryCount: 0, schema: {
          type: 'object', properties: { content: { type: 'string' }, calls: callsSchema },
          required: ['content', 'calls'], additionalProperties: false,
        } } }),
        parts: [{ type: 'text', text: request.text }, ...((request.images ?? []) as unknown[] as Record<string, unknown>[])],
      };
      let actionRetried = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        meta.steps = (meta.steps ?? 0) + 1;
        this.progress(meta, attempt ? 'correcting' : 'waiting');
        this.usageBySession.set(sessionID, undefined);
        const response = await Promise.race([watch, this.request(`${route}/message`, 'POST', payload, signal, null)]) as Record<string, unknown>;
        this.progress(meta, 'checking');
        let handoff: ExternalAction | null = (response?.handoff as ExternalAction | undefined) ?? null;
        if (!handoff) {
          // Close the race: an approval raised just before the response landed must still be
          // refused or handed over, otherwise its tool part looks like unexpected activity.
          const late = await this.pendingPermissions(sessionID, guardSignal);
          for (const p of late ?? []) {
            if (request.chatOnly && p.tool) throw new BridgeError('Chat-only model attempted native tool use; execution blocked', 502, 'native_tool_activity');
            const result = await this.handlePermission(p, request, guardSignal, rejected, meta);
            if (result?.handoff) { handoff = result.handoff; break; }
          }
        }
        // A handed-over action becomes the model's answer; no second upstream turn is spent.
        if (handoff) {
          await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {});
          meta.calls = 1;
          meta.handoff = handoff.name;
          successful = true;
          return completion(request.model.id, { role: 'assistant', content: null,
            tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
              function: { name: handoff.name, arguments: JSON.stringify(handoff.arguments) } }] }, await this.handoffUsage(sessionID, signal));
        }
        const info = (response.info && typeof response.info === 'object' ? response.info : {}) as Record<string, unknown>;
        const rawError = info.error as Record<string, unknown> | undefined;
        if (rawError && (request.chatOnly || rawError.name !== 'StructuredOutputError')) {
          const data = (rawError.data && typeof rawError.data === 'object' ? rawError.data : {}) as Record<string, unknown>;
          throw new BridgeError(String(data.message ?? rawError.message ?? rawError.name ?? 'Model request failed'), (data.statusCode as number) || 502, 'model_error');
        }
        // 'invalid' is how OpenCode marks a call whose arguments failed to parse: nothing executed,
        // so it belongs to the format path (correction, then translation), not to native activity.
        const parts = (Array.isArray(response.parts) ? response.parts : []) as Record<string, unknown>[];
        if (parts.some(p => p.type === 'tool' && (request.chatOnly || !['StructuredOutput', 'invalid'].includes(String(p.tool))) && !(rejected.has(String(p.callID)) && (p.state as Record<string, unknown> | undefined)?.status === 'error'))) throw new BridgeError('Unexpected native tool activity; response rejected', 502, 'native_tool_activity');
        // The envelope arrives one of three ways: OpenCode's structured field, the completed
        // StructuredOutput call this adapter asks for, or plain text. Reading only the first
        // and the last rejected a correct answer once, so all three are accepted.
        const structuredPart = parts.find(p => p.type === 'tool' && p.tool === 'StructuredOutput'
          && (p.state as Record<string, unknown> | undefined)?.status === 'completed'
          && (p.state as Record<string, unknown> | undefined)?.input);
        const structuredInput = (structuredPart?.state as Record<string, unknown> | undefined)?.input;
        const structured = info.structured ?? structuredInput;
        const text = structured !== undefined ? JSON.stringify(structured) : parts.filter(p => p.type === 'text').map(p => p.text).join('');
        let message: DecodedMessage;
        try {
          // A reply cut off by the output limit is a failure the model can fix once it is told.
          if (info.finish === 'length') throw new BridgeError('Model output was truncated', 502, 'output_truncated');
          if (!text.trim()) {
            // Name the real cause, and take the same path as any other unreadable reply: an empty
            // envelope deserves the one correction and the translator just like a malformed one.
            const unparsed = parts.find(p => p.type === 'tool' && p.tool === 'invalid');
            if (request.chatOnly) throw new BridgeError('Model returned no text', 502, 'empty_response');
            const detail = (unparsed?.state as Record<string, unknown> | undefined)?.input as Record<string, unknown> | undefined;
            throw new BridgeError(unparsed
              ? `模型交的调用参数不是合法 JSON：${String(detail?.error ?? 'no detail from the runtime')}`
              : '模型没有返回信封：structured、已完成的 StructuredOutput 调用、文本 part 三者都为空', 502, 'invalid_model_output');
          }
          message = request.chatOnly ? { role: 'assistant', content: text } : decode(text, request);
        }
        catch (error) {
          // One correction, one translation, one explicit retry: bounded, and only ever on a path
          // that has already failed. A malformed envelope and a reply cut off by the output limit
          // both land here; unexpected native activity still never does.
          const code = (error as BridgeError).code;
          if (request.chatOnly || signal?.aborted || !['invalid_model_output', 'invalid_tool_call', 'output_truncated'].includes(code)) throw error;
          const cut = code === 'output_truncated';
          if (!attempt) {
            payload.parts = [{ type: 'text', text: cut
              ? 'Your previous response was cut off by the output limit before the envelope was complete. Send it again in a much more compact form: content holds the conclusion, calls hold only the essential arguments, and keep reasoning to a minimum.'
              : 'Your previous response failed the adapter JSON format check. No external tool has been executed from that response. Return the intended answer or external tool proposal using StructuredOutput with exactly {"content":"a string, empty if only calling tools","calls":[{"name":"an allowed external tool name","arguments":{}}]}. Both fields are required; use [] when no tools are needed. Do not invoke native tools, repeat external searches, or claim actions have completed. Preserve the external conversation and its existing tool results.' }];
            continue;
          }
          if (attempt === 1) {
            // Still unreadable: hand the material to the translator. Detection never translates, so a
            // probe keeps measuring the model rather than the translator's help.
            if (!meta.probe) {
              const translated = await this.translate(request, 'envelope', rawMaterial(response, request, error as BridgeError), meta, null, signal);
              if (translated) {
                const message2 = translated as DecodedMessage;
                meta.calls = message2.tool_calls?.length ?? 0; successful = true;
                return completion(request.model.id, message2, info.tokens as TokenUsage);
              }
              // Nothing was inferable, so the model gets one more round with the failure spelled out
              // instead of the turn simply dying here.
              payload.parts = [{ type: 'text', text: resendPrompt({ error: error as BridgeError, repair: meta.repaired?.envelope }) }];
              continue;
            }
          }
          throw error;
        }
        // The model tried to act natively, the table could not express it, and it then answered
        // with text. Translate the blocked action and return it, exactly as a handoff would.
        if (!message.tool_calls?.length && meta.handoffMiss && !meta.probe && !actionRetried) {
          const rescued = await this.translate(request, 'action', rawMaterial(response, request), meta, meta.handoffMiss, signal);
          if (rescued) {
            const action = rescued as ExternalAction;
            await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {});
            meta.calls = 1;
            meta.handoff = action.name;
            successful = true;
            return completion(request.model.id, { role: 'assistant', content: null,
              tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
                function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] }, (info.tokens as TokenUsage) ?? await this.handoffUsage(sessionID, signal));
          }
          if (attempt < 2 && !signal?.aborted) {
            actionRetried = true;
            payload.parts = [{ type: 'text', text: resendPrompt({ repair: meta.repaired?.action, blocked: meta.handoffMiss }) }];
            continue;
          }
        }
        meta.calls = message.tool_calls?.length ?? 0;
        successful = true;
        return completion(request.model.id, message, info.tokens as TokenUsage);
      }
      throw new BridgeError('OpenCode did not produce a usable answer', 502, 'upstream_error');
    } finally {
      guard.abort();
      await watch.catch(() => {});
      this.usageBySession.delete(sessionID);
      if (!this.usageBySession.size) this.stopEvents();
      for (const [id, permission] of this.pendingApprovals)
        if (permission.sessionID === sessionID) this.pendingApprovals.delete(id);
      if (typeof meta.activity === 'function') {
        meta.activity({ sessionID, model: meta.model, type: 'request.done' });
        this.activeRequests.delete(sessionID);
      }
      // Cancellation must stop backend work, not merely disconnect the HTTP request.
      if (!successful) await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {});
      await this.request(route, 'DELETE', undefined, undefined, 5000).catch(e => console.error('Session cleanup failed:', (e as { code?: string; name?: string }).code || (e as Error).name));
    }
  }

  // OpenCode v2: model and agent are fixed at session creation; the prompt endpoint only
  // admits user input (durable admission), and inference runs asynchronously. The bridge
  // polls the message list for a completed assistant message while the permission watch
  // keeps refusing native actions. There is no json_schema format and no StructuredOutput
  // tool, so the envelope is requested through the system text and repaired like any other
  // malformed reply.
  async v2Complete(request: PreparedRequest, signal: AbortSignal | undefined, meta: CompletionMeta = {}): Promise<CompletionResult> {
    meta.steps = 0; meta.nativeAttempts = 0; meta.permissions = [];
    const modelID = stripModelPrefix(request.model.id);
    const session = await this.request('/api/session', 'POST', {
      title: 'opencode2pi-cli',
      agent: request.chatOnly ? 'buddy-chat' : 'buddy-bridge',
      model: { id: modelID, providerID: 'opencode', ...(request.variant ? { variant: request.variant } : {}) },
      permissions: v2Ruleset(v2NativePermissions),
    }, signal);
    const data = (session && typeof session === 'object' && 'data' in session ? (session as { data: unknown }).data : undefined) as Record<string, unknown> | undefined;
    const sessionID = data?.id ? String(data.id) : undefined;
    if (!sessionID) throw new BridgeError('OpenCode v2 session create failed', 502, 'upstream_error');
    const route = `/api/session/${encodeURIComponent(sessionID)}`;
    meta.sessionID = sessionID;
    this.usageBySession.set(sessionID, undefined);
    // Registered even without an activity callback: the execution-outcome event is what ends
    // a turn, and a non-streaming request still needs it.
    this.activeRequests.set(sessionID, meta);
    this.watchEvents();
    this.progress(meta, 'waiting');
    const guard = new AbortController();
    const rejected = new Set<string>();
    const guardSignal = AbortSignal.any([guard.signal, ...(signal ? [signal] : [])]);
    meta.v2Handoff = null;
    meta.v2WatchError = null;
    meta.v2Outcome = null;
    const watch = (async () => {
      while (!guardSignal.aborted) {
        const pending = await this.pendingPermissions(sessionID, guardSignal);
        for (const p of pending ?? []) {
          if (request.chatOnly && p.source?.type === 'tool') throw new BridgeError('Chat-only model attempted native tool use; execution blocked', 502, 'native_tool_activity');
          const result = await this.handlePermission(p, request, guardSignal, rejected, meta);
          // handlePermission returns `{ handoff }`; the poll reads the handoff itself, so it
          // must not store the wrapper or the tool call comes back with no name or arguments.
          if (result?.handoff) { meta.v2Handoff = result.handoff; return; }
        }
        await delay(250, undefined, { signal: guardSignal, ref: false }).catch(() => {});
      }
    })();
    watch.catch(e => { if (!guardSignal.aborted) meta.v2WatchError = e; });
    let successful = false;
    try {
      // v2 has no per-request system field: the adapter instructions and the external
      // conversation travel together in the admitted text.
      const promptBody: Record<string, unknown> = { text: `${request.system}\n\n${request.text}`, delivery: 'steer' };
      if (request.images?.length) promptBody.files = request.images.map(img => ({ uri: img.url, name: img.filename }));
      let actionRetried = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        meta.steps = (meta.steps ?? 0) + 1;
        this.progress(meta, attempt ? 'correcting' : 'waiting');
        this.usageBySession.set(sessionID, undefined);
        meta.v2Outcome = null;
        // The retry loop prompts the SAME session, so a bare "newest assistant message" would
        // answer the previous attempt within a poll. Baseline the ids that already exist.
        const baseline = new Set((await this.v2Messages(sessionID, signal).catch(() => [])).filter(m => m?.type === 'assistant').map(m => String(m.id)));
        await this.request(`${route}/prompt`, 'POST', promptBody, signal, null);
        this.progress(meta, 'checking');
        const result = await this.v2WaitForCompletion(sessionID, baseline, meta, signal, guardSignal);
        if (result.kind === 'handoff') {
          await this.request(`${route}/interrupt`, 'POST', undefined, undefined, 5000).catch(() => {});
          meta.calls = 1;
          meta.handoff = result.handoff.name;
          successful = true;
          return completion(request.model.id, { role: 'assistant', content: null,
            tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
              function: { name: result.handoff.name, arguments: JSON.stringify(result.handoff.arguments) } }] }, await this.handoffUsage(sessionID, signal));
        }
        const response = result.message;
        // v2 SessionError is { type, message, status?, response? }: there is no StructuredOutput
        // tool to spare and no `name`/`data` to read, so the provider's own status carries through.
        const rawError = response?.error as Record<string, unknown> | undefined;
        if (rawError) throw new BridgeError(String(rawError.message ?? rawError.type ?? 'Model request failed'), (rawError.status as number) || 502, 'model_error');
        // A native tool that actually ran without being refused is unexpected activity. A v2 tool
        // state is streaming | running | completed | error, so only `completed` means it ran;
        // refused calls leave an error state that the rejected set explains, and a v2 permission
        // source id is the tool part id.
        const content = (Array.isArray(response?.content) ? response!.content : []) as Record<string, unknown>[];
        const ranNative = content.some(p => p?.type === 'tool'
          && (p?.state as Record<string, unknown> | undefined)?.status === 'completed' && !rejected.has(String(p.id)));
        if (ranNative) throw new BridgeError('Unexpected native tool activity; response rejected', 502, 'native_tool_activity');
        const text = content.filter(p => p?.type === 'text' && typeof p?.text === 'string').map(p => p.text).join('');
        let message: DecodedMessage;
        try {
          if (response?.finish === 'length') throw new BridgeError('Model output was truncated', 502, 'output_truncated');
          if (!text.trim()) {
            if (request.chatOnly) throw new BridgeError('Model returned no text', 502, 'empty_response');
            throw new BridgeError('模型没有返回信封：assistant 消息的文本 part 为空', 502, 'invalid_model_output');
          }
          message = request.chatOnly ? { role: 'assistant', content: text } : decode(text, request);
        }
        catch (error) {
          const code = (error as BridgeError).code;
          if (request.chatOnly || signal?.aborted || !['invalid_model_output', 'invalid_tool_call', 'output_truncated'].includes(code)) throw error;
          const cut = code === 'output_truncated';
          if (!attempt) {
            promptBody.text = `${request.system}\n\n${cut
              ? 'Your previous response was cut off by the output limit before the envelope was complete. Send it again in a much more compact form: content holds the conclusion, calls hold only the essential arguments, and keep reasoning to a minimum.'
              : 'Your previous response failed the adapter JSON format check. No external tool has been executed from that response. Return the intended answer or external tool proposal as exactly one JSON object {"content":"a string, empty if only calling tools","calls":[{"name":"an allowed external tool name","arguments":{}}]}. Both fields are required; use [] when no tools are needed. Do not invoke native tools, repeat external searches, or claim actions have completed. Preserve the external conversation and its existing tool results.'}\n\n${request.text}`;
            continue;
          }
          if (attempt === 1) {
            if (!meta.probe) {
              const translated = await this.translate(request, 'envelope', v2RawMaterial(response, request, error as BridgeError), meta, null, signal);
              if (translated) {
                const message2 = translated as DecodedMessage;
                meta.calls = message2.tool_calls?.length ?? 0; successful = true;
                return completion(request.model.id, message2, response?.tokens as TokenUsage);
              }
              promptBody.text = `${request.system}\n\n${resendPrompt({ error: error as BridgeError, repair: meta.repaired?.envelope })}\n\n${request.text}`;
              continue;
            }
          }
          throw error;
        }
        if (!message.tool_calls?.length && meta.handoffMiss && !meta.probe && !actionRetried) {
          const rescued = await this.translate(request, 'action', v2RawMaterial(response, request), meta, meta.handoffMiss, signal);
          if (rescued) {
            const action = rescued as ExternalAction;
            await this.request(`${route}/interrupt`, 'POST', undefined, undefined, 5000).catch(() => {});
            meta.calls = 1;
            meta.handoff = action.name;
            successful = true;
            return completion(request.model.id, { role: 'assistant', content: null,
              tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
                function: { name: action.name, arguments: JSON.stringify(action.arguments) } }] }, (response?.tokens as TokenUsage) ?? await this.handoffUsage(sessionID, signal));
          }
          if (attempt < 2 && !signal?.aborted) {
            actionRetried = true;
            promptBody.text = `${request.system}\n\n${resendPrompt({ repair: meta.repaired?.action, blocked: meta.handoffMiss })}\n\n${request.text}`;
            continue;
          }
        }
        meta.calls = message.tool_calls?.length ?? 0;
        successful = true;
        return completion(request.model.id, message, response?.tokens as TokenUsage);
      }
      throw new BridgeError('OpenCode did not produce a usable answer', 502, 'upstream_error');
    } finally {
      guard.abort();
      this.usageBySession.delete(sessionID);
      if (!this.usageBySession.size) this.stopEvents();
      for (const [id, permission] of this.pendingApprovals)
        if (permission.sessionID === sessionID) this.pendingApprovals.delete(id);
      this.activeRequests.delete(sessionID);
      if (typeof meta.activity === 'function') meta.activity({ sessionID, model: meta.model, type: 'request.done' });
      // Cancellation must stop backend work, not merely disconnect the HTTP request.
      if (!successful) await this.request(`${route}/interrupt`, 'POST', undefined, undefined, 5000).catch(() => {});
      await this.request(route, 'DELETE', undefined, undefined, 5000).catch(e => console.error('Session cleanup failed:', (e as { code?: string; name?: string }).code || (e as Error).name));
    }
  }

  // v2 gives every model step its own assistant message, so a message that carries a finish
  // reason is not by itself the end of the turn: the native tool-call step finishes exactly the
  // same way. The execution outcome event is the turn signal; the message list only says what
  // was said. `baseline` holds the ids that existed before this prompt, so the retry loop's
  // second and third attempts cannot answer with the previous turn.
  async v2WaitForCompletion(sessionID: string, baseline: ReadonlySet<string>, meta: CompletionMeta, signal: AbortSignal | undefined, guardSignal: AbortSignal): Promise<V2WaitResult> {
    const POLL = 250;
    const NO_MESSAGE = 240;           // an unchanging list with no assistant row at all
    let quiet = 0;
    const newest = (messages: Record<string, unknown>[]) =>
      [...messages].reverse().find(m => m?.type === 'assistant' && !baseline.has(String(m.id))) ?? null;
    for (;;) {
      if (signal?.aborted) throw new BridgeError('Request aborted', 499, 'aborted');
      if (guardSignal.aborted) throw new BridgeError('Request aborted', 499, 'aborted');
      if (meta.v2Handoff) return { kind: 'handoff', handoff: meta.v2Handoff };
      if (meta.v2WatchError) throw meta.v2WatchError;
      let messages: Record<string, unknown>[] | null = null;
      try { messages = await this.v2Messages(sessionID, signal); }
      catch (error) { if (signal?.aborted || guardSignal.aborted) throw error; }
      // Measured against the live 2.0.22 API, the message list is returned oldest-first:
      // the last assistant row is the newest one, and reading the first row returns the
      // opening reasoning placeholder of a long run instead of the final answer. So the
      // newest assistant (the last row) is selected, then checked against the baseline.
      const assistant = newest(messages ?? []);
      if (assistant?.finish) return { kind: 'message', message: assistant };
      if (meta.v2Outcome) {
        // The outcome can arrive just before the message is final; give the store one more
        // read before trusting the newest row.
        let final = assistant;
        if (!final) {
          try { final = newest(await this.v2Messages(sessionID, signal)); }
          catch (error) { if (signal?.aborted || guardSignal.aborted) throw error; }
        }
        if (final) return { kind: 'message', message: final };
        throw new BridgeError('OpenCode v2 session ended without an assistant message', 502, 'upstream_error');
      }
      // Neither the event nor any assistant row: there is nothing left to wait for.
      if (!assistant) quiet += 1; else quiet = 0;
      if (!assistant && quiet >= NO_MESSAGE) throw new BridgeError('OpenCode v2 session ended without an assistant message', 502, 'upstream_error');
      await delay(POLL, undefined, { signal: guardSignal, ref: false }).catch(() => {});
    }
  }
}

type V2WaitResult = { kind: 'handoff'; handoff: ExternalAction } | { kind: 'message'; message: Record<string, unknown> };