import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import type { ModelPreview } from '@dcl-editor/contract'

// A studio contact sheet checks the exported asset; the scene's lighting still needs an in-world view.
export async function renderModelPreview(bytes: ArrayBuffer, files: Record<string, ArrayBuffer>): Promise<ModelPreview> {
  const blobs = new Map(Object.entries(files).map(([uri, data]) => [uri, URL.createObjectURL(new Blob([data]))]))
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => blobs.get(url) ?? url)
  const scene = new THREE.Scene()
  const meshes: THREE.Mesh[] = []
  const canvas = new OffscreenCanvas(384, 384)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  try {
    renderer.setSize(384, 384, false)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    scene.background = new THREE.Color('#d6d9dc')
    const { scene: model } = await new GLTFLoader(manager).parseAsync(bytes, '')
    const hidden: THREE.Object3D[] = []
    model.traverse((node) => {
      if (node instanceof THREE.Mesh) meshes.push(node)
      if (/_collider$/i.test(node.name)) hidden.push(node)
    })
    for (const node of hidden) node.removeFromParent()
    scene.add(model)
    const bounds = new THREE.Box3().setFromObject(model)
    if (bounds.isEmpty()) throw new Error('The model has no visible geometry to preview.')
    const center = bounds.getCenter(new THREE.Vector3())
    const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.01)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x697579, 2))
    const key = new THREE.DirectionalLight(0xfff0df, 3)
    key.position.set(3, 5, 4)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0xe1ecff, 1.5)
    rim.position.set(-4, 2, -3)
    scene.add(rim)
    const camera = new THREE.PerspectiveCamera(38, 1, radius / 100, radius * 20)
    const sheet = new OffscreenCanvas(1152, 384)
    const ctx = sheet.getContext('2d')
    if (ctx === null) throw new Error('The model preview could not be drawn.')
    for (const [i, yaw] of [Math.PI / 4, -Math.PI / 4, Math.PI * 1.25].entries()) {
      camera.position.copy(center).add(new THREE.Vector3(Math.sin(yaw), 0.3, Math.cos(yaw)).normalize().multiplyScalar(radius * 3.3))
      camera.lookAt(center)
      renderer.render(scene, camera)
      ctx.drawImage(canvas, i * 384, 0)
    }
    const jpeg = await sheet.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
    const image = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1])
      reader.onerror = () => reject(new Error('The model preview could not be encoded.'))
      reader.readAsDataURL(jpeg)
    })
    return { mimeType: 'image/jpeg', image, width: 1152, height: 384 }
  } finally {
    for (const node of meshes) {
      node.geometry.dispose()
      for (const material of [node.material].flat()) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose()
        material.dispose()
      }
    }
    renderer.dispose()
    for (const blob of blobs.values()) URL.revokeObjectURL(blob)
  }
}
