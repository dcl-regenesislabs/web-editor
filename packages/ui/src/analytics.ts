// What creators do in the web editor, sent through the hosting explorer's
// Segment pipeline so the events share its session and common fields. Desktop
// (no host) sends nothing. Tracking must never break the editor: every failure
// is logged at debug and the event dropped.
import { CREATOR_ACTION_EVENT, type CreatorAction, type CreatorProps } from '@dcl-editor/contract'
import { getHost, hostV1, hostedRoute } from './engine/hosted'
import { log } from './log'

interface TrackedEvent {
  event: string
  properties: CreatorProps
  timestamp: string
}

// The engine console splits its arguments on spaces, so the batch travels as one
// base64 token of its UTF-8 JSON (bevy-explorer react-web/src/lib/analytics.ts).
export function encodeBatch(batch: TrackedEvent[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(batch))
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

// The engine stamps `is_local_scene` from the realm, and the editor's preview realm
// counts as local: rows from inside a project read as previews, the ones before it
// don't. `surface` names the editor's rows whatever that flag says.
const SURFACE = 'web_editor'

export function trackCreator(action: CreatorAction, properties: CreatorProps = {}): void {
  const host = getHost()
  if (host === null) return
  const timestamp = new Date().toISOString()
  const project = hostedRoute.project
  const props: CreatorProps = { action, surface: SURFACE, ...(project === null ? {} : { project_id: project }), ...properties }
  try {
    const v1 = hostV1(host)
    if (typeof v1?.track === 'function') {
      v1.track(CREATOR_ACTION_EVENT, props)
      return
    }
    host
      .engineConsole(`/track ${encodeBatch([{ event: CREATOR_ACTION_EVENT, properties: props, timestamp }])}`)
      .catch((error: unknown) => log.debug('creator action not tracked', action, error))
  } catch (error) {
    log.debug('creator action not tracked', action, error)
  }
}
