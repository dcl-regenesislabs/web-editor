import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { INSPECTOR_DEFAULT_TITLE } from '@dcl-editor/contract'
import { alignSceneOnOpen, guardSceneJson, renameScene, type SceneJsonGuard } from './scene-json-guard'
import { saveSceneSettings } from './scene-settings'

type Metadata = {
  name: string
  description?: string
  thumbnail?: string
  author?: string
  email?: string
  layout: { base: { x: number; y: number }; parcels: Array<{ x: number; y: number }> }
  spawnPoints?: unknown[]
}

// the copy the inspector puts in a composite it creates
const DEFAULT_METADATA: Metadata = {
  name: INSPECTOR_DEFAULT_TITLE,
  description: 'This is a test scene',
  thumbnail: 'assets/scene/thumbnail.png',
  author: '',
  email: '',
  layout: { base: { x: 0, y: 0 }, parcels: [{ x: 0, y: 0 }] }
}

const SCENE = {
  ecs7: true,
  runtimeVersion: '7',
  display: { title: 'Tower of Madness', description: 'Climb' },
  main: 'bin/index.js',
  scene: { parcels: ['0,0', '1,0', '0,1', '1,1'], base: '0,0' },
  spawnPoints: [{ name: 'Start', default: true, position: { x: 8, y: 0, z: 8 } }]
}

let dir: string
let guard: SceneJsonGuard | null = null
const lines: string[] = []
const log = (line: string): void => {
  lines.push(line)
}

const compositeFile = (): string => path.join(dir, 'assets', 'scene', 'main.composite')
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T
const sceneJson = (): typeof SCENE => readJson(path.join(dir, 'scene.json'))
const compositeMetadata = (): Metadata =>
  readJson<{ components: Array<{ name: string; data: Record<string, { json: Metadata }> }> }>(compositeFile())
    .components.find((c) => c.name.startsWith('inspector::SceneMetadata'))!.data['0'].json

function writeComposite(metadata: Metadata): void {
  fs.mkdirSync(path.dirname(compositeFile()), { recursive: true })
  fs.writeFileSync(compositeFile(), JSON.stringify({ version: 1, components: [{ name: 'inspector::SceneMetadata-v5', jsonSchema: {}, data: { '0': { json: metadata } } }] }))
}

// What the data layer writes on a Scene component update (scene_update): the composite's copy
// merged over scene.json, arrays replaced.
function sceneUpdate(metadata: Metadata): void {
  const scene = sceneJson()
  const next = {
    ...scene,
    display: { ...scene.display, title: metadata.name, description: metadata.description ?? '', navmapThumbnail: metadata.thumbnail ?? '' },
    contact: { name: metadata.author ?? '', email: metadata.email ?? '' },
    scene: { parcels: metadata.layout.parcels.map((p) => `${p.x},${p.y}`), base: `${metadata.layout.base.x},${metadata.layout.base.y}` },
    spawnPoints: metadata.spawnPoints ?? []
  }
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(next, null, 2))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-json-guard-'))
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(SCENE, null, 2))
  lines.length = 0
})

afterEach(() => {
  guard?.close()
  guard = null
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('an existing scene whose composite holds the inspector default metadata', () => {
  beforeEach(() => writeComposite(DEFAULT_METADATA))

  it('gets its composite fixed from scene.json on open, and scene.json is not touched', () => {
    const before = fs.readFileSync(path.join(dir, 'scene.json'), 'utf8')
    alignSceneOnOpen(dir, null, log)
    expect(fs.readFileSync(path.join(dir, 'scene.json'), 'utf8')).toBe(before)
    const meta = compositeMetadata()
    expect(meta.name).toBe('Tower of Madness')
    expect(meta.layout.parcels).toHaveLength(4)
  })

  it('keeps its parcels and title through a scene_update after open', () => {
    alignSceneOnOpen(dir, null, log)
    guard = guardSceneJson(dir, log, false)
    sceneUpdate(compositeMetadata())
    guard.check()
    expect(sceneJson().display.title).toBe('Tower of Madness')
    expect(sceneJson().scene).toEqual(SCENE.scene)
  })

  it('gets scene.json put back when a scene_update still carries the default', () => {
    guard = guardSceneJson(dir, log, false)
    sceneUpdate(DEFAULT_METADATA)
    expect(sceneJson().scene.parcels).toEqual(['0,0'])
    guard.check()
    expect(sceneJson()).toEqual(SCENE)
    expect(lines.some((l) => l.includes('put back'))).toBe(true)
  })

  it('keeps its parcels through a rename, which renames the composite too', () => {
    alignSceneOnOpen(dir, null, log)
    guard = guardSceneJson(dir, log, false)
    renameScene(dir, '  Renamed  ')
    guard.check()
    expect(sceneJson().display.title).toBe('Renamed')
    expect(sceneJson().scene).toEqual(SCENE.scene)
    expect(compositeMetadata().name).toBe('Renamed')
    expect(compositeMetadata().layout.parcels).toHaveLength(4)
    sceneUpdate(compositeMetadata())
    guard.check()
    expect(sceneJson().display.title).toBe('Renamed')
    expect(sceneJson().scene).toEqual(SCENE.scene)
  })

  it('renames the composite even when the scene was never opened', () => {
    renameScene(dir, 'Renamed')
    expect(compositeMetadata().name).toBe('Renamed')
    expect(compositeMetadata().layout.parcels).toHaveLength(4)
  })
})

describe('the creator editing the fields on purpose', () => {
  it('may name a one-parcel scene like the default', () => {
    guard = guardSceneJson(dir, log, false)
    const problem = saveSceneSettings(dir, {
      title: INSPECTOR_DEFAULT_TITLE,
      description: '',
      thumbnailPath: null,
      thumbnail: null,
      contactName: '',
      contactEmail: '',
      parcels: ['0,0'],
      base: '0,0',
      spawnPoints: []
    })
    expect(problem).toBeNull()
    guard.check()
    expect(sceneJson().display.title).toBe(INSPECTOR_DEFAULT_TITLE)
    expect(sceneJson().scene.parcels).toEqual(['0,0'])
  })
})

describe('a scene with no composite', () => {
  it('gets the template composite with its own metadata, not the default', () => {
    const template = path.join(dir, 'template.composite')
    fs.writeFileSync(template, JSON.stringify({ version: 1, components: [{ name: 'inspector::SceneMetadata-v5', jsonSchema: {}, data: { '0': { json: { name: 'New Scene', layout: { base: { x: 0, y: 0 }, parcels: [{ x: 0, y: 0 }] } } } } }] }))
    alignSceneOnOpen(dir, template, log)
    expect(compositeMetadata().name).toBe('Tower of Madness')
    expect(compositeMetadata().layout.parcels).toHaveLength(4)
  })
})
