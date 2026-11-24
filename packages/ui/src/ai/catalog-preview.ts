import { catalogUrl, opendclUrl, readCapped, type ModelAsset } from '../assets'
import type { ModelPreview } from '@dcl-editor/contract'
import { log } from '../log'

export async function previewCatalogModels(models: readonly ModelAsset[], signal: AbortSignal): Promise<ModelPreview | undefined> {
  const shown = models.slice(0, 8)
  if (shown.length === 0) return undefined
  const pictures = await Promise.allSettled(shown.map(async (model) => {
    const url = opendclUrl(model.thumbnailUrl)
    if (url === undefined || !catalogUrl(url)) return null
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Thumbnail HTTP ${response.status}`)
    }
    const bytes = await readCapped(response, 2 * 1024 * 1024)
    return createImageBitmap(new Blob([bytes]), { resizeWidth: 256, resizeHeight: 256 })
  }))
  try {
    signal.throwIfAborted()
    if (!pictures.some((picture) => picture.status === 'fulfilled' && picture.value !== null)) return undefined
    const columns = Math.min(4, shown.length), width = columns * 256, height = 32 + Math.ceil(shown.length / columns) * 288
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('Catalog previews need a 2D canvas.')
    ctx.fillStyle = '#e1e2e4'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#24282d'
    ctx.font = '14px sans-serif'
    ctx.fillText('Catalog thumbnails — verify the chosen asset in the scene', 10, 21, width - 20)
    for (const [index, picture] of pictures.entries()) {
      const x = index % columns * 256, y = 32 + Math.floor(index / columns) * 288
      if (picture.status === 'fulfilled' && picture.value !== null) ctx.drawImage(picture.value, x, y, 256, 256)
      else {
        ctx.fillText('Preview unavailable', x + 10, y + 128)
        if (picture.status === 'rejected') log.warn('catalog thumbnail failed', shown[index].name, picture.reason)
      }
      ctx.fillText(`${index + 1}. ${shown[index].name}`, x + 10, y + 276, 236)
    }
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
    const image = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result.split(',')[1]) : reject(new Error('No catalog preview image.'))
      reader.onerror = () => reject(new Error('Catalog preview encoding failed.'))
      reader.readAsDataURL(blob)
    })
    return { image, mimeType: 'image/jpeg', width, height }
  } finally {
    for (const picture of pictures) if (picture.status === 'fulfilled') picture.value?.close()
  }
}
