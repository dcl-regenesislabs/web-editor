import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { keepUVs, lathe, rock, tube } from './model-geometry'
import { foliage, tree } from './model-nature'
import { libraryGeometry } from './library-glb'
import { mergeStatic, singleSided, toSceneAxes } from './build-passes'
import { MODEL_BUDGET } from '../ai/code-model'

function valid(geometry: THREE.BufferGeometry): void {
  for (const attribute of Object.values(geometry.attributes)) expect([...attribute.array].every(Number.isFinite)).toBe(true)
  const position = geometry.getAttribute('position')
  if (geometry.index !== null) expect(Math.max(...geometry.index.array)).toBeLessThan(position.count)
  const normal = geometry.getAttribute('normal')
  for (let i = 0; i < normal.count; i++) expect(new THREE.Vector3().fromBufferAttribute(normal, i).length()).toBeCloseTo(1, 3)
}

function faceNormal(geometry: THREE.BufferGeometry, face: number): THREE.Vector3 {
  const p = geometry.getAttribute('position'), indices = geometry.index!
  const [a, b, c] = [0, 1, 2].map((offset) => new THREE.Vector3().fromBufferAttribute(p, indices.getX(face * 3 + offset)))
  return b.sub(a).cross(c.sub(a)).normalize()
}

describe('modeling geometry', () => {
  it('makes outward-facing tapered tubes with closed ends and useful directional UVs', () => {
    const geometry = tube({ points: [[0, 0, 0], [0, 2, 0]], radii: [0.4, 0.1], segments: 8, sides: 8 })
    valid(geometry)
    const p = geometry.getAttribute('position')
    const radial = new THREE.Vector3(p.getX(0), 0, p.getZ(0)).normalize()
    expect(faceNormal(geometry, 0).dot(radial)).toBeGreaterThan(0.8)
    expect(faceNormal(geometry, 8 * 8 * 2).y).toBeCloseTo(-1)
    expect(faceNormal(geometry, 8 * 8 * 2 + 8).y).toBeCloseTo(1)
    expect(geometry.getAttribute('uv').getY(8 * 9)).toBeCloseTo(2)
  })

  it('retains curved tube UVs through axis conversion and the library-material pass', () => {
    const geometry = tube({ points: [[0, 0, 0], [0.4, 1, 0.2], [1, 2, -0.3]], radii: [0.2, 0.12, 0.03] })
    const root = new THREE.Group().add(new THREE.Mesh(geometry))
    toSceneAxes(root, [])
    const mesh = root.children[0] as THREE.Mesh<THREE.BufferGeometry>
    const mapped = libraryGeometry(mesh.geometry, mesh.matrixWorld, 1)
    const source = mesh.geometry.getAttribute('uv'), result = mapped.getAttribute('uv')
    const original = new Set(Array.from({ length: source.count }, (_, i) => `${source.getX(i)},${source.getY(i)}`))
    expect(Array.from({ length: result.count }, (_, i) => original.has(`${result.getX(i)},${result.getY(i)}`)).every(Boolean)).toBe(true)
    valid(mapped)
    expect(mapped.getAttribute('tangent')).toBeDefined()
  })

  it('preserves explicit authored mapping while keeping box projection as the existing default', () => {
    const authored = new THREE.PlaneGeometry(2, 3)
    authored.getAttribute('uv').setXY(0, 0.123, 0.456)
    const preserved = libraryGeometry(keepUVs(authored), new THREE.Matrix4(), 1)
    expect(preserved.getAttribute('uv').getX(0)).toBeCloseTo(0.123)
    const box = new THREE.PlaneGeometry(2, 3)
    const projected = libraryGeometry(box, new THREE.Matrix4(), 1)
    expect(projected.getAttribute('uv').getX(0)).not.toBe(box.getAttribute('uv').getX(0))
    expect(() => keepUVs(new THREE.BufferGeometry())).toThrow('texture coordinates')
  })

  it('gives rocks repeatable shapes, exact dimensions and a grounded base', () => {
    const a = rock({ size: [2, 1, 3], seed: 42 }), b = rock({ size: [2, 1, 3], seed: 42 })
    expect(a.getAttribute('position').array).toEqual(b.getAttribute('position').array)
    expect(a.getAttribute('position').array).not.toEqual(rock({ seed: 43 }).getAttribute('position').array)
    expect(a.boundingBox!.getSize(new THREE.Vector3()).toArray()).toEqual([2, 1, 3])
    expect(a.boundingBox!.min.y).toBe(0)
    valid(a)
  })

  it('makes a lathed profile with the requested dimensions and preserves its mapping', () => {
    const geometry = lathe([[0.2, 0], [0.4, 0.2], [0.3, 1]])
    geometry.computeBoundingBox()
    expect(geometry.boundingBox!.getSize(new THREE.Vector3()).y).toBe(1)
    expect(geometry.boundingBox!.max.x).toBeCloseTo(0.4)
    expect(geometry.userData.keepUVs).toBe(true)
    valid(geometry)
  })

  it('rejects excessive work and degenerate inputs before allocating geometry', () => {
    expect(() => tube({ points: [[0, 0, 0], [0, 0, 0]], radii: [1, 1] })).toThrow('distinct')
    expect(() => tube({ points: [[0, 0, 0], [0, 1, 0]], radii: [1] })).toThrow('one radius')
    expect(() => rock({ detail: 100 })).toThrow('detail')
    expect(() => foliage({ leaves: 100000 })).toThrow('leaves')
    expect(() => foliage({ leafLength: NaN })).toThrow('leafLength')
  })

  it('attaches the base of each leaf to the supplied twig path', () => {
    const geometry = foliage({ path: [[0, 0, 0], [0, 1, 0]], leaves: 12, seed: 3 })
    const position = geometry.getAttribute('position')
    for (let i = 0; i < 12; i++) {
      expect(position.getX(i * 4)).toBe(0)
      expect(position.getZ(i * 4)).toBe(0)
      expect(position.getY(i * 4)).toBeGreaterThan(0)
      expect(position.getY(i * 4)).toBeLessThan(1)
    }
  })
})

describe('the default tree after the production geometry passes', () => {
  it.each([1, 7, 42])('stays within budget with two merged materials, a grounded base and predictable size (seed %s)', (seed) => {
    const trunkMaterial = new THREE.MeshStandardMaterial()
    const leafMaterial = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })
    const root = tree({ height: 5, width: 3.4, seed, trunkMaterial, leafMaterial })
    const before = new THREE.Box3().setFromObject(root)
    expect(before.min.y).toBeCloseTo(0)
    expect(before.getSize(new THREE.Vector3()).y).toBeCloseTo(5)
    expect(Math.max(before.max.x - before.min.x, before.max.z - before.min.z)).toBeCloseTo(3.4)
    toSceneAxes(root, [])
    singleSided(root)
    mergeStatic(root, [])
    let triangles = 0, meshes = 0
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return
      meshes++
      valid(node.geometry)
      triangles += (node.geometry.index?.count ?? node.geometry.getAttribute('position').count) / 3
    })
    expect(triangles).toBeLessThanOrEqual(MODEL_BUDGET.triangles)
    expect(meshes).toBe(2)
  })

  it.each([3, 12, 16])('budgets default foliage when branch count changes to %s', (branches) => {
    const root = tree({ branches, trunkMaterial: new THREE.MeshStandardMaterial(), leafMaterial: new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }) })
    singleSided(root)
    let triangles = 0
    root.traverse((node) => {
      if (node instanceof THREE.Mesh) triangles += (node.geometry.index?.count ?? node.geometry.getAttribute('position').count) / 3
    })
    expect(triangles).toBeLessThanOrEqual(MODEL_BUDGET.triangles)
  })
})
