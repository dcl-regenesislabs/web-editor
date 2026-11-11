// The editor's only copy of three.js: builds the assistant's models and draws the catalog preview.
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg'
import type { ThreeReply, ThreeRequest } from './protocol'
import { lockDown, refusedSyntax } from './sandbox'
import { isLibraryName, LIBRARY, libraryMaterialName, metresPerTile, surface, type LibraryName, type MaterialMap } from './materials'
import { libraryGeometry, externalizeLibraryImages } from './library-glb'
import { keepUVs, lathe, rock, seededRandom, tube } from './model-geometry'
import { foliage, leafMaterial, tree, type TreeOptions } from './model-nature'
import { renderModelPreview } from './model-preview'
import { checkCanvasSize, mergeParts, mergeStatic, partNamer, singleSided, stripVertexColors, toSceneAxes } from './build-passes'

type Axis = 'x' | 'y' | 'z'
const STEPS = 24

// a node's tracks address it by name, so every animated node gets one
let namer = partNamer('Model')
const named = (node: THREE.Object3D): string => namer.name(node)

// one turn of a periodic motion, sampled so it loops without a seam
function sampled(seconds: number, at: (phase: number) => number[]): { times: number[]; values: number[] } {
  const times: number[] = []
  const values: number[] = []
  for (let i = 0; i <= STEPS; i++) {
    times.push((seconds * i) / STEPS)
    values.push(...at((i / STEPS) * Math.PI * 2))
  }
  return { times, values }
}

function turned(node: THREE.Object3D, axis: Axis, angle: (phase: number) => number, seconds: number): THREE.KeyframeTrack {
  const base = node.quaternion.clone()
  const unit = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0)
  const { times, values } = sampled(seconds, (phase) => base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(unit, angle(phase))).toArray())
  return new THREE.QuaternionKeyframeTrack(`${named(node)}.quaternion`, times, values)
}

// The real images never enter the worker: each map is a one-pixel stand-in that leaves the GLB as
// a pointer to the shared file (externalizeLibraryImages).
const standIns = new Map<string, THREE.CanvasTexture>()
function standIn(name: LibraryName, map: MaterialMap): THREE.CanvasTexture {
  let texture = standIns.get(`${name}/${map}`)
  if (texture === undefined) {
    texture = new THREE.CanvasTexture(new OffscreenCanvas(1, 1))
    if (map === 'color') texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    standIns.set(`${name}/${map}`, texture)
  }
  return texture
}

// one material per name and settings, so a material used on many parts counts once against the budget
const libraryMaterials = new Map<string, THREE.MeshStandardMaterial>()
function libraryMaterial(name: unknown, o: { color?: THREE.ColorRepresentation; roughness?: number; metalness?: number; relief?: boolean } = {}): THREE.MeshStandardMaterial {
  if (!isLibraryName(name)) throw new Error(`addons.material takes one of ${LIBRARY.join(', ')}`)
  // to the hundredth, so the name built from the settings tells every material apart
  const roughness = Math.round((o.roughness ?? surface(name).roughness) * 100) / 100
  const metalness = Math.round((o.metalness ?? surface(name).metalness) * 100) / 100
  const relief = o.relief !== false
  const settings = { color: new THREE.Color(o.color ?? 0xffffff).getHexString(), roughness, metalness, relief }
  const key = libraryMaterialName(name, settings)
  const known = libraryMaterials.get(key)
  if (known !== undefined) return known
  // relief is the normal map: a second texture, worth it on what players see up close
  const material = new THREE.MeshStandardMaterial({
    map: standIn(name, 'color'), ...(relief ? { normalMap: standIn(name, 'normal') } : {}),
    color: o.color ?? 0xffffff, roughness, metalness
  })
  material.userData.library = name
  material.name = key
  libraryMaterials.set(key, material)
  return material
}

const libraryOf = (node: THREE.Mesh): LibraryName | undefined =>
  [node.material].flat().map((material) => material.userData.library).find(isLibraryName)

const addons = {
  // a shared tiling material: its texture is one file for every model, laid at one tile per metre
  material: libraryMaterial,
  tube, lathe, rock, foliage, leafMaterial, keepUVs, random: seededRandom,
  tree: (options: Partial<TreeOptions> = {}) => tree({
    ...options, trunkMaterial: options.trunkMaterial ?? libraryMaterial('bark'),
    leafMaterial: options.leafMaterial ?? leafMaterial()
  }),
  RoundedBoxGeometry, mergeGeometries: mergeParts, mergeVertices,
  Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION,
  canvas: (width: number, height: number) => {
    checkCanvasSize(width, height)
    return new OffscreenCanvas(width, height)
  },
  // tracks for an AnimationClip; a part moves around its own origin, so put it in a group at the pivot
  spin: (node: THREE.Object3D, o: { axis?: Axis; seconds?: number } = {}) => turned(node, o.axis ?? 'y', (p) => p, o.seconds ?? 4),
  swing: (node: THREE.Object3D, o: { axis?: Axis; degrees?: number; seconds?: number } = {}) =>
    turned(node, o.axis ?? 'z', (p) => THREE.MathUtils.degToRad(o.degrees ?? 20) * Math.sin(p), o.seconds ?? 1),
  bob: (node: THREE.Object3D, o: { height?: number; seconds?: number } = {}) => {
    const start = node.position.clone()
    const { times, values } = sampled(o.seconds ?? 2, (p) => [start.x, start.y + (o.height ?? 0.1) * Math.sin(p), start.z])
    return new THREE.VectorKeyframeTrack(`${named(node)}.position`, times, values)
  }
}

// the page talks to this worker over a port it hands in first: the worker runs in a sandboxed frame
let port: MessagePort | null = null
const reply = (message: ThreeReply, transfer: Transferable[] = []): void => port?.postMessage(message, transfer)

// every geometry three makes, cut shapes included, goes through setAttribute: stopping there ends a
// runaway script long before it can exhaust memory, well above anything the model budget allows
const MAX_VERTICES = 1_000_000

function capGeometry(): void {
  let vertices = 0
  const setAttribute = THREE.BufferGeometry.prototype.setAttribute
  THREE.BufferGeometry.prototype.setAttribute = function (this: THREE.BufferGeometry, name, attribute) {
    if (name === 'position') {
      vertices += attribute.count
      if (vertices > MAX_VERTICES) throw new Error(`the script made over ${MAX_VERTICES.toLocaleString('en')} vertices; build less detail`)
    }
    return setAttribute.call(this, name, attribute)
  }
}

async function build(code: string, model: string): Promise<void> {
  // a build worker runs one script and is thrown away, so it is locked for good
  lockDown(self)
  const refused = refusedSyntax(code)
  if (refused !== null) throw new Error(refused)
  capGeometry()
  namer = partNamer(model)
  const root = new THREE.Group()
  const clips: unknown[] = []
  new Function('THREE', 'addons', 'root', 'clips', code)(THREE, addons, root, clips)
  const animations = clips.filter((clip): clip is THREE.AnimationClip => clip instanceof THREE.AnimationClip)
  root.updateMatrixWorld(true)
  toSceneAxes(root, animations)
  const warnings = stripVertexColors(root)
  singleSided(root)
  // projected without translation, so copies of one geometry that only move still share one buffer
  const projected = new Map<string, THREE.BufferGeometry>()
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    const name = libraryOf(node)
    if (name === undefined) return
    const turn = node.matrixWorld.clone().setPosition(0, 0, 0)
    const key = `${node.geometry.uuid}|${metresPerTile(name)}|${turn.elements.map((n) => n.toFixed(4)).join(',')}`
    let geometry = projected.get(key)
    if (geometry === undefined) {
      geometry = libraryGeometry(node.geometry, turn, metresPerTile(name))
      projected.set(key, geometry)
    }
    node.geometry = geometry
  })
  mergeStatic(root, animations)
  namer.nameAll(root)
  const exported = await new GLTFExporter().parseAsync(root, { binary: true, animations })
  if (!(exported instanceof ArrayBuffer)) throw new Error('the exporter returned no binary')
  const { glb, used } = externalizeLibraryImages(exported)
  reply({ kind: 'built', glb, clips: animations.map((clip) => clip.name), library: used, warnings }, [glb])
}

function externalUris(glb: ArrayBuffer, given: Record<string, ArrayBuffer>): boolean {
  const bytes = new Uint8Array(glb)
  const view = new DataView(glb)
  const text = bytes.length >= 20 && view.getUint32(0, true) === 0x46546c67
    ? new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true)))
    : new TextDecoder().decode(bytes)
  const json: unknown = JSON.parse(text)
  const uris = (key: string): unknown[] => {
    const rows: unknown = typeof json === 'object' && json !== null ? Reflect.get(json, key) : undefined
    return Array.isArray(rows) ? rows.map((row: unknown) => (typeof row === 'object' && row !== null ? Reflect.get(row, 'uri') : undefined)) : []
  }
  return [...uris('buffers'), ...uris('images')].some((uri) => typeof uri === 'string' && !uri.startsWith('data:') && !Object.prototype.hasOwnProperty.call(given, uri))
}

let view: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; target: THREE.Vector3; yaw: number; pitch: number; distance: number } | null = null
// a model's animation plays in the preview, first clip first; drawing then runs every frame
let motion: { mixer: THREE.AnimationMixer; clips: THREE.AnimationClip[] } | null = null

function play(name: string): void {
  if (motion === null) return
  const clip = motion.clips.find((c) => c.name === name)
  if (clip === undefined) return
  motion.mixer.stopAllAction()
  motion.mixer.clipAction(clip).play()
}

function animate(): void {
  const clock = new THREE.Clock()
  const frame = (): void => {
    motion?.mixer.update(clock.getDelta())
    draw()
    setTimeout(frame, 16)
  }
  frame()
}

function draw(): void {
  if (view === null) return
  const { camera, target, yaw, pitch, distance } = view
  camera.position.set(
    target.x + distance * Math.cos(pitch) * Math.sin(yaw),
    target.y + distance * Math.sin(pitch),
    target.z + distance * Math.cos(pitch) * Math.cos(yaw)
  )
  camera.lookAt(target)
  view.renderer.render(view.scene, camera)
}

function show(request: Extract<ThreeRequest, { kind: 'view' }>): void {
  // a preview fetches nothing: a model naming outside files would make the editor's origin request them
  const given = request.files ?? {}
  if (externalUris(request.bytes, given)) throw new Error('the model refers to files outside it')
  // the files it names are served from blobs made here, so the loader still fetches nothing outside
  const blobs = new Map(Object.entries(given).map(([uri, bytes]) => [uri, URL.createObjectURL(new Blob([bytes]))]))
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => blobs.get(url) ?? url)
  const renderer = new THREE.WebGLRenderer({ canvas: request.canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(request.dpr)
  renderer.setSize(request.width, request.height, false)
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2))
  const sun = new THREE.DirectionalLight(0xffffff, 2)
  sun.position.set(3, 6, 4)
  scene.add(sun)
  const camera = new THREE.PerspectiveCamera(40, request.width / request.height, 0.01, 2000)
  new GLTFLoader(manager).parse(request.bytes, '', (gltf) => {
    // Decentraland never draws *_collider meshes; they would wrap the model in a dark shell
    const colliders: THREE.Object3D[] = []
    gltf.scene.traverse((node) => { if (/_collider$/i.test(node.name)) colliders.push(node) })
    for (const node of colliders) node.removeFromParent()
    scene.add(gltf.scene)
    const box = new THREE.Box3().setFromObject(gltf.scene)
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.1)
    view = { renderer, scene, camera, target: box.getCenter(new THREE.Vector3()), yaw: Math.PI / 4, pitch: 0.4, distance: radius * 2.6 }
    if (gltf.animations.length > 0) {
      motion = { mixer: new THREE.AnimationMixer(gltf.scene), clips: gltf.animations }
      play(gltf.animations[0].name)
      animate()
    } else draw()
    reply({ kind: 'shown' })
  }, (error) => reply({ kind: 'failed', error: error.message }))
}

function handle(event: MessageEvent<ThreeRequest>): void {
  const request = event.data
  try {
    if (!['build', 'view', 'preview', 'clip'].includes(request.kind) && view === null) return
    if ((request.kind === 'build' && mode !== 'build') || ((request.kind === 'view' || request.kind === 'preview') && mode !== 'view')) throw new Error(`a ${String(mode)} worker does not ${request.kind}`)
    if (request.kind === 'build') {
      build(request.code, request.name).catch((error: unknown) => reply({ kind: 'failed', error: error instanceof Error ? error.message : String(error) }))
    } else if (request.kind === 'view') {
      show(request)
    } else if (request.kind === 'preview') {
      if (externalUris(request.bytes, request.files)) throw new Error('The model refers to files outside it.')
      renderModelPreview(request.bytes, request.files).then((preview) => reply({ kind: 'previewed', preview }))
        .catch((error: unknown) => reply({ kind: 'failed', error: error instanceof Error ? error.message : String(error) }))
    } else if (request.kind === 'clip') {
      play(request.name)
    } else if (view !== null && request.kind === 'orbit') {
      view.yaw -= request.dx * 0.01
      view.pitch = Math.max(-1.4, Math.min(1.4, view.pitch + request.dy * 0.01))
      draw()
    } else if (view !== null && request.kind === 'zoom') {
      view.distance *= Math.exp(request.delta * 0.001)
      draw()
    } else if (view !== null && request.kind === 'resize') {
      view.renderer.setSize(request.width, request.height, false)
      view.camera.aspect = request.width / request.height
      view.camera.updateProjectionMatrix()
      draw()
    }
  } catch (error) {
    reply({ kind: 'failed', error: error instanceof Error ? error.message : String(error) })
  }
}

// fixed by the first message: a preview worker never builds, a build worker never previews
let mode: 'build' | 'view' | null = null

self.onmessage = (event: MessageEvent) => {
  if (port !== null || event.ports[0] === undefined || (event.data !== 'build' && event.data !== 'view')) return
  mode = event.data
  port = event.ports[0]
  port.onmessage = handle
  reply({ kind: 'ready' })
}
