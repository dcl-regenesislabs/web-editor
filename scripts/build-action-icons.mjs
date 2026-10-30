// Renders the action-icon SVG sources into the PNGs a scene's touch buttons and HUD hints draw.
//
// packages/desktop/runtime-assets/action-icons/<name>.svg is the source, <name>.png beside it the
// output, and packages/ui/src/prefabs/action-icon-data.ts the same bytes for the editor to copy into a
// scene (packages/ui/src/prefabs/action-icons.ts). The repo has no SVG
// rasterizer (no sharp, resvg or canvas in node_modules), and pulling a native one in for twelve
// glyphs costs more than reading the small subset the sources are written in:
//
//   <svg viewBox="0 0 128 128"> <g> <circle> <rect rx> <polygon> <polyline> <line> <path d="M L H V Q C Z">
//   fill, stroke, stroke-width (inherited from <svg>/<g>), transform translate/rotate/scale
//
// White paints; black cuts back to transparent (a knockout, so a source previews on a dark page as it
// will look). Strokes always have round caps and joins. Anything outside the subset throws, so a source
// can never render differently here than in a browser without someone noticing.
//
// Usage:
//   node scripts/build-action-icons.mjs           write the PNGs
//   node scripts/build-action-icons.mjs --check   exit 1 when a PNG is missing or differs from its source
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

export const ICON_SIZE = 128
const SAMPLES = 4
const CURVE_STEPS = 24

// --- pure core (unit-tested in build-action-icons.test.mjs) ---

const IDENTITY = [1, 0, 0, 1, 0, 0]

function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]
  ]
}

function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2]
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]
}

function numbersIn(text) {
  return (text.match(/-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi) ?? []).map(Number)
}

export function parseTransform(text) {
  let m = IDENTITY
  for (const [, op, args] of (text ?? '').matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const n = numbersIn(args)
    if (op === 'translate') m = multiply(m, [1, 0, 0, 1, n[0], n[1] ?? 0])
    else if (op === 'scale') m = multiply(m, [n[0], 0, 0, n[1] ?? n[0], 0, 0])
    else if (op === 'rotate') {
      const a = (n[0] * Math.PI) / 180
      const [cx, cy] = [n[1] ?? 0, n[2] ?? 0]
      m = multiply(m, [1, 0, 0, 1, cx, cy])
      m = multiply(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0])
      m = multiply(m, [1, 0, 0, 1, -cx, -cy])
    } else throw new Error(`transform ${op}() is outside the icon subset`)
  }
  return m
}

function paint(value) {
  if (value === undefined || value === 'none') return null
  const v = value.toLowerCase()
  if (v === 'white' || v === '#fff' || v === '#ffffff') return 'draw'
  if (v === 'black' || v === '#000' || v === '#000000') return 'cut'
  throw new Error(`colour ${value} is outside the icon subset: white paints, black cuts`)
}

// subpaths as point lists, curves flattened
export function pathPoints(d) {
  const subpaths = []
  let current = null
  let [x, y] = [0, 0]
  for (const [, command, args] of d.matchAll(/([MLHVQCZmlhvqcz])([^MLHVQCZmlhvqcz]*)/g)) {
    const n = numbersIn(args)
    const rel = command === command.toLowerCase() && command !== 'z'
    switch (command.toUpperCase()) {
      case 'M':
        for (let i = 0; i < n.length; i += 2) {
          x = (rel ? x : 0) + n[i]
          y = (rel ? y : 0) + n[i + 1]
          if (i === 0) {
            current = { points: [[x, y]], closed: false }
            subpaths.push(current)
          } else current.points.push([x, y])
        }
        break
      case 'L':
        for (let i = 0; i < n.length; i += 2) {
          x = (rel ? x : 0) + n[i]
          y = (rel ? y : 0) + n[i + 1]
          current.points.push([x, y])
        }
        break
      case 'H':
        for (const v of n) { x = (rel ? x : 0) + v; current.points.push([x, y]) }
        break
      case 'V':
        for (const v of n) { y = (rel ? y : 0) + v; current.points.push([x, y]) }
        break
      case 'Q':
        for (let i = 0; i < n.length; i += 4) {
          const [bx, by] = rel ? [x, y] : [0, 0]
          const [x0, y0, cx, cy] = [x, y, bx + n[i], by + n[i + 1]]
          const [ex, ey] = [bx + n[i + 2], by + n[i + 3]]
          for (let s = 1; s <= CURVE_STEPS; s++) {
            const t = s / CURVE_STEPS
            const u = 1 - t
            current.points.push([u * u * x0 + 2 * u * t * cx + t * t * ex, u * u * y0 + 2 * u * t * cy + t * t * ey])
          }
          ;[x, y] = [ex, ey]
        }
        break
      case 'C':
        for (let i = 0; i < n.length; i += 6) {
          const [x0, y0] = [x, y]
          const [bx, by] = rel ? [x, y] : [0, 0]
          const [c1x, c1y, c2x, c2y] = [bx + n[i], by + n[i + 1], bx + n[i + 2], by + n[i + 3]]
          const [ex, ey] = [bx + n[i + 4], by + n[i + 5]]
          for (let s = 1; s <= CURVE_STEPS; s++) {
            const t = s / CURVE_STEPS
            const u = 1 - t
            current.points.push([
              u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex,
              u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey
            ])
          }
          ;[x, y] = [ex, ey]
        }
        break
      case 'Z':
        current.closed = true
        ;[x, y] = current.points[0]
        break
    }
  }
  return subpaths
}

function attributes(tag) {
  const out = {}
  for (const [, key, value] of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[key] = value
  return out
}

const INHERITED = ['fill', 'stroke', 'stroke-width']

/** The shapes of an icon source, in paint order, each with its own transform. */
export function parseSvg(text) {
  const shapes = []
  const stack = [{ style: { fill: 'black', 'stroke-width': '1' }, matrix: IDENTITY }]
  let viewBox = null
  for (const [, closing, name, body, selfClosing] of text.matchAll(/<(\/?)([\w:-]+)([^>]*?)(\/?)>/g)) {
    if (name.startsWith('?') || name.startsWith('!')) continue
    if (closing === '/') {
      if (name === 'svg' || name === 'g') stack.pop()
      continue
    }
    const attrs = attributes(body)
    const parent = stack[stack.length - 1]
    const style = { ...parent.style }
    for (const key of INHERITED) if (attrs[key] !== undefined) style[key] = attrs[key]
    const matrix = multiply(parent.matrix, parseTransform(attrs.transform))
    if (name === 'svg') {
      viewBox = numbersIn(attrs.viewBox ?? '')
      stack.push({ style, matrix })
      continue
    }
    if (name === 'g') {
      if (selfClosing !== '/') stack.push({ style, matrix })
      continue
    }
    const fill = paint(style.fill)
    const stroke = paint(style.stroke)
    const width = Number(style['stroke-width'])
    const base = { fill, stroke, width, inverse: invert(matrix) }
    const num = (key) => Number(attrs[key] ?? 0)
    let shape
    if (name === 'circle') shape = { ...base, kind: 'circle', cx: num('cx'), cy: num('cy'), r: num('r') }
    else if (name === 'rect') {
      shape = { ...base, kind: 'rect', x: num('x'), y: num('y'), w: num('width'), h: num('height'), rx: Number(attrs.rx ?? attrs.ry ?? 0) }
    } else if (name === 'line') {
      shape = { ...base, kind: 'path', subpaths: [{ points: [[num('x1'), num('y1')], [num('x2'), num('y2')]], closed: false }] }
    } else if (name === 'polygon' || name === 'polyline') {
      const n = numbersIn(attrs.points)
      const points = []
      for (let i = 0; i < n.length; i += 2) points.push([n[i], n[i + 1]])
      shape = { ...base, kind: 'path', subpaths: [{ points, closed: name === 'polygon' }] }
    } else if (name === 'path') shape = { ...base, kind: 'path', subpaths: pathPoints(attrs.d) }
    else throw new Error(`<${name}> is outside the icon subset`)
    shapes.push({ ...shape, bounds: deviceBounds(shape, matrix) })
  }
  if (viewBox === null || viewBox.length !== 4) throw new Error('an icon source needs <svg viewBox="0 0 w h">')
  return { viewBox, shapes }
}

// where a shape can touch, in viewBox units, so a sample far from it skips the exact test
function deviceBounds(shape, matrix) {
  const pad = shape.stroke === null ? 0 : shape.width / 2
  let corners
  if (shape.kind === 'circle') corners = [[shape.cx - shape.r, shape.cy - shape.r], [shape.cx + shape.r, shape.cy + shape.r]]
  else if (shape.kind === 'rect') corners = [[shape.x, shape.y], [shape.x + shape.w, shape.y + shape.h]]
  else {
    const all = shape.subpaths.flatMap((subpath) => subpath.points)
    corners = [[Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))], [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))]]
  }
  const [[x0, y0], [x1, y1]] = [[corners[0][0] - pad, corners[0][1] - pad], [corners[1][0] + pad, corners[1][1] + pad]]
  const points = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]])
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax
  const dy = by - ay
  const length = dx * dx + dy * dy
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function winding(px, py, subpaths) {
  let w = 0
  for (const { points } of subpaths) {
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i]
      const [bx, by] = points[(i + 1) % points.length]
      const side = (bx - ax) * (py - ay) - (px - ax) * (by - ay)
      if (ay <= py && by > py && side > 0) w++
      else if (ay > py && by <= py && side < 0) w--
    }
  }
  return w
}

function strokeDistance(px, py, subpaths) {
  let best = Infinity
  for (const { points, closed } of subpaths) {
    const last = closed ? points.length : points.length - 1
    for (let i = 0; i < last; i++) best = Math.min(best, segmentDistance(px, py, points[i], points[(i + 1) % points.length]))
    if (points.length === 1) best = Math.min(best, Math.hypot(px - points[0][0], py - points[0][1]))
  }
  return best
}

function roundedRectDistance(px, py, { x, y, w, h, rx }) {
  const r = Math.min(rx, w / 2, h / 2)
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r)
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

// what a shape does to one sample point: 'draw', 'cut' or null
function sampleShape(shape, sx, sy) {
  const [bx0, by0, bx1, by1] = shape.bounds
  if (sx < bx0 || sx > bx1 || sy < by0 || sy > by1) return null
  const m = shape.inverse
  const px = m[0] * sx + m[2] * sy + m[4]
  const py = m[1] * sx + m[3] * sy + m[5]
  let inFill = false
  let onStroke = false
  const half = shape.width / 2
  if (shape.kind === 'circle') {
    const d = Math.hypot(px - shape.cx, py - shape.cy)
    inFill = d <= shape.r
    onStroke = Math.abs(d - shape.r) <= half
  } else if (shape.kind === 'rect') {
    const d = roundedRectDistance(px, py, shape)
    inFill = d <= 0
    onStroke = Math.abs(d) <= half
  } else {
    if (shape.fill !== null) inFill = winding(px, py, shape.subpaths) !== 0
    if (shape.stroke !== null) onStroke = strokeDistance(px, py, shape.subpaths) <= half
  }
  if (shape.stroke !== null && onStroke) return shape.stroke
  if (shape.fill !== null && inFill) return shape.fill
  return null
}

/** Alpha per pixel, row-major, size x size, from SAMPLES x SAMPLES coverage. */
export function rasterize(svg, size = ICON_SIZE) {
  const [vx, vy, vw, vh] = svg.viewBox
  const alpha = new Uint8Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0
      for (let j = 0; j < SAMPLES; j++) {
        for (let i = 0; i < SAMPLES; i++) {
          const sx = vx + ((x + (i + 0.5) / SAMPLES) * vw) / size
          const sy = vy + ((y + (j + 0.5) / SAMPLES) * vh) / size
          let on = false
          for (const shape of svg.shapes) {
            const effect = sampleShape(shape, sx, sy)
            if (effect !== null) on = effect === 'draw'
          }
          if (on) covered++
        }
      }
      alpha[y * size + x] = Math.round((covered * 255) / (SAMPLES * SAMPLES))
    }
  }
  return alpha
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}

// RGB stays white under transparent pixels too, so a filtered texture never fringes dark
export function encodePng(alpha, size = ICON_SIZE) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const raw = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4)
    for (let x = 0; x < size; x++) raw.set([255, 255, 255, alpha[y * size + x]], row + 1 + x * 4)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Size and alpha of a PNG this script wrote (RGBA, filter 0), to compare pixels rather than zlib bytes. */
export function decodePng(bytes) {
  const buf = Buffer.from(bytes)
  let at = 8
  let size = 0
  const idat = []
  while (at < buf.length) {
    const length = buf.readUInt32BE(at)
    const type = buf.toString('ascii', at + 4, at + 8)
    const data = buf.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') size = data.readUInt32BE(0)
    if (type === 'IDAT') idat.push(data)
    at += 12 + length
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const alpha = new Uint8Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) alpha[y * size + x] = raw[y * (1 + size * 4) + 1 + x * 4 + 3]
  }
  return { size, alpha }
}

// --- fs driver ---

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ICONS_DIR = path.join(root, 'packages/desktop/runtime-assets/action-icons')
// the bytes the editor writes into a scene, as a plain module: a Vite asset import resolves to a data
// URL in the app build and to a path under vitest, so neither can be the one source of the bytes
export const DATA_MODULE = path.join(root, 'packages/ui/src/prefabs/action-icon-data.ts')

export function iconSources() {
  return fs.readdirSync(ICONS_DIR).filter((name) => name.endsWith('.svg')).sort().map((name) => name.slice(0, -4))
}

export function renderIcon(name) {
  return rasterize(parseSvg(fs.readFileSync(path.join(ICONS_DIR, `${name}.svg`), 'utf8')))
}

export function dataModule(pngs) {
  const rows = pngs.map(([name, bytes]) => `  '${name}.png': '${Buffer.from(bytes).toString('base64')}'`)
  return [
    '// Generated by scripts/build-action-icons.mjs from packages/desktop/runtime-assets/action-icons/. Do not edit.',
    'export const ACTION_ICON_PNGS: Record<string, string> = {',
    rows.join(',\n'),
    '}',
    ''
  ].join('\n')
}

function shippedPngs() {
  return iconSources().map((name) => [name, fs.readFileSync(path.join(ICONS_DIR, `${name}.png`))])
}

/** The icons whose PNG is missing or does not match its source, and 'data module' when it lags the PNGs. */
export function staleIcons() {
  const stale = iconSources().filter((name) => {
    const file = path.join(ICONS_DIR, `${name}.png`)
    if (!fs.existsSync(file)) return true
    const { size, alpha } = decodePng(fs.readFileSync(file))
    return size !== ICON_SIZE || !Buffer.from(alpha).equals(Buffer.from(renderIcon(name)))
  })
  if (stale.length > 0) return stale
  const current = fs.existsSync(DATA_MODULE) ? fs.readFileSync(DATA_MODULE, 'utf8') : ''
  return current === dataModule(shippedPngs()) ? [] : ['data module']
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const stale = staleIcons()
    if (stale.length > 0) {
      console.error(`build-action-icons: out of date: ${stale.join(', ')} — run node scripts/build-action-icons.mjs`)
      process.exit(1)
    }
    console.log('build-action-icons: every PNG matches its source')
  } else {
    for (const name of iconSources()) fs.writeFileSync(path.join(ICONS_DIR, `${name}.png`), encodePng(renderIcon(name)))
    fs.writeFileSync(DATA_MODULE, dataModule(shippedPngs()))
    console.log(`build-action-icons: wrote ${iconSources().length} icons`)
  }
}
