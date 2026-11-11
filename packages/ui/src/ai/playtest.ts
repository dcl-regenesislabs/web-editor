import { object } from '@dcl-editor/contract'
import { state } from '@scene/state'
import { syncFrozenState, writeCustomComponent } from '@scene/inspector'
import { uiPlay } from '../actions/playback'
import { restartScene } from '../boot/boot'
import { consoleCommand, getEngineWindow } from '../engine/console'
import { cmd } from '../engine/cmd'
import { hostV1 } from '../engine/hosted'
import { errorLines, isServerError } from '../features/editor/log-roles'
import { worldTransformOf } from '@scene/world-pos'
import { bounded, gameView, holds, mergeRequests, parseProbe, statePath, stateChanges, type ProbeAnswer, type ProbeRequest, type StateCondition } from './game-probe'
import { resolveEntityRef } from './request-format'
import { captureView, viewRequest } from './view'

const WAIT_FOR_TEXT_MS = 15_000
const SETTLE_MS = 300
const MAX_STEPS = 20
const STEPS_MS = 180_000
const WAIT_FOR_STATE_MS = 10_000
const MAX_WAIT_FOR_MS = 60_000
const STATE_POLL_MS = 250
const WALK_TO_ENTITY_MS = 10_000
const MAX_WALK_MS = 20_000
const ARRIVE_WITHIN_M = 1.5
// how long after a press the HUD is watched for the game's own answer to it
const FEEDBACK_MS = 1000
const PROBE = 'editor::GameProbe'
// The editor's write reaches the scene's tick 3–6 s later in the web editor (measured on a test run, where
// every answer arrived after a 1.5 s wait had given up). A scene that never answers (no game module, or a runtime
// copy from before the probe) costs this once per run, then only a short look; one that answered once is waited
// for in full every time.
const PROBE_WAIT_MS = 8000
const SILENT_PROBE_WAIT_MS = 150
const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  E: { key: 'e', code: 'KeyE', keyCode: 69 }, F: { key: 'f', code: 'KeyF', keyCode: 70 }
}

// The explorer's /mobile_ui: the host makes the canvas phone-shaped (1600x720) and a scene
// started under it is told it runs on a phone and gets the mobile interactable area.
let platform: 'desktop' | 'mobile' = 'desktop'

// The web editor's host shapes the canvas itself when /mobile_ui passes through it; the desktop
// page owns its engine frame, so it letterboxes the canvas the same way here.
const PHONE_CANVAS = { width: 'min(100vw, calc(100vh * 20 / 9))', height: 'min(100vh, calc(100vw * 9 / 20))', position: 'absolute', inset: '0', margin: 'auto' }
const FULL_CANVAS = { width: '100%', height: '100%', position: '', inset: '', margin: '' }

function phoneCanvas(on: boolean): void {
  if (hostV1() !== null) return
  const target = getEngineWindow().document.getElementById('mygame-canvas')
  if (target !== null) Object.assign(target.style, on ? PHONE_CANVAS : FULL_CANVAS)
}

async function usePlatform(next: 'desktop' | 'mobile'): Promise<void> {
  if (next === platform) return
  await consoleCommand('mobile_ui', [next === 'mobile' ? 'on' : 'off'])
  phoneCanvas(next === 'mobile')
  platform = next
}

// the seq starts away from 0 so a line an earlier editor session left in the log ring never matches
let probeSeq = 1 + Math.floor(Math.random() * 1_000_000)
let lastGame: ProbeAnswer | null = null
let gameSilent = false
let gameAnswered = false

async function probeGame(signal: AbortSignal): Promise<ProbeAnswer | null> {
  if (state.frozen) return null
  const seq = ++probeSeq
  await writeCustomComponent('0', PROBE, { seq })
  const until = Date.now() + (gameSilent ? SILENT_PROBE_WAIT_MS : PROBE_WAIT_MS)
  for (;;) {
    const answer = parseProbe(await cmd.sceneLogs(100), seq)
    if (answer !== null) {
      gameSilent = false
      gameAnswered = true
      return answer
    }
    if (Date.now() > until) {
      gameSilent = !gameAnswered
      return null
    }
    await wait(50, signal)
  }
}

export function playtestPlatform(): 'desktop' | 'mobile' {
  return platform
}

// a turn that ended on the phone leaves the creator's scene as it was before: desktop, editing
export async function leavePhone(): Promise<void> {
  if (platform === 'desktop') return
  await usePlatform('desktop')
  await restartScene()
}

function playerPosition(value: string): { x: number; y: number; z: number } | null {
  const match = /\(\s*([-\d.e+]+),\s*([-\d.e+]+),\s*([-\d.e+]+)\s*\)/i.exec(value)
  if (match === null) return null
  const [x, y, z] = match.slice(1).map(Number)
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null
}

function duration(value: unknown, fallback: number, max = 5000, name = 'durationMs'): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error(`${name} must be between 0 and ${max}.`)
  return value
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    signal.throwIfAborted()
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, until - Date.now())))
  }
  signal.throwIfAborted()
}

function canvas(): HTMLCanvasElement {
  const target = getEngineWindow().document.querySelector('canvas')
  if (target === null) throw new Error('The engine canvas is not available for playtesting.')
  target.focus()
  return target
}

function hudTexts(snapshot: Record<string, Record<string, unknown>>): string[] {
  return [...new Set(Object.values(snapshot).flatMap((components) => {
    const text = components.UiText
    return object(text) && typeof text.value === 'string' ? [text.value] : []
  }))]
}

// a press that must land inside a short window (a bite, a prompt): it waits for the text itself
async function untilText(text: string, signal: AbortSignal, ms = WAIT_FOR_TEXT_MS): Promise<void> {
  const until = Date.now() + ms
  while (!hudTexts(await cmd.crdtSnapshot()).some((value) => value.includes(text))) {
    if (Date.now() > until) throw new Error(`"${text}" did not appear on the HUD within ${ms / 1000} s.`)
    await wait(30, signal)
  }
}

// When the game answered a press on screen, before any server reply: the first HUD change after it.
async function watchHud(press: () => Promise<void>, signal: AbortSignal): Promise<{ hudChangedAfterMs: number | null }> {
  const before = JSON.stringify(hudTexts(await cmd.crdtSnapshot()))
  const started = Date.now()
  let pressed = false
  let changed: number | null = null
  const watching = (async () => {
    while (changed === null && !(pressed && Date.now() - started >= FEEDBACK_MS)) {
      if (JSON.stringify(hudTexts(await cmd.crdtSnapshot())) !== before) changed = Date.now() - started
      else await wait(50, signal)
    }
  })()
  try {
    await press()
  } finally {
    pressed = true
    await watching.catch((e: unknown) => { if (!signal.aborted) throw e })
  }
  return { hudChangedAfterMs: changed }
}

// A player action, checked before the game state is read so a bad request costs no probe. A press
// with waitFor is read before its wait: reading after it would land the press late in a short window.
// budgetMs is what is left of a steps run; detail is what a step reports beyond the game state.
interface PlayerAction { run: (budgetMs: number) => Promise<Record<string, unknown>> }

async function pressing(press: () => Promise<void>, measure: boolean, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (measure) return watchHud(press, signal)
  await press()
  return {}
}

function inputAction(keys: unknown, ms: number, waitFor: unknown, signal: AbortSignal, measure: boolean): PlayerAction {
  if (!Array.isArray(keys) || keys.length > 2 || keys.some((key) => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(KEYS, key))) {
    throw new Error('input presses the interaction keys E or F. Move the player with walk.')
  }
  if (waitFor !== undefined && (typeof waitFor !== 'string' || waitFor.trim() === '')) throw new Error('waitFor must be HUD text to wait for.')
  const held = [...new Set(keys as string[])]
  return {
    run: async (budgetMs) => {
      if (typeof waitFor === 'string') await untilText(waitFor, signal, Math.min(WAIT_FOR_TEXT_MS, budgetMs))
      const target = canvas()
      return pressing(async () => {
        try {
          for (const key of held) target.dispatchEvent(new KeyboardEvent('keydown', { ...KEYS[key], bubbles: true }))
          await wait(ms, signal)
        } finally {
          for (const key of held) target.dispatchEvent(new KeyboardEvent('keyup', { ...KEYS[key], bubbles: true }))
        }
      }, measure, signal)
    }
  }
}

function walkAction(to: unknown): PlayerAction {
  if (!object(to) || ![to.x, to.y, to.z].every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('walk requires a finite to: {x, y, z} in world metres, or entity: a name from the scene outline.')
  return {
    run: async () => {
      await consoleCommand('walk_player_to', [String(to.x), String(to.y), String(to.z), '5']).catch(async () => {
        const at = await consoleCommand('player_position').catch(() => 'unknown')
        throw new Error(`The walk stopped before ${to.x} ${to.y} ${to.z}: something blocks the way or the target is higher than a step. The player is at ${at}. Walk around it in shorter legs; a route that needs a jump is for the creator to try.`)
      })
      return {}
    }
  }
}

function entityPosition(id: string, name: string): { x: number; y: number; z: number } {
  const world = worldTransformOf(state.snapshot, id)
  if (world === null) throw new Error(`Where "${name}" stands in the world is not known yet: walk to its coordinates from the scene outline instead.`)
  return { x: world.position.x, y: world.position.y, z: world.position.z }
}

function metres(value: number): number {
  return Math.round(value * 100) / 100
}

// Straight at the entity, stopping short of it so its collider does not end the walk, then
// judged by how far from it the player actually stands.
function walkToEntity(name: string, within: number, ms: number): PlayerAction {
  const id = resolveEntityRef(state.snapshot, name)
  if (id === null) throw new Error(`No entity is named "${name}": use a name from the scene outline.`)
  return {
    run: async (budgetMs) => {
      const goal = entityPosition(id, name)
      const from = playerPosition(await consoleCommand('player_position'))
      if (from === null) throw new Error('The player position is not available.')
      const gap = Math.hypot(goal.x - from.x, goal.z - from.z)
      let walked = true
      if (gap > within) {
        const short = (within * 0.6) / gap
        const target = { x: goal.x - (goal.x - from.x) * short, y: from.y, z: goal.z - (goal.z - from.z) * short }
        const seconds = Math.max(1, Math.min(ms, budgetMs) / 1000)
        // a walk that ends against the entity's own collider fails yet arrives: the distance decides
        walked = await consoleCommand('walk_player_to', [String(metres(target.x)), String(metres(target.y)), String(metres(target.z)), String(seconds)]).then(() => true, () => false)
      }
      const end = playerPosition(await consoleCommand('player_position'))
      if (end === null) throw new Error('The player position is not available.')
      const distance = metres(Math.hypot(goal.x - end.x, goal.z - end.z))
      if (distance > within) {
        const why = walked ? 'the walk ended short of it' : 'something blocks the straight line or the walk timed out'
        throw new Error(`The walk to "${name}" stopped ${distance} m from it, at ${metres(end.x)} ${metres(end.y)} ${metres(end.z)}: ${why}. Walk around it in shorter legs to coordinates first.`)
      }
      return { entity: name, distance }
    }
  }
}

function clickAction(x: unknown, y: unknown, signal: AbortSignal, measure: boolean): PlayerAction {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error('click x and y must be fractions of the viewport from 0 to 1.')
  return {
    run: async () => {
      const target = canvas()
      const rect = target.getBoundingClientRect()
      // Bevy reads synthetic pointer events in device pixels, whatever the canvas renders at: the
      // editor's lower 3D resolution shrinks target.width, and a click scaled by it misses.
      const scale = getEngineWindow().devicePixelRatio
      const point = { clientX: (rect.left + x * rect.width) * scale, clientY: (rect.top + y * rect.height) * scale, bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true }
      target.dispatchEvent(new PointerEvent('pointermove', point))
      return pressing(async () => {
        try {
          target.dispatchEvent(new PointerEvent('pointerdown', { ...point, button: 0, buttons: 1 }))
          await wait(100, signal)
        } finally {
          target.dispatchEvent(new PointerEvent('pointerup', { ...point, button: 0, buttons: 0 }))
        }
      }, measure, signal)
    }
  }
}

function playerAction(request: Record<string, unknown>, signal: AbortSignal, measure = false): PlayerAction {
  switch (request.action) {
    case 'input': return inputAction(request.keys, duration(request.durationMs, 300), request.waitFor, signal, measure)
    case 'wait': {
      const ms = duration(request.durationMs, 1000)
      return { run: async () => { await wait(ms, signal); return {} } }
    }
    case 'walk': {
      if (request.entity === undefined) return walkAction(request.to)
      if (typeof request.entity !== 'string' || request.entity.trim() === '') throw new Error('walk entity is the name of an entity in the scene.')
      if (request.to !== undefined) throw new Error('walk takes to or entity, not both.')
      const within = duration(request.within, ARRIVE_WITHIN_M, 10, 'within')
      if (within < 0.5) throw new Error('within must be at least 0.5 m.')
      return walkToEntity(request.entity, within, duration(request.timeoutMs, WALK_TO_ENTITY_MS, MAX_WALK_MS, 'timeoutMs'))
    }
    case 'click': return clickAction(request.x, request.y, signal, measure)
    default: throw new Error('Unknown playtest action.')
  }
}

const NO_GAME = 'No game state: the scene did not answer the probe. It does not use the game module, or its runtime copy predates the probe (reopen the project to refresh it).'
const LATE_GAME = 'No game state this time: the game answered earlier in this run but not within 8 s now, so this result says nothing about what changed. Run status to read it again.'

async function observed(): Promise<{ position: unknown; hud: string[]; errors: string[]; serverErrors: string[] }> {
  const [position, snapshot, logs] = await Promise.all([consoleCommand('player_position'), cmd.crdtSnapshot(), cmd.sceneLogs(100)])
  return {
    position: playerPosition(position),
    hud: hudTexts(snapshot).slice(0, 80),
    errors: errorLines(logs).slice(-20),
    serverErrors: hostV1()?.previewServerLogs?.(0).filter(isServerError).slice(-20).map((line) => line.msg) ?? []
  }
}

async function status(signal: AbortSignal, before: ProbeAnswer | null, since: string): Promise<unknown> {
  const answer = await probeGame(signal)
  const { position, hud, errors, serverErrors } = await observed()
  if (answer !== null) lastGame = answer
  return {
    playing: !state.frozen,
    platform,
    position,
    hud,
    ...(state.frozen ? {} : { game: answer === null ? (gameAnswered ? LATE_GAME : NO_GAME) : gameView(answer, before, since) }),
    errors,
    serverErrors
  }
}

function forget(): void {
  lastGame = null
  gameSilent = false
  gameAnswered = false
}

function platformOf(value: unknown): 'desktop' | 'mobile' {
  if (value !== undefined && value !== 'desktop' && value !== 'mobile') throw new Error('platform is desktop or mobile.')
  return value === 'mobile' ? 'mobile' : 'desktop'
}

async function startPlay(on: 'desktop' | 'mobile', signal: AbortSignal): Promise<void> {
  forget()
  await usePlatform(on)
  await restartScene()
  signal.throwIfAborted()
  await uiPlay()
  await syncFrozenState()
  if (state.frozen) throw new Error(`Play did not start: ${state.saveStatus}`)
  await wait(1200, signal)
}

async function stopPlay(): Promise<void> {
  forget()
  await usePlatform('desktop')
  await restartScene()
}

// ---- steps: one call runs a chain of actions and reports the game across all of it ----

interface Steps {
  /** the game's answer the next step's changes are measured from */
  last: ProbeAnswer | null
  /** an answer a step read itself, which stands for the read after it */
  fresh: ProbeAnswer | null
  deadline: number
  record: (answer: ProbeAnswer) => void
}

interface Step {
  action: string
  observe: boolean
  run: (steps: Steps) => Promise<Record<string, unknown>>
}

function needPlay(): void {
  if (state.frozen) throw new Error('Start playtesting before sending player input: make start the first step.')
}

function condition(raw: Record<string, unknown>): StateCondition {
  const given = ['equals', 'changes', 'exists'].filter((key) => raw[key] !== undefined)
  if (given.length !== 1) throw new Error('waitFor with a path takes exactly one of equals, changes: true or exists.')
  if (raw.equals !== undefined) return { equals: raw.equals }
  if (raw.changes !== undefined) {
    if (raw.changes !== true) throw new Error('changes is true.')
    return { changes: true }
  }
  if (typeof raw.exists !== 'boolean') throw new Error('exists is true or false.')
  return { exists: raw.exists }
}

function said(want: StateCondition): string {
  if ('equals' in want) return `become ${JSON.stringify(want.equals)}`
  if ('changes' in want) return 'change'
  return want.exists ? 'appear' : 'go away'
}

function shown(value: unknown): string {
  return value === undefined ? 'not there' : JSON.stringify(bounded(value).value)
}

// Read the game until the condition holds: the state as this client sees it, polled, never a fixed sleep.
async function untilState(path: string, want: StateCondition, ms: number, steps: Steps, signal: AbortSignal): Promise<Record<string, unknown>> {
  const started = Date.now()
  let start = steps.last === null ? undefined : statePath(steps.last.state, path)
  let baseline = steps.last !== null
  let value: unknown
  for (;;) {
    const answer = await probeGame(signal)
    if (answer !== null) {
      steps.record(answer)
      value = statePath(answer.state, path)
      if (!baseline && 'changes' in want) start = value
      else if (holds(want, value, start)) return { path, value: bounded(value).value, waitedMs: Date.now() - started }
      baseline = true
    } else if (!gameAnswered) {
      throw new Error(`waitFor reads game.state, and there is none. ${NO_GAME} Wait for HUD text with hud instead.`)
    }
    if (Date.now() - started >= ms) throw new Error(`game.state.${path} did not ${said(want)} within ${ms / 1000} s: it is ${shown(value)}.`)
    await wait(STATE_POLL_MS, signal)
  }
}

function waitForStep(raw: Record<string, unknown>, observe: boolean, signal: AbortSignal): Step {
  const timeout = duration(raw.timeoutMs, WAIT_FOR_STATE_MS, MAX_WAIT_FOR_MS, 'timeoutMs')
  const { hud, path } = raw
  if (hud !== undefined) {
    if (typeof hud !== 'string' || hud.trim() === '') throw new Error('waitFor hud is the HUD text to wait for.')
    if (path !== undefined) throw new Error('waitFor takes hud or path, not both.')
    return {
      action: 'waitFor', observe,
      run: async (steps) => {
        needPlay()
        const started = Date.now()
        await untilText(hud, signal, Math.min(timeout, steps.deadline - started))
        return { hud, waitedMs: Date.now() - started }
      }
    }
  }
  if (typeof path !== 'string' || path.trim() === '') throw new Error('waitFor needs path (a game.state path such as score or boards.0.item) or hud (text on the HUD).')
  const want = condition(raw)
  return {
    action: 'waitFor', observe: true,
    run: (steps) => {
      needPlay()
      return untilState(path, want, Math.min(timeout, steps.deadline - Date.now()), steps, signal)
    }
  }
}

function step(raw: unknown, index: number, count: number, signal: AbortSignal): Step {
  if (!object(raw) || typeof raw.action !== 'string') throw new Error('each step is an object with an action.')
  if (raw.observe !== undefined && typeof raw.observe !== 'boolean') throw new Error('observe is true or false.')
  const observe = raw.observe !== false
  const action = raw.action
  switch (action) {
    case 'start': {
      if (index !== 0) throw new Error('start can only be the first step.')
      const on = platformOf(raw.platform)
      return { action, observe: true, run: async () => { await startPlay(on, signal); return {} } }
    }
    case 'stop':
      if (index !== count - 1) throw new Error('stop can only be the last step.')
      return { action, observe: false, run: async () => { await stopPlay(); return {} } }
    case 'waitFor': return waitForStep(raw, observe, signal)
    case 'status': case 'steps': throw new Error(`${action} is not a step: every step reports the game already.`)
    default: {
      const act = playerAction(raw, signal, true)
      return {
        action, observe,
        run: async (steps) => {
          needPlay()
          const detail = await act.run(steps.deadline - Date.now())
          await wait(SETTLE_MS, signal)
          return detail
        }
      }
    }
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function made(requests: ProbeRequest[], since: ProbeAnswer): Array<Record<string, unknown>> {
  return requests.filter((request) => request.at > since.now)
    .map((request) => ({ name: request.name, ...(request.refused !== undefined ? { refused: request.refused } : { reply: request.reply ?? null }) }))
}

async function runSteps(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const list = request.steps
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_STEPS) throw new Error(`steps is a list of 1 to ${MAX_STEPS} actions.`)
  if (request.view !== undefined && typeof request.view !== 'boolean') throw new Error('view is true or false.')
  // the whole chain is checked before anything runs, so a typo in step 6 costs no play
  const chain = list.map((raw: unknown, i) => {
    try {
      return step(raw, i, list.length, signal)
    } catch (e) {
      throw new Error(`Step ${i + 1}: ${message(e)}`)
    }
  })
  if (chain[0].action !== 'start') needPlay()
  let requests: ProbeRequest[] = []
  const steps: Steps = {
    last: null, fresh: null, deadline: Date.now() + STEPS_MS,
    record: (answer) => {
      steps.fresh = answer
      requests = mergeRequests(requests, answer.requests)
    }
  }
  let first: ProbeAnswer | null = null
  if (chain[0].action !== 'start') {
    first = await probeGame(signal)
    if (first !== null) steps.record(first)
    steps.last = first
    steps.fresh = null
  }
  const outcomes: Array<Record<string, unknown>> = []
  let failed: { step: number; error: string } | null = null
  for (const [i, current] of chain.entries()) {
    const started = Date.now()
    const outcome: Record<string, unknown> = { step: i + 1, action: current.action }
    outcomes.push(outcome)
    try {
      if (started > steps.deadline) throw new Error(`The steps used their ${STEPS_MS / 1000} s before this one ran.`)
      Object.assign(outcome, { ok: true }, await current.run(steps))
    } catch (e) {
      if (signal.aborted) throw e
      failed = { step: i + 1, error: message(e) }
      Object.assign(outcome, { ok: false, error: failed.error })
    }
    outcome.ms = Date.now() - started
    if (current.observe || failed !== null) {
      const after = steps.fresh ?? (state.frozen ? null : await probeGame(signal))
      steps.fresh = null
      if (after !== null) {
        requests = mergeRequests(requests, after.requests)
        if (steps.last !== null) {
          outcome.changed = stateChanges(steps.last.state, after.state)
          const asked = made(after.requests, steps.last)
          if (asked.length > 0) outcome.requests = asked
        }
        steps.last = after
        first ??= after
      } else if (!state.frozen && gameAnswered) {
        outcome.game = 'The game did not answer after this step: its changes show in the next one.'
      }
    }
    if (failed !== null) break
  }
  const final = steps.last
  if (final !== null) lastGame = final
  const game = final === null ? (gameAnswered ? LATE_GAME : NO_GAME)
    : gameView({ ...final, requests }, first === final ? null : first, 'before the first step')
  let picture: Record<string, unknown> = {}
  if (request.view === true) {
    try {
      picture = { view: await captureView(viewRequest({}), signal) }
    } catch (e) {
      if (signal.aborted) throw e
      picture = { viewError: message(e) }
    }
  }
  return {
    ok: failed === null,
    ...(failed === null ? {} : { failedStep: failed.step, error: failed.error, skipped: chain.length - failed.step }),
    steps: outcomes,
    playing: !state.frozen,
    platform,
    ...(await observed()),
    game,
    ...picture
  }
}

export async function playtest(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  const action = request.action
  if (action === 'steps') return runSteps(request, signal)
  let before = action === 'status' ? lastGame : null
  let since = 'the previous playtest result'
  if (action === 'start') {
    await startPlay(platformOf(request.platform), signal)
  } else if (action === 'stop') {
    await stopPlay()
  } else if (action !== 'status') {
    if (state.frozen) throw new Error('Start playtesting before sending player input.')
    const act = playerAction(request, signal)
    if (!gameSilent) before = await probeGame(signal)
    since = `before this ${String(action)}`
    await act.run(Infinity)
    await wait(SETTLE_MS, signal)
  }
  return status(signal, before, since)
}
