// After a build lands: run the new bundle once, the way Play would, and report what it printed.
// A bundle that compiles can still throw in main(); without this the assistant called it done.
import { state } from '@scene/state'
import { cmd } from '../engine/cmd'
import { hostV1 } from '../engine/hosted'
import { pauseScene, reloadSnapshot, syncFrozenState } from '@scene/inspector'
import { errorLines, isServerError } from '../features/editor/log-roles'
import { noteSceneUpToDate, sceneNeedsReload } from '../features/editor/scene-health'
import { flushPendingSave } from '../core/autosave'
import { log } from '../log'

// a reloaded scene spawns, runs main() and is frozen by the editor within this
const RUN_SETTLE_MS = 2_500
// the scene server restarts on the build and prints its startup within this
const SERVER_SETTLE_MS = 3_000

export interface BuildRun {
  // the scene was reloaded on the new bundle; false when nothing changed in it or it could not be
  reloaded: boolean
  // what the running scene's console flagged: the fresh instance's, or the current one's when nothing changed
  errors: string[]
  serverErrors: string[]
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// An edit still in the autosave's debounce is not in main.composite yet: a build that reads the
// project now compiles the scene without it, and the reload then drops it from the running scene.
export async function saveBeforeBuild(): Promise<void> {
  if (!(await flushPendingSave()).ok) {
    throw new Error('The scene could not be saved, so a build now would leave out the latest edits. Retry the build.')
  }
}

export async function runFreshBuild(): Promise<BuildRun> {
  const hash = state.scene?.hash
  const serverLogs = hostV1()?.previewServerLogs
  const serverSince = serverLogs === undefined ? 0 : (serverLogs(0).at(-1)?.seq ?? 0)
  let reloaded = false
  if (hash !== undefined && sceneNeedsReload() && state.frozen) {
    try {
      await cmd.reload(hash)
      noteSceneUpToDate()
      await sleep(RUN_SETTLE_MS)
      // the new instance is another scene to the inspector: pin it again, as Play does, and pull its state
      await cmd.setScene(hash)
      // a main() that threw never reached the editor's auto-freeze: back to edit mode either way
      await pauseScene()
      await syncFrozenState()
      await reloadSnapshot()
      reloaded = true
    } catch (e) {
      log.warn('could not run the fresh build', e)
    }
  }
  if (serverLogs !== undefined) await sleep(SERVER_SETTLE_MS)
  const errors = errorLines(await cmd.sceneLogs(300).catch(() => ''))
  const serverErrors = serverLogs === undefined ? [] : serverLogs(serverSince).filter(isServerError).map((line) => line.msg)
  return { reloaded, errors: errors.slice(0, 20), serverErrors: serverErrors.slice(0, 20) }
}
