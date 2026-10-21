# Mobile preview hosting

`@dcl-editor/mobile-preview` is the editor's private hosting and transport adapter.
It depends on an exact npm version of `@dcl-regenesislabs/mobile-preview-runtime`,
published by [godot-web-preview](https://github.com/dcl-regenesislabs/godot-web-preview)
using npm OIDC: every push to its `main` publishes a `next` snapshot versioned
`0.1.0-<run id>.commit-<sha>`.
The editor never clones or builds Godot source and needs no source-access token.
bevy-explorer has no mobile runtime dependency or configuration.

After `npm ci`, prepare and serve the installed runtime:

```sh
npm run build -w @dcl-editor/mobile-preview
npm run serve -w @dcl-editor/mobile-preview
```

`npm run dev:web` prepares and starts this server automatically at
`http://127.0.0.1:8788/mobile-preview/`. The loopback IP differs from the editor's
`localhost` site to isolate startup. The service image installs the same pinned
package, verifies its size/SHA-256 manifest, adds the editor transport and serves
it at `/mobile-preview/`. Generated files stay out of Git and Docker's build context.

For local runtime development, pass an exported directory to the build command or
set `MOBILE_PREVIEW_EXPORT=/path/to/mobile/build/web` before `npm run dev:web`.
This explicit development override bypasses npm; normal installs and CI use npm.

To adopt the newest snapshot while retaining an exact version and lockfile integrity:

```sh
v=$(npm view @dcl-regenesislabs/mobile-preview-runtime dist-tags.next)
npm install --save-exact @dcl-regenesislabs/mobile-preview-runtime@$v -w @dcl-editor/mobile-preview --ignore-scripts --no-audit
```

Review and commit the package/lockfile changes together; the lock entry must carry
npm's integrity for the registry tarball. Do not use `latest`: it still points at the
bootstrap placeholder until the runtime ships a stable tag. Runtime releases and npm
trusted-publisher setup live in the source repository. Local validation can use the
source repository's packed tarball.

The runtime requires HTTPS or loopback, WebGPU and the isolation headers provided
by this server. Its fetch bridge relays only active-scene metadata, content and
active-entity lookups; environment variables and server storage are inaccessible.
Messages are scoped to the runtime origin, editor window, session and instance.
The runtime bundles its browser networking assets and signs its own guest connection
to the preview scene room. The editor keeps the authoritative server running while
the mobile preview is focused. No wallet credentials cross the relay. Requests expire after 30 seconds, with a
1 MiB request limit, 4 MiB JSON limit and 64 MiB total buffered response budget.
Player presence and movement use the runtime's bundled Pulse WebTransport bridge;
the scene server and preview derive the same realm from the original scene ID.

Screenshots copy the canvas after GPU submission. Scene reload, capture and
visibility messages use the same connection in embedded and detached modes.
Minimize/restore retains the instance and its memory; moving or closing requires
a fresh engine next time. Pausing stops scene processing and GPU rendering;
closing releases the frame and workers. Cold startup and Wasm allocation remain.

To validate, open **Preview → As a phone**, confirm grass and touch controls,
minimize/restore, then move it to a tab. Capture both views. Drag an entity in the
editor, confirm the mobile scene reloads, then undo. Minimize/restore should retain
the instance URL; closing should remove its iframe and workers.
