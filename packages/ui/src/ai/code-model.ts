import { startThreeWorker, type ThreeWorker } from '../three/client'
import type { ModelStats, ThreeReply, ThreeRequest } from '../three/protocol'
import { isLibraryName, LIBRARY, type LibraryName } from '../three/materials'

const MAX_GLB_BYTES = 20 * 1024 * 1024

// The script ran before the worker answered, so it can forge the answer: nothing in it is trusted
// beyond what is checked here, and the caller measures the model from the GLB itself.
function checked(reply: Extract<ThreeReply, { kind: 'built' }>): { bytes: Uint8Array<ArrayBuffer>; clips: string[]; library: LibraryName[]; warnings: string[] } {
  const { glb, clips, library, warnings } = reply
  if (!(glb instanceof ArrayBuffer) || glb.byteLength === 0 || glb.byteLength > MAX_GLB_BYTES) throw new Error('The model is missing or over 20 MB.')
  if (!Array.isArray(library) || library.length > LIBRARY.length) throw new Error('The model names too many shared materials.')
  const materials = [...new Set(library)].map((name) => {
    if (!isLibraryName(name)) throw new Error('The model names an unknown shared material.')
    return name
  })
  const names = Array.isArray(clips) ? clips.filter((c): c is string => typeof c === 'string').slice(0, 32).map((c) => c.slice(0, 64)) : []
  const notes = Array.isArray(warnings) ? warnings.filter((w): w is string => typeof w === 'string').slice(0, 8).map((w) => w.slice(0, 300)) : []
  return { bytes: new Uint8Array(glb), clips: names, library: materials, warnings: notes }
}

export const MODEL_BUDGET = { triangles: 8000, materials: 6, textures: 4, largestTexture: 512 }
const BUILD_TIMEOUT_MS = 20_000

export function overBudget(stats: ModelStats, textureProblems: readonly string[] = []): string[] {
  return [
    ...(Object.keys(MODEL_BUDGET) as (keyof ModelStats)[])
      .filter((key) => stats[key] > MODEL_BUDGET[key])
      .map((key) => `${key} ${stats[key]} > ${MODEL_BUDGET[key]}`),
    ...textureProblems.map((problem) => `${problem}; use 64/128/256/512`)
  ]
}

// A fresh worker per build: a script that loops forever is stopped by terminating it.
export async function buildCodeModel(code: string, name: string, signal: AbortSignal): Promise<ReturnType<typeof checked>> {
  signal.throwIfAborted()
  const starting = startThreeWorker('build')
  // a Stop while the sandbox starts: give up now, and close the worker once it is up
  const worker = await new Promise<ThreeWorker>((resolve, reject) => {
    const stop = (): void => {
      reject(new Error('Stopped.'))
      void starting.then((late) => late.terminate(), () => {})
    }
    signal.addEventListener('abort', stop, { once: true })
    starting.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = () => {}
  try {
    const reply = await new Promise<ThreeReply>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`The model script stopped answering after ${BUILD_TIMEOUT_MS / 1000} s: it loops forever or ran out of memory. Make it simpler.`)), BUILD_TIMEOUT_MS)
      abort = () => reject(new Error('Stopped.'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      worker.onmessage = (event: MessageEvent<ThreeReply>) => resolve(event.data)
      worker.postMessage({ kind: 'build', code, name } satisfies ThreeRequest)
    })
    if (reply.kind !== 'built') throw new Error(`The model script failed: ${reply.kind === 'failed' ? String(reply.error).slice(0, 2000) : 'no model'}`)
    return checked(reply)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    worker.terminate()
  }
}
