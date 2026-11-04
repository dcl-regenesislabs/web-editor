// The seam between the web entry (main.tsx) and the in-page shell (shell/).
//
// shell/index.ts exports `createWebShell: CreateWebShell`. The entry calls it once
// per mount and installs the result: `shell` becomes window.editorShell, which is
// where the editor UI reads its backend from, and `dataLayer` is the project's
// file store (engine/datalayer.ts stops dialing a dev server when hosted).
//
// What the UI expects of `shell` in the browser:
// - A plain object: the UI spreads it and calls its methods unbound.
// - Projects are named by id (the preview realm's projectId), wherever the
//   desktop shell uses a folder path.
// - openProject(id): the entry has already switched the view to the loading
//   screen. Drop the previous project's ready payload synchronously, build and
//   publish the preview, then answer through onServersReady (and requestReady)
//   with { realm: preview realm url without the trailing slash, systemScene: '',
//   position: the scene's base parcel, spawn, spawnPoints }, or through
//   onServersError. Never navigate the page.
// - onBuildEvent reports drive the build banner and the wait before Play
//   (features/editor/scene-health.ts, engine/rebuild.ts); onStackLog lines are
//   only shown, in the logs drawer and on the loading screens.
// - The shell never reloads the scene. The editor does, by id, on Play, Stop and
//   a save in the code editor, once the build it waited for has been published.
// - Subscribers are never removed and a screen subscribes on every mount: keep
//   callbacks cheap and tolerate ones whose screen is gone.
// - The host's identity and console stay with the host: no signing in or out,
//   and console lines only through context.host.engineConsole.
import type { EditorShell, ProjectImportReport } from '@dcl-editor/contract'
import type { BuildOptions, BuildResult } from '@dcl-editor/scene-compiler'
import type { DataLayerClient } from '@ui/engine/datalayer'
import type { DclEditorHost } from '@ui/engine/hosted'
import type { SceneCompilerFiles } from './workers'

export type { DataLayerClient, DclEditorHost, EditorShell }

// What the rest of the web target needs of a project beyond the editor's own
// backend: publishing takes files + manifest + a production build, package
// resolution takes dependencies and the imports as they happen.
export interface WebProjects {
  // on this device, or (after asking the account) on the account
  find(id: string): Promise<boolean>
  // the project's source files as they are now: no build output, no packages
  files(id: string): Promise<Map<string, Uint8Array>>
  // path -> Decentraland content hash and size of those files (@dcl-editor/contract/cid);
  // a file the account already holds is not hashed again
  manifest(id: string): Promise<Record<string, { hash: string; size: number }>>
  // a build of those files; its outputs are bin/index.js and, with a composite,
  // main.crdt. { production: true } is what a deployment takes.
  build(id: string, options?: BuildOptions): Promise<BuildResult & { sdkVersion: string }>
  // package.json dependencies the bundled SDK does not provide: name -> range
  dependencies(id: string): Promise<Record<string, string>>
  // every project import, with the same dependency map; returns an unsubscribe function
  onImported(listener: (report: ProjectImportReport) => void): () => void
}

export interface WebShellContext {
  host: DclEditorHost
  // the in-browser build's files under editorBase, with the hashes they must match
  sceneCompiler: SceneCompilerFiles
}

export interface WebShell {
  shell: EditorShell
  projects: WebProjects
  // omitted: autosave, the script studio and asset import report "unavailable"
  dataLayer?: DataLayerClient
  // a project another account shared (its token from `?editor=copy-<token>`, shell/share.ts) copied in as a new one, or the copy
  // this device already made from it
  copyShared?: (token: string) => Promise<{ id: string; created: boolean }>
  // called on unmount, after the last save has been flushed
  dispose?: () => void
}

export type CreateWebShell = (context: WebShellContext) => WebShell
