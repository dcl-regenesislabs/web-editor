import { object } from '@dcl-editor/contract'
import { state } from '@scene/state'
import { syncFrozenState, writeCustomComponent } from '@scene/inspector'
import { uiPlay } from '../actions/playback'
import { restartScene } from '../boot/boot'
import { consoleCommand, getEngineWindow } from '../engine/console'
import { cmd } from '../engine/cmd'
import { hostV1 } from '../engine/hosted'
import { errorLines, isServerError } from '../features/editor/log-roles'
import { gameView, parseProbe, type ProbeAnswer } from './game-probe'

const WAIT_FOR_TEXT_MS = 15_000
const PROBE = 'editor::GameProbe'
// a game scene answers on its next frame; one that never answers (no game module, or a runtime copy
// from before the probe) costs this once per run, then only a short look
const PROBE_WAIT_MS = 1500
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

async function probeGame(signal: AbortSignal): Promise<ProbeAnswer | null> {
  if (state.frozen) return null
  const seq = ++probeSeq
  await writeCustomComponent('0', PROBE, { seq })
  const until = Date.now() + (gameSilent ? SILENT_PROBE_WAIT_MS : PROBE_WAIT_MS)
  for (;;) {
    const answer = parseProbe(await cmd.sceneLogs(100), seq)
    if (answer !== null) {
      gameSilent = false
      return answer
    }
    if (Date.now() > until) {
      gameSilent = true
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

function duration(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 5000) throw new Error('durationMs must be between 0 and 5000.')
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
async function untilText(text: string, signal: AbortSignal): Promise<void> {
  const until = Date.now() + WAIT_FOR_TEXT_MS
  while (!hudTexts(await cmd.crdtSnapshot()).some((value) => value.includes(text))) {
    if (Date.now() > until) throw new Error(`"${text}" did not appear on the HUD within ${WAIT_FOR_TEXT_MS / 1000} s.`)
    await wait(30, signal)
  }
}

// A player action, checked before the game state is read so a bad request costs no probe. A press
// with waitFor is read before its wait: reading after it would land the press late in a short window.
interface PlayerAction { run: () => Promise<void> }

function inputAction(keys: unknown, ms: number, waitFor: unknown, signal: AbortSignal): PlayerAction {
  if (!Array.isArray(keys) || keys.length > 2 || keys.some((key) => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(KEYS, key))) {
    throw new Error('input presses the interaction keys E or F. Move the player with walk.')
  }
  if (waitFor !== undefined && (typeof waitFor !== 'string' || waitFor.trim() === '')) throw new Error('waitFor must be HUD text to wait for.')
  const held = [...new Set(keys as string[])]
  return {
    run: async () => {
      if (typeof waitFor === 'string') await untilText(waitFor, signal)
      const target = canvas()
      try {
        for (const key of held) target.dispatchEvent(new KeyboardEvent('keydown', { ...KEYS[key], bubbles: true }))
        await wait(ms, signal)
      } finally {
        for (const key of held) target.dispatchEvent(new KeyboardEvent('keyup', { ...KEYS[key], bubbles: true }))
      }
    }
  }
}

function walkAction(to: unknown): PlayerAction {
  if (!object(to) || ![to.x, to.y, to.z].every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('walk requires a finite to: {x, y, z} in world metres.')
  return {
    run: async () => {
      await consoleCommand('walk_player_to', [String(to.x), String(to.y), String(to.z), '5']).catch(async () => {
        const at = await consoleCommand('player_position').catch(() => 'unknown')
        throw new Error(`The walk stopped before ${to.x} ${to.y} ${to.z}: something blocks the way or the target is higher than a step. The player is at ${at}. Walk around it in shorter legs; a route that needs a jump is for the creator to try.`)
      })
    }
  }
}

function clickAction(x: unknown, y: unknown, signal: AbortSignal): PlayerAction {
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
      try {
        target.dispatchEvent(new PointerEvent('pointerdown', { ...point, button: 0, buttons: 1 }))
        await wait(100, signal)
      } finally {
        target.dispatchEvent(new PointerEvent('pointerup', { ...point, button: 0, buttons: 0 }))
      }
    }
  }
}

function playerAction(request: Record<string, unknown>, signal: AbortSignal): PlayerAction {
  switch (request.action) {
    case 'input': return inputAction(request.keys, duration(request.durationMs, 300), request.waitFor, signal)
    case 'wait': {
      const ms = duration(request.durationMs, 1000)
      return { run: () => wait(ms, signal) }
    }
    case 'walk': return walkAction(request.to)
    case 'click': return clickAction(request.x, request.y, signal)
    default: throw new Error('Unknown playtest action.')
  }
}

const NO_GAME = 'No game state: the scene did not answer the probe. It does not use the game module, or its runtime copy predates the probe (reopen the project to refresh it).'

async function status(signal: AbortSignal, before: ProbeAnswer | null, since: string): Promise<unknown> {
  const answer = await probeGame(signal)
  const [position, snapshot, logs] = await Promise.all([consoleCommand('player_position'), cmd.crdtSnapshot(), cmd.sceneLogs(100)])
  const hud = hudTexts(snapshot).slice(0, 80)
  if (answer !== null) lastGame = answer
  return {
    playing: !state.frozen,
    platform,
    position: playerPosition(position),
    hud,
    ...(state.frozen ? {} : { game: answer === null ? NO_GAME : gameView(answer, before, since) }),
    errors: errorLines(logs).slice(-20),
    serverErrors: hostV1()?.previewServerLogs?.(0).filter(isServerError).slice(-20).map((line) => line.msg) ?? []
  }
}

export async function playtest(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  const action = request.action
  let before = action === 'status' ? lastGame : null
  let since = 'the previous playtest result'
  if (action === 'start' || action === 'stop') {
    lastGame = null
    gameSilent = false
  }
  if (action === 'start') {
    if (request.platform !== undefined && request.platform !== 'desktop' && request.platform !== 'mobile') throw new Error('platform is desktop or mobile.')
    await usePlatform(request.platform === 'mobile' ? 'mobile' : 'desktop')
    await restartScene()
    signal.throwIfAborted()
    await uiPlay()
    await syncFrozenState()
    if (state.frozen) throw new Error(`Play did not start: ${state.saveStatus}`)
    await wait(1200, signal)
  } else if (action === 'stop') {
    await usePlatform('desktop')
    await restartScene()
  } else if (action !== 'status') {
    if (state.frozen) throw new Error('Start playtesting before sending player input.')
    const act = playerAction(request, signal)
    if (!gameSilent) before = await probeGame(signal)
    since = `before this ${String(action)}`
    await act.run()
    await wait(300, signal)
  }
  return status(signal, before, since)
}
