import { object } from '@dcl-editor/contract'
import { state } from '@scene/state'
import { syncFrozenState } from '@scene/inspector'
import { uiPlay } from '../actions/playback'
import { restartScene } from '../boot/boot'
import { consoleCommand, getEngineWindow } from '../engine/console'
import { cmd } from '../engine/cmd'
import { hostV1 } from '../engine/hosted'
import { errorLines, isServerError } from '../features/editor/log-roles'

const WAIT_FOR_TEXT_MS = 15_000
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

async function input(keys: unknown, ms: number, waitFor: unknown, signal: AbortSignal): Promise<void> {
  if (!Array.isArray(keys) || keys.length > 2 || keys.some((key) => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(KEYS, key))) {
    throw new Error('input presses the interaction keys E or F. Move the player with walk.')
  }
  if (waitFor !== undefined && (typeof waitFor !== 'string' || waitFor.trim() === '')) throw new Error('waitFor must be HUD text to wait for.')
  if (typeof waitFor === 'string') await untilText(waitFor, signal)
  const target = canvas()
  const held = [...new Set(keys as string[])]
  try {
    for (const key of held) target.dispatchEvent(new KeyboardEvent('keydown', { ...KEYS[key], bubbles: true }))
    await wait(ms, signal)
  } finally {
    for (const key of held) target.dispatchEvent(new KeyboardEvent('keyup', { ...KEYS[key], bubbles: true }))
  }
}

async function status(): Promise<unknown> {
  const [position, snapshot, logs] = await Promise.all([consoleCommand('player_position'), cmd.crdtSnapshot(), cmd.sceneLogs(100)])
  const hud = hudTexts(snapshot).slice(0, 80)
  return {
    playing: !state.frozen,
    platform,
    position: playerPosition(position),
    hud, errors: errorLines(logs).slice(-20),
    serverErrors: hostV1()?.previewServerLogs?.(0).filter(isServerError).slice(-20).map((line) => line.msg) ?? []
  }
}

export async function playtest(request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  const action = request.action
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
    if (action === 'input') await input(request.keys, duration(request.durationMs, 300), request.waitFor, signal)
    else if (action === 'wait') await wait(duration(request.durationMs, 1000), signal)
    else if (action === 'walk') {
      const to = request.to
      if (!object(to) || ![to.x, to.y, to.z].every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('walk requires a finite to: {x, y, z} in world metres.')
      await consoleCommand('walk_player_to', [String(to.x), String(to.y), String(to.z), '5']).catch(async () => {
        const at = await consoleCommand('player_position').catch(() => 'unknown')
        throw new Error(`The walk stopped before ${to.x} ${to.y} ${to.z}: something blocks the way or the target is higher than a step. The player is at ${at}. Walk around it in shorter legs; a route that needs a jump is for the creator to try.`)
      })
    } else if (action === 'click') {
      const { x, y } = request
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error('click x and y must be fractions of the viewport from 0 to 1.')
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
    } else throw new Error('Unknown playtest action.')
    await wait(300, signal)
  }
  return status()
}
