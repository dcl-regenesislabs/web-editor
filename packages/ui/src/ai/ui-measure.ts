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

/** What the scene's installed SDK carries, when the editor can tell (desktop probes the scene's node_modules). */
export interface SceneSdk {
  elementId: boolean
  version?: string
}

export interface Unmeasurable {
  reason: 'no-ui' | 'no-element-ids' | 'sdk-has-no-element-id' | 'explorer-has-no-layout-feedback'
  why: string
  instead: string
}

const BY_HAND = 'Check the layout rules by hand instead: the sizes and positions in the UI code against the scene-ui rules, and the picture (playtest with platform mobile for the phone). Say which rules you checked only that way.'
const EXPERIMENTAL_SDK = '@dcl/sdk@experimental-bevy-auth-server @dcl/sdk-commands@experimental-bevy-auth-server'

/**
 * Why nothing on screen can be measured, or null when the engine measured at least one node:
 * an empty measurement must never read as "no problems".
 */
export function unmeasurable(snapshot: Record<string, Components>, sdk: SceneSdk | null): Unmeasurable | null {
  let ui = 0
  let named = 0
  for (const components of Object.values(snapshot)) {
    if (!object(components.UiTransform)) continue
    if (object(components.UiLayoutFeedback)) return null
    ui++
    if (typeof components.UiTransform.elementId === 'string') named++
  }
  if (ui === 0) {
    return {
      reason: 'no-ui',
      why: 'The scene draws no screen UI right now: no entity has a UiTransform.',
      instead: 'Check that the scene sets its UI renderer (ReactEcsRenderer.setUiRenderer, or the HUD from ./runtime/hudLayout) and that the playtest reached the screen that shows it, then measure again.'
    }
  }
  if (named > 0) {
    return {
      reason: 'explorer-has-no-layout-feedback',
      why: `${named} of the ${ui} UI nodes have an elementId, but the explorer reported no layout for any of them (UiLayoutFeedback): this explorer build does not measure screen UI. Only the Bevy explorer does.`,
      instead: `Measuring again will not help. ${BY_HAND}`
    }
  }
  if (sdk !== null && !sdk.elementId) {
    const version = sdk.version === undefined ? '' : ` ${sdk.version}`
    return {
      reason: 'sdk-has-no-element-id',
      why: `This scene's @dcl/sdk${version} has no elementId in uiTransform, so none of its ${ui} UI nodes can be measured: elementId is only in the experimental Bevy SDK builds, which new editor scenes use.`,
      instead: `Do not write elementId in this scene's code: its SDK does not have it. ${BY_HAND} Tell the creator the UI could be measured if the project moved to the experimental SDK (npm install ${EXPERIMENTAL_SDK} in the project folder); it changes package.json, so leave that choice to them.`
    }
  }
  return {
    reason: 'no-element-ids',
    why: `None of the ${ui} UI nodes has an elementId: the engine measures only nodes with one.`,
    instead: sdk === null
      ? `If uiTransform has elementId in this project's SDK (check its type, never guess), give every button, panel and text a unique one and measure again. If it does not: ${BY_HAND}`
      : 'Give every button, panel, dialog and text a unique elementId in uiTransform and measure again.'
  }
}
