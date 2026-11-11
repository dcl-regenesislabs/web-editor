import { startThreeWorker } from '../three/client'
import type { ModelPreview } from '../three/model-preview'
import type { ThreeReply } from '../three/protocol'
import { dataLayerReadFileBytes } from '../engine/datalayer'

export async function previewCodeModel(bytes: Uint8Array<ArrayBuffer>, uris: readonly string[], signal: AbortSignal): Promise<ModelPreview> {
  signal.throwIfAborted()
  const files = Object.fromEntries(await Promise.all(uris.map(async (uri) => [uri, new Uint8Array(await dataLayerReadFileBytes(`models/${uri}`)).buffer])))
  signal.throwIfAborted()
  const worker = await startThreeWorker('view')
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => worker.terminate()
  let abort = stop
  try {
    signal.throwIfAborted()
    return await new Promise<ModelPreview>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Model preview timed out. Use view to inspect it in the scene.')), 8000)
      abort = () => reject(new Error('Model preview stopped.'))
      signal.addEventListener('abort', abort, { once: true })
      worker.onmessage = ({ data }: MessageEvent<ThreeReply>) => {
        if (data.kind === 'previewed') resolve(data.preview)
        else reject(new Error(data.kind === 'failed' ? data.error : 'No model preview was returned.'))
      }
      worker.postMessage({ kind: 'preview', bytes: bytes.slice().buffer, files })
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    stop()
  }
}
