import { isCatalogSearch } from '../../contract/src/assistant'
import type { BrowserToolName } from '../../contract/src/assistant'

type BrowserCall = (name: BrowserToolName, args: Record<string, unknown>) => Promise<string>

export function orderedBrowserTools(run: BrowserCall): BrowserCall {
  let queued = Promise.resolve()
  return (name, args) => {
    const parallel = isCatalogSearch(name, args)
    const result = (parallel ? Promise.resolve() : queued).then(() => run(name, args))
    if (!parallel) queued = result.then(() => {}, () => {})
    return result
  }
}
