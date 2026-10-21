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
