// The scene's screen UI as the engine laid it out right now, on whatever the game runs as: the
// desktop canvas, or a 1600x720 phone when playtesting started with platform mobile. Measuring
// changes nothing, so a dialog opened by playtest click or input is measured open. With check,
// it runs the whole phone check instead (mobile-check.ts).
import { state } from '@scene/state'
import { cmd } from '../engine/cmd'
import { mobileCheck, type ProjectSources } from './mobile-check'
import { playtestPlatform } from './playtest'
import { measuredNodes, type Components } from './ui-measure'
import { captureView } from './view'

function measure(snapshot: Record<string, Components>): Record<string, unknown> {
  const root = snapshot['0'] ?? {}
  const { nodes, unnamed } = measuredNodes(snapshot)
  if (nodes.length === 0 && unnamed > 0) {
    throw new Error(`None of the ${unnamed} UI nodes has an elementId: the engine measures only nodes with one. If this project's SDK has elementId in uiTransform, give every button, panel and text a unique one and measure again; if it does not, check the layout rules by hand from the code and a view picture.`)
  }
  return {
    canvas: root.UiCanvasInformation,
    nodes,
    ...(unnamed > 0 ? { unmeasured: `${unnamed} UI nodes have no elementId and were not measured` } : {})
  }
}

export async function uiLayout(request: Record<string, unknown>, signal: AbortSignal, sources?: ProjectSources): Promise<unknown> {
  signal.throwIfAborted()
  if (request.check === true) {
    if (sources === undefined) throw new Error('The mobile check needs the project files.')
    return mobileCheck(signal, sources)
  }
  if (state.frozen) throw new Error('Start playtesting first (platform mobile for the phone layout): the UI is laid out while the game runs.')
  const layout = measure(await cmd.crdtSnapshot())
  signal.throwIfAborted()
  const view = await captureView({ entity: null, from: null, lookAt: null }, signal)
  return { platform: playtestPlatform(), ...layout, view }
}
