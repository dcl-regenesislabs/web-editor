import { chrome, setAdvanced } from '../../core/chrome'
import { getHost, hostV1 } from '../../engine/hosted'
import { canAskAssistant } from '../../panels/ai-store'

// Whether this editor may show its machinery at all. The desktop app is the whole editor, and so is
// a v0 host: it signs nothing, so it has no assistant to be left with. A v1 host only when the page's
// `editor-features` has `advanced`, so a creator who wasn't offered it can't reach it through a
// remembered choice or a reveal.
export function advancedOffered(): boolean {
  const host = getHost()
  return host === null || host.version === 0 || hostV1(host)?.features?.advanced === true
}

// Entry mode is the assistant alone: a creator who builds by asking sees the chat, the world,
// Publish and the phone preview, and nothing of the editor's machinery until they ask for it.
// The web editor starts there; the desktop app, a tool for people who edit by hand, starts in
// advanced. Without an assistant there is nothing to show in entry mode, so it is advanced where
// advanced is offered, and entry mode that says so where it isn't.
export function entryMode(): boolean {
  if (!advancedOffered()) return true
  const advanced = chrome.advanced ?? getHost() === null
  return !advanced && canAskAssistant()
}

// Anything that reveals a panel only the whole editor has (the hierarchy, a prefab, the
// inspector) switches to it: a revealed thing behind a hidden panel is not revealed.
export function showAdvanced(): void {
  if (entryMode() && advancedOffered()) setAdvanced(true)
}
