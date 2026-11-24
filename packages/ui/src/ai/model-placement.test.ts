import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { fitModelHeight } from './model-placement'

const bounds = {
  min: { x: -15.1598985, y: 33.6317639, z: -15.9243192 },
  max: { x: -8.3458934, y: 40.0511446, z: -8.3926146 },
  size: { x: 6.8140051, y: 6.4193807, z: 7.5317046 }
}

describe('fitting catalog models to a requested height', () => {
  it.each([0, Math.PI / 2, Math.PI / 4])('centres and grounds an offset model after rotation (%s radians)', (angle) => {
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 1, 0).normalize(), angle)
    const pose = fitModelHeight(bounds, 5, { x: 16, y: 2, z: 16 }, { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
    const box = new THREE.Box3(new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z), new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z))
    box.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(pose.position.x, pose.position.y, pose.position.z),
      new THREE.Quaternion(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w),
      new THREE.Vector3(pose.scale.x, pose.scale.y, pose.scale.z)))
    expect(box.min.y).toBeCloseTo(2)
    expect(box.max.y).toBeCloseTo(7)
    expect(box.getCenter(new THREE.Vector3()).x).toBeCloseTo(16)
    expect(box.getCenter(new THREE.Vector3()).z).toBeCloseTo(16)
    expect(pose.scale.x).toBe(pose.scale.y)
    expect(pose.scale.y).toBe(pose.scale.z)
  })

  it.each([0, -1, NaN, Infinity, '5'])('rejects an invalid height (%s)', (height) => {
    expect(() => fitModelHeight(bounds, height)).toThrow('height')
  })

  it('refuses unknown or flat bounds and malformed transforms', () => {
    expect(() => fitModelHeight(null, 5)).toThrow('reliable bounds')
    expect(() => fitModelHeight({ min: bounds.min, max: bounds.min, size: { x: 0, y: 0, z: 0 } }, 5)).toThrow('no height')
    expect(() => fitModelHeight(bounds, 5, { y: NaN })).toThrow('finite')
    expect(() => fitModelHeight(bounds, 5, undefined, { x: 0, y: 0, z: 0, w: 0 })).toThrow('nonzero')
  })
})
