import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiEvent, AiProviderInfo } from '@dcl-editor/contract'
import { AiPanel } from './AiPanel'
import { shadowedRuntimeProblem } from '../prefabs/generate'
import { mount, run } from '../test/render'

const { ensureScriptRuntime } = vi.hoisted(() => ({
  ensureScriptRuntime: vi.fn(async () => ({ vendored: [] as string[], shadowed: [] as string[] }))
}))

vi.mock('../prefabs/generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../prefabs/generate')>()
  return { ...actual, ensureScriptRuntime }
})

// Mutate the property, never the window itself — this suite renders into the DOM.
const shellHost = window as unknown as {
  editorShell?: {
    aiSend: () => Promise<void>
    aiReset: () => Promise<void>
    aiStop: () => Promise<void>
    aiProviders: () => Promise<AiProviderInfo[]>
    onAiEvent: (cb: (e: AiEvent) => void) => void
  }
}

let emit: (e: AiEvent) => void = () => {}

beforeEach(() => {
  ensureScriptRuntime.mockClear()
  ensureScriptRuntime.mockResolvedValue({ vendored: [], shadowed: [] })
  shellHost.editorShell = {
    aiSend: async () => {},
    aiReset: async () => {},
    aiStop: async () => {},
    aiProviders: async () => [],
    onAiEvent: (cb) => {
      emit = cb
    }
  }
})

afterEach(() => {
  delete shellHost.editorShell
})

async function turn(): Promise<ReturnType<typeof mount>> {
  const view = mount(<AiPanel shown fill={false} height={300} />)
  await view.settle()
  run(() => emit({ kind: 'started', turnId: 't1' }))
  run(() => emit({ kind: 'done', turnId: 't1', ok: true }))
  await view.settle()
  return view
}

// The assistant edits project files itself. When it changes a script that is
// already attached it writes no composite, so nothing else on this path vendors
// the runtime — and the import the system prompt tells it to write ('./runtime/…')
// would not resolve on the creator's next gesture, which is Play.
describe('AiPanel turn end', () => {
  it('vendors the script runtime when a turn ends', async () => {
    const view = await turn()
    expect(ensureScriptRuntime).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('leaves it alone when the turn failed', async () => {
    const view = mount(<AiPanel shown fill={false} height={300} />)
    await view.settle()
    run(() => emit({ kind: 'started', turnId: 't1' }))
    run(() => emit({ kind: 'done', turnId: 't1', ok: false }))
    await view.settle()
    expect(ensureScriptRuntime).not.toHaveBeenCalled()
    view.unmount()
  })

  it("tells the creator when their own file blocks a module, in the Script card's words", async () => {
    ensureScriptRuntime.mockResolvedValue({ vendored: [], shadowed: ['src/scripts/runtime/game.ts'] })
    const view = await turn()
    expect(view.text()).toContain(shadowedRuntimeProblem('src/scripts/runtime/game.ts'))
    view.unmount()
  })
})

describe('AiPanel new chat', () => {
  it.each([false, true])('clears the chat kept for this wallet and project (hosted: %s)', async (hosted) => {
    const save = vi.fn(async (_messages: unknown) => {})
    const stop = vi.fn(async () => {})
    const forget = vi.fn(async () => {})
    const transcript = { owner: 'p1@0xabc', load: async () => [{ role: 'user', text: 'Make a door' }], save }
    Object.assign(shellHost.editorShell ?? {}, { aiTranscript: () => transcript, aiStop: stop, aiForget: hosted ? forget : undefined })
    const view = mount(<AiPanel shown fill={false} height={300} />)
    await view.settle()
    expect(view.text()).toContain('Make a door')

    view.click(view.find('[aria-label="New chat"]'))
    view.click(view.byText('Yes'))
    await view.settle()

    expect(view.text()).not.toContain('Make a door')
    expect(save).toHaveBeenLastCalledWith([])
    expect(forget).toHaveBeenCalledTimes(hosted ? 1 : 0)
    expect(stop).toHaveBeenCalledTimes(hosted ? 0 : 1)
    view.unmount()
  })
})
