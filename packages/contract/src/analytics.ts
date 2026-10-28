// Creator analytics, sent through the hosting explorer's Segment pipeline. One
// event name on purpose: Segment's warehouse makes a table per event name, so
// every editor action lands in `creator_action` and `action` tells them apart.
export const CREATOR_ACTION_EVENT = 'Creator Action'

export type CreatorAction =
  | 'editor_opened'
  | 'project_created'
  | 'project_opened'
  | 'prompt_sent'
  | 'prompt_completed'
  | 'prompt_failed'
  | 'play_started'
  | 'play_stopped'
  | 'asset_added'
  | 'scene_published'
  | 'publish_failed'

// Flat on purpose (one warehouse column each), and never the creator's own text:
// the engine drops an event over 32 KB, and a prompt is not ours to keep.
export type CreatorProps = Record<string, string | number | boolean | null>

// The assistant service's own events, sent from its backend to the operator's Segment source.
// These types are the allowlist: no prompt, reply, file, tool argument, error text or wallet.
export const ASSISTANT_OPERATION_EVENT = 'Assistant Operation'

export type AssistantTurnOutcome = 'completed' | 'failed' | 'cancelled' | 'disconnected' | 'timed_out'
export type AssistantRejection = 'invalid' | 'busy' | 'limited' | 'allowance' | 'unavailable'
export type AssistantQuotaState = 'disabled' | 'unavailable' | 'ok'

export interface AssistantTurnUsageProps {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  /** false when a call ended without the provider reporting its usage: the counts are a floor */
  usage_complete: boolean
  /** priced at public API rates; not what the subscription bills */
  estimated_api_cost_usd: number
}

export type AssistantOperation =
  | { action: 'turn_started'; turn_id: string; session_id: string }
  | ({
    action: 'turn_finished'; turn_id: string; session_id: string; model: string | null
    outcome: AssistantTurnOutcome; duration_ms: number
    tool_calls: number; failed_tool_calls: number; builds: number; failed_builds: number
    model_calls: number
  } & AssistantTurnUsageProps)
  | { action: 'turn_rejected'; reason: AssistantRejection }
  | { action: 'image_generated'; ok: boolean }
  | {
    action: 'capacity_snapshot'; sessions: number; running_turns: number
    quota_state: AssistantQuotaState; quota_five_hour_percent: number | null; quota_seven_day_percent: number | null
  }
