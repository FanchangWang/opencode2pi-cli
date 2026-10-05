import { randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import type { CatalogModel, CompletionMeta, ProgressReport } from './backend.ts';
import { prepare, sendSSE, BridgeError, type ChatBody, type CompletionResult, type PreparedRequest } from './protocol.ts';

function authorized(req: http.IncomingMessage, key: string): boolean {
  const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${key}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req: http.IncomingMessage): Promise<ChatBody> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > 8 * 1024 * 1024) throw new BridgeError('Request exceeds 8 MB', 413);
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()) as ChatBody; }
  catch { throw new BridgeError('Invalid JSON'); }
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// omp reads the context window from max_model_len > context_length > limits.sum, and the output
// budget from limits.max_output_tokens; a key is only emitted when the catalog states it, so
// omp keeps its own default instead of a fabricated limit.
function modelList(models: readonly CatalogModel[]): unknown {
  return { object: 'list', data: models.map(m => {
    const context = m.input ?? m.context, limits: Record<string, number> = {};
    if (Number.isInteger(m.input) && (m.input ?? 0) > 0) limits.max_input_tokens = m.input!;
    if (Number.isInteger(m.output) && (m.output ?? 0) > 0) limits.max_output_tokens = m.output!;
    return { id: m.id, object: 'model', owned_by: 'opencode', name: m.name,
      ...(Number.isInteger(context) && (context ?? 0) > 0 ? { context_length: context } : {}),
      ...(Object.keys(limits).length ? { limits } : {}) };
  }) };
}
export type OnResult = (
  model: string | null, ok: boolean, error?: string, status?: number, code?: string,
  durationMs?: number, source?: string, chatOnly?: boolean, meta?: CompletionMeta,
) => Promise<void> | void;

export interface LocalProxyOptions {
  key: string;
  backend: { complete: (request: PreparedRequest, signal: AbortSignal | undefined, meta: CompletionMeta) => Promise<CompletionResult> };
  getModels: () => readonly CatalogModel[];
  status: () => unknown;
  onResult?: OnResult;
  onActivity?: (progress: ProgressReport) => void;
}

export interface LocalProxyServer extends http.Server {
  abortAll: () => void;
}

export function createServer({ key, backend, getModels, status, onResult = () => {}, onActivity }: LocalProxyOptions): LocalProxyServer {
  const active = new Set<AbortController>();
  const server = http.createServer((req, res) => { void handle(req, res); });
  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!authorized(req, key)) return json(res, 401, { error: { message: 'Local proxy API key required', type: 'authentication_error' } });
    // No browser origins are allowed. omp is a local Node process and never sends one.
    if (req.headers.origin) return json(res, 403, { error: { message: 'Browser-origin requests are disabled' } });
    const route = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const controller = new AbortController(); active.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let heartbeat: ReturnType<typeof setInterval> | undefined, model: string | undefined, started = 0, streamStart: { id: string; created: number } | undefined, attempted = false, meta: CompletionMeta = {};
    try {
      if (req.method === 'GET' && route === '/health') return json(res, 200, status());
      if (req.method === 'GET' && (route === '/v1/models' || route === '/models')) return json(res, 200, modelList(getModels()));
      if (req.method !== 'POST' || (route !== '/v1/chat/completions' && route !== '/chat/completions')) return json(res, 404, { error: { message: 'Not found' } });
      if (active.size > 4) throw new BridgeError('At most four requests may run at once', 429, 'busy');
      const body = await readBody(req);
      model = body.model;
      const request = prepare(body, getModels());
      model = request.model.id;
      meta = { tools: request.tools.length, model: request.model.id, ...(onActivity ? { activity: onActivity } : {}) };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': validating model response before emission\n\n');
        heartbeat = setInterval(() => res.write(': waiting\n\n'), 10000);
        const activity = meta.activity;
        meta.activity = progress => {
          if (progress.content === true && !streamStart && !controller.signal.aborted && !res.destroyed && !res.writableEnded) {
            streamStart = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000) };
            res.write(`data: ${JSON.stringify({ ...streamStart, object: 'chat.completion.chunk', model: body.model,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
          }
          activity?.(progress);
        };
      }
      attempted = true;
      started = performance.now();
      const result = await backend.complete(request, controller.signal, meta);
      // A cancelled client must never be recorded as a completed request.
      if (controller.signal.aborted) return;
      await onResult(model ?? null, true, undefined, undefined, undefined, Math.round(performance.now() - started), 'request', undefined, meta);
      result.model = body.model ?? result.model;
      if (body.stream) {
        if (streamStart) Object.assign(result, streamStart);
        sendSSE(res, result, body.stream_options?.include_usage, !!streamStart);
      }
      else json(res, 200, result);
    } catch (e) {
      if (controller.signal.aborted) return;
      const error = e as Error & { status?: number; code?: string };
      const message = error.name === 'TimeoutError' ? 'Model request timed out' : error.message;
      if (attempted) await onResult(model ?? null, false, message, error.status, error.code, Math.round(performance.now() - started), 'request', undefined, meta);
      const payload = { message, type: error.code || 'upstream_error', code: error.code || 'upstream_error' };
      if (res.headersSent) res.end(`data: ${JSON.stringify({ error: payload })}\n\n`);
      else json(res, error.status || 502, { error: payload });
    } finally { clearInterval(heartbeat); active.delete(controller); }
  }
  server.requestTimeout = 20000; server.headersTimeout = 15000;
  return Object.assign(server, { abortAll: () => { for (const c of active) c.abort(); } });
}