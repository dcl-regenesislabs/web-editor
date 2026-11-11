// The admin panel's Smart Items tab runs Creator Hub's script-backed smart items:
// their Actions are `call_script_method` (creator-hub#1667). The payloads below
// are wooden_door's, from creator-hub's packs/smart_items/assets/wooden_door/composite.json.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Entity } from '@dcl/sdk/ecs'
import { dispatchAction, SUPPORTED_ACTIONS } from '../../prefabs/admin-tools/scripts/actions'

const scene = vi.hoisted(() => ({ actions: new Map<number, Array<{ name: string; type: string; jsonPayload: string }>>() }))

vi.mock('@dcl/sdk/ecs', () => ({}))
vi.mock('../../prefabs/admin-tools/scripts/components', () => ({
  Actions: { getOrNull: (entity: number) => (scene.actions.has(entity) ? { value: scene.actions.get(entity) } : null) },
  States: { getMutableOrNull: () => null }
}))

const DOOR = 520 as Entity
const doorActions = (scriptPath: string): Array<{ name: string; type: string; jsonPayload: string }> => [
  { type: 'call_script_method', name: 'Open', jsonPayload: JSON.stringify({ scriptPath, methodName: 'open', params: {} }) },
  { type: 'call_script_method', name: 'Close', jsonPayload: JSON.stringify({ scriptPath, methodName: 'close', params: {} }) },
  { type: 'call_script_method', name: 'Say', jsonPayload: JSON.stringify({ scriptPath, methodName: 'say', params: { text: 'hi', times: 2 } }) }
]

class Door {
  calls: unknown[][] = []
  open(): void {
    this.calls.push(['open'])
  }
  close(): void {
    this.calls.push(['close'])
  }
  say(...args: unknown[]): void {
    this.calls.push(['say', ...args])
  }
}

function register(entity: Entity, path: string, instance: unknown): void {
  const globals = globalThis as unknown as Record<string, unknown>
  const registry = (globals.__DCL_SCRIPT_INSTANCES__ ??= new Map()) as Map<string, unknown>
  registry.set(`${entity}:${path}`, { instance, entity, path })
}

describe('call_script_method from the Smart Items tab', () => {
  let door: Door

  beforeEach(() => {
    door = new Door()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).__DCL_SCRIPT_INSTANCES__
    scene.actions.clear()
    vi.restoreAllMocks()
  })

  it('is a supported action type', () => {
    expect(SUPPORTED_ACTIONS).toContain('call_script_method')
  })

  it('calls the method on the script instance the payload names', () => {
    const path = 'assets/asset-packs/wooden_door/Door.ts'
    scene.actions.set(DOOR, doorActions(path))
    register(DOOR, path, door)
    expect(dispatchAction(DOOR, 'Open')).toBe(true)
    expect(dispatchAction(DOOR, 'Close')).toBe(true)
    expect(door.calls).toEqual([['open'], ['close']])
  })

  it('passes the payload params positionally', () => {
    const path = 'assets/asset-packs/wooden_door/Door.ts'
    scene.actions.set(DOOR, doorActions(path))
    register(DOOR, path, door)
    dispatchAction(DOOR, 'Say')
    expect(door.calls).toEqual([['say', 'hi', 2]])
  })

  it('resolves a payload that still holds {assetPath} to the entity script with that file name', () => {
    scene.actions.set(DOOR, doorActions('{assetPath}/Door.ts'))
    register(DOOR, 'custom/wooden_door/Door.ts', door)
    register(521 as Entity, 'custom/other_door/Door.ts', new Door())
    dispatchAction(DOOR, 'Open')
    expect(door.calls).toEqual([['open']])
  })

  it("never calls Object.prototype's members as an action", () => {
    const path = 'assets/asset-packs/wooden_door/Door.ts'
    scene.actions.set(DOOR, [{ type: 'call_script_method', name: 'Odd', jsonPayload: JSON.stringify({ scriptPath: path, methodName: 'constructor' }) }])
    register(DOOR, path, door)
    dispatchAction(DOOR, 'Odd')
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('has no method "constructor"'))
  })

  it('does nothing, and says so, when no instance has that method', () => {
    scene.actions.set(DOOR, doorActions('assets/asset-packs/wooden_door/Door.ts'))
    expect(() => dispatchAction(DOOR, 'Open')).not.toThrow()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('has no method "open"'))
  })
})
