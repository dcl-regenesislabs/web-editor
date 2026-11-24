import * as THREE from 'three'
import { bounded, count, keepUVs, seededRandom, tube, type Point3 } from './model-geometry'
import { MODEL_BUDGET } from './protocol'

export interface FoliageOptions {
  size?: Point3
  leaves?: number
  leafLength?: number
  seed?: number
  path?: readonly Point3[]
}

export function foliage({ size = [1.2, 0.8, 1.2], leaves = 90, leafLength = 0.22, seed = 1, path }: FoliageOptions = {}): THREE.BufferGeometry {
  count(leaves, 'leaves', 1, 1500)
  bounded(leafLength, 'leafLength', 0.005, 10)
  size.forEach((n) => bounded(n, 'size', 0.001, 1000))
  const random = seededRandom(seed)
  if (path !== undefined) {
    count(path.length, 'path.length', 2, 128)
    for (const point of path) {
      if (point.length !== 3) throw new Error('Each foliage path point needs [x,y,z].')
      point.forEach((n) => bounded(n, 'point', -10000, 10000))
    }
  }
  const curve = path === undefined ? null : new THREE.CatmullRomCurve3(path.map((p) => new THREE.Vector3(...p)))
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = []
  const up = new THREE.Vector3(0, 1, 0)
  for (let i = 0; i < leaves; i++) {
    const azimuth = random() * Math.PI * 2, y = random() * 2 - 1
    const radial = Math.sqrt(1 - y * y)
    const outward = new THREE.Vector3(Math.cos(azimuth) * radial, y, Math.sin(azimuth) * radial)
    const t = 0.15 + 0.85 * (i + 0.5) / leaves
    const center = curve?.getPointAt(t) ?? outward.clone().multiplyScalar(Math.cbrt(random()) * 0.5).multiply(new THREE.Vector3(...size))
    const length = leafLength * (0.7 + random() * 0.6)
    const tangent = curve?.getTangentAt(t)
    let direction: THREE.Vector3
    if (tangent === undefined) {
      direction = new THREE.Vector3(outward.x, 0.3 + random() * 0.6, outward.z).normalize()
    } else {
      const reference = Math.abs(tangent.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : up
      const lateral = new THREE.Vector3().crossVectors(tangent, reference).normalize()
      direction = lateral.applyAxisAngle(tangent, i * 2.399963 + random() * 0.5)
        .addScaledVector(tangent, 0.3).addScaledVector(up, 0.2).normalize()
    }
    const turn = new THREE.Quaternion().setFromUnitVectors(up, direction)
      .multiply(new THREE.Quaternion().setFromAxisAngle(up, random() * Math.PI * 2))
    const points = [[0, 0, 0], [-0.3, 0.45, -0.08], [0, 1, 0], [0.3, 0.45, -0.08]]
    const texels = [[0.5, 0], [0, 0.45], [0.5, 1], [1, 0.45]]
    for (let j = 0; j < points.length; j++) {
      const p = new THREE.Vector3(...points[j] as [number, number, number]).multiplyScalar(length).applyQuaternion(turn).add(center)
      positions.push(...p.toArray())
      // A soft outward normal keeps a foliage cluster readable without a separate material per leaf.
      const n = new THREE.Vector3(0, 0.35, 1).applyQuaternion(turn).addScaledVector(outward, 0.5).normalize()
      normals.push(...n.toArray())
      uvs.push(...texels[j])
    }
    const b = i * 4
    indices.push(b, b + 2, b + 1, b, b + 3, b + 2)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  return keepUVs(geometry)
}

export interface TreeOptions {
  height?: number
  width?: number
  branches?: number
  leaves?: number
  seed?: number
  trunkMaterial: THREE.Material
  leafMaterial: THREE.Material
}

export function tree({ height = 5, width = 3.4, branches = 9, leaves, seed = 1, trunkMaterial, leafMaterial }: TreeOptions): THREE.Group {
  bounded(height, 'height', 0.2, 100)
  bounded(width, 'width', 0.1, 100)
  count(branches, 'branches', 3, 16)
  // Reserve trunk, roots, leader leaves and each branch before allocating two-sided foliage.
  const maximum = Math.min(1500, Math.floor((MODEL_BUDGET.triangles - 608 - branches * 252) / 4))
  leaves ??= Math.min(1200, maximum)
  count(leaves, 'leaves', branches * 6, maximum)
  const random = seededRandom(seed)
  const root = new THREE.Group()
  const bendX = (random() - 0.5) * height * 0.09, bendZ = (random() - 0.5) * height * 0.09
  const trunkAt = (t: number): Point3 => [bendX * t * t, height * t, bendZ * t * t]
  root.add(new THREE.Mesh(tube({
    points: [trunkAt(0), trunkAt(0.22), trunkAt(0.48), trunkAt(0.72), trunkAt(0.94)],
    radii: [height * 0.044, height * 0.029, height * 0.021, height * 0.012, height * 0.002], segments: 16, sides: 8
  }), trunkMaterial))
  for (let i = 0; i < 5; i++) {
    const angle = i / 5 * Math.PI * 2 + random() * 0.4
    const radius = height * (0.055 + random() * 0.025)
    root.add(new THREE.Mesh(tube({
      points: [[Math.cos(angle) * radius, height * 0.008, Math.sin(angle) * radius], [Math.cos(angle) * radius * 0.45, height * 0.04, Math.sin(angle) * radius * 0.45], trunkAt(0.11)],
      radii: [height * 0.004, height * 0.018, height * 0.022], segments: 3, sides: 6
    }), trunkMaterial))
  }
  for (let i = 0; i < branches; i++) {
    const fraction = i / (branches - 1)
    const t = 0.38 + fraction * 0.34
    const start = new THREE.Vector3(...trunkAt(t))
    const angle = i * 2.399963 + random() * 0.45
    const reach = width * (0.30 + Math.sin(fraction * Math.PI) * 0.16) * (0.8 + random() * 0.4)
    const end = start.clone().add(new THREE.Vector3(Math.cos(angle) * reach, height * (0.10 + random() * 0.08), Math.sin(angle) * reach))
    const middle = start.clone().lerp(end, 0.55).add(new THREE.Vector3(0, -height * 0.035, 0))
    const points = [start.toArray(), middle.toArray(), end.toArray()]
    root.add(new THREE.Mesh(tube({ points, radii: [height * 0.014 * (1 - fraction * 0.4), height * 0.007, height * 0.0015], segments: 6, sides: 6 }), trunkMaterial))
    const leafCount = Math.floor(leaves / branches) + (i < leaves % branches ? 1 : 0)
    for (const [j, sign] of [-1, 0, 1].entries()) {
      const twigStart = start.clone().lerp(middle, 0.7 + j * 0.1)
      const tip = end.clone().add(new THREE.Vector3(-Math.sin(angle) * width * 0.22 * sign, height * (0.04 + random() * 0.04), Math.cos(angle) * width * 0.22 * sign))
      const path = [twigStart.toArray(), middle.clone().lerp(tip, 0.5).toArray(), tip.toArray()]
      root.add(new THREE.Mesh(tube({ points: path, radii: [height * 0.004, height * 0.002, height * 0.0007], segments: 3, sides: 4 }), trunkMaterial))
      const twigLeaves = Math.floor(leafCount / 3) + (j < leafCount % 3 ? 1 : 0)
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -1 : 1
        const twigCurve = new THREE.CatmullRomCurve3(path.map((p) => new THREE.Vector3(...p)))
        const shootStart = twigCurve.getPointAt(0.35 + k * 0.28)
        const shootEnd = tip.clone().add(new THREE.Vector3(
          -Math.sin(angle) * width * (0.12 + random() * 0.06) * side,
          height * (random() - 0.2) * 0.12,
          Math.cos(angle) * width * (0.12 + random() * 0.06) * side))
        const shoot = [shootStart.toArray(), shootStart.clone().lerp(shootEnd, 0.55).add(new THREE.Vector3(0, height * 0.025, 0)).toArray(), shootEnd.toArray()]
        root.add(new THREE.Mesh(tube({ points: shoot, radii: [height * 0.0015, height * 0.0008, height * 0.0003], segments: 2, sides: 3, capped: false }), trunkMaterial))
        root.add(new THREE.Mesh(foliage({ path: shoot, leaves: Math.floor(twigLeaves / 2) + (k < twigLeaves % 2 ? 1 : 0),
          leafLength: height * 0.075, seed: Math.floor(random() * 2147483647) }), leafMaterial))
      }
    }
  }
  root.add(new THREE.Mesh(foliage({ path: [trunkAt(0.78), trunkAt(0.94)], leaves: 24, leafLength: height * 0.05, seed }), leafMaterial))
  const bounds = new THREE.Box3().setFromObject(root), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3())
  const scale = new THREE.Vector3(width / Math.max(size.x, size.z), height / size.y, width / Math.max(size.x, size.z))
  for (const child of root.children) {
    child.position.sub(new THREE.Vector3(center.x, bounds.min.y, center.z)).multiply(scale)
    child.scale.multiply(scale)
  }
  return root
}

const leafMaterials = new Map<string, THREE.MeshStandardMaterial>()

export function leafMaterial(color: THREE.ColorRepresentation = '#607b38'): THREE.MeshStandardMaterial {
  const tint = new THREE.Color(color)
  const key = tint.getHexString()
  const cached = leafMaterials.get(key)
  if (cached !== undefined) return cached
  const canvas = new OffscreenCanvas(128, 256)
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Leaf textures need a 2D canvas.')
  const gradient = ctx.createLinearGradient(0, 0, 128, 0)
  gradient.addColorStop(0, tint.clone().multiplyScalar(0.55).getStyle())
  gradient.addColorStop(0.45, tint.getStyle())
  gradient.addColorStop(1, tint.clone().multiplyScalar(0.72).getStyle())
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 128, 256)
  ctx.strokeStyle = tint.clone().lerp(new THREE.Color('#c4c886'), 0.3).getStyle()
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(64, 0)
  ctx.lineTo(64, 256)
  for (let y = 25; y < 240; y += 27) {
    ctx.moveTo(64, y)
    ctx.lineTo(0, y - 36)
    ctx.moveTo(64, y)
    ctx.lineTo(128, y - 36)
  }
  ctx.stroke()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0, side: THREE.DoubleSide })
  leafMaterials.set(key, material)
  return material
}
