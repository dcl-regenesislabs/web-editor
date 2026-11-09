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

interface Limits { depth: number; items: number; keys: number; chars: number }

const LIMITS: Limits = { depth: 4, items: 12, keys: 24, chars: 160 }
// a before or after is one value that moved, not a copy of the state around it
const CHANGE_LIMITS: Limits = { depth: 2, items: 6, keys: 8, chars: 80 }
// what status with path shows of the one value asked for
const PATH_LIMITS: Limits = { depth: 6, items: 50, keys: 50, chars: 2000 }
const MAX_CHANGES = 12
const DIFF_DEPTH = 8
// this many paths that differ in one key (movers.0.x … movers.19.x) are reported as one
const GROUP_AT = 3

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
export function bounded(value: unknown, depth = 0, limits = LIMITS): { value: unknown; cut: boolean } {
  if (typeof value === 'string') {
    return value.length > limits.chars ? { value: `${value.slice(0, limits.chars)}… (${value.length} chars)`, cut: true } : { value, cut: false }
  }
  if (value === null || typeof value !== 'object') return { value, cut: false }
  const entries: Array<[string, unknown]> = Array.isArray(value) ? value.map((item, i) => [String(i), item]) : Object.entries(value)
  if (depth >= limits.depth) return { value: Array.isArray(value) ? `[${entries.length} items]` : `{${entries.length} keys}`, cut: entries.length > 0 }
  const cap = Array.isArray(value) ? limits.items : limits.keys
  let cut = entries.length > cap
  const kept = entries.slice(0, cap).map(([key, item]): [string, unknown] => {
    const inner = bounded(item, depth + 1, limits)
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

export interface Change { before: unknown; after: unknown }
/** Paths that differ in one key, as `movers.*.pos.x`: how many, and the one that moved most. */
export interface GroupedChange extends Change { paths: number; example: string }

interface Leaf { path: string[]; before: unknown; after: unknown }

// a short list of plain values reads better whole than item by item
function shortList(list: unknown[]): boolean {
  return list.length <= CHANGE_LIMITS.items && list.every((item) => item === null || typeof item !== 'object')
}

function moved(leaf: Leaf): number {
  return typeof leaf.before === 'number' && typeof leaf.after === 'number' ? Math.abs(leaf.after - leaf.before) : 0
}

function shownChange(leaf: Leaf): Change {
  return { before: bounded(leaf.before, 0, CHANGE_LIMITS).value, after: bounded(leaf.after, 0, CHANGE_LIMITS).value }
}

// Each path joins the pattern (one key replaced by *) that the most other paths share, when GROUP_AT do.
function grouped(leaves: Leaf[]): Array<{ at: number; key: string; leaves: Leaf[] }> {
  const patterns = leaves.map(({ path }) => path.length < 2 ? [] : path.map((_, j) => [...path.slice(0, j), '*', ...path.slice(j + 1)].join('.')))
  const counts = new Map<string, number>()
  for (const list of patterns) for (const pattern of list) counts.set(pattern, (counts.get(pattern) ?? 0) + 1)
  const groups = new Map<string, { at: number; key: string; leaves: Leaf[] }>()
  leaves.forEach((leaf, i) => {
    const best = patterns[i].reduce<string | null>((top, pattern) => top === null || (counts.get(pattern) ?? 0) > (counts.get(top) ?? 0) ? pattern : top, null)
    const key = best !== null && (counts.get(best) ?? 0) >= GROUP_AT ? best : leaf.path.join('.')
    const group = groups.get(key) ?? { at: i, key, leaves: [] }
    group.leaves.push(leaf)
    groups.set(key, group)
  })
  // a pattern whose paths mostly joined other patterns is not a group
  return [...groups.values()].flatMap((group) => group.leaves.length >= GROUP_AT || group.leaves.length === 1 ? [group]
    : group.leaves.map((leaf) => ({ at: leaves.indexOf(leaf), key: leaf.path.join('.'), leaves: [leaf] })))
}

/**
 * The paths whose value differs, as `stations.board.chopped` or `orders.0`, each with before and after: single
 * paths first, then paths that differ only in one key (twenty movers each moving) as one entry, at most max.
 */
export function stateChanges(before: Record<string, unknown>, after: Record<string, unknown>, max = MAX_CHANGES): Record<string, Change | GroupedChange> {
  const leaves: Leaf[] = []
  const walk = (path: string[], a: unknown, b: unknown, depth: number): void => {
    if (same(a, b)) return
    const lists = Array.isArray(a) && Array.isArray(b) && (a.length === b.length || !(shortList(a) && shortList(b)))
    if (depth < DIFF_DEPTH && ((object(a) && object(b)) || lists)) {
      const left = a as Record<string, unknown>
      const right = b as Record<string, unknown>
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) walk([...path, key], left[key], right[key], depth + 1)
      return
    }
    leaves.push({ path, before: a ?? null, after: b ?? null })
  }
  walk([], before, after, 0)
  const groups = grouped(leaves).sort((a, b) => (a.leaves.length > 1 ? 1 : 0) - (b.leaves.length > 1 ? 1 : 0) || a.at - b.at)
  const changes: Record<string, Change | GroupedChange> = {}
  for (const group of groups.slice(0, max)) {
    if (group.leaves.length === 1) changes[group.key] = shownChange(group.leaves[0])
    else {
      const most = group.leaves.reduce((top, leaf) => moved(leaf) > moved(top) ? leaf : top)
      changes[group.key] = { paths: group.leaves.length, example: most.path.join('.'), ...shownChange(most) }
    }
  }
  const rest = groups.slice(max).reduce((sum, group) => sum + group.leaves.length, 0)
  if (rest > 0) changes['…'] = { before: null, after: `${rest} more changed paths` }
  return changes
}

/**
 * The game as the playtest result shows it. `before` is the answer read before the action (or at
 * the previous playtest result): with it come `changed` and which requests are new since then. `path`
 * adds the one value there, with far more of it than state shows.
 */
export function gameView(answer: ProbeAnswer, before: ProbeAnswer | null, since: string, path?: string): Record<string, unknown> {
  const read = path === undefined ? {} : { read: readPath(answer.state, path) }
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
    ...read,
    ...(notes.length > 0 ? { notes } : {})
  }
}

function readPath(state: Record<string, unknown>, path: string): Record<string, unknown> {
  const value = statePath(state, path)
  if (value === undefined) return { path, exists: false }
  const shown = bounded(value, 0, PATH_LIMITS)
  return { path, value: shown.value, ...(shown.cut ? { cut: true } : {}) }
}

/** The value at `path` (`kitchen.boards.0.item`, optionally led by `game.state.`) in state, or undefined. */
export function statePath(state: Record<string, unknown>, path: string): unknown {
  let value: unknown = state
  for (const key of path.replace(/^(game\.)?state\./, '').split('.')) {
    if (Array.isArray(value)) value = value[Number(key)]
    else if (object(value)) value = value[key]
    else return undefined
  }
  return value
}

export type StateCondition = { equals: unknown } | { changes: true } | { exists: boolean }

export function holds(condition: StateCondition, value: unknown, start: unknown): boolean {
  if ('equals' in condition) return same(value, condition.equals)
  if ('changes' in condition) return !same(value, start)
  return condition.exists === (value !== undefined && value !== null)
}

const MAX_REQUESTS = 20

/** Every request either answer listed, once each: a later answer carries the reply an earlier one was still waiting for. */
export function mergeRequests(earlier: ProbeRequest[], later: ProbeRequest[]): ProbeRequest[] {
  const all = new Map<string, ProbeRequest>()
  for (const request of [...earlier, ...later]) all.set(`${request.name}@${request.at}`, request)
  return [...all.values()].sort((a, b) => a.at - b.at).slice(-MAX_REQUESTS)
}
