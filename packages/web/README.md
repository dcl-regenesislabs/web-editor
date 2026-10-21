# @dcl-editor/web

The editor for a page that already runs the engine (bevy-web). The desktop app puts the
editor UI in the outer document and the engine in an iframe; here the engine's page is
the outer document and loads the editor as one ES module.

```bash
npm run build -w @dcl-editor/web      # writes dist/ (gitignored); also builds @dcl-editor/scene-compiler
npm run validate:assistant -w @dcl-editor/web # Chromium: browser tools, memory restoration and New chat
npm run validate -w @dcl-editor/web   # build + headless Chromium smoke against a fake host:
                                      # the Create page's scene list (mountHome); a starter scene is
                                      # created, built and published in the page, opened in the docked
                                      # editor, left for the list (host.openCreatePage) and host.exit();
                                      # exported and imported as a .zip, and, signed in against an
                                      # in-memory project service, opened in a second browser context;
                                      # the assistant reads, edits and builds through browser tools;
                                      # encrypted memory survives a service restart, and New chat
                                      # removes it and its browser key from both assistant layouts;
                                      # a .zip that asks npm for a package is imported against a fixture
                                      # registry and rebuilt with the registry unreachable; a scene is
                                      # published to the fake Worlds server, signed outside the page
node packages/web/validate/fake-worlds-server.mjs --port 8799 --world my.dcl.eth=0x<owner>
                                      # the fake Worlds content server on its own (see Publish)
```

| In `dist/` | What |
|---|---|
| `editor.js` | The editor UI (ESM, React 18 inside). Every URL it uses is relative to itself. |
| `editor.css` | The UI font's `@font-face` rules, with the font files inlined. `editor.js` links it itself, with its hash. |
| `scene-compiler/` | `index.js`, `worker.js`, `esbuild.wasm`, `sdk-snapshot.json` from `@dcl-editor/scene-compiler`. |
| `prefabs/` | The desktop app's built-in prefabs (`packages/desktop/prefabs/`) and `catalog.json`: each folder's `data.json` and every file's sha384. `editor.js` holds the catalog's hash, the catalog every file's. |
| `scene/` | The editor scene's static export. Not written by this build, and kept across builds. |

Serve the directory as it is; the host page decides where (`editorBase`).

To run it hosted in bevy-explorer's HUD with a local project service: `npm run dev:web` from the
repository root (see CONTRIBUTING.md). It exports the editor scene once (its `about` names no
host, so the same export works on any port), builds this package, and starts the service and
bevy-explorer's `react-web` dev server with `WEB_EDITOR_DIR` set. The end-to-end checks in the
real engine are that repo's gates (`react-web/e2e/*.gate.spec.ts`, `react-web/e2e/README.md`):
the host contract and the preview realm.

## Host contract (v0, v1 and v1.1)

The page sets `window.__dclEditorHost` (`DclEditorHostV0` or `DclEditorHostV1`, in
`packages/ui/src/engine/hosted.ts`) and then adds `<script type="module" src="<editorBase>editor.js">`.
The module mounts nothing by itself. It sets:

```ts
window.__dclEditor = {
  // the Create page's body: the scene list, in the HUD's look. Returns the unmount
  // the page calls when it closes.
  mountHome(el: HTMLElement, api: { close(): void }): () => void
  unmount(): void // remove everything, give the HUD back (host.setMode('off')); what exit() calls
}
```

- **The Create page** (`packages/ui/src/features/home/CreateHome.tsx`): Your scenes and Trash,
  Import, New scene, the scene cards (sync state, the world it publishes to) and their menu. It
  renders in a shadow root under `el` and reads the HUD's `--brand`, `--accent`, `--text`,
  `--font-family` and radii where they inherit, with the HUD's values as fallbacks. The page
  shell scales it; it does not scale itself.
- **Opening a scene** calls `api.close()`, then mounts the docked editor into `host.container`
  (a shadow root; the root is `pointer-events: none`, panels opt in, so a click between panels
  reaches the canvas below). It is the desktop editor; hosted it differs only where the browser
  or the host decides: no sign-in, Alt for the tool keys, no mute (the HUD owns the volume), the
  HUD draws the reticle, the sync chip, and no entry point for what has no backend here.
- **Back to scenes** in the editor sets the mode to `'off'` and calls `host.openCreatePage()`
  (v1.1; a host without it gets `exit()`). **Back to Decentraland**, in the editor's menu, is
  `host.exit()`. The page closing only unmounts the list.

What the editor asks of the host:

- `engineConsole(line)` for every console command. A scene is always reloaded by its hash.
- `openPreview(previewId, position)` then `spawnEditorScene()` each time a project is opened.
  `previewId` is a random `p` + 32 hex id kept with the project, not its name, so no other scene
  can find an unpublished build. Leaving a scene, or a change of account, clears the preview cache.
  The host may answer `spawnEditorScene()` with the instance it already spawned: the editor
  then restarts it itself (`/reload <hash>`), because the scene picks its edit target as it boots.
  The host spawns the package's scene from bytes it checked against their hashes and serves from
  its own page (`<PAGE_DIR>editor-scene/<entityId>`), not from the package's host.
- `setMode('edit')` while a scene is open and paused, `'play'` while it runs, `'off'` when it
  leaves the scene or unmounts. The Create page changes no mode.
- `identity()` for the account it shows, and for whose copy the projects are compared with. It
  has no sign-in or sign-out of its own, and by design never reads the stored identity or signs
  itself. That is policy, not isolation: `editor.js` runs in the page's realm, so the host
  trusts it as it trusts its own code, enforced by the pinned version, SRI and review.
- v1 only: `openProject` (the id from `?editor=<id>`) is opened by the first `mountHome` of the
  page; an id that is neither on this device nor on the account stays on the list with one line.
  `services.projects` and `signedFetch(url, init)` carry every request to the project-storage
  service. A v0 host, a guest, or `services.projects: null` means the projects stay local.
- v1 only: `services.worldsContent` and `signDeployment(request)` are what publishing needs.
  A v0 host has no Publish entry point; a guest on a v1 host is told to sign in.
- `openCreatePage()` (v1.1) and `exit()`, as above.
- `busSession`: the page side of the editor bus is `dcl-editor-bus#<busSession>`.

## The shell

`src/shell/index.ts` exports `createWebShell` (`src/seam.ts` has the types and the rules).
Its `shell` is the editor's backend, the same `EditorShell` the desktop app provides over IPC,
and its `dataLayer` is the open project's files.

- **Projects** (`src/store/`) live in the Origin Private File System: `dcl-editor/projects/<id>/`
  and an index, `dcl-editor/index.json`. `node_modules/`, `bin/`, `.git/` and `.env*` files are
  never kept. One tab at a time holds a project (Web Locks); a second tab is told so.
  Ids are the name's slug plus a random four-character tail, so two devices never make the
  same id. Delete marks the project in the index and offers Undo; the Create page lists it
  under Trash with the days it has left and Restore, and it is removed for good 30 days later.
- **New scene** copies a starter shipped in the bundle (the desktop app's `templates/`).
- **Prefab library** (`src/shell/prefab-library.ts`, `builtin-prefabs.ts`): the built-ins from
  `prefabs/`, each file fetched against its hash. Placing one copies it into the open project's
  `custom/<slug>/` as the desktop app does: one copy per prefab id, `~runtime/` imports resolved,
  and an update that keeps the creator's own files. Built-ins are read-only. Signed in on a host
  with a project service, **My library** (`src/shell/user-prefabs.ts`) is the wallet's own, kept
  by the service (`/prefabs`) under the same signed fetch and quota as its projects; a guest is
  told to sign in for it.
- **Import / export** (`src/archive/`, `src/shell/archive.ts`): a project leaves as a `.zip` of its
  source files and comes in from a `.zip` or, where the browser has `showDirectoryPicker`, a
  folder. An import never opens `node_modules/`, `bin/`, `.git/` or `.env*`, needs a `scene.json`
  with its parcels, and reports what the editor cannot do with the project: a `server/` folder,
  a scene that is not SDK7, and the `package.json` dependencies the bundled SDK does not provide
  (`ProjectImportReport.needsPackages`). Zip files are read and written with the browser's own
  deflate; zip64 and encrypted archives are refused, and so is a zip whose directory points two
  files at the same bytes. An import past the service's limits (2000 files, 50 MB a file,
  500 MB in all) is refused before anything is inflated.
- **Build and preview** (`src/shell/preview.ts`): opening a project, and every file written
  after that, runs `@dcl-editor/scene-compiler` and `publishPreview` with this browser's machine id
  (`localStorage` `dcl-editor.machineId`). The shell never reloads the scene: the editor does,
  always by the scene's id, on Play, on Stop and on a save in the code editor.
- **Build reports** go to the editor as typed `SceneBuildEvent`s (`onBuildEvent`), which drive
  the error banner and Play's wait for a rebuild. The `onStackLog` lines are only displayed.
- **The in-tab server copy** of an authoritative scene (`src/shell/server-logs.ts`): while a
  project is open the shell polls `scene_logs 200 --server` through `host.engineConsole` and
  relays each new line once on `onStackLog`, so the Game tab shows its `[server]` lines as it does
  desktop's Multiplayer Server output; an engine without a server copy rejects the command and
  nothing is relayed. The logs drawer's Storage tab reads and writes the scene data the copy keeps
  at the preview realm's own storage routes (`<realm>/values`, `<realm>/players/<address>/values`,
  the shape `sdk-commands start` serves), through the host's `previewStorageFetch(path, init)`:
  the page's service worker answers them only with the server copy's token, which the host adds
  and never hands over. Env keys never take a preview scope.

- **npm packages** (`src/shell/packages.ts`, `src/store/package-store.ts`): see Packages.
- **Publish** (`src/publish/`): see Publish.
- **Assistant** (`src/ai/`): see Assistant.

The phone preview (`src/shell/phone-preview.ts`) loads the separate
[`mobile-preview-runtime`](../mobile-preview/README.md) npm package from the editor service's
`/mobile-preview/` endpoint, or the editor's standalone server on `127.0.0.1:8788` in development.
Its own origin isolates startup. `phone-preview-transport.ts` relays browser-local realm requests,
hot reload, lifecycle and captures with origin/window/session/instance checks. Closing the project
disposes the preview. The explorer has no runtime package or mobile hosting configuration.
Minimizing keeps the iframe mounted and sends a visibility message to pause its engine;
restoring resumes it without reloading. The minimized preview retains memory and rejects captures.

Left undefined, so the editor hides the entry point: updates, physical-phone QR and desktop-client
previews, and prefab imports (folder, zip, GitHub).

`createWebShell` also returns `projects` (`WebProjects` in `src/seam.ts`), for the parts of the
web target that are not the editor's backend: a project's files, their content-hash manifest, a
build of it (`{ production: true }` for a deployment), its dependencies outside the bundled SDK,
and a subscription to imports.

## Assistant

On a v1 host with `services.projects`, the chat uses the Node service's optional
assistant backend. The browser owns the files and executes read, revision-checked
source edits, scene actions and builds. The service runs pi with Claude/Codex OAuth
and streams responses through an authenticated WebSocket; it needs no server copy
of the working project. Project/account changes, Stop and disconnects cancel the
conversation. Account sync remains independent. The panel shows only once the service
says the signed-in account may use it: a guest, a host without the backend, or a wallet
outside `ASSISTANT_WALLETS` sees no assistant (the Studio stays as the code editor).

Enable the service with `ANTHROPIC_OAUTH_SETUP_TOKEN` or `--ai-auth <oauth-file>`.
See [Web assistant](../../docs/WEB-ASSISTANT.md) for sign-in, deployment, tools and
tests. `ASSISTANT_LIVE_AUTH=<oauth-file> node packages/web/validate/smoke.mjs` runs
the browser check with a real model; the normal smoke uses a deterministic agent.

## Sync

`src/sync/` copies projects to the signed-in wallet's private storage on the project service
and back. The project in the browser is the working copy and nothing waits for the network.

- Per project it keeps `{ wallet, baseVersion, base, pending }` in `dcl-editor/sync/<id>.json`:
  the manifest last agreed with the service and the paths written since. A push hashes only
  those paths (`@dcl-editor/contract/cid`: the Decentraland content hash, the same one a deployment uses), asks
  which blobs the service lacks, uploads them, and writes the manifest last against
  `baseVersion`. Pushes run 2 s after the last write, when a project closes and when the tab is
  hidden.
- The Create page compares the list with the account: a scene only there is listed and is
  downloaded when opened; one that is behind and unchanged here is brought up to date; one
  never copied is copied. Opening a project asks for its manifest first and waits at most 4 s.
- When both sides changed (the manifest write answers 409, or the comparison finds both moved)
  nothing is merged and nothing here is replaced. The scene is marked `conflict` and the
  creator chooses: keep both (this device's version becomes a new scene named
  "<title> (copy, <date time>)"), keep this device's, or use the other one. Until then it is
  not synced. A scene never synced from here whose id the account already uses is the
  `unrelated` variant: only keep both is offered.
- Trash and restore are the service's soft delete and restore. A scene deleted on another
  device goes to the trash here, unless it was edited here since.
- A request that fails for want of a network is retried after 2, 4, 8 … 60 s and when the
  browser comes back online; what the service refuses (quota, a file too large) is shown in
  words and not retried until the project changes. The Create page shows the account's
  storage use from the list; trashed scenes count until they are deleted for good.
- A project copied under one wallet is never pushed to another: signed in as someone else it
  stays local.

`fake-service.ts` is the service in memory, written from the contract; the unit tests and the
smoke use it. The real one is `packages/service`.

## Packages

What a project's `package.json` asks of npm is resolved by `@dcl-editor/scene-compiler`
(`resolveDependencies`) when the project is opened, when it is imported, and when `package.json`
is saved. Each tarball is checked against its sha512, unpacked, and never run.

- The **lock file**, `dcl-editor.lock.json`, is one of the project's files: it is synced to the
  account, exported in the `.zip`, and never deployed. It names every package version, its
  tarball and its integrity.
- The **package files** live in `dcl-editor/packages/<name@version>/` in the Origin Private File
  System, shared by the projects of this device. They are not project files: not synced (the
  account's quota is for scenes, and any device can download the same bytes again and check
  them against the lock), not exported, not deployed. Packages no lock names any more are
  removed when the trash is purged.
- A project whose lock fits `package.json` and whose packages are stored asks the registry for
  nothing, so it builds with no network. On a device that has the lock and not the files they
  are downloaded once, which needs the registry.
- The build log and the import dialog show the download, what was frozen, and the resolver's
  warnings (install scripts that are not run, native code, Node built-ins).

Not done: the code editor's type checker does not read the packages, so an import of one is
underlined there although the build resolves it.

## Publish

On a v1 host the shell publishes a scene to a World by itself (`shell.publishScene`), with no
CLI and no linker page:

1. `worldConfiguration.name` is written to the project's `scene.json` (this is also how the
   next publish remembers the world).
2. A production build (`build(files, { production: true })`), with the project's frozen packages.
3. The entity (`publish/entity.ts`), as `sdk-commands deploy` builds it: the project's files and
   the build's, minus `.dclignore` and sdk-commands' own ignore list (sources, `package.json`,
   dot files, …) and minus the package lock; each named by its Decentraland content hash
   (`@dcl-editor/contract/cid`); the entity file `{ version, type, pointers, timestamp, content, metadata }`
   with `metadata = { sdkVersion, ...scene.json }`; the entity id is the hash of that file.
   What sdk-commands and the server would refuse (parcels, base, thumbnail, a file over 50 MB,
   two names differing only in capitals) is said before anything is signed.
4. `host.signDeployment({ world, entityId, title, fileCount, bytes })`: the host page shows its
   own confirmation and signs. The editor holds no key.
5. `GET <worldsContent>/available-content?cid=…` to leave out files the server already stores,
   then one multipart `POST <worldsContent>/entities`: `entityId`,
   `authChain[i][type|payload|signature]`, and one part per hash (the entity file always).
   A network failure, a 5xx, 408 or 429 is tried three times; a refusal is not, and is put
   in words (`publish/errors.ts`).
6. The publish is recorded on the project (`published` in the index) and the dialog shows the
   page's own url with `realm=<world>`.

The worlds offered are read without a signature (`publish/worlds.ts`): the wallet's NAMEs from
the catalyst (`/lambdas/users/<wallet>/names`) and `GET <worldsContent>/worlds?authorized_deployer=<wallet>`,
which also lists the worlds of others the wallet may deploy to.

`validate/fake-worlds-server.mjs` is that server in memory for the tests and the gate. It checks
a deployment in the real server's order and with its sentences (entity id = hash of the entity
file, every content hash uploaded or stored and matching its bytes, the auth chain valid for the
entity id with `@dcl/crypto`, pointers = `scene.parcels`, the world named and the signer allowed
on it, the five-minute window, size and parcel limits) and then serves `/world/<name>/about`,
`/contents/<hash>`, `/entities/active`, `/world/<name>/scenes`, `/world/<name>/permissions`,
`/worlds`, `/available-content`. `--world name=0x<owner>` says who owns a name,
`--allow name=0x<wallet>` adds a deployer, `--claim name` gives it to the first wallet that
deploys. Its comms adapter is `offline:offline`.

Over plain http, name a local server's world without `.dcl.eth` (`--claim gate.eth`) if an
explorer is to enter it: the engine reads a realm url that ends in `.dcl.eth` and is not https as
a world name on Decentraland's own server, so the url the publish dialog shows for such a world
does not open.

## Keys

In a browser tab Cmd/Ctrl+W, +Q and +R close the tab, quit and reload, so hosted the tool
keys are Alt+Q/W/E/R, focus is Alt+F, mute is Alt+M and the Studio's close-tab is Alt+W.
The `?` list shows the keys that apply. Editor chords pressed with the viewport focused are
kept from the engine's canvas.
While a scene is open the tab asks before it closes or reloads, and F5 and Ctrl/Cmd+S never
reach the browser, from a text field either. Tab pressed on the engine's canvas moves focus
back into the editor.

## Served from a CDN

Releases are served from jsDelivr (see Releasing). What the bundle does for any CDN: every URL is relative to `editor.js`
or built from `host.editorBase`. What the CDN has to provide: CORS headers for every file
(each is fetched in `cors` mode).

**Integrity.** The host's integrity hash covers `editor.js` only; `editor.js` covers the rest.
`scripts/build.mjs` writes a sha384 of every other file the package fetches into `editor.js`
(`scene-compiler/worker.js`, `scene-compiler/esbuild.wasm`, `scene-compiler/sdk-snapshot.json`,
`editor.css`) and checks the written `dist/` against it. At run time (`src/workers.ts`,
`scene-compiler/src/verified-fetch.ts`) each is fetched with that `integrity`: the build worker
starts from a same-origin blob of the checked text, the wasm is compiled from the checked
bytes, and the stylesheet link carries `integrity` and `crossorigin`. A file that does not
match is refused with an error that names it (the smoke flips one byte of `worker.js` to see
it). The fonts are inlined into `editor.css`, since a CSS `url()` cannot carry a hash, and the
build refuses a separate chunk or asset, since a lazy `import()` could not either.
Not covered here: `scene-compiler/index.js` (shipped, never fetched by the editor) and `scene/`,
the editor scene the engine loads. Pinning that one is the host's side (bevy-web's
`PINNED_EDITOR`).

## Releasing

CI (`.github/workflows/web-package.yml`) publishes `dist/` as the npm package
`@dcl-regenesislabs/web-editor`: an oddish snapshot on `next` for every `main` push, and the
chosen ref on `latest` for a manual dispatch. The explorer loads it by exact version from
jsDelivr (`https://cdn.jsdelivr.net/npm/@dcl-regenesislabs/web-editor@<version>/`, which sends the
CORS and `Cross-Origin-Resource-Policy` headers the cross-origin isolated page needs) and checks
`editor.js` against a pinned hash, so a version reaches players only through an explorer PR:

```bash
node packages/web/scripts/pin.mjs <version> decentraland.zone   # prints PINNED_EDITOR
```

Paste its output into bevy-explorer's `react-web/src/features/editorHost/config.ts`. To check a
local build first: `npm run build -w @dcl-editor/web && node packages/web/scripts/package-dist.mjs`,
serve `packages/web/dist`, and pass `--base <that url>`.

The first publish of the name is manual (npm attaches a trusted publisher only to an existing
package): `npm publish --access public` in `packages/web/dist`, then add this repository and
workflow as the package's trusted publisher on npmjs.com. Later publishes need no token.
