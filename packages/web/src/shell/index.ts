// The editor's backend in the browser (see ../seam.ts): projects in the Origin
// Private File System, the scene built in a worker, and the result published to
// the preview realm the page's service worker serves.
// Publishing has no CLI to drive here: on a v1 host the shell does it itself
// (publish/publish.ts), and the hosting page confirms and signs.
//
// Signed in, on a page with a project service, the projects are also copied to
// the account (sync/engine.ts). Nothing here waits for that copy.
import type {
  EditorShell,
  HostState,
  ProjectImportReport,
  ProjectInfo,
  ProjectPackages,
  SceneBuildEvent,
  SceneSettings,
  ServersReady
} from '@dcl-editor/contract'
import { TRASH_DAYS, copySuffix, object } from '@dcl-editor/contract'
import { contentCid } from '@dcl-editor/contract/cid'
import { LOCK_FILE, PREVIEW_CACHE_NAME, PREVIEW_STORAGE_CACHE_NAME, assetPacksStubUpgrades, fetchVerified, lockedKey, parseLock } from '@dcl-editor/scene-compiler'
import { notify } from '@scene/reactive'
import { hostV1 } from '@ui/engine/hosted'
import { persistReady } from '@ui/core/persist'
import { version } from '../../package.json'
import { createBrowserAssistant } from '../ai/client'
import { refreshWrittenScript } from '@ui/ai/attach'
import { state } from '@scene/state'
import { browserSceneRequest } from '@ui/ai/scene'
import { sameBytes } from '../ai/tools'
import { captureView } from '@ui/ai/view'
import { createAssetRequests } from '@ui/ai/assets'
import { materialBytes, setLibraryBase, soundBytes } from '../ai/library-files'
import { setLibraryBytes } from '@ui/ai/library-bytes'
import { runFreshBuild } from '@ui/actions/verify-build'
import { flushPendingSave } from '@ui/core/autosave'
import { updateSpawnPoints } from '@ui/spawn-points'
import { leavePhone, playtest } from '@ui/ai/playtest'
import { uiLayout } from '@ui/ai/ui-layout'
import { externalDependencies } from '../archive/dependencies'
import { createPublisher } from '../publish/publish'
import { publishWorlds } from '../publish/worlds'
import type { CreateWebShell, DataLayerClient, WebProjects } from '../seam'
import { browserBackend, isNotFound } from '../store/fs'
import { BIDI, type ProjectRecord, ProjectStore } from '../store/project-store'
import { createPrefabsApi, createProjectsApi } from '../sync/api'
import { createSyncEngine } from '../sync/engine'
import { canPickFolder, downloadZip, importProject, pickFile } from './archive'
import { createBuiltinPrefabs } from './builtin-prefabs'
import { runtimeTypes, sceneTemplates, templateFiles } from './bundled'
import { type ProjectFiles, createPrefabLibrary, parseRef } from './prefab-library'
import { type Preview, browserSecret, createPreviews, previewMachineId } from './preview'
import { createPhonePreview, mobilePreviewEntry, previewEnvironment } from './phone-preview'
import { relayServerLogs } from './server-logs'
import { waitForPreviewLayout } from './preview-layout'
import { createUserPrefabs } from './user-prefabs'
import { fileIntegrity, threeWorkerSource } from '../workers'
import { setThreeWorker } from '@ui/three/client'
import { setPublishedSize } from '@ui/scene-budget'
import { publishedSize } from './deploy-size'
import {
  COMPOSITE_CANDIDATES,
  IMG_MIME,
  type RawSceneJson,
  applySettings,
  applyAssistantSettings,
  compositeEntityIds,
  extensionOf,
  extractSettings,
  imageDataUrl,
  parseSceneJson,
  sceneJsonBytes,
  spawnWorldPosition,
  validateSettings
} from './scene-json'

const MAX_LOG_LINES = 4000
const MAX_THUMBNAIL_BYTES = 4_000_000
const TRASH_KEPT_MS = TRASH_DAYS * 24 * 60 * 60 * 1000
const THUMBNAIL_DIR = 'assets/images'
const ACCOUNT_POLL_MS = 3000
// the service's limit on a project's name
const MAX_NAME = 100
const SIGN_IN_FOR_LIBRARY = 'Sign in to keep prefabs in your own library. The built-in prefabs work without it.'

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function previewReady(scene: RawSceneJson, realmUrl: string): ServersReady {
  return {
    realm: realmUrl.replace(/\/$/, ''), systemScene: '',
    position: scene.scene?.base ?? scene.scene?.parcels?.[0] ?? '0,0',
    spawn: spawnWorldPosition(scene),
    spawnPoints: JSON.stringify(Array.isArray(scene.spawnPoints) ? scene.spawnPoints : [])
  }
}

export const createWebShell: CreateWebShell = ({ host, sceneCompiler }) => {
  const store = new ProjectStore(browserBackend())
  const services = hostV1(host)
  // a v0 host signs nothing, and a v1 host may have no project service
  const api =
    services === null || services.services.projects === null
      ? null
      : createProjectsApi(services.services.projects, (url, init) => services.signedFetch(url, init))
  const wallet = (): string | null => {
    const { address, isGuest } = host.identity()
    return isGuest || address === null ? null : address.toLowerCase()
  }
  const logs: string[] = []
  const logListeners: Array<(line: string) => void> = []
  const buildListeners: Array<(event: SceneBuildEvent) => void> = []
  const readyListeners: Array<(info: ServersReady) => void> = []
  const errorListeners: Array<(message: string) => void> = []

  const log = (line: string): void => {
    logs.push(line)
    if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES)
    for (const listener of logListeners) listener(line)
  }
  const phone = createPhonePreview(mobilePreviewEntry(host.pageDir, services?.services.projects ?? null), previewIdOf, async (realmId) => previewMachineId(await secret, wallet() ?? 'guest', realmId), previewEnvironment(services?.services.worldsContent ?? null))
  const emit = (event: SceneBuildEvent): void => {
    for (const listener of buildListeners) listener(event)
    if (event.type === 'bundleSaved' && current !== null) phone.built(current.id).catch((error: unknown) => console.error('[editor] mobile preview reload failed', error))
  }
  // where each project's npm packages stand, for as long as the page lives
  const packages = new Map<string, ProjectPackages>()
  const packageListeners = new Set<(id: string, status: ProjectPackages) => void>()
  // stored in IndexedDB: read once it has loaded, or each page load would be another machine
  const secret = persistReady.then(browserSecret)
  const previews = createPreviews({
    pageDir: host.pageDir,
    urls: sceneCompiler,
    machineId: async (id) => previewMachineId(await secret, wallet() ?? 'guest', id),
    emit,
    log,
    packages: store.packages,
    saveLock: async (id, bytes) => {
      await store.write(id, LOCK_FILE, bytes)
      sync.touched(id, LOCK_FILE)
      // no rebuild: the build that froze the packages is the one under way
      if (current?.id === id) current.files.set(LOCK_FILE, bytes)
    },
    onPackages: (id, status) => {
      if (status === null) {
        packages.delete(id)
        return
      }
      packages.set(id, status)
      for (const listener of packageListeners) listener(id, status)
    }
  })

  let ready: ServersReady | null = null
  let current: Preview | null = null
  // the realm the open project is previewed at
  let currentRealm: string | null = null
  let stopServerLogs: (() => void) | null = null

  async function previewIdOf(id: string): Promise<string> {
    const known = (await store.list()).find((project) => project.id === id)?.previewId
    if (known !== undefined) return known
    const previewId = 'p' + Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
    await store.patch(id, { previewId })
    return previewId
  }

  // a preview realm is readable by any scene on this origin: drop what no open project needs
  async function clearPreviews(keep: string | null): Promise<void> {
    const root = new URL('preview/', host.pageDir).href
    const cache = await caches.open(PREVIEW_CACHE_NAME)
    for (const request of await cache.keys()) {
      if (request.url.startsWith(root) && (keep === null || !request.url.startsWith(keep))) await cache.delete(request)
    }
  }
  // opens and closes run one at a time; a newer one makes an older one's answer moot
  let generation = 0
  let transitions: Promise<void> = Promise.resolve()
  let fileWrites: Promise<unknown> = Promise.resolve()

  const assistant = createBrowserAssistant({
    service: services?.services.projects ?? null,
    fetch: (url, init) => {
      if (services === null) return Promise.reject(new Error('The assistant service is not configured.'))
      return services.signedFetch(url, init)
    },
    wallet,
    mobilePreview: phone.status,
    memory: {
      read: async (projectId, account) => {
        const kept = await store.assistantMemory(projectId, account)
        return object(kept) && typeof kept.id === 'string' && typeof kept.key === 'string' ? { id: kept.id, key: kept.key } : null
      },
      write: (projectId, account, ref) => store.setAssistantMemory(projectId, account, ref)
    },
    project: () => {
      const open = project()
      return {
        id: open.id,
        tools: {
          files: () => open.files,
          write: (path, bytes, expected, signal) => writeFile(open.id, path, bytes, { expected, signal }),
          assets: createAssetRequests({ files: () => open.files }),
          scene: (request, signal) =>
            browserSceneRequest(request, signal, async (settings) => {
              const layout = (raw: ReturnType<typeof parseSceneJson>) => JSON.stringify([raw?.scene?.parcels, raw?.scene?.base])
              await flushPendingSave()
              const before = layout(parseSceneJson(await readFile(open.id, 'scene.json')))
              await editSceneJson(open.id, (raw) => applyAssistantSettings(raw, settings))
              const raw = parseSceneJson(await readFile(open.id, 'scene.json'))
              const moved = layout(raw) !== before
              const parcels = raw?.scene?.parcels ?? []
              const live = state.scene?.parcels.map(p => `${p.x},${p.y}`).sort().join(';')
              if (moved || live !== [...parcels].sort().join(';')) {
                if (!(await open.flush())) throw new Error('The scene did not build. Fix the code and retry sceneSettings to load the new parcels.')
                signal.throwIfAborted()
                const realmId = await previewIdOf(open.id)
                ready = previewReady(raw ?? {}, previews.realmUrl(realmId))
                await waitForPreviewLayout(parcels, () => {
                  for (const listener of readyListeners) listener(ready!)
                }, signal)
              } else if (ready !== null) {
                const fresh = previewReady(raw ?? {}, ready.realm)
                if (fresh.spawn !== ready.spawn || fresh.spawnPoints !== ready.spawnPoints) {
                  ready = { ...ready, spawn: fresh.spawn, spawnPoints: fresh.spawnPoints }
                  updateSpawnPoints(fresh.spawn, fresh.spawnPoints)
                }
              }
              return {
                requiredPermissions: raw?.requiredPermissions ?? [], spawnPoints: raw?.spawnPoints ?? [],
                parcels, base: raw?.scene?.base ?? null, previewReady: true
              }
            }),
          written: refreshWrittenScript,
          view: (request, signal) => captureView(request, signal),
          playtest, uiLayout, turnEnded: leavePhone,
          build: async (signal) => {
            signal.throwIfAborted()
            await fileWrites
            const result = await previews.build(open.id, new Map(open.files))
            signal.throwIfAborted()
            if (!result.ok) return { ok: false, diagnostics: result.diagnostics, mobilePreview: phone.status() }
            // compiled is not working: run it once and report what it printed
            const run = await runFreshBuild()
            signal.throwIfAborted()
            return { ok: true, diagnostics: result.diagnostics, run, mobilePreview: phone.status() }
          }
        }
      }
    }
  })

  function leave(): void {
    assistant.reset()
    stopServerLogs?.()
    stopServerLogs = null
    if (current === null) return
    current.stop()
    store.close(current.id)
    void sync.flush(current.id)
    current = null
    currentRealm = null
  }

  async function readFile(id: string, path: string): Promise<Uint8Array | undefined> {
    if (current?.id === id) return current.files.get(path)
    return store.read(id, path).catch((error: unknown) => {
      if (isNotFound(error)) return undefined
      throw error
    })
  }

  function writeFile(id: string, path: string, bytes: Uint8Array, guard?: { expected: Uint8Array | null; signal: AbortSignal }): Promise<void> {
    const write = fileWrites.then(async () => {
      guard?.signal.throwIfAborted()
      if (guard !== undefined && (current?.id !== id || !sameBytes(current.files.get(path), guard.expected))) {
        throw new Error('This file changed. Read it again before writing.')
      }
      await store.write(id, path, bytes)
      sync.touched(id, path)
      if (current?.id !== id) return
      current.files.set(path, bytes)
      current.changed(path)
    })
    fileWrites = write.catch((error: unknown) => console.error('[editor] file write failed', error))
    return write
  }

  function removeFile(id: string, path: string): Promise<boolean> {
    const removal = fileWrites.then(async () => {
      const removed = await store.remove(id, path)
      if (removed) sync.touched(id, path)
      if (removed && current?.id === id && current.files.delete(path)) current.changed(path)
      return removed
    })
    fileWrites = removal.catch((error: unknown) => console.error('[editor] file removal failed', error))
    return removal
  }

  // the prefab copies work on the open project: the editor reads the folder back through the data layer
  function openFiles(id: string): ProjectFiles {
    const open = project()
    if (open.id !== id) throw new Error('that scene is not the one open')
    return {
      files: () => open.files,
      write: (path, bytes) => writeFile(id, path, bytes),
      remove: async (path) => {
        await removeFile(id, path)
      }
    }
  }

  async function title(id: string): Promise<string> {
    const scene = parseSceneJson(await readFile(id, 'scene.json').catch(() => undefined))
    // the service refuses control characters and bidi controls in a name
    const clean = (scene?.display?.title ?? '').replace(/[\x00-\x1f\x7f]/g, '').replace(new RegExp(BIDI.source, 'g'), '').trim().slice(0, MAX_NAME)
    return clean === '' ? id : clean
  }

  async function duplicate(id: string, suffix: string): Promise<string | null> {
    const record = (await store.list()).find((candidate) => candidate.id === id)
    if (record === undefined) return null
    const copy = await store.duplicate(id, `${record.name} ${suffix}`, sync.remoteIds())
    await editSceneJson(copy.id, (raw) => ({
      ...raw,
      display: { ...(raw.display ?? {}), title: `${raw.display?.title || record.name} ${suffix}` }
    }))
    return copy.id
  }

  const sync = createSyncEngine({
    store,
    session: () => {
      const signedIn = wallet()
      return api === null || signedIn === null ? null : { api, wallet: signedIn }
    },
    account: () => {
      if (api === null) return 'unavailable'
      return wallet() === null ? 'guest' : 'on'
    },
    hash: contentCid,
    title,
    duplicate: async (id) => {
      const copy = await duplicate(id, copySuffix(new Date()))
      if (copy === null) throw new Error('The scene is no longer on this device')
      return copy
    }
  })
  // hidden until the service says this account may use it
  let aiOffered = false
  let aiProbe = 0
  async function probeAssistant(): Promise<void> {
    const probe = ++aiProbe
    const offered = wallet() !== null && (await assistant.shell.aiProviders()).some((provider) => provider.available)
    if (probe !== aiProbe || offered === aiOffered) return
    aiOffered = offered
    notify()
  }
  void probeAssistant()
  // signing in or out changes whose copy the projects are compared with
  let signedInAs = wallet()
  const accountPoll = setInterval(() => {
    const now = wallet()
    if (now === signedInAs) return
    signedInAs = now
    assistant.reset()
    notify()
    void probeAssistant()
    void sync.refresh(true)
    void clearPreviews(currentRealm).catch((error: unknown) => console.warn('[editor] could not clear the previews', error))
  }, ACCOUNT_POLL_MS)
  // a tab being hidden may be a tab being closed: send what is waiting
  const onHidden = (): void => {
    if (document.visibilityState === 'hidden') void sync.flush()
  }
  document.addEventListener('visibilitychange', onHidden)
  const importListeners = new Set<(report: ProjectImportReport) => void>()

  async function editSceneJson(id: string, edit: (raw: RawSceneJson) => RawSceneJson): Promise<void> {
    const raw = parseSceneJson(await readFile(id, 'scene.json'))
    if (raw === null) throw new Error('scene.json is missing or is not valid JSON')
    await writeFile(id, 'scene.json', sceneJsonBytes(edit(raw)))
  }

  async function thumbnail(id: string, path: string | null | undefined): Promise<string | null> {
    if (path === null || path === undefined || path === '') return null
    const bytes = await readFile(id, path).catch(() => undefined)
    return bytes === undefined || bytes.length > MAX_THUMBNAIL_BYTES ? null : imageDataUrl(path, bytes)
  }

  async function info(record: ProjectRecord, states = sync.status().projects): Promise<ProjectInfo> {
    const scene = parseSceneJson(await readFile(record.id, 'scene.json').catch(() => undefined))
    return {
      sync: states[record.id],
      path: record.id,
      name: record.name,
      title: scene?.display?.title || record.name,
      world: scene?.worldConfiguration?.name || null,
      parcels: Array.isArray(scene?.scene?.parcels) ? scene.scene.parcels.length : 0,
      thumbnail: await thumbnail(record.id, scene?.display?.navmapThumbnail),
      favourite: record.favourite,
      lastOpened: record.lastOpened,
      published: record.published,
      deletedAt: record.deletedAt ?? undefined
    }
  }

  async function open(id: string, mine: number): Promise<void> {
    leave()
    logs.length = 0
    emit({ type: 'sessionStarted' })
    const fail = (message: string): void => {
      leave()
      if (mine !== generation) return
      log(`✖ ${message}`)
      for (const listener of errorListeners) listener(message)
    }
    try {
      // downloads a scene that is only on the account, and brings one that is behind up to date
      await sync.prepareOpen(id, (done, total) => log(`Downloading from your account… ${done}/${total}`))
      if (mine !== generation) return
      if (!(await store.open(id))) {
        fail('This scene is open in another tab. Close it there to edit it here.')
        return
      }
      const files = await store.readAll(id).then(async (files) => {
        for (const [path, bytes] of assetPacksStubUpgrades(files)) {
          await writeFile(id, path, bytes)
          files.set(path, bytes)
        }
        return files
      }).catch((error: unknown) => {
        store.close(id)
        throw error
      })
      if (mine !== generation) {
        store.close(id)
        return
      }
      const realmId = await previewIdOf(id)
      if (mine !== generation) {
        store.close(id)
        return
      }
      const preview = previews.open(id, files, realmId)
      current = preview
      const realmUrl = previews.realmUrl(realmId)
      currentRealm = realmUrl
      log(`▶ Opening ${parseSceneJson(preview.files.get('scene.json'))?.display?.title || id}`)
      // a build that fails still opens over the last one that worked: the fix is made in the editor
      if (!(await preview.start()) && !(await preview.published())) {
        // kept open: the error screen offers its code, and Try again opens it afresh
        if (mine !== generation) return
        log('✖ The scene did not build.')
        for (const listener of errorListeners) listener('The scene did not build.')
        return
      }
      await store.patch(id, { lastOpened: Date.now() })
      if (mine !== generation) {
        leave()
        return
      }
      const scene = parseSceneJson(preview.files.get('scene.json')) ?? {}
      ready = previewReady(scene, realmUrl)
      stopServerLogs = relayServerLogs((line) => host.engineConsole(line), log)
      for (const listener of readyListeners) listener(ready)
    } catch (error) {
      fail(describe(error))
    }
  }

  function transition(work: (mine: number) => Promise<void>): Promise<void> {
    phone.close()
    ready = null
    const mine = ++generation
    const stopped = assistant.reset()
    const run = transitions.then(async () => {
      await stopped
      await fileWrites
      if (mine === generation) await work(mine)
    })
    // one that throws must not stop the ones after it
    transitions = run.catch((error: unknown) => console.error('[editor] project transition failed', error))
    return run
  }

  function project(): Preview {
    if (current === null) throw new Error('no project is open')
    return current
  }

  const dataLayer: DataLayerClient = {
    saveFile: async ({ path, content }) => writeFile(project().id, path, content),
    getFile: async ({ path }) => {
      const content = project().files.get(path) ?? runtimeTypes(path)
      if (content === undefined) throw new Error(`no such file: ${path}`)
      return { content }
    },
    removeFiles: async ({ filePaths }) => {
      const open = project()
      const success: string[] = []
      const failed: string[] = []
      for (const path of filePaths) {
        const removed = await removeFile(open.id, path).catch(() => false)
        ;(removed ? success : failed).push(path)
      }
      return { success, failed }
    },
    getFilesSizes: async ({ path, ignore }) => {
      const under = path === '' ? '' : `${path.replace(/\/+$/, '')}/`
      const files = [...project().files.keys()]
        .filter((file) => file.startsWith(under) && !file.split('/').some((segment) => ignore.includes(segment)))
        .sort()
      return { files: files.map((file) => ({ path: file })) }
    }
  }

  const projects: WebProjects = {
    async find(id) {
      if ((await store.list()).some((record) => record.id === id)) return true
      await sync.refresh(true)
      return sync.remoteOnly().some((project) => project.id === id)
    },
    files: async (id) => (current?.id === id ? new Map(current.files) : store.readAll(id)),
    manifest: (id) => sync.manifest(id),
    build: async (id, options) => previews.build(id, await projects.files(id), options),
    dependencies: async (id) => externalDependencies(await readFile(id, 'package.json')),
    onImported: (listener) => {
      importListeners.add(listener)
      return () => importListeners.delete(listener)
    }
  }

  const publisher =
    services === null
      ? null
      : createPublisher({
          host: services,
          setWorld: async (id, world) => {
            const named = parseSceneJson(await readFile(id, 'scene.json'))?.worldConfiguration?.name
            if (named !== world) {
              await editSceneJson(id, (raw) => ({ ...raw, worldConfiguration: { ...(raw.worldConfiguration ?? {}), name: world } }))
            }
          },
          files: (id) => projects.files(id),
          build: (id, files) => previews.build(id, files, { production: true }),
          published: (id, scene) => store.patch(id, { published: scene })
        })

  const userPrefabs =
    services?.services.projects == null
      ? null
      : createUserPrefabs(createPrefabsApi(services.services.projects, (url, init) => services.signedFetch(url, init)), contentCid)
  setThreeWorker(threeWorkerSource(host.editorBase))
  setLibraryBase(host.editorBase)
  setLibraryBytes({ material: materialBytes, sound: soundBytes })
  setPublishedSize(async () => publishedSize(await projects.files(project().id)))
  const prefabs = createPrefabLibrary({
    builtin: createBuiltinPrefabs(host.editorBase, fileIntegrity('prefabs/catalog.json'), fetchVerified),
    user: () => (userPrefabs !== null && wallet() !== null ? userPrefabs.tree : null)
  })

  const shell: EditorShell = {
    ...(services?.services.projects == null ? {} : {
      ...assistant.shell,
      aiOffered: () => aiOffered,
      // read on every store notify, so it uses the polled account rather than asking the host
      aiTranscript: () => {
        const signedIn = signedInAs
        if (signedIn === null || current === null) return null
        const id = current.id
        return {
          owner: `${id}@${signedIn.toLowerCase()}`,
          load: () => store.transcript(id, signedIn),
          save: (messages) => store.setTranscript(id, signedIn, messages)
        }
      }
    }),
    // a folder or a zip comes in through importProject
    pickProject: async () => {},
    openProject: (id) => transition((mine) => open(id, mine)),
    relaunchProject: (id) => transition((mine) => open(id, mine)),
    closeProject: () =>
      transition(async () => {
        leave()
        emit({ type: 'sessionStarted' })
        log('■ Scene closed')
        await clearPreviews(null).catch((error: unknown) => console.warn('[editor] could not clear the previews', error))
      }),
    getState: async (): Promise<HostState> => {
      const records = await store.list()
      const states = sync.status().projects
      const onAccount = sync.remoteOnly().map(
        (project): ProjectInfo => ({
          path: project.id,
          name: project.name,
          title: project.name,
          world: null,
          parcels: 0,
          thumbnail: null,
          remoteOnly: true
        })
      )
      return {
        recentProjects: [...records].sort((a, b) => b.lastOpened - a.lastOpened).map((record) => record.id),
        projects: [...(await Promise.all(records.map((record) => info(record, states)))), ...onAccount],
        logs: [...logs],
        bevyWebDir: '',
        editorSceneDir: '',
        webPort: 0,
        scenePort: 0,
        editorScenePort: 0,
        favourites: records.filter((record) => record.favourite).map((record) => record.id)
      }
    },
    onStackLog: (listener) => {
      logListeners.push(listener)
    },
    onBuildEvent: (listener) => {
      buildListeners.push(listener)
    },
    onServersReady: (listener) => {
      readyListeners.push(listener)
    },
    requestReady: async () => ready,
    phonePreview: async (mode) => (ready === null ? { ok: false, reason: 'no-scene' } : phone.open(ready.realm, ready.position, mode)),
    phonePreviewState: phone.state,
    onPhonePreviewState: phone.subscribe,
    closePhonePreview: phone.close,
    capturePhonePreview: phone.capture,
    onServersError: (listener) => {
      errorListeners.push(listener)
    },

    toggleFavourite: async (id) => {
      const record = (await store.list()).find((candidate) => candidate.id === id)
      if (record !== undefined) await store.patch(id, { favourite: !record.favourite })
    },
    deleteProject: async (id) => {
      const trashed = await store.trash(id)
      if (trashed) sync.trashed(id)
      return trashed
    },
    trashedProjects: async () => Promise.all((await store.trashed()).map((record) => info(record))),
    restoreProject: async (id) => {
      const restored = await store.restore(id)
      if (restored) sync.restored(id)
      return restored
    },
    syncStatus: async () => {
      void sync.refresh()
      return sync.status()
    },
    onSyncStatus: (listener) => sync.subscribe(listener),
    resolveSyncConflict: (id, choice) => sync.resolve(id, choice),
    exportProject: async (id) => downloadZip(await title(id), await projects.files(id)),
    importProject: async (kind) => {
      const result = await importProject(kind, async (name, files) => {
        const record = await store.create(name, files, { taken: sync.remoteIds() })
        sync.touched(record.id, 'scene.json')
        return record.id
      })
      if (result?.ok === true) {
        const { id, needsPackages } = result.report
        // downloaded now, so the scene's first build finds them
        if (Object.keys(needsPackages).length > 0) {
          void store
            .readAll(id)
            .then((files) => previews.install(id, files))
            .catch((error: unknown) => console.warn('[editor] could not install the packages of', id, error))
        }
        for (const listener of importListeners) listener(result.report)
      }
      return result
    },
    projectPackages: async (id) => packages.get(id) ?? null,
    onProjectPackages: (listener) => {
      packageListeners.add(listener)
      return () => packageListeners.delete(listener)
    },
    ...(publisher === null || services === null
      ? {}
      : {
          publishScene: (id, world, onProgress) => publisher.publish(id, world, onProgress),
          publishStop: async () => publisher.stop(),
          publishWorlds: async () => {
            const signedIn = wallet()
            return signedIn === null ? [] : publishWorlds(signedIn, services.services.worldsContent.replace(/\/+$/, ''))
          }
        }),
    canImportFolder: canPickFolder(),
    renameProject: (id, title) =>
      editSceneJson(id, (raw) => ({ ...raw, display: { ...(raw.display ?? {}), title: title.trim() } })),
    duplicateProject: (id) => duplicate(id, 'copy'),
    sceneTemplates: async () => sceneTemplates(),
    createScene: async (_parent, name, template) => {
      const files = templateFiles(template)
      const scene = parseSceneJson(files.get('scene.json'))
      if (scene === null) throw new Error(`template not found: ${template}`)
      files.set('scene.json', sceneJsonBytes({ ...scene, display: { ...(scene.display ?? {}), title: name.trim() } }))
      const record = await store.create(name, files, { taken: sync.remoteIds() })
      sync.touched(record.id, 'scene.json')
      return record.id
    },
    openExternal: async (url) => {
      if (/^https?:$/.test(new URL(url).protocol)) window.open(url, '_blank', 'noopener,noreferrer')
    },

    compositeEntityIds: async (id) => {
      for (const path of COMPOSITE_CANDIDATES) {
        const bytes = await readFile(id, path)
        if (bytes !== undefined) return compositeEntityIds(new TextDecoder().decode(bytes))
      }
      return []
    },
    sceneSettings: async (id): Promise<SceneSettings> => {
      const raw = parseSceneJson(await readFile(id, 'scene.json'))
      if (raw === null) throw new Error('scene.json is missing or is not valid JSON')
      const settings = extractSettings(raw)
      return { ...settings, thumbnail: await thumbnail(id, settings.thumbnailPath) }
    },
    saveSceneSettings: async (id, settings) => {
      const problem = validateSettings(settings)
      if (problem !== null) return problem
      await editSceneJson(id, (raw) => applySettings(raw, settings))
      return null
    },
    pickSceneThumbnail: async (id) => {
      const picked = await pickFile(Object.values(IMG_MIME).join(','))
      if (picked === null) return null
      const extension = extensionOf(picked.name)
      if (IMG_MIME[extension] === undefined) throw new Error('not a supported image (png, jpg, gif, webp)')
      const path = `${THUMBNAIL_DIR}/scene-thumbnail${extension}`
      const bytes = new Uint8Array(await picked.arrayBuffer())
      await writeFile(id, path, bytes)
      return { path, dataUrl: imageDataUrl(path, bytes) }
    },
    appVersion: async () => version,

    prefabLibraryList: () => prefabs.list(),
    prefabLibraryCopyIn: async (ref, id) => prefabs.copyIn(ref, openFiles(id)),
    prefabLibraryUpdateCopy: async (ref, id) => prefabs.updateCopy(ref, openFiles(id)),
    prefabUserLibrary: () => (userPrefabs === null ? 'unavailable' : wallet() === null ? 'guest' : 'on'),
    ...(userPrefabs === null
      ? {}
      : {
          prefabLibraryCopyOut: async (id: string, folder: string) => {
            if (wallet() === null) throw new Error(SIGN_IN_FOR_LIBRARY)
            return userPrefabs.copyOut(openFiles(id), folder)
          },
          prefabLibraryDelete: async (ref: string) => {
            const parsed = parseRef(ref)
            return parsed?.scope === 'user' && wallet() !== null ? userPrefabs.remove(parsed.name) : false
          }
        })
  }

  // The packages no project's lock names any more: only looked for when projects
  // were purged, which is the one time a package can lose its last project.
  async function prunePackages(): Promise<void> {
    const wanted = new Set<string>()
    for (const record of [...(await store.list()), ...(await store.trashed())]) {
      const lock = parseLock(await readFile(record.id, LOCK_FILE).catch(() => undefined))
      for (const key of Object.keys(lock?.packages ?? {})) wanted.add(key)
      for (const [name, ref] of Object.entries(lock?.dependencies ?? {})) wanted.add(lockedKey(name, ref))
    }
    for (const key of await store.packages.keys()) if (!wanted.has(key)) await store.packages.remove(key)
  }

  // what left the trash a month ago goes for good, with the preview it left behind
  void store
    .purge(Date.now() - TRASH_KEPT_MS)
    .then(async (purged) => {
      const cache = await caches.open(PREVIEW_CACHE_NAME)
      const realms = purged.map(({ id, previewId }) => previews.realmUrl(previewId ?? id))
      for (const request of await cache.keys()) {
        if (realms.some((realm) => request.url.startsWith(realm))) await cache.delete(request)
      }
      const storage = await caches.open(PREVIEW_STORAGE_CACHE_NAME)
      for (const realm of realms) await storage.delete(`${realm}__storage`)
      if (purged.length > 0) await prunePackages()
    })
    .catch((error: unknown) => console.warn('[editor] could not empty the trash', error))

  return {
    shell,
    projects,
    dataLayer,
    dispose: () => {
      phone.dispose()
      assistant.dispose()
      generation++
      leave()
      previews.dispose()
      clearInterval(accountPoll)
      document.removeEventListener('visibilitychange', onHidden)
      // what is still waiting is sent before the engine stops listening
      void sync.flush().finally(() => sync.dispose())
    }
  }
}
