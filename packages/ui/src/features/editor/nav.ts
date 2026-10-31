// Our own engine host page (engine.html), which boots the upstream engine via
// its boot contract (/engine/boot.js + __bevyLaunch). The engine package's root
// index.html is the full Decentraland React HUD now — not loadable as a bare
// engine — so the editor owns the boot page.
import { getHost, hostedRoute, isHosted } from '../../engine/hosted'
import { flushPendingSave } from '../../core/autosave'
import { endSession, reattachScene } from '../../boot/boot'

// Leave the current scene for the scene list (hosted: the HUD's Create page). Stops the project's dev server (and
// its auth-server child) first via the shell so it doesn't linger, then
// navigates. Falls back to a plain navigation in-page (no shell).
export function backToProjects(): void {
  const shell = window.editorShell
  const host = getHost()
  if (host !== null) {
    // no page to navigate away from: the debounced save would outlive the project
    void flushPendingSave()
      .then(() => shell?.closeProject?.())
      .finally(() => {
        endSession()
        hostedRoute.project = null
        host.setMode('off')
        if (host.openCreatePage !== undefined) host.openCreatePage()
        else host.exit()
      })
    return
  }
  if (shell?.closeProject !== undefined) {
    void shell.closeProject().finally(() => window.location.assign('/editor-app.html'))
  } else {
    window.location.assign('/editor-app.html')
  }
}

export function backLabel(): string {
  return isHosted() ? 'Back to scenes' : 'Back to projects'
}

// Hosted, a page reload would restart the engine and the host's whole session.
export function reloadEditor(): void {
  if (isHosted()) void reattachScene()
  else window.location.reload()
}
