// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uiLayout } from './ui-layout'

const CANVAS = { width: 1500, height: 675, devicePixelRatio: 2, interactableArea: { left: 408.75, top: 30, right: 101.25, bottom: 42.1875 } }
const SNAPSHOT = {
  '0': { UiCanvasInformation: CANVAS },
  '512': { UiTransform: { parent: 0, elementId: 'hud' }, UiLayoutFeedback: { rect: { x: 0, y: 0, width: 1500, height: 675 }, visibleRect: { x: 0, y: 0, width: 1500, height: 675 }, visible: true, drawOrder: 3 } },
  '513': {
    UiTransform: { parent: 512, elementId: 'dash', zIndex: 2 },
    UiText: { value: 'DASH', fontSize: 24 },
    PointerEvents: { pointerEvents: [] },
    UiLayoutFeedback: { rect: { x: 1300, y: 500, width: 90, height: 90 }, visibleRect: { x: 1300, y: 500, width: 90, height: 80 }, visible: true, drawOrder: 4 }
  },
  '514': { UiTransform: { parent: 512, elementId: 'hidden' }, UiLayoutFeedback: { rect: { x: 0, y: 0, width: 10, height: 10 }, visible: false, drawOrder: 5 } },
  '515': { UiTransform: { parent: 512 }, UiText: { value: 'no id' } },
  '600': { Transform: {} }
}

const mock = vi.hoisted(() => ({
  state: { frozen: false },
  platform: 'mobile' as 'desktop' | 'mobile',
  snapshot: {} as Record<string, Record<string, unknown>>,
  calls: [] as string[]
}))
vi.mock('@scene/state', () => ({ state: mock.state }))
vi.mock('../engine/cmd', () => ({
  cmd: {
    crdtSnapshot: async () => {
      mock.calls.push('snapshot')
      return mock.snapshot
    }
  }
}))
vi.mock('./playtest', () => ({ playtestPlatform: () => mock.platform }))
vi.mock('./view', () => ({
  captureView: async () => {
    mock.calls.push('view')
    return { mimeType: 'image/jpeg', image: 'AAAA', width: 2, height: 1, framed: null }
  }
}))

describe('ui_layout', () => {
  beforeEach(() => {
    mock.calls.length = 0
    mock.state.frozen = false
    mock.snapshot = SNAPSHOT
  })

  it('measures the named nodes on screen from the snapshot, only the fields a node has, and changes nothing', async () => {
    const result = await uiLayout({}, new AbortController().signal) as { nodes: unknown[] }
    expect(result.nodes).toEqual([
      { entity: 512, parent: 0, elementId: 'hud', order: 3, rect: [0, 0, 1500, 675] },
      { entity: 513, parent: 512, elementId: 'dash', order: 4, zIndex: 2, rect: [1300, 500, 90, 90], clipped: true, visibleRect: [1300, 500, 90, 80], pointer: ['pointer_events'], text: 'DASH', fontSize: 24 }
    ])
    expect(result).toMatchObject({ platform: 'mobile', canvas: CANVAS, unmeasured: '1 UI nodes have no elementId and were not measured', view: { image: 'AAAA' } })
    expect(mock.calls).toEqual(['snapshot', 'view'])
  })

  it('says nothing was measured, why and what to do instead, with the picture, when no node has an element id', async () => {
    mock.snapshot = { '0': { UiCanvasInformation: CANVAS }, '515': { UiTransform: { parent: 0 } } }
    const result = await uiLayout({}, new AbortController().signal) as Record<string, unknown>
    expect(result).toMatchObject({ platform: 'mobile', canvas: CANVAS, measured: false, unmeasurable: 'no-element-ids', view: { image: 'AAAA' } })
    expect(result).not.toHaveProperty('nodes')
    expect(result.why).toContain('None of the 1 UI nodes has an elementId')
    // without a probe the SDK is unknown: the answer covers both
    expect(result.instead).toContain('check its type')
    expect(result.instead).toContain('by hand')
  })

  it('blames the scene SDK when the probe says uiTransform has no elementId, and asks for no element ids', async () => {
    mock.snapshot = { '0': { UiCanvasInformation: CANVAS }, '515': { UiTransform: { parent: 0 } }, '516': { UiTransform: { parent: 515 } } }
    const result = await uiLayout({}, new AbortController().signal, undefined, async () => ({ elementId: false, version: '7.33.0' })) as Record<string, unknown>
    expect(result).toMatchObject({ measured: false, unmeasurable: 'sdk-has-no-element-id' })
    expect(result.why).toContain("@dcl/sdk 7.33.0 has no elementId")
    expect(result.instead).toContain('Do not write elementId')
    expect(result.instead).toContain('@dcl/sdk@experimental-bevy-auth-server')
  })

  it('names the explorer when nodes have element ids but none got a layout', async () => {
    mock.snapshot = { '0': { UiCanvasInformation: CANVAS }, '512': { UiTransform: { parent: 0, elementId: 'hud' } } }
    const result = await uiLayout({}, new AbortController().signal, undefined, async () => ({ elementId: true })) as Record<string, unknown>
    expect(result).toMatchObject({ measured: false, unmeasurable: 'explorer-has-no-layout-feedback' })
    expect(result.why).toContain('UiLayoutFeedback')
  })

  it('says when the scene draws no screen UI at all', async () => {
    mock.snapshot = { '0': { UiCanvasInformation: CANVAS }, '600': { Transform: {} } }
    const result = await uiLayout({}, new AbortController().signal) as Record<string, unknown>
    expect(result).toMatchObject({ measured: false, unmeasurable: 'no-ui' })
  })

  it('notes that nothing measured is on screen rather than answering an empty list alone', async () => {
    mock.snapshot = { '0': { UiCanvasInformation: CANVAS }, '514': SNAPSHOT['514'] }
    const result = await uiLayout({}, new AbortController().signal) as Record<string, unknown>
    expect(result).toMatchObject({ measured: true, nodes: [] })
    expect(result.note).toContain('no measured node is on screen')
  })

  it('measures only while the game runs', async () => {
    mock.state.frozen = true
    await expect(uiLayout({}, new AbortController().signal)).rejects.toThrow('Start playtesting')
    expect(mock.calls).toEqual([])
  })
})
