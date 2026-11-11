import type { AiEvent, AiProviderInfo, AiSendParams } from '../../../contract/src/shell.ts'
import type { BrowserToolName } from '../../../contract/src/assistant.ts'
import type { WalletImages } from './thumbnail.ts'

export interface AssistantAgent {
  /** The model id the agent was created with. */
  readonly model?: string
  prompt(params: AiSendParams): Promise<void>
  abort(): Promise<void>
  dispose(): void
  /** Model calls since the last take, including compaction. */
  takeUsage(): TurnUsage
  /** What the model remembers so far, for `create` to start from again. */
  snapshot(): unknown[]
}

export interface TurnUsage {
  /** Priced at the model's API rates, for the service's internal allowance. */
  cost: number
  /** Provider-reported tokens; absent from an agent that cannot report them. */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** Model calls that ended, and how many of them ended without a usage report. */
  calls?: number
  unreported?: number
  /** The model the provider last answered as. */
  responseModel?: string
}

/** Every Claude account the service holds is at its plan's limit. */
export class ProviderLimited extends Error {
  /** When the first one frees up; null when none will on its own. */
  readonly until: string | null
  constructor(until: string | null) {
    super('Provider limited')
    this.until = until
  }
}

/** The agent summarized older messages to keep its context small. */
export interface CompactionStep {
  ms: number
  ok: boolean
  /** Estimated context tokens before and after; absent when the summary failed. */
  tokensBefore?: number
  tokensAfter?: number
  summaryChars: number
}

export type BrowserCall =(tool: BrowserToolName, args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>

export interface AgentFactory {
  providers(): Promise<AiProviderInfo[]>
  create(
    params: AiSendParams,
    call: BrowserCall,
    emit: (event: Pick<Extract<AiEvent, { kind: 'text' }>, 'text'>) => void,
    restore?: unknown[],
    images?: WalletImages,
    onCompaction?: (step: CompactionStep) => void
  ): Promise<AssistantAgent>
}

export interface AssistantService {
  handle(request: Request, path: string, wallet: string, client?: string): Promise<Response>
}
