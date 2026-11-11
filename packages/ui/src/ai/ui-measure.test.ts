import { describe, expect, it } from 'vitest'
import { measuredNodes } from './ui-measure'

describe('measuredNodes', () => {
  it('names the unmeasured nodes that show text or take presses, and only counts plain containers', () => {
    const { nodes, unnamed, skipped } = measuredNodes({
      '0': {},
      '512': { UiTransform: { parent: 0, elementId: 'hud:top:0' }, UiLayoutFeedback: { rect: { x: 0, y: 0, width: 10, height: 10 }, visible: true } },
      '513': { UiTransform: { parent: 512 } },
      '514': { UiTransform: { parent: 513 }, UiText: { value: 'Score 0', fontSize: 15 } },
      '515': { UiTransform: { parent: 513 }, UiText: { value: '  ' } },
      '516': { UiTransform: { parent: 513 }, PointerEvents: { pointerEvents: [] } },
      '517': { UiTransform: { parent: 513, elementId: 'not-laid-out-yet' }, UiText: { value: 'Later' } }
    })
    expect(nodes.map((node) => node.elementId)).toEqual(['hud:top:0'])
    expect(unnamed).toBe(4)
    // a named node the engine never laid out is as unchecked as an unnamed one
    expect(skipped).toEqual([{ entity: 514, text: 'Score 0' }, { entity: 516, pointer: ['pointer_events'] }, { entity: 517, elementId: 'not-laid-out-yet', text: 'Later' }])
  })
})
