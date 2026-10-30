import { describe, expect, it } from 'vitest'
import { createRng, rngRange, rngInt, rngPick } from '../runtime-modules/pure/rng'
import { ntpSample, combineSamples } from '../runtime-modules/pure/time-math'
import {
  remainingMs,
  isExpired,
  countdownRemainingMs,
  countdownWithMultiplier,
  settleExpired,
  periodId,
  dailyKey,
  weeklyKey,
  DAY_MS,
  WEEK_MS
} from '../runtime-modules/pure/countdown'
import {
  safeNumber,
  safeString,
  safeBoolean,
  safeStringArray,
  normalizeVersioned
} from '../runtime-modules/pure/normalize'
import { LivenessTracker } from '../runtime-modules/pure/liveness'
import { PendingMap } from '../runtime-modules/pure/pending'
import { Membership } from '../runtime-modules/pure/membership'
import { ZoneRegistry, zoneKey } from '../runtime-modules/pure/zoneRegistry'
import {
  THROW_MS,
  applyCarry,
  clampThrow,
  flightPosition,
  freshCarry,
  giveCarry,
  heldItem,
  leaveCarry,
  parseCombines,
  parseKinds,
  parseTurns,
  readAction,
  readCarry,
  setStationKind,
  stationProgress,
  tickCarry,
  useHeld,
  type CarryAction,
  type CarryRules,
  type CarryState
} from '../runtime-modules/pure/carryRules'
import { CarryPrediction } from '../runtime-modules/pure/carryPrediction'
import { nearestCandidate, promptText, verbWith } from '../runtime-modules/pure/interactPick'
import fs from 'node:fs'
import path from 'node:path'

describe('_runtime rng', () => {
  it('is deterministic per seed', () => {
    const a = createRng(1234)
    const b = createRng(1234)
    const c = createRng(4321)
    const seqA = [a(), a(), a(), a()]
    const seqB = [b(), b(), b(), b()]
    const seqC = [c(), c(), c(), c()]
    expect(seqA).toEqual(seqB)
    expect(seqA).not.toEqual(seqC)
  })

  it('stays in bounds', () => {
    const rng = createRng(7)
    for (let i = 0; i < 1000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      const r = rngRange(rng, 2, 5.5)
      expect(r).toBeGreaterThanOrEqual(2)
      expect(r).toBeLessThan(5.5)
      const n = rngInt(rng, 0, 3)
      expect([0, 1, 2]).toContain(n)
    }
  })

  it('picks only from the list', () => {
    const rng = createRng(42)
    const items = ['a', 'b', 'c']
    for (let i = 0; i < 100; i++) expect(items).toContain(rngPick(rng, items))
  })
})

describe('_runtime time-math', () => {
  it('computes offset and rtt from the four timestamps', () => {
    // client clock 1000ms behind server, 40ms each way, 10ms server processing
    const t1 = 10_000
    const t2 = 10_000 + 40 + 1000
    const t3 = t2 + 10
    const t4 = t1 + 40 + 10 + 40
    const s = ntpSample(t1, t2, t3, t4)
    expect(s.rtt).toBe(80)
    expect(s.offset).toBe(1000)
  })

  it('drops best and worst samples before averaging', () => {
    const samples = [
      { offset: 1000, rtt: 50 },
      { offset: 1002, rtt: 60 },
      { offset: 998, rtt: 55 },
      { offset: 5000, rtt: 900 }, // congested outlier — dropped as worst rtt
      { offset: -400, rtt: 5 } // impossible fast path — dropped as best rtt
    ]
    const offset = combineSamples(samples)
    expect(offset).toBeCloseTo((1000 + 1002 + 998) / 3, 5)
  })

  it('handles small sample sets without slicing to nothing', () => {
    expect(combineSamples([])).toBe(0)
    expect(combineSamples([{ offset: 10, rtt: 1 }])).toBe(10)
    expect(
      combineSamples([
        { offset: 10, rtt: 1 },
        { offset: 20, rtt: 2 }
      ])
    ).toBe(15)
  })
})

describe('_runtime countdown', () => {
  it('deadline helpers clamp at zero', () => {
    expect(remainingMs(1000, 400)).toBe(600)
    expect(remainingMs(1000, 1500)).toBe(0)
    expect(isExpired(1000, 999)).toBe(false)
    expect(isExpired(1000, 1000)).toBe(true)
  })

  it('derives drift-free countdowns and survives speed changes', () => {
    const start = { changedAtMs: 0, remainingAtChangeMs: 10_000, multiplier: 1 }
    expect(countdownRemainingMs(start, 4000)).toBe(6000)
    // frenzy: at t=4000 switch to 2x speed — remaining is preserved at the switch
    const frenzy = countdownWithMultiplier(start, 4000, 2)
    expect(frenzy).toEqual({ changedAtMs: 4000, remainingAtChangeMs: 6000, multiplier: 2 })
    expect(countdownRemainingMs(frenzy, 5000)).toBe(4000)
    expect(countdownRemainingMs(frenzy, 8000)).toBe(0)
  })

  it('settles items that expired while the server slept', () => {
    const items = [
      { name: 'past', endsAt: 100 },
      { name: 'future', endsAt: 10_000 },
      { name: 'also-past', endsAt: 500 }
    ]
    const settled: string[] = []
    const count = settleExpired(items, (i) => i.endsAt, 1000, (i) => settled.push(i.name))
    expect(count).toBe(2)
    expect(settled).toEqual(['past', 'also-past'])
  })

  it('rolls period keys over at exact boundaries', () => {
    expect(periodId(DAY_MS - 1, DAY_MS)).toBe(0)
    expect(periodId(DAY_MS, DAY_MS)).toBe(1)
    expect(dailyKey('board', DAY_MS * 3 + 5)).toBe('board:daily:3')
    expect(weeklyKey('board', WEEK_MS * 2)).toBe('board:weekly:2')
  })
})

describe('_runtime normalize', () => {
  it('repairs primitives', () => {
    expect(safeNumber(5, 0)).toBe(5)
    expect(safeNumber(NaN, 0)).toBe(0)
    expect(safeNumber('5', 0)).toBe(0)
    expect(safeString('x', 'd')).toBe('x')
    expect(safeString(5, 'd')).toBe('d')
    expect(safeBoolean(true, false)).toBe(true)
    expect(safeBoolean('true', false)).toBe(false)
    expect(safeStringArray(['a', 1, 'b', null])).toEqual(['a', 'b'])
    expect(safeStringArray('nope')).toEqual([])
  })

  it('gates on schema version and repairs field by field', () => {
    type S = { schemaVersion: number; gold: number; name: string }
    const defaults = (): S => ({ schemaVersion: 2, gold: 0, name: 'anon' })
    const repair = (v: Partial<S>, d: S): S => ({
      schemaVersion: d.schemaVersion,
      gold: safeNumber(v.gold, d.gold),
      name: safeString(v.name, d.name)
    })
    expect(normalizeVersioned(null, 2, defaults, repair)).toEqual(defaults())
    expect(normalizeVersioned({ schemaVersion: 1, gold: 99 }, 2, defaults, repair)).toEqual(defaults())
    expect(normalizeVersioned({ schemaVersion: 2, gold: 99, name: 3 }, 2, defaults, repair)).toEqual({
      schemaVersion: 2,
      gold: 99,
      name: 'anon'
    })
  })
})

describe('_runtime membership', () => {
  it('fires every entry under "every time"', () => {
    const m = new Membership<number>()
    expect(m.touch(1, 'every time')).toBe(true)
    expect(m.touch(1, 'every time')).toBe(false) // already inside
    m.drop(1)
    expect(m.tick(1, 0)).toEqual([1])
    expect(m.touch(1, 'every time')).toBe(true) // came back
  })

  it('fires once per player, and once ever, across re-entries', () => {
    const perPlayer = new Membership<number>()
    expect(perPlayer.touch(1, 'once per player')).toBe(true)
    expect(perPlayer.touch(2, 'once per player')).toBe(true)
    perPlayer.drop(1)
    perPlayer.tick(1, 0)
    expect(perPlayer.touch(1, 'once per player')).toBe(false)

    const onceEver = new Membership<number>()
    expect(onceEver.touch(1, 'once ever')).toBe(true)
    expect(onceEver.touch(2, 'once ever')).toBe(false)
    onceEver.drop(1)
    onceEver.tick(1, 0)
    expect(onceEver.touch(1, 'once ever')).toBe(false)
  })

  it('suppressed entries still count as occupancy', () => {
    const m = new Membership<number>()
    m.touch(1, 'once ever')
    m.touch(2, 'once ever') // no event, but player 2 IS in the zone
    expect(m.list()).toEqual([1, 2])
    expect(m.has(2)).toBe(true)
  })

  it('holds a member through the cooldown and cancels the exit if they come back', () => {
    const m = new Membership<number>()
    m.touch(1, 'every time')
    m.drop(1)
    expect(m.tick(0.1, 0.3)).toEqual([])
    expect(m.has(1)).toBe(true) // still occupancy while straddling the boundary
    expect(m.touch(1, 'every time')).toBe(false) // no re-entry event
    expect(m.tick(0.5, 0.3)).toEqual([]) // grace was cancelled, not merely reset
    m.drop(1)
    expect(m.tick(0.2, 0.3)).toEqual([])
    expect(m.tick(0.1, 0.3)).toEqual([1])
    expect(m.size).toBe(0)
  })

  it('re-asserts membership from STAY without re-firing, and re-fires after expiry', () => {
    // TriggerAreaResult is capped at 100 and trimmed from the front: the ENTER
    // can be evicted, so STAY is the first thing the scene sees.
    const m = new Membership<number>()
    expect(m.touch(7, 'every time')).toBe(true) // arrived via STAY
    expect(m.touch(7, 'every time')).toBe(false) // further STAY heartbeats
    expect(m.touch(7, 'every time')).toBe(false)
    m.drop(7)
    expect(m.tick(0.016, 0)).toEqual([7])
    expect(m.touch(7, 'every time')).toBe(true)
  })

  it('reset forgets the once-per-player history', () => {
    const m = new Membership<string>()
    m.touch('a', 'once per player')
    m.reset()
    expect(m.size).toBe(0)
    expect(m.touch('a', 'once per player')).toBe(true)
  })
})

describe('_runtime zone registry', () => {
  const stub = <T>(items: T[]) => () => items

  it('matches names ignoring case and surrounding space, keeping the creator spelling', () => {
    const r = new ZoneRegistry<number>()
    r.publish(' Front Hall ', 10, stub([1]))
    expect(zoneKey('  FRONT hall ')).toBe('front hall')
    expect(r.contains('front hall', 1)).toBe(true)
    expect(r.contains('FRONT HALL', 1)).toBe(true)
    expect(r.occupants('front  hall')).toEqual([]) // inner spacing is still a different name
    expect(r.names()).toEqual(['Front Hall'])
    expect(r.displayName('front hall')).toBe('Front Hall')
  })

  it('unions and dedupes occupancy across areas sharing a name', () => {
    const r = new ZoneRegistry<number>()
    r.publish('Arena', 10, stub([1, 2]))
    r.publish('arena', 11, stub([2, 3]))
    expect(r.occupants('Arena')).toEqual([1, 2, 3])
    expect(r.names()).toEqual(['arena']) // last publish owns the spelling
    r.unpublish(11)
    expect(r.occupants('Arena')).toEqual([1, 2])
    r.unpublish(10)
    expect(r.names()).toEqual([])
  })

  it('replays current occupancy to a late subscriber as enter events', () => {
    const r = new ZoneRegistry<number>()
    r.publish('Front Hall', 10, stub([1, 2]))
    const seen: string[] = []
    r.subscribe('front hall', 'enter', (kind, who, zoneEntity) => seen.push(`${kind}:${who}:${zoneEntity}`))
    expect(seen).toEqual(['enter:1:10', 'enter:2:10'])
    r.emit('FRONT HALL', 'enter', 3, 10)
    expect(seen).toEqual(['enter:1:10', 'enter:2:10', 'enter:3:10'])
  })

  it('does not replay to exit-only subscribers, and routes by kind', () => {
    const r = new ZoneRegistry<number>()
    r.publish('Front Hall', 10, stub([1]))
    const exits: number[] = []
    const any: string[] = []
    r.subscribe('Front Hall', 'exit', (_kind, who) => exits.push(who))
    r.subscribe('Front Hall', 'any', (kind) => any.push(kind))
    expect(exits).toEqual([])
    expect(any).toEqual(['enter']) // 'any' still gets the replay
    r.emit('Front Hall', 'exit', 1, 10)
    expect(exits).toEqual([1])
    expect(any).toEqual(['enter', 'exit'])
  })

  it('subscribes before the zone exists and stops on unsubscribe', () => {
    const r = new ZoneRegistry<number>()
    const seen: number[] = []
    const off = r.subscribe('Not Yet', 'enter', (_kind, who) => seen.push(who))
    r.publish('not yet', 10, stub([]))
    r.emit('Not Yet', 'enter', 1, 10)
    off()
    r.emit('Not Yet', 'enter', 2, 10)
    expect(seen).toEqual([1])
  })

  it('ignores a blank name rather than publishing an unaddressable zone', () => {
    const r = new ZoneRegistry<number>()
    r.publish('   ', 10, stub([1]))
    expect(r.names()).toEqual([])
    expect(r.occupants('')).toEqual([])
  })
})

describe('runtime-modules distribution', () => {
  it('templates ship zero runtime code — the shared copy is vendored on first import', () => {
    for (const t of ['blank', 'starter']) {
      const dir = path.resolve(__dirname, `../templates/${t}/src/_runtime`)
      expect(fs.existsSync(dir)).toBe(false)
    }
  })

  // without a composite the inspector writes a one-parcel "Test Scene" that can land back on scene.json
  it('templates ship a composite whose scene metadata matches scene.json', () => {
    for (const t of ['blank', 'starter']) {
      const dir = path.resolve(__dirname, `../templates/${t}`)
      const scene = JSON.parse(fs.readFileSync(path.join(dir, 'scene.json'), 'utf8'))
      const composite = JSON.parse(fs.readFileSync(path.join(dir, 'assets/scene/main.composite'), 'utf8'))
      const meta = composite.components.find((c: { name: string }) => c.name.startsWith('inspector::SceneMetadata')).data['0'].json
      expect(meta.name).toBe(scene.display.title)
      expect(meta.layout.parcels.map((p: { x: number; y: number }) => `${p.x},${p.y}`)).toEqual(scene.scene.parcels)
      expect(`${meta.layout.base.x},${meta.layout.base.y}`).toBe(scene.scene.base)
    }
  })

  it('master modules never re-introduce a barrel export', () => {
    const dir = path.resolve(__dirname, '../runtime-modules')
    expect(fs.existsSync(path.join(dir, 'index.ts'))).toBe(false)
  })
})

describe('_runtime liveness', () => {
  it('is connecting until a change is observed — a stale snapshot value is not life', () => {
    const t = new LivenessTracker(6000)
    expect(t.state(0)).toBe('connecting')
    t.observe(12345, 0) // first sighting of a (possibly stale) value
    expect(t.state(100)).toBe('alive')
    // the value never changes again: a snapshot from a dead server
    t.observe(12345, 7000)
    expect(t.state(7000)).toBe('lost')
  })

  it('recovers when the value changes again', () => {
    const t = new LivenessTracker(6000)
    t.observe(1, 0)
    t.observe(1, 10_000)
    expect(t.state(10_000)).toBe('lost')
    t.observe(2, 11_000) // server woke up
    expect(t.state(11_000)).toBe('alive')
  })

  it('reports first-life exactly once', () => {
    const t = new LivenessTracker(6000)
    expect(t.everAlive()).toBe(false)
    t.observe(null, 0)
    expect(t.everAlive()).toBe(false)
    t.observe(7, 100)
    expect(t.everAlive()).toBe(true)
  })
})

describe('_runtime rpc pending', () => {
  it('settles and fails by id, exactly once', () => {
    const p = new PendingMap<string>()
    const got: string[] = []
    p.add('a', { resolve: (v) => got.push(v), reject: () => got.push('err'), sentAtMs: 0, retriesLeft: 0 })
    expect(p.settle('a', 'ok')).toBe(true)
    expect(p.settle('a', 'again')).toBe(false)
    expect(got).toEqual(['ok'])
    expect(p.size).toBe(0)
  })

  it('retries on timeout, then fails when the budget is spent', () => {
    const p = new PendingMap<string>()
    let error: Error | null = null
    p.add('x', { resolve: () => {}, reject: (e) => (error = e), sentAtMs: 0, retriesLeft: 2 })
    expect(p.tick(1000, 4000)).toEqual([]) // not timed out yet
    expect(p.tick(4000, 4000)).toEqual(['x']) // retry 1, clock reset
    expect(p.tick(7999, 4000)).toEqual([]) // within the reset window
    expect(p.tick(8000, 4000)).toEqual(['x']) // retry 2
    expect(p.tick(12_000, 4000)).toEqual([]) // budget spent → failed
    expect(error).not.toBeNull()
    expect(p.size).toBe(0)
  })
})

describe('_runtime carry rules', () => {
  const rules: CarryRules = {
    sources: {
      ball: { kind: 'Ball', endless: false, returnMs: 5000 },
      'tomato crate': { kind: 'Tomato', endless: true, returnMs: 0 }
    },
    stations: {
      board: { mode: 'hold', accepts: [], recipes: parseTurns('Tomato > Chopped Tomato', 2000), combines: {} },
      stove: { mode: 'timed', accepts: parseKinds('Chopped Tomato, Soup'), recipes: parseTurns('Chopped Tomato > Soup, Soup > Burnt Soup', 4000), combines: {} },
      plate: { mode: 'counter', accepts: [], recipes: {}, combines: parseCombines('Bread + Chopped Tomato > Sandwich') }
    }
  }
  const apply = (state: CarryState, action: CarryAction, player = 'a', now = 0) => applyCarry(state, action, player, rules, now)
  const at = { x: 1, y: 0, z: 1 }

  it('gives a placed item one holder at a time', () => {
    const picked = apply(freshCarry(), { type: 'pick', item: 'ball' })
    expect(picked.accepted).toBe(true)
    expect(heldItem(picked.state, 'a')).toEqual({ item: 'ball', kind: 'Ball' })
    expect(apply(picked.state, { type: 'pick', item: 'ball' }, 'b')).toMatchObject({ accepted: false, message: 'Someone else has it' })
    expect(apply(picked.state, { type: 'pick', item: 'tomato crate' })).toMatchObject({ accepted: false, message: 'Your hands are full' })
  })

  it('mints a new item per pick from an endless source', () => {
    const first = apply(freshCarry(), { type: 'pick', item: 'tomato crate' }, 'a').state
    const second = apply(first, { type: 'pick', item: 'tomato crate' }, 'b').state
    expect(heldItem(second, 'a')).toEqual({ item: 'tomato crate#1', kind: 'Tomato' })
    expect(heldItem(second, 'b')).toEqual({ item: 'tomato crate#2', kind: 'Tomato' })
  })

  it('drops and throws what is held, and anyone can pick it up from the floor', () => {
    const held = apply(freshCarry(), { type: 'pick', item: 'ball' }).state
    expect(apply(freshCarry(), { type: 'drop', pos: at }).accepted).toBe(false)
    const dropped = apply(held, { type: 'drop', pos: at }).state
    expect(dropped.items.ball).toEqual({ kind: 'Ball', at: 'floor', pos: at })
    expect(heldItem(apply(dropped, { type: 'pick', item: 'ball' }, 'b').state, 'b')?.item).toBe('ball')
    const thrown = apply(held, { type: 'throw', from: { x: 0, y: 1, z: 0 }, to: { x: 4, y: 0, z: 0 } }, 'a', 1000).state.items.ball
    expect(flightPosition(thrown, 1000)).toEqual({ x: 0, y: 1, z: 0 })
    expect(flightPosition(thrown, 1000 + THROW_MS / 2)!.y).toBeGreaterThan(1)
    expect(flightPosition(thrown, 1000 + THROW_MS)).toEqual({ x: 4, y: 0, z: 0 })
    expect(clampThrow({ x: 0, y: 0, z: 0 }, { x: 30, y: 0, z: 0 }).x).toBe(8)
  })

  it('holds one item per station, takes only what it accepts and gives it back', () => {
    const tomato = apply(freshCarry(), { type: 'pick', item: 'tomato crate' }).state
    expect(apply(tomato, { type: 'put', station: 'stove' })).toMatchObject({ accepted: false, message: 'Tomato does not go here' })
    const onBoard = apply(tomato, { type: 'put', station: 'board' }).state
    expect(heldItem(onBoard, 'a')).toBeNull()
    expect(onBoard.stations.board.item).toBe('tomato crate#1')
    const other = apply(onBoard, { type: 'pick', item: 'tomato crate' }, 'b').state
    expect(apply(other, { type: 'put', station: 'board' }, 'b')).toMatchObject({ accepted: false, message: 'Something is already here' })
    expect(heldItem(apply(onBoard, { type: 'take', station: 'board' }, 'b').state, 'b')?.kind).toBe('Tomato')
  })

  it('turns an item only while someone holds work, and keeps the progress when they stop', () => {
    let state = apply(apply(freshCarry(), { type: 'pick', item: 'tomato crate' }).state, { type: 'put', station: 'board' }).state
    expect(apply(state, { type: 'work', station: 'stove', on: true }).accepted).toBe(false)
    state = apply(state, { type: 'work', station: 'board', on: true }, 'a', 1000).state
    expect(apply(state, { type: 'work', station: 'board', on: true }, 'b', 1100).message).toBe('Someone is already working here')
    expect(stationProgress(state.stations.board, 2000, 2000)).toBe(0.5)
    state = apply(state, { type: 'work', station: 'board', on: false }, 'a', 2000).state
    expect(stationProgress(state.stations.board, 2000, 9000)).toBe(0.5)
    state = apply(state, { type: 'work', station: 'board', on: true }, 'b', 3000).state
    const ticked = tickCarry(state, rules, 4000, () => true)
    expect(ticked.events).toEqual([{ type: 'done', item: 'tomato crate#1', kind: 'Chopped Tomato', was: 'Tomato', station: 'board', player: 'b' }])
    expect(ticked.state.stations.board).toEqual({ item: 'tomato crate#1', work: 0, since: undefined })
  })

  it('stops a worker who walks away', () => {
    let state = apply(apply(freshCarry(), { type: 'pick', item: 'tomato crate' }).state, { type: 'put', station: 'board' }).state
    state = apply(state, { type: 'work', station: 'board', on: true }, 'a', 0).state
    const away = tickCarry(state, rules, 500, () => false)
    expect(away.state.stations.board).toEqual({ item: 'tomato crate#1', work: 500 })
    expect(away.events).toEqual([])
  })

  it('cooks by itself on a timed station and keeps going into the next recipe', () => {
    let state = giveCarry(freshCarry(), 'a', 'Chopped Tomato').state
    state = apply(state, { type: 'put', station: 'stove' }, 'a', 0).state
    expect(tickCarry(state, rules, 3999, () => true).changed).toBe(false)
    const soup = tickCarry(state, rules, 4000, () => true).state
    expect(Object.values(soup.items)[0].kind).toBe('Soup')
    expect(soup.stations.stove.since).toBe(4000)
    expect(Object.values(tickCarry(soup, rules, 8000, () => true).state.items)[0].kind).toBe('Burnt Soup')
  })

  it('combines two kinds on a station, in either order', () => {
    let state = giveCarry(freshCarry(), 'a', 'Chopped Tomato').state
    state = apply(state, { type: 'put', station: 'plate' }).state
    state = giveCarry(state, 'a', 'bread').state
    const combined = apply(state, { type: 'put', station: 'plate' })
    expect(combined.events[0]).toMatchObject({ type: 'combine', kind: 'Sandwich', was: 'Chopped Tomato' })
    expect(Object.keys(combined.state.items)).toHaveLength(1)
  })

  it('uses up a placed item until it comes back home, and ends a minted one', () => {
    const used = useHeld(apply(freshCarry(), { type: 'pick', item: 'ball' }).state, 'a', rules, 1000).state
    expect(used.items.ball).toEqual({ kind: 'Ball', at: 'gone', t: 1000 })
    expect(apply(used, { type: 'pick', item: 'ball' }, 'b').message).toBe('That is gone')
    expect(tickCarry(used, rules, 6000, () => true).state.items.ball).toBeUndefined()
    const minted = useHeld(giveCarry(freshCarry(), 'a', 'Key').state, 'a', rules, 0).state
    expect(minted.items).toEqual({})
  })

  it("lets the server set or clear a station, and drops a leaver's item where they were", () => {
    const set = setStationKind(freshCarry(), 'plate', 'Bread', rules, 0)
    expect(set.accepted).toBe(true)
    expect(setStationKind(set.state, 'plate', null, rules, 0).state.stations.plate).toEqual({ work: 0 })
    expect(setStationKind(freshCarry(), 'nowhere', 'Bread', rules, 0).accepted).toBe(false)
    const held = apply(freshCarry(), { type: 'pick', item: 'ball' }).state
    expect(leaveCarry(held, 'a', at, 0).items.ball).toEqual({ kind: 'Ball', at: 'floor', pos: at })
    expect(leaveCarry(held, 'a', null, 0).items.ball).toBeUndefined()
  })

  it('reads synced state and requests defensively', () => {
    const state = apply(freshCarry(), { type: 'pick', item: 'ball' }).state
    expect(readCarry(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(readCarry({ items: { x: { kind: 'Ball', at: 'hand' }, y: { kind: 1, at: 'floor' } }, stations: { s: { item: 'x', work: -5 } } }))
      .toEqual({ items: {}, stations: { s: { work: 0 } }, n: 0 })
    expect(readCarry('nonsense')).toEqual(freshCarry())
    expect(readAction({ type: 'pick', item: 'ball' })).toEqual({ type: 'pick', item: 'ball' })
    expect(readAction({ type: 'drop', pos: { x: 1, y: 'up', z: 0 } })).toBeNull()
    expect(readAction({ type: 'work', station: 'board' })).toBeNull()
    expect(readAction({ type: 'take', station: 'board', extra: true })).toEqual({ type: 'take', station: 'board' })
  })
})

describe('_runtime carry prediction', () => {
  const rules: CarryRules = { sources: { ball: { kind: 'Ball', endless: false, returnMs: 0 } }, stations: {} }
  const make = () => new CarryPrediction(() => rules, () => 'a')

  it('shows a pick at once and drops it once the server agrees', () => {
    const prediction = make()
    prediction.reconcile(freshCarry(), 0)
    expect(prediction.predict({ type: 'pick', item: 'ball' }, 100).id).not.toBeNull()
    expect(heldItem(prediction.view(100)!, 'a')?.item).toBe('ball')
    prediction.reconcile(applyCarry(freshCarry(), { type: 'pick', item: 'ball' }, 'a', rules, 200).state, 300)
    expect(prediction.pendingCount).toBe(0)
    expect(heldItem(prediction.view(300)!, 'a')?.item).toBe('ball')
  })

  it('rolls a refused pick back, and lets a pending one expire', () => {
    const prediction = make()
    prediction.reconcile(freshCarry(), 0)
    const id = prediction.predict({ type: 'pick', item: 'ball' }, 0).id!
    expect(prediction.reject(id)).toBe(true)
    expect(heldItem(prediction.view(10)!, 'a')).toBeNull()
    prediction.predict({ type: 'pick', item: 'ball' }, 100)
    expect(heldItem(prediction.view(3200)!, 'a')).toBeNull()
  })

  it('keeps a chain of pending actions in order, and drops one someone else overtook', () => {
    const prediction = make()
    prediction.reconcile(freshCarry(), 0)
    prediction.predict({ type: 'pick', item: 'ball' }, 0)
    prediction.predict({ type: 'drop', pos: { x: 1, y: 0, z: 1 } }, 50)
    expect(prediction.view(60)!.items.ball.at).toBe('floor')
    expect(prediction.predict({ type: 'drop', pos: { x: 0, y: 0, z: 0 } }, 70).id).toBeNull()
    prediction.reconcile(applyCarry(freshCarry(), { type: 'pick', item: 'ball' }, 'b', rules, 80).state, 90)
    expect(prediction.pendingCount).toBe(0)
    expect(prediction.view(90)!.items.ball.who).toBe('b')
  })
})

describe('_runtime interact prompt', () => {
  const near = { position: { x: 1, y: 0, z: 0 }, range: 2, name: 'near' }
  const far = { position: { x: 5, y: 0, z: 0 }, range: 2, name: 'far' }
  const above = { position: { x: 0.5, y: 4, z: 0 }, range: 2, name: 'above' }

  it('points at the nearest candidate in range, across the floor only', () => {
    expect(nearestCandidate([far, near, above], { x: 0, y: 0, z: 0 })?.name).toBe('near')
    expect(nearestCandidate([far], { x: 0, y: 0, z: 0 })).toBeNull()
    expect(nearestCandidate([{ position: null, name: 'held' }], { x: 0, y: 0, z: 0 })).toBeNull()
    expect(nearestCandidate([near], null)).toBeNull()
  })

  it('names the key on desktop and only the verb on a phone', () => {
    const verbs = [{ verb: 'Take Tomato', button: 'primary' as const }, { verb: 'Chop Tomato', button: 'secondary' as const }]
    expect(promptText(verbs, false)).toBe('[E] Take Tomato   [F] Chop Tomato')
    expect(promptText(verbs, true)).toBe('Take Tomato · Chop Tomato')
  })

  it('puts the kind where the language wants it', () => {
    expect(verbWith('Pick up', 'Tomato')).toBe('Pick up Tomato')
    expect(verbWith('Coger {item}', 'Tomate')).toBe('Coger Tomate')
    expect(verbWith('{item} aufheben', 'Ball')).toBe('Ball aufheben')
    expect(verbWith('Drop {item}', '')).toBe('Drop')
  })
})
