// What the assistant sees when it asks: the engine's frame, framed on an entity when it names one,
// shrunk to a size a model reads well. The editor's panels are DOM over the canvas, so they are
// not in the capture; the editor scene's own gizmos are.
import { consoleCommand } from '@ui/engine/console'
import { uiFocusEntity } from '@ui/actions/selection'
import { resolveEntityRef } from '@ui/ai/request-format'
import { state, isUiEntity } from '@scene/state'
import { isReservedEntity } from '@dcl-editor/contract'
import { sendToScene } from '@ui/engine/bus'
import { captureMobileView } from './mobile-view'

const MAX_SIDE = 1024
// the focus tween is 0.3 s; the frame after it has the new view
const FOCUS_SETTLE_MS = 700
const RELOAD_SETTLE_MS = 2000
const RELOAD_TRIES = 5

async function frame(signal: AbortSignal): Promise<ImageBitmap> {
  const png = await consoleCommand('/screenshot')
  signal.throwIfAborted()
  return createImageBitmap(await (await fetch(`data:image/png;base64,${png.trim()}`)).blob())
}

function isBlack(bitmap: ImageBitmap): boolean {
  const probe = new OffscreenCanvas(16, 16)
  const ctx = probe.getContext('2d')
  if (ctx === null) return false
  ctx.drawImage(bitmap, 0, 0, 16, 16)
  const data = ctx.getImageData(0, 0, 16, 16).data
  let sum = 0
  for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2]
  return sum / (data.length / 4) < 12
}

export interface ViewCapture {
  mimeType: 'image/jpeg'
  image: string
  width: number
  height: number
  framed: string | null
}

export interface Point {
  x: number
  y: number
  z: number
}

export interface ViewRequest {
  target?: 'editor' | 'mobile'
  openIfClosed?: boolean
  entity: string | null
  // the free camera moved here, in world metres, looking at lookAt (or keeping its aim)
  from: Point | null
  lookAt: Point | null
}

// The creator's camera comes back where it was once the picture is taken.
export async function captureView(request: ViewRequest, signal: AbortSignal): Promise<ViewCapture> {
  const phone = window.editorShell?.phonePreviewState?.()
  const mobile = request.target === 'mobile' || (request.target === undefined && phone?.mode === 'embedded' && request.from === null && request.entity === null && request.lookAt === null)
  if (mobile) {
    if (request.from !== null || request.entity !== null || request.lookAt !== null) throw new Error('Mobile captures use the current player camera. Use target: editor for entity framing or camera positioning.')
    return { ...await captureMobileView(request.openIfClosed === true, signal), framed: 'mobile preview' }
  }
  const moving = request.from !== null || request.entity !== null
  if (moving) await sendToScene({ type: 'camera-hold' })
  try {
    return await captureFrame(request, signal)
  } finally {
    if (moving) await sendToScene({ type: 'camera-release' })
  }
}

async function captureFrame({ entity, from, lookAt }: ViewRequest, signal: AbortSignal): Promise<ViewCapture> {
  let framed: string | null = null
  if (from !== null) {
    await sendToScene({ type: 'camera-pose', position: from, ...(lookAt === null ? {} : { lookAt }) })
    framed = `from ${from.x} ${from.y} ${from.z}${lookAt === null ? '' : ` towards ${lookAt.x} ${lookAt.y} ${lookAt.z}`}`
    await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS))
    signal.throwIfAborted()
  } else if (entity !== null) {
    const id = resolveEntityRef(state.snapshot, entity)
    if (id === null || isReservedEntity(id) || isUiEntity(state.snapshot, id)) throw new Error('No editable entity matches that reference.')
    uiFocusEntity(id)
    framed = entity
    await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS))
    signal.throwIfAborted()
  }
  let bitmap = await frame(signal)
  // new content or a build re-instances the scene, and its frames are black until it is back
  for (let tries = 0; tries < RELOAD_TRIES && isBlack(bitmap); tries++) {
    bitmap.close()
    await new Promise((resolve) => setTimeout(resolve, RELOAD_SETTLE_MS))
    signal.throwIfAborted()
    bitmap = await frame(signal)
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('The view could not be drawn.')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('The view could not be encoded.'))
    reader.readAsDataURL(jpeg)
  })
  return { mimeType: 'image/jpeg', image: url.slice(url.indexOf(',') + 1), width, height, framed }
}
