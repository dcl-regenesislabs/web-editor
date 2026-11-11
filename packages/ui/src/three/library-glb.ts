import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { isLibraryName, materialFile, type LibraryName, type MaterialMap } from './materials'

export function libraryGeometry(geometry: THREE.BufferGeometry, world: THREE.Matrix4, metresPerTile: number): THREE.BufferGeometry {
  const mapped = geometry.userData.keepUVs === true
    ? geometry.clone() : boxProjectUVs(geometry, world, metresPerTile)
  if (mapped.getAttribute('uv') === undefined) throw new Error('Preserved texture mapping needs UV coordinates.')
  const result = mergeVertices(mapped)
  if (result.getAttribute('normal') !== undefined) result.computeTangents()
  return result
}

// UVs from world position, one tile per metre on whichever axis a face looks along: library
// textures then line up on any shape the script made, with no UV work in the script.
export function boxProjectUVs(geometry: THREE.BufferGeometry, world: THREE.Matrix4, metresPerTile = 1): THREE.BufferGeometry {
  const flat = geometry.index === null ? geometry.clone() : geometry.toNonIndexed()
  const position = flat.getAttribute('position')
  const uv = new Float32Array(position.count * 2)
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3()
  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i).applyMatrix4(world)
    b.fromBufferAttribute(position, i + 1).applyMatrix4(world)
    c.fromBufferAttribute(position, i + 2).applyMatrix4(world)
    normal.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b))
    const [x, y, z] = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)]
    for (const [k, p] of [a, b, c].entries()) {
      const [u, v] = x >= y && x >= z ? [p.z, p.y] : y >= z ? [p.x, p.z] : [p.x, p.y]
      uv[(i + k) * 2] = u / metresPerTile
      uv[(i + k) * 2 + 1] = v / metresPerTile
    }
  }
  flat.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return flat
}

interface Gltf {
  materials?: {
    extras?: { library?: unknown }
    pbrMetallicRoughness?: { baseColorTexture?: { index: number } }
    normalTexture?: { index: number }
  }[]
  textures?: { source?: number }[]
  images?: Record<string, unknown>[]
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number }[]
  buffers?: { byteLength: number }[]
}

const pad = (n: number): number => (n + 3) & ~3

// Library images leave the GLB: each map points at its shared file beside it (materialFile), and the bytes go.
export function externalizeLibraryImages(glb: ArrayBuffer): { glb: ArrayBuffer; used: LibraryName[] } {
  const bytes = new Uint8Array(glb)
  const view = new DataView(glb)
  const jsonLength = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Gltf
  const binAt = 20 + jsonLength
  const bin = binAt < bytes.length ? bytes.subarray(binAt + 8, binAt + 8 + view.getUint32(binAt, true)) : new Uint8Array(0)
  const library = new Map<number, { name: LibraryName; map: MaterialMap }>()
  for (const material of json.materials ?? []) {
    const name = material.extras?.library
    if (!isLibraryName(name)) continue
    const slots: [MaterialMap, number | undefined][] = [
      ['color', material.pbrMetallicRoughness?.baseColorTexture?.index],
      ['normal', material.normalTexture?.index]
    ]
    for (const [map, texture] of slots) {
      const source = texture === undefined ? undefined : json.textures?.[texture]?.source
      if (source !== undefined) library.set(source, { name, map })
    }
  }
  if (library.size === 0) return { glb, used: [] }
  const dropped = new Set<number>()
  for (const [index, { name, map }] of library) {
    const image = json.images?.[index]
    if (typeof image?.bufferView === 'number') dropped.add(image.bufferView)
    const uri = materialFile(name, map)
    if (json.images !== undefined) json.images[index] = { uri, name: uri.replace(/^.*\/|\.jpg$/g, '') }
  }
  // the dropped views stay as tiny unused entries so no other index moves
  const kept: Uint8Array[] = []
  let length = 0
  for (const [index, bufferView] of (json.bufferViews ?? []).entries()) {
    if (dropped.has(index)) {
      bufferView.byteOffset = 0
      bufferView.byteLength = 4
      continue
    }
    const start = bufferView.byteOffset ?? 0
    kept.push(bin.subarray(start, start + bufferView.byteLength))
    bufferView.byteOffset = length
    length = pad(length + bufferView.byteLength)
  }
  const newBin = new Uint8Array(Math.max(4, length))
  let at = 0
  for (const part of kept) {
    newBin.set(part, at)
    at = pad(at + part.length)
  }
  if (json.buffers?.[0] !== undefined) json.buffers[0].byteLength = newBin.length
  const text = new TextEncoder().encode(JSON.stringify(json))
  const jsonChunk = new Uint8Array(pad(text.length)).fill(0x20)
  jsonChunk.set(text)
  const out = new Uint8Array(12 + 8 + jsonChunk.length + 8 + newBin.length)
  const w = new DataView(out.buffer)
  w.setUint32(0, 0x46546c67, true)
  w.setUint32(4, 2, true)
  w.setUint32(8, out.length, true)
  w.setUint32(12, jsonChunk.length, true)
  w.setUint32(16, 0x4e4f534a, true)
  out.set(jsonChunk, 20)
  w.setUint32(20 + jsonChunk.length, newBin.length, true)
  w.setUint32(24 + jsonChunk.length, 0x004e4942, true)
  out.set(newBin, 28 + jsonChunk.length)
  return { glb: out.buffer, used: [...new Set([...library.values()].map((l) => l.name))] }
}
