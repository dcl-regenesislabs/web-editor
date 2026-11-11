import { state } from '@scene/state'
import { restartScene } from '../boot/boot'
import { asAssistant } from '../core/autosave'
import { log } from '../log'
import { entitiesWithScript, refreshScriptEverywhere } from '../script/attach'
import { attachablePath } from '../script/template'

// After the assistant writes a script: refresh the params on every entity running it. A new script runs
// nowhere until the assistant attaches it with attachScript — the selection at turn start is often not
// where it belongs.
//
// A playing scene is stopped first, as playtest stop does: its new settings would otherwise be the
// running instance's only, lost on Stop, and the new code only runs after a reload anyway.
export async function refreshWrittenScript(path: string, content: string): Promise<void> {
  if (attachablePath(path) !== path || entitiesWithScript(path).length === 0) return
  try {
    if (!state.frozen) await restartScene()
    if (!state.frozen) {
      log.warn('script settings left as they were: the scene would not stop', path)
      return
    }
    await asAssistant(() => refreshScriptEverywhere(path, content))
  } catch (error) {
    log.error('could not refresh the script settings:', path, error)
  }
}
