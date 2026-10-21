import { ASSISTANT_ID, ASSISTANT_PROTOCOL, ASSISTANT_TICKET_PREFIX, isCatalogSearch, object } from '@dcl-editor/contract'
import type { AiEvent, AiProviderInfo, AiSendParams, AssistantClientMessage, AssistantMemoryRef, BrowserToolCall, EditorShell, PhonePreviewState } from '@dcl-editor/contract'
import type { HostFetchInit } from '@ui/engine/hosted'
import { createBrowserTools } from './tools'
import type { BrowserProject } from './tools'

type AssistantShell = Required<Pick<EditorShell, 'aiProviders' | 'aiSend' | 'aiStop' | 'aiReset' | 'aiForget' | 'aiCanResume' | 'onAiEvent'>>

export function createBrowserAssistant(options: {
  service: string | null
  fetch(url: string, init?: HostFetchInit): Promise<Response>
  wallet(): string | null
  mobilePreview?(): Pick<PhonePreviewState, 'mode' | 'ready'>
  project(): { id: string; tools: BrowserProject }
  // this browser's key to what the service remembers of a project's chat
  memory: {
    read(projectId: string, wallet: string): Promise<AssistantMemoryRef | null>
    write(projectId: string, wallet: string, ref: AssistantMemoryRef | null): Promise<void>
  }
}) {
  const listeners = new Set<(event: AiEvent) => void>()
  let socket: WebSocket | null = null
  let connecting: Promise<WebSocket> | null = null
  let connectionGeneration = 0
  let active: { id: string; projectId: string; wallet: string; controller: AbortController; calls: Set<string>; execute: ReturnType<typeof createBrowserTools> } | null = null
  let toolQueue: Promise<void> = Promise.resolve()
  // the connection whose service still holds a conversation a limit paused
  let paused: WebSocket | null = null
  const emit = (event: AiEvent) => { for (const listener of listeners) listener(event) }
  const unavailable = (reason: string): AiProviderInfo[] => [{
    id: 'claude', label: 'Claude', available: false, models: [], defaultModel: '', transport: 'service', reason
  }]
  const send = (message: AssistantClientMessage) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }
  function finish(ok: boolean, message?: string): void {
    const turn = active
    if (turn === null) return
    active = null
    turn.controller.abort()
    if (message !== undefined) emit({ kind: 'error', turnId: turn.id, message })
    emit({ kind: 'done', turnId: turn.id, ok })
  }

  // null when the row needs the result; write_file too, since the panel refreshes the file rail on its row
  function rowFor(call: BrowserToolCall): { tool: string; detail: string } | null {
    const request = object(call.args.request) ? call.args.request : {}
    switch (call.tool) {
      case 'write_file': return null
      case 'read_file': return { tool: 'Read', detail: typeof call.args.path === 'string' ? call.args.path : '' }
      case 'asset_request': return { tool: 'Assets', detail: String(call.args.action ?? '') }
      case 'build': return { tool: 'Build', detail: 'Scene' }
      case 'view': return { tool: 'View', detail: call.args.target === 'mobile' ? 'Mobile preview' : call.args.target === 'editor' ? 'Editor' : 'Current view' }
      case 'playtest': return { tool: 'Playtest', detail: String(call.args.action ?? '') }
      case 'scene_request':
        if (request.type === 'batch' && Array.isArray(request.requests)) return { tool: 'Scene', detail: `${request.requests.length} changes` }
        if (request.type === 'sceneSettings') return { tool: 'Scene', detail: 'Settings' }
        if (request.type === 'saveThumbnail') return { tool: 'Thumbnail', detail: 'New version' }
        if (request.type === 'readThumbnail') return { tool: 'Thumbnail', detail: 'Current' }
        if (request.type === 'useThumbnail') return { tool: 'Thumbnail', detail: `Version ${String(request.version)}` }
        if (request.type === 'attachScript') return null
    }
    return { tool: 'Inspect', detail: 'Project' }
  }

  function reportTool(turnId: string, call: BrowserToolCall, text: string, shown: boolean): void {
    const label = call.label === undefined ? {} : { label: call.label }
    const row = rowFor(call)
    if (row !== null) {
      if (!shown) emit({ kind: 'tool', turnId, ...row, ...label })
      return
    }
    if (call.tool === 'write_file') {
      const path = typeof call.args.path === 'string' ? call.args.path : ''
      emit({ kind: 'tool', turnId, tool: call.args.revision === null ? 'Write' : 'Edit', detail: path, ...label })
      const result: unknown = JSON.parse(text)
      if (object(result) && object(result.attached) && typeof result.attached.name === 'string') {
        emit({ kind: 'tool', turnId, tool: 'Attached', detail: `${path.split('/').pop() ?? path} to ${result.attached.name}`, ...label })
      }
      return
    }
    const result: unknown = JSON.parse(text)
    if (object(result) && Array.isArray(result.attached)) {
      for (const script of result.attached) if (typeof script === 'string') emit({ kind: 'tool', turnId, tool: 'AttachScript', detail: script, ...label })
    }
  }

  async function runTool(call: BrowserToolCall): Promise<void> {
    const turn = active
    if (turn === null || turn.id !== call.turnId || turn.controller.signal.aborted) return
    let ok = false
    let text = ''
    let shown = false
    try {
      if (options.wallet() !== turn.wallet || options.project().id !== turn.projectId) throw new Error('The open project or account changed.')
      // a labelled step shows while it runs, not once it is over
      if (call.label !== undefined) {
        const row = rowFor(call)
        if (row !== null) {
          emit({ kind: 'tool', turnId: turn.id, ...row, label: call.label })
          shown = true
        }
      }
      text = await turn.execute(call, turn.controller.signal)
      if (text.length > 500_000) throw new Error('The tool result is too large. Ask for a smaller part of the project.')
      turn.controller.signal.throwIfAborted()
      ok = true
      reportTool(turn.id, call, text, shown)
    } catch (error) {
      // the engine console rejects with its own reply as a plain string
      text = error instanceof Error ? error.message : typeof error === 'string' && error !== '' ? error : 'The browser tool failed.'
    }
    if (active === turn && !turn.controller.signal.aborted) send({ kind: 'result', turnId: turn.id, callId: call.callId, ok, text })
  }

  function receive(raw: string): void {
    let message: unknown
    try { message = JSON.parse(raw) } catch { finish(false, 'Invalid assistant response.'); return }
    if (!object(message)) return
    if (message.kind === 'failure' && typeof message.message === 'string') { finish(false, message.message); return }
    if (message.kind === 'call' && typeof message.turnId === 'string' && typeof message.callId === 'string' &&
      ASSISTANT_ID.test(message.callId) && ['list_files', 'read_file', 'write_file', 'scene_request', 'asset_request', 'build', 'view', 'playtest'].includes(String(message.tool)) && object(message.args)) {
      const { label, ...rest } = message as unknown as Omit<BrowserToolCall, 'label'> & { label?: unknown }
      const call: BrowserToolCall = typeof label === 'string' ? { ...rest, label } : rest
      if (active === null || active.id !== call.turnId || active.calls.has(call.callId)) return
      active.calls.add(call.callId)
      const parallel = isCatalogSearch(call.tool, call.args)
      const result = (parallel ? Promise.resolve() : toolQueue)
        .then(() => runTool(call)).catch((error: unknown) => {
          console.error('[assistant] browser tool failed', call.tool, error)
          if (active?.id === call.turnId) finish(false, 'The browser tool failed.')
        })
      if (!parallel) toolQueue = result
      return
    }
    if (message.kind !== 'event' || !object(message.event)) return
    const event = message.event
    if (active === null || event.turnId !== active.id) return
    if (event.kind === 'text' && typeof event.text === 'string') emit({ kind: 'text', turnId: active.id, text: event.text })
    if (event.kind === 'error' && typeof event.message === 'string') {
      const resumable = event.resumable === true
      if (resumable) paused = socket
      emit({ kind: 'error', turnId: active.id, message: event.message, ...(resumable ? { resumable } : {}) })
    }
    if (event.kind === 'done' && typeof event.ok === 'boolean') finish(event.ok)
  }

  async function connect(): Promise<WebSocket> {
    if (socket?.readyState === WebSocket.OPEN) return socket
    if (connecting !== null) return connecting
    const generation = connectionGeneration
    const attempt = (async () => {
      if (options.service === null) throw new Error('The assistant service is not configured.')
      const response = await options.fetch(`${options.service}/assistant/connect`, { method: 'POST' })
      if (!response.ok) throw new Error('The assistant service is unavailable. Sign in and recheck.')
      const ticket: unknown = await response.json()
      if (!object(ticket) || typeof ticket.token !== 'string') throw new Error('Invalid assistant connection.')
      if (generation !== connectionGeneration) throw new Error('Connection cancelled.')
      const url = new URL(`${options.service}/assistant/socket`, location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(url, [ASSISTANT_PROTOCOL, ASSISTANT_TICKET_PREFIX + ticket.token])
      socket = ws
      return new Promise<WebSocket>((resolve, reject) => {
        let ready = false
        const timer = setTimeout(() => { ws.close(); reject(new Error('Assistant connection timed out.')) }, 10_000)
        ws.onmessage = ({ data }: MessageEvent<unknown>) => {
          if (socket !== ws) return
          if (typeof data !== 'string') return
          if (!ready) {
            let message: unknown
            try { message = JSON.parse(data) } catch { ws.close(); return }
            if (!object(message) || message.kind !== 'ready') return
            ready = true
            clearTimeout(timer)
            resolve(ws)
          } else receive(data)
        }
        ws.onerror = () => { ws.close(); reject(new Error('Could not connect to the assistant service.')) }
        ws.onclose = () => {
          clearTimeout(timer)
          if (socket === ws) {
            socket = null
            finish(false, 'Assistant connection closed. Your edits are saved; the next message starts a new conversation.')
          }
          reject(new Error('Assistant connection closed.'))
        }
      })
    })()
    connecting = attempt
    try { return await attempt } finally { if (connecting === attempt) connecting = null }
  }

  function currentProject(): string | null {
    try {
      return options.project().id
    } catch {
      return null
    }
  }

  async function rememberedChat(projectId: string, wallet: string): Promise<AssistantMemoryRef | undefined> {
    try {
      const kept = await options.memory.read(projectId, wallet)
      if (kept !== null) return kept
      const ref = { id: hex(crypto.getRandomValues(new Uint8Array(16))), key: base64url(crypto.getRandomValues(new Uint8Array(32))) }
      await options.memory.write(projectId, wallet, ref)
      return ref
    } catch {
      // without a place to keep the key the conversation is simply not kept
      return undefined
    }
  }

  function reset(): Promise<void> {
    connectionGeneration++
    send({ kind: 'reset' })
    finish(false)
    const old = socket
    socket = null
    connecting = null
    old?.close()
    return toolQueue
  }

  const shell: AssistantShell = {
    async aiProviders() {
      if (options.wallet() === null) return unavailable('Sign in to Decentraland to use the assistant.')
      if (options.service === null) return unavailable('The assistant service is not configured.')
      try {
        const response = await options.fetch(`${options.service}/assistant/providers`)
        if (!response.ok) return unavailable('The assistant service is unavailable. Recheck when it is running.')
        const value: unknown = await response.json()
        if (!Array.isArray(value)) return unavailable('The assistant service returned an invalid provider list.')
        return value.filter((p): p is AiProviderInfo => object(p) && (p.id === 'claude' || p.id === 'codex') &&
          typeof p.label === 'string' && typeof p.available === 'boolean' && typeof p.defaultModel === 'string' &&
          Array.isArray(p.models) && p.models.every((m) => typeof m === 'string')).map((p) => ({ ...p, transport: 'service' }))
      } catch { return unavailable('Could not reach the assistant service. Recheck your connection.') }
    },
    async aiSend(params: AiSendParams) {
      if (active !== null) throw new Error('A turn is already running.')
      const wallet = options.wallet()
      if (wallet === null) throw new Error('Sign in to use the assistant.')
      paused = null
      const project = options.project()
      const turn = { id: crypto.randomUUID(), wallet, projectId: project.id, controller: new AbortController(), calls: new Set<string>(), execute: createBrowserTools(project.tools) }
      active = turn
      emit({ kind: 'started', turnId: turn.id })
      try {
        await connect()
        turn.controller.signal.throwIfAborted()
        if (options.wallet() !== wallet || options.project().id !== project.id) throw new Error('The open project or account changed.')
        const memory = await rememberedChat(project.id, wallet)
        turn.controller.signal.throwIfAborted()
        const preview = options.mobilePreview?.()
        const context = preview === undefined ? params.context : [params.context,
          `[Mobile preview] ${JSON.stringify({ mode: preview.mode, ready: preview.ready })}`
        ].filter(Boolean).join('\n\n')
        send({ kind: 'prompt', turnId: turn.id, projectId: project.id, params: { ...params, context }, memory })
      } catch (error) {
        if (active === turn) finish(false, error instanceof Error ? error.message : 'Could not start the assistant.')
      }
      return { turnId: turn.id }
    },
    async aiStop() {
      if (active !== null) send({ kind: 'stop', turnId: active.id })
      await reset()
    },
    async aiReset() { await reset() },
    async aiForget() {
      const wallet = options.wallet()
      const projectId = active?.projectId ?? currentProject()
      if (active !== null) send({ kind: 'stop', turnId: active.id })
      finish(false)
      const ref = wallet === null || projectId === null ? null : await options.memory.read(projectId, wallet).catch(() => null)
      // the key goes too, so a copy the service couldn't delete now is unreadable
      if (ref !== null && wallet !== null && projectId !== null) {
        send({ kind: 'forget', id: ref.id })
        await options.memory.write(projectId, wallet, null).catch(() => {})
      }
      await reset()
    },
    aiCanResume: () => paused !== null && paused === socket && socket.readyState === WebSocket.OPEN,
    onAiEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
  return { shell, reset, dispose() { reset(); listeners.clear() } }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
