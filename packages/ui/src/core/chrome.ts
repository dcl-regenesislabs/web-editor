// Whether the editor chrome (topbar, panels, toolbar, assistant) is drawn over
// the viewport. Hiding it is pure page-side state — the engine iframe keeps
// rendering underneath, so a clean look at the scene costs nothing and asks
// nothing of bevy. The scene-health banner stays outside this flag on purpose:
// a crash must be visible even when the creator is admiring their work.
import { reactive } from './store'
import { setStoredFlag, storedFlag, storedValue, whenPersisted } from './persist'

// The right dock is ONE unit — the inspector and the assistant live and hide
// together, so its visibility is a single flag. It lives here rather than in a
// component's usePersistentFlag because module code has to be able to raise the
// dock: an "ask the assistant" chip or a jump to an error line has to reach a
// panel the creator may have hidden.
export const chrome = reactive({
  uiHidden: false,
  rightOpen: storedFlag('right', true),
  rightDock: 0,
  rightDockBottom: 0,
  // the creator's pick between the assistant alone and the whole editor; null until they make one
  advanced: storedAdvanced()
})
whenPersisted(() => {
  chrome.rightOpen = storedFlag('right', true)
  chrome.advanced = storedAdvanced()
})

function storedAdvanced(): boolean | null {
  const stored = storedValue('advanced')
  return stored === null ? null : stored === '1'
}

export function setAdvanced(on: boolean): void {
  chrome.advanced = on
  setStoredFlag('advanced', on)
}

export function toggleUiHidden(): void {
  chrome.uiHidden = !chrome.uiHidden
}

export function setRightOpen(open: boolean): void {
  chrome.rightOpen = open
  setStoredFlag('right', open)
}

export function toggleRightPanel(): void {
  setRightOpen(!chrome.rightOpen)
}

// The logs drawer ends where the right-hand column begins, so the assistant's composer stays usable.
export function trackRightDock(el: HTMLElement): () => void {
  const observer = new ResizeObserver(() => measure())
  const measure = (): void => {
    const left = el.getBoundingClientRect().left
    chrome.rightDock = el.hidden || left <= 0 ? 0 : Math.max(0, Math.round(window.innerWidth - left))
    // a minimized inspector or assistant is a title bar at the top: below it the column is empty
    chrome.rightDockBottom = Math.round(Math.max(0, ...[...el.children].map((child) => child.getBoundingClientRect().bottom)))
  }
  const watchChildren = (): void => {
    observer.disconnect()
    observer.observe(el)
    for (const child of el.children) observer.observe(child)
    measure()
  }
  const children = new MutationObserver(watchChildren)
  children.observe(el, { childList: true })
  watchChildren()
  window.addEventListener('resize', measure)
  return () => {
    observer.disconnect()
    children.disconnect()
    window.removeEventListener('resize', measure)
    chrome.rightDock = 0
    chrome.rightDockBottom = 0
  }
}
