import { createHmac } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ASSISTANT_OPERATION_EVENT } from '../../../contract/src/analytics.ts'
import type { AssistantOperation } from '../../../contract/src/analytics.ts'
import type { OperationsSink } from './operations.ts'

export const SEGMENT_BATCH_URL = 'https://api.segment.io/v1/batch'
const MAX_QUEUED = 2000
const BATCH_SIZE = 100
const FLUSH_MS = 10_000
const MAX_BACKOFF_MS = 5 * 60_000
const SEND_TIMEOUT_MS = 10_000

export interface DeliveryHealth {
  enabled: boolean
  queued: number
  delivered: number
  failedAttempts: number
  dropped: number
  lastDeliveryAt: string | null
  lastFailureAt: string | null
  /** An HTTP status or `network`; never a response body. */
  lastFailure: string | null
}

export interface Analytics extends OperationsSink {
  health(): DeliveryHealth
  /** Sends what is queued now; resolves whether or not it got through. */
  flush(): Promise<void>
  stop(): Promise<void>
}

interface Queued {
  messageId: string
  timestamp: string
  userId?: string
  anonymousId?: string
  operation: AssistantOperation
}

export const DISABLED_DELIVERY: DeliveryHealth = {
  enabled: false, queued: 0, delivered: 0, failedAttempts: 0, dropped: 0, lastDeliveryAt: null, lastFailureAt: null, lastFailure: null
}

/** Installation-scoped and one-way: the same wallet maps to the same id here and nowhere else. */
function pseudonymousUser(salt: string, wallet: string): string {
  return createHmac('sha256', salt).update(`dcl-editor-assistant-user:${wallet.toLowerCase()}`).digest('hex').slice(0, 32)
}

export function createSegmentAnalytics(options: {
  writeKey: string
  /** Hashes wallets into user ids; set once per installation and kept. */
  userSalt: string
  /** The bounded delivery queue's directory, on the persistent volume outside project storage. */
  dir: string
  endpoint?: string
  fetch?: typeof fetch
  now?: () => number
  logError?: (message: string) => void
}): Analytics {
  const send = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const endpoint = options.endpoint ?? SEGMENT_BATCH_URL
  const authorization = `Basic ${Buffer.from(`${options.writeKey}:`).toString('base64')}`
  const file = join(options.dir, 'queue.json')
  const health: DeliveryHealth = { ...DISABLED_DELIVERY, enabled: true }
  let queue: Queued[] = []
  const loaded: Promise<void> = readFile(file, 'utf8').then((text) => {
    const saved: unknown = JSON.parse(text)
    if (!Array.isArray(saved)) return
    const valid = saved.filter((event): event is Queued => typeof event === 'object' && event !== null &&
      typeof event.messageId === 'string' && typeof event.timestamp === 'string' && typeof event.operation === 'object')
    queue = [...valid, ...queue].slice(-MAX_QUEUED)
  }).catch(() => {})
  let writes: Promise<void> = Promise.resolve()
  let writePending = false
  let sending: Promise<void> | undefined
  let backoff = 0
  let retryAt = 0
  let stopped = false

  // after the saved queue is loaded, or the first write would replace it
  function persist(): void {
    if (writePending) return
    writePending = true
    writes = writes.then(() => loaded).then(async () => {
      writePending = false
      const snapshot = JSON.stringify(queue)
      await mkdir(options.dir, { recursive: true, mode: 0o700 })
      await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 })
      await rename(`${file}.tmp`, file)
    }).catch(() => { options.logError?.('Analytics queue could not be saved') })
  }

  function failed(reason: string): void {
    health.failedAttempts++
    health.lastFailureAt = new Date(now()).toISOString()
    health.lastFailure = reason
    backoff = Math.min(MAX_BACKOFF_MS, backoff === 0 ? FLUSH_MS : backoff * 2)
    retryAt = now() + backoff
  }

  async function deliver(): Promise<void> {
    await loaded
    while (queue.length > 0 && now() >= retryAt) {
      const batch = queue.slice(0, BATCH_SIZE)
      let status: number
      try {
        const response = await send(endpoint, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          body: JSON.stringify({
            batch: batch.map(({ messageId, timestamp, userId, anonymousId, operation }) => ({
              type: 'track', event: ASSISTANT_OPERATION_EVENT, messageId, timestamp,
              ...(userId === undefined ? { anonymousId } : { userId }),
              properties: operation,
              context: { library: { name: 'dcl-editor-service', version: '1' } }
            }))
          })
        })
        status = response.status
        await response.body?.cancel()
      } catch {
        failed('network')
        return
      }
      if (status >= 200 && status < 300) {
        health.delivered += batch.length
        health.lastDeliveryAt = new Date(now()).toISOString()
        backoff = 0
      } else if (status === 429 || status >= 500 || status === 408) {
        failed(String(status))
        return
      } else {
        // the source refused these events as they are: retrying sends the same refusal
        health.dropped += batch.length
        failed(String(status))
        retryAt = 0
      }
      const sent = new Set(batch.map((event) => event.messageId))
      queue = queue.filter((event) => !sent.has(event.messageId))
      persist()
    }
  }

  function flush(): Promise<void> {
    sending ??= deliver().finally(() => { sending = undefined })
    return sending
  }

  const timer = setInterval(() => { void flush() }, FLUSH_MS)
  timer.unref()

  return {
    track(operation, wallet) {
      if (stopped) return
      queue.push({
        messageId: crypto.randomUUID(),
        timestamp: new Date(now()).toISOString(),
        ...(wallet === undefined ? { anonymousId: 'dcl-editor-service' } : { userId: pseudonymousUser(options.userSalt, wallet) }),
        operation
      })
      if (queue.length > MAX_QUEUED) {
        health.dropped += queue.length - MAX_QUEUED
        queue = queue.slice(-MAX_QUEUED)
      }
      persist()
      if (queue.length >= BATCH_SIZE) void flush()
    },
    health: () => ({ ...health, queued: queue.length }),
    flush,
    async stop() {
      stopped = true
      clearInterval(timer)
      retryAt = 0
      await flush()
      persist()
      await writes
    }
  }
}
