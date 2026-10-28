import { describe, expect, it } from 'vitest'
import { createQuotaMonitor } from './quota.ts'

// as Claude sent them on a setup-token response
const headers = (session: string, reset = '1793161200') => ({
  'anthropic-ratelimit-unified-5h-utilization': session, 'anthropic-ratelimit-unified-5h-reset': reset,
  'anthropic-ratelimit-unified-7d-utilization': '0.17', 'anthropic-ratelimit-unified-7d-reset': '1793167200',
  'anthropic-ratelimit-unified-status': 'allowed', 'content-type': 'text/event-stream'
})

describe('Claude plan usage', () => {
  it('reads the session and week from reply headers, waits for the first one, and goes stale', () => {
    let clock = 0
    const monitor = createQuotaMonitor({ now: () => clock })
    expect(monitor.view()).toMatchObject({ state: 'unavailable', windows: [], checkedAt: null })
    monitor.record({ 'content-type': 'application/json' })
    monitor.record({ 'anthropic-ratelimit-unified-5h-utilization': 'n/a' })
    expect(monitor.view().state).toBe('unavailable')
    monitor.record(headers('0.03'))
    expect(monitor.view()).toMatchObject({
      state: 'ok', stale: false, checkedAt: new Date(0).toISOString(),
      windows: [
        { name: 'five_hour', percent: 3, resetsAt: new Date(1793161200 * 1000).toISOString() },
        { name: 'seven_day', percent: 17, resetsAt: new Date(1793167200 * 1000).toISOString() }
      ]
    })
    clock = 31 * 60_000
    expect(monitor.view().stale).toBe(true)
  })

  it('relates the session reading to this service\'s spend, across readings that arrive mid-turn and a reset', () => {
    let spend = 0
    const monitor = createQuotaMonitor({ spend: () => spend })
    monitor.record(headers('0.10'))
    expect(monitor.view().sessionPercentPerUsd).toBeNull()
    // two replies in one turn: the reading rises before the turn's spend lands
    monitor.record(headers('0.12'))
    monitor.record(headers('0.14'))
    spend = 2
    monitor.record(headers('0.14'))
    expect(monitor.view().sessionPercentPerUsd).toBeCloseTo(4 / 2)
    // a new window says nothing about the spend before it
    spend = 3
    monitor.record(headers('0.01', '1793179200'))
    spend = 5
    monitor.record(headers('0.03', '1793179200'))
    expect(monitor.view().sessionPercentPerUsd).toBeCloseTo((4 + 2) / (2 + 2))
  })
})
