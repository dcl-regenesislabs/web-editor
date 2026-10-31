import { describe, expect, it } from 'vitest'
import {
  ALL_CONTROLS, actionButtons, keyHintIssues, layoutIssues, touchIssues, touchLayout, unionArea, usedActions, visibleButtons,
  type Canvas, type MeasuredNode, type TouchLayout
} from './mobile-rules'

const PHONE: Canvas = { width: 1600, height: 720, interactable: { left: 436, top: 32, right: 108, bottom: 45 } }
const rules = (nodes: MeasuredNode[], controls: TouchLayout | null = ALL_CONTROLS) => layoutIssues('hud', PHONE, nodes, controls).map((issue) => issue.rule)
const rounded = (rect: number[]) => rect.map((n) => Math.round(n))

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
    expect(rules([{ entity: 1, elementId: 'card', rect: [1250, 420, 200, 200], text: 'Close', fontSize: 18 }], null)).toEqual([])
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

describe('the phone controls', () => {
  it('places the action buttons as the mobile client does: the large corner button, an arc, and "+" past five', () => {
    const all = actionButtons(ALL_CONTROLS)
    expect(all.map((button) => button.id)).toEqual(['large jump button', 'pointer button', 'E button', 'F button', '"+" button'])
    expect(rounded(all[0].rect)).toEqual([1336, 519, 156, 156])
    expect(rounded(all[1].rect)).toEqual([1211, 595, 80, 80])
    expect(rounded(all[4].rect)).toEqual([1412, 394, 80, 80])
    expect(actionButtons({ visible: [], joystick: true })).toEqual([])
  })

  it('puts the main action in the large button and a lone second button mid-arc', () => {
    const two = actionButtons({ visible: ['IA_PRIMARY', 'IA_SECONDARY'], main: 'IA_SECONDARY', joystick: true })
    expect(two.map((button) => button.id)).toEqual(['large F button', 'E button'])
    expect(rounded(two[1].rect)).toEqual([1256, 439, 80, 80])
  })

  it('counts only the buttons the scene left visible for L2', () => {
    const score: MeasuredNode = { entity: 1, elementId: 'score', rect: [1400, 394, 90, 100], text: 'Score 12', fontSize: 24 }
    const issues = layoutIssues('hud', PHONE, [score], ALL_CONTROLS)
    expect(issues.map((issue) => issue.rule)).toEqual(['L2'])
    expect(issues[0].detail).toContain('"+" button')
    expect(rules([score], { visible: ['IA_PRIMARY', 'IA_SECONDARY'], joystick: true })).toEqual([])
  })

  it('drops the joystick and its touch zone when the scene hides the joystick', () => {
    const pad: MeasuredNode = { entity: 1, elementId: 'pad', rect: [450, 500, 100, 80], pointer: ['pointer_events'] }
    expect(rules([pad], { visible: [], joystick: true })).toEqual(['L2'])
    expect(rules([pad], { visible: [], joystick: false })).toEqual([])
  })

  it('reads the controls from TouchScreenControls', () => {
    expect(touchLayout({ touchInputs: [{ inputAction: 8, hide: true }], mainAction: 1, hideJoystick: true }))
      .toEqual({ visible: ['IA_POINTER', 'IA_PRIMARY', 'IA_SECONDARY', 'IA_ACTION_3', 'IA_ACTION_4', 'IA_ACTION_5', 'IA_ACTION_6'], main: 'IA_PRIMARY', joystick: false })
    expect(touchLayout(undefined)).toEqual({ visible: visibleButtons(undefined), joystick: true })
  })
})

describe('HUD coverage', () => {
  const none: TouchLayout = { visible: [], joystick: true }

  it('measures the union of rects, overlaps once', () => {
    expect(unionArea([[0, 0, 10, 10], [5, 5, 10, 10], [100, 100, 0, 50]])).toBe(175)
  })

  it('passes a compact HUD clear of the centre', () => {
    expect(rules([
      { entity: 1, elementId: 'hud:left:0', rect: [456, 132, 300, 100] },
      { entity: 2, elementId: 'hud:right:0', rect: [1172, 52, 300, 120] },
      { entity: 3, elementId: 'hud:top:0', rect: [800, 52, 300, 80] }
    ], none)).toEqual([])
  })

  it('fails a HUD over a quarter of the screen and names what to shrink', () => {
    const issues = layoutIssues('hud', PHONE, [
      { entity: 1, elementId: 'hud:right:0', rect: [1132, 52, 340, 600] },
      { entity: 2, elementId: 'hud:top:0', rect: [750, 52, 370, 188] },
      { entity: 3, elementId: 'hud:bottom:0', rect: [580, 560, 440, 100] }
    ], none)
    expect(issues.map((issue) => issue.rule)).toEqual(['H2-coverage'])
    expect(issues[0].detail).toContain('covers 28% of the phone screen')
    expect(issues[0].detail).toMatch(/Shrink hud:right:0 to 340x\d+ or less/)
  })

  it('fails a score box over the screen centre, and says how to clear it', () => {
    const issues = layoutIssues('hud', PHONE, [{ entity: 1, elementId: 'hud:left:0', rect: [456, 132, 340, 420] }], none)
    expect(issues.map((issue) => issue.rule)).toEqual(['H3-centre'])
    expect(issues[0].detail).toContain('at most 340x108')
    expect(issues[0].detail).toContain("'right' column")
  })

  it('lets a status panel clip the centre edge, and a dialog cover the screen', () => {
    expect(rules([{ entity: 1, elementId: 'hud:left:0', rect: [456, 132, 300, 176] }], none)).toEqual([])
    expect(rules([{ entity: 1, elementId: 'hud:top:0', rect: [436, 32, 1056, 643] }], null)).toEqual([])
  })
})

describe('keyHintIssues', () => {
  const keyed = (text: string) => keyHintIssues('hud', [{ entity: 1, elementId: 'hud-help', rect: [700, 300, 300, 40], text, fontSize: 18 }])
  const flagged = (text: string) => keyed(text).map((issue) => issue.rule)

  it('flags hints that name E and F on a phone', () => {
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
