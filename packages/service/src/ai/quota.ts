import type { AssistantQuotaState } from '../../../contract/src/analytics.ts'

export interface QuotaWindow {
  /** five_hour (the session) or seven_day */
  name: string
  /** Of the Claude account's allowance for this window, shared with anything else signed in to it. */
  percent: number
  resetsAt: string | null
}

export interface QuotaView {
  state: AssistantQuotaState
  windows: QuotaWindow[]
  /** When a Claude reply last carried the reading. */
  checkedAt: string | null
  /** The last reading is older than half an hour: only replies refresh it. */
  stale: boolean
  /**
   * Session (five_hour) percent per estimated API dollar this service spent, learned from how the
   * reading moved; null until enough spend backs it. Other use of the account inflates it.
   */
  sessionPercentPerUsd: number | null
}

export interface QuotaMonitor {
  view(): QuotaView
  /** A Claude response's headers; responses without plan headers are ignored. */
  record(headers: Record<string, string>): void
  /** Spend from now on is this account's again: forget the reading the next one would be compared with. */
  rebase(): void
}

export const DISABLED_QUOTA: QuotaView = { state: 'disabled', windows: [], checkedAt: null, stale: false, sessionPercentPerUsd: null }

const STALE_MS = 30 * 60_000
// below this much observed spend one percent step of the reading swings the estimate too far
const MIN_CALIBRATION_USD = 1
const HEADER = 'anthropic-ratelimit-unified-'
const WINDOWS = [['5h', 'five_hour'], ['7d', 'seven_day']] as const

// Claude reports plan usage on every subscription response, e.g. -5h-utilization: 0.03 and
// -5h-reset: <unix seconds>; Claude Code reads its /usage the same way.
function parseWindows(headers: Record<string, string>): QuotaWindow[] {
  const windows: QuotaWindow[] = []
  for (const [key, name] of WINDOWS) {
    const raw = headers[`${HEADER}${key}-utilization`]
    const utilization = Number(raw)
    if (raw === undefined || raw === '' || !Number.isFinite(utilization)) continue
    const reset = Number(headers[`${HEADER}${key}-reset`])
    windows.push({
      name, percent: Math.max(0, Math.round(utilization * 1000) / 10),
      resetsAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null
    })
  }
  return windows
}

export function createQuotaMonitor(options: {
  /** This service's estimated API spend so far, to relate the session reading to its own use. */
  spend?: () => number
  now?: () => number
} = {}): QuotaMonitor {
  const now = options.now ?? Date.now
  let windows: QuotaWindow[] = []
  let checkedAt: number | null = null
  let previous: { percent: number; resetsAt: string | null; spend: number } | null = null
  let calibration = { percent: 0, usd: 0 }

  function calibrate(session: QuotaWindow | undefined): void {
    const spend = options.spend?.()
    if (session === undefined || spend === undefined) return
    const current = { percent: session.percent, resetsAt: session.resetsAt, spend }
    // a window that reset, or a reading that went down, says nothing about the interval: start over
    if (previous === null || previous.resetsAt !== session.resetsAt || session.percent < previous.percent) {
      previous = current
      return
    }
    // spend lands when a turn ends while readings arrive during it: hold the start until spend moves
    if (spend <= previous.spend) return
    calibration = { percent: calibration.percent + session.percent - previous.percent, usd: calibration.usd + spend - previous.spend }
    previous = current
  }

  return {
    record(headers) {
      const parsed = parseWindows(headers)
      if (parsed.length === 0) return
      calibrate(parsed.find((window) => window.name === 'five_hour'))
      windows = parsed
      checkedAt = now()
    },
    rebase() {
      previous = null
    },
    view() {
      return {
        state: checkedAt === null ? 'unavailable' : 'ok',
        windows,
        checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
        stale: checkedAt !== null && now() - checkedAt > STALE_MS,
        sessionPercentPerUsd: calibration.usd >= MIN_CALIBRATION_USD ? calibration.percent / calibration.usd : null
      }
    }
  }
}
