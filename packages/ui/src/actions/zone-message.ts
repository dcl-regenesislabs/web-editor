import { state } from '@scene/state'
import { entityName } from '@scene/custom-components'
import { flushPendingSave } from '../core/autosave'
import { pushHistory, treeCreationEntries, withHistorySuppressed } from '../core/history'
import { writeScriptParamValues } from '../script/params'
import { uiPlaceLibraryPrefab } from './prefabs'

export async function uiAddZoneMessage(zoneId: string): Promise<string | null> {
  const zone = entityName(state.snapshot, zoneId)
  if (zone === undefined || zone.trim() === '') return null
  let created: string | null = null
  try {
    await withHistorySuppressed(async () => {
      const placement = { name: `${zone} Message` }
      created = await uiPlaceLibraryPrefab('builtin:announcer', 'zone_message', placement)
      if (created === null) return
      const problems: string[] = []
      await writeScriptParamValues(created, { zone, when: 'enter' }, problems)
      if (problems.length) throw new Error(problems.join('; '))
    })
    if (created !== null) {
      await flushPendingSave()
      state.saveStatus = 'Message added — edit its text in the inspector, then Play and enter the area'
    }
  } catch (error) {
    state.saveStatus = `Could not configure the area message: ${String(error)}`
  } finally {
    if (created !== null) pushHistory(treeCreationEntries(created))
  }
  return created
}
