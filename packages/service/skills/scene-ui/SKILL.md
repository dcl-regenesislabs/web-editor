---
name: scene-ui
description: "Build 2D screen UI for Decentraland scenes (React-ECS) that works on phones and desktops from the first draft: HUDs, menus, dialogs, buttons, notifications, custom touch controls. Covers the two canvases (mobile 1600x720, desktop 1920x1080), the screen areas (safe area, interactable area, screenInset), hiding and replacing the native touch buttons (TouchScreenControls, UiInputBinding), thumb reach, dialog rules, and a layout check against rule IDs. Use whenever a scene shows anything on screen or reads player input — including when the request is a whole game (scores, timers, menus, results, ability buttons, key actions) and never says \"UI\" — or when existing UI must work on mobile. Do NOT use for 3D in-world text (see advanced-rendering) or clickable 3D objects (see add-interactivity)."
---

# Scene UI — one UI for phones and desktops

Many Decentraland players are on phones. A scene's UI is designed for **both** platforms from the first
draft, never ported to mobile at the end. This skill is the rulebook and the loop; the component API
(props of `UiEntity`, `Label`, `Button`, `Input`, `Dropdown`) is in
`{baseDir}/../build-ui/references/ui-components.md`.

Every rule has an ID. Cite the ID when you apply it, when you break it on purpose (say why), and in your
report. The full text of each rule is in the reference named next to it.

## The two canvases

| | Desktop / web | Mobile |
|---|---|---|
| Virtual canvas | 1920 × 1080 | **1600 × 720** — any 16:9 virtual size is rewritten to this on a phone; a tall phone reports a bit more height (iPhone 14 Pro: 1600 × 738) |
| What scales it | `min(screenW / virtualW, screenH / virtualH)` | same; `devicePixelRatio` is not part of it |
| Screen inset area | 0 on every side | at least 108 / 32 / 108 / 45 (left / top / right / bottom), more where the notch is bigger |
| Interactable area | the client's left HUD column is excluded (~25% of the width) | the screen inset area minus a 328-unit chat column: **436 / 32 / 108 / 45** on a 1600 × 720 phone — a 1056 × 643 box |
| Native controls | none on screen | joystick bottom-left, action buttons bottom-right (inside the interactable area, by design) |
| Input | mouse + keyboard, hover exists | touch only — no hover, no `PointerLock`, no keyboard shortcuts |

On a phone one virtual unit is roughly **0.09 mm** (1600 units across a ~14 cm screen). That is why the
size rules below look large next to desktop habits. The mobile canvas is also **a third shorter**: a
column that fits 1080 units does not fit 720.

## The loop

1. **Inventory.** List what the player does and which inputs the scene reads (every `InputAction`, every
   UI button). This list drives C1–C5. Write it down before any UI code.
2. **Place.** Choose the area each piece lives in (`references/screen-areas.md`) and the thumb zone of
   each action (`references/thumb-and-dialogs.md`). Decide which native buttons stay, which you hide and
   which you replace (`references/touch-controls.md`).
3. **Build** the UI in the project's existing UI file or a new `.tsx`. When this project's SDK accepts
   `elementId` in `uiTransform` (experimental SDKs; check its type before writing one, never guess), give
   every button, panel, dialog and text a unique one (`hud-score`, `shop-buy`): the explorer measures only
   named nodes. On an SDK without it, write none: it does not compile, and the layout is checked by hand.
4. **Check the layout on both canvases** (`references/layout-check.md`): rules L1–L8, for every screen
   the player can reach — the HUD, each dialog and panel open, the end screen — on desktop and on mobile.
   When the explorer gives you a layout dump (in the Decentraland editor: the `ui_layout` tool during a
   playtest, started with `platform: "mobile"` for the phone), the check is mechanical: measure, fix,
   measure again until no rule fails. Without a dump, check the same rules against the numbers in the code and a
   screenshot, and say which ones you could not measure.
5. **Review** C1–C8 against the code and D1–D6 against the design. Every button, dialog and game-flow
   screen (start, result, time up) has its sound: the `game-sounds` skill has the library and the wiring.
6. **Hand off** with the closing message below.

## Rules at a glance

**L — layout (measured; a failure is a bug)** · `references/layout-check.md`

- **L1** Every pressable node lies fully inside the interactable area (mobile) / screen inset area (desktop).
- **L2** No node of yours overlaps a native control that is still visible.
- **L3** Touch targets ≥ 80 units on the short side; the primary action ≥ 96. *(proposed, pending device measurement)*
- **L4** Text ≥ 24 on the mobile canvas (≥ 20 only for secondary text); no text clipped by its box. *(proposed)*
- **L5** No pressable node is covered by a later or higher node that also takes the pointer.
- **L6** Area containers (`InteractableArea`, `ScreenInsetArea`) never get a width or height.
- **L7** A dialog that asks for an action is centred in the area (on a phone the interactable area, not the whole screen, so its buttons stay inside L1); a message that asks for nothing sits top-centre.
- **L8** Nothing visible falls off either canvas; every stack fits in 720 units of height.

**C — controls (read from the code)** · `references/touch-controls.md`

- **C1** Inventory every `InputAction` the scene reads.
- **C2** Hide every native touch button the scene does not use.
- **C3** Set the main action (`setMainAction`) to the scene's main verb; give kept buttons an icon that says what they do.
- **C4** No core action on `IA_ACTION_3`–`IA_ACTION_6` (on a phone they hide behind "+").
- **C5** Buttons appear only while their action is possible (E near a usable thing, an item button once you hold the item).
- **C6** Never hide the joystick unless the scene gives the player another way to move.
- **C7** A modal hides the touch controls on open and restores them on close, through one close function, which also plays its close sound.
- **C8** Nothing depends on hover, `PointerLock`, a mouse wheel or a keyboard shortcut alone.

**D — design (judged)** · `references/thumb-and-dialogs.md`

- **D1** Frequent actions in the right-thumb zone (bottom-right).
- **D2** Rare and destructive actions (exit, settings, mute) in the top corners.
- **D3** Dialogs: centred, ≤ 3 choices, primary on the right, destructive confirmed.
- **D4** Every press shows a pressed state and plays a click before it acts; a denied press plays an error sound.
- **D5** Show the least that works; disclose the rest on demand.
- **D6** One HUD fits both canvases; branch on `isMobile()` only where a rule needs it.

**H — on a device (the creator does it)**

- **H1** The creator plays it on a phone before shipping (Preview → *Show QR Code for Mobile*, or
  `npm run start -- --mobile`). You cannot do this step; you ask for it, every time.

## Closing message (mandatory)

Whenever you finish work that adds or changes screen UI or touch controls, end your reply with this line,
in the creator's language:

> Many Decentraland players come from mobile devices — try it there too! (Preview → Show QR Code for Mobile)

Before it, list the rules you could not verify (any L you checked only by reading code, every D, H1),
so the creator knows what to look at on the phone. Spanish:

> Muchos usuarios de Decentraland vienen de dispositivos móviles, ¡hacé una prueba ahí! (Preview → Show QR Code for Mobile)

## Starting point

```tsx
import ReactEcs, { ReactEcsRenderer, UiEntity, InteractableArea, ScreenInsetArea } from '@dcl/sdk/react-ecs'
import { isMobile } from '@dcl/sdk/platform'

// 'none' lets full-screen layers (vignette, flashes) cover the whole screen; the HUD goes inside an area.
ReactEcsRenderer.setUiRenderer(Root, { virtualWidth: 1920, virtualHeight: 1080, screenInset: 'none' })

// The area places itself with top/left/right/bottom: never give it a width or height (L6).
const Area = (p: { children?: ReactEcs.JSX.ReactNode }) =>
  isMobile() ? <InteractableArea>{p.children}</InteractableArea> : <ScreenInsetArea>{p.children}</ScreenInsetArea>

function Root() {
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', pointerFilter: 'none' }}>
      {/* full-screen layers first: vignette, a dialog's dim backdrop */}
      {/* pressable HUD and dialogs last, inside the area, dialogs centred in it (L1, L5, L7) */}
      <Area>{/* HUD, then the open dialog */}</Area>
    </UiEntity>
  )
}
```

With no full-screen layers, the simpler form is `screenInset: 'interactable'` on the renderer and no area
wrappers at all. Never both: an area inside an inset renderer applies the inset twice.

**Decentraland Studio projects** already have this decision made: import `UI_CANVAS` and
`sceneUiTheme` from `./runtime/uiTheme` and the components from `./runtime/uiComponents`, and pass
`UI_CANVAS` (`screenInset: 'interactable'`) to every `ReactEcsRenderer.addUiRenderer(entity, Ui, UI_CANVAS)`.
`UiButton` is 52 units tall: below L3, so give it `uiTransform={{ height: 80 }}` (96 for the primary action)
wherever a phone player has to press it.

## Gotchas that cost a phone test each

These come from a real mobile pass (one HUD, three phone tests):

- An area container given `width: '100%', height: '100%'` on top of its own insets ends up partly
  off-screen. Areas size themselves (L6).
- A full-screen dialog layer drawn after the HUD swallows every tap on the HUD's corner buttons. Draw the
  pressable HUD last, or make the layer `pointerFilter: 'none'` (L5).
- Hiding the native E button and then waiting for E presses: the action is unreachable on a phone. Accept
  `IA_POINTER` (a tap on the thing) as well, or bring E back only near usable things (C5).
- Figma frames for phones are drawn at 1600 × 720: take sizes from them as virtual units directly.
- `borderRadius` and nine-slice textures are not rendered on mobile; emoji glyphs are missing on desktop.
  Keep shapes square or bake them into a texture.
- Platform detection is asynchronous: the first frames run with `isMobile()` false at 1920 × 1080, then
  the layout swaps. Don't cache `isMobile()` at module load.

## Report

Say what you built, which rules you checked and how (dump, code, screenshot), which ones you broke on
purpose and why, and end with the closing message.
