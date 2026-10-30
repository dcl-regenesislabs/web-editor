// The phone layout rules the mobile check applies in code, so a result does not depend on the model
// reading a picture: the scene-ui skill's L and H rules (references/layout-check.md) and its C2 and C3 touch
// rules, on the layout the engine measured. Rects are canvas units, [x, y, width, height] from the top left.

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

// The explorer's own controls on a 1600x720 phone, scaled to other canvases. Nothing reports their real rects:
// bevy-explorer draws none (its /mobile_ui only reshapes the canvas) and the mobile client that does, godot-explorer,
// exposes no layout. So they are computed the way that client lays them out: the top-left buttons row is measured
// from the mobile preview, the rest is layout-check.md's table, and the action buttons follow joypad.gd/joypad_arc.gd.
const PHONE = { width: 1600, height: 720 }
const EXPLORER: Array<{ id: string; rect: Rect; touch?: boolean }> = [
  { id: 'explorer buttons (profile, chat, camera, reload)', rect: [108, 32, 360, 85] },
  { id: 'chat column', rect: [108, 117, 328, 558] }
]
const JOYSTICK: Array<{ id: string; rect: Rect; touch?: boolean }> = [
  { id: 'joystick', rect: [177, 444, 170, 170] },
  { id: 'joystick touch zone', rect: [0, 240, 640, 480], touch: true }
]
// the right and bottom screen insets the action buttons sit against, the large button, the arc discs and their orbit
const CLUSTER = { right: 108, bottom: 45, large: 156, small: 80, orbit: 167 }
// the order the buttons fill the cluster in; hidden ones drop out and the rest move up
const PRIORITY = ['IA_JUMP', 'IA_POINTER', 'IA_PRIMARY', 'IA_SECONDARY', 'IA_ACTION_3', 'IA_ACTION_4', 'IA_ACTION_5', 'IA_ACTION_6']
const GLYPH: Record<string, string> = { IA_JUMP: 'jump', IA_POINTER: 'pointer', IA_PRIMARY: 'E', IA_SECONDARY: 'F', IA_ACTION_3: '1', IA_ACTION_4: '2', IA_ACTION_5: '3', IA_ACTION_6: '4' }

/** What the phone shows of its own controls in the HUD state: the visible buttons, the main one, the joystick. */
export interface TouchLayout { visible: string[]; main?: string; joystick: boolean }

export const ALL_CONTROLS: TouchLayout = { visible: PRIORITY, joystick: true }

/** The action buttons as the mobile client places them, in 1600x720 units: the first visible action in the large
 * corner button, the next ones on an arc around it, and a "+" holding the rest when more than five show. */
export function actionButtons(touch: TouchLayout): Array<{ id: string; rect: Rect }> {
  const order = PRIORITY.filter((name) => touch.visible.includes(name))
  if (touch.main !== undefined && touch.main !== 'IA_JUMP' && order.includes(touch.main)) {
    order.splice(order.indexOf(touch.main), 1)
    order.unshift(touch.main)
  }
  if (order.length === 0) return []
  const c = CLUSTER
  const cx = PHONE.width - c.right - c.large / 2
  const cy = PHONE.height - c.bottom - c.large / 2
  const buttons: Array<{ id: string; rect: Rect }> = [{ id: `large ${GLYPH[order[0]]} button`, rect: [cx - c.large / 2, cy - c.large / 2, c.large, c.large] }]
  const plus = order.length > 5
  const arc = order.slice(1, plus ? 4 : 5).map((name) => `${GLYPH[name]} button`)
  if (plus) arc.push('"+" button')
  const edge = (c.large - c.small) / 2
  const span = Math.sqrt(c.orbit * c.orbit - edge * edge)
  const first = Math.atan2(edge, -span)
  let last = Math.atan2(-span, edge)
  if (last < first) last += 2 * Math.PI
  const step = (last - first) / (Math.max(arc.length, 3) - 1)
  arc.forEach((id, i) => {
    const theta = arc.length === 1 ? (first + last) / 2 : first + step * i
    const x = cx + Math.cos(theta) * c.orbit
    const y = cy + Math.sin(theta) * c.orbit
    buttons.push({ id, rect: [x - c.small / 2, y - c.small / 2, c.small, c.small] })
  })
  return buttons
}

function nativeControls(touch: TouchLayout): Array<{ id: string; rect: Rect; touch?: boolean }> {
  return [...EXPLORER, ...(touch.joystick ? JOYSTICK : []), ...actionButtons(touch)]
}

// A compact game HUD (score, timer, a hint) takes 15–20% of a phone screen; the shared layout's four slots
// filled with one compact panel each come to about 15%. 25% leaves that room and still fails a HUD that hides
// the game, as the Overcooked score box did.
export const HUD_COVERAGE_BUDGET = 0.25
// the share of the screen centre (its middle third both ways: the avatar, the crosshair, what the player acts on)
// one HUD item may cover: a status panel may clip its edge, a score box may not sit in it
export const CENTRE_SHARE_LIMIT = 0.15

// the floor the assistant prompt states, not the skill's L4 (24, still proposed): the editor's own HUD
// modules and the UI skill's examples draw 16–20, so 24 would fail almost every scene
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

function area(rect: Rect): number {
  return Math.max(0, rect[2]) * Math.max(0, rect[3])
}

function clip(a: Rect, b: Rect): Rect {
  const x = Math.max(a[0], b[0])
  const y = Math.max(a[1], b[1])
  return [x, y, Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - x), Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - y)]
}

/** The area the rects cover together, overlaps counted once. */
export function unionArea(rects: Rect[]): number {
  const xs = [...new Set(rects.flatMap((r) => [r[0], r[0] + r[2]]))].sort((a, b) => a - b)
  let total = 0
  for (let i = 0; i + 1 < xs.length; i++) {
    const spans = rects.filter((r) => r[0] <= xs[i] && r[0] + r[2] >= xs[i + 1] && r[2] > 0)
      .map((r) => [r[1], r[1] + r[3]]).sort((a, b) => a[0] - b[0])
    let covered = 0
    let end = -Infinity
    for (const [top, bottom] of spans) {
      if (bottom <= end) continue
      covered += bottom - Math.max(top, end)
      end = bottom
    }
    total += covered * (xs[i + 1] - xs[i])
  }
  return total
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

/** H2 and H3: the HUD leaves the game visible. Only the HUD state counts; a dialog is meant to cover it. */
export function coverageIssues(state: string, canvas: Canvas, nodes: MeasuredNode[]): Issue[] {
  const issues: Issue[] = []
  const screen: Rect = [0, 0, canvas.width, canvas.height]
  const items = nodes.filter(hudItem).map((node) => ({ node, rect: clip(node.rect, screen) }))
  const covered = unionArea(items.map((item) => item.rect))
  const budget = HUD_COVERAGE_BUDGET * area(screen)
  if (covered > budget) {
    const largest = [...items].sort((a, b) => area(b.rect) - area(a.rect))
    const big = largest[0]
    const [, , w, h] = big.rect
    const target = Math.max(48, Math.floor(h - (covered - budget) / Math.max(1, w)))
    const list = largest.slice(0, 4).map((item) => `${label(item.node)} ${Math.round(item.rect[2])}x${Math.round(item.rect[3])} (${percent(area(item.rect) / area(screen))})`).join(', ')
    issues.push({
      rule: 'H2-coverage', state, node: label(big.node),
      detail: `the HUD covers ${percent(covered / area(screen))} of the phone screen, over the ${percent(HUD_COVERAGE_BUDGET)} budget (a compact game HUD is 15–20%): ${list}. Shrink ${label(big.node)} to ${Math.round(w)}x${target} or less, merge panels, or move detail into a modal the player opens (D5)`
    })
  }
  const centre: Rect = [canvas.width / 3, canvas.height / 3, canvas.width / 3, canvas.height / 3]
  for (const { node, rect } of items) {
    const share = area(clip(rect, centre)) / area(centre)
    if (share <= CENTRE_SHARE_LIMIT) continue
    const above = Math.floor(centre[1] - rect[1])
    const fit = above >= 48 ? `keep it at most ${Math.round(rect[2])}x${above} so it ends above y=${Math.round(centre[1])}` : 'make it smaller'
    const move = node.elementId?.startsWith('hud:left:') === true ? ", or move it to the 'right' column, which stays clear of the centre" : ''
    issues.push({
      rule: 'H3-centre', state, node: label(node),
      detail: `${numbers(rect)} covers ${percent(share)} of the screen centre ${numbers(centre)}, where the player and the game are: ${fit}${move}`
    })
  }
  return issues
}

/** The layout rules for one screen state: `hud` with the phone's controls as the scene set them, or a modal (null: hidden). */
export function layoutIssues(state: string, canvas: Canvas, nodes: MeasuredNode[], controls: TouchLayout | null): Issue[] {
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
    if (controls !== null && (pressable || hudItem(node) || node.text !== undefined)) {
      const hits = nativeControls(controls).filter((native) => native.touch !== true || pressable)
        .map((native) => ({ id: native.id, rect: scaled(native.rect, canvas) })).filter((native) => intersects(node.rect, native.rect))
      if (hits.length > 0) {
        issues.push({ rule: 'L2', state, node: label(node), detail: `${numbers(node.rect)} overlaps the ${hits.map((hit) => `${hit.id} ${numbers(hit.rect)}`).join(', the ')}` })
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
  if (controls !== null) issues.push(...coverageIssues(state, canvas, measured))
  return issues
}

// A desktop key named as the way to act. Letters are case-sensitive and must stand alone, so words, "E-mail"
// and "F1" pass; digits only count bracketed or after a press verb, since "Round 1:", "1 / 4" and "press 3 buttons" are not keys.
const KEY_HINTS: RegExp[] = [
  /(?:^|[\s([{"'¿¡])([EF])\s*(?::|\/(?!\d)|\s+(?:to|para|pour)\s)/gu,
  /[[(]\s*([EF])\s*[\])]/gu,
  /\[\s*([1-4])\s*\]/gu,
  /(?:^|[^\p{L}])(?:press|hold|hit|pulsa|pulsá|presiona|presioná|aprieta|apretá|mantén|mantené|tecla|key)\s+[[(]?([EF])(?![\p{L}\p{N}-])/giu,
  /(?:^|[^\p{L}])(?:press|pulsa|pulsá|presiona|presioná|aprieta|apretá|tecla|key)\s+[[(]?([1-4])[\])]?(?=\s*(?:$|[:,.!)]|(?:to|para|pour)\s))/giu
]
// the verb patterns ignore case, but "presiona e intenta" is Spanish for "and"
const KEY = /^[EF1-4]$/

/** C3: text a phone shows that tells the player to press a keyboard key it does not have. */
export function keyHintIssues(state: string, nodes: MeasuredNode[]): Issue[] {
  const issues: Issue[] = []
  for (const node of nodes) {
    if (node.text === undefined || marker(node)) continue
    const text = node.text
    const key = KEY_HINTS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1])).find((found) => KEY.test(found))
    if (key === undefined) continue
    issues.push({
      rule: 'C3-key-letter', state, node: label(node),
      detail: `names the key "${key}" as the way to act, and a phone has no keyboard. On mobile name the action (or show its icon) and keep the key for desktop: isMobile() ? 'Tap the station' : 'E: use the station'`
    })
  }
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

/** The phone's own controls in the HUD state, from the root's TouchScreenControls. */
export function touchLayout(touch: unknown): TouchLayout {
  const value = typeof touch === 'object' && touch !== null ? touch as { mainAction?: unknown; hideJoystick?: unknown } : {}
  const main = actionName(value.mainAction)
  return { visible: visibleButtons(touch), joystick: value.hideJoystick !== true, ...(main === undefined ? {} : { main }) }
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
