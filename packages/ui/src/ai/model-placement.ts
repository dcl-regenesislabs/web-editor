import { object } from '@dcl-editor/contract'
import { Matrix, Quaternion, Vector3 } from '@dcl/sdk/math'
import type { inspectModel } from '../model-info'

type Bounds = ReturnType<typeof inspectModel>['bounds']

function coordinate(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Model position and rotation must contain finite numbers.')
  return value
}

export function fitModelHeight(bounds: Bounds, height: unknown, position?: unknown, rotation?: unknown) {
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) throw new Error('height must be a positive number in metres.')
  if (bounds === null) throw new Error('This model has no reliable bounds. Inspect and place it with an explicit scale instead of height.')
  if (position !== undefined && !object(position)) throw new Error('position must contain x, y and z coordinates.')
  if (rotation !== undefined && !object(rotation)) throw new Error('rotation must be a quaternion with x, y, z and w.')
  const p = position ?? {}, r = rotation ?? {}
  const anchor = { x: coordinate(p.x, 8), y: coordinate(p.y, 0), z: coordinate(p.z, 8) }
  const q = { x: coordinate(r.x, 0), y: coordinate(r.y, 0), z: coordinate(r.z, 0), w: coordinate(r.w, 1) }
  const length = Math.hypot(q.x, q.y, q.z, q.w)
  if (length < 1e-8) throw new Error('rotation must be a nonzero quaternion.')
  const orientation = Quaternion.create(q.x / length, q.y / length, q.z / length, q.w / length)
  const matrix = Matrix.compose(Vector3.One(), orientation, Vector3.Zero())
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (let corner = 0; corner < 8; corner++) {
    const point = Vector3.transformCoordinates({
      x: (corner & 1 ? bounds.max : bounds.min).x,
      y: (corner & 2 ? bounds.max : bounds.min).y,
      z: (corner & 4 ? bounds.max : bounds.min).z
    }, matrix)
    for (const axis of ['x', 'y', 'z'] as const) {
      min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis])
    }
  }
  const nativeHeight = max.y - min.y
  if (!Number.isFinite(nativeHeight) || nativeHeight < 1e-8) throw new Error('This model has no height to fit.')
  const scale = height / nativeHeight
  const pose = {
    position: { x: anchor.x - (min.x + max.x) * scale / 2, y: anchor.y - min.y * scale, z: anchor.z - (min.z + max.z) * scale / 2 },
    rotation: orientation,
    scale: { x: scale, y: scale, z: scale }
  }
  if (![...Object.values(pose.position), scale].every(Number.isFinite)) throw new Error('The fitted model transform is too large.')
  return pose
}
