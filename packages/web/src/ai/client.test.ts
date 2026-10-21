import { afterEach, expect, it, vi } from 'vitest'
import type { AiEvent, AssistantClientMessage, AssistantMemoryRef, PhonePreviewState } from '@dcl-editor/contract'
import { ASSISTANT_PROTOCOL, ASSISTANT_TICKET_PREFIX } from '@dcl-editor/contract'
import { createBrowserAssistant } from './client'

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: AssistantClientMessage[] = []
  constructor(readonly url: URL, readonly protocols: string[]) {
    Socket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = Socket.OPEN
      this.onopen?.()
      this.receive({ kind: 'ready', providers: [] })
    })
  }
  send(raw: string) { this.sent.push(JSON.parse(raw) as AssistantClientMessage) }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
  close() { this.readyState = 3; this.onclose?.() }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

function setup(fetch = async () => new Response(JSON.stringify({ token: 'test-ticket' }))) {
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('location', new URL('http://editor.test'))
  let projectId = 'first'
  const scene = vi.fn(async (_request: unknown, _signal: AbortSignal): Promise<unknown> => ({ id: '512' }))
  const assets = vi.fn(async () => ({ results: [{ ref: 'builtin:game-flow' }] }))
  const mobilePreview = vi.fn((): PhonePreviewState => ({ mode: 'closed', ready: false, url: null }))
  const kept = new Map<string, AssistantMemoryRef>()
  const read = vi.fn(async (id: string, wallet: string) => kept.get(`${id}@${wallet}`) ?? null)
  const assistant = createBrowserAssistant({
    service: 'http://service.test', fetch, wallet: () => 'wallet', mobilePreview,
    memory: {
      read,
      write: async (id, wallet, ref) => { if (ref === null) kept.delete(`${id}@${wallet}`); else kept.set(`${id}@${wallet}`, ref) }
    },
    project: () => ({ id: projectId, tools: {
      files: () => new Map(), write: async () => {}, scene, assets, build: async () => ({ ok: true }), view: async () => ({})
    } })
  })
  const events: AiEvent[] = []
  assistant.shell.onAiEvent((event) => events.push(event))
  return { assistant, events, scene, assets, kept, read, mobilePreview, switchProject() { projectId = 'second' } }
}

afterEach(() => { Socket.instances = []; vi.unstubAllGlobals() })

it('sends fresh mobile availability on each turn without its launch URL', async () => {
  const { assistant, mobilePreview, events } = setup()
  const params = { provider: 'claude' as const, text: 'Fix the HUD', context: 'Selected: Score' }
  try {
    await assistant.shell.aiSend(params)
    const socket = Socket.instances[0]
    expect(socket.sent.find((message) => message.kind === 'prompt')?.params.context)
      .toBe('Selected: Score\n\n[Mobile preview] {"mode":"closed","ready":false}')
    await assistant.reset()
    mobilePreview.mockReturnValue({ mode: 'tab', ready: true, url: 'http://editor.test/godot/?previewSession=private-session' })
    const { turnId } = await assistant.shell.aiSend(params)
    const next = Socket.instances[1]
    expect(next.sent.find((message) => message.kind === 'prompt')?.params.context)
      .toBe('Selected: Score\n\n[Mobile preview] {"mode":"tab","ready":true}')
    next.receive({ kind: 'call', turnId, callId: 'mobile-shot', tool: 'view', args: { target: 'mobile' }, label: 'Checking mobile UI' })
    await vi.waitFor(() => expect(events).toContainEqual({
      kind: 'tool', turnId, tool: 'View', detail: 'Mobile preview', label: 'Checking mobile UI'
    }))
  } finally { assistant.dispose() }
})

it('dispatches asset tools through the signed assistant connection', async () => {
  const { assistant, assets } = setup()
  try {
    const { turnId } = await assistant.shell.aiSend({ provider: 'claude', text: 'Find a round controller' })
    const ws = Socket.instances[0]
    ws.receive({ kind: 'call', turnId, callId: 'assets-1', tool: 'asset_request', args: { action: 'search_prefabs', query: 'round' } })
    await vi.waitFor(() => expect(ws.sent).toContainEqual(expect.objectContaining({ kind: 'result', callId: 'assets-1', ok: true })))
    expect(assets).toHaveBeenCalledWith({ action: 'search_prefabs', query: 'round' }, expect.any(AbortSignal))
  } finally { assistant.dispose() }
})

it('runs each tool call once and refuses requests after the browser project changes', async () => {
  const { assistant, scene, switchProject } = setup()
  try {
    const { turnId } = await assistant.shell.aiSend({ provider: 'claude', text: 'Make a door' })
    const ws = Socket.instances[0]
    expect(ws.protocols).toEqual([ASSISTANT_PROTOCOL, ASSISTANT_TICKET_PREFIX + 'test-ticket'])
    expect(ws.url.search).toBe('')
    const call = { kind: 'call', turnId, callId: 'call-1', tool: 'scene_request', args: { request: { type: 'createEntity', name: 'Door' } } }
    ws.receive({ ...call, turnId: 'another-turn' })
    ws.receive(call)
    ws.receive(call)
    await vi.waitFor(() => expect(ws.sent.some((message) => message.kind === 'result' && message.ok)).toBe(true))
    expect(scene).toHaveBeenCalledTimes(1)
    switchProject()
    ws.receive({ ...call, callId: 'call-2' })
    await vi.waitFor(() => expect(ws.sent).toContainEqual(expect.objectContaining({ kind: 'result', callId: 'call-2', ok: false })))
    expect(scene).toHaveBeenCalledTimes(1)
  } finally { assistant.dispose() }
})

it('cancels queued tools, drains an in-flight action, and ignores messages from the old connection', async () => {
  const { assistant, scene, events } = setup()
  const action = deferred<void>()
  scene.mockImplementation(async () => { await action.promise; return { id: '512' } })
  try {
    const { turnId } = await assistant.shell.aiSend({ provider: 'claude', text: 'Make a door' })
    const old = Socket.instances[0]
    const call = { kind: 'call', turnId, callId: 'call-1', tool: 'scene_request', args: { request: { type: 'createEntity', name: 'Door' } } }
    old.receive(call)
    old.receive({ ...call, callId: 'call-2' })
    await vi.waitFor(() => expect(scene).toHaveBeenCalledTimes(1))
    let drained = false
    const reset = assistant.reset().then(() => { drained = true })
    expect(scene.mock.calls[0][1].aborted).toBe(true)
    await Promise.resolve()
    expect(drained).toBe(false)
    action.resolve()
    await reset
    expect(scene).toHaveBeenCalledTimes(1)
    expect(old.sent.some((message) => message.kind === 'result')).toBe(false)
    const next = await assistant.shell.aiSend({ provider: 'claude', text: 'Try again' })
    old.receive({ kind: 'failure', message: 'Old connection failure' })
    expect(events.some((event) => event.kind === 'done' && event.turnId === next.turnId)).toBe(false)
  } finally { action.resolve(); assistant.dispose() }
})

it('does not open a socket when a pending signed connection request is cancelled', async () => {
  const ticket = deferred<Response>()
  const { assistant, events } = setup(() => ticket.promise)
  const sending = assistant.shell.aiSend({ provider: 'claude', text: 'Make a door' })
  await assistant.reset()
  ticket.resolve(new Response(JSON.stringify({ token: 'late-ticket' })))
  const { turnId } = await sending
  expect(Socket.instances).toHaveLength(0)
  expect(events).toContainEqual({ kind: 'done', turnId, ok: false })
  assistant.dispose()
})

it('sends the same kept chat after a reconnect, and a new chat forgets it and its key', async () => {
  const { assistant, kept } = setup()
  const memoryOf = (socket: Socket) => socket.sent.find((message) => message.kind === 'prompt')?.memory
  try {
    const { turnId } = await assistant.shell.aiSend({ provider: 'claude', text: 'Make a door' })
    await vi.waitFor(() => expect(memoryOf(Socket.instances[0])).toBeDefined())
    const first = memoryOf(Socket.instances[0])!
    expect(first.id).toMatch(/^[a-f0-9]{32}$/)
    expect(first.key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    Socket.instances[0].receive({ kind: 'event', event: { kind: 'done', turnId, ok: true } })
    await assistant.reset()

    await assistant.shell.aiSend({ provider: 'claude', text: 'Make it red' })
    await vi.waitFor(() => expect(memoryOf(Socket.instances[1])).toEqual(first))

    await assistant.shell.aiForget()
    expect(Socket.instances[1].sent).toContainEqual({ kind: 'forget', id: first.id })
    expect(kept.size).toBe(0)
  } finally { assistant.dispose() }
})

it('cancels a turn immediately while New chat reads the key, then forgets before disconnecting', async () => {
  const { assistant, events, scene, read } = setup()
  const { turnId } = await assistant.shell.aiSend({ provider: 'claude', text: 'Make a door' })
  const socket = Socket.instances[0]
  const ref = socket.sent.find((message) => message.kind === 'prompt')?.memory ?? null
  const reading = deferred<AssistantMemoryRef | null>()
  read.mockReturnValueOnce(reading.promise)
  const forgetting = assistant.shell.aiForget()
  try {
    expect(events).toContainEqual({ kind: 'done', turnId, ok: false })
    expect(socket.readyState).toBe(Socket.OPEN)
    socket.receive({ kind: 'call', turnId, callId: 'late-call', tool: 'scene_request', args: { request: { type: 'createEntity', name: 'Door' } } })
    reading.resolve(ref)
    await forgetting

    expect(scene).not.toHaveBeenCalled()
    expect(socket.sent.slice(1)).toEqual([{ kind: 'stop', turnId }, { kind: 'forget', id: ref?.id }, { kind: 'reset' }])
    expect(socket.readyState).toBe(3)
  } finally { reading.resolve(ref); await forgetting; assistant.dispose() }
})

it('searches during scene edits, orders imports, and discards a cancelled search result', async () => {
  const { assistant, scene } = setup()
  const edit = deferred<void>()
  const catalog = deferred<{ models: [] }>()
  scene.mockImplementationOnce(async () => { await edit.promise; return { id: '512' } })
  scene.mockImplementationOnce(() => catalog.promise)
  try {
    const { turnId } = await assistant.shell.aiSend({ provider: 'claude', text: 'Build a tower' })
    const ws = Socket.instances[0]
    ws.receive({ kind: 'call', turnId, callId: 'edit', tool: 'scene_request', args: { request: { type: 'batch', requests: [] } } })
    ws.receive({ kind: 'call', turnId, callId: 'search', tool: 'scene_request', args: { request: { type: 'findModels', query: 'obstacle' } } })
    ws.receive({ kind: 'call', turnId, callId: 'import', tool: 'scene_request', args: { request: { type: 'placeModel', id: 'spinner', into: 'Spinner' } } })
    await vi.waitFor(() => expect(scene).toHaveBeenCalledTimes(2))
    expect(ws.sent.filter(m => m.kind === 'result')).toHaveLength(0)
    edit.resolve()
    await vi.waitFor(() => expect(ws.sent).toContainEqual(expect.objectContaining({ kind: 'result', callId: 'import', ok: true })))
    expect(scene).toHaveBeenCalledTimes(3)
    await assistant.reset()
    const next = await assistant.shell.aiSend({ provider: 'claude', text: 'Another scene' })
    catalog.resolve({ models: [] })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ws.sent).not.toContainEqual(expect.objectContaining({ kind: 'result', callId: 'search' }))
    expect(Socket.instances[1].sent).toContainEqual(expect.objectContaining({ kind: 'prompt', turnId: next.turnId }))
  } finally { edit.resolve(); catalog.resolve({ models: [] }); assistant.dispose() }
})
