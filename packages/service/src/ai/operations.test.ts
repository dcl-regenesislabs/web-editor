import { describe, expect, it, vi } from 'vitest'
import type { AssistantOperation } from '../../../contract/src/analytics.ts'
import type { AssistantServerMessage } from '../../../contract/src/assistant.ts'
import { createConnection } from './connection.ts'
import { createOperations } from './operations.ts'
import type { AgentFactory, AssistantAgent, BrowserCall, TurnUsage } from './types.ts'

const params = { provider: 'claude' as const, text: 'Make a door' }
const WALLET_A = '0x' + 'a'.repeat(40)
const WALLET_B = '0x' + 'b'.repeat(40)

// an agent whose turn calls the given tools and waits until the test lets it finish
function scriptedFactory(script: (call: BrowserCall) => Promise<void>, usage: TurnUsage = { cost: 0.5, tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 }, calls: 2, unreported: 0, responseModel: 'model-from-provider' }): AgentFactory {
  return {
    providers: async () => [],
    create: async (_params, call): Promise<AssistantAgent> => ({
      model: 'chosen-model',
      prompt: () => script(call), abort: async () => {}, dispose: () => {}, snapshot: () => [], takeUsage: () => usage
    })
  }
}

function connect(factory: AgentFactory, operations: ReturnType<typeof createOperations>, wallet: string, extra: Partial<Parameters<typeof createConnection>[0]> = {}) {
  const events: AssistantServerMessage[] = []
  const session = operations.openSession(wallet)
  const connection = createConnection({
    factory, logger: { error: vi.fn(), info: vi.fn() }, send: (event) => events.push(event), allowTurn: () => true, operations: session, ...extra
  })
  const answer = async (ok: boolean) => {
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'call')).toBe(true))
    const call = events.find((event) => event.kind === 'call')
    if (call?.kind !== 'call') throw new Error('No call')
    events.splice(events.indexOf(call), 1)
    connection.receive({ kind: 'result', turnId: call.turnId, callId: call.callId, ok, text: 'done' })
  }
  return { events, connection, session, answer, prompt: (turnId: string) => connection.receive({ kind: 'prompt', turnId, projectId: 'scene', params }) }
}

describe('assistant live operations', () => {
  it('counts sessions and overlapping turns apart, and clears each when it ends', async () => {
    const tracked: AssistantOperation[] = []
    const operations = createOperations({ track: (operation) => tracked.push(operation) })
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const factory = scriptedFactory(async () => { await held })
    const a = connect(factory, operations, WALLET_A)
    const b = connect(factory, operations, WALLET_B)
    connect(factory, operations, WALLET_B)
    a.prompt('one')
    b.prompt('two')
    await vi.waitFor(() => expect(operations.snapshot().turns.map((turn) => turn.model)).toEqual(['chosen-model', 'chosen-model']))
    const live = operations.snapshot()
    expect(live.sessions).toBe(3)
    // ids are the server's own, not the browser's turn ids
    expect(live.turns.map((turn) => turn.id)).not.toContain('one')
    release()
    await vi.waitFor(() => expect(operations.snapshot().turns).toHaveLength(0))
    expect(operations.snapshot().sinceStart).toMatchObject({
      turns: { completed: 2 },
      usage: { prompts: 2, finishedTurns: 2, inputTokens: 200, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 2, estimatedCostUsd: 1, incompleteTurns: 0 }
    })
    expect(operations.snapshot().users.map(({ wallet, prompts, inputTokens, sessions }) => ({ wallet, prompts, inputTokens, sessions }))).toEqual([
      { wallet: WALLET_A, prompts: 1, inputTokens: 100, sessions: 1 },
      { wallet: WALLET_B, prompts: 1, inputTokens: 100, sessions: 2 }
    ])
    await a.connection.close()
    a.session.closed()
    expect(operations.snapshot().sessions).toBe(2)
    const finished = tracked.filter((operation) => operation.action === 'turn_finished')
    expect(finished).toHaveLength(2)
    expect(finished[0]).toMatchObject({
      outcome: 'completed', model: 'model-from-provider', input_tokens: 100, output_tokens: 20,
      cache_read_tokens: 5, cache_write_tokens: 1, model_calls: 2, usage_complete: true, estimated_api_cost_usd: 0.5
    })
  })

  it('tells a completed turn from its tools, and a failed build from a failed turn', async () => {
    const tracked: AssistantOperation[] = []
    const operations = createOperations({ track: (operation) => tracked.push(operation) })
    const client = connect(scriptedFactory(async (call) => {
      await call('build', {}).catch(() => {})
      await call('read_file', { path: 'src/index.ts' })
    }), operations, WALLET_A)
    client.prompt('one')
    await client.answer(false)
    await client.answer(true)
    await vi.waitFor(() => expect(tracked.some((operation) => operation.action === 'turn_finished')).toBe(true))
    expect(tracked.find((operation) => operation.action === 'turn_finished')).toMatchObject({
      outcome: 'completed', tool_calls: 2, failed_tool_calls: 1, builds: 1, failed_builds: 1
    })
  })

  it('names how a turn ended: cancelled, timed out, disconnected or failed', async () => {
    const tracked: AssistantOperation[] = []
    const operations = createOperations({ track: (operation) => tracked.push(operation) })
    const outcome = () => tracked.filter((operation) => operation.action === 'turn_finished').map((operation) => operation.action === 'turn_finished' && operation.outcome)

    const waiting = scriptedFactory(async (call) => { await call('build', {}) })
    const stopped = connect(waiting, operations, WALLET_A)
    stopped.prompt('one')
    await vi.waitFor(() => expect(stopped.events.some((event) => event.kind === 'call')).toBe(true))
    stopped.connection.receive({ kind: 'stop', turnId: 'one' })
    await vi.waitFor(() => expect(outcome()).toEqual(['cancelled']))

    const slow = connect(waiting, operations, WALLET_A, { toolTimeoutMs: 5 })
    slow.prompt('two')
    await vi.waitFor(() => expect(outcome()).toEqual(['cancelled', 'timed_out']))

    const gone = connect(waiting, operations, WALLET_A)
    gone.prompt('three')
    await vi.waitFor(() => expect(gone.events.some((event) => event.kind === 'call')).toBe(true))
    await gone.connection.close()
    gone.session.closed()
    expect(outcome()).toEqual(['cancelled', 'timed_out', 'disconnected'])

    const broken = connect(scriptedFactory(async () => { throw new Error('provider said no') }), operations, WALLET_A)
    broken.prompt('four')
    await vi.waitFor(() => expect(outcome()).toEqual(['cancelled', 'timed_out', 'disconnected', 'failed']))
    expect(operations.snapshot().turns).toEqual([])
  })

  it('counts refused prompts without starting a turn', async () => {
    const tracked: AssistantOperation[] = []
    const operations = createOperations({ track: (operation) => tracked.push(operation) })
    const limited = connect(scriptedFactory(async () => {}), operations, WALLET_A, { allowTurn: () => 'Too many requests. Try again shortly.' })
    limited.prompt('one')
    limited.connection.receive({ kind: 'prompt', turnId: 'two', projectId: 'scene', params: { provider: 'claude', text: '' } })
    const exhausted = connect(scriptedFactory(async () => {}), operations, WALLET_A, {
      usage: { exhausted: async () => true, balance: async () => ({ dailyPercent: 100, dailyResetAt: '', weeklyPercent: 0, weeklyResetAt: '' }), record: vi.fn() }
    })
    exhausted.prompt('three')
    await vi.waitFor(() => expect(operations.snapshot().sinceStart.rejected.allowance).toBe(1))
    expect(operations.snapshot().sinceStart.rejected).toMatchObject({ limited: 1, invalid: 1, allowance: 1 })
    expect(tracked.some((operation) => operation.action === 'turn_started')).toBe(false)
  })

  it('reports missing provider usage as incomplete rather than as zero', async () => {
    const tracked: AssistantOperation[] = []
    const operations = createOperations({ track: (operation) => tracked.push(operation) })
    const client = connect(scriptedFactory(async () => {}, { cost: 0 }), operations, WALLET_A)
    client.prompt('one')
    await vi.waitFor(() => expect(tracked.some((operation) => operation.action === 'turn_finished')).toBe(true))
    expect(tracked.find((operation) => operation.action === 'turn_finished')).toMatchObject({ usage_complete: false, model: 'chosen-model' })
    expect(operations.snapshot().sinceStart.usage).toMatchObject({ prompts: 1, inputTokens: 0, incompleteTurns: 1 })
  })

  it('settles a turn its connection left open when the socket closes', () => {
    const operations = createOperations()
    const session = operations.openSession(WALLET_A)
    session.turnStarted()
    session.closed()
    expect(operations.snapshot()).toMatchObject({ sessions: 0, turns: [], sinceStart: { turns: { disconnected: 1 } } })
  })
})
