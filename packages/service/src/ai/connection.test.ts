import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import type { ResourceLoader } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import type { AssistantServerMessage } from '../../../contract/src/assistant.ts'
import type { AiSendParams } from '../../../contract/src/shell.ts'
import { createConnection, parsePrompt, toolTimeout } from './connection.ts'
import { editorToolDeadlineMs } from '../../../contract/src/editor-tools.ts'
import { createAssistantMemory } from './memory.ts'
import { createSessionLog, type TurnRecord } from './session-log.ts'
import { createUsageMeter } from './usage.ts'
import type { AgentFactory } from './types.ts'

const params = { provider: 'claude' as const, model: 'test', text: 'Edit the door' }

describe('assistant tool bridge', () => {
  it('counts a build that did not compile as a failed build, not a failed call', async () => {
    const events: AssistantServerMessage[] = []
    const record = vi.fn(async (_turn: TurnRecord, _transcript: unknown[] | undefined) => {})
    const factory: AgentFactory = {
      providers: async () => [],
      create: async (_params, call) => ({
        prompt: async () => { await call('build', {}) },
        abort: async () => {}, dispose: () => {}, snapshot: () => [], takeUsage: () => ({ cost: 0 })
      })
    }
    const connection = createConnection({
      factory, logger: { error: vi.fn(), info: vi.fn() }, send: (e) => events.push(e), allowTurn: () => true, sessions: { record }
    })
    connection.receive({ kind: 'prompt', turnId: 'one', projectId: 'scene', params })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'call')).toBe(true))
    const call = events.find((e) => e.kind === 'call')
    if (call?.kind !== 'call') throw new Error('No call')
    const text = JSON.stringify({ ok: false, diagnostics: [{ severity: 'error', message: 'Could not resolve "./src/scripts/Game.ts"' }] })
    connection.receive({ kind: 'result', turnId: 'one', callId: call.callId, ok: true, text })
    await vi.waitFor(() => expect(record).toHaveBeenCalled())
    expect(record.mock.calls[0][0]).toMatchObject({ builds: 1, failedBuilds: 1, toolCalls: 1, failedToolCalls: 0 })
    await connection.close()
  })

  it('waits for the matching browser result and retains the agent for the next turn', async () => {
    const events: AssistantServerMessage[] = []
    const results: string[] = []
    const factory: AgentFactory = {
      providers: async () => [],
      create: vi.fn(async (_params, call, emit) => ({
        prompt: async () => { results.push(await call('read_file', { path: 'src/scripts/Door.ts', label: 'Reading the door' })); emit({ text: 'Done' }) },
        abort: async () => {}, dispose: () => {}, snapshot: () => [], takeUsage: () => ({ cost: 0 })
      }))
    }
    const connection = createConnection({ factory, logger: { error: vi.fn(), info: vi.fn() }, send: (e) => events.push(e), allowTurn: () => true })
    connection.receive({ kind: 'prompt', turnId: 'one', projectId: 'scene', params })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'call')).toBe(true))
    const call = events.find((e) => e.kind === 'call')
    if (call?.kind !== 'call') throw new Error('No call')
    expect(call.label).toBe('Reading the door')
    expect(call.args).toEqual({ path: 'src/scripts/Door.ts' })
    connection.receive({ kind: 'result', turnId: 'foreign', callId: call.callId, ok: true, text: 'wrong' })
    expect(results).toEqual([])
    connection.receive({ kind: 'result', turnId: 'one', callId: call.callId, ok: true, text: 'browser content' })
    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'one', ok: true } }))
    expect(results).toEqual(['browser content'])
    connection.receive({ kind: 'prompt', turnId: 'two', projectId: 'scene', params })
    expect(factory.create).toHaveBeenCalledTimes(1)
    connection.close()
  })

  it('cancels a pending browser tool and disposes the agent on disconnect', async () => {
    const dispose = vi.fn()
    const abort = vi.fn(async () => {})
    const events: AssistantServerMessage[] = []
    const factory: AgentFactory = {
      providers: async () => [],
      create: async (_params, call) => ({
        prompt: async () => { await call('write_file', { path: 'src/scripts/Door.ts' }) }, abort, dispose, snapshot: () => [], takeUsage: () => ({ cost: 0 })
      })
    }
    const connection = createConnection({ factory, logger: { error: vi.fn(), info: vi.fn() }, send: (e) => events.push(e), allowTurn: () => true })
    connection.receive({ kind: 'prompt', turnId: 'one', projectId: 'scene', params })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'call')).toBe(true))
    expect(events.find((e) => e.kind === 'call')).not.toHaveProperty('label')
    connection.close()
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
    expect(abort).toHaveBeenCalledOnce()
    expect(events.filter((e) => e.kind === 'event' && e.event.kind === 'done')).toEqual([])
  })

  it('pauses the turn when a tool without a deadline of its own times out, prevents retries, and hides provider errors', async () => {
    const events: AssistantServerMessage[] = []
    let toolError = ''
    const connection = createConnection({
      logger: { error: vi.fn(), info: vi.fn() }, send: (e) => events.push(e), allowTurn: () => true, toolTimeoutMs: 5,
      factory: {
        providers: async () => [],
        create: async (_params, call) => ({
          async prompt() {
            try { await call('write_file', {}) } catch (error) { toolError = String(error) }
            await expect(call('write_file', {})).rejects.toThrow('cancelled')
            throw new Error('a provider credential must not appear')
          },
          abort: async () => {}, dispose: () => {}, snapshot: () => [], takeUsage: () => ({ cost: 0 })
        })
      }
    })
    connection.receive({ kind: 'prompt', turnId: 'one', projectId: 'scene', params })
    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'one', ok: false } }))
    expect(toolError).toContain('browser did not answer')
    // paused, so Continue carries the same conversation on from the failed call
    expect(events).toContainEqual({ kind: 'event', event: { kind: 'error', turnId: 'one', message: 'Saving a file timed out. Check the scene, then continue.', resumable: true } })
    expect(events.filter((event) => event.kind === 'call')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('credential must not appear')
    connection.close()
  })

  it.each(['build', 'scene_request', 'playtest'] as const)('answers a %s that timed out with an error the model can act on, and the turn goes on', async (tool) => {
    vi.useFakeTimers()
    const events: AssistantServerMessage[] = []
    const info = vi.fn()
    let toolError = ''
    const args = { action: 'status' }
    const connection = createConnection({
      logger: { error: vi.fn(), info }, send: (e) => events.push(e), allowTurn: () => true,
      factory: {
        providers: async () => [],
        create: async (_params, call) => ({
          async prompt() {
            try { await call(tool, args) } catch (error) { toolError = String(error) }
            await call('read_file', { path: 'src/index.ts' })
          },
          abort: async () => {}, dispose: () => {}, snapshot: () => [], takeUsage: () => ({ cost: 0 })
        })
      }
    })
    try {
      const limit = toolTimeout(tool, args)
      connection.receive({ kind: 'prompt', turnId: 'one', projectId: 'scene', params })
      await vi.advanceTimersByTimeAsync(limit - 1)
      expect(toolError).toBe('')
      await vi.advanceTimersByTimeAsync(1)
      expect(toolError).toBe(`Error: The ${{ build: 'build', scene_request: 'scene request', playtest: 'playtest' }[tool]} did not answer within ${limit / 1000} s; ` +
        'the editor may have reloaded, or it is stuck on the scene. ' + (tool === 'scene_request'
        ? 'A batch may have applied part of its requests: check with outline what landed before sending any of it again.'
        : 'Try again once, or carry on and tell the creator what is left.'))
      expect(events.some((e) => e.kind === 'event' && e.event.kind === 'error')).toBe(false)
      expect(info).toHaveBeenCalledWith(`assistant tool timeout turn=one n=1 tool=${tool} limit=${limit}ms`)
      const read = events.filter((e) => e.kind === 'call')[1]
      if (read?.kind !== 'call') throw new Error('No call')
      connection.receive({ kind: 'result', turnId: 'one', callId: read.callId, ok: true, text: 'file' })
      await vi.advanceTimersByTimeAsync(0)
      expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'one', ok: true } })
    } finally {
      await connection.close()
      vi.useRealTimers()
    }
  })

  it('gives each slow tool a limit far below the 15 minutes, past the deadline the editor keeps itself', () => {
    expect(toolTimeout('read_file')).toBe(60_000)
    expect(toolTimeout('view')).toBe(120_000)
    expect(toolTimeout('write_file')).toBe(15 * 60_000)
    expect(toolTimeout('build')).toBe((editorToolDeadlineMs('build', {}) ?? 0) + 30_000)
    expect(toolTimeout('build')).toBe(270_000)
    expect(toolTimeout('scene_request', { request: { type: 'batch' } })).toBe(270_000)
    // status: two reads of the game, then a margin
    expect(toolTimeout('playtest', { action: 'status' })).toBe(16_000 + 30_000 + 30_000)
    const steps = [{ action: 'start' }, { action: 'walk', entity: 'Crate' }, { action: 'input', keys: ['E'] }, { action: 'waitFor', path: 'score', changes: true, timeoutMs: 20_000 }]
    // 120 + 10 + 1.3 + 20 s of actions, a game read after each and one before, then the picture and the margins
    expect(toolTimeout('playtest', { action: 'steps', steps, view: true })).toBe(151_300 + 5 * 8_000 + 45_000 + 30_000 + 30_000)
    const longest = Array.from({ length: 20 }, () => ({ action: 'waitFor', hud: 'Score', timeoutMs: 60_000 }))
    const capped = toolTimeout('playtest', { action: 'steps', steps: longest, view: true })
    // the editor starts no step after 180 s, but the last one runs out its own 60 s
    expect(capped).toBe(180_000 + 60_000 + 8_000 + 8_000 + 45_000 + 30_000 + 30_000)
    expect(capped).toBeLessThan(15 * 60_000 / 2)
  })

  it('keeps the session after a turn limit so the next prompt continues it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dcl-agent-resume-'))
    const runtime = await ModelRuntime.create({ authPath: join(directory, '.auth.json'), modelsPath: null, refreshOnCreate: false })
    const faux = fauxProvider({ provider: 'anthropic', models: [{ id: 'test' }] })
    runtime.registerNativeProvider(faux.provider)
    const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() }
    const resources: ResourceLoader = {
      getExtensions: () => extensions, getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => '', getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {}
    }
    const sessions: Array<Awaited<ReturnType<typeof createAgentSession>>['session']> = []
    const factory: AgentFactory = {
      providers: async () => [],
      create: vi.fn(async (_params, call) => {
        const model = runtime.getModel('anthropic', 'test')
        if (model === undefined) throw new Error('No faux model')
        const { session } = await createAgentSession({
          modelRuntime: runtime, model, resourceLoader: resources, sessionManager: SessionManager.inMemory(),
          settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }), tools: ['build'],
          customTools: [{
            name: 'build', label: 'build', description: 'Build', parameters: Type.Object({}),
            execute: async (_id, _args, signal) => ({ content: [{ type: 'text', text: await call('build', {}, signal) }], details: {} })
          }]
        })
        sessions.push(session)
        return { prompt: async (next: AiSendParams) => { await session.prompt(next.text) }, abort: () => session.abort(), dispose: () => session.dispose(), snapshot: () => [], takeUsage: () => ({ cost: 0 }) }
      })
    }
    const events: AssistantServerMessage[] = []
    const connection = createConnection({ factory, logger: { error: vi.fn(), info: vi.fn() }, send: (e) => events.push(e), allowTurn: () => true, turnTimeoutMs: 50 })
    faux.setResponses([fauxAssistantMessage(fauxToolCall('build', {}), { stopReason: 'toolUse' })])
    connection.receive({ kind: 'prompt', turnId: 'one', projectId: 'scene', params: { ...params, text: 'Build a door' } })
    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'one', ok: false } }))
    expect(events).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ kind: 'error', resumable: true }) }))

    faux.setResponses([fauxAssistantMessage('Continued the door')])
    connection.receive({ kind: 'prompt', turnId: 'two', projectId: 'scene', params: { ...params, text: 'Continue' } })
    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'two', ok: true } }))
    expect(factory.create).toHaveBeenCalledOnce()
    const asked = sessions[0].messages.filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content))
    expect(asked).toEqual([expect.stringContaining('Build a door'), expect.stringContaining('Continue')])
    await connection.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('validates messages before spending a model call', () => {
    expect(parsePrompt(params)).toEqual(params)
    expect(parsePrompt({ ...params, text: ' ' })).toBeNull()
    expect(parsePrompt({ ...params, provider: 'arbitrary-provider' })).toBeNull()
    expect(parsePrompt({ ...params, images: [{ name: 'large', dataUrl: 'a'.repeat(2_800_001) }] })).toBeNull()
  })

  it('restores what the model remembered after a restart, only with the browser key, and forgets it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-memory-'))
    const wallet = '0x' + 'a'.repeat(40)
    const ref = { id: 'b'.repeat(32), key: Buffer.alloc(32, 7).toString('base64url') }
    const restored: unknown[] = []
    const factory: AgentFactory = {
      providers: async () => [],
      create: async (_params, _call, _emit, restore) => {
        restored.push(restore)
        const said: unknown[] = [...(restore ?? [])]
        return { prompt: async (next: AiSendParams) => { said.push(next.text) }, abort: async () => {}, dispose: () => {}, snapshot: () => said, takeUsage: () => ({ cost: 0 }) }
      }
    }
    // each connection on a fresh store over the same folder: a service that restarted in between
    async function turn(memoryKey: string, text: string) {
      const events: AssistantServerMessage[] = []
      const connection = createConnection({ factory, logger: { error: vi.fn(), info: vi.fn() }, send: (e) => events.push(e), allowTurn: () => true, memory: createAssistantMemory(dir).forWallet(wallet) })
      connection.receive({ kind: 'prompt', turnId: text.replace(/\W/g, '-'), projectId: 'scene', params: { ...params, text }, memory: { id: ref.id, key: memoryKey } })
      await vi.waitFor(() => expect(events.some((e) => e.kind === 'event' && e.event.kind === 'done')).toBe(true))
      await connection.close()
      return connection
    }
    try {
      await turn(ref.key, 'Make a door')
      await turn(ref.key, 'Make it red')
      expect(restored[1]).toEqual(['Make a door'])
      await turn(Buffer.alloc(32, 9).toString('base64url'), 'Someone else')
      expect(restored[2]).toBeUndefined()
      await turn(ref.key, 'Make it big')
      expect(restored[3]).toEqual(['Make a door', 'Make it red'])
      const [stored] = await readdir(join(dir, wallet))
      expect((await readFile(join(dir, wallet, stored))).includes('Make a door')).toBe(false)

      const connection = createConnection({ factory, logger: { error: vi.fn(), info: vi.fn() }, send: () => {}, allowTurn: () => true, memory: createAssistantMemory(dir).forWallet(wallet) })
      connection.receive({ kind: 'forget', id: ref.id })
      await connection.close()
      expect(await readdir(join(dir, wallet))).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('authenticates a changed key on the same connection and resumes saving with the right key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-memory-key-change-'))
    const wallet = '0x' + 'a'.repeat(40)
    const ref = { id: 'b'.repeat(32), key: Buffer.alloc(32, 7).toString('base64url') }
    const memory = createAssistantMemory(dir)
    const events: AssistantServerMessage[] = []
    const restored: unknown[] = []
    const factory: AgentFactory = {
      providers: async () => [],
      create: async (_params, _call, _emit, restore) => {
        restored.push(restore)
        const said: unknown[] = [...(restore ?? [])]
        return { prompt: async (next) => { said.push(next.text) }, abort: async () => {}, dispose: () => {}, snapshot: () => [...said], takeUsage: () => ({ cost: 0 }) }
      }
    }
    const connection = createConnection({ factory, logger: { error: vi.fn(), info: vi.fn() }, send: (e) => events.push(e), allowTurn: () => true, memory: memory.forWallet(wallet) })
    async function turn(turnId: string, key: string) {
      connection.receive({ kind: 'prompt', turnId, projectId: 'scene', params: { ...params, text: turnId }, memory: { ...ref, key } })
      await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId, ok: true } }))
    }
    try {
      await turn('original', ref.key)
      await turn('wrong-key', Buffer.alloc(32, 9).toString('base64url'))
      await turn('continued', ref.key)
      await connection.close()

      expect(restored).toEqual([undefined, undefined, ['original']])
      expect(await memory.forWallet(wallet).load(ref)).toEqual(['original', 'continued'])
    } finally { await connection.close(); await rm(dir, { recursive: true, force: true }) }
  })

  it('logs memory failures without secrets and keeps later saves and deletions working', async () => {
    const events: AssistantServerMessage[] = []
    const logger = { error: vi.fn(), info: vi.fn() }
    const ref = { id: 'b'.repeat(32), key: Buffer.alloc(32, 7).toString('base64url') }
    const failure = new Error(`Private conversation and key: ${ref.key}`)
    const memory = {
      load: vi.fn(async () => null),
      save: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined),
      forget: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined)
    }
    const connection = createConnection({
      logger, memory, send: (e) => events.push(e), allowTurn: () => true,
      factory: {
        providers: async () => [],
        create: async () => ({ prompt: async () => {}, abort: async () => {}, dispose: () => {}, snapshot: () => [], takeUsage: () => ({ cost: 0 }) })
      }
    })
    try {
      for (const turnId of ['one', 'two']) {
        connection.receive({ kind: 'prompt', turnId, projectId: 'scene', params, memory: ref })
        await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId, ok: true } }))
      }
      connection.receive({ kind: 'forget', id: ref.id })
      connection.receive({ kind: 'forget', id: ref.id })
      await connection.close()

      expect(memory.save).toHaveBeenCalledTimes(2)
      expect(memory.forget).toHaveBeenCalledTimes(2)
      expect(logger.error.mock.calls).toEqual([['Assistant memory save failed'], ['Assistant memory deletion failed']])
      expect(events.some((e) => e.kind === 'failure' || (e.kind === 'event' && e.event.kind === 'error'))).toBe(false)
    } finally { await connection.close() }
  })

  it('keeps internal usage across restarts and refuses turns once the allowance is spent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-usage-'))
    const wallet = '0x' + 'a'.repeat(40)
    const factory: AgentFactory = {
      providers: async () => [],
      create: async () => ({
        prompt: async () => {}, abort: async () => {}, dispose: () => {}, snapshot: () => [],
        takeUsage: () => ({ cost: 6 })
      })
    }
    async function turn(turnId: string) {
      const events: AssistantServerMessage[] = []
      const connection = createConnection({
        factory, logger: { error: vi.fn(), info: vi.fn() }, send: (e) => events.push(e), allowTurn: () => true,
        usage: createUsageMeter(dir, { daily: 10, weekly: 100 }).forWallet(wallet)
      })
      connection.receive({ kind: 'prompt', turnId, projectId: 'scene', params })
      await vi.waitFor(() => expect(events.some((e) => e.kind === 'failure' || (e.kind === 'event' && e.event.kind === 'done'))).toBe(true))
      await connection.close()
      return events
    }
    try {
      const first = await turn('one')
      const balance = () => createUsageMeter(dir, { daily: 10, weekly: 100 }).forWallet(wallet).balance()
      expect(await balance()).toMatchObject({ dailyPercent: 60, weeklyPercent: 6 })
      expect(JSON.stringify(first)).not.toContain('usage')
      const second = await turn('two')
      expect(await balance()).toMatchObject({ dailyPercent: 100, weeklyPercent: 12 })
      expect(JSON.stringify(second)).not.toContain('usage')
      const third = await turn('three')
      expect(third).toEqual([{ kind: 'failure', message: expect.stringContaining('allowance') }])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('records each turn with its steps, usage and transcript, and tells the browser the cost only while recording', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'assistant-session-log-'))
    const wallet = '0x' + 'b'.repeat(40)
    const memoryId = 'd'.repeat(32)
    const factory: AgentFactory = {
      providers: async () => [],
      create: async (_params, call, _emit, _restore, _images, onCompaction) => ({
        // a model reads a failed tool's text and carries on, as pi does
        prompt: async () => {
          await call('build', { label: 'Building' }).catch((error: unknown) => String(error))
          onCompaction?.({ ms: 40, ok: true, tokensBefore: 121_000, tokensAfter: 64_000, summaryChars: 900 })
        },
        abort: async () => {}, dispose: () => {},
        snapshot: () => [{ type: 'session' }, { type: 'message', text: 'built' }],
        takeUsage: () => ({ cost: 0.25, tokens: { input: 1, output: 200, cacheRead: 3000, cacheWrite: 40 }, calls: 2 })
      })
    }
    const log = createSessionLog(dir)
    const events: AssistantServerMessage[] = []
    const connection = createConnection({
      factory, logger: { error: vi.fn(), info: vi.fn() }, send: (e) => events.push(e), allowTurn: () => true, sessions: log.forWallet(wallet)
    })
    try {
      connection.receive({ kind: 'prompt', turnId: 'one', projectId: 'kitchen', params, memory: { id: memoryId, key: Buffer.alloc(32, 2).toString('base64url') } })
      await vi.waitFor(() => expect(events.some((e) => e.kind === 'call')).toBe(true))
      const call = events.find((e) => e.kind === 'call')
      if (call?.kind !== 'call') throw new Error('No call')
      connection.receive({ kind: 'result', turnId: 'one', callId: call.callId, ok: false, text: 'Build failed' })
      await vi.waitFor(() => expect(events.some((e) => e.kind === 'event' && e.event.kind === 'done')).toBe(true))
      expect(events.at(-1)).toEqual({
        kind: 'event', event: { kind: 'done', turnId: 'one', ok: true, usage: { input: 1, output: 200, cacheRead: 3000, cacheWrite: 40, cost: 0.25, calls: 2 } }
      })
      await vi.waitFor(async () => expect(await log.turns(wallet, memoryId)).toHaveLength(1))
      const [turn] = await log.turns(wallet, memoryId) ?? []
      expect(turn).toMatchObject({
        turnId: 'one', projectId: 'kitchen', conversation: memoryId, outcome: 'completed', prompt: 'Edit the door', model: 'test',
        toolCalls: 1, failedToolCalls: 1, builds: 1, failedBuilds: 1, usage: { cost: 0.25, calls: 2 },
        steps: [
          { n: 1, tool: 'build', ok: false, chars: 'Build failed'.length },
          { n: 2, tool: 'compaction', toolMs: 40, ok: true, chars: 900, tokensBefore: 121_000, tokensAfter: 64_000 }
        ]
      })
      expect(await log.transcript(wallet, memoryId)).toContain('"text":"built"')
    } finally {
      await connection.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps a stopped turn in the conversation and tells the model it was stopped', async () => {
    const events: AssistantServerMessage[] = []
    const asked: string[] = []
    const save = vi.fn(async () => 'saved' as const)
    const memory = { load: vi.fn(async () => null), save, forget: vi.fn(async () => {}) }
    const ref = { id: 'b'.repeat(32), key: Buffer.alloc(32, 7).toString('base64url') }
    const factory: AgentFactory = {
      providers: async () => [],
      create: vi.fn(async (_params, call) => ({
        prompt: async (next: AiSendParams) => {
          asked.push(next.text)
          if (asked.length === 1) await call('scene_request', { request: { type: 'batch' } }).catch(() => {})
        },
        abort: async () => {}, dispose: vi.fn(), snapshot: () => [{ type: 'message', text: 'placed the stove' }], takeUsage: () => ({ cost: 0 })
      }))
    }
    const connection = createConnection({ factory, logger: { error: vi.fn(), info: vi.fn() }, send: (e) => events.push(e), allowTurn: () => true, memory })
    connection.receive({ kind: 'prompt', turnId: 'one', projectId: 'scene', params, memory: ref })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'call')).toBe(true))
    connection.receive({ kind: 'stop', turnId: 'one' })
    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'one', ok: false } }))
    expect(save).toHaveBeenCalledWith(ref, [{ type: 'message', text: 'placed the stove' }])

    connection.receive({ kind: 'prompt', turnId: 'two', projectId: 'scene', params: { ...params, text: 'Now the sink' }, memory: ref })
    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'two', ok: true } }))
    expect(factory.create).toHaveBeenCalledOnce()
    expect(asked[1]).toMatch(/^\[The creator stopped your previous reply.*\]\n\nNow the sink$/)

    connection.receive({ kind: 'prompt', turnId: 'three', projectId: 'scene', params: { ...params, text: 'And a fridge' }, memory: ref })
    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'three', ok: true } }))
    expect(asked[2]).toBe('And a fridge')
    await connection.close()
  })

  it('drops the agent and its memory when the chat is reset while a turn runs', async () => {
    const events: AssistantServerMessage[] = []
    const save = vi.fn(async () => 'saved' as const)
    const memory = { load: vi.fn(async () => null), save, forget: vi.fn(async () => {}) }
    const ref = { id: 'b'.repeat(32), key: Buffer.alloc(32, 7).toString('base64url') }
    const dispose = vi.fn()
    const factory: AgentFactory = {
      providers: async () => [],
      create: vi.fn(async (_params, call) => ({
        prompt: async () => { await call('build', {}) }, abort: async () => {}, dispose, snapshot: () => [], takeUsage: () => ({ cost: 0 })
      }))
    }
    const connection = createConnection({ factory, logger: { error: vi.fn(), info: vi.fn() }, send: (e) => events.push(e), allowTurn: () => true, memory })
    connection.receive({ kind: 'prompt', turnId: 'one', projectId: 'scene', params, memory: ref })
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'call')).toBe(true))
    connection.receive({ kind: 'reset' })
    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'one', ok: false } }))
    expect(dispose).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
    await connection.close()
  })

  it('tells the creator and the log when a conversation is too long to keep', async () => {
    const events: AssistantServerMessage[] = []
    const logger = { error: vi.fn(), info: vi.fn() }
    const memory = { load: vi.fn(async () => null), save: vi.fn(async () => 'too_large' as const), forget: vi.fn(async () => {}) }
    const connection = createConnection({
      logger, memory, send: (e) => events.push(e), allowTurn: () => true,
      factory: {
        providers: async () => [],
        create: async () => ({ prompt: async () => {}, abort: async () => {}, dispose: () => {}, snapshot: () => [], takeUsage: () => ({ cost: 0 }) })
      }
    })
    connection.receive({ kind: 'prompt', turnId: 'one', projectId: 'scene', params, memory: { id: 'b'.repeat(32), key: Buffer.alloc(32, 7).toString('base64url') } })
    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'event', event: { kind: 'done', turnId: 'one', ok: true } }))
    const notes = events.filter((e) => e.kind === 'event' && e.event.kind === 'text')
    expect(notes).toEqual([{ kind: 'event', event: { kind: 'text', turnId: 'one', text: expect.stringContaining('too long to keep') } }])
    expect(events.indexOf(notes[0])).toBeLessThan(events.length - 1)
    expect(logger.info).toHaveBeenCalledWith('assistant memory turn=one kept=too_large')
    await connection.close()
  })
})
