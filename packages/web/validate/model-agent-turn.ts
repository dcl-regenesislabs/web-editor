import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { createPiFactory } from '../../service/src/ai/pi.ts'
import { createSkillsComponent } from '../../service/src/adapters/skills.ts'
import { ASSISTANT_EFFORT, ASSISTANT_MODEL } from '../../contract/src/assistant.ts'
import type { BrowserToolName } from '../../contract/src/assistant.ts'
import { orderedBrowserTools } from './model-agent-tools.ts'

const [configPath] = process.argv.slice(2)
const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
  auth: string; cdp: string; url: string; out: string; prompt: string; variant: string; source?: string; timeoutMs: number
}
const browser = await chromium.connectOverCDP(config.cdp)
const page = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url() === config.url)
if (page === undefined) throw new Error('Open the benchmark scene before running the assistant.')
const library = await createSkillsComponent()
const skills = config.variant === 'baseline' ? {
  ...library,
  catalog: library.catalog.split('\n').filter((line) => !line.includes('model-building/')).join('\n'),
  read: (name: string, offset?: number, query?: string) => {
    if (name.startsWith('model-building/')) throw new Error('Unknown SDK skill document')
    return library.read(name, offset, query)
  }
} : library
const factory = await createPiFactory(config.auth, ASSISTANT_MODEL, undefined, skills, { info: (message) => console.log(message) })
const providers = await factory.providers()
if (!providers.some((provider) => provider.id === 'claude' && provider.available)) throw new Error('Sign in to the editor service before running the model benchmark.')
const tools: Array<{ name: string; args: unknown; startedMs: number; durationMs?: number; error?: string; result?: unknown }> = []
const placements: Array<{ source: 'generated' | 'catalog'; model: string; id: string; elapsedMs: number }> = []
let answer = ''
const started = performance.now()
let firstModelMs: number | undefined
const context = await page.evaluate(async () => {
  const probe = (window as unknown as { __modelProbe: { context(): Promise<string> } }).__modelProbe
  return probe.context()
})
const params = { provider: 'claude' as const, model: ASSISTANT_MODEL, text: config.prompt, context }
const runBrowser = async (name: BrowserToolName, args: Record<string, unknown>): Promise<string> => {
  const call: typeof tools[number] = { name, args, startedMs: performance.now() - started }
  tools.push(call)
  console.log(`tool ${name} ${typeof args.label === 'string' ? args.label : ''}`)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      page.evaluate(async ({ name, args }) => {
        const probe = (window as unknown as { __modelProbe: { run(name: string, args: Record<string, unknown>): Promise<string> } }).__modelProbe
        return probe.run(name, args)
      }, { name, args }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('The benchmark turn deadline expired during a browser tool.')), Math.max(1, config.timeoutMs - call.startedMs))
      })
    ])
    call.durationMs = performance.now() - started - call.startedMs
    call.result = JSON.parse(result)
    const recordModels = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      const record = value as Record<string, unknown>
      if (typeof record.model === 'string' && typeof record.id === 'string') {
        const elapsedMs = performance.now() - started
        firstModelMs ??= elapsedMs
        placements.push({ source: typeof record.script === 'string' ? 'generated' : 'catalog', model: record.model, id: record.id, elapsedMs })
      }
      if (Array.isArray(record.results)) {
        for (const item of record.results) {
          if (item !== null && typeof item === 'object') recordModels((item as Record<string, unknown>).result)
        }
      }
    }
    if (name === 'scene_request') recordModels(call.result)
    return result
  } catch (error) {
    call.durationMs = performance.now() - started - call.startedMs
    call.error = error instanceof Error ? error.message : String(error)
    console.log(`tool failed ${name}: ${call.error.slice(0, 400)}`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
// Match the service connection: searches may overlap, but project edits run in order.
const agent = await factory.create(params, orderedBrowserTools(runBrowser), (event) => { answer += event.text })
const timer = setTimeout(() => { void agent.abort() }, config.timeoutMs)
let failure: string | undefined
try {
  await agent.prompt(params)
  if (firstModelMs === undefined) failure = 'The assistant finished without placing a model.'
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
} finally {
  clearTimeout(timer)
  await fs.mkdir(config.out, { recursive: true })
  const totalMs = performance.now() - started
  let imageIndex = 0
  const stripImages = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(stripImages))
    if (value === null || typeof value !== 'object') return value
    const record = value as Record<string, unknown>
    if (record.mimeType === 'image/jpeg' && typeof record.image === 'string') {
      const file = `view-${++imageIndex}.jpg`
      await fs.writeFile(path.join(config.out, file), Buffer.from(record.image, 'base64'))
      return { ...record, image: file }
    }
    return Object.fromEntries(await Promise.all(Object.entries(record).map(async ([key, item]) => [key, await stripImages(item)])))
  }
  const report = { variant: config.variant, source: config.source ?? 'code', model: agent.model, effort: ASSISTANT_EFFORT,
    toolOrdering: 'serial-except-catalog-search', prompt: config.prompt, totalMs, firstModelMs, placements, failure,
    usage: agent.takeUsage(), answer, tools: await stripImages(tools) }
  await fs.writeFile(path.join(config.out, 'turn.json'), JSON.stringify(report, null, 2))
  agent.dispose()
  await browser.close()
  console.log(JSON.stringify({ totalMs, firstModelMs, calls: tools.length, errors: tools.filter((call) => call.error).length, failure }))
}
if (failure !== undefined) process.exitCode = 1
