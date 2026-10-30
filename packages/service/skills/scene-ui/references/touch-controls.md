# Touch controls: keep, hide, replace

Rules: **C1–C8, L2**.

On a phone the client draws its own controls: a joystick bottom-left and a cluster of action buttons
bottom-right. Your scene decides which of those buttons exist. The default — every button visible —
is almost never right: unused buttons push the useful ones behind a "+" and tell the player there are
actions that do nothing.

## The native buttons

| Button | InputAction | Desktop key |
|---|---|---|
| Joystick | `IA_FORWARD` / `IA_BACKWARD` / `IA_LEFT` / `IA_RIGHT` | WASD |
| Large central button | `IA_JUMP` unless you set a main action | Space |
| Interaction button | `IA_POINTER` | left click |
| E | `IA_PRIMARY` | E |
| F | `IA_SECONDARY` | F |
| 1–4, behind "+" | `IA_ACTION_3`–`IA_ACTION_6` | 1–4 |

How the cluster fills (mobile client):
- Priority order is fixed: JUMP, POINTER, PRIMARY, SECONDARY, ACTION_3…6. Hidden buttons drop out and the
  rest move up. `setMainAction(x)` moves `x` to the front (into the large button); jump stays where it is.
- The first visible action takes the large button; the next ones take an arc around it.
- **5 or fewer visible**: all of them show, no "+". **More than 5**: three on the arc, and the rest
  behind a "+", one tap away — never put a core action there (C4).
- The arc runs from the bottom edge (left of the large button) round to the right edge (above it). With
  one arc button it sits midway (centre about `(1296, 479)`); with two or three they keep the three-button
  spacing from the bottom; four (or three and "+") spread over the whole arc.

Where the cluster sits on a 1600 × 720 canvas (R and B are the right and bottom insets, normally 108 and
45; scale the rest with the canvas):

| Piece | Rect or centre |
|---|---|
| Large button | 156 × 156 at `[W − R − 156, H − B − 156]` → `[1336, 519]` |
| Arc buttons | 80-unit discs, 167 units from the large button's centre `(1414, 597)`, from left-low round to above it |
| Whole cluster, everything visible | about `x 1211–1492, y 394–675` |
| "+" menu when open | a 72-wide column above the "+", about `[1416, 42, 72, 336]` |
| Joystick | centre `(262, 529)`, radius ~85; its touch zone is the left 40% of the screen from y = 240 down |
| Emote button | 80 × 80 at `[108, H − 125]` |

Scene UI is drawn above the joystick and the action buttons and takes their touches. A button of yours
on top of a native button that is still visible makes that native button unpressable (**L2**). If you
hid a native button, its slot is yours.

## The API

```ts
import { engine, InputAction, TouchScreenControls } from '@dcl/sdk/ecs'

TouchScreenControls.hide([InputAction.IA_JUMP, InputAction.IA_SECONDARY, InputAction.IA_ACTION_3,
  InputAction.IA_ACTION_4, InputAction.IA_ACTION_5, InputAction.IA_ACTION_6])
TouchScreenControls.setMainAction(InputAction.IA_PRIMARY)
TouchScreenControls.hideAll() / showAll()          // buttons only; showAll() also clears custom icons
TouchScreenControls.hideJoystick() / showJoystick()
TouchScreenControls.hideCrosshair() / showCrosshair()
```

It lives on the root entity, merges with what is already set, does nothing on desktop (no `isMobile()`
guard needed), and resets when the player leaves the scene. For a custom icon per button write the
component directly: `touchInputs: [{ inputAction, hide: false, icon: { tex: { $case: 'texture', texture: { src } } } }]`.
The icon replaces the button's glyph, drawn about 56 units square on the button: a bold white shape on a
transparent square PNG reads; a thin or dark one does not.

To replace a native button with your own, bind your element to the action with `uiInputBinding`: while it
is pressed the action is held exactly as the native button would hold it (movement included), and your
`inputSystem` listeners fire unchanged.

```tsx
<UiEntity
  uiTransform={{ width: 96, height: 96 }}
  uiBackground={{ texture: { src: 'images/torch.png' } }}
  uiInputBinding={{ actions: [InputAction.IA_SECONDARY] }}
/>
```

## The rules

**C1 — Inventory.** Grep the scene for `InputAction.` and every UI `onMouseDown` / `onClick`. Write the
list: action → what it does → desktop key → how a phone player triggers it. A row with no phone answer is
a bug.

**C2 — Hide what you don't use.** Everything not in the inventory goes in `TouchScreenControls.hide([...])`
at scene start. Jump is a button like any other: a puzzle that never needs a jump hides it.

**C3 — Name the main verb.** `setMainAction` puts the scene's most frequent action in the large button.
Give each kept button an icon that says what it does — a generic "E" means nothing to a phone player — and
never tell a phone player to press E, F or 1–4: a hint shows the action's word and icon on a phone and keeps
the key for desktop (`isMobile() ? 'Tap the station' : 'E: use the station'`).

**C4 — Not behind "+".** `IA_ACTION_3`–`IA_ACTION_6` sit behind "+" on phones whenever more than five
buttons are visible. Use them only for shortcuts that also exist elsewhere, or keep the visible count at
five or fewer.

**C5 — Show when possible.** A button appears while its action is possible and disappears after: the E
button near a usable thing (show/hide it from a proximity check), an item button once the item is held.
Taps on world things work through `IA_POINTER` with no button at all — accept it alongside E for
anything the player uses by touching it.

**C6 — Keep the joystick.** Hide it only when the scene moves the player another way (a cutscene, a
seated minigame, your own `uiInputBinding` pad). Restore it after.

**C7 — Modals own the controls while open.** Opening a dialog that takes the player's attention calls
`hideAll()` + `hideJoystick()`; closing it restores the exact previous setup (`showAll()` drops custom
icons and re-shows buttons you hid on purpose, so re-apply your C2/C3 setup rather than calling it
alone). Route every way of closing — the button, a tap outside, a timeout, the scene ending — through one
function.

**C8 — Touch has no hover.** No information only in a hover state, no `PointerLock`-dependent aiming, no
action that needs a keyboard key with no button. Desktop keeps its shortcuts as a second path.

Decentraland Studio projects declare their buttons with `declareTouchButtons` from `./runtime/hudLayout`,
which writes `TouchScreenControls` itself and restores the declared set after a modal: call that, never the
component. Give each button its icon there, from the shipped set in `./runtime/actionIcons` (pick-up, drop,
chop, cook, wash, throw, use, serve, jump, interact, attack, talk; the editor copies the images into
`assets/images/action-icons/` once a script imports the module):
`declareTouchButtons([{ action: InputAction.IA_PRIMARY, icon: actionIcon('pick-up') }, { action: InputAction.IA_SECONDARY, icon: actionIcon('chop') }], { main: InputAction.IA_PRIMARY })`.
Show the same icon in the HUD hint with `ActionHint` from that module: the icon and the word on a phone, the
key on desktop. Both headers are the API. Prefabs and UI-Designer scenes may manage `TouchScreenControls` themselves (a generated
`src/mobile-hud.ts`, a prefab guide that says so): read that first and don't fight it.
