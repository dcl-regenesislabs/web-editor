import * as THREE from 'three'

export type Point3 = readonly [number, number, number]

export function bounded(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}.`)
  return value
}

export function count(value: number, name: string, min: number, max: number): number {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`)
  return bounded(value, name, min, max)
}

export function seededRandom(seed = 1): () => number {
  bounded(seed, 'seed', -2147483648, 2147483647)
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let n = Math.imul(state ^ (state >>> 15), 1 | state)
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n)
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
}

export function keepUVs(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (geometry.getAttribute('uv') === undefined) throw new Error('keepUVs needs geometry with texture coordinates.')
  geometry.userData.keepUVs = true
  return geometry
}

export interface TubeOptions {
  points: readonly Point3[]
  radii: readonly number[]
  segments?: number
  sides?: number
  capped?: boolean
  metresPerTile?: number
}

// Texture distance follows the curve, so grain runs along a branch, handle or pipe.
export function tube({ points, radii, segments = 16, sides = 10, capped = true, metresPerTile = 1 }: TubeOptions): THREE.BufferGeometry {
  count(points.length, 'points.length', 2, 128)
  count(segments, 'segments', 2, 128)
  count(sides, 'sides', 3, 32)
  bounded(metresPerTile, 'metresPerTile', 0.001, 1000)
  if (radii.length !== points.length) throw new Error('Give one radius per point.')
  radii.forEach((radius) => bounded(radius, 'radius', 0.00001, 1000))
  const controls = points.map((p) => {
    if (p.length !== 3) throw new Error('Each point needs [x,y,z].')
    return new THREE.Vector3(...p.map((n) => bounded(n, 'point', -10000, 10000)) as [number, number, number])
  })
  if (controls.some((p, i) => i > 0 && p.distanceToSquared(controls[i - 1]) < 1e-12)) throw new Error('Consecutive tube points must be distinct.')
  const curve = new THREE.CatmullRomCurve3(controls)
  const frames = curve.computeFrenetFrames(segments, false)
  const positions: number[] = [], uvs: number[] = [], indices: number[] = []
  const length = curve.getLength()
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const center = curve.getPointAt(t)
    const control = curve.getUtoTmapping(t, 0) * (radii.length - 1)
    const left = Math.min(Math.floor(control), radii.length - 2)
    const radius = THREE.MathUtils.lerp(radii[left], radii[left + 1], control - left)
    for (let j = 0; j <= sides; j++) {
      const angle = j / sides * Math.PI * 2
      const offset = frames.normals[i].clone().multiplyScalar(-Math.cos(angle))
        .addScaledVector(frames.binormals[i], Math.sin(angle)).multiplyScalar(radius)
      positions.push(...center.clone().add(offset).toArray())
      uvs.push(j / sides * 2 * Math.PI * radii[0] / metresPerTile, t * length / metresPerTile)
      if (i > 0 && j > 0) {
        const a = (sides + 1) * (i - 1) + j - 1, b = (sides + 1) * i + j - 1
        indices.push(a, b, a + 1, b, b + 1, a + 1)
      }
    }
  }
  if (capped) {
    for (const end of [0, segments]) {
      const centerIndex = positions.length / 3
      const center = curve.getPointAt(end / segments)
      positions.push(...center.toArray())
      uvs.push(0.5, 0.5)
      for (let j = 0; j <= sides; j++) {
        const at = (end * (sides + 1) + j) * 3
        positions.push(positions[at], positions[at + 1], positions[at + 2])
        uvs.push(0.5 + 0.5 * Math.cos(j / sides * Math.PI * 2), 0.5 + 0.5 * Math.sin(j / sides * Math.PI * 2))
        if (j > 0) {
          const a = centerIndex + j, b = a + 1
          indices.push(centerIndex, ...(end === 0 ? [a, b] : [b, a]))
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const normals = geometry.getAttribute('normal')
  for (let i = 0; i <= segments; i++) {
    const a = i * (sides + 1), b = a + sides
    const n = new THREE.Vector3().fromBufferAttribute(normals, a).add(new THREE.Vector3().fromBufferAttribute(normals, b)).normalize()
    normals.setXYZ(a, n.x, n.y, n.z)
    normals.setXYZ(b, n.x, n.y, n.z)
  }
  return keepUVs(geometry)
}

export function lathe(profile: readonly (readonly [number, number])[], sides = 32): THREE.BufferGeometry {
  count(profile.length, 'profile.length', 2, 128)
  count(sides, 'sides', 6, 96)
  const points = profile.map(([radius, height]) => new THREE.Vector2(bounded(radius, 'radius', 0, 1000), bounded(height, 'height', -1000, 1000)))
  const geometry = new THREE.LatheGeometry(points, sides)
  geometry.normalizeNormals()
  const uv = geometry.getAttribute('uv')
  const perimeter = 2 * Math.PI * Math.max(...points.map((p) => p.x))
  const distances = [0]
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + points[i].distanceTo(points[i - 1]))
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * perimeter, distances[i % points.length])
  return keepUVs(geometry)
}

export interface RockOptions {
  size?: Point3
  seed?: number
  detail?: number
  roughness?: number
}

export function rock({ size = [1.4, 0.9, 1.1], seed = 1, detail = 3, roughness = 0.18 }: RockOptions = {}): THREE.BufferGeometry {
  count(detail, 'detail', 1, 5)
  bounded(roughness, 'roughness', 0, 0.45)
  size.forEach((n) => bounded(n, 'size', 0.001, 1000))
  const random = seededRandom(seed)
  const phases = Array.from({ length: 6 }, () => random() * Math.PI * 2)
  const geometry = new THREE.IcosahedronGeometry(1, detail)
  const position = geometry.getAttribute('position')
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i)
    const shape = 1 + roughness * (Math.sin(3 * x + phases[0]) * Math.cos(4 * y + phases[1])
      + 0.5 * Math.sin(5 * z + phases[2]) * Math.cos(4 * x + phases[3])
      + 0.25 * Math.sin(11 * x + 7 * y + phases[4]) * Math.cos(8 * z + phases[5]))
    position.setXYZ(i, x * shape, Math.max(-0.65, y * shape), z * shape)
  }
  geometry.computeBoundingBox()
  const bounds = geometry.boundingBox!
  const extent = bounds.getSize(new THREE.Vector3())
  const center = bounds.getCenter(new THREE.Vector3())
  for (let i = 0; i < position.count; i++) position.setXYZ(i,
    (position.getX(i) - center.x) / extent.x * size[0],
    (position.getY(i) - bounds.min.y) / extent.y * size[1],
    (position.getZ(i) - center.z) / extent.z * size[2])
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
