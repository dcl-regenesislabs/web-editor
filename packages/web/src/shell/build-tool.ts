// The assistant's build tool: compile the open project's files and run the result once.
import type { BuildDiagnostic } from '@dcl-editor/scene-compiler'
import type { BuildRun } from '@ui/actions/verify-build'

export interface BuildToolDeps {
  // writes the edits still waiting in the autosave's debounce
  saveScene(): Promise<void>
  // resolves once every queued file write has landed in the project
  fileWrites(): Promise<unknown>
  compile(): Promise<{ ok: boolean; diagnostics: BuildDiagnostic[] }>
  run(): Promise<BuildRun>
  mobilePreview(): unknown
}

export function createBuildTool(deps: BuildToolDeps): (signal: AbortSignal) => Promise<unknown> {
  return async (signal) => {
    signal.throwIfAborted()
    // the save is itself a file write: it has to be queued before the queue is awaited
    await deps.saveScene()
    await deps.fileWrites()
    const result = await deps.compile()
    signal.throwIfAborted()
    if (!result.ok) return { ok: false, diagnostics: result.diagnostics, mobilePreview: deps.mobilePreview() }
    // compiled is not working: run it once and report what it printed
    const run = await deps.run()
    signal.throwIfAborted()
    return { ok: true, diagnostics: result.diagnostics, run, mobilePreview: deps.mobilePreview() }
  }
}
