import { describe, expect, it } from 'vitest'
import { editorToolContent } from './editor-tools'

describe('model preview tool results', () => {
  const preview = { mimeType: 'image/jpeg', image: 'AAAA', width: 1152, height: 384 }

  it('delivers the preview as an image and keeps build metadata without base64 in text', () => {
    const content = editorToolContent('scene_request', JSON.stringify({ path: 'models/tree.glb', stats: { triangles: 6000 }, preview }))
    expect(content).toContainEqual({ type: 'image', mimeType: 'image/jpeg', data: 'AAAA' })
    const texts = content.filter((part) => part.type === 'text').map((part) => part.text)
    expect(texts.join(' ')).not.toContain('AAAA')
    expect(JSON.parse(texts.at(-1)!)).toEqual({ path: 'models/tree.glb', stats: { triangles: 6000 } })
  })

  it('extracts each successful model in a batch without hiding failures', () => {
    const content = editorToolContent('scene_request', JSON.stringify({ results: [
      { ok: true, result: { path: 'models/tree.glb', preview } },
      { ok: false, error: 'over budget' },
      { ok: true, result: { path: 'models/rock.glb', preview } }
    ] }))
    expect(content.filter((part) => part.type === 'image')).toHaveLength(2)
    const last = content.at(-1)!
    expect(last.type === 'text' && last.text).toContain('over budget')
    expect(last.type === 'text' && last.text).not.toContain('AAAA')
  })

  it('leaves other scene results unchanged, including a model whose preview failed', () => {
    const result = JSON.stringify({ path: 'models/tree.glb', warnings: ['preview failed'] })
    expect(editorToolContent('scene_request', result)).toEqual([{ type: 'text', text: result }])
  })
})

describe('editorToolContent', () => {
  it('hands a playtest picture to the model as an image and keeps the rest as text', () => {
    expect(editorToolContent('playtest', JSON.stringify({ ok: true, steps: [] }))).toEqual([{ type: 'text', text: '{"ok":true,"steps":[]}' }])
    expect(editorToolContent('playtest', JSON.stringify({ ok: true, view: { mimeType: 'image/jpeg', image: 'AAAA', width: 2, height: 2 } }))).toEqual([
      { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
      { type: 'text', text: '{"ok":true}' }
    ])
  })
})
