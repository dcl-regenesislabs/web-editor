import type { ILoggerComponent } from '@well-known-components/interfaces'
import { ASSISTANT_ID, ASSISTANT_MAX_IMAGE_BYTES, isCatalogSearch, object } from '../../../contract/src/assistant.ts'
import type { AssistantServerMessage, BrowserToolName } from '../../../contract/src/assistant.ts'
import type { AiSendParams } from '../../../contract/src/shell.ts'
import { editorToolDeadlineMs, editorToolTimeoutMessage } from '../../../contract/src/editor-tools.ts'
import { MEMORY_ID, MEMORY_KEY } from './memory.ts'
import type { MemoryRef, MemorySaveResult, WalletMemory } from './memory.ts'
import type { WalletUsage } from './usage.ts'
import type { AssistantTurnOutcome } from '../../../contract/src/analytics.ts'
import type { SessionOperations } from './operations.ts'
import type { StepRecord, WalletSessionLog } from './session-log.ts'
import { ProviderLimited } from './types.ts'
import type { AgentFactory, AssistantAgent, CompactionStep } from './types.ts'
import type { WalletImages } from './thumbnail.ts'

const MAX_TURN_RESULT_CHARS = 2_000_000
const MAX_LABEL_CHARS = 80
// the model sees the stopped turn's finished calls; this says why the rest never ran
const STOPPED_NOTE = '[The creator stopped your previous reply before it finished. What it already changed in the project stays.]'
const NOT_KEPT_NOTE: Partial<Record<MemorySaveResult, string>> = {
  too_large: 'This conversation is now too long to keep: the assistant remembers it while this page stays open, ' +
    'but not after a reload. Start a new chat to carry on with a fresh memory.',
  full: 'The assistant could not keep this conversation for later: its storage is full. ' +
    'It remembers it while this page stays open, but not after a reload.'
}
const TOOL_LABELS: Record<BrowserToolName, string> = {
  playtest: 'Testing the game', ui_layout: 'Measuring the UI', mobile_check: 'Checking it on a phone',
  build: 'Building the scene', scene_request: 'Editing the scene', write_file: 'Saving a file', asset_request: 'Working with assets',
  read_file: 'Reading a file', list_files: 'Listing files', view: 'Looking at the scene',
  search_files: 'Searching the code', edit_file: 'Editing a file'
}

// past the editor's own deadline for a call: the editor answers first, this covers one that never does
const DEADLINE_GRACE_MS = 30_000

// a picture is quick or stuck: the browser gives up on it sooner, this covers an editor that does not
export function toolTimeout(tool: BrowserToolName, args: Record<string, unknown> = {}): number {
  if (tool === 'read_file' || tool === 'list_files' || tool === 'search_files') return 60_000
  if (tool === 'view') return 2 * 60_000
  const deadline = editorToolDeadlineMs(tool, args)
  return deadline === undefined ? 15 * 60_000 : deadline + DEADLINE_GRACE_MS
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
  /** The creator reset or forgot the conversation while this turn ran: neither the agent nor its memory is kept. */
  discarded: boolean
  tools: { toolCalls: number; failedToolCalls: number; builds: number; failedBuilds: number }
  stepLog: StepRecord[]
}

const MAX_STEPS_LOGGED = 2000

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

// A build that did not compile is a tool call that worked: the browser answers it ok, with ok:false in its text.
function compileFailed(text: string): boolean {
  try {
    const result: unknown = JSON.parse(text)
    return object(result) && result.ok === false
  } catch {
    return false
  }
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
  sessions?: WalletSessionLog
}) {
  let agent: AssistantAgent | null = null
  let identity = ''
  // the memory id when the browser keeps one, so a session log matches the creator's chat
  let conversation = ''
  let active: ActiveTurn | null = null
  let closed = false
  let running: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let saving: Promise<void> = Promise.resolve()
  let browserCalls: Promise<void> = Promise.resolve()
  // the kept agent's last turn was stopped by the creator
  let stoppedBefore = false
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
        const limit = options.toolTimeoutMs ?? toolTimeout(tool, args)
        const timer = setTimeout(() => {
          tally(live, tool, false)
          // the socket answers pings (server.ts closes it otherwise): the page is there, its editor never answered
          options.logger.info(`assistant tool timeout turn=${live.id} n=${step} tool=${tool} limit=${limit}ms`)
          if (editorToolDeadlineMs(tool, args) !== undefined) {
            // the editor gives up on these itself; one that does not has not got that yet, or is stuck. The model can
            // retry once or carry on, so the turn goes on.
            finish(false, editorToolTimeoutMessage(tool, limit, 'the editor may have reloaded, or it is stuck on the scene'))
            return
          }
          finish(false, 'The browser did not answer the tool request.')
          // paused, not ended: the conversation keeps the failed call, so Continue picks up from it
          abort(`${label ?? TOOL_LABELS[tool]} timed out. Check the scene, then continue.`, true, 'timed_out')
        }, limit)
        function finish(ok: boolean, text: string) {
          if (!pending.delete(callId)) return
          clearTimeout(timer)
          const toolMs = Date.now() - asked
          options.logger.info(`assistant step turn=${live.id} n=${step} tool=${tool} think=${thinking}ms tool_ms=${toolMs} ok=${ok} chars=${text.length}`)
          if (live.stepLog.length < MAX_STEPS_LOGGED) live.stepLog.push({ n: step, tool, thinkMs: thinking, toolMs, ok, chars: text.length })
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

  // the summary runs between steps: its time is neither the model's thinking nor the next tool's
  function compacted(step: CompactionStep): void {
    const live = active
    if (live === null) return
    const n = ++live.steps
    const thinkMs = Math.max(0, Date.now() - step.ms - live.lastStepAt)
    options.logger.info(`assistant step turn=${live.id} n=${n} tool=compaction think=${thinkMs}ms tool_ms=${step.ms} ok=${step.ok} ` +
      `tokens_before=${step.tokensBefore ?? 0} tokens_after=${step.tokensAfter ?? 0}`)
    if (live.stepLog.length < MAX_STEPS_LOGGED) {
      live.stepLog.push({
        n, tool: 'compaction', thinkMs, toolMs: step.ms, ok: step.ok, chars: step.summaryChars,
        ...step.tokensBefore === undefined ? {} : { tokensBefore: step.tokensBefore },
        ...step.tokensAfter === undefined ? {} : { tokensAfter: step.tokensAfter }
      })
    }
    live.lastStepAt = Date.now()
  }

  function tally(turn: ActiveTurn, tool: BrowserToolName, ok: boolean, text = ''): void {
    turn.tools.toolCalls++
    if (!ok) turn.tools.failedToolCalls++
    if (tool === 'build') {
      turn.tools.builds++
      if (!ok || compileFailed(text)) turn.tools.failedBuilds++
    }
  }

  async function prompt(turnId: string, projectId: string, params: AiSendParams, ref: MemoryRef | null): Promise<void> {
    const startedAt = Date.now()
    const turn: ActiveTurn = {
      id: turnId, controller: new AbortController(), chars: 0, resumable: false, discarded: false, steps: 0, lastStepAt: startedAt,
      tools: { toolCalls: 0, failedToolCalls: 0, builds: 0, failedBuilds: 0 }, stepLog: []
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
        conversation = ref?.id ?? crypto.randomUUID().replaceAll('-', '')
      }
      // a restored conversation was saved with the stopped turn in it, but the note went with the old agent
      if (agent === null) stoppedBefore = false
      if (agent === null) {
        await saving
        const restore = ref === null ? null : await options.memory?.load(ref) ?? null
        const created = await options.factory.create(params, call, ({ text }) => {
          if (active !== null && !active.controller.signal.aborted) send({ kind: 'event', event: { kind: 'text', turnId: active.id, text } })
        }, restore ?? undefined, options.images, compacted)
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
      const note = stoppedBefore
      stoppedBefore = false
      await agent.prompt(note ? { ...params, text: `${STOPPED_NOTE}\n\n${params.text}` } : params)
      ok = !turn.controller.signal.aborted
    } catch (error) {
      if (!turn.controller.signal.aborted) {
        if (error instanceof ProviderLimited) {
          // keep the agent: the next prompt carries on from what this turn already did
          turn.resumable = true
          const after = error.until === null ? 'an operator adds a Claude account' : new Date(error.until).toUTCString()
          send({ kind: 'event', event: { kind: 'error', turnId, message: `The assistant's Claude accounts have all reached their usage limit. Try again after ${after}.`, resumable: true } })
        } else if (started) send({ kind: 'event', event: { kind: 'error', turnId, message: 'The assistant could not finish. Check the service connection and provider sign-in, then retry.' } })
        else {
          options.operations?.rejected('unavailable')
          send({ kind: 'failure', message: 'The assistant allowance could not be checked. Try again shortly.' })
        }
      }
    } finally {
      clearTimeout(timer)
      const cause = turn.cause ?? (closed ? 'disconnected' : undefined)
      turn.controller.abort()
      // A stopped, paused or cut-off turn stays in the conversation: its edits are in the scene, so the model has to
      // know about them, and the next message reads the same history from cache instead of rewriting it.
      const stopped = cause === 'cancelled' || cause === 'disconnected'
      const continues = !turn.discarded && (ok || turn.resumable || stopped)
      const keep = continues && ref !== null && options.memory !== undefined
      const snapshot = turnAgent !== null && (keep || (started && options.sessions !== undefined)) ? turnAgent.snapshot() : undefined
      let stored: Promise<MemorySaveResult | void> | undefined
      if (keep && snapshot !== undefined && options.memory !== undefined) {
        const memory = options.memory
        stored = saving.then(() => memory.save(ref, snapshot))
        saving = stored.then(() => {}, () => { options.logger.error('Assistant memory save failed') })
      }
      // a stopped or failed turn still paid for the calls it made
      const spent = turnAgent?.takeUsage()
      const outcome: AssistantTurnOutcome = ok ? 'completed' : cause ?? 'failed'
      if (started && options.sessions !== undefined) {
        const sessions = options.sessions
        const record = {
          turnId, projectId, conversation, startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString(),
          ms: Date.now() - startedAt, outcome, model: turnAgent?.model ?? params.model, prompt: params.text,
          steps: turn.stepLog, ...turn.tools, usage: spent
        }
        void sessions.record(record, snapshot).catch(() => { options.logger.error('Assistant session log write failed') })
      }
      // a slow turn shows where it went: no prompt or scene content, only shape and timing
      options.logger.info(`assistant turn=${turnId} ms=${Date.now() - startedAt} ok=${ok} steps=${turn.steps}`)
      if (tracked !== undefined) {
        options.operations?.turnFinished(tracked, { outcome, ...turn.tools, usage: spent })
      }
      if (spent !== undefined && options.usage !== undefined) {
        await options.usage.record(spent.cost).catch(() => { options.logger.error('Assistant usage could not be recorded') })
      }
      if (turn.discarded || (!ok && (!(turn.resumable || stopped) || closed))) {
        agent?.dispose()
        agent = null
      } else if (cause === 'cancelled') stoppedBefore = true
      const kept = stored === undefined ? undefined : await stored.catch(() => undefined)
      if (kept === 'trimmed' || kept === 'too_large' || kept === 'full') {
        options.logger.info(`assistant memory turn=${turnId} kept=${kept}`)
      }
      const notKept = kept === undefined ? undefined : NOT_KEPT_NOTE[kept]
      if (started && notKept !== undefined) send({ kind: 'event', event: { kind: 'text', turnId, text: `\n\n_${notKept}_` } })
      active = null
      // the browser sees what a turn cost only where sessions are recorded for study, never in production use
      const usage = options.sessions === undefined || spent?.tokens === undefined ? undefined
        : { ...spent.tokens, cost: spent.cost, calls: spent.calls ?? 0 }
      if (started) send({ kind: 'event', event: { kind: 'done', turnId, ok, ...(usage === undefined ? {} : { usage }) } })
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
        tally(active, request.tool, active.chars <= MAX_TURN_RESULT_CHARS && message.ok, message.text)
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
        if (active !== null) { active.discarded = true; abort(); return }
        agent?.dispose()
        agent = null
        identity = ''
        return
      }
      if (message.kind === 'forget') {
        if (typeof message.id !== 'string' || !MEMORY_ID.test(message.id)) return
        if (active !== null) { active.discarded = true; abort() }
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
