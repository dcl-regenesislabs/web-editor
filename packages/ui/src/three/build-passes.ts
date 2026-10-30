// What the build worker does to a script's model before export; pure, so it is tested without a worker.
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { pascal } from './materials'

const MAX_CANVAS = 512
const powerOfTwo = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_CANVAS && (n & (n - 1)) === 0

// never rounded up: the drawing would fill one corner and stop matching the UVs
export function checkCanvasSize(width: number, height: number): void {
  if (powerOfTwo(width) && powerOfTwo(height)) return
  throw new Error(`addons.canvas(${String(width)}, ${String(height)}): each side must be a power of two up to ${MAX_CANVAS} ` +
    '(1, 2, 4, 8, 16, 32, 64, 128, 256 or 512); pick those sizes and draw to fit them.')
}

const attributeList = (geometry: THREE.BufferGeometry): string => Object.keys(geometry.attributes).sort().join(', ')
const layout = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): string =>
  `${a.itemSize}:${String(a.normalized)}:${a.array.constructor.name}`

function mergeFailure(parts: THREE.BufferGeometry[]): string {
  const first = parts[0]
  for (let i = 1; i < parts.length; i++) {
    if (attributeList(parts[i]) !== attributeList(first)) {
      return `parts have different attributes (part 0: ${attributeList(first)}; part ${i}: ${attributeList(parts[i])}); ` +
        'give every part the same attributes, or add the odd ones as separate meshes.'
    }
    const odd = Object.keys(first.attributes).find((name) => layout(parts[i].getAttribute(name)) !== layout(first.getAttribute(name)))
    if (odd !== undefined) return `attribute "${odd}" has a different layout in part ${i}; add that part as a separate mesh.`
  }
  return 'parts have different morph targets; add them as separate meshes.'
}

// three's merge returns null when only some parts are indexed (RoundedBoxGeometry never is),
// and a null geometry fails later with an error that names nothing the script wrote
export function mergeParts(geometries: THREE.BufferGeometry[], useGroups = false): THREE.BufferGeometry {
  if (!Array.isArray(geometries) || geometries.length === 0) throw new Error('addons.mergeGeometries: pass an array of at least one geometry.')
  const mixed = geometries.some((g) => g.index !== null) && geometries.some((g) => g.index === null)
  const parts = mixed ? geometries.map((g) => (g.index === null ? g : g.toNonIndexed())) : geometries
  const merged = mergeGeometries(parts, useGroups)
  if (merged === null) throw new Error(`addons.mergeGeometries: ${mergeFailure(parts)}`)
  return merged
}

// Decentraland's client ignores vertex colours, so a model coloured that way would look different there
export function stripVertexColors(root: THREE.Object3D): string[] {
  let parts = 0
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    const geometry: THREE.BufferGeometry = node.geometry
    const colored = geometry.getAttribute('color') !== undefined || (node instanceof THREE.InstancedMesh && node.instanceColor !== null)
    if (!colored) return
    geometry.deleteAttribute('color')
    if (node instanceof THREE.InstancedMesh) node.instanceColor = null
    parts++
  })
  return parts === 0 ? [] : [`Removed vertex colours from ${parts} part${parts === 1 ? '' : 's'}: Decentraland ignores them. Colour parts with materials instead.`]
}

// the same surface facing the other way: reversed winding, and normals turned unless a transform already did
export function flipped(geometry: THREE.BufferGeometry, turnNormals = true): THREE.BufferGeometry {
  const out = geometry.clone()
  if (out.index === null) out.setIndex([...Array(out.getAttribute('position').count).keys()])
  const index = out.index
  if (index === null) return out
  for (let i = 0; i + 2 < index.count; i += 3) {
    const b = index.getX(i + 1)
    index.setX(i + 1, index.getX(i + 2))
    index.setX(i + 2, b)
  }
  const normal = out.getAttribute('normal')
  if (turnNormals && normal !== undefined) {
    for (let i = 0; i < normal.count; i++) normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i))
  }
  return out
}

// Decentraland reads glTF with x negated (left-handed), so x is mirrored here to make the script's +x the
// scene's east; u turns too, so text and images still read forward from the front
export function toSceneAxes(root: THREE.Object3D, clips: readonly THREE.AnimationClip[]): void {
  const mirror = new THREE.Matrix4().makeScale(-1, 1, 1)
  const conjugate = (m: THREE.Matrix4): THREE.Matrix4 => m.premultiply(mirror).multiply(mirror)
  const negate = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, component: 'X' | 'Y' | 'Z'): void => {
    if (attribute === undefined) return
    for (let i = 0; i < attribute.count; i++) attribute[`set${component}`](i, -attribute[`get${component}`](i))
  }
  const done = new Map<string, THREE.BufferGeometry>()
  const mirrored = (geometry: THREE.BufferGeometry, faces: boolean): THREE.BufferGeometry => {
    const key = `${geometry.uuid}:${faces}`
    let out = done.get(key)
    if (out !== undefined) return out
    const copy = geometry.clone()
    for (const name of ['position', 'normal'] as const) {
      negate(copy.getAttribute(name), 'X')
      for (const target of copy.morphAttributes[name] ?? []) negate(target, 'X')
    }
    // tangent' = -mirror(tangent) once u is turned, which leaves its handedness w as it was
    negate(copy.getAttribute('tangent'), 'Y')
    negate(copy.getAttribute('tangent'), 'Z')
    for (const [name, uv] of Object.entries(copy.attributes)) {
      if (!/^uv\d*$/.test(name)) continue
      for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i))
    }
    // lines and points have no faces to turn, and their vertex order is their shape
    out = faces ? flipped(copy, false) : copy
    done.set(key, out)
    return out
  }
  const skeletons = new Set<THREE.Skeleton>()
  root.traverse((node) => {
    node.position.x = -node.position.x
    node.quaternion.set(node.quaternion.x, -node.quaternion.y, -node.quaternion.z, node.quaternion.w)
    if (!node.matrixAutoUpdate) conjugate(node.matrix)
    if (node instanceof THREE.InstancedMesh) {
      const matrix = new THREE.Matrix4()
      for (let i = 0; i < node.count; i++) {
        node.getMatrixAt(i, matrix)
        node.setMatrixAt(i, conjugate(matrix))
      }
    }
    if (node instanceof THREE.SkinnedMesh) {
      conjugate(node.bindMatrix)
      conjugate(node.bindMatrixInverse)
      if (!skeletons.has(node.skeleton)) {
        skeletons.add(node.skeleton)
        for (const inverse of node.skeleton.boneInverses) conjugate(inverse)
      }
    }
    if ('geometry' in node && node.geometry instanceof THREE.BufferGeometry) node.geometry = mirrored(node.geometry, node instanceof THREE.Mesh)
  })
  // a track keeps the values array it was given, so tracks can share one
  const turnedValues = new Set<ArrayLike<number>>()
  for (const track of new Set(clips.flatMap((clip) => clip.tracks))) {
    if (turnedValues.has(track.values)) continue
    turnedValues.add(track.values)
    const { propertyName, propertyIndex } = THREE.PropertyBinding.parseTrackName(track.name)
    const turned = propertyName === 'position' ? ['x'] : propertyName === 'quaternion' ? ['y', 'z'] : []
    const stride = propertyName === 'position' ? 3 : 4
    track.values.forEach((value, i) => {
      if (propertyIndex === undefined ? turned.includes('xyzw'[i % stride]) : turned.includes(propertyIndex)) track.values[i] = -value
    })
  }
  root.updateMatrixWorld(true)
}

const sides = (mesh: THREE.Mesh): THREE.Side[] => [mesh.material].flat().map((material) => material.side)

// Seen from behind, a surface shows its texture mirrored, so the back copy turns u about the middle of the
// geometry's own u range: 0–1 becomes 1−u, a tiled 0–4 stays tiled, an atlas cell stays in its cell
function mirroredU(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const [name, uv] of Object.entries(geometry.attributes)) {
    if (!/^uv\d*$/.test(name) || uv.count === 0) continue
    let low = Infinity
    let high = -Infinity
    for (let i = 0; i < uv.count; i++) {
      low = Math.min(low, uv.getX(i))
      high = Math.max(high, uv.getX(i))
    }
    for (let i = 0; i < uv.count; i++) uv.setX(i, low + high - uv.getX(i))
  }
  // with u reversed and the normal turned, the tangent turns too and its handedness w stays
  const tangent = geometry.getAttribute('tangent')
  if (tangent !== undefined) {
    for (let i = 0; i < tangent.count; i++) tangent.setXYZ(i, -tangent.getX(i), -tangent.getY(i), -tangent.getZ(i))
  }
  return geometry
}

// Decentraland culls back faces, so a double-sided part gets a back copy and a back-sided one turns around
export function singleSided(root: THREE.Object3D): void {
  const doubled: THREE.Mesh[] = []
  const reversed: THREE.Mesh[] = []
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || node instanceof THREE.SkinnedMesh || /_collider/i.test(node.name)) return
    if (sides(node).every((side) => side === THREE.DoubleSide)) doubled.push(node)
    else if (sides(node).every((side) => side === THREE.BackSide)) reversed.push(node)
  })
  const turned = new Map<string, THREE.BufferGeometry>()
  // a back-sided part keeps its UVs: three shows it mirrored too, and turning it should not change its look
  const turn = (geometry: THREE.BufferGeometry, back: boolean): THREE.BufferGeometry => {
    const key = `${geometry.uuid}:${String(back)}`
    let out = turned.get(key)
    if (out === undefined) turned.set(key, out = back ? mirroredU(flipped(geometry)) : flipped(geometry))
    return out
  }
  for (const mesh of doubled) {
    // a child at its origin, so it follows the part and anything animating it
    const back = mesh.clone(false)
    back.name = ''
    back.position.set(0, 0, 0)
    back.quaternion.identity()
    back.scale.set(1, 1, 1)
    back.geometry = turn(mesh.geometry, true)
    mesh.add(back)
  }
  for (const mesh of reversed) mesh.geometry = turn(mesh.geometry, false)
  // front and back share the material, now one-sided, so it still counts once
  for (const mesh of [...doubled, ...reversed]) for (const material of [mesh.material].flat()) material.side = THREE.FrontSide
  root.updateMatrixWorld(true)
}

// Decentraland names parts <Model>_Part01…; pascal() leaves no '_', so no name can read as a collider
export function partNamer(model: string): { name: (node: THREE.Object3D) => string; nameAll: (root: THREE.Object3D) => void } {
  const prefix = pascal(model).slice(0, 40) || 'Model'
  const taken = new Set<string>()
  let count = 0
  const next = (): string => {
    let name: string
    do name = `${prefix}_Part${String(++count).padStart(2, '0')}`
    while (taken.has(name))
    taken.add(name)
    return name
  }
  return {
    name: (node) => {
      if (node.name === '') node.name = next()
      return node.name
    },
    // never renames a part the script named
    nameAll: (root) => {
      root.traverse((node) => { if (node.name !== '') taken.add(node.name) })
      root.traverse((node) => { if (node !== root && node.name === '') node.name = next() })
    }
  }
}

const shown = (node: THREE.Object3D, root: THREE.Object3D): boolean => {
  for (let at: THREE.Object3D | null = node; at !== null && at !== root; at = at.parent) if (!at.visible) return false
  return root.visible
}

// what a merge must leave alone: everything a clip moves, with whatever is above or below it
function animatedNodes(root: THREE.Object3D, clips: readonly THREE.AnimationClip[]): Set<THREE.Object3D> {
  const targets = new Set(clips.flatMap((clip) => clip.tracks.map((track) => THREE.PropertyBinding.parseTrackName(track.name).nodeName)))
  const held = new Set<THREE.Object3D>()
  root.traverse((node) => {
    if (!targets.has(node.name) && !targets.has(node.uuid)) return
    node.traverse((below) => held.add(below))
    node.traverseAncestors((above) => held.add(above))
  })
  return held
}

// Each part is a draw call per material, so many static unnamed parts sharing one become one mesh.
// Merging copies shared geometry, so small groups stay apart: the file would only grow.
export function mergeStatic(root: THREE.Object3D, clips: readonly THREE.AnimationClip[], least = 5): void {
  root.updateMatrixWorld(true)
  const held = animatedNodes(root, clips)
  const groups = new Map<string, THREE.Mesh[]>()
  root.traverse((node) => {
    // named parts are the script's
    if (!(node instanceof THREE.Mesh) || node instanceof THREE.InstancedMesh || node instanceof THREE.SkinnedMesh) return
    if (node.name !== '' || held.has(node) || !shown(node, root)) return
    const geometry: THREE.BufferGeometry = node.geometry
    if (Array.isArray(node.material) || Object.keys(geometry.morphAttributes).length > 0) return
    const material: THREE.Material = node.material
    const attributes = Object.entries(geometry.attributes)
      .map(([name, a]) => `${name}:${a.itemSize}:${String(a.normalized)}:${a.array.constructor.name}`).sort().join(',')
    const key = `${material.uuid}|${String(geometry.index !== null)}|${attributes}`
    groups.set(key, [...(groups.get(key) ?? []), node])
  })
  const toRoot = root.matrixWorld.clone().invert()
  for (const meshes of groups.values()) {
    if (meshes.length < least) continue
    const baked = meshes.map((mesh) => {
      const matrix = toRoot.clone().multiply(mesh.matrixWorld)
      const geometry = mesh.geometry.clone().applyMatrix4(matrix)
      // a mirroring transform turned the faces inside out once baked in
      return matrix.determinant() < 0 ? flipped(geometry, false) : geometry
    })
    const merged = mergeGeometries(baked)
    if (merged === null) continue
    for (const mesh of meshes) {
      let emptied: THREE.Object3D | null = mesh.parent
      // what hangs below a merged part (a back copy, another material) stays where it is in the world
      for (const child of [...mesh.children]) emptied?.attach(child)
      mesh.removeFromParent()
      // groups the merge emptied would export as stray nodes
      const group = (node: THREE.Object3D): boolean => node instanceof THREE.Group || node.constructor === THREE.Object3D
      while (emptied !== null && emptied !== root && group(emptied) && emptied.children.length === 0 && emptied.name === '' && !held.has(emptied)) {
        const above: THREE.Object3D | null = emptied.parent
        emptied.removeFromParent()
        emptied = above
      }
    }
    root.add(new THREE.Mesh(merged, meshes[0].material))
  }
  root.updateMatrixWorld(true)
}
