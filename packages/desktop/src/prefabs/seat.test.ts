// The shared seat behaviour (runtime-modules/seat.ts), ported from Creator Hub's
// Seat.ts: synced Free/Taken per spot, the taken message, sit() picking the
// nearest free spot, and standing up by walking away.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Entity } from '@dcl/sdk/ecs'
import { SeatBehavior } from '../../runtime-modules/seat'

const fake = vi.hoisted(() => {
  type Store = Map<number, Record<string, unknown>>
  const stores = new Map<string, Store>()
  const component = (name: string) => {
    const store: Store = stores.get(name) ?? new Map()
    stores.set(name, store)
    return {
      componentId: name.length,
      componentName: name,
      has: (e: number) => store.has(e),
      getOrNull: (e: number) => store.get(e) ?? null,
      get: (e: number) => store.get(e),
      getMutable: (e: number) => store.get(e),
      getMutableOrNull: (e: number) => store.get(e) ?? null,
      create: (e: number, value: Record<string, unknown> = {}) => {
        store.set(e, structuredClone(value))
        return store.get(e)
      },
      createOrReplace: (e: number, value: Record<string, unknown> = {}) => store.set(e, structuredClone(value))
    }
  }
  const defined = new Map<string, ReturnType<typeof component>>()
  const clicks = new Map<number, () => void>()
  const calls = { moved: [] as unknown[], emotes: [] as unknown[], synced: [] as unknown[], server: false }
  // the real engine refuses new components once the scene runs: after module load
  const engine = { sealed: false }
  let next = 10_000
  return { stores, component, defined, clicks, calls, engine, nextEntity: () => next++ }
})

vi.mock('@dcl/sdk/ecs', () => {
  const Transform = fake.component('core::Transform')
  const PointerEvents = fake.component('core::PointerEvents')
  const shape = () => ({ setBox: () => {}, setSphere: () => {}, setPbrMaterial: () => {} })
  return {
    engine: {
      RootEntity: 0,
      PlayerEntity: 1,
      getComponentOrNull: (name: string) => fake.defined.get(name) ?? null,
      defineComponent: (name: string) => {
        const existing = fake.defined.get(name)
        if (existing !== undefined) return existing
        if (fake.engine.sealed) throw new Error('Engine is already sealed. No components can be added at this stage')
        const c = fake.component(name)
        fake.defined.set(name, c)
        return c
      },
      getEntitiesWith: function* (...wanted: Array<{ componentName: string }>) {
        const stores = wanted.map((c) => fake.stores.get(c.componentName) ?? new Map())
        for (const [e, first] of stores[0]) {
          if (stores.every((store) => store.has(e))) yield [e, first, ...stores.slice(1).map((store) => store.get(e))]
        }
      },
      addEntity: () => fake.nextEntity(),
      removeEntity: () => {}
    },
    Transform,
    PointerEvents,
    PlayerIdentityData: fake.component('core::PlayerIdentityData'),
    VisibilityComponent: fake.component('core::VisibilityComponent'),
    UiTransform: fake.component('core::UiTransform'),
    UiText: fake.component('core::UiText'),
    MeshCollider: shape(),
    MeshRenderer: shape(),
    Material: shape(),
    pointerEventsSystem: {
      onPointerDown: (opts: { entity: number; opts: { hoverText: string } }, cb: () => void) => {
        fake.clicks.set(opts.entity, cb)
        PointerEvents.create(opts.entity, { pointerEvents: [{ eventInfo: { hoverText: opts.opts.hoverText } }] })
      }
    },
    Schemas: { String: {}, Number: {}, Array: () => ({}), Optional: () => ({}) },
    ColliderLayer: { CL_POINTER: 1 },
    InputAction: { IA_POINTER: 0 },
    PointerFilterMode: { PFM_NONE: 0 },
    TextAlignMode: { TAM_BOTTOM_CENTER: 7 },
    YGUnit: { YGU_PERCENT: 2 },
    Font: { F_SANS_SERIF: 0 }
  }
})
vi.mock('@dcl/sdk/network', () => ({
  isServer: () => fake.calls.server,
  syncEntity: (...args: unknown[]) => fake.calls.synced.push(args)
}))
vi.mock('~system/RestrictedActions', () => ({
  movePlayerTo: async (to: unknown) => fake.calls.moved.push(to),
  triggerEmote: async (emote: unknown) => fake.calls.emotes.push(emote),
  triggerSceneEmote: async (emote: unknown) => fake.calls.emotes.push(emote)
}))

const SEAT = 512 as Entity
const LEFT = 513 as Entity
const RIGHT = 514 as Entity
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 }
const ONE = { x: 1, y: 1, z: 1 }

function place(entity: number, x: number, parent?: number, name?: string): void {
  fake.stores.get('core::Transform')?.set(entity, { position: { x, y: 0, z: 0 }, rotation: IDENTITY, scale: ONE, parent })
  if (name !== undefined) fake.defined.get('core-schema::Name')?.create(entity, { value: name })
}

const player = (x: number): void => place(1, x)
const stateOf = (spot: number): unknown => fake.defined.get('asset-packs::States')?.getOrNull(spot)?.currentValue
// what another player's client writes, arriving through the sync
function takenElsewhere(spot: number): void {
  const states = fake.defined.get('asset-packs::States')?.getMutableOrNull(spot)
  if (states === null || states === undefined) throw new Error(`spot ${spot} has no States`)
  states.currentValue = 'Taken'
}
const hoverOf = (spot: number): unknown =>
  (fake.stores.get('core::PointerEvents')?.get(spot) as { pointerEvents: Array<{ eventInfo: { hoverText: string } }> }).pointerEvents[0].eventInfo.hoverText

function couch(): InstanceType<typeof SeatBehavior> {
  place(SEAT, 10)
  place(LEFT, -1, SEAT, 'Sit Spot')
  place(RIGHT, 1, SEAT, 'Sit Spot 2')
  const seat = new SeatBehavior('custom/couch/scripts', SEAT, 'Sit Here', 'Seat is taken')
  seat.start()
  return seat
}

beforeEach(() => {
  fake.engine.sealed = true
  for (const store of fake.stores.values()) store.clear()
  fake.clicks.clear()
  fake.calls.moved = []
  fake.calls.emotes = []
  fake.calls.synced = []
  fake.calls.server = false
})

describe('a seat with two sit spots', () => {
  it('shares each spot as Free under its own entity number', () => {
    couch()
    expect(stateOf(LEFT)).toBe('Free')
    expect(stateOf(RIGHT)).toBe('Free')
    // in a range of their own: a sync id is scene-wide, not an entity number
    expect(fake.calls.synced.map((args) => (args as unknown[])[2])).toEqual([0x5ea70000 + LEFT, 0x5ea70000 + RIGHT])
  })

  it('takes the clicked spot, moves the avatar onto it, then plays the emote', () => {
    const seat = couch()
    player(20)
    fake.clicks.get(LEFT)?.()
    expect(stateOf(LEFT)).toBe('Taken')
    expect(fake.calls.moved).toHaveLength(1)
    expect(fake.calls.emotes).toHaveLength(0)
    seat.update(0.3)
    expect(fake.calls.emotes).toHaveLength(1)
  })

  it('sits on the nearest free spot through sit(), and shows the taken message when none is', () => {
    const seat = couch()
    player(11.2)
    seat.sit()
    expect(stateOf(RIGHT)).toBe('Taken')
    takenElsewhere(LEFT)
    const ui = fake.stores.get('core::UiText')
    seat.update(0.016) // the avatar arrives
    player(30) // walks away: stands up
    seat.update(0.016)
    expect(stateOf(RIGHT)).toBe('Free')
    takenElsewhere(RIGHT)
    seat.sit()
    expect([...(ui?.values() ?? [])].map((t) => (t as { value: string }).value)).toEqual(['Seat is taken'])
  })

  it('says a spot another player took is taken in its hover hint', () => {
    const seat = couch()
    takenElsewhere(LEFT)
    seat.update(0.016)
    expect(hoverOf(LEFT)).toBe('Seat is taken')
    expect(hoverOf(RIGHT)).toBe('Sit Here')
  })

  it('frees the spot when the move never lands', () => {
    const seat = couch()
    player(30)
    fake.clicks.get(LEFT)?.()
    seat.update(3.1)
    expect(stateOf(LEFT)).toBe('Free')
  })

  it('frees every spot with markAsFree()', () => {
    const seat = couch()
    takenElsewhere(LEFT)
    takenElsewhere(RIGHT)
    seat.markAsFree()
    expect([stateOf(LEFT), stateOf(RIGHT)]).toEqual(['Free', 'Free'])
  })

  // the sitter disconnected or reloaded: their client never stands them up
  it('frees a spot another player left taken once nobody has been on it for a while', () => {
    const seat = couch()
    player(30)
    takenElsewhere(LEFT)
    for (let t = 0; t < 5; t += 1) seat.update(1)
    expect(stateOf(LEFT)).toBe('Taken')
    for (let t = 0; t < 3; t += 1) seat.update(1)
    expect(stateOf(LEFT)).toBe('Free')
  })

  it('keeps a spot taken while another avatar sits on it', () => {
    const seat = couch()
    player(30)
    takenElsewhere(LEFT)
    place(77, 9)
    fake.stores.get('core::PlayerIdentityData')?.set(77, { address: '0xother' })
    for (let t = 0; t < 10; t += 1) seat.update(1)
    expect(stateOf(LEFT)).toBe('Taken')
  })

  it('only keeps the occupancy in sync on the Multiplayer Server', () => {
    fake.calls.server = true
    couch()
    expect(fake.calls.synced).toHaveLength(2)
    expect(fake.clicks.size).toBe(0)
  })
})

describe('a standalone sit spot', () => {
  it('is its own spot', () => {
    place(SEAT, 0)
    new SeatBehavior('custom/spot/scripts', SEAT, 'Sit Here', '').start()
    expect(stateOf(SEAT)).toBe('Free')
    expect(fake.clicks.has(SEAT)).toBe(true)
  })
})
