// A scene made with Creator Hub's current Admin Tools (creator-hub#1748) opens
// here: the item is an `asset-packs::Placeholder` plus an `asset-packs::Script`
// running AdminTools.ts, and no `asset-packs::AdminTools` component. Both files
// are Creator Hub's own, copied into creator-hub-fixtures/.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildComposite, snapshotComponentName, unknownComponentNames } from '@scene/composite'
import { getScriptParams, layoutOf, mergeLayout, parseLayout, type ScriptLayout } from './parser'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'creator-hub-fixtures')
// what Creator Hub writes into main.composite when the item is placed
const ASSET_DIR = 'assets/asset-packs/admin_toolkit'
const placed = JSON.parse(
  readFileSync(path.join(fixturesDir, 'admin_toolkit.composite.json'), 'utf8').split('{assetPath}').join(ASSET_DIR)
) as { components: Array<{ name: string; data: Record<string, { json: unknown }> }> }
const script = readFileSync(path.join(fixturesDir, 'AdminTools.ts.txt'), 'utf8')

const ENTITY = '512'

function snapshotOf(): Record<string, Record<string, unknown>> {
  const components: Record<string, unknown> = {}
  for (const component of placed.components) {
    const name = snapshotComponentName(component.name)
    if (name !== undefined) components[name] = component.data['0'].json
  }
  return { [ENTITY]: components }
}

function storedLayout(): ScriptLayout {
  const entry = placed.components.find((c) => c.name === 'asset-packs::Script')?.data['0'].json as {
    value: Array<{ path: string; layout: string }>
  }
  expect(entry.value[0].path).toBe(`${ASSET_DIR}/AdminTools.ts`)
  const layout = parseLayout(entry.value[0].layout)
  if (layout === undefined) throw new Error('the stored layout did not parse')
  return layout
}

describe("Creator Hub's Admin Tools in this editor", () => {
  it('carries only components this editor decodes and saves', () => {
    expect(placed.components.map((c) => c.name)).toEqual(['asset-packs::Placeholder', 'asset-packs::Script'])
    for (const component of placed.components) expect(snapshotComponentName(component.name)).toBeDefined()
    expect(unknownComponentNames(snapshotOf())).toEqual([])
  })

  it('saves the item back unchanged', () => {
    const saved = JSON.parse(buildComposite(snapshotOf())) as { components: Array<{ name: string; data: Record<string, { json: unknown }> }> }
    for (const original of placed.components) {
      const written = saved.components.find((c) => c.name === original.name)
      expect(written?.data[ENTITY].json).toEqual(original.data['0'].json)
    }
  })

  it('reads the same params from AdminTools.ts that Creator Hub stored', () => {
    const stored = storedLayout()
    const fresh = layoutOf(getScriptParams(script))
    expect(fresh.error).toBeUndefined()
    expect(Object.keys(fresh.params)).toEqual(Object.keys(stored.params))
    for (const [name, param] of Object.entries(fresh.params)) {
      expect(param.type).toBe(stored.params[name].type)
      expect(param.value).toEqual(stored.params[name].value)
    }
  })

  it("keeps the creator's configuration when the inspector parses the script again", () => {
    const stored = storedLayout()
    stored.params.smartItemsControl.value = {
      isEnabled: true,
      linkAllSmartItems: false,
      smartItems: [{ entity: 520, customName: 'Front door', defaultAction: 'Open' }]
    }
    stored.params.videoControl.value = {
      isEnabled: true,
      disableVideoPlayersSound: true,
      showAuthorOnVideoPlayers: false,
      linkAllVideoPlayers: false,
      videoPlayers: [{ entity: 530, customName: 'Stage' }]
    }
    stored.params.adminPermissions.value = 'PRIVATE'
    const merged = mergeLayout(layoutOf(getScriptParams(script)), stored)
    for (const name of Object.keys(stored.params)) expect(merged.params[name].value).toEqual(stored.params[name].value)
    expect(merged.params.smartItemsControl.fields?.smartItems.item?.fields?.defaultAction).toMatchObject({ actionsOf: 'entity' })
  })
})
