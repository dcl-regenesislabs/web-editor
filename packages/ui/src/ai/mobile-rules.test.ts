import { describe, expect, it } from 'vitest'
import { keyHintIssues, layoutIssues, touchIssues, usedActions, visibleButtons, type Canvas, type MeasuredNode } from './mobile-rules'

const PHONE: Canvas = { width: 1600, height: 720, interactable: { left: 436, top: 32, right: 108, bottom: 45 } }
const rules = (nodes: MeasuredNode[], controls = true) => layoutIssues('hud', PHONE, nodes, controls).map((issue) => issue.rule)

describe('layoutIssues', () => {
  it('passes a status panel below the explorer buttons, inside the interactable area', () => {
    expect(rules([{ entity: 1, elementId: 'hud:left:0', rect: [456, 132, 300, 176] }])).toEqual([])
  })

  it('flags a panel under the explorer buttons row, as the Faro HUD sat', () => {
    expect(rules([{ entity: 1, elementId: 'hud:left:0', rect: [456, 52, 300, 176] }])).toEqual(['L2'])
  })

  it('flags a HUD item outside the interactable area and over the action buttons', () => {
    expect(rules([{ entity: 1, elementId: 'hud:right:0', rect: [1300, 400, 340, 200] }])).toEqual(['L1', 'L8', 'L2'])
  })

  it('ignores the touch controls while a modal hides them', () => {
    expect(rules([{ entity: 1, elementId: 'card', rect: [1250, 420, 200, 200], text: 'Close', fontSize: 18 }], false)).toEqual([])
  })

  it('checks touch targets, text size and clipping', () => {
    expect(rules([
      { entity: 1, elementId: 'ok', rect: [700, 300, 120, 40], pointer: ['pointer_events'] },
      { entity: 2, elementId: 'tiny', rect: [700, 400, 120, 30], text: 'hint', fontSize: 12 },
      { entity: 3, elementId: 'letter', rect: [700, 450, 120, 30], text: 'long letter', fontSize: 20, clipped: true }
    ])).toEqual(['L3', 'L4', 'L4'])
  })

  it('flags a pressable covered by a later pressable that is not its child', () => {
    expect(rules([
      { entity: 1, parent: 0, elementId: 'under', order: 1, rect: [700, 300, 100, 60], pointer: ['pointer_events'] },
      { entity: 2, parent: 0, elementId: 'over', order: 2, rect: [720, 310, 100, 60], pointer: ['pointer_events'] },
      { entity: 3, parent: 2, elementId: 'label', order: 3, rect: [730, 320, 60, 50], pointer: ['pointer_events'] }
    ])).toEqual(['L5', 'L5'])
  })

  it('flags two HUD items that overlap, and skips the layout markers', () => {
    expect(rules([
      { entity: 1, elementId: 'hud:top:0', rect: [800, 52, 300, 100] },
      { entity: 2, elementId: 'hud:right:0', rect: [1050, 52, 300, 100] },
      { entity: 3, elementId: 'hud:modals:2', rect: [0, 0, 1, 1] }
    ])).toEqual(['H1'])
  })
})

describe('keyHintIssues', () => {
  const keyed = (text: string) => keyHintIssues('hud', [{ entity: 1, elementId: 'hud-help', rect: [700, 300, 300, 40], text, fontSize: 18 }])
  const flagged = (text: string) => keyed(text).map((issue) => issue.rule)

  it('flags the Overcooked hints, which name E and F on a phone', () => {
    expect(flagged('E / tocar: usar estación')).toEqual(['C3-key-letter'])
    expect(flagged('E: Coger tomate / F: Cortar')).toEqual(['C3-key-letter'])
    expect(keyed('E / tocar: usar estación')[0].detail).toContain('isMobile()')
  })

  it.each([
    '[E] Usar', '(F) cortar', 'Press E to open', 'Pulsa E para cocinar', 'presioná F', 'Hold F to charge', 'tecla 2: arma',
    'Press 3', 'Press 1 to heal', '[1] Espada', 'E to talk', 'E/F: tomar o soltar', 'Mesa — E: dejar', 'PRESS E TO START', 'pulsa e intenta, luego pulsa E'
  ])('flags "%s"', (text) => {
    expect(flagged(text)).toEqual(['C3-key-letter'])
  })

  it.each([
    'Tocá la estación', 'Equipo', 'E-mail', 'Escape', 'F1 race', 'Vitamina E', 'Round 1: go', 'Score 1 / 4', 'Lives (3)',
    'Press 3 buttons', 'presiona e intenta', 'padres E hijos', 'CAFE: abierto', 'Tomate x2', 'Level 4'
  ])('passes "%s"', (text) => {
    expect(flagged(text)).toEqual([])
  })
})

describe('touch buttons', () => {
  it('reads the actions the scene code uses, not the runtime modules', () => {
    expect(usedActions([
      ['src/scripts/Lantern.ts', 'inputSystem.isTriggered(InputAction.IA_SECONDARY, PointerEventType.PET_DOWN)'],
      ['src/scripts/Mirror.ts', 'button: InputAction2.IA_PRIMARY, and InputAction.IA_FORWARD'],
      ['src/scripts/runtime/game.ts', 'InputAction.IA_ACTION_3'],
      ['assets/notes.md', 'InputAction.IA_ACTION_4']
    ])).toEqual(['IA_PRIMARY', 'IA_SECONDARY'])
  })

  it('treats every button as shown unless TouchScreenControls hides it', () => {
    expect(visibleButtons(undefined)).toHaveLength(8)
    expect(visibleButtons({ touchInputs: [{ inputAction: 10, hide: true }, { inputAction: 'IA_ACTION_4', hide: true }, { inputAction: 1, hide: false }] }))
      .toEqual(['IA_POINTER', 'IA_PRIMARY', 'IA_SECONDARY', 'IA_JUMP', 'IA_ACTION_5', 'IA_ACTION_6'])
  })

  it('reports the Faro case: E and F used, 1–4 left on screen', () => {
    const issues = touchIssues(['IA_PRIMARY', 'IA_SECONDARY'], visibleButtons(undefined))
    expect(issues.map((issue) => issue.rule)).toEqual(['C2'])
    expect(issues[0].detail).toContain('IA_ACTION_3, IA_ACTION_4, IA_ACTION_5, IA_ACTION_6')
  })

  it('reports an action the code reads whose button is hidden', () => {
    expect(touchIssues(['IA_PRIMARY'], ['IA_JUMP']).map((issue) => issue.rule)).toEqual(['C1'])
  })
})
