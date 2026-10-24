import { object } from '@dcl-editor/contract'

// The scene thumbnail the assistant's image model painted: cropped to Decentraland's 16:9 at 1920×1080
// and saved as the project's navmap thumbnail. Only a small preview, when asked, goes back to the model.
// Each painting is a new version, so the creator can go back to an earlier one.
export const THUMBNAIL_VERSION = /^assets\/images\/thumbnail-(\d+)\.jpg$/
export const thumbnailPath = (version: number): string => `assets/images/thumbnail-${version}.jpg`
export const THUMBNAIL_WIDTH = 1920
export const THUMBNAIL_HEIGHT = 1080
const PREVIEW_WIDTH = 384
const PREVIEW_HEIGHT = 216
const MAX_INPUT_BYTES = 12 * 1024 * 1024
// Worlds take a thumbnail of at most 1 MB
const MAX_THUMBNAIL_BYTES = 1024 * 1024
const QUALITIES = [0.88, 0.8, 0.7, 0.6]
const TYPES = ['image/jpeg', 'image/png', 'image/webp']

interface Crop {
  sx: number
  sy: number
  sw: number
  sh: number
}

// cover: the largest centred 16:9 part of the picture
function coverCrop(width: number, height: number): Crop {
  const aspect = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT
  if (width / height > aspect) {
    const sw = Math.round(height * aspect)
    return { sx: Math.round((width - sw) / 2), sy: 0, sw, sh: height }
  }
  const sh = Math.round(width / aspect)
  return { sx: 0, sy: Math.round((height - sh) / 2), sw: width, sh }
}

interface Picture {
  width: number
  height: number
  jpeg(crop: Crop, width: number, height: number, quality: number): Promise<Uint8Array>
  close(): void
}

async function openPicture(bytes: Uint8Array<ArrayBuffer>, mimeType: string): Promise<Picture> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }))
  return {
    width: bitmap.width,
    height: bitmap.height,
    async jpeg(crop, width, height, quality) {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('The thumbnail could not be drawn.')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height)
      return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer())
    },
    close: () => bitmap.close()
  }
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function nextThumbnailVersion(files: string[]): number {
  return Math.max(0, ...files.map((file) => Number(THUMBNAIL_VERSION.exec(file)?.[1] ?? 0))) + 1
}

export interface ThumbnailSaved {
  path: string
  version: number
  width: number
  height: number
  bytes: number
  preview?: { mimeType: 'image/jpeg'; image: string }
}

export async function saveThumbnail(request: Record<string, unknown>, project: {
  files(): Promise<string[]>
  save(path: string, bytes: Uint8Array): Promise<void>
  // points scene.json's display.navmapThumbnail at the file
  setThumbnail(path: string): Promise<unknown>
}, signal: AbortSignal): Promise<ThumbnailSaved> {
  const { image, mimeType } = request
  if (typeof mimeType !== 'string' || !TYPES.includes(mimeType) || typeof image !== 'string' ||
    image.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
    throw new Error('saveThumbnail needs the image model\'s picture.')
  }
  const picture = await openPicture(fromBase64(image), mimeType)
  try {
    const crop = coverCrop(picture.width, picture.height)
    let jpeg: Uint8Array = new Uint8Array(0)
    for (const quality of QUALITIES) {
      jpeg = await picture.jpeg(crop, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, quality)
      if (jpeg.length <= MAX_THUMBNAIL_BYTES) break
    }
    signal.throwIfAborted()
    const version = nextThumbnailVersion(await project.files())
    const path = thumbnailPath(version)
    await project.save(path, jpeg)
    await project.setThumbnail(path)
    const saved: ThumbnailSaved = { path, version, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, bytes: jpeg.length }
    if (request.preview !== true) return saved
    return { ...saved, preview: { mimeType: 'image/jpeg', image: toBase64(await picture.jpeg(crop, PREVIEW_WIDTH, PREVIEW_HEIGHT, 0.7)) } }
  } finally {
    picture.close()
  }
}

// The thumbnail scene.json points at now, for the image model to revise
export async function readThumbnail(sceneJson: string, read: (path: string) => Promise<Uint8Array>): Promise<{ path: string; mimeType: string; image: string }> {
  const scene: unknown = JSON.parse(sceneJson)
  const path = object(scene) && object(scene.display) ? scene.display.navmapThumbnail : undefined
  if (typeof path !== 'string' || path === '') throw new Error('The scene has no thumbnail yet.')
  const mimeType = /\.png$/i.test(path) ? 'image/png' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : null
  if (mimeType === null) throw new Error(`The thumbnail ${path} is not a jpg or png.`)
  const bytes = await read(path)
  if (bytes.length > MAX_INPUT_BYTES) throw new Error(`The thumbnail ${path} is too large to revise.`)
  return { path, mimeType, image: toBase64(bytes) }
}
