# Editor host contract v1 (bevy-web <-> editor package)

v0 is implemented in bevy-explorer (react-web/src/features/editorHost/host/host.ts) and here (packages/ui/src/engine/hosted.ts, packages/web/README.md). v1 = v0 plus the following. Both sides implement exactly this; deviations must be reported loudly.

## Entering and leaving
- The editor is AVAILABLE when the page is on an allowed host and an editor package source exists (loopback: `<PAGE_DIR>editor/`; decentraland.zone: the pinned CDN package, currently none). Availability never downloads anything.
- The editor OPENS (host object published, script tag added) when the player clicks a Create entry point in the HUD (menu top bar item + sidebar rail icon), or automatically once in-world when the entry url has `?editor`. `?editor=<projectId>` asks the editor to open that project directly (host passes it as `host.openProject`).
- Re-entering after exit(): bevy-web calls `window.__dclEditor.mount()` (the module script only runs once per page).
- exit(): unmount, kill the editor scene, clear the inspection pin (`/set_scene` with no argument), restore the clock the player had, restore the HUD, travel back.

## New members on window.__dclEditorHost (version: 1)
```ts
interface DclEditorHostV1 extends DclEditorHostV0 {
  version: 1
  /** project id from `?editor=<id>`, or null */
  openProject: string | null
  services: {
    /** base url (no trailing slash) of the private project-storage service; null = sync unavailable */
    projects: string | null
    /** base url of the Worlds content server deployments go to */
    worldsContent: string
  }
  /** fetch `url` (must start with services.projects) signed as the signed-in wallet (Decentraland signed fetch, ADR-44 headers:
   *  x-identity-auth-chain-<n>, x-identity-timestamp, x-identity-metadata). The HOST fixes the metadata:
   *  { intent: 'dcl:editor:projects', signer: 'dcl:editor', origin: location.origin }. The editor cannot change it.
   *  Rejects with Error('not-signed-in') for a guest, Error('not-allowed') for any other url. */
  signedFetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: BodyInit | null }): Promise<Response>
  /** Sign a Worlds deployment. The HOST shows its own confirmation dialog (world name, title, file count, size) and only then
   *  signs `entityId` with the wallet's identity. Resolves with the auth chain to send with the deployment.
   *  Rejects with Error('cancelled') when declined, Error('not-signed-in') for a guest. */
  signDeployment(request: { world: string; entityId: string; title: string; fileCount: number; bytes: number }): Promise<Array<{ type: string; payload: string; signature: string }>>
}
```
Rules:
- The host API never hands the identity (the ephemeral key) to the editor, and the editor package by policy never reads localStorage identity entries or signs. This is policy, not isolation: `editor.js` runs in the page's realm and is trusted like the HUD bundle, enforced by the pinned version, SRI and review.
- Signing code must not grow the normal HUD bundle: it loads only when the editor opens (no dynamic import(); a separate same-origin script built by react-web and added with a script tag is fine).
- Signed payload for signedFetch (ADR-44): `${method}:${path}:${timestamp}:${metadataJson}` lowercased, where timestamp is ms since epoch as a string. `path` is the pathname plus the query (`search`) for `services.projects`, and the pathname only (no query) for `services.signed` (v1.2), the rule the desktop signer uses in production.

## v1.2 (still `version: 1`, additive)
```ts
services.signed?: { worldsContent: string; commsGatekeeper: string; storage: string; creatorsData: string; multiplayer: string }
signedFetch(url, init?: { method?; headers?; body?; metadata?: Record<string, unknown>; signal?: AbortSignal }): Promise<Response>
```
- `services.signed` is present only when `services.worldsContent` is exactly `https://worlds-content-server.decentraland.zone` or `.org` (trailing slash ignored): that environment's `https://comms-gatekeeper.decentraland.<tld>`, `https://storage.decentraland.<tld>`, `https://multiplayer-server.decentraland.<tld>`, and always `https://creators-data.decentraland.org/v2`. Absent for loopback or overridden Worlds servers. Its presence is the capability flag.
- `services.projects` urls: unchanged (fixed editor metadata, pathname + query signed, `init.metadata` ignored).
- `services.signed` urls (same under-the-base check as projects; userinfo, other ports and other hosts are refused): metadata = `JSON.stringify(init.metadata ?? {})`, pathname only signed. Refused with `not-allowed` when, after lowercasing the metadata JSON as the payload is signed, `signer === 'dcl:editor'` or `intent` starts with `dcl:editor:`.
- Methods: worldsContent GET/PUT/DELETE; commsGatekeeper and storage GET/POST/PUT/DELETE; creatorsData POST; multiplayer GET of `/logs` only. Anything else: `not-allowed`.
- `DELETE {worldsContent}/world/<name>/scenes/<coord>` (undeploy one scene) and `DELETE {worldsContent}/entities/<name>` (undeploy the whole world; case and a trailing slash ignored on both) ask the player in the page first (world, parcel or "All scenes", server, wallet) and reject `cancelled` when declined. Aborting `signal` while the dialog is open closes it and rejects with the abort reason; nothing is signed.
- Header allow-list: `accept`, `content-type`, `if-match`, `if-none-match`, `x-confirm-delete-all`. `body` (string, FormData, Blob) passes through untouched (no content-type added); `signal` is forwarded to fetch.
- Guests: `not-signed-in`, as before.

## Viewport activity (still `version: 1`, additive)

`setViewportActive?(active: boolean): void` reduces the engine to at most 5 FPS while another
preview covers the editor viewport. Editing and console requests remain available. Restoring
activity uses the current graphics setting; the temporary cap never writes that setting.
The editor restores activity on preview close/unmount or pop-out to another tab; the host also restores it on exit.
Older hosts can omit this method. Hidden browser tabs are throttled independently by the engine.

## The project-storage service (packages/service)
- Rejects any request whose metadata has `signer === 'decentraland-kernel-scene'` (or a sceneId), or whose `intent !== 'dcl:editor:projects'`; timestamp window 5 minutes; Origin allowlist.
- API (all under the base url, all signed, wallet = the auth chain's owner, lowercased):
  - `GET /projects` -> `{ projects: [{ id, name, version, updatedAt, bytes, deletedAt? }] }`
  - `GET /projects/:id/manifest` -> `{ id, name, version, updatedAt, files: { [path]: { hash, size } } }` (404 when none)
  - `POST /projects/:id/uploads` `{ files: [{ hash, size }] }` -> `{ uploads: [{ hash, url, method: 'PUT', headers }] }` only for blobs this wallet has not stored
  - PUT each blob to its url (the service or the bucket verifies the bytes match the hash)
  - `PUT /projects/:id/manifest` `{ name, files, baseVersion }` with `baseVersion: null` to create -> `{ version }`; 409/412 `{ version, updatedAt }` when baseVersion is stale; 422 when a referenced blob is missing for this wallet
  - `GET /projects/:id/files/:hash` -> the blob (only hashes in that wallet's manifests)
  - `DELETE /projects/:id` -> soft delete (kept 30 days); `POST /projects/:id/restore`
- `hash` is the Decentraland content hash a Worlds deployment uses (hashV1: `bafkrei…` up to 262,144 bytes, `bafybei…` above), so files are hashed once.
- Order: content first, manifest last. Project ids match `/^[a-z0-9][a-z0-9-]{0,63}$/`.
