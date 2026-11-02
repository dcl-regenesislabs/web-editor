import { describe, expect, it } from 'vitest'
import { editorToolContent } from './editor-tools'

describe('editorToolContent', () => {
  it('hands a playtest picture to the model as an image and keeps the rest as text', () => {
    expect(editorToolContent('playtest', JSON.stringify({ ok: true, steps: [] }))).toEqual([{ type: 'text', text: '{"ok":true,"steps":[]}' }])
    expect(editorToolContent('playtest', JSON.stringify({ ok: true, view: { mimeType: 'image/jpeg', image: 'AAAA', width: 2, height: 2 } }))).toEqual([
      { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
      { type: 'text', text: '{"ok":true}' }
    ])
  })
})
