import { afterEach, describe, expect, it } from 'vitest'
import { state } from '@scene/state'
import { NAME_COMPONENT } from '@scene/custom-components'
import { ParamField } from './script-params'
import { prefabStore, type PrefabEntry } from '../prefab-store'
import { CREATE_SPAWNABLE_GESTURE, NO_SPAWNABLES_YET } from '../../prefabs/copy'
import { mount, run } from '../../test/render'

const ZOMBIE_ID = '9f1c3a5e-0000-4000-8000-000000000001'

const zombie: PrefabEntry = {
  folder: 'custom/zombie_basic',
  data: { id: ZOMBIE_ID, name: 'Zombie Basic', category: 'custom', tags: [], spawnable: { max: 8 } },
  hasGuide: false
}

afterEach(() => {
  run(() => {
    prefabStore.items = []
    state.snapshot = {}
  })
})

describe('prefab param pickers with nothing to pick', () => {
  it('names the gesture that fills the picker instead of a dead dropdown', () => {
    const view = mount(<ParamField name="zombie" param={{ type: 'prefab', value: '' }} onChange={() => {}} />)
    expect(view.text()).toContain(NO_SPAWNABLES_YET)
    expect(view.text()).toContain(CREATE_SPAWNABLE_GESTURE)
    expect(view.find('.eui-ds-select')).toBeNull()
    view.unmount()
  })

  it('says the same thing over a prefab-list param', () => {
    const view = mount(<ParamField name="arenas" param={{ type: 'prefabList', value: [] }} onChange={() => {}} />)
    expect(view.text()).toContain(NO_SPAWNABLES_YET)
    view.unmount()
  })

  it('offers the picker once the project has a spawnable prefab', () => {
    run(() => {
      prefabStore.items = [zombie]
    })
    const view = mount(<ParamField name="zombie" param={{ type: 'prefab', value: '' }} onChange={() => {}} />)
    expect(view.text()).not.toContain('No spawnable prefabs yet')
    view.unmount()
  })
})

describe('param labels', () => {
  it('reads as a phrase, in full, with the real name in the tooltip', () => {
    const view = mount(
      <ParamField
        name="atMostAtOnce"
        param={{ type: 'number', value: 1, description: 'How many copies can be out at once.' }}
        onChange={() => {}}
      />
    )
    const label = view.find('.plabel')
    expect(label?.textContent).toBe('At Most At Once')
    expect(label?.classList.contains('param')).toBe(true)
    expect(label?.getAttribute('data-tip')).toContain('atMostAtOnce')
    expect(label?.getAttribute('data-tip')).toContain('How many copies can be out at once.')
    view.unmount()
  })
})

describe('the entity picker', () => {
  const name = (value: string): Record<string, unknown> => ({ [NAME_COMPONENT]: { value } })

  it('lists none first, then named entities alphabetically with their id as detail', () => {
    run(() => {
      state.snapshot = { '0': {}, '512': name('Lever'), '513': {}, '514': name('Anvil') }
    })
    const view = mount(
      <ParamField
        name="clickable"
        param={{ type: 'entity', value: 0, description: 'For "when clicked": the thing a player clicks.' }}
        onChange={() => {}}
      />
    )
    view.click(view.find('.eui-ds-select-field'))
    const rows = view.all('.eui-ds-pop-row').map((row) => row.textContent)
    expect(rows).toEqual(['nonethe thing a player clicks.', 'Anvil#514', 'Lever#512'])
    view.unmount()
  })

  it('keeps an unnamed current value so nothing silently changes', () => {
    run(() => {
      state.snapshot = { '512': name('Lever'), '513': {} }
    })
    let picked: unknown = null
    const view = mount(
      <ParamField name="clickable" param={{ type: 'entity', value: 513 }} onChange={(v) => (picked = v)} />
    )
    view.click(view.find('.eui-ds-select-field'))
    const rows = view.all('.eui-ds-pop-row')
    expect(rows.map((row) => row.textContent)).toEqual(['none', '#513unnamed', 'Lever#512'])
    view.click(rows[2])
    expect(picked).toBe(512)
    view.unmount()
  })
})

describe('enum display labels', () => {
  const param = {
    type: 'enum' as const,
    value: 'when a script asks',
    options: ['when clicked', 'when a script asks']
  }

  it('shows the friendlier words while storing the exact value', () => {
    let stored: unknown = null
    const view = mount(
      <ParamField
        name="when"
        param={param}
        enumLabels={{ 'when a script asks': 'when another script triggers it' }}
        onChange={(v) => (stored = v)}
      />
    )
    expect(view.text()).toContain('when another script triggers it')
    view.click(view.find('.eui-ds-select-field'))
    view.click(view.byText('when another script triggers it', '.eui-ds-pop-row'))
    expect(stored).toBe('when a script asks')
    view.unmount()
  })

  it('defaults to the stored words untouched', () => {
    const view = mount(<ParamField name="when" param={param} onChange={() => {}} />)
    expect(view.text()).toContain('when a script asks')
    expect(view.find('.eui-param-hint')).toBeNull()
    view.unmount()
  })

  it('captions the picked choice with what it actually does', () => {
    const view = mount(
      <ParamField
        name="when"
        param={param}
        enumHints={{ 'when a script asks': 'One of your scripts calls this spawner by name.' }}
        onChange={() => {}}
      />
    )
    expect(view.find('.eui-param-hint')?.textContent).toBe('One of your scripts calls this spawner by name.')
    view.unmount()
  })
})


describe('scene theme and course controls', () => {
  it('accepts a hex edit, rejects invalid colors and exposes a native color picker', () => {
    let picked: unknown
    const view = mount(<ParamField name="accent" param={{ type: 'string', control: 'color', value: '#FF2D55' }} onChange={(v) => { picked = v }} />)
    expect(view.find('input[type="color"]')).not.toBeNull()
    view.type(view.find('input[aria-label="accent hex"]'), '#59e0ac')
    expect(picked).toBe('#59E0AC')
    picked = undefined
    view.type(view.find('input[aria-label="accent hex"]'), 'invalid')
    expect(picked).toBeUndefined()
    expect((view.find('input[aria-label="accent hex"]') as HTMLInputElement).value).toBe('#FF2D55')
    view.unmount()
  })

  it('lets a creator pick, order and remove named entities without typing CSV', () => {
    run(() => { state.snapshot = { '512': { [NAME_COMPONENT]: { value: 'First' } }, '513': { [NAME_COMPONENT]: { value: 'Second' } } } })
    let picked: unknown
    const render = (value: string) => <ParamField name="markers" param={{ type: 'string', control: 'entityNames', value }} onChange={(v) => { picked = v }} />
    const view = mount(render('First, Second'))
    view.click(view.find('[aria-label="Move Second up"]'))
    expect(picked).toBe('Second, First')
    view.render(render(String(picked)))
    view.click(view.find('[aria-label="Remove First"]'))
    expect(picked).toBe('Second')
    view.render(render(String(picked)))
    view.click(view.find('[aria-label="Add markers"]'))
    view.click(view.all('.eui-ds-pop-row').find((row) => row.textContent === 'First#512') ?? null)
    expect(picked).toBe('Second, First')
    view.unmount()
  })

  it('offers only actual uniquely named Trigger Areas to zone controls', () => {
    run(() => { state.snapshot = {
      '512': { [NAME_COMPONENT]: { value: 'Start' }, 'asset-packs::Script': { value: [{ path: 'custom/trigger_zone/scripts/trigger-zone.ts' }] } },
      '513': { [NAME_COMPONENT]: { value: 'Wall' } },
      '514': { [NAME_COMPONENT]: { value: 'Duplicate' } },
      '515': { [NAME_COMPONENT]: { value: 'Duplicate' } }
    } })
    const view = mount(<ParamField name="zone" param={{ type: 'string', control: 'zone', value: '' }} onChange={() => {}} />)
    view.click(view.find('.eui-ds-select-field'))
    const rows = view.all('.eui-ds-pop-row').map((e) => e.textContent)
    expect(rows).toEqual(['Choose a Trigger Area', 'Start#512'])
    view.unmount()
  })
})

describe('Creator Hub param shapes (creator-hub#1513, #1667, #1748)', () => {
  it('edits a slider within its range', () => {
    const view = mount(<ParamField name="speed" param={{ type: 'slider', value: 2, min: 0, max: 10, step: 0.5 }} onChange={() => {}} />)
    const range = view.find('input[type="range"]') as HTMLInputElement
    expect([range.min, range.max, range.step, range.value]).toEqual(['0', '10', '0.5', '2'])
    view.unmount()
  })

  it("edits an object's members in place and writes the whole object back", () => {
    let picked: unknown
    const param = {
      type: 'object' as const,
      value: { label: 'a', on: false },
      fields: { label: { type: 'string' as const, value: '' }, on: { type: 'boolean' as const, value: false } }
    }
    const view = mount(<ParamField name="cfg" param={param} onChange={(v) => { picked = v }} />)
    expect(view.text()).toContain('2 settings')
    view.type(view.find('.eui-param-group input'), 'b')
    expect(picked).toEqual({ label: 'b', on: false })
    view.unmount()
  })

  it('adds and removes list rows', () => {
    let picked: unknown
    const item = { type: 'object' as const, value: { entity: 0, customName: '' }, fields: { entity: { type: 'entity' as const, value: 0 }, customName: { type: 'string' as const, value: '' } } }
    const render = (value: { entity: number; customName: string }[]) => (
      <ParamField name="videoPlayers" param={{ type: 'array', value, item }} onChange={(v) => { picked = v }} />
    )
    const view = mount(render([]))
    expect(view.text()).toContain('none yet')
    view.click(view.find('[aria-label="add videoPlayers"]'))
    expect(picked).toEqual([{ entity: 0, customName: '' }])
    view.render(render([{ entity: 512, customName: 'Screen' }, { entity: 513, customName: 'Other' }]))
    view.click(view.find('[aria-label="remove videoPlayers 1"]'))
    expect(picked).toEqual([{ entity: 513, customName: 'Other' }])
    view.unmount()
  })

  it('offers only entities with the @components it names', () => {
    run(() => { state.snapshot = {
      '512': { [NAME_COMPONENT]: { value: 'Screen' }, 'asset-packs::VideoScreen': {} },
      '513': { [NAME_COMPONENT]: { value: 'Wall' } }
    } })
    const view = mount(<ParamField name="entity" param={{ type: 'entity', value: 0, components: ['asset-packs::VideoScreen'] }} onChange={() => {}} />)
    view.click(view.find('.eui-ds-select-field'))
    expect(view.all('.eui-ds-pop-row').map((e) => e.textContent)).toEqual(['none', 'Screen#512'])
    view.unmount()
  })

  it('picks a default action among those of the sibling entity (@actionsOf)', () => {
    run(() => { state.snapshot = { '520': { 'asset-packs::Actions': { id: 520, value: [{ name: 'open' }, { name: 'close' }] } } } })
    const view = mount(
      <ParamField name="defaultAction" param={{ type: 'string', value: '', actionsOf: 'entity' }} siblings={{ entity: 520 }} onChange={() => {}} />
    )
    view.click(view.find('.eui-ds-select-field'))
    expect(view.all('.eui-ds-pop-row').map((e) => e.textContent)).toEqual(['none', 'open', 'close'])
    view.unmount()
  })
})
