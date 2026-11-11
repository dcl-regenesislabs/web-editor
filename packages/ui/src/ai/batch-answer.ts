// What a scene_request batch answers. Its history stays for the whole conversation and every later
// call pays for it again, so an edit says what it did and nothing the assistant sent or that every
// other edit of the batch also says. Reads answer in full: their answer is what they were sent for.
import { object } from '@dcl-editor/contract'

const READS = new Set(['outline', 'inspect', 'check', 'findSounds', 'findModels', 'findIcons', 'readThumbnail'])

export type BatchOutcome = { ok: true; result: unknown } | { ok: false; error: string }

export interface BatchAnswer {
  /** one per request, in order; an edit whose every field is in same answers only ok */
  results: Array<BatchOutcome | { ok: true }>
  /** per request type, the fields most of its results share; a result lists such a field only where it differs */
  same?: Record<string, Record<string, unknown>>
  /** set when the batch was stopped before its end: what ran is in results, the rest never started */
  cutShort?: string
}

function isEdit(type: string): boolean {
  return !READS.has(type)
}

function requestOutcomes(value: Record<string, unknown>): string[] | null {
  if (!Array.isArray(value.outcomes)) return null
  return value.outcomes.flatMap((o) => object(o) && typeof o.tool === 'string' && typeof o.detail === 'string' ? [`${o.tool} ${o.detail}`] : [])
}

// echoing back the components written or empty lists filled the conversation with the assistant's own
// input; inspect and outline read them when needed. A move keeps its position: it may have been sent as a
// relative step, and the answer is the only place the result is said.
function brief(type: string, result: unknown): unknown {
  if (!object(result)) return result
  const { components: _components, value: _value, ...rest } = result
  const done = requestOutcomes(rest)
  if (done !== null) {
    delete rest.outcomes
    delete rest.attached
    if (done.length > 0) rest.done = done
  }
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => !(Array.isArray(v) && v.length === 0)))
}

// A field every result of a type has, and at least two of them with one value, is said once.
function hoist(results: Array<Record<string, unknown>>): Record<string, unknown> {
  const same: Record<string, unknown> = {}
  if (results.length < 2) return same
  for (const key of Object.keys(results[0])) {
    if (!results.every((r) => key in r)) continue
    const counts = new Map<string, number>()
    for (const r of results) {
      const text = JSON.stringify(r[key])
      counts.set(text, (counts.get(text) ?? 0) + 1)
    }
    const [text, count] = [...counts].reduce((top, entry) => entry[1] > top[1] ? entry : top)
    if (count < 2) continue
    same[key] = JSON.parse(text) as unknown
    for (const r of results) if (JSON.stringify(r[key]) === text) delete r[key]
  }
  return same
}

export function batchAnswer(items: Array<{ type: string; outcome: BatchOutcome }>): BatchAnswer {
  const firstError = new Map<string, number>()
  const results: BatchOutcome[] = items.map(({ type, outcome }, i) => {
    if (!outcome.ok) {
      const seen = firstError.get(outcome.error)
      if (seen !== undefined) return { ok: false, error: `As request ${seen}.` }
      firstError.set(outcome.error, i + 1)
      return outcome
    }
    return isEdit(type) ? { ok: true, result: brief(type, outcome.result) } : outcome
  })
  const byType = new Map<string, Array<Record<string, unknown>>>()
  results.forEach((outcome, i) => {
    const type = items[i].type
    if (outcome.ok && isEdit(type) && object(outcome.result)) byType.set(type, [...(byType.get(type) ?? []), outcome.result])
  })
  const same: Record<string, Record<string, unknown>> = {}
  for (const [type, list] of byType) {
    const shared = hoist(list)
    if (Object.keys(shared).length > 0) same[type] = shared
  }
  const shown = results.map((outcome) => outcome.ok && object(outcome.result) && Object.keys(outcome.result).length === 0 ? { ok: true as const } : outcome)
  return Object.keys(same).length > 0 ? { results: shown, same } : { results: shown }
}
