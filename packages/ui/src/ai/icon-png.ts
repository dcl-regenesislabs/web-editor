// An icon's SVG drawn into a square PNG: Decentraland UI textures are images, not SVG.
// The catalog's icons are white on transparent, so a scene tints one with uiBackground's color.
export const ICON_SIZES = [64, 128, 256] as const
export type IconSize = (typeof ICON_SIZES)[number]

// Sized to `size` and scaled from its own coordinates: an SVG with only width/height (Kenney's) gets a
// viewBox first, or a bigger width would just crop it.
export function sizedSvg(svg: string, size: number): string {
  const open = /^<svg\b[^>]*>/.exec(svg)
  if (open === null) throw new Error('The icon is not an SVG.')
  let tag = open[0]
  const attr = (name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
  if (attr('viewBox') === undefined) {
    const w = Number.parseFloat(attr('width') ?? '')
    const h = Number.parseFloat(attr('height') ?? '')
    if (!(w > 0 && h > 0)) throw new Error('The icon has no size to scale from.')
    tag = tag.replace(/^<svg\b/, `<svg viewBox="0 0 ${w} ${h}"`)
  }
  tag = tag.replace(/\s(width|height)="[^"]*"/g, '').replace(/^<svg\b/, `<svg width="${size}" height="${size}"`)
  return tag + svg.slice(open[0].length)
}

export async function iconPng(svg: string, size: IconSize): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([sizedSvg(svg, size)], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    const canvas = new OffscreenCanvas(size, size)
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('The icon could not be drawn.')
    ctx.drawImage(image, 0, 0, size, size)
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}
