import { describe, expect, it, vi } from 'vitest'
import { state } from '@scene/state'
import { runSceneChecks } from './scene-checks'
import { collectSceneCheckContext, isCheckedScript } from './scene-check-context'

describe('which files the scene checks read', () => {
  it('reads a .tsx script — the Announcer is one, and every rule was blind to it', () => {
    expect(isCheckedScript('custom/announcer/scripts/announcer.tsx')).toBe(true)
    expect(isCheckedScript('src/scripts/hud.tsx')).toBe(true)
  })

  it('reads a .ts script', () => {
    expect(isCheckedScript('src/scripts/race.ts')).toBe(true)
    expect(isCheckedScript('custom/tower/scripts/madness-race.ts')).toBe(true)
  })

  it('leaves the carried runtime modules and everything that is not a script', () => {
    expect(isCheckedScript('custom/announcer/scripts/runtime/game.ts')).toBe(false)
    expect(isCheckedScript('src/scripts/runtime/pure/gameCore.tsx')).toBe(false)
    expect(isCheckedScript('src/scene.json')).toBe(false)
    expect(isCheckedScript('node_modules/@dcl/sdk/index.ts')).toBe(false)
  })
})

vi.mock('../../engine/datalayer', () => ({
  dataLayerAvailable: () => true, dataLayerListFiles: async () => [],
  dataLayerWriteTick: () => 0, dataLayerReadFile: async () => '',
  dataLayerReadFileBytes: async () => new Uint8Array(0), dataLayerRealm: () => 'project', dataLayerPathTick: () => 0
}))

it('keeps the engine world origin when filtering code-spawned entities for bounds checks', async () => {
  state.initialBaseline = {
    '0': {}, '512': { Transform: { position: { x: 24, y: 0, z: 8 } } }
  }
  state.savedBaseline = null
  state.snapshot = { ...state.initialBaseline,
    '5': { Transform: { position: { x: -32, y: 0, z: 16 } } },
    '600': { Transform: { position: { x: 100, y: 0, z: 100 } } }
  }
  state.scene = { hash: 'test', title: 'Offset parcel', parcels: [{ x: 2, y: -1 }],
    isPortable: false, isBroken: false, isBlocked: false, isSuper: false, sdkVersion: '7' }
  const context = await collectSceneCheckContext()
  expect(context?.snapshot['600']).toBeUndefined()
  expect(context?.snapshot['5']).toBeDefined()
  expect(runSceneChecks(context!).filter(f => f.id === 'outside-scene-bounds').map(f => f.entityId)).toEqual(['512'])
})

it('hands the rules the parcel budget, so an over-budget scene is a finding like any other', async () => {
  const colours = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [String(512 + i), {
    Material: { material: { pbr: { albedoColor: { r: i / 21, g: 0, b: 0, a: 1 } } } }
  }]))
  state.initialBaseline = { '0': {}, ...colours }
  state.savedBaseline = null
  state.snapshot = { ...state.initialBaseline }
  state.scene = { hash: 'test', title: 'One parcel', parcels: [{ x: 0, y: 0 }],
    isPortable: false, isBroken: false, isBlocked: false, isSuper: false, sdkVersion: '7' }
  const context = await collectSceneCheckContext()
  expect(context?.budget).toMatchObject({ parcels: 1, over: ['materials'] })
  expect(runSceneChecks(context!).filter((f) => f.id === 'scene-over-budget').map((f) => f.title))
    .toEqual([`Too many materials (21 of ${context!.budget!.limits.materials})`])
})
