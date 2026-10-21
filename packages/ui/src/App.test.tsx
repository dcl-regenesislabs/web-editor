import { afterEach, expect, it, vi } from 'vitest'
import { App } from './App'
import { mount, run, type Mounted } from './test/render'
import { aiStore } from './panels/ai-store'
import { state } from '@scene/state'
import type { EditorShell, PhonePreviewState } from '@dcl-editor/contract'
import { setRightOpen } from './core/chrome'
import { setStoredFlag } from './core/persist'

vi.mock('./boot/boot', async (real) => ({ ...(await real<object>()), getBootPhase: () => 'ready', isViewportReady: () => true }))

let ui: Mounted | null = null
afterEach(() => {
  run(() => (aiStore.turnRunning = false))
  ui?.unmount()
  ui = null
  delete window.editorShell
  run(() => setRightOpen(true))
  setStoredFlag('left', true)
})

const shown = (el: HTMLElement | null): boolean => el !== null && el.closest('[hidden]') === null

it('reopens both sidebars without restarting an embedded preview', () => {
  const preview: PhonePreviewState = { mode: 'embedded', url: 'about:blank', ready: true }
  const phonePreview = vi.fn()
  Object.defineProperty(window, 'editorShell', { configurable: true, value: {
    phonePreviewState: () => preview, phonePreview
  } satisfies Partial<EditorShell> })
  ui = mount(<App />)
  ui.click(ui.find('.eui-toolbar button[aria-label="Hide hierarchy"]'))
  ui.click(ui.find('.eui-toolbar button[aria-label="Hide inspector & assistant"]'))
  expect(shown(ui.find('.eui-left'))).toBe(false)
  expect(shown(ui.find('.eui-right-col'))).toBe(false)
  const frame = ui.find('.eui-phone-preview iframe')
  expect(frame).not.toBeNull()

  ui.click(ui.find('.eui-phone-preview button[aria-label="Show hierarchy"]'))
  ui.click(ui.find('.eui-phone-preview button[aria-label="Show inspector & assistant"]'))
  expect(shown(ui.find('.eui-left'))).toBe(true)
  expect(shown(ui.find('.eui-right-col'))).toBe(true)
  expect(ui.find('.eui-phone-preview')?.style.left).not.toBe('12px')
  expect(ui.find('.eui-phone-preview')?.style.right).not.toBe('12px')
  expect(ui.find('.eui-phone-preview iframe')).toBe(frame)
  expect(phonePreview).not.toHaveBeenCalled()
})

it('hides the editor chrome while playing and brings the same panels back on stop', () => {
  ui = mount(<App />)
  const toolbar = ui.find('.eui-toolbar')
  const left = ui.find('.eui-left')
  expect(shown(toolbar) && shown(left) && shown(ui.find('.eui-right-col'))).toBe(true)

  ui.render(<App playing />)
  expect([toolbar, left, ui.find('.eui-right-col')].map(shown)).toEqual([false, false, false])

  ui.render(<App playing={false} />)
  expect(ui.find('.eui-toolbar')).toBe(toolbar)
  expect(ui.find('.eui-left')).toBe(left)
  expect(shown(toolbar) && shown(left) && shown(ui.find('.eui-right-col'))).toBe(true)
})

it('keeps the assistant on screen for the Play its own turn started', () => {
  ui = mount(<App />)
  run(() => (aiStore.turnRunning = true))
  ui.render(<App playing />)
  run(() => (aiStore.turnRunning = false))
  expect(shown(ui.find('.eui-right-col'))).toBe(true)
  expect(shown(ui.find('.eui-toolbar'))).toBe(false)

  ui.render(<App playing={false} />)
  ui.render(<App playing />)
  expect(shown(ui.find('.eui-right-col'))).toBe(false)
})

it('does not warn about editing over a full-screen game', () => {
  ui = mount(<App playing />)
  run(() => (state.playEditWarn = true))
  expect(ui.text()).not.toContain('Editing while playing')
  expect(state.playEditWarn).toBe(false)
})
