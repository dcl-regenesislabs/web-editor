// The scene's screen UI as the engine laid it out right now, on whatever the game runs as: the
// desktop canvas, or a 1600x720 phone when playtesting started with platform mobile. Measuring
// changes nothing, so a dialog opened by playtest click or input is measured open.
//
// The engine writes UiLayoutFeedback (experimental) on every UI entity with an elementId, so the
// measurement is the scene's own CRDT: nodes without an elementId are counted, not measured.
import { object } from '@dcl-editor/contract'
import { state } from '@scene/state'
import { cmd } from '../engine/cmd'
import { playtestPlatform } from './playtest'
import { captureView } from './view'

type Components = Record<string, unknown>

function rect(value: unknown): number[] | null {
  if (!object(value)) return null
  const { x = 0, y = 0, width = 0, height = 0 } = value as Record<string, number | undefined>
  return [x, y, width, height]
}

// what makes a node take presses, as the engine counts it
function pointer(components: Components, transform: Record<string, unknown>): string[] {
  return [
    ...('PointerEvents' in components ? ['pointer_events'] : []),
    ...('UiInput' in components ? ['input'] : []),
    ...('UiDropdown' in components ? ['dropdown'] : []),
    ...(transform.pointerFilter === 1 || transform.pointerFilter === 'PFM_BLOCK' ? ['pointer_filter'] : [])
  ]
}

function node(entity: string, components: Components, feedback: Record<string, unknown>): Record<string, unknown> {
  const transform = object(components.UiTransform) ? components.UiTransform : {}
  const text = object(components.UiText) ? components.UiText : null
  const box = rect(feedback.rect)
  const shown = rect(feedback.visibleRect)
  const presses = pointer(components, transform)
  const kept: Record<string, unknown> = {
    entity: Number(entity),
    parent: transform.parent ?? 0,
    elementId: transform.elementId,
    order: feedback.drawOrder ?? 0,
    zIndex: transform.zIndex,
    rect: box,
    text: text?.value,
    fontSize: text?.fontSize
  }
  return {
    ...Object.fromEntries(Object.entries(kept).filter(([, value]) => value !== undefined && value !== null)),
    ...(shown !== null && JSON.stringify(shown) !== JSON.stringify(box) ? { clipped: true, visibleRect: shown } : {}),
    ...(presses.length > 0 ? { pointer: presses } : {})
  }
}

function measure(snapshot: Record<string, Components>): Record<string, unknown> {
  const root = snapshot['0'] ?? {}
  const nodes: Record<string, unknown>[] = []
  let unnamed = 0
  for (const [entity, components] of Object.entries(snapshot)) {
    if (!object(components.UiTransform)) continue
    const feedback = components.UiLayoutFeedback
    if (!object(feedback)) {
      if (typeof components.UiTransform.elementId !== 'string') unnamed++
      continue
    }
    if (feedback.visible === true) nodes.push(node(entity, components, feedback))
  }
  nodes.sort((a, b) => Number(a.order) - Number(b.order))
  if (nodes.length === 0 && unnamed > 0) {
    throw new Error(`None of the ${unnamed} UI nodes has an elementId: the engine measures only nodes with one. If this project's SDK has elementId in uiTransform, give every button, panel and text a unique one and measure again; if it does not, check the layout rules by hand from the code and a view picture.`)
  }
  return {
    canvas: root.UiCanvasInformation,
    nodes,
    ...(unnamed > 0 ? { unmeasured: `${unnamed} UI nodes have no elementId and were not measured` } : {})
  }
}

export async function uiLayout(_request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted()
  if (state.frozen) throw new Error('Start playtesting first (platform mobile for the phone layout): the UI is laid out while the game runs.')
  const layout = measure(await cmd.crdtSnapshot())
  signal.throwIfAborted()
  const view = await captureView({ entity: null, from: null, lookAt: null }, signal)
  return { platform: playtestPlatform(), ...layout, view }
}
