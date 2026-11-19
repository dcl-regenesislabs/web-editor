---
name: verify
description: Prove a change to the web editor works by running the real thing - the validate gate, then the editor and its 3D view in a browser on a hardware GPU, with screenshots. Use before reporting any change done, when asked to verify, check, test or reproduce something in the editor, and when reviewing a change someone else made.
---

# Verify a change in the web editor

A change is not done because the code reads right or the unit tests pass. It is done when the
gate is green **and** you have looked at the affected screen in the running editor. Report what
you ran and what you saw; say plainly what you did not check.

## 1. The gate

```bash
npm install
npm run validate        # lint, typecheck, unit tests, build. Must pass.
```

Run `npm run validate:e2e` as well when the change touches runtime behaviour and the machine
can run it. Node must be 24 or another even release (`validate` refuses odd ones). A failing
or flaky test is fixed or removed, never retried until it passes.

## 2. Start the editor with its 3D view

The 3D view is the Bevy explorer from `decentraland/dcl-one`. Its engine comes prebuilt from
npm; do not compile Rust for an editor change. Keep the explorer checkout outside this
repository. From a fresh machine, in order:

```bash
# the explorer at the commit the published engine was built from, and the engine itself
mkdir -p /tmp/ext && cd /tmp/ext
v=$(npm view @dcl-regenesislabs/bevy-explorer-web dist-tags.next)
git clone https://github.com/decentraland/dcl-one dcl-one
cd dcl-one && git checkout "${v##*commit-}"
mkdir -p /tmp/bew && npm pack "@dcl-regenesislabs/bevy-explorer-web@$v" --pack-destination /tmp/bew
tar -xzf /tmp/bew/*.tgz -C /tmp/bew
mkdir -p rendering/bevy-explorer/source/deploy/web/engine
cp -R /tmp/bew/package/engine/pkg /tmp/bew/package/engine/pkg-scene rendering/bevy-explorer/source/deploy/web/engine/

# the explorer's HUD and bridge scene: pnpm, not npm (npm fails on its workspace: dependencies)
cd rendering/bevy-explorer/source/react-web
pnpm install
(cd bridge-scene && pnpm install)

# this repository's stack, in the background, logging to a file
cd <this repository>
npm run dev:web -- --bevy /tmp/ext/dcl-one > /tmp/stack.log 2>&1 &
```

The first start builds the editor (about a minute); `--no-build` skips that on a restart.
Ready means the log shows the service on `:8787`, the bridge scene on `:8100` and vite on
`:5173`. If the bridge scene says it cannot start `@dcl/sdk-commands`, the pnpm installs
above were skipped. If the page stops at "Starting... 0%" or vite reports a missing export
from `./pkg/webgpu_build.js`, the explorer checkout and the engine are from different commits.

## 3. Open it on a hardware GPU, headed

The engine needs a real GPU and a visible window. Headless Chrome, and a background tab,
fall back to a software renderer or stop rendering. Start Chrome headed with WebGPU enabled
and a DevTools port, then confirm the page's adapter before trusting anything you see:

```js
(await navigator.gpu.requestAdapter()).info   // vendor and architecture
```

A vendor of `google` with architecture `swiftshader`, or `llvmpipe`, is software: stop and
say so. Open `http://localhost:5173/?editor&editor-features=experimental,advanced`.

## 4. Drive it

The editor's panels are HTML: find controls by their role and label. The explorer draws its
own screens (welcome, login, avatar, the Create page) on a canvas with no elements to find:
take a screenshot, read it, and click by position. With
[`agent-browser`](https://github.com/vercel-labs/agent-browser) attached to that Chrome:

```bash
agent-browser --cdp 9222 snapshot -i                  # HTML controls, with refs
agent-browser --cdp 9222 click @e3
agent-browser --cdp 9222 screenshot /abs/path/shot.png # absolute path
agent-browser --cdp 9222 mouse move 245 379 && agent-browser --cdp 9222 mouse down left && agent-browser --cdp 9222 mouse up left
```

From a fresh profile to a scene, with no wallet: **Play as guest**, **Continue**, type a name,
tick the terms box, **Jump in**; on the Create page, **New scene**, a starter, **Create scene**.
Positions depend on the window size, so read them from your own screenshot. The editor is
ready when the left panel shows Scene, Prefabs and Assets, the toolbar is across the top, the
Inspector is on the right and the scene renders between them.

After editing the editor: `npm run build -w @dcl-editor/web`, then reload. A change under
`packages/scene` also needs `npm run export-static -w @dcl-editor/scene`.

## 5. Evidence

For anything a person would see:

- a screenshot of the affected screen **before** the change, on the base commit;
- the same screen, same steps, **after**;
- a pixel difference of the two when the change is small
  (`agent-browser --cdp 9222 diff screenshot --baseline before.png`).

Look at your own screenshots before describing them. Then report: the commands you ran and
their result, the adapter the page had, what each image shows, console errors that matter,
and what you did not verify. Stop what you started.

## What failure looks like

| You see | It means |
| --- | --- |
| `EBADENGINE` on `npm install` | Node is not 24 |
| the welcome screen, never the editor | the canvas clicks did not land; screenshot and re-read positions |
| a grey or black centre with the panels around it | the engine did not start, or it is not rendering: check the adapter and that the window is visible |
| "Starting... 0%" forever | engine and explorer checkout from different commits |
| a software adapter | the screenshot proves nothing about rendering |
