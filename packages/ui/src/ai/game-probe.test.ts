import { describe, expect, it } from 'vitest'
import { bounded, gameView, parseProbe, stateChanges, type ProbeAnswer } from './game-probe'

const line = (seq: number, body: string): string => `[4.20] Log: [studio] game-probe ${seq} ${body}`

describe('parseProbe', () => {
  it('reads the answer to this probe and no other', () => {
    const logs = [
      line(6, '{"state":{"score":1}}'),
      '[4.3] Log: hello',
      line(7, '{"state":{"score":2},"omitted":{"board":9000},"now":5,"life":"running","requests":[{"name":"chop","at":4,"refused":"too far"},{"bad":1}]}')
    ].join('\n')
    expect(parseProbe(logs, 7)).toEqual({
      state: { score: 2 }, omitted: { board: 9000 }, now: 5, life: 'running', requests: [{ name: 'chop', at: 4, refused: 'too far' }]
    })
    expect(parseProbe(logs, 8)).toBeNull()
    expect(parseProbe(logs, 70)).toBeNull()
  })

  it('says so when the engine cut the line', () => {
    expect(() => parseProbe(line(3, '{"state":{"a":"xx…[truncated]'), 3)).toThrow('cut short')
  })
})

describe('bounded', () => {
  it('keeps small values as they are', () => {
    expect(bounded({ a: [1, 2], b: 'hi', c: null })).toEqual({ value: { a: [1, 2], b: 'hi', c: null }, cut: false })
  })

  it('cuts long lists, long strings and deep levels, and says where', () => {
    const { value, cut } = bounded({ list: Array.from({ length: 30 }, (_, i) => i), text: 'x'.repeat(500), deep: { a: { b: { c: { d: 1 } } } } })
    expect(cut).toBe(true)
    const shown = value as { list: unknown[]; text: string; deep: unknown }
    expect(shown.list).toHaveLength(13)
    expect(shown.list[12]).toBe('… 18 more')
    expect(shown.text).toMatch(/… \(500 chars\)$/)
    expect(shown.deep).toEqual({ a: { b: { c: '{1 keys}' } } })
  })
})

describe('stateChanges', () => {
  it('names the leaf that moved', () => {
    expect(stateChanges(
      { boards: { left: { chopped: 0, item: 'tomato' } }, orders: ['soup'], score: 3 },
      { boards: { left: { chopped: 1, item: 'tomato' } }, orders: ['soup', 'salad'], score: 3, holding: 'knife' }
    )).toEqual({
      'boards.left.chopped': { before: 0, after: 1 },
      orders: { before: ['soup'], after: ['soup', 'salad'] },
      holding: { before: null, after: 'knife' }
    })
  })

  it('is empty when nothing changed, and bounded when everything did', () => {
    expect(stateChanges({ a: { b: 1 } }, { a: { b: 1 } })).toEqual({})
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]))
    const changes = stateChanges({}, many)
    expect(Object.keys(changes)).toHaveLength(21)
    expect(changes['…'].after).toBe('10 more changed paths')
  })
})

describe('gameView', () => {
  const at = (state: Record<string, unknown>, extra: Partial<ProbeAnswer> = {}): ProbeAnswer =>
    ({ state, omitted: {}, now: 2000, life: 'running', requests: [], ...extra })

  it('lifts the round out of the state and notes what it could not show', () => {
    expect(gameView(at({ round: { id: 'w-2', number: 2, seed: 9, phase: 1 }, big: 'y'.repeat(300) }, { omitted: { board: 7000 } }), null, '')).toEqual({
      life: 'running', now: 2000,
      round: { id: 'w-2', number: 2, phase: 1 },
      state: { big: `${'y'.repeat(160)}… (300 chars)` },
      requests: [],
      notes: ['Long or deep values are cut (… marks where).', 'state.board (7000 bytes) is too large to show here.']
    })
  })
})
