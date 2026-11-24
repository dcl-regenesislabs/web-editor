// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { renderModelPreview } from './model-preview'

vi.mock('three', async (real) => ({ ...(await real<object>()), WebGLRenderer: class {
  setSize = vi.fn()
  render = vi.fn()
  dispose = vi.fn()
} }))

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('disposes detached colliders along with visible geometry and materials', async () => {
  const model = new THREE.Group()
  const visible = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshStandardMaterial({ map: new THREE.Texture() }))
  hidden.name = 'box_collider'
  model.add(visible, hidden)
  const disposals = [visible.geometry, visible.material, hidden.geometry, hidden.material, hidden.material.map!].map((resource) => vi.spyOn(resource, 'dispose'))
  vi.spyOn(GLTFLoader.prototype, 'parseAsync').mockResolvedValue({ scene: model } as unknown as Awaited<ReturnType<GLTFLoader['parseAsync']>>)
  vi.stubGlobal('OffscreenCanvas', class {
    getContext() { return { drawImage: vi.fn() } }
    async convertToBlob() { return new Blob(['jpeg'], { type: 'image/jpeg' }) }
  })
  await expect(renderModelPreview(new ArrayBuffer(0), {})).resolves.toMatchObject({ mimeType: 'image/jpeg', width: 1152, height: 384 })
  expect(hidden.parent).toBeNull()
  for (const dispose of disposals) expect(dispose).toHaveBeenCalledOnce()
})
