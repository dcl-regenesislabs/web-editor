// What the playtest tells the assistant about the game: game.state as this player's client holds it,
// the round, the shared clock, and this player's last few requests, read off the one console line
// game.ts prints when the editor bumps editor::GameProbe. Pure: log text in, a bounded view out.
import { object } from '@dcl-editor/contract'
import { GAME_PROBE_MARKER } from '../features/play/game-life'

export interface ProbeRequest {
  name: string
  at: number
  reply?: string
  refused?: string
}

export interface ProbeAnswer {
  state: Record<string, unknown>
  /** keys game.ts left out to stay under the engine's line cap, with their size in bytes */
  omitted: Record<string, number>
  now: number
  life: string
  requests: ProbeRequest[]
}

const LIMITS = { depth: 4, items: 12, keys: 24, chars: 160 }
const MAX_CHANGES = 20
const DIFF_DEPTH = 8

function asRequest(value: unknown): ProbeRequest[] {
  if (!object(value) || typeof value.name !== 'string' || typeof value.at !== 'number') return []
  return [{
    name: value.name, at: value.at,
    ...(typeof value.reply === 'string' ? { reply: value.reply } : {}),
    ...(typeof value.refused === 'string' ? { refused: value.refused } : {})
  }]
}

/** The answer to probe `seq`, or null while it has not printed. Throws when the line arrived cut. */
export function parseProbe(logs: string, seq: number): ProbeAnswer | null {
  const mark = `${GAME_PROBE_MARKER} ${seq} `
  const line = logs.split('\n').reverse().find((text) => text.includes(mark))
  if (line === undefined) return null
  let raw: unknown
  try {
    raw = JSON.parse(line.slice(line.indexOf(mark) + mark.length))
  } catch (e) {
    throw new Error(`The game's state reached the editor cut short: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!object(raw) || !object(raw.state)) throw new Error('The game answered the state probe in a shape the editor does not read.')
  const omitted: Record<string, number> = {}
  if (object(raw.omitted)) for (const [key, bytes] of Object.entries(raw.omitted)) if (typeof bytes === 'number') omitted[key] = bytes
  return {
    state: raw.state, omitted,
    now: typeof raw.now === 'number' ? raw.now : 0,
    life: typeof raw.life === 'string' ? raw.life : 'unknown',
    requests: Array.isArray(raw.requests) ? raw.requests.flatMap(asRequest) : []
  }
}

/** A copy of value small enough to read: deep levels, long lists and long strings are cut, and say so. */
export function bounded(value: unknown, depth = 0): { value: unknown; cut: boolean } {
  if (typeof value === 'string') {
    return value.length > LIMITS.chars ? { value: `${value.slice(0, LIMITS.chars)}… (${value.length} chars)`, cut: true } : { value, cut: false }
  }
  if (value === null || typeof value !== 'object') return { value, cut: false }
  const entries: Array<[string, unknown]> = Array.isArray(value) ? value.map((item, i) => [String(i), item]) : Object.entries(value)
  if (depth >= LIMITS.depth) return { value: Array.isArray(value) ? `[${entries.length} items]` : `{${entries.length} keys}`, cut: entries.length > 0 }
  const cap = Array.isArray(value) ? LIMITS.items : LIMITS.keys
  let cut = entries.length > cap
  const kept = entries.slice(0, cap).map(([key, item]): [string, unknown] => {
    const inner = bounded(item, depth + 1)
    cut ||= inner.cut
    return [key, inner.value]
  })
  const more = `… ${entries.length - cap} more`
  if (Array.isArray(value)) return { value: [...kept.map(([, item]) => item), ...(entries.length > cap ? [more] : [])], cut }
  return { value: Object.fromEntries(entries.length > cap ? [...kept, ['…', more]] : kept), cut }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Every path whose value differs, as `stations.board.chopped` or `orders.0`, each with before and after. */
export function stateChanges(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { before: unknown; after: unknown }> {
  const out: Array<[string, { before: unknown; after: unknown }]> = []
  const walk = (path: string, a: unknown, b: unknown, depth: number): void => {
    if (same(a, b)) return
    const nested = depth < DIFF_DEPTH && ((object(a) && object(b)) || (Array.isArray(a) && Array.isArray(b) && a.length === b.length))
    if (nested) {
      const left = a as Record<string, unknown>
      const right = b as Record<string, unknown>
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) walk(path === '' ? key : `${path}.${key}`, left[key], right[key], depth + 1)
      return
    }
    out.push([path, { before: bounded(a === undefined ? null : a).value, after: bounded(b === undefined ? null : b).value }])
  }
  walk('', before, after, 0)
  const changes = Object.fromEntries(out.slice(0, MAX_CHANGES))
  if (out.length > MAX_CHANGES) changes['…'] = { before: null, after: `${out.length - MAX_CHANGES} more changed paths` }
  return changes
}

/**
 * The game as the playtest result shows it. `before` is the answer read before the action (or at
 * the previous playtest result): with it come `changed` and which requests are new since then.
 */
export function gameView(answer: ProbeAnswer, before: ProbeAnswer | null, since: string): Record<string, unknown> {
  const { round, ...rest } = answer.state
  const state = bounded(rest)
  const notes: string[] = []
  if (state.cut) notes.push('Long or deep values are cut (… marks where).')
  for (const [key, bytes] of Object.entries(answer.omitted)) notes.push(`state.${key} (${bytes} bytes) is too large to show here.`)
  const requests = answer.requests.map((request) => ({
    name: request.name,
    secondsAgo: Math.max(0, Math.round((answer.now - request.at) / 100) / 10),
    ...(request.refused !== undefined ? { refused: request.refused } : { reply: request.reply ?? null }),
    ...(before !== null && request.at > before.now ? { new: true } : {})
  }))
  return {
    life: answer.life,
    now: answer.now,
    round: object(round) ? { id: round.id, number: round.number, phase: round.phase } : null,
    state: state.value,
    ...(before === null ? {} : { since, changed: stateChanges(before.state, answer.state) }),
    requests,
    ...(notes.length > 0 ? { notes } : {})
  }
}
