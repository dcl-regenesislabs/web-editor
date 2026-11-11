import { describe, expect, it } from 'vitest'
import { editorToolContent, editorToolDeadlineMs, editorToolTimeoutMessage } from './editor-tools'

describe('editorToolContent', () => {
  it('hands a playtest picture to the model as an image and keeps the rest as text', () => {
    expect(editorToolContent('playtest', JSON.stringify({ ok: true, steps: [] }))).toEqual([{ type: 'text', text: '{"ok":true,"steps":[]}' }])
    expect(editorToolContent('playtest', JSON.stringify({ ok: true, view: { mimeType: 'image/jpeg', image: 'AAAA', width: 2, height: 2 } }))).toEqual([
      { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
      { type: 'text', text: '{"ok":true}' }
    ])
  })
})

describe('editorToolDeadlineMs', () => {
  it('follows the steps a playtest was given, and leaves tools without a deadline alone', () => {
    const short = editorToolDeadlineMs('playtest', { action: 'steps', steps: [{ action: 'wait', durationMs: 2000 }] })
    const long = editorToolDeadlineMs('playtest', { action: 'steps', steps: [{ action: 'start' }, { action: 'waitFor', hud: 'Won', timeoutMs: 60_000 }], view: true })
    expect(short).toBe(2000 + 8000 + 8000 + 30_000)
    expect(long).toBe(120_000 + 60_000 + 2 * 8000 + 8000 + 45_000 + 30_000)
    // a value out of range counts as its maximum, not as unbounded
    expect(editorToolDeadlineMs('playtest', { action: 'wait', durationMs: 1e9 })).toBe(5000 + 16_000 + 30_000)
    expect(editorToolDeadlineMs('build', {})).toBe(240_000)
    expect(editorToolDeadlineMs('write_file', {})).toBeUndefined()
  })

  it('tells the model why a call ran out of time and what to do next', () => {
    expect(editorToolTimeoutMessage('build', 240_000, 'the engine is busy'))
      .toBe('The build did not answer within 240 s; the engine is busy. Try again once, or carry on and tell the creator what is left.')
  })
})
