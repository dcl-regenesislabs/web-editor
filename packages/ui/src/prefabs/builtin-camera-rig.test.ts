// Guards the Camera Rig prefab's folder facts: the generic sweep in
// builtin.test.ts covers hygiene, this covers what the script and the guide
// are written against.
import { describe, expect, it } from 'vitest'
import { getScriptParams } from '../script/parser'
import { readPrefabFile as read } from './builtin-fixtures'
import { ASSET_PATH_TOKEN, SCRIPT_COMPONENT, isRecord, parsePrefabComposite, parsePrefabData, prefabLayout } from './format'

const FOLDER = 'camera-rig'
const SCRIPT = `${FOLDER}/scripts/camera-rig.ts`

describe('the camera rig', () => {
  const data = parsePrefabData(read(`${FOLDER}/data.json`), FOLDER, 'fallback')
  const composite = parsePrefabComposite(read(`${FOLDER}/composite.json`), FOLDER)
  const { params, error } = getScriptParams(read(SCRIPT))

  it('runs on any scene: no SDK gate, no permissions, no group tile', () => {
    expect(data.origin?.source).toBe('builtin')
    expect(data.id).toBe('7ea892f3-168f-40fb-8338-d9c91c23708e')
    expect(data.requiresSdk).toBeUndefined()
    expect(data.requiredPermissions ?? []).toEqual([])
    expect(data.group).toBeUndefined()
  })

  // The scale IS the framed area and the TriggerArea the editor draws, so it
  // ships a size; the drop point supplies the position.
  it('is one entity whose scale is the area, with no authored position', () => {
    const layout = prefabLayout(composite)
    expect(layout.entities.map((entity) => entity.localId)).toEqual(['0'])
    expect(layout.entities[0].transform?.scale).toEqual({ x: 12, y: 4, z: 12 })
    expect(layout.entities[0].transform?.position).toBeUndefined()
  })

  // A TriggerArea renders nothing in a built game and the editor draws its
  // volume only while building — that is the rig's edit-time marker. Mask 8 is
  // the local avatar: the view switches for the player at this screen only.
  it('marks its area with a local-avatar TriggerArea and ships no visible mesh', () => {
    const area = composite.components.find((component) => component.name === 'core::TriggerArea')
    expect(area?.data['0']?.json).toEqual({ mesh: 0, collisionMask: 8 })
    const names = composite.components.map((component) => component.name)
    expect(names).not.toContain('core::MeshRenderer')
    expect(names).not.toContain('core::GltfContainer')
  })

  it('points at the rig script with a layout stub placement fills in', () => {
    const script = composite.components.find((component) => component.name === SCRIPT_COMPONENT)
    const json = script?.data['0']?.json
    const value = isRecord(json) && Array.isArray(json.value) ? json.value : []
    const entry = isRecord(value[0]) ? value[0] : {}
    expect(entry.path).toBe(`${ASSET_PATH_TOKEN}/scripts/camera-rig.ts`)
    expect(entry.layout).toBe('{"params":{},"actions":[]}')
  })

  // The guide and the assistant's placePrefab requests write these names and
  // option strings verbatim.
  it('exposes the six settings the guide is written against', () => {
    expect(error).toBeUndefined()
    expect(Object.keys(params)).toEqual(['mode', 'activeWhen', 'angle', 'distance', 'fitSize', 'transitionSeconds'])
    expect(params.mode.options).toEqual(['top-down', 'isometric', 'follow'])
    expect(params.mode.value).toBe('isometric')
    expect(params.activeWhen.options).toEqual(['inside this area', 'always'])
    expect(params.activeWhen.value).toBe('inside this area')
    expect(params.angle.value).toBe(55)
    expect(params.distance.value).toBe(0)
    expect(params.fitSize.value).toBe(0)
    expect(params.transitionSeconds.value).toBe(0.6)
  })

  // Older project pins lack VirtualCamera.fov and the Transition helper; the
  // script must stay on the surface every pin has.
  it('keeps to the long-stable camera surface', () => {
    const source = read(SCRIPT)
    expect(source).not.toContain('VirtualCamera.Transition')
    expect(source).toContain("$case: 'time'")
    expect(source).toContain('MainCamera.createOrReplace(engine.CameraEntity')
    expect(source).toContain('if (isServer()) return')
  })
})
