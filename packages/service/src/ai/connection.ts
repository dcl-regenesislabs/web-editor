import type { ILoggerComponent } from '@well-known-components/interfaces'
import { ASSISTANT_ID, ASSISTANT_MAX_IMAGE_BYTES, isCatalogSearch, object } from '../../../contract/src/assistant.ts'
import type { AssistantServerMessage, BrowserToolName } from '../../../contract/src/assistant.ts'
import type { AiSendParams } from '../../../contract/src/shell.ts'
import { MEMORY_ID, MEMORY_KEY } from './memory.ts'
import type { MemoryRef, WalletMemory } from './memory.ts'
import type { WalletUsage } from './usage.ts'
import type { AssistantTurnOutcome } from '../../../contract/src/analytics.ts'
import type { SessionOperations } from './operations.ts'
import type { AgentFactory, AssistantAgent } from './types.ts'
import type { WalletImages } from './thumbnail.ts'

const MAX_TURN_RESULT_CHARS = 2_000_000
const MAX_LABEL_CHARS = 80
const TOOL_LABELS: Record<BrowserToolName, string> = {
  playtest: 'Testing the game', ui_layout: 'Measuring the UI', mobile_check: 'Checking it on a phone',
  build: 'Building the scene', scene_request: 'Editing the scene', write_file: 'Saving a file', asset_request: 'Working with assets',
  read_file: 'Reading a file', list_files: 'Listing files', view: 'Looking at the scene',
  search_files: 'Searching the code', edit_file: 'Editing a file'
}

interface Pending {
  turnId: string
  tool: BrowserToolName
  finish(ok: boolean, text: string): void
}

/** Why a turn was stopped before it finished on its own. */
type StopCause = Exclude<AssistantTurnOutcome, 'completed'>

interface ActiveTurn {
  id: string
  controller: AbortController
  chars: number
  resumable: boolean
  steps: number
  lastStepAt: number
  cause?: StopCause
  tools: { toolCalls: number; failedToolCalls: number; builds: number; failedBuilds: number }
}

export function parsePrompt(value: unknown): AiSendParams | null {
  if (!object(value) || !['claude', 'codex'].includes(String(value.provider))) return null
  if (typeof value.text !== 'string' || !value.text.trim()) return null
  if (value.context !== undefined && typeof value.context !== 'string') return null
  if (value.model !== undefined && (typeof value.model !== 'string' || value.model.length > 120)) return null
  if (value.images !== undefined && (!Array.isArray(value.images) || value.images.length > 4 || value.images.some((image) =>
    !object(image) || typeof image.name !== 'string' || image.name.length > 200 ||
    typeof image.dataUrl !== 'string' || image.dataUrl.length > Math.ceil(ASSISTANT_MAX_IMAGE_BYTES / 3) * 4 + 64 ||
    !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl)
  ))) return null
  return value as unknown as AiSendParams
}

// null: none sent; undefined: one that isn't valid
function parseMemory(value: unknown): MemoryRef | null | undefined {
  if (value === undefined) return null
  if (!object(value) || typeof value.id !== 'string' || !MEMORY_ID.test(value.id) ||
    typeof value.key !== 'string' || !MEMORY_KEY.test(value.key)) return undefined
  return { id: value.id, key: value.key }
}

export function createConnection(options: {
  factory: AgentFactory
  logger: Pick<ILoggerComponent.ILogger, 'error' | 'info'>
  send(message: AssistantServerMessage): void
  /** true, or why the turn is refused */
  allowTurn(): true | string
  usage?: WalletUsage
  memory?: WalletMemory
  images?: WalletImages
  toolTimeoutMs?: number
  turnTimeoutMs?: number
  operations?: SessionOperations
}) {
  let agent: AssistantAgent | null = null
  let identity = ''
  let active: ActiveTurn | null = null
  let closed = false
  let running: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let saving: Promise<void> = Promise.resolve()
  let browserCalls: Promise<void> = Promise.resolve()
  const pending = new Map<string, Pending>()
  const send = (message: AssistantServerMessage) => { if (!closed) options.send(message) }

  function abort(message?: string, resumable = false, cause: StopCause = 'cancelled'): void {
    if (active !== null && !active.controller.signal.aborted) {
      active.cause ??= cause
      if (message !== undefined) {
        active.resumable = resumable
        send({ kind: 'event', event: { kind: 'error', turnId: active.id, message, ...(resumable ? { resumable } : {}) } })
      }
    }
    active?.controller.abort()
    for (const request of pending.values()) request.finish(false, 'The turn was cancelled.')
    stopping = agent?.abort().catch(() => send({ kind: 'failure', message: 'Unable to stop the assistant.' }))
  }

  function call(tool: BrowserToolName, { label: said, ...args }: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const turn = active
    const label = typeof said === 'string' && said.trim() !== '' ? said.trim().slice(0, MAX_LABEL_CHARS) : undefined
    const parallel = isCatalogSearch(tool, args)
    // The browser serializes edits; queued calls must not spend their timeout waiting for earlier ones.
    const result = (parallel ? Promise.resolve() : browserCalls).then(() => {
      if (turn === null || active !== turn || turn.controller.signal.aborted || signal?.aborted) throw new Error('Turn cancelled')
      const live = turn
      const controller = turn.controller
      const callId = crypto.randomUUID()
      // the model's thinking is the gap since the last step ended, the tool's work is the rest
      const asked = Date.now()
      const thinking = pending.size === 0 ? asked - live.lastStepAt : 0
      const step = ++live.steps
      return new Promise<string>((resolve, reject) => {
        const cancel = () => finish(false, 'The turn was cancelled.')
        const timer = setTimeout(() => {
          tally(live, tool, false)
          finish(false, 'The browser did not answer the tool request.')
          abort(`${label ?? TOOL_LABELS[tool]} timed out. The turn stopped; check the scene before retrying.`, false, 'timed_out')
        }, options.toolTimeoutMs ?? (tool === 'read_file' || tool === 'list_files' || tool === 'search_files' ? 60_000 : 15 * 60_000))
        function finish(ok: boolean, text: string) {
          if (!pending.delete(callId)) return
          clearTimeout(timer)
          options.logger.info(`assistant step turn=${live.id} n=${step} tool=${tool} think=${thinking}ms tool_ms=${Date.now() - asked} ok=${ok} chars=${text.length}`)
          live.lastStepAt = Date.now()
          signal?.removeEventListener('abort', cancel)
          controller.signal.removeEventListener('abort', cancel)
          if (ok) resolve(text)
          else reject(new Error(text))
        }
        pending.set(callId, { turnId: turn.id, tool, finish })
        signal?.addEventListener('abort', cancel, { once: true })
        turn.controller.signal.addEventListener('abort', cancel, { once: true })
        send({ kind: 'call', turnId: turn.id, callId, tool, args, ...(label === undefined ? {} : { label }) })
      })
    })
    if (!parallel) browserCalls = result.then(() => {}, () => {})
    return result
  }

  function tally(turn: ActiveTurn, tool: BrowserToolName, ok: boolean): void {
    turn.tools.toolCalls++
    if (!ok) turn.tools.failedToolCalls++
    if (tool === 'build') {
      turn.tools.builds++
      if (!ok) turn.tools.failedBuilds++
    }
  }

  async function prompt(turnId: string, projectId: string, params: AiSendParams, ref: MemoryRef | null): Promise<void> {
    const startedAt = Date.now()
    const turn: ActiveTurn = {
      id: turnId, controller: new AbortController(), chars: 0, resumable: false, steps: 0, lastStepAt: startedAt,
      tools: { toolCalls: 0, failedToolCalls: 0, builds: 0, failedBuilds: 0 }
    }
    active = turn
    let started = false
    let turnAgent: AssistantAgent | null = null
    let ok = false
    let tracked: string | undefined
    const timer = setTimeout(() => abort('The turn reached its 60-minute limit.', true, 'timed_out'), options.turnTimeoutMs ?? 60 * 60_000)
    try {
      if (options.usage !== undefined && await options.usage.exhausted()) {
        options.operations?.rejected('allowance')
        const balance = await options.usage.balance()
        const resetAt = balance.weeklyPercent >= 100 ? balance.weeklyResetAt : balance.dailyResetAt
        send({ kind: 'failure', message: `This account has used its assistant allowance for now. Try again after ${resetAt}.` })
        return
      }
      turn.controller.signal.throwIfAborted()
      started = true
      tracked = options.operations?.turnStarted()
      send({ kind: 'event', event: { kind: 'started', turnId } })
      const key = JSON.stringify([projectId, params.provider, params.model, ref?.id, ref?.key])
      if (identity !== key) {
        agent?.dispose()
        agent = null
        identity = key
      }
      if (agent === null) {
        await saving
        const restore = ref === null ? null : await options.memory?.load(ref) ?? null
        const created = await options.factory.create(params, call, ({ text }) => {
          if (active !== null && !active.controller.signal.aborted) send({ kind: 'event', event: { kind: 'text', turnId: active.id, text } })
        }, restore ?? undefined, options.images)
        if (closed || turn.controller.signal.aborted) {
          created.dispose()
          return
        }
        agent = created
      }
      turnAgent = agent
      if (tracked !== undefined) options.operations?.turnModel(tracked, agent.model ?? params.model)
      await stopping
      turn.controller.signal.throwIfAborted()
      await agent.prompt(params)
      ok = !turn.controller.signal.aborted
    } catch {
      if (!turn.controller.signal.aborted) {
        if (started) send({ kind: 'event', event: { kind: 'error', turnId, message: 'The assistant could not finish. Check the service connection and provider sign-in, then retry.' } })
        else {
          options.operations?.rejected('unavailable')
          send({ kind: 'failure', message: 'The assistant allowance could not be checked. Try again shortly.' })
        }
      }
    } finally {
      clearTimeout(timer)
      const cause = turn.cause ?? (closed ? 'disconnected' : undefined)
      turn.controller.abort()
      if (ok && turnAgent !== null && ref !== null && options.memory !== undefined) {
        const memory = options.memory
        const snapshot = turnAgent.snapshot()
        saving = saving.then(() => memory.save(ref, snapshot)).catch(() => { options.logger.error('Assistant memory save failed') })
      }
      // a stopped or failed turn still paid for the calls it made
      const spent = turnAgent?.takeUsage()
      // a slow turn shows where it went: no prompt or scene content, only shape and timing
      options.logger.info(`assistant turn=${turnId} ms=${Date.now() - startedAt} ok=${ok} steps=${turn.steps}`)
      if (tracked !== undefined) {
        options.operations?.turnFinished(tracked, { outcome: ok ? 'completed' : cause ?? 'failed', ...turn.tools, usage: spent })
      }
      if (spent !== undefined && options.usage !== undefined) {
        await options.usage.record(spent.cost).catch(() => { options.logger.error('Assistant usage could not be recorded') })
      }
      if (!ok && (!turn.resumable || closed)) {
        agent?.dispose()
        agent = null
      }
      active = null
      if (started) send({ kind: 'event', event: { kind: 'done', turnId, ok } })
    }
  }

  return {
    isRunning: () => active !== null,
    receive(message: unknown): void {
      if (closed || !object(message)) return
      if (message.kind === 'result') {
        if (typeof message.callId !== 'string' || typeof message.turnId !== 'string' ||
          typeof message.ok !== 'boolean' || typeof message.text !== 'string' || message.text.length > 600_000) return
        const request = pending.get(message.callId)
        if (request?.turnId !== message.turnId || active?.id !== message.turnId) return
        active.chars += message.text.length
        tally(active, request.tool, active.chars <= MAX_TURN_RESULT_CHARS && message.ok)
        if (active.chars > MAX_TURN_RESULT_CHARS) {
          request.finish(false, 'The tool results for this turn are too large.')
          abort('The turn read as much as one turn can hold.', true, 'failed')
          return
        }
        request.finish(message.ok, message.text)
        return
      }
      if (message.kind === 'stop' && message.turnId === active?.id) { abort(); return }
      if (message.kind === 'reset') {
        if (active !== null) { abort(); return }
        agent?.dispose()
        agent = null
        identity = ''
        return
      }
      if (message.kind === 'forget') {
        if (typeof message.id !== 'string' || !MEMORY_ID.test(message.id)) return
        if (active !== null) abort()
        agent?.dispose()
        agent = null
        identity = ''
        const memory = options.memory
        if (memory !== undefined) saving = saving.then(() => memory.forget(message.id as string)).catch(() => { options.logger.error('Assistant memory deletion failed') })
        return
      }
      if (message.kind !== 'prompt') return
      const ref = parseMemory(message.memory)
      const params = parsePrompt(message.params)
      if (typeof message.turnId !== 'string' || !ASSISTANT_ID.test(message.turnId) ||
        typeof message.projectId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(message.projectId) || params === null ||
        ref === undefined) {
        options.operations?.rejected('invalid')
        send({ kind: 'failure', message: 'Invalid prompt. Use up to four images, at most 2 MB each.' })
        return
      }
      const allowed = active !== null ? 'A turn is already running.' : options.allowTurn()
      if (allowed !== true) {
        options.operations?.rejected(active !== null ? 'busy' : 'limited')
        send({ kind: 'failure', message: allowed })
        return
      }
      running = prompt(message.turnId, message.projectId, params, ref)
    },
    async close(): Promise<void> {
      closed = true
      abort(undefined, false, 'disconnected')
      await Promise.all([running, stopping])
      agent?.dispose()
      agent = null
      await saving
    }
  }
}
