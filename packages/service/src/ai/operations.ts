import type { AssistantOperation, AssistantRejection, AssistantTurnOutcome } from '../../../contract/src/analytics.ts'
import type { TurnUsage } from './types.ts'

/** Where finished work is reported; the operations tracker never waits on it. */
export interface OperationsSink {
  track(operation: AssistantOperation, wallet?: string): void
}

export interface TurnResult {
  outcome: AssistantTurnOutcome
  toolCalls: number
  failedToolCalls: number
  builds: number
  failedBuilds: number
  usage?: TurnUsage
}

/** One assistant socket's view of the tracker. */
export interface SessionOperations {
  rejected(reason: AssistantRejection): void
  turnStarted(): string
  turnModel(turnId: string, model: string | undefined): void
  turnFinished(turnId: string, result: TurnResult): void
  closed(): void
}

export interface UsageTotals {
  prompts: number
  /** Turns that ended, so their tokens are in the totals; averages divide by this. */
  finishedTurns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** At public API rates; not the subscription's bill. */
  estimatedCostUsd: number
  /** Turns whose provider usage was missing, so the token totals are a floor. */
  incompleteTurns: number
}

export interface UserActivity extends UsageTotals {
  /** Shown to admins only; never exported. */
  wallet: string
  sessions: number
  running: number
  lastActiveAt: string
}

export interface OperationsSnapshot {
  startedAt: string
  sessions: number
  turns: Array<{ id: string; model: string | null; startedAt: string }>
  sinceStart: { turns: Record<AssistantTurnOutcome, number>; rejected: Record<AssistantRejection, number>; usage: UsageTotals }
  /** The most active wallets since the service started, by tokens. */
  users: UserActivity[]
}

export interface Operations {
  openSession(wallet: string): SessionOperations
  /** Thumbnails come from a separate image model and stay out of the turn's usage. */
  imageGenerated(wallet: string, ok: boolean): void
  snapshot(): OperationsSnapshot
}

interface LiveTurn {
  id: string
  model: string | null
  startedAt: number
}

const MAX_USERS_SHOWN = 50
// with ASSISTANT_WALLETS=* any wallet can appear; the least recently active are forgotten first
const MAX_USERS_KEPT = 5000
const emptyTotals = (): UsageTotals => ({
  prompts: 0, finishedTurns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, incompleteTurns: 0
})

const usageComplete = (usage: TurnUsage | undefined) => usage?.tokens !== undefined && usage.unreported === 0

function addUsage(totals: UsageTotals, usage: TurnUsage | undefined): void {
  const tokens = usage?.tokens
  totals.finishedTurns++
  totals.inputTokens += tokens?.input ?? 0
  totals.outputTokens += tokens?.output ?? 0
  totals.cacheReadTokens += tokens?.cacheRead ?? 0
  totals.cacheWriteTokens += tokens?.cacheWrite ?? 0
  totals.estimatedCostUsd += usage?.cost ?? 0
  if (!usageComplete(usage)) totals.incompleteTurns++
}

const SETTLED_ON_CLOSE: TurnResult = { outcome: 'disconnected', toolCalls: 0, failedToolCalls: 0, builds: 0, failedBuilds: 0 }

export function createOperations(sink?: OperationsSink, now = Date.now): Operations {
  const startedAt = now()
  const sessions = new Map<string, { wallet: string; turns: Map<string, LiveTurn> }>()
  const totals = emptyTotals()
  const users = new Map<string, UsageTotals & { lastActiveAt: number }>()
  const user = (wallet: string) => {
    let entry = users.get(wallet)
    if (entry === undefined) {
      if (users.size >= MAX_USERS_KEPT) {
        const idle = [...users].reduce((oldest, next) => next[1].lastActiveAt < oldest[1].lastActiveAt ? next : oldest)
        users.delete(idle[0])
      }
      entry = { ...emptyTotals(), lastActiveAt: now() }
      users.set(wallet, entry)
    }
    return entry
  }
  const outcomes: Record<AssistantTurnOutcome, number> = { completed: 0, failed: 0, cancelled: 0, disconnected: 0, timed_out: 0 }
  const rejections: Record<AssistantRejection, number> = { invalid: 0, busy: 0, limited: 0, allowance: 0, unavailable: 0 }

  function openSession(wallet: string): SessionOperations {
    const sessionId = crypto.randomUUID()
    const turns = new Map<string, LiveTurn>()
    sessions.set(sessionId, { wallet, turns })

    function turnFinished(turnId: string, result: TurnResult): void {
      const turn = turns.get(turnId)
      if (turn === undefined) return
      turns.delete(turnId)
      outcomes[result.outcome]++
      addUsage(totals, result.usage)
      const activity = user(wallet)
      addUsage(activity, result.usage)
      activity.lastActiveAt = now()
      const usage = result.usage
      const tokens = usage?.tokens
      sink?.track({
        action: 'turn_finished', turn_id: turn.id, session_id: sessionId,
        model: usage?.responseModel ?? turn.model,
        outcome: result.outcome, duration_ms: now() - turn.startedAt,
        tool_calls: result.toolCalls, failed_tool_calls: result.failedToolCalls,
        builds: result.builds, failed_builds: result.failedBuilds,
        model_calls: usage?.calls ?? 0,
        input_tokens: tokens?.input ?? 0, output_tokens: tokens?.output ?? 0,
        cache_read_tokens: tokens?.cacheRead ?? 0, cache_write_tokens: tokens?.cacheWrite ?? 0,
        usage_complete: usageComplete(usage),
        estimated_api_cost_usd: usage?.cost ?? 0
      }, wallet)
    }

    return {
      rejected(reason) {
        rejections[reason]++
        sink?.track({ action: 'turn_rejected', reason }, wallet)
      },
      turnStarted() {
        const turn = { id: crypto.randomUUID(), model: null, startedAt: now() }
        turns.set(turn.id, turn)
        totals.prompts++
        const activity = user(wallet)
        activity.prompts++
        activity.lastActiveAt = turn.startedAt
        sink?.track({ action: 'turn_started', turn_id: turn.id, session_id: sessionId }, wallet)
        return turn.id
      },
      turnModel(turnId, model) {
        const turn = turns.get(turnId)
        if (turn !== undefined && model !== undefined) turn.model = model
      },
      turnFinished,
      closed() {
        // a turn its connection never settled must not outlive the socket in live state
        for (const turnId of [...turns.keys()]) turnFinished(turnId, SETTLED_ON_CLOSE)
        sessions.delete(sessionId)
      }
    }
  }

  return {
    openSession,
    imageGenerated(wallet, ok) {
      sink?.track({ action: 'image_generated', ok }, wallet)
    },
    snapshot() {
      const open = [...sessions.values()]
      const live = open.flatMap((session) => [...session.turns.values()])
      const activity = [...users].map(([wallet, entry]) => {
        const mine = open.filter((session) => session.wallet === wallet)
        return {
          ...entry, wallet,
          sessions: mine.length,
          running: mine.reduce((sum, session) => sum + session.turns.size, 0),
          lastActiveAt: new Date(entry.lastActiveAt).toISOString()
        }
      })
      return {
        startedAt: new Date(startedAt).toISOString(),
        sessions: sessions.size,
        turns: live.sort((a, b) => a.startedAt - b.startedAt)
          .map((turn) => ({ id: turn.id, model: turn.model, startedAt: new Date(turn.startedAt).toISOString() })),
        sinceStart: { turns: { ...outcomes }, rejected: { ...rejections }, usage: { ...totals } },
        users: activity
          .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || b.prompts - a.prompts)
          .slice(0, MAX_USERS_SHOWN)
      }
    }
  }
}
