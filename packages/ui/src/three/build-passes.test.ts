// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { checkCanvasSize, mergeParts, mergeStatic, partNamer, singleSided, stripVertexColors, toSceneAxes } from './build-passes'

describe('a model build', () => {
  it('takes only power-of-two canvas sides up to 512', () => {
    expect(() => checkCanvasSize(512, 64)).not.toThrow()
    for (const [w, h] of [[300, 128], [1024, 512], [256, 0], [128.5, 128]]) expect(() => checkCanvasSize(w, h)).toThrow(/power of two up to 512/)
  })

  it('merges indexed and non-indexed parts, and names the attributes when parts cannot merge', () => {
    const rounded = new RoundedBoxGeometry()
    const box = new THREE.BoxGeometry()
    const merged = mergeParts([rounded, box])
    expect(merged.getAttribute('position').count).toBe(rounded.getAttribute('position').count + box.getIndex()!.count)
    const bare = new THREE.BoxGeometry().deleteAttribute('uv')
    expect(() => mergeParts([box, bare])).toThrow(/mergeGeometries: parts have different attributes \(part 0: normal, position, uv; part 1: normal, position\)/)
  })

  it('drops vertex and instance colours and says so', () => {
    const geometry = new THREE.BoxGeometry()
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 3), 3))
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(), undefined, 2)
    instanced.setColorAt(0, new THREE.Color('red'))
    const root = new THREE.Group().add(new THREE.Mesh(geometry), instanced, new THREE.Mesh(new THREE.BoxGeometry()))
    expect(stripVertexColors(root)).toEqual([expect.stringMatching(/^Removed vertex colours from 2 parts/)])
    expect(geometry.getAttribute('color')).toBeUndefined()
    expect(instanced.instanceColor).toBeNull()
  })

  it('gives a double-sided part a one-sided back copy and turns a back-sided part around', () => {
    const plane = new THREE.PlaneGeometry()
    const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })
    const card = new THREE.Mesh(plane, material)
    card.position.set(1, 2, 3)
    const inside = new THREE.Mesh(plane, new THREE.MeshStandardMaterial({ side: THREE.BackSide }))
    singleSided(new THREE.Group().add(card, inside))
    const [back] = card.children
    expect(back).toBeInstanceOf(THREE.Mesh)
    expect(back.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([1, 2, 3])
    for (const mesh of [back, inside] as THREE.Mesh[]) {
      expect([...(mesh.geometry.index?.array ?? [])].slice(0, 3)).toEqual([0, 1, 2])
      expect(mesh.geometry.getAttribute('normal').getZ(0)).toBe(-1)
      expect(sidesOf(mesh)).toEqual([THREE.FrontSide])
    }
    expect([...(plane.index?.array ?? [])].slice(0, 3)).toEqual([0, 2, 1])
    expect(material.side).toBe(THREE.FrontSide)
  })

  it('mirrors u on the back copy of a double-sided part, so text reads forward from behind', () => {
    const sign = new THREE.PlaneGeometry()
    sign.computeTangents()
    // an atlas cell, to show the flip stays inside the part's own u range
    const cell = new THREE.PlaneGeometry().toNonIndexed()
    const cellUv = cell.getAttribute('uv')
    for (let i = 0; i < cellUv.count; i++) cellUv.setX(i, 0.25 + cellUv.getX(i) * 0.25)
    const material = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), side: THREE.DoubleSide })
    const front = new THREE.Mesh(sign, material)
    const atlas = new THREE.Mesh(cell, material)
    const inside = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ side: THREE.BackSide }))
    singleSided(new THREE.Group().add(front, atlas, inside))
    const back = (front.children[0] as THREE.Mesh).geometry
    const [u, backU] = [sign, back].map((g) => g.getAttribute('uv'))
    expect(u.getX(0)).toBe(0)
    expect(backU.getX(0)).toBe(1)
    for (let i = 0; i < u.count; i++) {
      expect(backU.getX(i)).toBeCloseTo(1 - u.getX(i))
      expect(backU.getY(i)).toBe(u.getY(i))
      expect(back.getAttribute('normal').getZ(i)).toBe(-1)
      expect(back.getAttribute('tangent').getX(i)).toBe(-sign.getAttribute('tangent').getX(i))
      expect(back.getAttribute('tangent').getW(i)).toBe(sign.getAttribute('tangent').getW(i))
    }
    // the face still points the way its normal does: (b - a) × (c - a) along -z
    const [a, b, c] = [...(back.index?.array ?? [])].slice(0, 3).map((i) => new THREE.Vector3().fromBufferAttribute(back.getAttribute('position'), i))
    expect(b.sub(a).cross(c.sub(a)).z).toBeLessThan(0)
    const atlasBack = (atlas.children[0] as THREE.Mesh).geometry.getAttribute('uv')
    for (let i = 0; i < cellUv.count; i++) expect(atlasBack.getX(i)).toBeCloseTo(0.75 - cellUv.getX(i))
    expect(inside.geometry.getAttribute('uv').getX(0)).toBe(0)
  })

  it('names unnamed parts <Model>_PartNN, keeps the script\'s names and never makes a collider name', () => {
    const namer = partNamer('gate_collider')
    const pivot = namer.name(new THREE.Group())
    const door = Object.assign(new THREE.Mesh(), { name: 'Door' })
    const root = new THREE.Group().add(Object.assign(new THREE.Group(), { name: pivot }).add(new THREE.Mesh()), door,
      Object.assign(new THREE.Mesh(), { name: 'GateCollider_Part02' }))
    namer.nameAll(root)
    expect(pivot).toBe('GateCollider_Part01')
    expect(root.name).toBe('')
    expect(root.children.map((node) => node.name)).toEqual(['GateCollider_Part01', 'Door', 'GateCollider_Part02'])
    expect(root.children[0].children[0].name).toBe('GateCollider_Part03')
  })

  it('merges five or more static unnamed parts sharing a material, in place, and leaves the rest', () => {
    const material = new THREE.MeshStandardMaterial()
    const box = new THREE.BoxGeometry()
    const root = new THREE.Group()
    root.position.set(0, 1, 0)
    const parts = [0, 1, 2, 3, 4].map((x) => {
      const part = new THREE.Mesh(box, material)
      part.position.x = x * 2
      return part
    })
    parts[1].scale.set(-1, 1, 1)
    const knob = Object.assign(new THREE.Mesh(box, new THREE.MeshBasicMaterial()), { name: 'Knob' })
    knob.position.y = 1
    parts[1].add(knob)
    const wheel = Object.assign(new THREE.Mesh(box, material), { name: 'Wheel' })
    const few = new THREE.MeshBasicMaterial()
    const other = [0, 1, 2, 3].map(() => new THREE.Mesh(box, few))
    const group = new THREE.Group().add(...parts)
    root.add(group, wheel, ...other)
    const clip = new THREE.AnimationClip('Spin', 1, [new THREE.NumberKeyframeTrack('Wheel.position[x]', [0], [0])])
    root.updateMatrixWorld(true)
    const before = new THREE.Box3().setFromObject(root)
    mergeStatic(root, [clip])
    const merged = root.children.at(-1) as THREE.Mesh
    expect(root.children.map((node) => node.uuid)).toEqual([group, wheel, ...other, merged].map((node) => node.uuid))
    expect(merged.geometry.getAttribute('position').count).toBe(5 * box.getAttribute('position').count)
    expect(new THREE.Box3().setFromObject(root)).toEqual(before)
    expect(group.children).toEqual([knob])
    expect(knob.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([2, 2, 0])
    // every face still faces the way its normals say
    const { position, normal } = merged.geometry.attributes
    const index = merged.geometry.index?.array ?? []
    const [a, b, c, n] = [0, 1, 2, 3].map(() => new THREE.Vector3())
    for (let i = 0; i < index.length; i += 3) {
      a.fromBufferAttribute(position, index[i]); b.fromBufferAttribute(position, index[i + 1]); c.fromBufferAttribute(position, index[i + 2])
      expect(n.subVectors(c, b).cross(a.clone().sub(b)).dot(new THREE.Vector3().fromBufferAttribute(normal, index[i]))).toBeGreaterThan(0)
    }
  })
  it('exports a model whose +x is the scene\'s east and +z its north, with a plane\'s face still reading forward and shared skeletons and tracks turned once', async () => {
    const east = Object.assign(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2)), { name: 'East' })
    east.position.set(1, 0, 0)
    const sign = Object.assign(new THREE.Mesh(new THREE.PlaneGeometry()), { name: 'Sign' })
    sign.position.set(0, 0, 1)
    const root = new THREE.Group().add(east, sign)
    const clip = new THREE.AnimationClip('Slide', 1, [new THREE.VectorKeyframeTrack('East.position', [0, 1], [1, 0, 0, 2, 0, 0])])
    const bone = new THREE.Bone()
    const skeleton = new THREE.Skeleton([bone], [new THREE.Matrix4().makeTranslation(1, 0, 0)])
    const skinned = [0, 1].map(() => new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))
    for (const mesh of skinned) mesh.bind(skeleton, new THREE.Matrix4())
    const values = new Float32Array([1, 0, 0])
    const echoes = ['A', 'B'].map((name) => Object.assign(new THREE.VectorKeyframeTrack(`${name}.position`, [0], [0, 0, 0]), { values }))
    toSceneAxes(new THREE.Group().add(bone, ...skinned), [new THREE.AnimationClip('Echo', 1, echoes)])
    expect(new THREE.Vector3().setFromMatrixPosition(skeleton.boneInverses[0]).x).toBe(-1)
    expect(values[0]).toBe(-1)
    toSceneAxes(root, [clip])
    const glb = await new GLTFExporter().parseAsync(root, { binary: true, animations: [clip] })
    const gltf = await new GLTFLoader().parseAsync(glb as ArrayBuffer, '')
    gltf.scene.updateMatrixWorld(true)
    // Decentraland places glTF with x negated: scene = (-x, y, z)
    const inScene = (v: THREE.Vector3): number[] => [0 - v.x, v.y, v.z]
    const at = (name: string): number[] => inScene(gltf.scene.getObjectByName(name)?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3())
    expect(at('East')).toEqual([1, 0, 0])
    expect(at('Sign')).toEqual([0, 0, 1])
    expect(gltf.animations[0].tracks[0].values[3]).toBe(-2)
    const plane = gltf.scene.getObjectByName('Sign') as THREE.Mesh
    const { position, uv } = plane.geometry.attributes
    const [i, j, k] = plane.geometry.index?.array ?? [0, 1, 2]
    const [a, b, c] = [i, j, k].map((n) => new THREE.Vector3().fromBufferAttribute(position, n))
    const [ua, ub, uc] = [i, j, k].map((n) => new THREE.Vector2(uv.getX(n), uv.getY(n)))
    const front = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a))
    // its front, by winding, faces the scene's north
    expect(Math.sign(front.z)).toBe(1)
    // u runs to the right and v up as seen from the front, in the glTF's own right-handed frame
    const e1 = new THREE.Vector3().subVectors(b, a), e2 = new THREE.Vector3().subVectors(c, a)
    const [du1, dv1, du2, dv2] = [ub.x - ua.x, ub.y - ua.y, uc.x - ua.x, uc.y - ua.y]
    const r = 1 / (du1 * dv2 - du2 * dv1)
    const alongU = e1.clone().multiplyScalar(dv2 * r).addScaledVector(e2, -dv1 * r)
    const alongV = e2.clone().multiplyScalar(du1 * r).addScaledVector(e1, -du2 * r)
    expect(alongU.clone().cross(alongV).dot(front)).toBeGreaterThan(0)
  })
})

const sidesOf = (mesh: THREE.Mesh): THREE.Side[] => [mesh.material].flat().map((m) => m.side)
