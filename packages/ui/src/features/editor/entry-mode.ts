import { chrome, setAdvanced } from '../../core/chrome'
import { getHost } from '../../engine/hosted'
import { canAskAssistant } from '../../panels/ai-store'

// Entry mode is the assistant alone: a creator who builds by asking sees the chat, the world,
// Publish and the phone preview, and nothing of the editor's machinery until they ask for it.
// The web editor starts there; the desktop app, a tool for people who edit by hand, starts in
// advanced. Without an assistant there is nothing to show in entry mode, so it is advanced.
export function entryMode(): boolean {
  const advanced = chrome.advanced ?? getHost() === null
  return !advanced && canAskAssistant()
}

// Anything that reveals a panel only the whole editor has (the hierarchy, a prefab, the
// inspector) switches to it: a revealed thing behind a hidden panel is not revealed.
export function showAdvanced(): void {
  if (entryMode()) setAdvanced(true)
}
