import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DclEditorHost, setHost } from '../../engine/hosted'
import { chrome, setAdvanced } from '../../core/chrome'
import { run } from '../../test/render'
import { entryMode, showAdvanced } from './entry-mode'

const shellHost = window as unknown as { editorShell?: { aiSend: () => Promise<void> } }
const webHost = { version: 0, engineConsole: async () => '' } as Partial<DclEditorHost> as DclEditorHost

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
    setHost(webHost)
    expect(entryMode()).toBe(true)
  })

  it('follows the creator once they pick, on either', () => {
    run(() => setAdvanced(true))
    setHost(webHost)
    expect(entryMode()).toBe(false)
    setHost(null)
    run(() => setAdvanced(false))
    expect(entryMode()).toBe(true)
  })

  it('needs an assistant: without one there is nothing to show but the whole editor', () => {
    setHost(webHost)
    delete shellHost.editorShell
    expect(entryMode()).toBe(false)
  })

  it('leaves for the whole editor when something reveals one of its panels', () => {
    setHost(webHost)
    run(showAdvanced)
    expect(chrome.advanced).toBe(true)
    expect(entryMode()).toBe(false)
  })
})
