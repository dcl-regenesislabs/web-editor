import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ACTION_ICON_DIR, actionIconFiles, missingActionIcons } from './action-icons'

const ASSETS = fileURLToPath(new URL('../../../desktop/runtime-assets/action-icons/', import.meta.url))
const MODULE = readFileSync(fileURLToPath(new URL('../../../desktop/runtime-modules/actionIcons.tsx', import.meta.url)), 'utf8')

describe('the shipped action icons', () => {
  it('are the PNGs rendered from the sources, byte for byte', () => {
    const files = actionIconFiles()
    const sources = readdirSync(ASSETS).filter((name) => name.endsWith('.svg')).map((name) => name.replace(/\.svg$/, '.png')).sort()
    expect(Object.keys(files).sort()).toEqual(sources)
    for (const name of sources) expect(Buffer.from(files[name]).equals(readFileSync(`${ASSETS}${name}`))).toBe(true)
  })

  it('are exactly the names and folder the runtime module promises', () => {
    const names = /ACTION_ICONS = \[([^\]]+)\]/.exec(MODULE)?.[1].match(/'[^']+'/g)?.map((quoted) => `${quoted.slice(1, -1)}.png`)
    expect(names?.sort()).toEqual(Object.keys(actionIconFiles()).sort())
    expect(MODULE).toContain(`ACTION_ICON_DIR = '${ACTION_ICON_DIR}'`)
  })

  it('are only wanted by a runtime holding the icon module, and only where no file stands', () => {
    expect(missingActionIcons(['hudLayout.tsx', 'uiTheme.ts'], [])).toEqual([])
    const missing = missingActionIcons(['actionIcons.tsx'], [`${ACTION_ICON_DIR}/chop.png`])
    expect(missing).toHaveLength(Object.keys(actionIconFiles()).length - 1)
    expect(missing).not.toContain(`${ACTION_ICON_DIR}/chop.png`)
  })
})
