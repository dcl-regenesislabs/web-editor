import { describe, expect, it } from 'vitest'
import { batchAnswer } from './batch-answer'

describe('batchAnswer', () => {
  it('says a repeated error once and points the rest at it', () => {
    const playing = 'The scene is playing. Run playtest stop, then make this change again.'
    expect(batchAnswer([
      { type: 'move', outcome: { ok: false, error: playing } },
      { type: 'outline', outcome: { ok: true, result: { entities: [] } } },
      { type: 'move', outcome: { ok: false, error: playing } },
      { type: 'move', outcome: { ok: false, error: 'No editable entity matches that reference.' } }
    ])).toEqual({
      results: [
        { ok: false, error: playing },
        { ok: true, result: { entities: [] } },
        { ok: false, error: 'As request 1.' },
        { ok: false, error: 'No editable entity matches that reference.' }
      ]
    })
  })

  it('answers a placed prefab with what was done, and a read as it is', () => {
    const outline = { entities: [{ id: '600', name: 'Tree', position: { x: 1, y: 0, z: 2 } }], total: 1 }
    expect(batchAnswer([
      { type: 'placePrefab', outcome: { ok: true, result: { outcomes: [{ tool: 'Placed', detail: 'Door' }], problems: [], attached: [] } } },
      { type: 'setParams', outcome: { ok: true, result: { outcomes: [], problems: ['there is no entity called "Gate", so its settings were left alone'], attached: [] } } },
      { type: 'move', outcome: { ok: true, result: { id: '600', position: { x: 2, y: 0, z: 2 } } } },
      { type: 'outline', outcome: { ok: true, result: outline } }
    ])).toEqual({
      results: [
        { ok: true, result: { done: ['Placed Door'] } },
        { ok: true, result: { problems: ['there is no entity called "Gate", so its settings were left alone'] } },
        { ok: true, result: { id: '600' } },
        { ok: true, result: outline }
      ]
    })
  })

  it('leaves a result that shares everything as only ok', () => {
    const removed = { ok: true as const, result: { component: 'MeshRenderer', removed: false } }
    expect(batchAnswer([{ type: 'removeComponent', outcome: removed }, { type: 'removeComponent', outcome: { ...removed, result: { ...removed.result } } }]))
      .toEqual({ results: [{ ok: true }, { ok: true }], same: { removeComponent: { component: 'MeshRenderer', removed: false } } })
  })
})
