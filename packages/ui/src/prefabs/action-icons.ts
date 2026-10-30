// The action-icon PNGs a scene's touch buttons and HUD hints draw (runtime-modules/actionIcons.tsx).
//
// A texture has to be a file in the scene, so these travel the way the runtime modules do, but only into
// a project whose runtime holds actionIcons.tsx: a scene that never names an icon ships none. Written only
// where no file stands, so a creator who redraws one keeps theirs. Sources and the script that renders
// them: packages/desktop/runtime-assets/action-icons/, scripts/build-action-icons.mjs.
import { dataLayerSaveFileBytes } from '../engine/datalayer'
import { ACTION_ICON_PNGS } from './action-icon-data'

export const ACTION_ICONS_MODULE = 'actionIcons.tsx'
export const ACTION_ICON_DIR = 'assets/images/action-icons'

const ICONS: Record<string, Uint8Array> = Object.fromEntries(
  Object.entries(ACTION_ICON_PNGS).map(([name, base64]) => [name, Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))])
)

/** The shipped icon files, by file name. */
export function actionIconFiles(): Record<string, Uint8Array> {
  return ICONS
}

/** The icons a project's runtime needs and lacks, as scene paths. */
export function missingActionIcons(runtimeModules: string[], files: string[]): string[] {
  if (!runtimeModules.includes(ACTION_ICONS_MODULE)) return []
  const present = new Set(files)
  return Object.keys(ICONS).sort().map((name) => `${ACTION_ICON_DIR}/${name}`).filter((path) => !present.has(path))
}

/** Writes the icons the project lacks; returns the paths written. */
export async function vendorActionIcons(runtimeModules: string[], files: string[]): Promise<string[]> {
  const missing = missingActionIcons(runtimeModules, files)
  for (const path of missing) await dataLayerSaveFileBytes(path, ICONS[path.slice(ACTION_ICON_DIR.length + 1)])
  return missing
}
