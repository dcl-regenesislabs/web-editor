import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSessionLog, DEFAULT_SESSION_LOG_LIMITS } from './session-log.ts'
import type { TurnRecord } from './session-log.ts'

const wallet = '0x' + 'a'.repeat(40)
const conversation = 'c'.repeat(32)

function turn(n: number, change: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turnId: `turn-${n}`, projectId: 'kitchen', conversation, startedAt: new Date(n).toISOString(), endedAt: new Date(n + 1).toISOString(),
    ms: 1, outcome: 'completed', model: 'claude-opus-5-5', prompt: `prompt ${n}`,
    steps: [{ n: 1, tool: 'build', thinkMs: 10, toolMs: 20, ok: true, chars: 30 }],
    toolCalls: 1, failedToolCalls: 0, builds: 1, failedBuilds: 0,
    usage: { cost: 0.5, tokens: { input: 1, output: 10, cacheRead: 100, cacheWrite: 5 }, calls: 2 },
    ...change
  }
}

it('keeps every turn and the latest transcript of a conversation, and sums them for the admin list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-sessions-'))
  try {
    const log = createSessionLog(dir)
    const mine = log.forWallet(wallet.toUpperCase().replace('0X', '0x'))
    await mine.record(turn(1), [{ type: 'session' }, { type: 'message', n: 1 }])
    await mine.record(turn(2, { outcome: 'failed', prompt: 'x'.repeat(5000) }), [{ type: 'session' }, { type: 'message', n: 2 }])

    const turns = await log.turns(wallet, conversation)
    expect(turns?.map((t) => t.turnId)).toEqual(['turn-1', 'turn-2'])
    expect(turns?.[1].prompt).toHaveLength(4000)
    expect(await log.transcript(wallet, conversation)).toBe('{"type":"session"}\n{"type":"message","n":2}\n')

    const [summary] = await log.list()
    expect(summary).toMatchObject({
      wallet, conversation, projectId: 'kitchen', turns: 2, steps: 2, firstPrompt: 'prompt 1',
      outcomes: { completed: 1, failed: 1 }, tokens: { input: 2, output: 20, cacheRead: 200, cacheWrite: 10 }, cost: 1
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('refuses paths that are not a wallet and a conversation id, and a turn with no transcript keeps the old one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-sessions-paths-'))
  try {
    const log = createSessionLog(dir)
    expect(() => log.forWallet('../etc')).toThrow('Invalid wallet')
    await log.forWallet(wallet).record(turn(1, { conversation: '../../x' }), [])
    expect(await readdir(dir)).toEqual([])
    expect(await log.turns(wallet, '../' + conversation.slice(3))).toBeNull()
    expect(await log.transcript('0xnotawallet', conversation)).toBeNull()

    await log.forWallet(wallet).record(turn(1), ['first'])
    await log.forWallet(wallet).record(turn(2), undefined)
    expect(await log.transcript(wallet, conversation)).toBe('"first"\n')
    expect(await log.turns(wallet, conversation)).toHaveLength(2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('stops writing past the volume budget and sweeps conversations older than the retention', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assistant-sessions-limits-'))
  try {
    const log = createSessionLog(dir, { ...DEFAULT_SESSION_LOG_LIMITS, totalBytes: 10 })
    await log.forWallet(wallet).record(turn(1), ['first'])
    await log.forWallet(wallet).record(turn(2), ['second'])
    expect(await log.turns(wallet, conversation)).toHaveLength(1)

    const old = new Date(Date.now() - DEFAULT_SESSION_LOG_LIMITS.maxAgeMs - 60_000)
    for (const name of await readdir(join(dir, wallet, conversation))) await utimes(join(dir, wallet, conversation, name), old, old)
    expect(await log.sweep()).toBe(1)
    expect(await log.list()).toEqual([])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
