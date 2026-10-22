// Transport: play / pause / step, and the composite save that has to happen
// before the scene starts running.
import { state } from '@scene/state'
import { pauseScene, playScene, stepScene, saveCompositeDirect, reloadSnapshot } from '@scene/inspector'
import { type CameraMode } from '@scene/bridge-protocol'
import { cmd } from '../engine/cmd'
import { flushPendingSave } from '../core/autosave'
import { awaitFreshBundle, noteSceneUpToDate, sceneNeedsReload, wireSceneHealth } from '../features/editor/scene-health'
import { consumePlayOverride, playBlockingFindings, revealSceneChecks } from '../features/editor/scene-checks'
import { refreshAuthoredIds } from '../panels/authored-ids'
import { autoHideSceneUi, releaseAutoHiddenSceneUi } from '../engine/scene-ui'
import { trackCreator } from '../analytics'
import { log } from '../log'
import { run } from './run'
import { uiSetCamera } from './selection'

// The editor camera active when Play was pressed, restored on Pause. Play hands
// control to the player camera: the pointer ray is cast from the ACTIVE camera
// and scene interactions default to a 10m camera-distance rule, so running the
// scene from a fly/orbit camera leaves every clickable out of range (and the
// avatar input-locked) — nothing like the real preview.
let prePlayCam: CameraMode | null = null

// One transport change at a time: a second press while Play is still saving and
// rebuilding reads the scene as stopped and would start it again. A start can
// hang (a save, a reload, an engine command that never answers), so the lock
// lapses after a rebuild's worst case and Stop always takes over.
const TRANSITION_DEADLINE_MS = 45_000
let transition: { done: Promise<void>; since: number } | null = null
let generation = 0
function exclusive(task: (gen: number) => Promise<void>): Promise<void> {
  if (transition !== null && Date.now() - transition.since < TRANSITION_DEADLINE_MS) return transition.done
  const gen = ++generation
  const done: Promise<void> = task(gen).finally(() => {
    if (transition?.done === done) transition = null
  })
  transition = { done, since: Date.now() }
  return done
}
const superseded = (gen: number): boolean => gen !== generation

export const uiPause = (): Promise<void> => {
  transition = null
  return exclusive(pause)
}

async function pause(): Promise<void> {
  const wasPlaying = !state.frozen
  await run(pauseScene(), false)
  if (wasPlaying && state.frozen) {
    trackCreator('play_stopped')
    await reloadSnapshot()
  }
  autoHideSceneUi() // back to editing: the HUD stops being the game again
  if (prePlayCam !== null) {
    uiSetCamera(prePlayCam)
    prePlayCam = null
  }
}

// how long a freshly reloaded scene gets to spawn before Play unfreezes it
const RELOAD_SETTLE_MS = 2_100

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// held on screen until the rebuild ends: a press during it would otherwise look ignored
export const REBUILDING_FOR_PLAY = 'rebuilding the scene before play…'

// Play must never resume a scene instance older than the code it is about to run.
// Unfreezing only continues the instance the engine already has, and a script
// attached (or edited) since that instance loaded was never instantiated, so it
// silently does nothing.
//
// But only reload when something actually needs it. A nudged gizmo rewrites
// main.composite and rebuilds the bundle too, and its value is already in the
// running scene's CRDT — reloading for that would cost a respawn to show what is
// on screen already. sceneNeedsReload() is the whole decision.
async function waitForFreshBuild(): Promise<void> {
  wireSceneHealth()
  if (!sceneNeedsReload()) return
  state.saveStatus = REBUILDING_FOR_PLAY
  await awaitFreshBundle()
  // by id: a bare /reload respawns every scene, the editor's and a host page's included
  const hash = state.scene?.hash
  if (hash !== undefined) await cmd.reload(hash).then(noteSceneUpToDate).catch((e) => log.warn('reload before play failed', e))
  // give the fresh instance a beat to spawn; playScene re-pins if the old one died
  await sleep(RELOAD_SETTLE_MS)
  state.saveStatus = ''
}

export const uiPlay = (): Promise<void> => exclusive((gen) => play(gen))

export const uiTogglePlay = (): Promise<void> => (state.frozen ? uiPlay() : uiPause())

async function play(gen: number): Promise<void> {
  // persist edit-mode changes before the scene starts running — once playing,
  // edits become runtime-only (not saved), so this is the last authored save
  await flushPendingSave()
  if (superseded(gen)) return
  // Authoring problems the scene cannot run through. The card's "Play anyway"
  // waves exactly one press past this, so a wrong rule never traps a creator.
  const blocking = playBlockingFindings()
  if (blocking.length > 0 && !consumePlayOverride()) {
    revealSceneChecks()
    state.saveStatus = `Play is blocked — ${blocking[0].title}`
    return
  }
  await waitForFreshBuild()
  if (superseded(gen)) return
  if (state.camMode !== 'none') {
    prePlayCam = state.camMode === 'free' ? 'free' : 'target'
    uiSetCamera('off')
  } else {
    prePlayCam = null
  }
  // the scene's UI is the game once it runs — never preview it with the HUD blanked
  await releaseAutoHiddenSceneUi()
  await run(playScene(), false)
  if (!state.frozen) trackCreator('play_started', { forced: blocking.length > 0 })
}

export const uiStep = async (count = 1): Promise<void> => {
  await run(stepScene(count), false)
}

export const uiSave = async (): Promise<void> => {
  // failures land in state.saveStatus (shown as a toast)
  await run(saveCompositeDirect().catch(() => {}), false)
  // the composite just gained whatever was created this session — re-read the
  // authored set so those rows move out of "Made by your code"
  refreshAuthoredIds()
}
