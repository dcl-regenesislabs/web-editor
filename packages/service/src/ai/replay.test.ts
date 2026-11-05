import { expect, it } from 'vitest'
import { OPUS_PRICES, parseSession, POLICIES, replay } from './replay.ts'
import type { ReplayCall, ReplaySession } from './replay.ts'

const MINUTE = 60_000
const [today, hour, warm30] = POLICIES

function call(atMinute: number, prompt: number, change: Partial<ReplayCall> = {}): ReplayCall {
  return { start: atMinute * MINUTE, end: atMinute * MINUTE + 10_000, prompt, uncached: 0, output: 1000, cost: 0, cacheRead: 0, cacheWrite: 0, ...change }
}

const session = (calls: ReplayCall[], shared = 20_000): ReplaySession => ({ calls, warmCost: 0, shared })

it('rewrites the whole prompt after an idle gap longer than the cache lasts, and reads it within the hour at 1 h', () => {
  const idle = session([call(0, 100_000), call(10, 110_000)])
  const fiveMinutes = replay(idle, today)
  expect(fiveMinutes).toMatchObject({ coldWrites: 1 })
  // the shared prefix is still read; the rest of the second prompt is written again
  expect(fiveMinutes.coldCost).toBeCloseTo(90_000 * OPUS_PRICES.cacheWrite5m)

  const oneHour = replay(idle, hour)
  expect(oneHour.coldWrites).toBe(0)
  expect(oneHour.cost).toBeLessThan(fiveMinutes.cost)
})

it('keeps the cache warm with pings through a gap, and keeps pinging after the last reply', () => {
  const result = replay(session([call(0, 100_000), call(10, 110_000)]), warm30)
  expect(result.coldWrites).toBe(0)
  // 10 minutes of gap at a ping every 4.5: two pings; then 30 minutes of an open page: six
  expect(result.warmPings).toBe(2 + 6)
  expect(result.warmCost).toBeCloseTo(2 * (100_000 * OPUS_PRICES.cacheRead + OPUS_PRICES.output) + 6 * (110_000 * OPUS_PRICES.cacheRead + OPUS_PRICES.output))
})

it('summarizes once a prompt passes the threshold and carries the smaller context into the calls after it', () => {
  const growing = session([call(0, 60_000), call(1, 160_000), call(2, 170_000), call(3, 180_000)])
  const result = replay(growing, { ...today, name: 'compact 150k', compactAt: 150_000 })
  expect(result.compactions).toBe(1)
  expect(result.compactionCost).toBeCloseTo((160_000 - 20_000 - 50_000 + 1_500) * OPUS_PRICES.input + 4_000 * OPUS_PRICES.output)
  // 20k shared + 4k summary + 50k kept, and each later call adds what it added before
  expect(result.peakPrompt).toBe(74_000 + 20_000)
})

it('reads the calls of a pi session file and sets keep-alive pings apart', () => {
  const lines = [
    { type: 'session', id: 's' },
    { type: 'message', timestamp: '2026-11-02T10:00:05.000Z', message: { role: 'assistant', timestamp: Date.parse('2026-11-02T10:00:00.000Z'), usage: { input: 4, output: 200, cacheRead: 0, cacheWrite: 24_000, cost: { total: 0.124 } } } },
    { type: 'message', timestamp: '2026-11-02T10:00:06.000Z', message: { role: 'toolResult', content: [] } },
    { type: 'message', timestamp: '2026-11-02T10:00:07.000Z', message: { role: 'assistant', timestamp: Date.parse('2026-11-02T10:00:06.500Z'), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
    { type: 'usage', kind: 'cache_warm', usage: { cost: { total: 0.014 } } },
    { type: 'message', timestamp: '2026-11-02T10:20:09.000Z', message: { role: 'assistant', timestamp: Date.parse('2026-11-02T10:20:00.000Z'), usage: { input: 2, output: 100, cacheRead: 23_000, cacheWrite: 40_000, cost: { total: 0.2 } } } }
  ]
  const parsed = parseSession(lines.map((line) => JSON.stringify(line)).join('\n') + '\n{broken')
  expect(parsed.calls.map((c) => [c.prompt, c.end - c.start])).toEqual([[24_004, 5000], [63_002, 9000]])
  expect(parsed.warmCost).toBeCloseTo(0.014)
  // the prefix the cold second call still read
  expect(parsed.shared).toBe(23_000)
})
