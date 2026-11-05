import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DclEditorHost, setHost } from '../../engine/hosted'
import { chrome, setAdvanced } from '../../core/chrome'
import { run } from '../../test/render'
import { advancedOffered, entryMode, showAdvanced } from './entry-mode'

const shellHost = window as unknown as { editorShell?: { aiSend: () => Promise<void> } }
const webHost = (features?: { advanced?: boolean }): DclEditorHost =>
  ({ version: 1, engineConsole: async () => '', features }) as Partial<DclEditorHost> as DclEditorHost

beforeEach(() => {
  shellHost.editorShell = { aiSend: async () => {} }
})

afterEach(() => {
  setHost(null)
  delete shellHost.editorShell
  run(() => {
    chrome.advanced = null
  })
})

describe('entry mode', () => {
  it('is where the web editor starts, and the desktop app does not', () => {
    expect(entryMode()).toBe(false)
    setHost(webHost({ advanced: true }))
    expect(entryMode()).toBe(true)
  })

  it('follows the creator once they pick, where advanced is offered', () => {
    run(() => setAdvanced(true))
    setHost(webHost({ advanced: true }))
    expect(entryMode()).toBe(false)
    setHost(null)
    run(() => setAdvanced(false))
    expect(entryMode()).toBe(true)
  })

  it('needs an assistant to leave for: without one, advanced is all an offering host shows', () => {
    setHost(webHost({ advanced: true }))
    delete shellHost.editorShell
    expect(entryMode()).toBe(false)
  })

  it('leaves for the whole editor when something reveals one of its panels', () => {
    setHost(webHost({ advanced: true }))
    run(showAdvanced)
    expect(chrome.advanced).toBe(true)
    expect(entryMode()).toBe(false)
  })
})

describe('advanced', () => {
  it('is offered by the desktop app, and by a host only when its features say so', () => {
    expect(advancedOffered()).toBe(true)
    setHost(webHost({ advanced: true }))
    expect(advancedOffered()).toBe(true)
    for (const features of [undefined, {}, { advanced: false }]) {
      setHost(webHost(features))
      expect(advancedOffered()).toBe(false)
    }
    setHost({ version: 0, engineConsole: async () => '' } as Partial<DclEditorHost> as DclEditorHost)
    expect(advancedOffered()).toBe(false)
  })

  it('stays out of reach where it is not offered: a remembered pick, a reveal, no assistant', () => {
    setHost(webHost())
    run(() => setAdvanced(true))
    expect(entryMode()).toBe(true)
    run(() => {
      chrome.advanced = null
    })
    run(showAdvanced)
    expect(chrome.advanced).toBe(null)
    expect(entryMode()).toBe(true)
    delete shellHost.editorShell
    expect(entryMode()).toBe(true)
  })
})
