import { describe, expect, it } from 'vitest'
import { INSPECTOR_DEFAULT_TITLE, alignCompositeMetadata, guardSceneJsonWrite, type SceneJsonMetadata } from './scene-metadata'

// the copy the inspector writes into a composite that has none
const DEFAULT_METADATA = {
  name: INSPECTOR_DEFAULT_TITLE,
  description: 'This is a test scene',
  thumbnail: 'assets/scene/thumbnail.png',
  ageRating: 'T',
  skyboxConfig: { fixedTime: 36000, transitionMode: 0 },
  categories: [],
  author: '',
  email: '',
  tags: [],
  layout: { base: { x: 0, y: 0 }, parcels: [{ x: 0, y: 0 }] }
}

const composite = (metadata: Record<string, unknown>): string =>
  JSON.stringify({
    version: 1,
    components: [
      { name: 'inspector::Nodes', jsonSchema: {}, data: { '0': { json: { value: [] } } } },
      { name: 'inspector::SceneMetadata-v5', jsonSchema: {}, data: { '0': { json: metadata } } }
    ]
  })

const metadataOf = (text: string): Record<string, unknown> =>
  (JSON.parse(text) as { components: Array<{ name: string; data: Record<string, { json: Record<string, unknown> }> }> })
    .components.find((c) => c.name.startsWith('inspector::SceneMetadata'))!.data['0'].json

const SCENE: SceneJsonMetadata = {
  display: { title: 'Tower of Madness', description: 'Climb', navmapThumbnail: 'assets/images/tom.png' },
  contact: { name: 'SDK', email: '' },
  scene: { parcels: ['0,0', '1,0', '0,1', '1,1'], base: '1,0' },
  spawnPoints: [{ name: 'Start', default: true, position: { x: [4, 6], y: 0, z: 8 } }]
}

describe('composite scene metadata', () => {
  it('takes the title, parcels and spawn points of scene.json over the inspector default', () => {
    const aligned = alignCompositeMetadata(composite(DEFAULT_METADATA), SCENE)
    expect(aligned).not.toBeNull()
    const meta = metadataOf(aligned!)
    expect(meta.name).toBe('Tower of Madness')
    expect(meta.description).toBe('Climb')
    expect(meta.thumbnail).toBe('assets/images/tom.png')
    expect(meta.author).toBe('SDK')
    expect(meta.layout).toEqual({
      base: { x: 1, y: 0 },
      parcels: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]
    })
    expect(meta.spawnPoints).toEqual([
      { name: 'Start', default: true, position: { x: { $case: 'range', value: [4, 6] }, y: { $case: 'single', value: 0 }, z: { $case: 'single', value: 8 } } }
    ])
    // what scene.json leaves out is left out: the write-back would otherwise put the default's values there
    expect(meta.skyboxConfig).toBeUndefined()
    expect(meta.ageRating).toBeUndefined()
  })

  it('carries every field the inspector writes back, so a default copy resets none of them', () => {
    const scene: SceneJsonMetadata = {
      ...SCENE,
      creator: '0xabc',
      tags: ['game', 'parkour', 'social'],
      featureToggles: { voiceChat: 'disabled', portableExperiences: 'enabled', nearbyVoiceChat: 'disabled' },
      landscapeTerrain: false,
      rating: 'A',
      skyboxConfig: { fixedTime: 43200 },
      spawnPoints: [{ name: '', position: { x: 1, y: 0, z: 1 } }]
    }
    const meta = metadataOf(alignCompositeMetadata(composite(DEFAULT_METADATA), scene)!)
    expect(meta).toMatchObject({
      creator: '0xabc',
      categories: ['game', 'social'],
      tags: ['parkour'],
      silenceVoiceChat: true,
      disableNearbyVoiceChat: true,
      hideLandscapeTerrain: true,
      ageRating: 'A',
      skyboxConfig: { fixedTime: 43200 }
    })
    // an empty spawn point name gets the inspector's own fallback, so the next open finds nothing to change
    expect((meta.spawnPoints as Array<{ name: string }>)[0].name).toBe('Spawn Point 1')
    expect(alignCompositeMetadata(composite(meta), scene)).toBeNull()
  })

  it('leaves a composite that already matches, or has no metadata, alone', () => {
    const aligned = alignCompositeMetadata(composite(DEFAULT_METADATA), SCENE)!
    expect(alignCompositeMetadata(aligned, SCENE)).toBeNull()
    expect(alignCompositeMetadata(JSON.stringify({ version: 1, components: [] }), SCENE)).toBeNull()
    expect(alignCompositeMetadata('not json', SCENE)).toBeNull()
  })

  it('does not touch the layout when scene.json has no usable parcels', () => {
    const aligned = alignCompositeMetadata(composite(DEFAULT_METADATA), { display: { title: 'X' } })!
    expect(metadataOf(aligned).layout).toEqual(DEFAULT_METADATA.layout)
  })
})

describe('scene.json write guard', () => {
  // what the inspector's write-back of its default copy makes of SCENE
  const overwritten: SceneJsonMetadata = {
    ...SCENE,
    display: { title: INSPECTOR_DEFAULT_TITLE, description: 'This is a test scene', navmapThumbnail: 'assets/scene/thumbnail.png' },
    contact: { name: '', email: '' },
    scene: { parcels: ['0,0'], base: '0,0' },
    spawnPoints: []
  }

  it('puts back the whole scene.json a default copy overwrote', () => {
    expect(guardSceneJsonWrite(SCENE, overwritten)).toEqual(SCENE)
  })

  it('puts back the title alone when only the title is the default', () => {
    const next = { ...SCENE, display: { ...SCENE.display, title: INSPECTOR_DEFAULT_TITLE } }
    expect(guardSceneJsonWrite(SCENE, next)).toEqual(SCENE)
  })

  it('puts back parcels shrunk to the default one', () => {
    const next = { ...SCENE, scene: { parcels: ['0,0'], base: '0,0' } }
    expect(guardSceneJsonWrite(SCENE, next)?.scene).toEqual(SCENE.scene)
  })

  it('keeps every other write', () => {
    expect(guardSceneJsonWrite(SCENE, { ...SCENE, display: { ...SCENE.display, title: 'Renamed' } })).toBeNull()
    expect(guardSceneJsonWrite(SCENE, { ...SCENE, scene: { parcels: ['1,0', '1,1'], base: '1,0' } })).toBeNull()
    expect(guardSceneJsonWrite(SCENE, { ...SCENE, spawnPoints: [] })).toBeNull()
    // a scene that already is the default has nothing to lose
    expect(guardSceneJsonWrite(overwritten, { ...overwritten, spawnPoints: [] })).toBeNull()
  })
})
