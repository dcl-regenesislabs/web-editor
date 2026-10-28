// The creator's viewport quality choices, kept across sessions by the editor and applied to every
// engine it attaches to through `/session_graphics`: the engine holds them for this session only
// and never writes them to the player's settings. Leaving the editor hands each one back.
import { storedValue, whenPersisted, writeKey } from '../core/persist'
import { log } from '../log'
import { consoleCommand, engineReady, getEngineWindow } from './console'

export const RENDER_SCALES = ['0.5', '0.75', '1'] as const
export type RenderScale = (typeof RENDER_SCALES)[number]

// the engine's empty-parcel grass levels; the player's default is low
export const GRASS_DETAILS = ['off', 'low', 'mid', 'high'] as const
export type GrassDetail = (typeof GRASS_DETAILS)[number]

export const FPS_CAPS = ['30', '45', '60'] as const
export type FpsCap = (typeof FPS_CAPS)[number]

export interface ViewportQuality {
  renderScale: RenderScale
  grass: GrassDetail
  fpsCap: FpsCap
}

const DEFAULTS: ViewportQuality = { renderScale: '0.75', grass: 'low', fpsCap: '60' }

const KEY = 'eui:viewport-quality'

function oneOf<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
  return options.find((o) => o === value) ?? fallback
}

export function parseQuality(raw: string | null): ViewportQuality {
  let stored: Partial<Record<keyof ViewportQuality, unknown>> = {}
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') stored = parsed
  } catch {
    // an unreadable record is a first run
  }
  return {
    renderScale: oneOf(RENDER_SCALES, stored.renderScale, DEFAULTS.renderScale),
    grass: oneOf(GRASS_DETAILS, stored.grass, DEFAULTS.grass),
    fpsCap: oneOf(FPS_CAPS, stored.fpsCap, DEFAULTS.fpsCap)
  }
}

type Setting = 'render_scale' | 'grass' | 'fps'

// the `/session_graphics` lines that bring the engine from `before` to `next`, or all of them
export function sessionCommands(before: ViewportQuality | null, next: ViewportQuality): Array<[Setting, string]> {
  const commands: Array<[Setting, string]> = []
  if (before?.renderScale !== next.renderScale) commands.push(['render_scale', next.renderScale])
  if (before?.grass !== next.grass) commands.push(['grass', next.grass])
  if (before?.fpsCap !== next.fpsCap) commands.push(['fps', next.fpsCap])
  return commands
}

const read = (): ViewportQuality => parseQuality(storedValue('viewport-quality'))

let quality = read()
const listeners = new Set<() => void>()
let attached = false

export function viewportQuality(): ViewportQuality {
  return quality
}

export function onViewportQuality(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function publish(next: ViewportQuality): ViewportQuality {
  const before = quality
  quality = next
  for (const fn of listeners) fn()
  return before
}

whenPersisted(() => {
  const before = publish(read())
  void apply(before)
})

export function setViewportQuality(change: Partial<ViewportQuality>): void {
  const next = { ...quality, ...change }
  writeKey(KEY, JSON.stringify(next))
  const before = publish(next)
  void apply(before)
}

async function send(commands: Array<[Setting, ...string[]]>): Promise<void> {
  const failed = (await Promise.allSettled(commands.map((args) => consoleCommand('/session_graphics', args)))).filter((r) => r.status === 'rejected')
  // an engine older than /session_graphics (or render_scale off the web canvas) keeps its own
  for (const f of failed) log.warn('viewport quality: the engine refused a setting:', f.reason)
}

async function apply(before: ViewportQuality | null): Promise<void> {
  if (!attached || !engineReady()) return
  await send(sessionCommands(before, quality))
}

// applies the stored choices to each engine the editor attaches to, and on leaving gives the
// engine back the player's own settings (a hosted engine is the player's explorer)
export function installViewportQuality(): () => void {
  let appliedTo: Window | null = null
  attached = true
  const timer = setInterval(() => {
    const w = getEngineWindow()
    if (w === appliedTo || !engineReady()) return
    appliedTo = w
    void apply(null)
  }, 500)
  return () => {
    clearInterval(timer)
    attached = false
    if (appliedTo !== null && engineReady()) void send([['render_scale'], ['grass'], ['fps']])
  }
}
