/**
 * Which models the roster hides, decided by the user rather than by us.
 *
 * Health is annotation by default: a model that failed one probe stays in the
 * list, because the evidence says verdicts move. Measured 2026-10-06 on the same
 * lane, `muse-spark-1.3-contributor-free` answered ✅ while opencode2pi's direct
 * lane was region-blocked for it, and `fledge-alpha-free` did the opposite.
 * Anything automatic would therefore be wrong half the time.
 *
 * So the rule set is opt-in, and the user picks it in the TUI. What is *never*
 * offered is hiding on a quota pause or an unreachable local server: those are
 * facts about the lane, not about the model, and hiding on them empties the
 * roster at exactly the moment it is worth having.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type { HealthStore, ProbeResult } from './health.ts'
import type { UpstreamFailure } from './errors.ts'
import { atomicWrite } from './atomic.ts'
import { resolveDataDirectory } from './platform.ts'

export interface ProbeFilters {
  /** Hide models the upstream refuses from this egress. */
  readonly hideRegionBlocked: boolean
  /** Hide models that failed for a reason attributable to them. */
  readonly hideFailed: boolean
}

export const DEFAULT_FILTERS: ProbeFilters = { hideRegionBlocked: false, hideFailed: false }

/**
 * Failures that belong to the model rather than to the lane.
 *
 * `RATE_LIMIT` and `RUNTIME_MISSING` are deliberately absent: a 429 hit one model
 * while its neighbours answered 200 in the same minute, and a missing local
 * server says nothing about any model at all. Hiding on either would empty the
 * roster during a transient and refill it later, which is the behaviour this
 * whole feature exists to avoid.
 */
const MODEL_VERDICTS: ReadonlySet<string> = new Set([
  'MODEL_GONE',
  'REGION_BLOCKED',
  'REQUEST_REJECTED',
  'UPSTREAM',
])

/** Ids the roster should not advertise under these filters. */
export function hiddenModels(results: readonly ProbeResult[], filters: ProbeFilters): ReadonlySet<string> {
  if (!filters.hideFailed && !filters.hideRegionBlocked) return new Set()
  const hidden = new Set<string>()
  for (const result of results) {
    if (filters.hideRegionBlocked && result.kind === 'REGION_BLOCKED') hidden.add(result.modelId)
    else if (filters.hideFailed && MODEL_VERDICTS.has(result.kind)) hidden.add(result.modelId)
  }
  return hidden
}

/** The same rule applied to a stored health record rather than a fresh result. */
export function hiddenFromStore(store: HealthStore, filters: ProbeFilters): ReadonlySet<string> {
  const hidden = new Set<string>()
  for (const [id, record] of Object.entries(store)) {
    if (filters.hideRegionBlocked && record.kind === 'REGION_BLOCKED') hidden.add(id)
    else if (filters.hideFailed && MODEL_VERDICTS.has(record.kind)) hidden.add(id)
  }
  return hidden
}

/**
 * Whether the roster the provider was registered with differs from the one the
 * current filters produce.
 *
 * The switches are not the question. A user who re-picks the option already in
 * force has changed no switch, yet the registry may still be holding the list
 * from before the choice existed — comparing switches answered "no change" and
 * left every model visible in `/model`.
 */
export function hiddenChanged(previous: ReadonlySet<string>, next: ReadonlySet<string>): boolean {
  return previous.size !== next.size || [...next].some(id => !previous.has(id));
}

function storeFile(): string {
  return path.join(resolveDataDirectory(), 'filters.json')
}

export async function loadFilters(): Promise<ProbeFilters> {
  try {
    const parsed: unknown = JSON.parse(await readFile(storeFile(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_FILTERS
    const record = parsed as Partial<ProbeFilters>
    return {
      hideRegionBlocked: record.hideRegionBlocked === true,
      hideFailed: record.hideFailed === true,
    }
  } catch {
    return DEFAULT_FILTERS
  }
}

export async function saveFilters(filters: ProbeFilters): Promise<void> {
  try {
    await atomicWrite(storeFile(), JSON.stringify(filters))
  } catch {
    // An unwritable filter file costs one re-selection, never a wrong roster.
  }
}
