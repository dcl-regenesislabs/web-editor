// The editor's web target. A page that already runs the engine (bevy-web) sets
// window.__dclEditorHost and loads this module, which mounts nothing by itself and
// answers with window.__dclEditor (editor host contract v1.1): the page's Create
// page calls mountHome for the scene list, and opening a scene mounts the docked
// editor into the host's container.
// Inter is registered at document level: @font-face reaches into the shadow root,
// a stylesheet does not. The build emits it as editor.css next to this module.
import '@fontsource-variable/inter/index.css'
import type { EditorShell } from '@dcl-editor/contract'
import { trackCreator } from '@ui/analytics'
import { flushPendingSave } from '@ui/core/autosave'
import { setConsoleTransport } from '@ui/engine/console'
import { setDataLayerClient } from '@ui/engine/datalayer'
import { type DclEditorHost, hostV1, hostedRoute, setHost } from '@ui/engine/hosted'
import { setHostIdentity } from '@ui/features/account/auth'
import { wireSceneHealth } from '@ui/features/editor/scene-health'
import { CreateHome, captureHudTokens } from '@ui/features/home/CreateHome'
import { welcomeGate } from '@ui/features/home/Welcome'
import { mountEditorUi } from '@ui/mount'
import { Root } from './Root'
import type { WebShell } from './seam'
import { createWebShell } from './shell'
import { fileIntegrity, sceneCompilerFiles } from './workers'

declare const __EDITOR_UI_BUILD__: string

interface HomeApi {
  close(): void
}

declare global {
  interface Window {
    __dclEditorHost?: DclEditorHost
    __dclEditor?: { mountHome(el: HTMLElement, api: HomeApi): () => void; unmount(): void }
    editorShell?: EditorShell
  }
}

interface Session {
  host: DclEditorHost
  web: WebShell
  fonts: HTMLLinkElement
}

let session: Session | null = null
let home: { api: HomeApi; unmount: () => void } | null = null
let docked: (() => void) | null = null
// `?editor=<id>` opens that project once; coming back in later starts at the scene list
let deepLinkTaken = false

function start(): Session | null {
  if (session !== null) return session
  const host = window.__dclEditorHost
  if (host === undefined || (host.version !== 0 && host.version !== 1)) {
    console.error('[editor] window.__dclEditorHost (contract v0 or v1) is missing: nothing to mount into')
    return null
  }
  console.log(`[editor] web build ${__EDITOR_UI_BUILD__}`)
  setHost(host)
  setConsoleTransport((line) => host.engineConsole(line))
  setHostIdentity(() => host.identity())
  welcomeGate.needed = false

  const web = createWebShell({ host, sceneCompiler: sceneCompilerFiles(host.editorBase) })
  window.editorShell = routed(web.shell, host)
  setDataLayerClient(web.dataLayer ?? null)
  // before the first project opens: its first build report must not be missed
  wireSceneHealth()

  const fonts = document.createElement('link')
  fonts.rel = 'stylesheet'
  fonts.href = new URL('editor.css', host.editorBase).href
  fonts.integrity = fileIntegrity('editor.css')
  fonts.crossOrigin = 'anonymous'
  fonts.onerror = () => console.error('[editor] editor.css did not load or does not match the hash this editor was published with: its fonts are not applied')
  document.head.appendChild(fonts)

  hostedRoute.project = null
  hostedRoute.notice = null
  session = { host, web, fonts }
  return session
}

function closeHome(): void {
  const open = home
  home = null
  open?.unmount()
}

// Desktop's shell navigates the page to open a project. Here the Create page
// closes and the docked editor takes over in place. Also where the Create page's
// project actions are tracked.
function routed(shell: EditorShell, host: DclEditorHost): EditorShell {
  const { createScene, importProject, duplicateProject } = shell
  return {
    ...shell,
    ...(createScene === undefined ? {} : {
      createScene: async (parent, name, template) => {
        const id = await createScene(parent, name, template)
        if (id !== null) trackCreator('project_created', { project_id: id, source: 'template', template })
        return id
      }
    }),
    ...(importProject === undefined ? {} : {
      importProject: async (kind) => {
        const result = await importProject(kind)
        if (result?.ok === true) trackCreator('project_created', { project_id: result.report.id, source: 'import', import_kind: kind })
        return result
      }
    }),
    ...(duplicateProject === undefined ? {} : {
      duplicateProject: async (id) => {
        const copy = await duplicateProject(id)
        if (copy !== null) trackCreator('project_created', { project_id: copy, source: 'duplicate', from_project_id: id })
        return copy
      }
    }),
    openProject: async (id) => {
      const page = home
      closeHome()
      page?.api.close()
      docked ??= mountEditorUi(host.container, <Root />)
      host.setMode('edit')
      hostedRoute.project = id
      hostedRoute.opens++
      await shell.openProject(id)
      trackCreator('project_opened')
    }
  }
}

function mountHome(el: HTMLElement, api: HomeApi): () => void {
  const s = start()
  if (s === null) return () => {}
  closeHome()
  const frame = document.createElement('div')
  frame.style.cssText = 'position:relative;width:100%;height:100%'
  captureHudTokens(frame)
  el.appendChild(frame)
  const unmountUi = mountEditorUi(frame, <CreateHome />, 'eui-create-root')
  const entry = {
    api,
    unmount: () => {
      unmountUi()
      frame.remove()
    }
  }
  home = entry

  const wanted = deepLinkTaken ? null : (hostV1(s.host)?.openProject ?? null)
  deepLinkTaken = true
  trackCreator('editor_opened', { deep_link: wanted !== null })
  if (wanted !== null) {
    void s.web.projects
      .find(wanted)
      .catch(() => false)
      .then((found) => {
        // the creator may have opened something, or closed the page, while the account was asked
        if (home !== entry) return
        if (found) void window.editorShell?.openProject(wanted)
        else hostedRoute.notice = `“${wanted}” is not on this device or on your account. Here are your scenes.`
      })
  }

  return () => {
    if (home === entry) closeHome()
  }
}

function unmount(): void {
  closeHome()
  const s = session
  if (s === null) return
  session = null
  // the debounced save is still owed to the store that is about to go away
  const lastSave = flushPendingSave()
  docked?.()
  docked = null
  s.fonts.remove()
  hostedRoute.project = null
  delete window.editorShell
  setHostIdentity(null)
  setConsoleTransport(null)
  setHost(null)
  s.host.setMode('off')
  void lastSave.finally(() => {
    s.web.dispose?.()
    if (session === null) setDataLayerClient(null)
  })
}

window.__dclEditor = { mountHome, unmount }
