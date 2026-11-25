// Writes the Pickup Item's two scene emotes into prefabs/pickup-item/emotes/:
//   node packages/desktop/scripts/make-pickup-emotes.mjs
// They are keyframed here, not mocap: a short reach to a table, and a squat to the floor. The rig
// (bones, rest pose, skin) is copied from the seat's emote, so the bone names and the skeleton
// match the Decentraland avatar exactly; only the animation is new.
//
// A pose turns each bone by angles about the AVATAR's axes at rest (x: its left, y: up, z: its
// front), applied z, then x, then y, and on top of its parent's turn, as when posing by hand.
// Seen from the avatar: +x bends the spine forward, a negative z lowers its left arm and a positive
// z its right, a thigh goes forward with a negative x and its shin folds back with +x. The reach
// angles were solved for the right hand's knuckles: about 0.9 m high and 0.4 m ahead over a table,
// 0.12 m off the floor and 0.4 m ahead in the squat.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const prefabs = path.resolve(here, '..', 'prefabs')
const RIG = path.join(prefabs, 'sit-spot-edge', 'emotes', 'Sit_Edge1_emote.glb')
const OUT = path.join(prefabs, 'pickup-item', 'emotes')
const FPS = 30

const deg = (d) => (d * Math.PI) / 180
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
]
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]]
const axis = (x, y, z, rad) => [x * Math.sin(rad / 2), y * Math.sin(rad / 2), z * Math.sin(rad / 2), Math.cos(rad / 2)]
const rotate = (q, v) => qmul(qmul(q, [...v, 0]), qinv(q)).slice(0, 3)
const smooth = (t) => t * t * (3 - 2 * t)

function readGlb(file) {
  const bytes = fs.readFileSync(file)
  const jsonLength = bytes.readUInt32LE(12)
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString())
  const binStart = 20 + jsonLength + 8
  return { json, bin: bytes.subarray(binStart, binStart + bytes.readUInt32LE(20 + jsonLength)) }
}

function writeGlb(file, json, bin) {
  const pad = (buf, fill) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4, fill)])
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20)
  const binChunk = pad(bin, 0)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8)
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32LE(data.length, 0)
    head.writeUInt32LE(type, 4)
    return Buffer.concat([head, data])
  }
  fs.writeFileSync(file, Buffer.concat([header, chunk(0x4e4f534a, jsonChunk), chunk(0x004e4942, binChunk)]))
}

const rig = readGlb(RIG)
const nodes = rig.json.nodes
const parentOf = new Map()
nodes.forEach((node, i) => (node.children ?? []).forEach((child) => parentOf.set(child, i)))
const restWorld = []
function worldRotation(i) {
  if (restWorld[i] !== undefined) return restWorld[i]
  const own = nodes[i].rotation ?? [0, 0, 0, 1]
  restWorld[i] = parentOf.has(i) ? qmul(worldRotation(parentOf.get(i)), own) : own
  return restWorld[i]
}
const indexOf = (name) => {
  const i = nodes.findIndex((node) => node.name === name)
  if (i < 0) throw new Error(`the rig has no bone ${name}`)
  return i
}
const HIPS = indexOf('Avatar_Hips')

const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'].flatMap((f) => [1, 2, 3].map((n) => `${f}${n}`))
// arms down from the rig's T-pose, elbows soft: the avatar standing still
const IDLE = {
  Avatar_LeftArm: [0, 0, -78],
  Avatar_RightArm: [0, 0, 78],
  Avatar_LeftForeArm: [-8, 0, 0],
  Avatar_RightForeArm: [-8, 0, 0]
}
const grip = (curl) => Object.fromEntries(FINGERS.map((f) => [`Avatar_RightHand${f}`, [0, 0, curl]]))
// thigh forward a, shin back b, foot flat again: the hips drop and move back to stay over the feet
function squat(a, b) {
  const thigh = 0.448
  const shin = 0.407
  const drop = thigh + shin - (thigh * Math.cos(deg(a)) + shin * Math.cos(deg(b - a)))
  const back = thigh * Math.sin(deg(a)) - shin * Math.sin(deg(b - a))
  const legs = {}
  for (const side of ['Left', 'Right']) {
    legs[`Avatar_${side}UpLeg`] = [-a, 0, 0]
    legs[`Avatar_${side}Leg`] = [b, 0, 0]
    legs[`Avatar_${side}Foot`] = [a - b, 0, 0]
  }
  return { legs, hips: [0, -drop, -back] }
}

const TABLE = {
  name: 'Pickup_Table',
  keys: [
    { t: 0, pose: IDLE },
    {
      t: 0.45,
      pose: {
        ...IDLE,
        Avatar_Spine: [12, 0, 0],
        Avatar_Spine1: [6, 0, 0],
        Avatar_Neck: [8, 0, 0],
        Avatar_RightArm: [-45, 0, 90],
        Avatar_RightForeArm: [-5, 0, 0],
        ...grip(10)
      }
    },
    {
      t: 0.65,
      pose: {
        ...IDLE,
        Avatar_Spine: [10, 0, 0],
        Avatar_Spine1: [5, 0, 0],
        Avatar_Neck: [6, 0, 0],
        Avatar_RightArm: [-40, 0, 88],
        Avatar_RightForeArm: [-25, 0, 0],
        ...grip(55)
      }
    },
    { t: 1.2, pose: { ...IDLE, ...grip(30) } }
  ]
}

const low = squat(85, 145)
const FLOOR = {
  name: 'Pickup_Floor',
  keys: [
    { t: 0, pose: IDLE },
    {
      t: 0.75,
      hips: low.hips,
      pose: {
        ...IDLE,
        ...low.legs,
        Avatar_Spine: [40, 0, 0],
        Avatar_Spine1: [12, 0, 0],
        Avatar_Neck: [15, 0, 0],
        Avatar_LeftArm: [-35, 0, -70],
        Avatar_LeftForeArm: [-40, 0, 0],
        Avatar_RightArm: [-70, 0, 95],
        Avatar_RightForeArm: [-60, 0, 0],
        ...grip(10)
      }
    },
    {
      t: 1.0,
      hips: low.hips,
      pose: {
        ...IDLE,
        ...low.legs,
        Avatar_Spine: [38, 0, 0],
        Avatar_Spine1: [12, 0, 0],
        Avatar_Neck: [12, 0, 0],
        Avatar_LeftArm: [-35, 0, -70],
        Avatar_LeftForeArm: [-40, 0, 0],
        Avatar_RightArm: [-62, 0, 92],
        Avatar_RightForeArm: [-75, 0, 0],
        ...grip(55)
      }
    },
    { t: 1.9, pose: { ...IDLE, ...grip(30) } }
  ]
}

// the bone's local rotation for turns about the avatar's rest axes, on top of its parent
function localRotation(i, [x, y, z]) {
  const turn = qmul(axis(0, 1, 0, deg(y)), qmul(axis(1, 0, 0, deg(x)), axis(0, 0, 1, deg(z))))
  const own = nodes[i].rotation ?? [0, 0, 0, 1]
  if (!parentOf.has(i)) return qmul(turn, own)
  const parent = worldRotation(parentOf.get(i))
  return qmul(qmul(qmul(qinv(parent), turn), parent), own)
}

function sample(clip, t) {
  const keys = clip.keys
  let k = 0
  while (k < keys.length - 2 && t > keys[k + 1].t) k++
  const a = keys[k]
  const b = keys[k + 1]
  const f = smooth(Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))))
  const mix = (p, q) => p.map((v, n) => v + (q[n] - v) * f)
  const angles = new Map()
  for (const name of new Set([...Object.keys(a.pose), ...Object.keys(b.pose)])) {
    angles.set(name, mix(a.pose[name] ?? [0, 0, 0], b.pose[name] ?? [0, 0, 0]))
  }
  return { angles, hips: mix(a.hips ?? [0, 0, 0], b.hips ?? [0, 0, 0]) }
}

function build(clip) {
  const json = structuredClone(rig.json)
  const ibm = rig.json.accessors[rig.json.skins[0].inverseBindMatrices]
  const ibmView = rig.json.bufferViews[ibm.bufferView]
  const parts = [Buffer.from(rig.bin.subarray(ibmView.byteOffset ?? 0, (ibmView.byteOffset ?? 0) + ibmView.byteLength))]
  let offset = ibmView.byteLength
  json.bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: ibmView.byteLength }]
  json.accessors = [{ ...ibm, bufferView: 0, byteOffset: 0 }]
  json.skins[0].inverseBindMatrices = 0
  const addAccessor = (floats, type, extra = {}) => {
    const data = Buffer.from(new Float32Array(floats).buffer)
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length })
    parts.push(data)
    offset += data.length
    const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type]
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: floats.length / width, type, ...extra })
    return json.accessors.length - 1
  }

  const end = clip.keys[clip.keys.length - 1].t
  const frames = Math.round(end * FPS) + 1
  if (frames > 300) throw new Error(`${clip.name} is ${frames} frames; an emote holds at most 300`)
  const times = Array.from({ length: frames }, (_, n) => n / FPS)
  const input = addAccessor(times, 'SCALAR', { min: [0], max: [times[times.length - 1]] })
  const samplers = []
  const channels = []
  const poses = times.map((t) => sample(clip, t))
  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i].name.startsWith('Avatar_')) continue
    const rotations = poses.flatMap((pose) => localRotation(i, pose.angles.get(nodes[i].name) ?? [0, 0, 0]))
    samplers.push({ input, output: addAccessor(rotations, 'VEC4'), interpolation: 'LINEAR' })
    channels.push({ sampler: samplers.length - 1, target: { node: i, path: 'rotation' } })
  }
  // hips offsets are in metres along the avatar's axes; the hips' own translation is in its parent's frame
  const parent = parentOf.get(HIPS)
  const scale = nodes[parent].scale?.[0] ?? 1
  const toLocal = qinv(worldRotation(parent))
  const rest = nodes[HIPS].translation ?? [0, 0, 0]
  const translations = poses.flatMap((pose) => rotate(toLocal, pose.hips.map((v) => v / scale)).map((v, n) => v + rest[n]))
  samplers.push({ input, output: addAccessor(translations, 'VEC3'), interpolation: 'LINEAR' })
  channels.push({ sampler: samplers.length - 1, target: { node: HIPS, path: 'translation' } })

  json.animations = [{ name: `${clip.name}_Avatar`, samplers, channels }]
  json.buffers = [{ byteLength: offset }]
  json.asset = { version: '2.0', generator: 'dcl-editor make-pickup-emotes' }
  const file = path.join(OUT, `${clip.name}_emote.glb`)
  writeGlb(file, json, Buffer.concat(parts))
  return `${path.relative(process.cwd(), file)}: ${frames} frames, ${fs.statSync(file).size} bytes`
}

fs.mkdirSync(OUT, { recursive: true })
for (const clip of [TABLE, FLOOR]) console.log(build(clip))
