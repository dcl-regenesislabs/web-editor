// The phone layout rules the mobile check applies in code, so a result does not depend on the model
// reading a picture: the scene-ui skill's L rules (references/layout-check.md) and its C2 touch rule,
// on the layout the engine measured. Rects are canvas units, [x, y, width, height] from the top left.

export type Rect = [number, number, number, number]

export interface MeasuredNode {
  entity: number
  parent?: number
  elementId?: string
  order?: number
  rect: Rect
  text?: string
  fontSize?: number
  clipped?: boolean
  pointer?: string[]
}

export interface Canvas {
  width: number
  height: number
  interactable: { left: number; top: number; right: number; bottom: number }
}

export interface Issue { rule: string; state: string; node?: string; detail: string }

// the explorer's own controls on a 1600x720 phone (layout-check.md), scaled to other canvases; the top-left
// buttons row is measured from the mobile preview
const PHONE = { width: 1600, height: 720 }
const NATIVE: Array<{ id: string; rect: Rect; touch?: boolean }> = [
  { id: 'explorer buttons (profile, chat, camera, reload)', rect: [108, 32, 360, 85] },
  { id: 'chat column', rect: [108, 117, 328, 558] },
  { id: 'joystick', rect: [177, 444, 170, 170] },
  { id: 'joystick touch zone', rect: [0, 240, 640, 480], touch: true },
  { id: 'action buttons', rect: [1211, 394, 281, 281] }
]

export const MIN_TEXT = 16
export const MIN_TARGET = 48

function scaled(rect: Rect, canvas: Canvas): Rect {
  const sx = canvas.width / PHONE.width
  const sy = canvas.height / PHONE.height
  return [rect[0] * sx, rect[1] * sy, rect[2] * sx, rect[3] * sy]
}

export function intersects(a: Rect, b: Rect): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

function inside(a: Rect, b: Rect): boolean {
  const slack = 0.5
  return a[0] >= b[0] - slack && a[1] >= b[1] - slack && a[0] + a[2] <= b[0] + b[2] + slack && a[1] + a[3] <= b[1] + b[3] + slack
}

function label(node: MeasuredNode): string {
  const text = node.text === undefined ? '' : ` "${node.text.slice(0, 40)}"`
  return `${node.elementId ?? `entity ${node.entity}`}${text}`
}

function numbers(rect: Rect): string {
  return `[${rect.map((n) => Math.round(n)).join(', ')}]`
}

// a HUD item's box, as hudLayout.tsx names it; the modal boxes are the whole screen they dim
function hudItem(node: MeasuredNode): boolean {
  return /^hud:(left|right|top|bottom):\d+$/.test(node.elementId ?? '')
}

function marker(node: MeasuredNode): boolean {
  return /^hud:(modals:\d+|modal:\d+)$/.test(node.elementId ?? '')
}

function ancestor(nodes: Map<number, MeasuredNode>, of: MeasuredNode, candidate: MeasuredNode): boolean {
  let at = of.parent
  for (let hops = 0; at !== undefined && at !== 0 && hops < 64; hops++) {
    if (at === candidate.entity) return true
    at = nodes.get(at)?.parent
  }
  return false
}

/** The layout rules for one screen state: `hud` (touch controls showing) or a modal (controls hidden). */
export function layoutIssues(state: string, canvas: Canvas, nodes: MeasuredNode[], controlsShown: boolean): Issue[] {
  const issues: Issue[] = []
  const area: Rect = [canvas.interactable.left, canvas.interactable.top,
    canvas.width - canvas.interactable.left - canvas.interactable.right,
    canvas.height - canvas.interactable.top - canvas.interactable.bottom]
  const screen: Rect = [0, 0, canvas.width, canvas.height]
  const byEntity = new Map(nodes.map((node) => [node.entity, node]))
  const measured = nodes.filter((node) => !marker(node))
  for (const node of measured) {
    const pressable = (node.pointer?.length ?? 0) > 0
    if ((pressable || hudItem(node)) && !inside(node.rect, area)) {
      issues.push({ rule: 'L1', state, node: label(node), detail: `${numbers(node.rect)} leaves the interactable area ${numbers(area)}` })
    }
    if (!inside(node.rect, screen)) {
      issues.push({ rule: 'L8', state, node: label(node), detail: `${numbers(node.rect)} falls off the ${canvas.width}x${canvas.height} canvas` })
    }
    if (controlsShown && (pressable || hudItem(node) || node.text !== undefined)) {
      for (const native of NATIVE) {
        if (native.touch === true && !pressable) continue
        const rect = scaled(native.rect, canvas)
        if (intersects(node.rect, rect)) {
          issues.push({ rule: 'L2', state, node: label(node), detail: `${numbers(node.rect)} overlaps the ${native.id} ${numbers(rect)}` })
        }
      }
    }
    if (pressable && Math.min(node.rect[2], node.rect[3]) < MIN_TARGET) {
      issues.push({ rule: 'L3', state, node: label(node), detail: `${Math.round(node.rect[2])}x${Math.round(node.rect[3])}, under ${MIN_TARGET} on its short side` })
    }
    if (node.fontSize !== undefined && node.fontSize < MIN_TEXT) {
      issues.push({ rule: 'L4', state, node: label(node), detail: `text size ${node.fontSize}, under ${MIN_TEXT}` })
    }
    if (node.clipped === true && node.text !== undefined) {
      issues.push({ rule: 'L4', state, node: label(node), detail: 'its text is clipped by its box' })
    }
  }
  const pressables = measured.filter((node) => (node.pointer?.length ?? 0) > 0)
  for (const below of pressables) {
    for (const above of pressables) {
      if (above === below || (above.order ?? 0) <= (below.order ?? 0)) continue
      if (ancestor(byEntity, above, below) || ancestor(byEntity, below, above)) continue
      if (intersects(above.rect, below.rect)) {
        issues.push({ rule: 'L5', state, node: label(below), detail: `covered by ${label(above)}, which also takes presses` })
      }
    }
  }
  const items = measured.filter(hudItem)
  items.forEach((a, i) => {
    for (const b of items.slice(i + 1)) {
      if (intersects(a.rect, b.rect)) issues.push({ rule: 'H1', state, node: label(a), detail: `overlaps ${label(b)}` })
    }
  })
  return issues
}

// InputAction, as the scene's CRDT writes it: a number, or its name
const ACTION_NAMES = ['IA_POINTER', 'IA_PRIMARY', 'IA_SECONDARY', 'IA_ANY', 'IA_FORWARD', 'IA_BACKWARD', 'IA_RIGHT', 'IA_LEFT',
  'IA_JUMP', 'IA_WALK', 'IA_ACTION_3', 'IA_ACTION_4', 'IA_ACTION_5', 'IA_ACTION_6', 'IA_MODIFIER']
export const TOUCH_BUTTONS = ['IA_POINTER', 'IA_PRIMARY', 'IA_SECONDARY', 'IA_JUMP', 'IA_ACTION_3', 'IA_ACTION_4', 'IA_ACTION_5', 'IA_ACTION_6']

export function actionName(value: unknown): string | undefined {
  if (typeof value === 'number') return ACTION_NAMES[value]
  return typeof value === 'string' && ACTION_NAMES.includes(value) ? value : undefined
}

/** The input actions the scene's own code reads, from its sources (the editor's runtime modules excluded). */
export function usedActions(sources: Iterable<[string, string]>): string[] {
  const used = new Set<string>()
  for (const [path, text] of sources) {
    if (!/\.tsx?$/.test(path) || /(^|\/)runtime\//.test(path) || path.includes('node_modules/')) continue
    for (const match of text.matchAll(/InputAction\d*\.(IA_[A-Z0-9_]+)/g)) used.add(match[1])
  }
  return [...used].filter((name) => TOUCH_BUTTONS.includes(name)).sort()
}

/** The native buttons a phone shows, from the root's TouchScreenControls; every one is shown by default. */
export function visibleButtons(touch: unknown): string[] {
  const hidden = new Set<string>()
  if (typeof touch === 'object' && touch !== null && Array.isArray((touch as { touchInputs?: unknown }).touchInputs)) {
    for (const input of (touch as { touchInputs: unknown[] }).touchInputs) {
      if (typeof input !== 'object' || input === null) continue
      const { inputAction, hide } = input as { inputAction?: unknown; hide?: unknown }
      const name = actionName(inputAction)
      if (name !== undefined && hide === true) hidden.add(name)
    }
  }
  return TOUCH_BUTTONS.filter((name) => !hidden.has(name))
}

/** C1/C2: every visible button does something, and every action the code reads has a way in on a phone. */
export function touchIssues(used: string[], visible: string[]): Issue[] {
  const issues: Issue[] = []
  // jumping is movement, which the code never names; taps on world objects work with no pointer button
  const unused = visible.filter((name) => !used.includes(name) && name !== 'IA_JUMP' && name !== 'IA_POINTER')
  if (unused.length > 0) {
    issues.push({ rule: 'C2', state: 'hud', detail: `the phone shows buttons the scene never reads: ${unused.join(', ')}. Declare the ones it uses with declareTouchButtons from './runtime/hudLayout'` })
  }
  const missing = used.filter((name) => !visible.includes(name) && name !== 'IA_POINTER')
  if (missing.length > 0) {
    issues.push({ rule: 'C1', state: 'hud', detail: `the code reads ${missing.join(', ')} but its phone button is hidden` })
  }
  return issues
}
