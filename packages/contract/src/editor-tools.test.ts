import { describe, expect, it } from 'vitest'
import { editorToolContent, editorToolDeadlineMs, editorToolTimeoutMessage } from './editor-tools'

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

  it('bounds images across nested batch results and preserves every result without base64', () => {
    const results = Array.from({ length: 200 }, (_, id) => ({ ok: true, result: { id, preview } }))
    const content = editorToolContent('scene_request', JSON.stringify({ results: [{ ok: true, result: { results } }] }))
    expect(content.filter((part) => part.type === 'image')).toHaveLength(4)
    const last = content.at(-1)!
    expect(last.type === 'text' && last.text).not.toContain('AAAA')
    expect(last.type === 'text' && JSON.parse(last.text).results[0].result.results).toHaveLength(200)
  })

  it.each([null, { image: 'AAAA' }, { ...preview, width: -1 }, { ...preview, image: 'A'.repeat(400_001) }])(
    'keeps successful build metadata when its preview is malformed or oversized', (preview) => {
      const content = editorToolContent('scene_request', JSON.stringify({ path: 'models/tree.glb', preview }))
      expect(content.filter((part) => part.type === 'image')).toHaveLength(0)
      const last = content.at(-1)!
      expect(last.type === 'text' && JSON.parse(last.text)).toMatchObject({ path: 'models/tree.glb' })
      expect(last.type === 'text' && last.text).not.toContain('AAAA')
    }
  )
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
