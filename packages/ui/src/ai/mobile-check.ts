// The phone check as one fixed path, so it runs the same however the model would have walked it: play as
// on a 1600x720 phone, measure the HUD, open every modal the shared HUD layout holds (editor::HudPreview)
// and measure each, then apply the layout and touch-button rules in code (mobile-rules.ts).
import { object } from '@dcl-editor/contract'
import { writeCustomComponent } from '@scene/inspector'
import { state } from '@scene/state'
import { cmd } from '../engine/cmd'
import { keyHintIssues, layoutIssues, touchIssues, usedActions, visibleButtons, type Canvas, type Issue, type MeasuredNode, type Rect } from './mobile-rules'
import { playtest, playtestPlatform } from './playtest'
import { measuredNodes } from './ui-measure'
import { captureView } from './view'

type Snapshot = Record<string, Record<string, unknown>>

const PREVIEW = 'editor::HudPreview'
const MAX_MODALS = 6
const UI_READY_MS = 5000
// frames for the scene to read the preview and the engine to lay the dialog out
const SETTLE_MS = 500

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
  signal.throwIfAborted()
}

function canvasOf(snapshot: Snapshot): Canvas | null {
  const info = snapshot['0']?.UiCanvasInformation
  if (!object(info) || typeof info.width !== 'number' || typeof info.height !== 'number') return null
  const area = object(info.interactableArea) ? info.interactableArea : {}
  const side = (key: string) => typeof area[key] === 'number' ? area[key] as number : 0
  return { width: info.width, height: info.height, interactable: { left: side('left'), top: side('top'), right: side('right'), bottom: side('bottom') } }
}

function modalCount(snapshot: Snapshot): number | null {
  for (const components of Object.values(snapshot)) {
    const transform = components.UiTransform
    const id = object(transform) && typeof transform.elementId === 'string' ? /^hud:modals:(\d+)$/.exec(transform.elementId) : null
    if (id !== null) return Number(id[1])
  }
  return null
}

function nodesOf(snapshot: Snapshot): { nodes: MeasuredNode[]; unnamed: number } {
  const measured = measuredNodes(snapshot)
  const nodes = measured.nodes.flatMap((raw): MeasuredNode[] => {
    const rect = raw.rect
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => typeof n === 'number')) return []
    return [{
      entity: Number(raw.entity), parent: typeof raw.parent === 'number' ? raw.parent : undefined,
      elementId: typeof raw.elementId === 'string' ? raw.elementId : undefined,
      order: typeof raw.order === 'number' ? raw.order : undefined, rect: rect as Rect,
      text: typeof raw.text === 'string' ? raw.text : undefined,
      fontSize: typeof raw.fontSize === 'number' ? raw.fontSize : undefined,
      clipped: raw.clipped === true,
      pointer: Array.isArray(raw.pointer) ? raw.pointer.filter((p): p is string => typeof p === 'string') : undefined
    }]
  })
  return { nodes, unnamed: measured.unnamed }
}

async function untilUi(signal: AbortSignal): Promise<Snapshot> {
  const until = Date.now() + UI_READY_MS
  for (;;) {
    const snapshot = await cmd.crdtSnapshot()
    if (canvasOf(snapshot) !== null && modalCount(snapshot) !== null) return snapshot
    if (Date.now() > until) return snapshot
    await sleep(200, signal)
  }
}

interface StateResult { state: string; measured: number; unmeasured: number; view: unknown }

async function measureState(name: string, controlsShown: boolean, signal: AbortSignal): Promise<{ result: StateResult; issues: Issue[]; snapshot: Snapshot }> {
  const snapshot = await cmd.crdtSnapshot()
  const canvas = canvasOf(snapshot)
  const { nodes, unnamed } = nodesOf(snapshot)
  const issues = canvas === null
    ? [{ rule: 'setup', state: name, detail: 'the engine reported no UiCanvasInformation' }]
    : [...layoutIssues(name, canvas, nodes, controlsShown), ...keyHintIssues(name, nodes)]
  if (name.startsWith('modal') && !nodes.some((node) => node.elementId !== undefined && !node.elementId.startsWith('hud:'))) {
    issues.push({ rule: 'M1', state: name, detail: 'nothing inside this dialog is measured: give its panel a uiTransform elementId, and make its render draw the dialog whenever it is called (open() decides when it shows)' })
  }
  const view = await captureView({ entity: null, from: null, lookAt: null }, signal)
  return { result: { state: name, measured: nodes.length, unmeasured: unnamed, view }, issues, snapshot }
}

/** The project's files, for the input actions its code reads. */
export type ProjectSources = () => Promise<ReadonlyMap<string, Uint8Array>>

function decoded(files: ReadonlyMap<string, Uint8Array>): Array<[string, string]> {
  const decoder = new TextDecoder()
  return [...files].filter(([path]) => /\.tsx?$/.test(path)).map(([path, bytes]) => [path, decoder.decode(bytes)])
}

/** Measure every screen state of the scene's UI on a phone and check it; leaves the mobile playtest running. */
export async function mobileCheck(signal: AbortSignal, sources: ProjectSources): Promise<unknown> {
  signal.throwIfAborted()
  if (state.frozen || playtestPlatform() !== 'mobile') await playtest({ action: 'start', platform: 'mobile' }, signal)
  const first = await untilUi(signal)
  const modals = modalCount(first)
  const states: StateResult[] = []
  const issues: Issue[] = []
  if (modals === null) {
    issues.push({ rule: 'setup', state: 'hud', detail: 'the scene has no HUD from ./runtime/hudLayout: place every panel with addHudItem, or check the layout by hand from the code and a view picture' })
  }
  if (modals !== null) {
    await writeCustomComponent('0', PREVIEW, { modal: -1 })
    await sleep(SETTLE_MS, signal)
  }
  const hud = await measureState('hud', true, signal)
  states.push(hud.result)
  issues.push(...hud.issues)
  try {
    for (let k = 0; k < Math.min(modals ?? 0, MAX_MODALS); k++) {
      await writeCustomComponent('0', PREVIEW, { modal: k })
      await sleep(SETTLE_MS, signal)
      const modal = await measureState(`modal ${k}`, false, signal)
      states.push(modal.result)
      issues.push(...modal.issues)
    }
  } finally {
    if (modals !== null) await writeCustomComponent('0', PREVIEW, { modal: -1 })
  }
  const used = usedActions(decoded(await sources()))
  const visible = visibleButtons(hud.snapshot['0']?.TouchScreenControls)
  issues.push(...touchIssues(used, visible))
  return {
    passed: issues.length === 0,
    platform: 'mobile',
    canvas: canvasOf(hud.snapshot),
    touch: { used, visible },
    issues,
    ...((modals ?? 0) > MAX_MODALS ? { note: `only the first ${MAX_MODALS} of ${modals} modals were opened` } : {}),
    states
  }
}
