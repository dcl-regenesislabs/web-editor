import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { ThreeReply, ThreeRequest } from './protocol'
import { renderModelPreview } from './model-preview'

const { scope } = vi.hoisted(() => {
  const scope = { onmessage: null as ((event: MessageEvent) => void) | null }
  vi.stubGlobal('self', scope)
  return { scope }
})
vi.mock('./model-preview', () => ({ renderModelPreview: vi.fn(async () => ({ mimeType: 'image/jpeg', image: 'AAAA', width: 1152, height: 384 })) }))
import './worker'

const port = { postMessage: vi.fn<(reply: ThreeReply) => void>(), onmessage: null as ((event: MessageEvent<ThreeRequest>) => void) | null }
beforeAll(() => scope.onmessage?.({ data: 'view', ports: [port] } as unknown as MessageEvent))
afterAll(() => vi.unstubAllGlobals())

it.each(['texture.jpg', 'https://example.com/texture.jpg', 'toString'])('refuses a missing external file (%s) before invoking the renderer', (uri) => {
  vi.mocked(renderModelPreview).mockClear()
  port.onmessage?.({ data: { kind: 'preview', bytes: new TextEncoder().encode(JSON.stringify({ images: [{ uri }] })).buffer, files: {} } } as unknown as MessageEvent<ThreeRequest>)
  expect(port.postMessage).toHaveBeenLastCalledWith({ kind: 'failed', error: 'The model refers to files outside it.' }, [])
  expect(renderModelPreview).not.toHaveBeenCalled()
})

it('previews embedded and explicitly supplied resources and returns render failures', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ images: [{ uri: 'wood.jpg' }, { uri: 'data:image/png;base64,AAAA' }] })).buffer
  const files = { 'wood.jpg': new ArrayBuffer(0) }
  port.onmessage?.({ data: { kind: 'preview', bytes, files } } as unknown as MessageEvent<ThreeRequest>)
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenLastCalledWith({ kind: 'previewed', preview: { mimeType: 'image/jpeg', image: 'AAAA', width: 1152, height: 384 } }, []))
  expect(renderModelPreview).toHaveBeenLastCalledWith(bytes, files)
  vi.mocked(renderModelPreview).mockRejectedValueOnce(new Error('No visible geometry'))
  port.onmessage?.({ data: { kind: 'preview', bytes, files } } as unknown as MessageEvent<ThreeRequest>)
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenLastCalledWith({ kind: 'failed', error: 'No visible geometry' }, []))
})
