import { afterEach, expect, it, vi } from 'vitest'
import type { EditorShell, PhonePreviewState } from '@dcl-editor/contract'
import { PhonePreviewPane } from './PhonePreviewPane'
import { mount, run, type Mounted } from '../../test/render'

const { setViewportActive } = vi.hoisted(() => ({ setViewportActive: vi.fn() }))
vi.mock('../../engine/hosted', () => ({ getHost: () => ({ setViewportActive }) }))

let ui: Mounted | null = null
afterEach(() => {
  ui?.unmount()
  ui = null
  delete window.editorShell
  vi.clearAllMocks()
})

it('restores editing when the mobile preview moves to a tab', () => {
  let preview: PhonePreviewState = { mode: 'embedded', url: 'about:blank', ready: true }
  let notify = (): void => {}
  Object.defineProperty(window, 'editorShell', { configurable: true, value: {
    phonePreviewState: () => preview,
    onPhonePreviewState: (listener) => { notify = listener; return () => {} }
  } satisfies Partial<EditorShell> })
  ui = mount(<PhonePreviewPane left={320} right={320} />)
  expect(setViewportActive).toHaveBeenLastCalledWith(false)
  expect(ui.find('iframe')).not.toBeNull()

  run(() => { preview = { ...preview, mode: 'tab' }; notify() })
  expect(setViewportActive).toHaveBeenLastCalledWith(true)
  expect(ui.find('.eui-phone-preview-stage')).toBeNull()
  expect(ui.find('iframe')).toBeNull()
  expect(ui.find('button[aria-label="Move preview here"]')).not.toBeNull()
  expect(ui.find('button[aria-label="Close preview"]')).not.toBeNull()

  run(() => { preview = { ...preview, mode: 'embedded' }; notify() })
  expect(setViewportActive).toHaveBeenLastCalledWith(false)
  ui.unmount()
  ui = null
  expect(setViewportActive).toHaveBeenLastCalledWith(true)
})

it('keeps the frame mounted while paused and restores the editor viewport', async () => {
  let preview: PhonePreviewState = { mode: 'embedded', url: 'about:blank', ready: true }
  let notify = (): void => {}
  const closePhonePreview = vi.fn()
  const phonePreview = vi.fn<NonNullable<EditorShell['phonePreview']>>(async (mode = 'embedded') => {
    preview = { ...preview, mode }
    notify()
    return { ok: true }
  })
  Object.defineProperty(window, 'editorShell', { configurable: true, value: {
    phonePreviewState: () => preview,
    onPhonePreviewState: (listener) => { notify = listener; return () => {} },
    phonePreview, closePhonePreview
  } satisfies Partial<EditorShell> })
  ui = mount(<PhonePreviewPane left={320} right={320} />)
  const frame = ui.find('iframe')
  expect(ui.find('button[aria-label="Open preview in tab"] svg')).not.toBeNull()
  ui.click(ui.find('button[aria-label="Minimize preview"]'))
  await ui.settle()
  expect(phonePreview).toHaveBeenLastCalledWith('minimized')
  expect(ui.find('iframe')).toBe(frame)
  expect(ui.find('.eui-phone-preview-stage')?.hidden).toBe(true)
  expect(ui.byText('Paused')).not.toBeNull()
  expect(setViewportActive).toHaveBeenLastCalledWith(true)
  ui.click(ui.find('button[aria-label="Restore preview"]'))
  await ui.settle()
  expect(phonePreview).toHaveBeenLastCalledWith('embedded')
  expect(ui.find('iframe')).toBe(frame)
  expect(ui.find('.eui-phone-preview-stage')?.hidden).toBe(false)
  expect(setViewportActive).toHaveBeenLastCalledWith(false)
  ui.click(ui.find('button[aria-label="Close preview"]'))
  expect(closePhonePreview).toHaveBeenCalledOnce()
})
