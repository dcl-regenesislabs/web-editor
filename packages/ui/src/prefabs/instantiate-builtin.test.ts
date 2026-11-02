// The built-in prefabs, placed through the real instantiatePrefab against an engine that, like
// /set_component, refuses a protocol component carrying the SDK's `$case` oneof form.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isCustomComponent } from '@scene/custom-components'
import { prefabFolders, readPrefabFile } from './builtin-fixtures'

const h = vi.hoisted(() => ({
  state: { snapshot: {} as Record<string, Record<string, unknown>>, frozen: true, activeEntity: null as string | null },
  nextId: 600,
  refused: [] as string[]
}))

vi.mock('@scene/state', () => ({ state: h.state, setSelected: () => {} }))
vi.mock('@scene/inspector', () => ({
  allocateNamedEntities: async (names: Array<{ value: string }>) => names.map(() => h.nextId++),
  writeComponent: async (id: string, name: string, json: string) => {
    if (!isCustomComponent(name) && json.includes('"$case"')) {
      h.refused.push(name)
      throw new Error("invalid JSON: unknown variant `$case`, expected one of `box`, `sphere`, `cylinder`, `plane`, `gltf`")
    }
    h.state.snapshot[id] = { ...h.state.snapshot[id], [name]: JSON.parse(json) as unknown }
  },
  reloadSnapshot: async () => {}
}))
vi.mock('../panels/reveal', () => ({ revealInTree: () => {} }))
vi.mock('../assets', () => ({ ensureContentMapped: async () => true }))
vi.mock('../engine/datalayer', () => ({
  // custom/<prefab>/… is the prefab's own folder on disk
  dataLayerReadFile: async (path: string) => readPrefabFile(path.replace(/^custom\//, ''))
}))
vi.mock('./storage', () => ({
  mergeRequiredPermissions: async () => [],
  readPrefabFolder: async (folder: string) => {
    const name = folder.replace(/^custom\//, '')
    return {
      folder,
      data: JSON.parse(readPrefabFile(`${name}/data.json`)) as unknown,
      composite: parsePrefabComposite(readPrefabFile(`${name}/composite.json`), folder)
    }
  }
}))

import { instantiatePrefab } from './instantiate'
import { parsePrefabComposite } from './format'

const ONEOF = /"\$case"/
const withOneof = prefabFolders().filter((name) => ONEOF.test(readPrefabFile(`${name}/composite.json`)))

beforeEach(() => {
  h.state.snapshot = { '0': {} }
  h.nextId = 600
  h.refused = []
})

describe('placing a built-in prefab', () => {
  it('covers the prefabs whose primitives are stored in oneof form', () => {
    expect(withOneof).toEqual(expect.arrayContaining(['pickup-item', 'sit-spot', 'spawner', 'video-screen', 'work-station']))
  })

  it.each(withOneof)('%s reaches the engine with every component', async (name) => {
    const placed = await instantiatePrefab(`custom/${name}`, { x: 8, y: 0, z: 8 })
    expect(h.refused).toEqual([])
    expect(placed.warnings.filter((w) => w.includes('could not be written'))).toEqual([])
  })
})
