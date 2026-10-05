import type { CatalogModel } from './backend.ts';

// Only advertise effort controls that map to an actual OpenCode variant.
export function reasoningEfforts(model: CatalogModel): Record<string, string> {
  if (!model.reasoning) return {};
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const entries = Object.entries(model.variants ?? {})
    .filter(([, options]) => !options.disabled && typeof options.reasoningEffort === 'string' && order.includes(options.reasoningEffort))
    .map(([variant, options]) => [options.reasoningEffort as string, variant]);
  return Object.fromEntries(entries);
}