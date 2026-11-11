import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AssistantServerMessage } from '../../../contract/src/assistant.ts'
import type { UsageBalance } from './usage.ts'
import { createConnection, parsePrompt } from './connection.ts'
import { ProviderLimited } from './types.ts'
import { createUsageMeter } from './usage.ts'

const params = { provider: 'claude' as const, text: 'Build a game' }
const wallet = `0x${'a'.repeat(40)}`
const balance = { dailyPercent: 100, weeklyPercent: 10, dailyResetAt: '2026-10-08T00:00:00.000Z', weeklyResetAt: '2026-10-12T00:00:00.000Z' }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0).reverse()) await close()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function meter(now = Date.now) {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-limits-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return createUsageMeter(dir, { daily: 10, weekly: 100 }, now).forWallet(wallet)
}

function setup(options: Partial<Parameters<typeof createConnection>[0]> = {}) {
  const events: AssistantServerMessage[] = []
  const prompt = vi.fn(async () => {})
  const connection = createConnection({
    factory: {
      providers: async () => [],
      create: async () => ({ prompt, abort: async () => {}, dispose() {}, snapshot: () => ['completed'], takeUsage: () => ({ cost: 10 }) })
    },
    logger: { error: vi.fn(), info: vi.fn() }, allowTurn: () => true, send: (event) => events.push(event), ...options
  })
  cleanup.push(() => connection.close())
  const send = (turnId: string) => connection.receive({ kind: 'prompt', turnId, projectId: 'scene', params })
  const done = (turnId: string) => vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId, ok: true } }))
  return { connection, events, prompt, send, done }
}

it('accepts scene context and prompts above the former character caps', () => {
  for (const input of [{ ...params, context: 'x'.repeat(128_001) }, { ...params, text: 'x'.repeat(32_001) }]) {
    expect(parsePrompt(input)).toEqual(input)
  }
})

it('checks the shared wallet balance before a second tab spends another turn', async () => {
  const usage = await meter()
  const first = setup({ usage })
  const second = setup({ usage })
  first.send('one')
  await first.done('one')
  second.send('two')
  await vi.waitFor(() => expect(second.events).toContainEqual({ kind: 'failure', message: expect.stringContaining('allowance') }))
  expect(second.prompt).not.toHaveBeenCalled()
})

it('accepts a turn on the same connection after the daily allowance resets', async () => {
  let now = Date.parse('2026-10-07T23:59:00Z')
  const usage = await meter(() => now)
  const client = setup({ usage })
  client.send('one')
  await client.done('one')
  now = Date.parse('2026-10-08T00:01:00Z')
  client.send('two')
  await client.done('two')
  expect(client.prompt).toHaveBeenCalledTimes(2)
})

it('reserves the connection while checking an already exhausted allowance', async () => {
  const checked = deferred<boolean>()
  const client = setup({ usage: { exhausted: () => checked.promise, balance: async () => balance, record: async () => balance } })
  client.send('one')
  client.send('two')
  checked.resolve(true)
  await vi.waitFor(() => expect(client.events).toContainEqual({ kind: 'failure', message: expect.stringContaining('allowance') }))
  expect(client.prompt).not.toHaveBeenCalled()
})

it('saves completed memory even if the socket closes during the usage write', async () => {
  const recording = deferred<void>()
  const recorded = deferred<UsageBalance>()
  const memory = { load: async () => null, save: vi.fn(async () => {}), forget: async () => {} }
  const client = setup({
    memory, usage: { balance: vi.fn(), exhausted: async () => false, record: () => { recording.resolve(); return recorded.promise } }
  })
  client.connection.receive({ kind: 'prompt', turnId: 'one', projectId: 'scene', params,
    memory: { id: 'b'.repeat(32), key: Buffer.alloc(32, 7).toString('base64url') } })
  await recording.promise
  const closing = client.connection.close()
  recorded.resolve({ dailyPercent: 10, weeklyPercent: 1, dailyResetAt: '', weeklyResetAt: '' })
  await closing
  expect(memory.save).toHaveBeenCalledWith(expect.anything(), ['completed'])
})

it('starts each browser action timeout when that action is dispatched', async () => {
  vi.useFakeTimers()
  const client = setup({ toolTimeoutMs: 50, factory: {
    providers: async () => [],
    create: async (_params, call) => ({
      prompt: async () => { await Promise.all([call('read_file', { path: 'src/a.ts' }), call('read_file', { path: 'src/b.ts' })]) },
      abort: async () => {}, dispose() {}, snapshot: () => [], takeUsage: () => ({ cost: 0 })
    })
  } })
  client.send('one')
  await vi.advanceTimersByTimeAsync(40)
  const calls = () => client.events.filter((event) => event.kind === 'call')
  expect(calls()).toHaveLength(1)
  client.connection.receive({ kind: 'result', turnId: 'one', callId: calls()[0].callId, ok: true, text: 'a' })
  await vi.advanceTimersByTimeAsync(40)
  expect(calls()).toHaveLength(2)
  client.connection.receive({ kind: 'result', turnId: 'one', callId: calls()[1].callId, ok: true, text: 'b' })
  await vi.advanceTimersByTimeAsync(0)
  expect(client.events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'one', ok: true } })
})

it.each(['build', 'scene_request'] as const)('allows a slow %s to complete after one minute', async (tool) => {
  vi.useFakeTimers()
  const client = setup({ factory: {
    providers: async () => [],
    create: async (_params, call) => ({
      prompt: async () => { await call(tool, {}) }, abort: async () => {}, dispose() {}, snapshot: () => [], takeUsage: () => ({ cost: 0 })
    })
  } })
  client.send('one')
  await vi.advanceTimersByTimeAsync(61_000)
  expect(client.events.some((event) => event.kind === 'event' && event.event.kind === 'error')).toBe(false)
  const call = client.events.find((event) => event.kind === 'call')
  client.connection.receive({ kind: 'result', turnId: 'one', callId: call?.callId, ok: true, text: 'built' })
  await vi.advanceTimersByTimeAsync(0)
  expect(client.events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'one', ok: true } })
})

it('searches the catalog alongside a scene edit while keeping imports ordered', async () => {
  const client = setup({ factory: {
    providers: async () => [],
    create: async (_params, call) => ({
      prompt: async () => { await Promise.all([
        call('scene_request', { request: { type: 'batch', requests: [] } }),
        call('scene_request', { request: { type: 'findModels', query: 'obstacle' } }),
        call('scene_request', { request: { type: 'placeModel', id: 'spinner', into: 'Spinner' } })
      ]) },
      abort: async () => {}, dispose() {}, snapshot: () => [], takeUsage: () => ({ cost: 0 })
    })
  } })
  client.send('one')
  const calls = () => client.events.filter((event) => event.kind === 'call')
  await vi.waitFor(() => expect(calls()).toHaveLength(2))
  const type = (call: { args: Record<string, unknown> }) => (call.args.request as { type: string }).type
  const edit = calls().find(call => type(call) === 'batch')!
  const search = calls().find(call => type(call) === 'findModels')!
  client.connection.receive({ kind: 'result', turnId: 'one', callId: edit.callId, ok: true, text: '{}' })
  await vi.waitFor(() => expect(calls()).toHaveLength(3))
  const imported = calls().find(call => type(call) === 'placeModel')!
  client.connection.receive({ kind: 'result', turnId: 'one', callId: imported.callId, ok: true, text: '{}' })
  client.connection.receive({ kind: 'result', turnId: 'one', callId: search.callId, ok: true, text: '{}' })
  await client.done('one')
})

it('tells the creator when every Claude account is at its limit, and keeps the conversation for later', async () => {
  const events: AssistantServerMessage[] = []
  const prompt = vi.fn(async () => {})
  const dispose = vi.fn()
  const create = vi.fn(async () => ({ prompt, abort: async () => {}, dispose, snapshot: () => [], takeUsage: () => ({ cost: 0 }) }))
  const connection = createConnection({
    factory: { providers: async () => [], create }, logger: { error: vi.fn(), info: vi.fn() },
    allowTurn: () => true, send: (event) => events.push(event)
  })
  cleanup.push(() => connection.close())
  prompt.mockRejectedValueOnce(new ProviderLimited('2026-10-29T03:00:00.000Z'))
  connection.receive({ kind: 'prompt', turnId: 'limited', projectId: 'scene', params })
  await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: {
    kind: 'error', turnId: 'limited', resumable: true,
    message: "The assistant's Claude accounts have all reached their usage limit. Try again after Thu, 29 Oct 2026 03:00:00 GMT."
  } }))
  await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'limited', ok: false } }))
  connection.receive({ kind: 'prompt', turnId: 'later', projectId: 'scene', params })
  await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'later', ok: true } }))
  expect([create.mock.calls.length, dispose.mock.calls.length]).toEqual([1, 0])
})
