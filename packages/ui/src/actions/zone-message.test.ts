import { beforeEach, expect, it, vi } from 'vitest'
import { state } from '@scene/state'
import { uiAddZoneMessage } from './zone-message'

const calls = vi.hoisted(() => ({ place: vi.fn(async () => '600'), params: vi.fn(async () => []), history: vi.fn() }))
vi.mock('../core/autosave', () => ({ flushPendingSave: async () => {} }))
vi.mock('../core/history', () => ({
  withHistorySuppressed: async (fn: () => Promise<void>) => fn(),
  treeCreationEntries: (id: string) => [{ entityId: id }], pushHistory: calls.history
}))
vi.mock('../script/params', () => ({ writeScriptParamValues: calls.params }))
vi.mock('./prefabs', () => ({ uiPlaceLibraryPrefab: calls.place }))

beforeEach(() => {
  state.snapshot = { '512': { 'core-schema::Name': { value: 'Welcome Area' } } }
  vi.clearAllMocks()
})

it('places and wires a message to the selected area without creating custom code', async () => {
  expect(await uiAddZoneMessage('512')).toBe('600')
  expect(calls.place).toHaveBeenCalledWith('builtin:announcer', 'zone_message', { name: 'Welcome Area Message' })
  expect(calls.params).toHaveBeenCalledWith('600', { zone: 'Welcome Area', when: 'enter' }, [])
  expect(calls.history).toHaveBeenCalledTimes(1)
  expect(state.saveStatus).toContain('edit its text in the inspector')
})

it('does nothing when the area was deleted before the gesture', async () => {
  expect(await uiAddZoneMessage('999')).toBeNull()
  expect(calls.place).not.toHaveBeenCalled()
})
