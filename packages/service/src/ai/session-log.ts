// Operator-side record of assistant sessions, for studying what the assistant did and what it cost. Off unless
// ASSISTANT_SESSION_LOG=1. Unlike memory.ts it keeps the conversation in PLAINTEXT, readable through /admin/, so
// it is for development deployments whose users know their sessions are studied.
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { AssistantTurnOutcome } from '../../../contract/src/analytics.ts'
import type { TurnUsage } from './types.ts'

const WALLET = /^0x[a-f0-9]{40}$/
export const CONVERSATION_ID = /^[a-f0-9]{32}$/
const MAX_PROMPT_CHARS = 4000

export const DEFAULT_SESSION_LOG_LIMITS = {
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  // past this the transcript is not rewritten; turns.jsonl keeps growing
  maxTranscriptBytes: 64 * 1024 * 1024,
  totalBytes: 4 * 1024 * 1024 * 1024
}

export interface StepRecord {
  n: number
  tool: string
  /** The model's time before asking for this tool. */
  thinkMs: number
  toolMs: number
  ok: boolean
  chars: number
}

export interface TurnRecord {
  turnId: string
  projectId: string
  conversation: string
  startedAt: string
  endedAt: string
  ms: number
  outcome: AssistantTurnOutcome
  model?: string
  prompt: string
  steps: StepRecord[]
  toolCalls: number
  failedToolCalls: number
  builds: number
  failedBuilds: number
  usage?: TurnUsage
}

export interface SessionSummary {
  wallet: string
  conversation: string
  projectId: string
  updatedAt: string
  turns: number
  firstPrompt: string
  outcomes: Partial<Record<AssistantTurnOutcome, number>>
  steps: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  cost: number
  transcriptBytes: number
}

export interface WalletSessionLog {
  /** Appends the turn and replaces the transcript; never throws to the caller's turn. */
  record(turn: TurnRecord, transcript: unknown[] | undefined): Promise<void>
}

export interface SessionLog {
  forWallet(wallet: string): WalletSessionLog
  list(limit?: number): Promise<SessionSummary[]>
  turns(wallet: string, conversation: string): Promise<TurnRecord[] | null>
  /** The pi session entries as JSON lines, or null. */
  transcript(wallet: string, conversation: string): Promise<string | null>
  sweep(now?: number): Promise<number>
}

const valid = (wallet: string, conversation: string) => WALLET.test(wallet) && CONVERSATION_ID.test(conversation)

function parseLines(text: string): TurnRecord[] {
  const turns: TurnRecord[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    // a line cut short by a crash is skipped, not fatal for the rest
    try { turns.push(JSON.parse(line) as TurnRecord) } catch { /* partial line */ }
  }
  return turns
}

export function createSessionLog(dir: string, limits = DEFAULT_SESSION_LOG_LIMITS): SessionLog {
  const folder = (wallet: string, conversation: string) => join(dir, wallet, conversation)
  let writes: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = writes.then(work, work)
    writes = next.catch(() => {})
    return next
  }

  async function conversations(): Promise<Array<{ wallet: string; conversation: string; mtimeMs: number; bytes: number }>> {
    const found = []
    for (const wallet of await readdir(dir).catch(() => [])) {
      if (!WALLET.test(wallet)) continue
      for (const conversation of await readdir(join(dir, wallet)).catch(() => [])) {
        if (!CONVERSATION_ID.test(conversation)) continue
        let mtimeMs = 0
        let bytes = 0
        for (const name of await readdir(folder(wallet, conversation)).catch(() => [])) {
          const info = await stat(join(folder(wallet, conversation), name)).catch(() => null)
          if (info === null) continue
          mtimeMs = Math.max(mtimeMs, info.mtimeMs)
          bytes += info.size
        }
        found.push({ wallet, conversation, mtimeMs, bytes })
      }
    }
    return found
  }

  async function summarize(wallet: string, conversation: string, mtimeMs: number): Promise<SessionSummary | null> {
    const text = await readFile(join(folder(wallet, conversation), 'turns.jsonl'), 'utf8').catch(() => null)
    if (text === null) return null
    const turns = parseLines(text)
    if (turns.length === 0) return null
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const outcomes: Partial<Record<AssistantTurnOutcome, number>> = {}
    let cost = 0
    let steps = 0
    for (const turn of turns) {
      outcomes[turn.outcome] = (outcomes[turn.outcome] ?? 0) + 1
      steps += turn.steps.length
      cost += turn.usage?.cost ?? 0
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) tokens[key] += turn.usage?.tokens?.[key] ?? 0
    }
    const transcriptBytes = (await stat(join(folder(wallet, conversation), 'session.jsonl')).catch(() => null))?.size ?? 0
    return {
      wallet, conversation, projectId: turns.at(-1)?.projectId ?? '', updatedAt: new Date(mtimeMs).toISOString(),
      turns: turns.length, firstPrompt: turns[0].prompt.slice(0, 200), outcomes, steps, tokens, cost, transcriptBytes
    }
  }

  return {
    forWallet(raw) {
      const wallet = raw.toLowerCase()
      if (!WALLET.test(wallet)) throw new Error('Invalid wallet')
      return {
        record(turn, transcript) {
          return serial(async () => {
            if (!CONVERSATION_ID.test(turn.conversation)) return
            const total = (await conversations()).reduce((sum, c) => sum + c.bytes, 0)
            if (total > limits.totalBytes) return
            const target = folder(wallet, turn.conversation)
            await mkdir(target, { recursive: true, mode: 0o700 })
            const line = JSON.stringify({ ...turn, prompt: turn.prompt.slice(0, MAX_PROMPT_CHARS) })
            await appendFile(join(target, 'turns.jsonl'), `${line}\n`, { mode: 0o600 })
            if (transcript === undefined) return
            const body = transcript.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
            if (Buffer.byteLength(body) > limits.maxTranscriptBytes) return
            const temp = join(target, `session.jsonl.${randomBytes(6).toString('hex')}.tmp`)
            await writeFile(temp, body, { mode: 0o600 })
            await rename(temp, join(target, 'session.jsonl'))
          })
        }
      }
    },
    async list(limit = 200) {
      const all = (await conversations()).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
      const summaries = await Promise.all(all.map((c) => summarize(c.wallet, c.conversation, c.mtimeMs)))
      return summaries.filter((summary): summary is SessionSummary => summary !== null)
    },
    async turns(wallet, conversation) {
      if (!valid(wallet, conversation)) return null
      const text = await readFile(join(folder(wallet, conversation), 'turns.jsonl'), 'utf8').catch(() => null)
      return text === null ? null : parseLines(text)
    },
    async transcript(wallet, conversation) {
      if (!valid(wallet, conversation)) return null
      return readFile(join(folder(wallet, conversation), 'session.jsonl'), 'utf8').catch(() => null)
    },
    sweep(now = Date.now()) {
      return serial(async () => {
        let removed = 0
        for (const c of await conversations()) {
          if (now - c.mtimeMs <= limits.maxAgeMs) continue
          await rm(folder(c.wallet, c.conversation), { recursive: true, force: true })
          removed++
        }
        return removed
      })
    }
  }
}
