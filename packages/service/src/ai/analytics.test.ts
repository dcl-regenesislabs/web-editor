import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantServerMessage } from '../../../contract/src/assistant.ts'
import { createSegmentAnalytics } from './analytics.ts'
import { createConnection } from './connection.ts'
import { createOperations } from './operations.ts'
import type { AgentFactory } from './types.ts'

const SALT = 'installation-salt-installation-salt'
const WALLET = '0x' + 'c'.repeat(40)
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function queueDir() {
  const directory = await mkdtemp(join(tmpdir(), 'dcl-analytics-'))
  directories.push(directory)
  return directory
}

interface Sent { messageId: string; userId?: string; anonymousId?: string; event: string; properties: Record<string, unknown> }

function segment(statuses: Array<number | 'network'>) {
  const bodies: string[] = []
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body))
    const status = statuses.shift() ?? 200
    if (status === 'network') throw new Error('offline')
    return new Response('{}', { status })
  })
  const sent = () => bodies.flatMap((body) => (JSON.parse(body) as { batch: Sent[] }).batch)
  return { fetch, bodies, sent }
}

const started = { action: 'turn_started' as const, turn_id: 't', session_id: 's' }

describe('Segment delivery', () => {
  it('keeps events through an outage and resends them with the same ids', async () => {
    let clock = 1_000_000
    const server = segment(['network', 503, 200])
    const analytics = createSegmentAnalytics({ writeKey: 'key', userSalt: SALT, dir: await queueDir(), fetch: server.fetch, now: () => clock })
    analytics.track(started, WALLET)
    analytics.track({ action: 'turn_rejected', reason: 'busy' }, WALLET)
    await analytics.flush()
    expect(analytics.health()).toMatchObject({ queued: 2, delivered: 0, failedAttempts: 1, lastFailure: 'network' })
    await analytics.flush()
    expect(server.fetch).toHaveBeenCalledTimes(1)
    clock += 10_000
    await analytics.flush()
    expect(analytics.health()).toMatchObject({ queued: 2, failedAttempts: 2, lastFailure: '503' })
    clock += 20_000
    await analytics.flush()
    expect(analytics.health()).toMatchObject({ queued: 0, delivered: 2, dropped: 0 })
    const ids = server.sent().map((event) => event.messageId)
    expect(new Set(ids).size).toBe(2)
    expect(ids).toHaveLength(6)
    expect(new Headers(server.fetch.mock.calls[0][1]?.headers).get('authorization')).toBe(`Basic ${Buffer.from('key:').toString('base64')}`)
    await analytics.stop()
  })

  it('drops a batch the source refuses, and the oldest events past the bound', async () => {
    const server = segment([400])
    const analytics = createSegmentAnalytics({ writeKey: 'key', userSalt: SALT, dir: await queueDir(), fetch: server.fetch })
    analytics.track(started)
    await analytics.flush()
    expect(analytics.health()).toMatchObject({ queued: 0, dropped: 1, delivered: 0, lastFailure: '400' })
    const offline = segment(Array.from({ length: 100 }, () => 'network' as const))
    const full = createSegmentAnalytics({ writeKey: 'key', userSalt: SALT, dir: await queueDir(), fetch: offline.fetch })
    for (let n = 0; n < 2050; n++) full.track(started)
    expect(full.health()).toMatchObject({ queued: 2000, dropped: 50 })
    await analytics.stop()
    await full.stop()
  })

  it('delivers after a restart what the previous process had queued', async () => {
    const dir = await queueDir()
    const offline = segment(['network', 'network'])
    const before = createSegmentAnalytics({ writeKey: 'key', userSalt: SALT, dir, fetch: offline.fetch })
    before.track(started, WALLET)
    await before.stop()
    expect(JSON.parse(await readFile(join(dir, 'queue.json'), 'utf8'))).toHaveLength(1)
    const server = segment([200])
    const after = createSegmentAnalytics({ writeKey: 'key', userSalt: SALT, dir, fetch: server.fetch })
    await after.flush()
    expect(after.health()).toMatchObject({ queued: 0, delivered: 1 })
    expect(server.sent()[0].messageId).toBe((JSON.parse(offline.bodies[0]) as { batch: Sent[] }).batch[0].messageId)
    await after.stop()
  })

  it('sends no prompt, reply, file, tool argument, tool result, error text or wallet', async () => {
    const SECRET = 'SENTINEL-do-not-export'
    const server = segment([])
    const analytics = createSegmentAnalytics({ writeKey: 'key', userSalt: SALT, dir: await queueDir(), fetch: server.fetch })
    const operations = createOperations(analytics)
    const events: AssistantServerMessage[] = []
    const factory: AgentFactory = {
      providers: async () => [],
      create: async (_params, call, emit) => ({
        model: 'model',
        async prompt() {
          await call('write_file', { path: `src/${SECRET}.ts`, content: SECRET, revision: null, label: SECRET })
          emit({ text: SECRET })
          throw new Error(SECRET)
        },
        abort: async () => {}, dispose: () => {}, snapshot: () => [SECRET],
        takeUsage: () => ({ cost: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, calls: 1, unreported: 0, responseModel: 'model' })
      })
    }
    const session = operations.openSession(WALLET)
    const connection = createConnection({ factory, logger: { error: vi.fn(), info: vi.fn() }, send: (event) => events.push(event), allowTurn: () => true, operations: session })
    connection.receive({ kind: 'prompt', turnId: 'one', projectId: 'scene', params: { provider: 'claude', text: SECRET, context: SECRET } })
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'call')).toBe(true))
    const call = events.find((event) => event.kind === 'call')
    if (call?.kind !== 'call') throw new Error('No call')
    connection.receive({ kind: 'result', turnId: 'one', callId: call.callId, ok: true, text: SECRET })
    await vi.waitFor(() => expect(operations.snapshot().sinceStart.turns.failed).toBe(1))
    await connection.close()
    session.closed()
    operations.imageGenerated(WALLET, true)
    await analytics.flush()
    const payload = server.bodies.join('\n')
    expect(server.sent().map((event) => event.properties.action)).toEqual(['turn_started', 'turn_finished', 'image_generated'])
    expect(payload).not.toContain(SECRET)
    expect(payload.toLowerCase()).not.toContain(WALLET.slice(2))
    const users = new Set(server.sent().map((event) => event.userId))
    expect(users.size).toBe(1)
    expect([...users][0]).toMatch(/^[0-9a-f]{32}$/)
    await analytics.stop()
  })
})
