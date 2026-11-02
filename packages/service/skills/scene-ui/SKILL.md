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

## Two surfaces: the HUD and windows

Every piece of screen UI is one of two things, and they follow different rules.

- **The HUD** is what stays on screen while the game plays: timer, score, the objective line, a small
  status. It is **ultra clean**: as little as works (D5), compact, at the screen edges, the centre clear (H3),
  and never on the phone's touch buttons (L2, H4). Detail the player does not need every second goes in a
  window they open.
- **A window** is where the mechanic is interacting for a moment: a shop, a recipe or upgrade choice, a
  dialog, the results. While it is open it **may take the whole screen**: the screen behind it dims and a tap
  there closes it, and on a phone the window fills the interactable area edge to edge (W2). Use that space
  for content (text, images, big buttons), not for margins and padding: every pixel counts on a phone. When
  there is a lot to fit, step down to the dense sizes, never below the floors. On desktop a window is
  centred, at most about 960 wide, closer to ordinary React layout (W4).

One size set covers both, per surface and platform (`uiSizes(surface, { dense })` in
`./runtime/uiComponents` answers it for the player's device; virtual units):

| | text | small (least) | title | press (least) | main button |
|---|---|---|---|---|---|
| HUD, phone | 28 | 20 | 28 | 80 | 80 |
| HUD, desktop | 24 | 16 | 24 | 48 | 48 |
| Window, phone | 24 | 20 | 32 | 80 | 96 |
| Window, phone, dense | 20 | 20 | 28 | 80 | 80 |
| Window, desktop | 20 | 16 | 28 | 48 | 56 |
| Window, desktop, dense | 18 | 16 | 24 | 48 | 48 |

The phone floors, text 20 and presses 80 on the short side, are L3 and L4: `mobile_check` measures them.

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
- **L3** Touch targets ≥ 80 units on the short side on a phone (48 on desktop); a window's main action ≥ 96.
- **L4** Text ≥ 20 on the mobile canvas (24 for a window's body, 28 for HUD values; 16 on desktop); no text clipped by its box.
- **L5** No pressable node is covered by a later or higher node that also takes the pointer.
- **L6** Area containers (`InteractableArea`, `ScreenInsetArea`) never get a width or height.
- **L7** A dialog that asks for an action is centred in the area (on a phone the interactable area, not the whole screen, so its buttons stay inside L1); a message that asks for nothing sits top-centre.
- **L8** Nothing visible falls off either canvas; every stack fits in 720 units of height.

**H — the HUD leaves the game visible (measured on the phone)** · `references/layout-check.md`

- **H1** No two HUD panels overlap.
- **H2** The HUD covers at most 25% of the phone screen (a compact game HUD is 15–20%).
- **H3** No HUD panel sits in the screen centre (the middle third both ways), where the player and the game are.
- **H4** The HUD is measured as it looks mid-game, every window closed: no HUD panel sits on a touch button
  the scene declares (measured as L2; on a phone the right column ends above them), and a list that grows
  during play (orders, players, a leaderboard) is sized to `hudSpace(slot)` and shows only the rows that fit.

**W — windows (shop, choice, dialog, results)** · `references/thumb-and-dialogs.md`

- **W1** A window covers the screen only while it is open: it is a `modal` with an `open()` that answers
  false during play (measured).
- **W2** On a phone a window fills the interactable area with content: thumb-sized buttons, choices in a grid,
  little padding; dense sizes when a lot has to fit.
- **W3** A tap on the dimmed screen behind it closes it when closing loses nothing, and it has a close button
  in its title row; both go through the one close function (C7).
- **W4** On desktop a window is centred and at most about 960 wide; its height follows its content.

**C — controls (read from the code)** · `references/touch-controls.md`

- **C1** Inventory every `InputAction` the scene reads.
- **C2** Hide every native touch button the scene does not use.
- **C3** Set the main action (`setMainAction`) to the scene's main verb; give kept buttons an icon that says what they do, and never name E, F or 1–4 in text a phone shows.
- **C4** No core action on `IA_ACTION_3`–`IA_ACTION_6` (on a phone they hide behind "+").
- **C5** Buttons appear only while their action is possible (E near a usable thing, an item button once you hold the item).
- **C6** Never hide the joystick unless the scene gives the player another way to move.
- **C7** A modal hides the touch controls on open and restores them on close, through one close function, which also plays its close sound.
- **C8** Nothing depends on hover, `PointerLock`, a mouse wheel or a keyboard shortcut alone.

**D — design (judged)** · `references/thumb-and-dialogs.md`

- **D1** Frequent actions in the right-thumb zone (bottom-right).
- **D2** Rare and destructive actions (exit, settings, mute) in the top corners.
- **D3** Dialogs that ask a question: ≤ 3 choices, primary on the right, destructive confirmed.
- **D4** Every press shows a pressed state and plays a click before it acts; a denied press plays an error sound.
- **D5** Show the least that works; disclose the rest on demand.
- **D6** One HUD fits both canvases; branch on `isMobile()` only where a rule needs it.

**P — on a phone (the creator does it)**

- **P1** The creator plays it on a phone before shipping (Preview → *Show QR Code for Mobile*, or
  `npm run start -- --mobile`). You cannot do this step; you ask for it, every time.

## Closing message (mandatory)

Whenever you finish work that adds or changes screen UI or touch controls, the closing block of your reply
(its order is in the system prompt) carries this line, in the creator's language:

> Many Decentraland players come from mobile devices — try it there too! (Preview → Show QR Code for Mobile)

Before it, list the rules you could not verify (any L or H you checked only by reading code, every D, P1),
so the creator knows what to look at on the phone.

In another language, translate the line in the creator's own register (formal or informal, as they write) and keep the menu path in English.

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

**Decentraland Studio projects** already have this decision made, and ship the two surfaces ready-made:
the compact HUD set in `./runtime/hudKit` and windows in `./runtime/uiWindow` (their headers are the API).
A HUD with a timer, an objective, the score and a status line, under 5% of a phone screen:

```tsx
import { mountCompactHud } from './runtime/hudKit'

mountCompactHud(() => ({ timer: secondsLeft(), objective: 'Deliver the soup', score: myScore(), status: holding() }))
```

A shop window: full interactable area on a phone, centred and at most 960 wide on desktop, closed by a tap
on the dimmed screen or its close button:

```tsx
import ReactEcs from '@dcl/sdk/react-ecs'
import { mountWindow, UiWindow, UiChoiceGrid, UiWindowActions } from './runtime/uiWindow'

let shopOpen = false
const closeShop = () => { shopOpen = false }
mountWindow({ open: () => shopOpen, close: closeShop, render: () =>
  <UiWindow id="shop" title="Shop" onClose={closeShop} dense={items.length > 6}>
    <UiChoiceGrid id="shop" choices={items.map((item) => ({ label: item.name, detail: `${item.price} coins`,
      image: item.icon, disabled: coins() < item.price, onClick: () => buy(item) }))} />
    <UiWindowActions id="shop" actions={[{ label: 'Done', primary: true, onClick: closeShop }]} />
  </UiWindow> })
```

Under them, place every panel with
`addHudItem(slot, render)` from `./runtime/hudLayout` (read its header), never your own
`ReactEcsRenderer.addUiRenderer`. The shared layout draws inside `UI_CANVAS` (`screenInset: 'interactable'`),
stacks panels in the `left`, `right`, `top` and `bottom` slots, leaves the bottom corners to the phone's
joystick and jump/E/F buttons, ends the right column above the action buttons on a phone, and draws `modal`
windows in front over the whole screen, hiding the touch controls while one is open. The native buttons the
scene uses are declared with `declareTouchButtons([...], { main })` from the same module, each with the icon of what
it does: `{ action: InputAction.IA_PRIMARY, icon: actionIcon('pick-up') }`, with `actionIcon` and the `ActionHint`
that shows the same icon in a HUD hint from `./runtime/actionIcons` (C2, C3 and C7 are then the layout's job; never
call `TouchScreenControls` yourself). A modal's render draws the dialog whenever it is
called, and its panel carries a `uiTransform` `elementId`. Style panels with
`sceneUiTheme` from `./runtime/uiTheme` and the components from `./runtime/uiComponents`. In the editor,
`mobile_check` measures the HUD on a phone as it looks during play (every window closed, the declared touch
buttons shown), then each modal open, and checks L1–L5, L8, H1–H4, W1, C1, C2 and C3 in code: run it after
every UI or input change, instead of judging a picture. It measures what is on screen when it runs, so run it
during a round with the lists as long as they get. `UiButton` is `uiSizes('window').button` tall (80 on a
phone); give a window's main action `uiTransform={{ height: uiSizes('window').primary }}`.

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
purpose and why, and then the closing message.
