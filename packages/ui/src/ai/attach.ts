import { refreshScriptEverywhere } from '../script/attach'
import { attachablePath } from '../script/template'

// After the assistant writes a script: refresh the params on every entity running it. A new script runs
// nowhere until the assistant attaches it with attachScript — the selection at turn start is often not
// where it belongs.
export async function refreshWrittenScript(path: string, content: string): Promise<void> {
  if (attachablePath(path) !== path) return
  try {
    await refreshScriptEverywhere(path, content)
  } catch (error) {
    console.error('could not refresh the script settings:', path, error)
  }
}
