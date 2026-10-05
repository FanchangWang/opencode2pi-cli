import type { CatalogModel } from './backend.ts';

export type ModelCategory = 'available' | 'quota' | 'rate_limit' | 'access' | 'timeout' | 'error';

export interface ModelResultShape {
  ok: boolean;
  category: ModelCategory;
  time: string;
  error?: string;
  status?: number;
  code?: string;
  [key: string]: unknown;
}

export interface RequestMeta {
  calls?: number;
  nativeAttempts?: number;
  steps?: number;
  handoff?: string;
  handoffCheck?: unknown;
  repaired?: unknown;
}

// Provider errors do not expose a reliable remaining-balance API.
export function modelResult(ok: boolean, message = '', status?: number, code?: string): ModelResultShape {
  let category: ModelCategory = 'available';
  if (!ok) {
    if (/insufficient[_ ]quota|quota.{0,30}(exceed|exhaust|deplet)|out of credits|insufficient.{0,20}(credit|balance)|额度.{0,10}(不足|用尽)/i.test(message)) category = 'quota';
    else if (status === 429 || /rate.?limit|too many requests/i.test(message)) category = 'rate_limit';
    else if (status === 401 || status === 403) category = 'access';
    else if (/timeout|timed out/i.test(message)) category = 'timeout';
    else category = 'error';
  }
  return { ok, category, time: new Date().toISOString(), ...(message ? { error: message } : {}), ...(status ? { status } : {}), ...(code ? { code } : {}) };
}

// A request result carries what the adapter observed on this one work item (tool calls,
export function withRequestMeta<T extends ModelResultShape>(result: T, meta: RequestMeta = {}): T {
  if (!meta || typeof meta !== 'object') return result;
  const row = result as ModelResultShape;
  if (Number.isInteger(meta.calls)) row.calls = meta.calls;
  if (Number.isInteger(meta.nativeAttempts)) row.nativeAttempts = meta.nativeAttempts;
  if (Number.isInteger(meta.steps)) row.steps = meta.steps;
  if (typeof meta.handoff === 'string') row.handoff = meta.handoff;
  if (meta.handoffCheck) row.handoffCheck = meta.handoffCheck;
  if (meta.repaired) row.repaired = meta.repaired;
  return result;
}

export function clientModelID(model: CatalogModel): string { return `OC · ${model.name}`; }