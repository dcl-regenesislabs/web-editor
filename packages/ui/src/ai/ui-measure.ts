// The scene's screen UI nodes as the engine measured them. The engine writes UiLayoutFeedback
// (experimental) on every UI entity with an elementId, so the measurement is the scene's own CRDT:
// nodes without an elementId are counted, not measured.
import { object } from '@dcl-editor/contract'

export type Components = Record<string, unknown>

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

/** The visible nodes the engine measured, in draw order, and how many UI nodes it could not (no elementId). */
export function measuredNodes(snapshot: Record<string, Components>): { nodes: Record<string, unknown>[]; unnamed: number } {
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
  return { nodes, unnamed }
}
