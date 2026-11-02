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

// a reloaded scene spawns, runs main() and is frozen by the editor within this; a heavy one takes longer
const RUN_SETTLE_MS = 2_500
// the reloaded instance is asked for again until then: a scene with many models can take seconds to spawn
const REATTACH_TIMEOUT_MS = 15_000
const REATTACH_POLL_MS = 500
const PAUSE_ATTEMPTS = 5
// the scene server restarts on the build and prints its startup within this
const SERVER_SETTLE_MS = 3_000

export interface BuildRun {
  // the scene was reloaded on the new bundle; false when nothing changed in it or it could not be
  reloaded: boolean
  // why the new bundle did not run, when it should have
  reason?: string
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

// The new instance is another scene to the inspector: pin it again, as Play does. It answers
// "no scene matching" until it has spawned, so ask until it does or the deadline passes.
async function reattach(hash: string): Promise<void> {
  const deadline = Date.now() + REATTACH_TIMEOUT_MS
  for (;;) {
    try {
      await cmd.setScene(hash)
      return
    } catch (e) {
      if (Date.now() + REATTACH_POLL_MS > deadline) throw e
    }
    await sleep(REATTACH_POLL_MS)
  }
}

// freeze_scene can be refused for a moment right after the pin
async function pauseFresh(): Promise<boolean> {
  for (let i = 0; i < PAUSE_ATTEMPTS; i++) {
    if (await pauseScene()) return true
    await sleep(REATTACH_POLL_MS)
  }
  return false
}

export async function runFreshBuild(): Promise<BuildRun> {
  const hash = state.scene?.hash
  const serverLogs = hostV1()?.previewServerLogs
  const serverSince = serverLogs === undefined ? 0 : (serverLogs(0).at(-1)?.seq ?? 0)
  let reloaded = false
  let reason: string | undefined
  if (hash !== undefined && sceneNeedsReload() && !state.frozen) {
    reason = 'The scene is playing, so the new build was not loaded. Stop the playtest, then build again.'
  } else if (hash !== undefined && sceneNeedsReload()) {
    try {
      await cmd.reload(hash)
      noteSceneUpToDate()
      await sleep(RUN_SETTLE_MS)
      await reattach(hash)
      // a main() that threw never reached the editor's auto-freeze: back to edit mode either way
      const paused = await pauseFresh()
      await syncFrozenState()
      await reloadSnapshot()
      if (paused) reloaded = true
      else reason = 'The new build is running but the editor could not pause it. Run playtest stop before editing.'
    } catch (e) {
      log.warn('could not run the fresh build', e)
      reason = `The scene did not come back within ${Math.round((RUN_SETTLE_MS + REATTACH_TIMEOUT_MS) / 1000)} s of the reload ` +
        `(${e instanceof Error ? e.message : String(e)}). Run playtest stop to reattach the editor, then build again.`
    }
  }
  if (serverLogs !== undefined) await sleep(SERVER_SETTLE_MS)
  const errors = errorLines(await cmd.sceneLogs(300).catch(() => ''))
  const serverErrors = serverLogs === undefined ? [] : serverLogs(serverSince).filter(isServerError).map((line) => line.msg)
  return { reloaded, ...(reason === undefined ? {} : { reason }), errors: errors.slice(0, 20), serverErrors: serverErrors.slice(0, 20) }
}
