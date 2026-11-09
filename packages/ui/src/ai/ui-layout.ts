// The scene's screen UI as the engine laid it out right now, on whatever the game runs as: the
// desktop canvas, or a 1600x720 phone when playtesting started with platform mobile. Measuring
// changes nothing, so a dialog opened by playtest click or input is measured open. With check,
// it runs the whole phone check instead (mobile-check.ts).
import { state } from '@scene/state'
import { cmd } from '../engine/cmd'
import { mobileCheck, type ProjectSources } from './mobile-check'
import { playtestPlatform } from './playtest'
import { measuredNodes, unmeasurable, type Components, type SceneSdk } from './ui-measure'
import { captureView } from './view'

/** What the desktop editor knows about the scene's installed SDK; the web build uses the editor's own. */
export type SceneSdkProbe = () => Promise<SceneSdk | null>

const LAYOUT_SETTLE_MS = 500

function measure(snapshot: Record<string, Components>, sdk: SceneSdk | null): Record<string, unknown> {
  const root = snapshot['0'] ?? {}
  const blocked = unmeasurable(snapshot, sdk)
  if (blocked !== null) return { canvas: root.UiCanvasInformation, measured: false, unmeasurable: blocked.reason, why: blocked.why, instead: blocked.instead }
  const { nodes, unnamed } = measuredNodes(snapshot)
  return {
    canvas: root.UiCanvasInformation,
    measured: true,
    nodes,
    ...(nodes.length === 0 ? { note: 'no measured node is on screen now: open the panel or dialog (playtest click or input) and measure again' } : {}),
    ...(unnamed > 0 ? { unmeasured: `${unnamed} UI nodes have no elementId and were not measured` } : {})
  }
}

export async function uiLayout(request: Record<string, unknown>, signal: AbortSignal, sources?: ProjectSources, sdk?: SceneSdkProbe): Promise<unknown> {
  signal.throwIfAborted()
  const probe = async (): Promise<SceneSdk | null> => sdk === undefined ? null : await sdk()
  if (request.check === true) {
    if (sources === undefined) throw new Error('The mobile check needs the project files.')
    return mobileCheck(signal, sources, await probe())
  }
  if (state.frozen) throw new Error('Start playtesting first (platform mobile for the phone layout): the UI is laid out while the game runs.')
  const scene = await probe()
  let layout = measure(await cmd.crdtSnapshot(), scene)
  // right after a playtest starts the engine can write the layout a frame or two late: look again before blaming it
  if (layout.unmeasurable === 'explorer-has-no-layout-feedback') {
    await new Promise((resolve) => setTimeout(resolve, LAYOUT_SETTLE_MS))
    signal.throwIfAborted()
    layout = measure(await cmd.crdtSnapshot(), scene)
  }
  signal.throwIfAborted()
  const view = await captureView({ entity: null, from: null, lookAt: null }, signal)
  return { platform: playtestPlatform(), ...layout, view }
}
