# Testing

Three tiers, fastest to slowest. The first two are the everyday gate; the third
is corroborating evidence.

| Tier | Command | Speed | Needs | Is it the gate? |
|---|---|---|---|---|
| **Unit tests** | `npm test` | ~0.5s | nothing | part of the gate |
| **Validate** | `npm run validate` | ~30–60s | nothing (no engine/Electron) | **yes — run after every change** |
| **E2E (CDP)** | `npm run validate:e2e` | minutes | GPU + a test scene, macOS/Linux | no — corroborating |

`npm run validate` runs **typecheck → unit tests → build** in sequence and stops
at the first failure. If it's green, the tree is healthy.

---

## Unit tests (Vitest)

Pure logic — the functions that carry correctness risk and have no engine
dependency — is unit-tested with [Vitest](https://vitest.dev).

```bash
npm test               # run once
npm run test:watch     # watch mode while iterating
```

Current coverage (`packages/scene/src/*.test.ts`):

- **`world-pos`** — transform composition through parent chains, world↔local
  round-trips, `rootLocalForWorld`, the parent-cycle guard, and the
  missing-world-origin (entity 5) case.
- **`save-diff`** — `deepEqual` (including the float32-tolerance at every nesting
  level, which the save flow depends on) and the option-collapse helpers.
- **`composite`** — the authored-entity predicate (root + ≥512).

### Why these resolve under Vitest

The scene modules import `@dcl/sdk/math` and `@dcl/sdk/ecs`, which Vite resolves
the same way the UI build does. The tested functions never call `~system/*`
engine ops, so no engine/runtime is needed. The one dynamic `import('~system/...')`
in the scene is inside a function, so it doesn't run at module load.

### Writing a new unit test

1. Colocate it: `packages/scene/src/<module>.test.ts` (or `packages/ui/src/…`).
   `vitest.config.ts` includes `packages/**/src/**/*.test.ts`.
2. Test files are **excluded from the scene's production build/typecheck**
   (`tsconfig.json` `exclude`), so importing `vitest`/Vite types can't leak into
   the shipped bundle.
3. Keep tests pure — if a function needs `state` or engine ops, either inject a
   minimal fixture (see the `Snapshot` cast helper in `world-pos.test.ts`) or
   leave it for the e2e tier.

> Good first targets to grow coverage: `custom-components` codec round-trips,
> `schema` defaults/validation, and the `composite` builder.

---

## Validate (the gate)

```bash
npm run validate
```

Typecheck (all workspaces) + unit tests + full build (scene → ui → desktop).
Fast and hermetic — no engine, no Electron, no network. This is the contract:
**a change isn't done until `npm run validate` is green.**

---

## E2E / CDP harness

Launches the real desktop app and drives it over the Chrome DevTools Protocol.
Full reference (steps, requirements, how to extend) is in
[`AI-AGENT.md`](./AI-AGENT.md#part-2--the-cdp-end-to-end-harness). In short:

```bash
npm run validate:e2e                                    # full run
node packages/desktop/validate/validate.mjs --steps=boot,picker,engine,scene
BEVY_EDITOR_PROJECT=/path/to/scene node packages/desktop/validate/validate.mjs
npm run validate:auth -w @dcl-editor/desktop            # auth-server template probe
npm run build -w @dcl-editor/desktop && node packages/desktop/validate/probe-server-clock.mjs
npm run build -w @dcl-editor/desktop && node packages/desktop/validate/probe-tower.mjs
```

The auth probe (`validate/probe-auth-server.mjs`) creates a scene from the
blank template through the real shell API and checks what it produced:
`authoritativeMultiplayer` in scene.json, an exact per-commit auth-server SDK
pin in lockstep, and a scene that installs, builds and opens in the editor.
**Run it before advancing the template SDK pins.** It does not exercise the
multiplayer transport — the pin is taken on trust, so a pin whose runtime broke
still comes back green. The only real client→server→client round-trip is the
server-clock probe (`validate/probe-server-clock.mjs`), which places the
built-in Server Clock prefab and waits for the clock to leave its placeholder.

The tower probe (`validate/probe-tower.mjs`) is the acceptance test for the
whole facade: it materialises the Tower of Madness fixture — five kit prefabs,
eleven chunk prefabs, five creator scripts — into a real scene, and checks that
the module generates, the scene builds, a round starts, the seeded tower stacks
the chunks the seed asked for, a finish is validated in the game, and the board
updates. Everything from `round` on needs a Multiplayer Server, so a local run
reports those four as SKIP; `TOWER_PROBE_REQUIRE_SERVER=1` against a deployed
world holds the gate to the full set. `--emit <dir>` writes the scene without
booting Electron. The half of it that runs in CI is
`packages/desktop/src/tower-of-madness.test.ts`, which boots the same scripts
against the real `game` module under a mocked engine.

It needs a GPU (WebGPU engine), a test scene, and is macOS/Linux-only. It's
timing-sensitive: green is strong evidence, red means investigate — but the hard
requirement remains `npm run validate`.

## Custom model generation

The browser probe runs the actual modeling sandbox, GLB exporter, budget checks
and preview worker with a tree, rock, ceramic planter and curved wooden handle:

```bash
node packages/web/validate/model-building.mjs --out /tmp/model-building
# Or connect to an isolated Chromium session with remote debugging enabled:
node packages/web/validate/model-building.mjs --cdp http://localhost:9222 --out /tmp/model-building
```

The first form needs a Playwright-compatible Chromium installation. The second
opens and closes its own test tab, leaving the existing browser running. Inspect
`models.png` and the individual JPEG contact sheets for shape, material mapping
and detached parts. `models/` contains the exported GLBs and their shared images;
copy that whole directory into a test scene to inspect them in Bevy.

`report.json` records triangle/material/texture counts, GLB KB, script length,
geometry/export time and preview time. GLB size excludes shared texture files;
the timings use fixed scripts and do not measure assistant response time or
Bevy frame time. Studio lighting also differs from the scene's lighting.

The geometry unit tests cover outward-facing surfaces, directional UV preservation
through the production export passes, repeatable shapes, attached leaf bases,
and the default tree's triangle budget after two-sided leaves are expanded.

### Actual assistant turns in Bevy

`model-assistant.mjs` uses the production assistant provider, prompts and browser
tools. It creates a fresh temporary scene and conversation for each tree, chair,
shed and cartoon chest, then captures each result in Bevy at a fixed camera pose.
It needs an existing editor OAuth session, an isolated Chromium CDP endpoint and
an installed SDK7 scene to supply its dependencies. It uses that session's model
allowance. It does not send messages to another person.
Browser tools use the service's ordering: catalog searches may overlap; other
calls run sequentially so simultaneous script edits and rebuilds cannot race.

```bash
node packages/web/validate/model-assistant.mjs --auth /path/to/.auth.json --cdp http://localhost:9222 --sdk /path/to/installed-scene --variant baseline --baseline HEAD --out /tmp/model-turns
node packages/web/validate/model-assistant.mjs --auth /path/to/.auth.json --cdp http://localhost:9222 --sdk /path/to/installed-scene --variant current --out /tmp/model-turns
node packages/web/validate/model-report.mjs --baseline /tmp/model-turns/baseline --current /tmp/model-turns/current --out /tmp/model-comparison
```

Run the variants sequentially; they own local ports 3021, 8024 and 8025. Both
servers use `--bevy-web --no-browser`, plus `--no-client` where supported, so
starting SDK content servers cannot auto-launch the native Explorer. Check their
logs for the absence of `Desktop client:`. `--no-browser` alone is insufficient
with SDK versions that default to the native client.
Each temporary scene has a real `node_modules` directory containing links to the
dependency template. Some SDK versions reinstall when the directory itself is a
link and ignore `--skip-install` during `start`. The runner checks that the shared
packages remain linked after startup.

The baseline replaces the changed modeling and prompt modules with their contents
at `--baseline`, and hides the new modeling skill; it is not a whole-repository
checkout. `--cases tree,chair` selects cases. Output directories must be fresh.
`--build-only` prepares bundles without running a provider; `--skip-build` reuses
them only when sources have not changed.
`--effort low|medium|high` overrides reasoning only in the benchmark bundle;
omitting it uses the production setting. Each effort has a separate bundle, and
`turn.json` records the actual setting. Keep code, model, prompts and source the
same when comparing effort, alternate the run order, and inspect every result in
Bevy before accepting a faster setting. This flag does not change the editor default.
`--source code` (the default) requests a generated model; `--source catalog`
requests an existing asset, and `--source auto` lets the assistant choose. Use a
fresh output directory for each source. Comparisons between sources measure
different workflows; baseline/current speed comparisons must keep the source and
prompt identical. Catalog downloads use the desktop host's existing CDN proxy.
`--follow-up "Make the generated model 20% taller by editing its saved script; keep its width, depth, position and materials."`
runs another provider turn against the finished scene and records its time, tools
and screenshot under `revision/`. This turn starts from the current project context,
without the first conversation's history. Its model files remain in the parent `project/`.

Each `turn.json` records total prompt-to-answer time, first saved model time,
whether each placement was generated or imported, generated code, tool errors,
rebuilds and usage. A turn that ends without placing a model fails the run.
`bevy.png` uses the same case camera
for both variants; `frames.json` samples engine heartbeats for five seconds after
the turn. Frame intervals measure the whole capped scene, not isolated model GPU
cost. `index.html` in the comparison directory puts images beside time and size
measurements, including shared texture bytes. Single runs reveal failures and
quality differences; repeated interleaved runs are needed for a speed claim.
