// Collecting what the scene checks read: the authored snapshot, the project's
// prefab folders, its script texts and the Game Config component. The impure
// half of the registry — every rule stays a pure function because this module
// does the reading for all of them.
//
// Two rules govern when it runs:
//   * never while the scene is playing. The scene's own code spawns entities
//     then, and instance drift computed over those is a lie.
//   * file reads are cached. Autosave writes the composite constantly, and a
//     round trip per prefab folder per keystroke would be the most expensive
//     thing in the editor. The list of relevant files is the cheap change
//     detector; a TTL catches edits made to a file's contents.
import { isRuntimeEntity, provenanceBaseline, state } from '@scene/state'
import { isReservedEntity } from '@dcl-editor/contract'
import { dataLayerAvailable, dataLayerListFiles, dataLayerReadFile, dataLayerWriteTick } from '../../engine/datalayer'
import { authoredOnly } from '../../prefabs/capture'
import { prefabFoldersIn, readPrefabFolder } from '../../prefabs/storage'
import { findGameConfig } from '../../gameconfig/generate'
import { log } from '../../log'
import { sceneBudget, type SceneBudget } from '../../scene-budget'
import {
  runSceneChecks,
  sceneFindings,
  setSceneFindings,
  type SceneCheckContext,
  type SceneCheckPrefab,
  type SceneFinding
} from './scene-checks'

const CACHE_TTL_MS = 30_000
const DEBOUNCE_MS = 1_200
// carried copies of the runtime modules are vendored masters, not consumer code
const RUNTIME_DIR = '/runtime/'
const MAX_SCRIPTS = 400

// A script is a script whichever extension it carries: the Announcer ships as
// `.tsx`, and a `.ts`-only listing made every rule blind to it — including the
// one that accuses a scene of never answering a message it does answer.
const SCRIPT_EXT = /\.tsx?$/

export function isCheckedScript(path: string): boolean {
  if (!SCRIPT_EXT.test(path) || path.includes(RUNTIME_DIR)) return false
  return path.startsWith('src/') || path.startsWith('custom/')
}

interface ProjectRead {
  key: string
  prefabs: SceneCheckPrefab[]
  scripts: Record<string, string>
  thumbnailPath: string | null | undefined
}

async function readThumbnailPath(files: string[]): Promise<string | null | undefined> {
  try {
    const scene: unknown = JSON.parse(await dataLayerReadFile('scene.json'))
    const display = typeof scene === 'object' && scene !== null ? (scene as { display?: unknown }).display : undefined
    const path = typeof display === 'object' && display !== null ? (display as { navmapThumbnail?: unknown }).navmapThumbnail : undefined
    return typeof path === 'string' && files.includes(path) ? path : null
  } catch (e) {
    log.debug('scene checks: scene.json unreadable', e)
    return undefined
  }
}

let cached: ProjectRead | null = null
let cachedAt = 0

async function readProject(): Promise<ProjectRead> {
  const files = await dataLayerListFiles()
  const scriptPaths = files.filter(isCheckedScript).slice(0, MAX_SCRIPTS)
  // The write tick is part of the key: a `data.json` rewritten in place leaves
  // the file list identical, so without it a raised Max alive stayed invisible
  // for the whole TTL and Play kept refusing with the reason already fixed.
  const key = [...prefabFoldersIn(files), ...scriptPaths, `w${dataLayerWriteTick()}`].join('|')
  if (cached !== null && cached.key === key && Date.now() - cachedAt < CACHE_TTL_MS) return cached

  const prefabs: SceneCheckPrefab[] = []
  for (const folder of prefabFoldersIn(files)) {
    try {
      prefabs.push(await readPrefabFolder(folder))
    } catch (e) {
      log.debug('scene checks: prefab folder unreadable', folder, e)
    }
  }
  const scripts: Record<string, string> = {}
  for (const path of scriptPaths) {
    try {
      scripts[path] = await dataLayerReadFile(path)
    } catch (e) {
      log.debug('scene checks: script unreadable', path, e)
    }
  }
  cached = { key, prefabs, scripts, thumbnailPath: await readThumbnailPath(files) }
  cachedAt = Date.now()
  return cached
}

export function invalidateSceneCheckCache(): void {
  cached = null
}

// The model files it reads are cached per write, so counting on every check run is cheap. A count that
// fails costs only the budget finding, never the other checks.
async function readBudget(): Promise<SceneBudget | undefined> {
  try {
    return await sceneBudget()
  } catch (e) {
    log.warn('scene checks: budget uncountable', e)
    return undefined
  }
}

export async function collectSceneCheckContext(): Promise<SceneCheckContext | null> {
  if (dataLayerAvailable() !== true) return null
  const { prefabs, scripts, thumbnailPath } = await readProject()
  const budget = await readBudget()
  const baseline = provenanceBaseline()
  return {
    snapshot: authoredOnly(state.snapshot, (id) => !isReservedEntity(id) && isRuntimeEntity(id, baseline)),
    prefabs,
    scripts,
    gameConfig: findGameConfig(state.snapshot)?.value ?? null,
    parcels: state.scene?.parcels,
    thumbnailPath,
    budget
  }
}

export async function refreshSceneChecks(): Promise<SceneFinding[]> {
  // `frozen` is edit mode: while the scene runs, its own entities are in the
  // snapshot and half these rules would report them as the creator's work
  if (!state.frozen) return sceneFindings()
  try {
    const ctx = await collectSceneCheckContext()
    if (ctx === null) return sceneFindings()
    const findings = runSceneChecks(ctx)
    setSceneFindings(findings)
    return findings
  } catch (e) {
    log.warn('scene checks failed', e)
    return sceneFindings()
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
let running = false
let queued = false

// Trailing debounce with an in-flight guard: a burst of edits produces one run,
// and a run that lands mid-burst schedules exactly one more.
export function scheduleSceneChecks(): void {
  if (running) {
    queued = true
    return
  }
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    running = true
    void refreshSceneChecks().finally(() => {
      running = false
      if (!queued) return
      queued = false
      scheduleSceneChecks()
    })
  }, DEBOUNCE_MS)
}
