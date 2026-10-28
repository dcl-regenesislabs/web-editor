import { join } from 'node:path'
import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import type { IBaseComponent, IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { createSegmentAnalytics, DISABLED_DELIVERY, SEGMENT_BATCH_URL } from '../ai/analytics.ts'
import type { Analytics, DeliveryHealth } from '../ai/analytics.ts'
import { createOperations } from '../ai/operations.ts'
import type { Operations } from '../ai/operations.ts'
import { createQuotaMonitor, DISABLED_QUOTA } from '../ai/quota.ts'
import type { QuotaView } from '../ai/quota.ts'

const SNAPSHOT_MS = 5 * 60_000

function historyUrl(value: string | undefined): string | undefined {
  const url = value?.trim()
  if (!url) return undefined
  if (!/^https:\/\//.test(url) || !URL.canParse(url)) throw new Error('ANALYTICS_HISTORY_URL must be an https URL')
  return url
}

export interface TelemetryComponent extends IBaseComponent {
  operations: Operations
  quota(): QuotaView
  delivery(): DeliveryHealth
  /** Hand it every Claude response's headers; they carry the plan's usage. */
  recordProviderHeaders(headers: Record<string, string>): void
  historyUrl?: string
}

/** Live state stays in memory; events go to the operator's Segment source only when one is configured. */
export async function createTelemetryComponent({ config, logs }: { config: IConfigComponent; logs: ILoggerComponent }, options: {
  /** The assistant's secret directory on the persistent volume, outside STORAGE_DIR; unset, there is no assistant to report. */
  stateDir?: string
}): Promise<TelemetryComponent> {
  const logger = logs.getLogger('telemetry')
  const writeKey = (await config.getString('SEGMENT_WRITE_KEY'))?.trim()
  const userSalt = await config.getString('ANALYTICS_USER_SALT')
  let analytics: Analytics | undefined
  if (writeKey) {
    if (userSalt === undefined || userSalt.length < 32) throw new Error('ANALYTICS_USER_SALT must be at least 32 characters when SEGMENT_WRITE_KEY is set')
    if (options.stateDir === undefined) throw new Error('SEGMENT_WRITE_KEY needs the assistant configured (its directory holds the delivery queue)')
    analytics = createSegmentAnalytics({
      writeKey, userSalt, dir: join(options.stateDir, 'analytics'),
      endpoint: (await config.getString('SEGMENT_ENDPOINT')) ?? SEGMENT_BATCH_URL,
      logError: (message) => logger.error(message)
    })
  }
  const operations = createOperations(analytics)
  const quota = options.stateDir === undefined ? undefined
    : createQuotaMonitor({ spend: () => operations.snapshot().sinceStart.usage.estimatedCostUsd })
  const view = () => quota?.view() ?? DISABLED_QUOTA
  let snapshots: ReturnType<typeof setInterval> | undefined
  const snapshot = () => {
    const live = operations.snapshot()
    const reading = view()
    const percent = (name: string) => reading.windows.find((window) => window.name === name)?.percent ?? null
    analytics?.track({
      action: 'capacity_snapshot', sessions: live.sessions, running_turns: live.turns.length,
      quota_state: reading.state, quota_five_hour_percent: percent('five_hour'), quota_seven_day_percent: percent('seven_day')
    })
  }
  return {
    operations,
    quota: view,
    delivery: () => analytics?.health() ?? DISABLED_DELIVERY,
    recordProviderHeaders: (headers) => quota?.record(headers),
    historyUrl: historyUrl(await config.getString('ANALYTICS_HISTORY_URL')),
    async [START_COMPONENT]() {
      if (analytics !== undefined) {
        snapshots = setInterval(snapshot, SNAPSHOT_MS)
        snapshots.unref()
      }
    },
    async [STOP_COMPONENT]() {
      clearInterval(snapshots)
      await analytics?.stop()
    }
  }
}
