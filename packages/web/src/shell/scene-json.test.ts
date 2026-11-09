import { expect, it } from 'vitest'
import { applyAssistantSettings, compositeFixes } from './scene-json'

const raw = { display: { title: 'Tower' }, scene: { parcels: ['0,0'], base: '0,0' }, main: 'bin/index.js' }

it('lets the assistant grow the scene into one connected area, keeping its base and the rest of scene.json', () => {
  expect(applyAssistantSettings(raw, { parcels: ['0,0', '1,0', '0,1', '1,1'] })).toEqual({
    display: { title: 'Tower' }, scene: { parcels: ['0,0', '1,0', '0,1', '1,1'], base: '0,0' }, main: 'bin/index.js'
  })
  expect(applyAssistantSettings(raw, { parcels: ['5,5', '5,6'] }).scene).toEqual({ parcels: ['5,5', '5,6'], base: '5,5' })
  expect(() => applyAssistantSettings(raw, { parcels: ['0,0', '2,0'] })).toThrow('connected')
  expect(() => applyAssistantSettings(raw, { parcels: ['0,0', '1,0'], base: '3,3' })).toThrow('base')
  expect(() => applyAssistantSettings(raw, { parcels: ['0,0', '0,0'] })).toThrow('duplicates')
  expect(() => applyAssistantSettings(raw, { parcels: 'everything' })).toThrow('parcels')
})

it('fixes a composite holding the inspector default metadata from scene.json, not the other way round', () => {
  const scene = new TextEncoder().encode(JSON.stringify({ display: { title: 'Tower' }, scene: { parcels: ['0,0', '1,0'], base: '0,0' } }))
  const composite = new TextEncoder().encode(JSON.stringify({
    version: 1,
    components: [{ name: 'inspector::SceneMetadata-v5', jsonSchema: {}, data: { '0': { json: { name: 'Test Scene', layout: { base: { x: 0, y: 0 }, parcels: [{ x: 0, y: 0 }] } } } } }]
  }))
  const fixes = compositeFixes(scene, composite)
  expect(fixes.map(([path]) => path)).toEqual(['assets/scene/main.composite'])
  const meta = JSON.parse(new TextDecoder().decode(fixes[0][1])).components[0].data['0'].json
  expect(meta.name).toBe('Tower')
  expect(meta.layout.parcels).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }])
  expect(compositeFixes(scene, fixes[0][1])).toEqual([])
  expect(compositeFixes(undefined, composite)).toEqual([])
  expect(compositeFixes(scene, undefined)).toEqual([])
})
