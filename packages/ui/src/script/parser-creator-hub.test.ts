// What Creator Hub's parser learned after the port: Slider and negative defaults
// (creator-hub#1513), @event (#1604), object and array params (#1667) and the
// @components / @actionsOf / @format editor hints (#1748). The inline cases are
// creator-hub's own parser.spec.ts and utils.spec.ts; the fixtures are real
// smart-item scripts copied from Creator Hub (see creator-hub-fixtures/README.md).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getScriptParams, layoutOf, mergeLayout, type ScriptLayout } from './parser'

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'creator-hub-fixtures')
const fixture = (name: string): string => readFileSync(path.join(fixturesDir, name), 'utf8')

function classScript(constructorParams: string, leadingComment = ''): string {
  return `
import { Entity } from '@dcl/sdk/ecs'

export class TestScript {
  ${leadingComment}
  constructor(
    public src: string,
    public entity: Entity,
    ${constructorParams}
  ) {}
}
`
}

describe('Slider<min, max, step> (creator-hub#1513)', () => {
  it('reads the declared range and the default', () => {
    const { params } = getScriptParams(classScript('public speed: Slider<0, 10, 0.5> = 1,'))
    expect(params.speed).toEqual({ type: 'slider', value: 1, min: 0, max: 10, step: 0.5, optional: true })
  })

  it('defaults the step to 1', () => {
    const { params } = getScriptParams(classScript('public volume: Slider<0, 100> = 50,'))
    expect(params.volume).toMatchObject({ type: 'slider', min: 0, max: 100, step: 1, value: 50 })
  })

  it('reads negative bounds and a negative default', () => {
    expect(getScriptParams(classScript('public tilt: Slider<-90, 90> = 0,')).params.tilt).toMatchObject({
      type: 'slider', min: -90, max: 90, value: 0
    })
    expect(getScriptParams(classScript('public depth: Slider<-100, -10, 10> = -50,')).params.depth).toMatchObject({
      type: 'slider', min: -100, max: -10, value: -50
    })
  })

  it('starts at the minimum without a default, and clamps one out of range', () => {
    expect(getScriptParams(classScript('public speed: Slider<2, 10>,')).params.speed).toMatchObject({ value: 2 })
    expect(getScriptParams(classScript('public speed: Slider<0, 10> = 50,')).params.speed).toMatchObject({ value: 10 })
  })

  it('degrades to a number without valid literal bounds', () => {
    for (const declared of ['Slider', 'Slider<10, 0>', 'Slider<0, 10, 0>']) {
      const { params } = getScriptParams(classScript(`public speed: ${declared} = 3,`))
      expect(params.speed).toMatchObject({ type: 'number', value: 3 })
    }
  })

  it('reads a slider in a function-style script', () => {
    const { params } = getScriptParams('export function start(src: string, entity: Entity, speed: Slider<0, 10> = 5) {}')
    expect(params.speed).toMatchObject({ type: 'slider', value: 5, min: 0, max: 10, step: 1 })
  })

  it("reads Creator Hub's locomotion settings, which declare Slider as a local alias", () => {
    const { params, error } = getScriptParams(fixture('locomotion-settings.ts.txt'))
    expect(error).toBeUndefined()
    expect(Object.keys(params)).toHaveLength(9)
    expect(params.walkSpeed).toMatchObject({ type: 'slider', value: 1.5, min: 0, max: 10, step: 0.1 })
    expect(params.hardLandingCooldown).toMatchObject({ type: 'slider', value: 0.75, min: 0, max: 5, step: 0.05 })
  })
})

describe('negative defaults (creator-hub#1513)', () => {
  it('keeps the number, annotated or not', () => {
    expect(getScriptParams(classScript('public offset: number = -5,')).params.offset).toMatchObject({ type: 'number', value: -5 })
    expect(getScriptParams(classScript('public offset = -50,')).params.offset).toMatchObject({ type: 'number', value: -50 })
  })
})

describe('@event (creator-hub#1604)', () => {
  it('extracts the event names from the constructor JSDoc', () => {
    const { events } = getScriptParams(classScript('public onlyMe: boolean = false,', '/**\n   * @event enter\n   * @event exit\n   */'))
    expect(events).toEqual(['enter', 'exit'])
  })

  it('is empty without @event tags, and the layout then carries none', () => {
    const result = getScriptParams(classScript('public speed: number = 1,'))
    expect(result.events).toEqual([])
    expect(layoutOf(result)).not.toHaveProperty('events')
  })

  it("reads the open and close events of Creator Hub's door", () => {
    const result = getScriptParams(fixture('Door.ts.txt'))
    expect(result.error).toBeUndefined()
    expect(result.events).toEqual(['open', 'close'])
    expect(layoutOf(result).events).toEqual(['open', 'close'])
    expect(result.params.hoverText).toMatchObject({ type: 'string', value: 'Open / Close' })
  })

  it('keeps the fresh events through mergeLayout', () => {
    const fresh: ScriptLayout = { params: {}, events: ['open', 'close'] }
    expect(mergeLayout(fresh, { params: {}, events: ['stale'] }).events).toEqual(['open', 'close'])
    expect(mergeLayout({ params: {} }, { params: {}, events: ['stale'] })).not.toHaveProperty('events')
  })
})

describe('object and array params (creator-hub#1667)', () => {
  it('parses `string[]` and `Array<T>` as lists', () => {
    expect(getScriptParams(classScript('public tags: string[],')).params.tags).toMatchObject({
      type: 'array', value: [], item: { type: 'string' }
    })
    expect(getScriptParams(classScript('public tags: Array<number>,')).params.tags).toMatchObject({
      type: 'array', value: [], item: { type: 'number' }
    })
    expect(getScriptParams(classScript("public tags: string[] = ['a', 'b'],")).params.tags).toMatchObject({
      type: 'array', value: ['a', 'b']
    })
  })

  it('still reads PrefabRef[] as the prefab list, not a generic array', () => {
    expect(getScriptParams(classScript("public arenas: PrefabRef[] = ['x'],")).params.arenas).toMatchObject({
      type: 'prefabList', value: ['x']
    })
  })

  it('parses a list of objects with entity and action members', () => {
    const { params } = getScriptParams(classScript('public items: Array<{ entity: Entity; onDo: ActionCallback; label: string }>,'))
    expect(params.items).toMatchObject({
      type: 'array',
      item: { type: 'object', fields: { entity: { type: 'entity' }, onDo: { type: 'action' }, label: { type: 'string' } } }
    })
  })

  it('gives an inline object type its fields and type-derived defaults', () => {
    const { params } = getScriptParams(classScript('public coords: { x: number; y: number; z: number },'))
    expect(params.coords).toMatchObject({
      type: 'object',
      value: { x: 0, y: 0, z: 0 },
      fields: { x: { type: 'number', value: 0 }, y: { type: 'number', value: 0 }, z: { type: 'number', value: 0 } }
    })
  })

  it('keeps an authored object default, filling keys it could not evaluate', () => {
    expect(getScriptParams(classScript('public cfg: { enabled: boolean; count: number } = { enabled: true, count: 3 },')).params.cfg)
      .toMatchObject({ value: { enabled: true, count: 3 } })
    expect(getScriptParams(classScript('public cfg: { a: number; b: number } = { a: 5, b: someConst },')).params.cfg)
      .toMatchObject({ value: { a: 5, b: 0 } })
  })

  it('recurses into object-in-object', () => {
    const { params } = getScriptParams(classScript('public group: { pos: { x: number }; on: boolean } = { pos: { x: 5 }, on: true },'))
    expect(params.group).toMatchObject({
      value: { pos: { x: 5 }, on: true },
      fields: { pos: { type: 'object', fields: { x: { type: 'number' } } }, on: { type: 'boolean' } }
    })
  })

  it('reads a named type it cannot resolve through its default, not as a string', () => {
    expect(getScriptParams(classScript('public config: DoorConfig = { speed: 1, open: false },')).params.config).toMatchObject({
      type: 'object',
      value: { speed: 1, open: false },
      fields: { speed: { type: 'number' }, open: { type: 'boolean' } }
    })
    expect(getScriptParams(classScript("public label: Label = 'hi',")).params.label).toMatchObject({ type: 'string', value: 'hi' })
  })

  it('infers the shape of an unannotated object default', () => {
    expect(getScriptParams(classScript('public cfg = { on: true, rows: [1, 2] },')).params.cfg).toMatchObject({
      type: 'object',
      value: { on: true, rows: [1, 2] },
      fields: { on: { type: 'boolean' }, rows: { type: 'array', item: { type: 'number' } } }
    })
  })
})

describe('@components, @actionsOf and @format wallet (creator-hub#1748)', () => {
  it('narrows an entity to the named components', () => {
    const { params } = getScriptParams(classScript(`
        /** @components asset-packs::Actions, asset-packs::VideoScreen */
        public target: Entity,`))
    expect(params.target).toMatchObject({ type: 'entity', components: ['asset-packs::Actions', 'asset-packs::VideoScreen'] })
  })

  it('leaves untagged params as they were', () => {
    const { params } = getScriptParams(classScript('public target: Entity, public label: string,'))
    expect(params.target).toEqual({ type: 'entity', value: 0, optional: false })
    expect(params.label).toEqual({ type: 'string', value: '', optional: false })
  })

  it("reads Creator Hub's Admin Tools script", () => {
    const { params, error } = getScriptParams(fixture('AdminTools.ts.txt'))
    expect(error).toBeUndefined()
    expect(Object.keys(params)).toEqual([
      'adminPermissions',
      'authorizedAdminUsers',
      'moderationControl',
      'textAnnouncementControl',
      'videoControl',
      'smartItemsControl'
    ])
    expect(params.adminPermissions).toMatchObject({ type: 'enum', value: 'PUBLIC', options: ['PUBLIC', 'PRIVATE'] })
    expect(params.authorizedAdminUsers).toMatchObject({
      type: 'object',
      value: { me: true, sceneOwners: true, allowList: true, adminAllowList: [] },
      fields: { adminAllowList: { type: 'array', item: { type: 'string', format: 'wallet' } } }
    })
    expect(params.moderationControl).toMatchObject({
      value: { isEnabled: true, kickCoordinates: { x: 0, y: 0, z: 0 }, allowNonOwnersManageAdminAllowList: false }
    })
    expect(params.videoControl.fields?.videoPlayers).toMatchObject({
      type: 'array',
      item: { type: 'object', fields: { entity: { type: 'entity', components: ['asset-packs::VideoScreen'] }, customName: { type: 'string' } } }
    })
    expect(params.smartItemsControl).toMatchObject({
      value: { isEnabled: true, linkAllSmartItems: false, smartItems: [] },
      fields: {
        smartItems: {
          item: {
            fields: {
              entity: { type: 'entity', components: ['asset-packs::Actions'] },
              defaultAction: { type: 'string', actionsOf: 'entity' }
            }
          }
        }
      }
    })
  })
})

describe('mergeLayout reconciles nested values (creator-hub#1513, #1667)', () => {
  it('takes the range from the fresh slider and clamps the stored value into it', () => {
    const source: ScriptLayout = { params: { speed: { type: 'slider', value: 1, min: 0, max: 20, step: 2 } } }
    expect(mergeLayout(source, { params: { speed: { type: 'slider', value: 8, min: 0, max: 10, step: 0.5 } } }).params.speed)
      .toEqual({ type: 'slider', value: 8, min: 0, max: 20, step: 2 })
    const narrower: ScriptLayout = { params: { speed: { type: 'slider', value: 0, min: 0, max: 5, step: 1 } } }
    expect(mergeLayout(narrower, { params: { speed: { type: 'slider', value: 8, min: 0, max: 10, step: 1 } } }).params.speed)
      .toMatchObject({ value: 5 })
  })

  it('drops a stored number when the param became a slider', () => {
    const source: ScriptLayout = { params: { speed: { type: 'slider', value: 1, min: 0, max: 10, step: 1 } } }
    expect(mergeLayout(source, { params: { speed: { type: 'number', value: 42 } } }).params.speed).toMatchObject({ value: 1 })
  })

  it('keeps stored object keys, adds new ones and drops removed ones', () => {
    const source: ScriptLayout = {
      params: {
        cfg: {
          type: 'object',
          value: { enabled: false, retries: 3 },
          fields: { enabled: { type: 'boolean', value: false }, retries: { type: 'number', value: 3 } }
        }
      }
    }
    const target: ScriptLayout = {
      params: {
        cfg: {
          type: 'object',
          value: { enabled: true, legacy: 'x' },
          fields: { enabled: { type: 'boolean', value: false }, legacy: { type: 'string', value: '' } }
        }
      }
    }
    expect(mergeLayout(source, target).params.cfg.value).toEqual({ enabled: true, retries: 3 })
  })

  it('keeps stored rows against the fresh item shape', () => {
    const item = {
      type: 'object' as const,
      value: { entity: 0, label: '' },
      fields: { entity: { type: 'entity' as const, value: 0 }, label: { type: 'string' as const, value: '' } }
    }
    const rows = [{ entity: 512, label: 'a' }, { entity: 513, label: 'b' }]
    const merged = mergeLayout({ params: { items: { type: 'array', value: [], item } } }, { params: { items: { type: 'array', value: rows, item } } })
    expect(merged.params.items.value).toEqual(rows)
  })

  it('falls back to the fresh default for a nested value that no longer fits', () => {
    const source = getScriptParams(classScript("public cfg: { count: number; mode: 'a' | 'b' } = { count: 3, mode: 'a' },"))
    const stored: ScriptLayout = { params: { cfg: { type: 'object', value: { count: 'three', mode: 'gone' } } } }
    expect(mergeLayout(layoutOf(source), stored).params.cfg.value).toEqual({ count: 3, mode: 'a' })
  })

  it("keeps a placed Admin Tools' edited config when its script is parsed again", () => {
    const fresh = layoutOf(getScriptParams(fixture('AdminTools.ts.txt')))
    const edited = structuredClone(fresh)
    edited.params.smartItemsControl.value = {
      isEnabled: true,
      linkAllSmartItems: false,
      smartItems: [{ entity: 520, customName: 'Front door', defaultAction: 'open' }]
    }
    edited.params.authorizedAdminUsers.value = { me: true, sceneOwners: false, allowList: true, adminAllowList: ['0xabc'] }
    const merged = mergeLayout(fresh, edited)
    expect(merged.params.smartItemsControl.value).toEqual(edited.params.smartItemsControl.value)
    expect(merged.params.authorizedAdminUsers.value).toEqual(edited.params.authorizedAdminUsers.value)
  })
})
