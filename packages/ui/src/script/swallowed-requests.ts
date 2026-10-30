// The `game.request` calls whose refusal a script catches and then drops.
//
// Every player action in a multiplayer game is a request, and the runtime
// refuses some (asked too often, too much data, nothing answers it) and loses
// others (no answer in time). A `.catch(() => { busy = false })` turns each of
// those into a key the player presses that does nothing.
//
// Light on purpose, like the rest of runs-on: a handler counts as handling the
// refusal when it calls anything at all, throws, or reads the error — a call to
// a function we cannot see might well show a toast, and a stored error might be
// what the HUD renders. What is left is a handler made only of assignments, or
// nothing.
import type { ScriptSource } from '../prefabs/script-source'
import { gameRequestSites, matchingBracket } from './runs-on'

export interface SwallowedRequest {
  /** the message name, or null when the call computes it */
  name: string | null
  /** `.catch(…)` on the call's chain, or a `try { await … } catch {}` around it */
  form: 'catch' | 'try'
}

// Words that sit in front of a parenthesis without being a call.
const NOT_A_CALL = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'void', 'await',
  'in', 'of', 'delete', 'yield', 'case', 'else', 'do', 'function', 'async'
])

/** The masked code between two offsets, with string contents blanked as well. */
function codeBetween(source: ScriptSource, from: number, to: number): string {
  let out = ''
  for (let i = from; i < to; i++) out += source.inString[i] === 1 ? ' ' : source.code[i]
  return out
}

/** True when this body does nothing a player or a log could notice. */
function dropsIt(body: string, param: string | null): boolean {
  if (/\bthrow\b|\bnew\s/.test(body)) return false
  if (param !== null && new RegExp(`(?:^|[^\\w$.])${param.replace(/\$/g, '\\$')}(?![\\w$])`).test(body)) return false
  for (const m of body.matchAll(/([\w$]+|[\])])\s*(?:\?\.\s*)?\(/g)) {
    if (!NOT_A_CALL.has(m[1])) return false
  }
  return true
}

/** The handler a `.catch(` holds, from its open paren: true when it drops the error. */
function handlerDrops(source: ScriptSource, open: number, close: number): boolean {
  const start = open + 1 + (/^\s*/.exec(source.code.slice(open + 1, close))?.[0].length ?? 0)
  const head = source.code.slice(start, close)
  const asyncLen = /^async\s+/.exec(head)?.[0].length ?? 0
  const at = start + asyncLen
  const rest = source.code.slice(at, close)
  let param: string | null = null
  let bodyFrom: number
  if (/^function\b/.test(rest)) {
    const paren = source.code.indexOf('(', at)
    const end = paren < 0 || paren > close ? -1 : matchingBracket(source, paren, ')')
    if (end < 0) return false
    param = /^\s*([\w$]+)/.exec(source.code.slice(paren + 1, end))?.[1] ?? null
    bodyFrom = end + 1
  } else if (rest.startsWith('(')) {
    const end = matchingBracket(source, at, ')')
    if (end < 0 || end > close) return false
    const arrow = /^\s*(?::[^=]*)?=>/.exec(source.code.slice(end + 1, close))
    if (arrow === null) return false
    param = /^\s*([\w$]+)/.exec(source.code.slice(at + 1, end))?.[1] ?? null
    bodyFrom = end + 1 + arrow[0].length
  } else {
    const bare = /^([\w$]+)\s*=>/.exec(rest)
    // a function passed by name (`.catch(retryLater)`) is somebody's handling
    if (bare === null) return false
    param = bare[1]
    bodyFrom = at + bare[0].length
  }
  return dropsIt(codeBetween(source, bodyFrom, close), param)
}

/** `.then(…)`, `.catch(…)` and `.finally(…)` links after a call's closing paren. */
function catchesOnChain(source: ScriptSource, close: number): Array<{ open: number; close: number }> {
  const out: Array<{ open: number; close: number }> = []
  let at = close + 1
  for (;;) {
    const link = /^\s*\.\s*(then|catch|finally)\s*\(/.exec(source.code.slice(at, at + 200))
    if (link === null) return out
    const open = at + link[0].length - 1
    const end = matchingBracket(source, open, ')')
    if (end < 0) return out
    if (link[1] === 'catch') out.push({ open, close: end })
    at = end + 1
  }
}

/** True when the innermost `try { … }` holding this awaited call is followed by a `catch` that drops it. */
function droppingTryAround(source: ScriptSource, open: number, awaited: RegExp): boolean {
  let inner: { brace: number; end: number } | null = null
  for (const m of source.code.matchAll(/(?:^|[^\w$.])try\s*\{/g)) {
    const brace = (m.index ?? 0) + m[0].length - 1
    if (brace > open) break
    const end = matchingBracket(source, brace, '}')
    if (end > open) inner = { brace, end }
  }
  if (inner === null || !awaited.test(source.code.slice(inner.brace, open + 1))) return false
  const clause = /^\s*catch\s*(?:\(\s*([\w$]+)[^)]*\))?\s*\{/.exec(source.code.slice(inner.end + 1, inner.end + 200))
  if (clause === null) return false
  const body = inner.end + clause[0].length
  const bodyEnd = matchingBracket(source, body, '}')
  return bodyEnd >= 0 && dropsIt(codeBetween(source, body + 1, bodyEnd), clause[1] ?? null)
}

export function swallowedRequests(text: string): SwallowedRequest[] {
  const { source, game, sites } = gameRequestSites(text)
  if (game === null) return []
  const awaited = new RegExp(`\\bawait\\s+${game.replace(/\$/g, '\\$')}\\s*\\.\\s*request\\s*(?:<[^<>()]*>)?\\s*\\($`)
  const out: SwallowedRequest[] = []
  for (const site of sites) {
    const close = matchingBracket(source, site.open, ')')
    if (close < 0) continue
    if (catchesOnChain(source, close).some((c) => handlerDrops(source, c.open, c.close))) {
      out.push({ name: site.name, form: 'catch' })
    } else if (droppingTryAround(source, site.open, awaited)) {
      out.push({ name: site.name, form: 'try' })
    }
  }
  return out
}
