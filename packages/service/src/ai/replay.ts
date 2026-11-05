// Replays recorded sessions (session.jsonl from /admin/) under another prompt-cache or compaction policy and prices
// every call, so a policy can be compared on real conversations without spending a model call (#89, #90). It is a
// model of the cache, not a copy of it: docs/ASSISTANT-BENCHMARK.md says how far it agrees with what was billed.
// It replays the same calls, so it cannot see a policy change what the model does: after a compaction the model
// reads files again, which made 150k cost more in real runs than it saves here.

/** USD per token, Opus 5.5 at the rates the session logs record. A 1-hour cache write is 2x input, as Anthropic bills it. */
export const OPUS_PRICES = { input: 4e-6, output: 20e-6, cacheRead: 0.2e-6, cacheWrite5m: 5e-6, cacheWrite1h: 8e-6 }
export type Prices = typeof OPUS_PRICES

export interface ReplayCall {
  /** When the request was sent and when its reply ended, in ms. */
  start: number
  end: number
  /** The whole prompt: uncached input, cache read and cache write. */
  prompt: number
  uncached: number
  output: number
  /** What it was billed, and its cache read and write. */
  cost: number
  cacheRead: number
  cacheWrite: number
}

export interface ReplaySession {
  calls: ReplayCall[]
  /** Keep-alive pings and summaries the recording paid for: left out when a policy is simulated. */
  warmCost: number
  summaryCost: number
  /** The system prompt and tools every conversation starts with, warm from other conversations. */
  shared: number
}

export interface Policy {
  name: string
  ttlMs: number
  writePrice: 'cacheWrite5m' | 'cacheWrite1h'
  /** Keep the cache warm with pings for this long while nothing is sent; 0 for none. */
  warmForMs: number
  /** Ping only while pi's idle rule expects it to pay (ASSISTANT_CACHE_WARMING=idle), not on every gap. */
  warmLikePi?: boolean
  /** Summarize older messages before a call whose prompt passes this; 0 for never. */
  compactAt: number
}

export const KEEP_RECENT_TOKENS = 50_000
// Measured on the compaction benchmark: pi sends the summarized part as text with tool results cut short, about a
// seventh of its tokens, and writes a summary of about 3k tokens.
export const SUMMARY_TOKENS = 3_000
const SUMMARY_INPUT_SHARE = 0.15
const SUMMARY_INSTRUCTIONS_TOKENS = 1_500
const MINUTE = 60_000
// pi's idle cache warming: a refresh is sent when a 15% chance of saving a cold rewrite beats its cost by $0.05
const PI_CONTINUATION = 0.15
const PI_MIN_SAVING = 0.05

export const POLICIES: Policy[] = [
  { name: '5 min (today)', ttlMs: 5 * MINUTE, writePrice: 'cacheWrite5m', warmForMs: 0, compactAt: 0 },
  { name: '1 h', ttlMs: 60 * MINUTE, writePrice: 'cacheWrite1h', warmForMs: 0, compactAt: 0 },
  { name: '5 min + warm 30 min', ttlMs: 5 * MINUTE, writePrice: 'cacheWrite5m', warmForMs: 30 * MINUTE, compactAt: 0 },
  { name: '5 min + warm 60 min', ttlMs: 5 * MINUTE, writePrice: 'cacheWrite5m', warmForMs: 60 * MINUTE, compactAt: 0 },
  { name: 'pi idle warming', ttlMs: 5 * MINUTE, writePrice: 'cacheWrite5m', warmForMs: 30 * MINUTE, compactAt: 0, warmLikePi: true },
  { name: '5 min, compact 150k', ttlMs: 5 * MINUTE, writePrice: 'cacheWrite5m', warmForMs: 0, compactAt: 150_000 },
  { name: '5 min, compact 200k', ttlMs: 5 * MINUTE, writePrice: 'cacheWrite5m', warmForMs: 0, compactAt: 200_000 },
  { name: '1 h, compact 200k', ttlMs: 60 * MINUTE, writePrice: 'cacheWrite1h', warmForMs: 0, compactAt: 200_000 },
  { name: 'pi idle warming, compact 200k', ttlMs: 5 * MINUTE, writePrice: 'cacheWrite5m', warmForMs: 30 * MINUTE, compactAt: 200_000, warmLikePi: true }
]

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const tokens = (usage: Record<string, unknown>, key: string): number => typeof usage[key] === 'number' ? usage[key] : 0

/** The model calls of a pi session file, in order, with what each was billed. */
export function parseSession(text: string): ReplaySession {
  const calls: ReplayCall[] = []
  let warmCost = 0
  let summaryCost = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    if (!record(entry)) continue
    if (entry.type === 'usage' && entry.kind === 'cache_warm' && record(entry.usage) && record(entry.usage.cost)) {
      warmCost += tokens(entry.usage.cost, 'total')
      continue
    }
    if (entry.type === 'compaction' && record(entry.usage) && record(entry.usage.cost)) {
      summaryCost += tokens(entry.usage.cost, 'total')
      continue
    }
    const message = entry.message
    if (entry.type !== 'message' || !record(message) || message.role !== 'assistant' || !record(message.usage)) continue
    const usage = message.usage
    const prompt = tokens(usage, 'input') + tokens(usage, 'cacheRead') + tokens(usage, 'cacheWrite')
    // a reply that failed before the model answered was not billed
    if (prompt === 0) continue
    const start = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(String(entry.timestamp))
    const end = Date.parse(String(entry.timestamp))
    calls.push({
      start, end: Number.isFinite(end) ? Math.max(start, end) : start, prompt, uncached: tokens(usage, 'input'), output: tokens(usage, 'output'),
      cost: record(usage.cost) ? tokens(usage.cost, 'total') : 0, cacheRead: tokens(usage, 'cacheRead'), cacheWrite: tokens(usage, 'cacheWrite')
    })
  }
  // after a long gap only the prefix every conversation shares is still read from cache
  const cold = calls.filter((call, i) => i > 0 && call.cacheRead > 0 && call.cacheWrite > call.cacheRead)
  const shared = cold.length === 0 ? 0 : Math.min(...cold.map((call) => call.cacheRead), calls[0].prompt)
  return { calls, warmCost, summaryCost, shared }
}

export interface ReplayResult {
  cost: number
  /** Calls that found the conversation's cache expired and wrote it again. */
  coldWrites: number
  coldCost: number
  warmPings: number
  warmCost: number
  compactions: number
  compactionCost: number
  /** Context of the largest call after compaction. */
  peakPrompt: number
}

export function replay(session: ReplaySession, policy: Policy, prices: Prices = OPUS_PRICES): ReplayResult {
  const result: ReplayResult = { cost: 0, coldWrites: 0, coldCost: 0, warmPings: 0, warmCost: 0, compactions: 0, compactionCost: 0, peakPrompt: 0 }
  const write = prices[policy.writePrice]
  const pingEvery = policy.ttlMs * 0.9
  let cached = 0
  let touched = 0
  // tokens compaction has taken out of every later prompt
  let removed = 0
  const worthPinging = (): boolean => !policy.warmLikePi ||
    PI_CONTINUATION * cached * (write - prices.cacheRead) - cached * prices.cacheRead >= PI_MIN_SAVING
  const ping = (count: number): void => {
    const cost = count * (cached * prices.cacheRead + prices.output)
    result.warmPings += count
    result.warmCost += cost
    result.cost += cost
  }
  for (const call of session.calls) {
    let prompt = Math.max(session.shared, call.prompt - removed)
    let compacted = false
    if (policy.compactAt > 0 && prompt > policy.compactAt) {
      const kept = session.shared + SUMMARY_TOKENS + KEEP_RECENT_TOKENS
      const summarized = Math.max(0, prompt - session.shared - KEEP_RECENT_TOKENS)
      // the summary has its own system prompt and gets the conversation as text: nothing of it is cached
      const cost = (summarized * SUMMARY_INPUT_SHARE + SUMMARY_INSTRUCTIONS_TOKENS) * prices.input + SUMMARY_TOKENS * prices.output
      result.compactions++
      result.compactionCost += cost
      result.cost += cost
      removed += prompt - kept
      prompt = kept
      compacted = true
    }
    const gap = call.start - touched
    let warm = cached > 0 && gap <= policy.ttlMs
    if (!warm && cached > 0 && policy.warmForMs > 0 && worthPinging()) {
      const pings = Math.floor(Math.min(gap, policy.warmForMs) / pingEvery)
      ping(pings)
      warm = gap <= pings * pingEvery + policy.ttlMs
    }
    const read = compacted ? Math.min(session.shared, prompt) : warm ? Math.min(cached, prompt) : Math.min(session.shared, prompt)
    const written = Math.max(0, prompt - read - call.uncached)
    const cost = read * prices.cacheRead + written * write + call.uncached * prices.input + call.output * prices.output
    if (!warm && cached > 0 && !compacted) {
      result.coldWrites++
      result.coldCost += written * write
    }
    result.cost += cost
    result.peakPrompt = Math.max(result.peakPrompt, prompt)
    cached = prompt
    touched = call.end
  }
  // a page left open keeps pinging after the last reply
  if (policy.warmForMs > 0 && cached > 0 && worthPinging()) ping(Math.floor(policy.warmForMs / pingEvery))
  return result
}
