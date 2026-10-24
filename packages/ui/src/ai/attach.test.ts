import { describe, expect, it, vi } from 'vitest'
import { scriptAttacher } from './attach'

const { snapshot, setValue } = vi.hoisted(() => {
  const snapshot: Record<string, Record<string, unknown>> = {}
  const setValue = vi.fn(async (_key: string, id: string, component: string, json: string) => {
    snapshot[id][component] = JSON.parse(json)
  })
  return { snapshot, setValue }
})
vi.mock('@scene/state', () => ({
  state: { snapshot, activeEntity: null },
  componentKey: (id: string, name: string) => `${id}:${name}`,
  isUiEntity: () => false
}))
vi.mock('@scene/custom-components', () => ({ entityName: () => 'Tower HUD', NAME_COMPONENT: 'core::Name' }))
vi.mock('../actions/components', () => ({ uiSetComponentValue: setValue, uiAddComponent: vi.fn() }))
vi.mock('../engine/datalayer', () => ({ dataLayerReadFile: vi.fn() }))

const PATH = 'src/scripts/TowerHud.tsx'
const source = (fields: string) => `export class TowerHud {\n  constructor(public src: string, public entity: Entity, ${fields}) {}\n}\n`

const holder = (params: Record<string, { type: string; value: unknown }>) => ({
  'asset-packs::Script': { value: [{ path: PATH, priority: 0, layout: JSON.stringify({ params, actions: [] }) }] }
})
const paramsOf = (id: string) =>
  JSON.parse((snapshot[id]['asset-packs::Script'] as { value: Array<{ layout: string }> }).value[0].layout).params as Record<string, { value: unknown }>

describe('scriptAttacher', () => {
  it('keeps the configured values when a rewrite does not parse', async () => {
    snapshot['549'] = holder({ courseId: { type: 'string', value: 'summit' } })
    await scriptAttacher()(PATH, `export class TowerHud {\n  constructor(public src: string, public entity: Entity, public courseId: string = 'tower'\n`, false)
    expect(paramsOf('549').courseId.value).toBe('summit')
  })


  it('refreshes the settings of a script an earlier turn attached when this turn rewrites it', async () => {
    snapshot['548'] = {
      'asset-packs::Script': {
        value: [{ path: PATH, priority: 0, layout: JSON.stringify({ params: { courseId: { type: 'string', value: 'tower' } }, actions: [] }) }]
      }
    }
    await scriptAttacher()(PATH, source(`public courseId: string = 'tower', public title: string = 'Tower'`), false)
    const [item] = (snapshot['548']['asset-packs::Script'] as { value: Array<{ layout: string }> }).value
    expect(Object.keys(JSON.parse(item.layout).params)).toEqual(['courseId', 'title'])
  })
})
