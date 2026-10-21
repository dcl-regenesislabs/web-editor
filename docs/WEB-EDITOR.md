# The web editor

The scene editor in the browser: **Create** in the Decentraland web explorer opens it, the
creator builds a scene with the assistant, plays it (with an authoritative server when the
scene has one) and publishes it to a World. Start here; the other docs go deeper.

## Two repositories

| Repo | What lives there |
|---|---|
| `dcl-regenesislabs/bevy-editor` (this one, private) | The editor: UI (`packages/ui`), the in-engine editor scene (`packages/scene`), the web shell (`packages/web`), the project + assistant service (`packages/service`), the shared types (`packages/contract`). |
| `decentraland/bevy-explorer` (public) | The engine (Rust, wasm in the browser) and the web explorer (`react-web`). It hosts the editor: `react-web/src/features/editorHost` (the host contract, signing, the pin), the preview realm in the service worker (`deploy/web/PREVIEW_REALM.md`), and the headless scene server (`deploy/web/engine/headless.*`, `src/headless`). |

They meet at one contract, `window.__dclEditorHost` ([`HOST-CONTRACT.md`](./HOST-CONTRACT.md),
`packages/web/README.md`): the explorer gives the editor its services, signing, the engine
console and the preview server; the editor never holds a key.

**Fix things where they belong.** We own the engine, the explorer and the editor. When the
editor hits an engine or host limit, fix it in bevy-explorer with its own PR instead of working
around it here (example: tweens ignored Pause until the engine fixed it, bevy-explorer #1445).

## How a change reaches players

1. Editor PR merged to `main` here.
2. `web-package.yml` publishes `@dcl-regenesislabs/web-editor` to npm under `next`
   (version `0.1.1-<run>.commit-<sha>`).
3. Pin it in the explorer: `node packages/web/scripts/pin.mjs <version> decentraland.zone`
   prints `PINNED_EDITOR`; paste it into bevy-explorer's
   `react-web/src/features/editorHost/config.ts` and open a PR. The page checks `editor.js`
   against that hash, so nothing reaches players without this PR.
4. Merged to bevy-explorer `main`, CI publishes `@dcl-regenesislabs/bevy-explorer-web` and
   `https://decentraland.zone/bevy-web/` serves it a few minutes later. Check which commit is
   live: `curl -s https://decentraland.zone/bevy-web/ | grep -o 'commit-[0-9a-f]*' | head -1`.

The editor is offered only on `decentraland.zone` (the pin's `hosts`). `?baseDomain=decentraland.org`
on that page points the session, and the editor's Worlds server, at org.

## Develop locally (no Docker)

You need Node 24, git, and both repos side by side:

```
~/code/bevy-explorer
~/code/bevy-editor      (this repo)
```

1. **The engine.** It is Rust compiled to WebAssembly into `bevy-explorer/deploy/web/engine/pkg`
   (the engine) and `pkg-scene` (the scene runtime). The page loads it from that folder, so
   whichever way it got there, `dev:web` runs it. Pick one:

   **a. Not changing Rust: take the compiled one.** CI builds it and publishes all of
   `deploy/web`, wasm included, as `@dcl-regenesislabs/bevy-explorer-web`. Check out the commit it
   was built from (the `commit-<sha>` in its version) so the JS around it matches, then copy it in:

   ```bash
   cd ~/code/bevy-explorer
   v=$(npm view @dcl-regenesislabs/bevy-explorer-web dist-tags.next)   # e.g. 0.1.0-…commit-89156d6
   git checkout ${v##*commit-}
   mkdir -p /tmp/bew && npm pack @dcl-regenesislabs/bevy-explorer-web@$v --pack-destination /tmp/bew
   tar -xzf /tmp/bew/*.tgz -C /tmp/bew
   cp -R /tmp/bew/package/engine/pkg /tmp/bew/package/engine/pkg-scene deploy/web/engine/
   ```

   **b. Changing Rust: build it.** The same steps as CI (`.github/workflows/ci.yml`, "Build WASM
   package"), without the slow optimisation pass. Once:

   ```bash
   rustup toolchain install nightly-2026-04-15 --component rust-src --target wasm32-unknown-unknown
   cargo install wasm-pack --version 0.15.0
   ```

   Then after each Rust change, from `bevy-explorer` (the first build takes a while; after that
   about 4 minutes on an M-series Mac):

   ```bash
   export RUSTUP_TOOLCHAIN=nightly-2026-04-15
   wasm-pack build --target web --no-opt --out-dir ./deploy/web/engine/pkg --no-default-features --features="livekit,social"
   wasm-pack build crates/dcl_scene_wasm --target web --no-opt --out-dir ../../deploy/web/engine/pkg-scene --no-default-features
   npx --yes esbuild@0.28.1 ./deploy/web/engine/sandbox_worker.js --bundle --format=esm \
     --outfile=./deploy/web/engine/pkg/sandbox_worker.bundle.js
   ```

   Reload the page to run the new engine. Engine JS (`deploy/web/engine/*.js`) and the HUD
   (`react-web/src`) need no build: vite serves them live. Engine logic that doesn't need a
   browser is quicker to check natively: `cargo test -p <crate>`, `cargo clippy -p <crate>`.

   Either way, once: `cd react-web && npm install && (cd bridge-scene && npm install)`.

2. **Everything else, one command** (from this repo):

   ```bash
   npm install
   npm run dev:web -- --bevy ../bevy-explorer
   ```

   It builds the editor once and starts, as plain Node processes: the project service on `:8787`
   (data in `.data/service`), bevy-explorer's react-web dev server with this checkout as the editor,
   and the bridge scene on `:8100`. Open `http://localhost:5173/?editor`. Add `--world name.eth` for
   a stand-in Worlds server on `:8799` to test publishing, `--no-build` to skip the build.

3. **The assistant locally** uses your own Claude session, never an API key:

   ```bash
   node packages/service/scripts/assistant-login.ts --provider claude --auth .data/assistant/.auth.json
   npm run dev:web -- --bevy ../bevy-explorer --ai-auth .data/assistant/.auth.json
   ```

4. **After editing the editor:** `npm run build -w @dcl-editor/web`, then reload the page. A change
   under `packages/scene` (the in-engine editor scene) also needs
   `npm run export-static -w @dcl-editor/scene`; the web build leaves `dist/scene` alone.

5. **Preview ▸ As a phone** embeds the Decentraland mobile explorer in the editor's center at a
   1600×720 aspect ratio. The red, yellow and green window controls close, minimize/pause,
   and open in a tab or restore it to the editor. Hover or focus reveals the action labels.
   In another tab, the preview leaves the editor viewport and gizmos available at their normal
   frame rate; only the embedded preview caps the covered viewport at 5 FPS.
   **Minimize** pauses mobile rendering and scene processing, leaving a compact **Restore preview**
   bar while you edit. Restore keeps the same instance and player camera. Minimizing retains its
   memory; **Close preview** releases it. A screenshot briefly resumes a minimized preview and
   pauses it again afterward, keeping the same instance and camera.
   Moving restarts the preview; closing it or leaving the project releases its engine.
   Builds hot-reload the scene in either view. The runtime is a separately published npm package,
   `@dcl-regenesislabs/mobile-preview-runtime`; bevy-explorer does not serve or depend on it.
   `npm ci` installs the exact version pinned in `packages/mobile-preview/package.json`.
   `npm run dev:web` prepares the editor adapter and starts its server on **127.0.0.1:8788**, separate from the editor's
   localhost origin so runtime startup cannot block the editor's JavaScript thread.
   Production uses the editor service's `/mobile-preview/` endpoint. The service image installs
   the pinned npm package and verifies its artifacts; editor CI never clones or builds Godot.
   For runtime development, `MOBILE_PREVIEW_EXPORT=/path/to/build/web` overrides the installed
   runtime. Releases use npm OIDC in `dcl-regenesislabs/godot-web-preview`, which publishes a
   `next` snapshot on every push to its `main`; the editor requires no source token.
   See [runtime packaging](../packages/mobile-preview/README.md). A fetch bridge relays the active
   scene's HTTP requests through the editor, including requests from scene workers; lifecycle, hot reload and captures use scoped postMessage.
   The local launch skips lobby/account background work and surrounding terrain.
   The assistant's `view` tool accepts `target: 'mobile'` to photograph this preview.
   When the creator asks to see mobile UI, it can also open a closed preview with `openIfClosed: true`.
   Scene JavaScript runs in a web worker. Its system API bridge is still incomplete, including
   renderer RPC calls, so verify final gameplay in the native mobile app.

So one local page runs your editor, your explorer and your engine together: change any of the
three, rebuild that one (editor: `npm run build -w @dcl-editor/web`; engine: step 1b; explorer:
nothing) and reload.

Docker is for the deployed service only (below).

## Test

| What changed | Run |
|---|---|
| Anything here | `npm run validate` (typecheck + unit tests + build). Run vitest from the repo root: `npx vitest run packages/ui/...`; from inside `packages/ui` it has no DOM and the UI tests fail. |
| UI behavior | the flow by hand in `npm run dev:web`, and say what you checked in the PR |
| The host contract, preview realm, scene server | bevy-explorer's gates, real engine, headed: `WEB_EDITOR_DIR=../bevy-editor npx playwright test --config playwright.gate.config.ts [editor\|preview-realm]` from `react-web/` (`react-web/e2e/README.md`) |
| The explorer's editor host | `cd react-web && npx vitest run src/test/editorHost*.test.tsx && npx tsc -b` |
| The service | `npx vitest run packages/service`; against a running one, `scripts/session.ts` and `scripts/socket-idle.ts` |
| The assistant end to end | [`WEB-ASSISTANT.md`](./WEB-ASSISTANT.md), "Validation" |

The engine needs a real GPU: run gates headed. A Chrome tab in the background doesn't render it.

## The deployed project service

`https://web-editor-dev.dclregenesislabs.xyz`, a DigitalOcean droplet (`162.243.43.60`, 4 GB)
behind Cloudflare. It stores projects and runs the assistant on the team's Claude subscription.

- **Layout.** `/opt/dcl-editor` holds a copy of `package.json`, `package-lock.json`,
  `packages/contract` and `packages/service` (not a git checkout). The image
  `dcl-editor-service:local` is built there and run with `packages/service/compose.yaml` plus a
  `compose.override.yaml` that sets that image and `mem_limit: 2560m`.
- **Secrets** live in `/opt/dcl-editor/packages/service/.env` (mode 600). Never commit or print it.
  Production refuses to start without `ALLOWED_ORIGINS` (`https://decentraland.zone`), `PUBLIC_URL`,
  `TICKET_SECRET`, `WKC_METRICS_BEARER_TOKEN`, `STORAGE_WALLETS` and, with a model credential,
  `ASSISTANT_WALLETS` (both `*` here). The credential is `ANTHROPIC_OAUTH_SETUP_TOKEN` from
  `claude setup-token` (`sk-ant-oat…`); an empty `ANTHROPIC_OAUTH_SETUP_TOKEN=` line crashes startup.
- **Redeploy:** the image installs the pinned mobile runtime from npm and builds
  `packages/mobile-preview/dist` itself; it rejects missing runtime artifacts.

  ```bash
  rsync -a --delete package.json package-lock.json root@162.243.43.60:/opt/dcl-editor/
  rsync -a --delete --exclude .env --exclude compose.override.yaml --exclude node_modules --exclude dist packages/contract packages/service packages/mobile-preview root@162.243.43.60:/opt/dcl-editor/packages/
  ssh root@162.243.43.60 'cd /opt/dcl-editor && docker build -f packages/service/Dockerfile -t dcl-editor-service:local . \
    && cd packages/service && docker compose up -d && sleep 5 && curl -fsS http://127.0.0.1:8787/health/ready'
  ```

- **nginx** (`/etc/nginx/sites-available/dcl-editor`) comes from
  [`packages/service/deploy/nginx-site.conf.tmpl`](../packages/service/deploy/nginx-site.conf.tmpl)
  with `__HOST__` replaced: TLS, per-IP limits (10 req/s, 20 connections; the assistant 6 new
  sessions a minute, 4 at once), `/metrics` closed, sockets kept 15 minutes. The client IP comes
  from Cloudflare's header (`/etc/nginx/conf.d/cloudflare-real-ip.conf`, Cloudflare's published
  ranges), or every visitor would share Cloudflare's address and its limits.
- **Firewall:** ufw allows SSH, and 80/443 only from Cloudflare's ranges.
- **Cloudflare:** proxied, with a Configuration Rule setting SSL to **Full (strict)** for this
  hostname. The certificate is Let's Encrypt via certbot (auto-renews).

## Things we ran into

- **Engine writes take whole components.** `set_component` with a partial Transform fails with
  `missing field parent/rotation`: the editor completes assistant writes from the component's
  schema and merges a Transform over its current value.
- **Pause must reach everything that moves.** It freezes the scene; tweens kept running until the
  engine checked the freeze (bevy-explorer #1445). GLTF animations are still held editor-side
  (`scene/src/viewport/animation-hold.ts`). The scene server is not paused, by design.
- **The app runs in a frame without `localStorage`** (bevy-explorer's web shell): reading it
  throws. The identity comes from the shell (`getLogin()`), which also signs. The editor keeps its
  preferences in IndexedDB `dcl-editor-prefs`; `dcl-editor` belongs to the engine's `web_save.js`.
- **The scene server restarts on every build:** the editor calls `previewChanged()` after saving a
  bundle and the host coalesces restarts. It boots on the client's backends (`__bevyBootConfig`).
- **Services follow the session's base domain,** not the page's host; `?worldsServer=` is ignored
  for deployments so a link can't redirect them (bevy-explorer #1441).
- **A published link needs `&position=<base>`:** a World holds several scenes and otherwise
  lands on its spawn.
- **Cloudflare:** Flexible SSL loops with nginx's HTTPS redirect (use Strict); it closes sockets
  idle for 100 s, so the service pings assistant sockets every 30 s.
- **CI minutes:** this repo is private, so Actions are billed. When the org's limit is reached,
  jobs don't start ("recent account payments have failed or your spending limit…") and nothing
  publishes. The desktop builds (macOS 10×, Windows 2×) use most of it.
- **Line endings:** some bevy-explorer files are CRLF (`deploy/web/service_worker.js`,
  `sandbox_worker.js`). Keep them that way when editing.

## Open issues

- A second engine (the scene server frame) sometimes stalls at 95% in `navigator.gpu.requestAdapter()`.
- Strangers can appear at parcel 0,0 in a local preview: it still opens a global comms session.
- The service records nothing per assistant turn yet: no duration, tokens or failure data.
