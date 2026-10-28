import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent'
import type { FileEntry } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import type { Provider } from '@earendil-works/pi-ai'
import { afterEach, expect, it, vi } from 'vitest'
import { createPiFactory } from './pi.ts'
import type { AssistantAgent } from './types.ts'

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

it('charges compaction and replies once, including after restoring a conversation, and passes on Claude\'s plan headers', async () => {
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
  const headers: Array<Record<string, string>> = []
  const factory = await createPiFactory(await authPath(), 'test', 'sk-ant-oat-synthetic-test-token', undefined, undefined, (received) => headers.push(received))
  const params = { provider: 'claude' as const, model: 'test', text: 'Build a game' }
  let agent: AssistantAgent | undefined
  try {
    agent = await factory.create(params, async () => 'unused', () => {})
    let charged = 0
    let inputTokens = 0
    for (let turn = 0; turn < 10; turn++) {
      await agent.prompt({ ...params, text: `Request ${turn}: ${'x'.repeat(18_000)}` })
      const usage = agent.takeUsage()
      charged += usage.cost
      inputTokens += usage.tokens?.input ?? 0
      expect(usage).toMatchObject({ calls: 1, unreported: 0, responseModel: 'test' })
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
    expect(headers.length).toBeGreaterThanOrEqual(10)
    expect(headers[0]).toEqual({ 'anthropic-ratelimit-unified-5h-utilization': '0.03', 'x-other': 'kept' })
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
