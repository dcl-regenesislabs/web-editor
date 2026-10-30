import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent'
import type { FileEntry } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import type { FauxResponseFactory, Provider } from '@earendil-works/pi-ai'
import { afterEach, expect, it, vi } from 'vitest'
import { createAccountPool } from './accounts.ts'
import { createPiFactory } from './pi.ts'
import { ProviderLimited } from './types.ts'
import type { AssistantAgent, CompactionStep } from './types.ts'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function authPath() {
  const directory = await mkdtemp(join(tmpdir(), 'dcl-agent-security-'))
  directories.push(directory)
  return join(directory, '.auth.json')
}

it('creates a browser-only agent with synthetic OAuth credentials without calling a model', async () => {
  const file = await authPath()
  const factory = await createPiFactory(file, undefined, 'sk-ant-oat-synthetic-test-token')
  const providers = await factory.providers()
  const claude = providers.find((provider) => provider.id === 'claude')
  expect(claude?.available).toBe(true)
  expect(providers.find((provider) => provider.id === 'codex')?.available).toBe(false)
  const agent = await factory.create({ provider: 'claude', text: 'Not sent' }, async () => 'unused', () => {})
  await agent.abort()
  agent.dispose()
  const pinned = await createPiFactory(file, claude?.defaultModel)
  const models = await pinned.providers()
  expect(models.find((provider) => provider.id === 'claude')?.models).toEqual([claude?.defaultModel])
  expect(models.find((provider) => provider.id === 'codex')?.models).toEqual([])
})

it('fails closed when the configured model is unknown', async () => {
  await expect(createPiFactory(await authPath(), 'model-that-does-not-exist')).rejects.toThrow('AI_MODEL')
})

it('charges compaction and replies once, including after restoring a conversation, and credits Claude\'s plan headers to the account', async () => {
  const faux = fauxProvider({ provider: 'anthropic', models: [{ id: 'test', contextWindow: 40_000, maxTokens: 1024 }] })
  const originalCreate = ModelRuntime.create.bind(ModelRuntime)
  vi.spyOn(ModelRuntime, 'create').mockImplementation(async (options) => {
    const runtime = await originalCreate(options)
    const auth = runtime.getProvider('anthropic')?.auth
    if (auth === undefined) throw new Error('Missing synthetic OAuth provider')
    const streamSimple: Provider['streamSimple'] = (model, context, opts) => {
      const stream = createAssistantMessageEventStream()
      void (async () => {
        await opts?.onResponse?.({ status: 200, headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.03', 'x-other': 'kept' } }, model)
        for await (const event of faux.provider.streamSimple(model, context, opts)) {
          if (event.type === 'done') event.message.usage.cost = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 }
          stream.push(event)
        }
      })()
      return stream
    }
    runtime.registerNativeProvider({ ...faux.provider, auth, streamSimple })
    return runtime
  })
  const originalSettings = SettingsManager.inMemory.bind(SettingsManager)
  vi.spyOn(SettingsManager, 'inMemory').mockImplementation((settings) => originalSettings({
    ...settings, compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1000 }
  }))
  faux.setResponses(Array.from({ length: 50 }, () => fauxAssistantMessage('Done.')))
  const file = await authPath()
  const accounts = await createAccountPool({ primaryPath: file, dir: join(dirname(file), 'claude-accounts') })
  const factory = await createPiFactory(file, 'test', 'sk-ant-oat-synthetic-test-token', undefined, undefined, accounts)
  const params = { provider: 'claude' as const, model: 'test', text: 'Build a game' }
  let agent: AssistantAgent | undefined
  try {
    agent = await factory.create(params, async () => 'unused', () => {})
    let charged = 0
    let inputTokens = 0
    const compactions = () => (agent?.snapshot() as FileEntry[]).filter((entry) => entry.type === 'compaction').length
    for (let turn = 0; turn < 10; turn++) {
      const before = compactions()
      await agent.prompt({ ...params, text: `Request ${turn}: ${'x'.repeat(18_000)}` })
      const usage = agent.takeUsage()
      charged += usage.cost
      inputTokens += usage.tokens?.input ?? 0
      // the reply, and the summary call of each compaction
      expect(usage).toMatchObject({ calls: 1 + compactions() - before, unreported: 0, responseModel: 'test' })
      expect(agent.takeUsage()).toMatchObject({ cost: 0, calls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
    }
    const entries = agent.snapshot() as FileEntry[]
    expect(entries.some((entry) => entry.type === 'compaction')).toBe(true)
    const actual = entries.reduce((total, entry) => {
      if (entry.type === 'message' && entry.message.role === 'assistant') return total + entry.message.usage.cost.total
      if (entry.type === 'compaction') return total + (entry.usage?.cost.total ?? 0)
      return total
    }, 0)
    expect(charged).toBe(actual)
    expect(accounts.quota().windows).toEqual([{ name: 'five_hour', percent: 3, resetsAt: null }])
    const actualInput = entries.reduce((total, entry) => {
      if (entry.type === 'message' && entry.message.role === 'assistant') return total + entry.message.usage.input
      if (entry.type === 'compaction') return total + (entry.usage?.input ?? 0)
      return total
    }, 0)
    expect(inputTokens).toBeGreaterThan(0)
    expect(inputTokens).toBe(actualInput)
    agent.dispose()
    agent = await factory.create(params, async () => 'unused', () => {}, entries)
    expect(agent.takeUsage()).toMatchObject({ cost: 0, calls: 0, tokens: { input: 0, output: 0 } })
    await agent.prompt(params)
    expect(agent.takeUsage().cost).toBe(1)
  } finally { agent?.dispose() }
})

it('summarizes the start of a long turn between its tool calls, keeping the request, the files written and recent results', async () => {
  const faux = fauxProvider({ provider: 'anthropic', models: [{ id: 'test', contextWindow: 200_000, maxTokens: 8192 }] })
  const originalCreate = ModelRuntime.create.bind(ModelRuntime)
  vi.spyOn(ModelRuntime, 'create').mockImplementation(async (options) => {
    const runtime = await originalCreate(options)
    const auth = runtime.getProvider('anthropic')?.auth
    if (auth === undefined) throw new Error('Missing synthetic OAuth provider')
    runtime.registerNativeProvider({ ...faux.provider, auth })
    return runtime
  })
  const script = [
    fauxAssistantMessage(fauxToolCall('write_file', { path: 'src/game.ts', content: 'export {}', revision: null }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('read_file', { path: 'src/index.ts' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('build', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('read_file', { path: 'src/hud.ts' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('playtest', { action: 'status' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done.')
  ]
  const summaries: string[] = []
  const text = (message: Parameters<FauxResponseFactory>[0]['messages'][number] | undefined) => message === undefined ? ''
    : typeof message.content === 'string' ? message.content
      : message.content.map((block) => block.type === 'text' ? block.text : '').join('')
  faux.setResponses(Array.from({ length: 20 }, () => (context: Parameters<FauxResponseFactory>[0]) => {
    const [system, request] = context.messages
    if (system?.role !== 'system' || !text(system).startsWith('You are a context summarization assistant')) {
      return script.shift() ?? fauxAssistantMessage('Out of script.')
    }
    summaries.push(text(request))
    return fauxAssistantMessage('## Goal\nA game in src/game.ts')
  }))
  // each result is about 10k tokens, so the context passes 30k after the third tool
  const call = async (tool: string) => tool === 'build' ? `Build failed: Cannot find name 'Door'. ${'b'.repeat(40_000)}` : 'r'.repeat(40_000)
  const steps: CompactionStep[] = []
  const factory = await createPiFactory(await authPath(), 'test', 'sk-ant-oat-synthetic-test-token', undefined, undefined, undefined, 30_000)
  const params = { provider: 'claude' as const, model: 'test', text: 'Build an Overcooked-like kitchen game' }
  const agent = await factory.create(params, call, () => {}, undefined, undefined, (step) => steps.push(step))
  try {
    await agent.prompt(params)
    const entries = agent.snapshot() as FileEntry[]
    const compactions = entries.filter((entry) => entry.type === 'compaction')
    expect(compactions.length).toBeGreaterThan(0)
    // within the one prompt: a single request, and the reply after the summary
    expect(entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user')).toHaveLength(1)
    const last = entries.map((entry) => entry.type === 'message' && entry.message.role === 'assistant').lastIndexOf(true)
    expect(entries.findIndex((entry) => entry.type === 'compaction')).toBeLessThan(last)
    // one structured summary per compaction, with the start of the turn folded in and the editor's focus
    expect(summaries).toHaveLength(compactions.length)
    expect(summaries[0]).toContain('[User]: \n\nBuild an Overcooked-like kitchen game')
    expect(summaries[0]).toContain('## Constraints & Preferences')
    expect(summaries[0]).toContain('Additional focus: This is a Decentraland SDK7 scene')
    const [first] = compactions
    if (first.type !== 'compaction') throw new Error('No compaction')
    expect(first.summary).toContain('<modified-files>\nsrc/game.ts\n</modified-files>')
    // a later summary still lists it
    const latest = compactions.at(-1)
    expect(latest?.type === 'compaction' ? latest.summary : '').toContain('<modified-files>\nsrc/game.ts\n</modified-files>')
    expect(steps).toHaveLength(compactions.length)
    expect(steps[0]).toMatchObject({ ok: true, summaryChars: first.summary.length })
    expect(steps[0].tokensBefore).toBeGreaterThan(30_000)
    expect(steps[0].tokensAfter).toBeLessThan(steps[0].tokensBefore ?? 0)
    expect(agent.takeUsage()).toMatchObject({ calls: 6 + compactions.length, unreported: 0 })
  } finally { agent.dispose() }
})

it('moves a turn to the next Claude account when one reaches its limit, and says so when all have', async () => {
  const faux = fauxProvider({ provider: 'anthropic', models: [{ id: 'test', contextWindow: 40_000, maxTokens: 1024 }] })
  const limited = new Set<string>()
  const served: string[] = []
  const originalCreate = ModelRuntime.create.bind(ModelRuntime)
  vi.spyOn(ModelRuntime, 'create').mockImplementation(async (options) => {
    const runtime = await originalCreate(options)
    const auth = runtime.getProvider('anthropic')?.auth
    if (auth === undefined) throw new Error('Missing synthetic OAuth provider')
    const streamSimple: Provider['streamSimple'] = (model, context, opts) => {
      const stream = createAssistantMessageEventStream()
      const token = String(opts?.apiKey)
      void (async () => {
        if (limited.has(token)) {
          const reset = String(Math.floor(Date.now() / 1000) + 3600)
          await opts?.onResponse?.({ status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': reset } }, model)
          stream.push({ type: 'error', reason: 'error', error: fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429 rate_limit_error' }) })
          return
        }
        served.push(token)
        await opts?.onResponse?.({ status: 200, headers: {} }, model)
        for await (const event of faux.provider.streamSimple(model, context, opts)) stream.push(event)
      })()
      return stream
    }
    runtime.registerNativeProvider({ ...faux.provider, auth, streamSimple })
    return runtime
  })
  faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage('Done.')))
  const file = await authPath()
  const accounts = await createAccountPool({ primaryPath: file, dir: join(dirname(file), 'claude-accounts') })
  const factory = await createPiFactory(file, 'test', 'sk-ant-oat-first', undefined, undefined, accounts)
  await accounts.add('Second', 'sk-ant-oat-second')
  const params = { provider: 'claude' as const, model: 'test', text: 'Build a game' }
  const agent = await factory.create(params, async () => 'unused', () => {})
  try {
    await agent.prompt(params)
    limited.add('sk-ant-oat-first')
    await agent.prompt(params)
    expect(served).toEqual(['sk-ant-oat-first', 'sk-ant-oat-second'])
    expect((await accounts.list()).map((account) => account.state)).toEqual(['limited', 'active'])

    limited.add('sk-ant-oat-second')
    const failure = await agent.prompt(params).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProviderLimited)
    expect(Date.parse((failure as ProviderLimited).until ?? '')).toBeGreaterThan(Date.now())
  } finally { agent.dispose() }
}, 30_000)

it('asks once for mobile_check when a turn changed screen UI without one, and not when it ran', async () => {
  const faux = fauxProvider({ provider: 'anthropic', models: [{ id: 'test', contextWindow: 40_000, maxTokens: 1024 }] })
  const originalCreate = ModelRuntime.create.bind(ModelRuntime)
  vi.spyOn(ModelRuntime, 'create').mockImplementation(async (options) => {
    const runtime = await originalCreate(options)
    const auth = runtime.getProvider('anthropic')?.auth
    if (auth === undefined) throw new Error('Missing synthetic OAuth provider')
    runtime.registerNativeProvider({ ...faux.provider, auth })
    return runtime
  })
  const hud = { path: 'src/scripts/hud.tsx', content: 'addHudItem("left", () => null)', revision: null }
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('write_file', hud), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done.'),
    fauxAssistantMessage(fauxToolCall('mobile_check', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Checked on a phone.'),
    fauxAssistantMessage(fauxToolCall('write_file', hud), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('mobile_check', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done and checked.')
  ])
  const calls: string[] = []
  const call = async (tool: string) => {
    calls.push(tool)
    return tool === 'mobile_check' ? JSON.stringify({ passed: true, issues: [], states: [] }) : '{}'
  }
  const factory = await createPiFactory(await authPath(), 'test', 'sk-ant-oat-synthetic-test-token')
  const params = { provider: 'claude' as const, model: 'test', text: 'Add a HUD' }
  const agent = await factory.create(params, call, () => {})
  try {
    await agent.prompt(params)
    expect(calls).toEqual(['write_file', 'mobile_check'])
    await agent.prompt(params)
    expect(calls).toEqual(['write_file', 'mobile_check', 'write_file', 'mobile_check'])
    expect(faux.state.callCount).toBe(7)
  } finally { agent.dispose() }
})
