# Screen areas, canvases and where things go

Rules: **L1, L2, L6, L7, L8, D6**.

## The canvas

React-ECS scales your UI from a virtual size you choose to the real screen:
`scale = min(screenW / virtualW, screenH / virtualH)`. Pass `{ virtualWidth: 1920, virtualHeight: 1080 }`;
on a phone the SDK rewrites any 16:9 size to **1600 × 720**. Work in those virtual units and think of two
canvases, not one:

| | Desktop | Mobile |
|---|---|---|
| Canvas | 1920 × 1080 | 1600 × 720 (taller phones report a little more height: 1600 × 738 on an iPhone 14 Pro) |
| One virtual unit on screen | ~0.2–0.3 mm | **~0.09 mm** |
| Height lost vs. desktop | — | one third |

`vw` / `vh` units ignore `screenInset`. Passing `0` for the virtual size turns scaling off: don't.
Platform detection is asynchronous: the first frames lay out at 1920 × 1080 with `isMobile()` false, so
read `isMobile()` inside the render function, never once at module load.

## The two areas

Explorers report two rectangles every frame in `UiCanvasInformation`, as distances from each screen edge
in canvas units. Read them at runtime; the numbers below are for checking, not for hardcoding.

**Screen inset area** (`screenInsetArea`) — the screen minus hardware margins (notch, rounded corners,
home indicator). On the mobile client it is never thinner than **108 / 32 / 108 / 45**
(left / top / right / bottom; left and right are kept equal). On desktop it is the whole screen.

**Interactable area** (`interactableArea`) — where the player can comfortably press your UI:
- Mobile: the screen inset area minus the client's 328-unit chat column on the left →
  **436 / 32 / 108 / 45** on a 1600 × 720 phone, a **1056 × 643** box. The native action buttons on the
  bottom right are drawn *inside* it by design (see `touch-controls.md`).
- Desktop: the explorer's left HUD column is excluded — about the left 25% of the screen.
- It needs mobile client 1.12.1 or newer; older clients report the two areas as the same rectangle.

The three explorers don't agree exactly (Unity: left 25%; Bevy: measured from its HUD; mobile: the numbers
above). That is why the rules use the reported area, not a constant.

## Choosing how the renderer insets

`ReactEcsRenderer.setUiRenderer(Ui, { virtualWidth, virtualHeight, screenInset })` — or `addUiRenderer`
with the same options:

| `screenInset` | The whole UI sits in | Use when |
|---|---|---|
| `'device'` (default) | screen inset area | rarely what you want on mobile: the joystick and chat sit inside it |
| `'interactable'` | interactable area | **the default choice**: a HUD with no full-screen layers |
| `'none'` | the full screen | you have full-screen layers (vignette, flash, fade, a backdrop), and you wrap the HUD in `<InteractableArea>` / `<ScreenInsetArea>` yourself |

Never put an area wrapper inside an inset renderer: the inset is applied twice. And never give an area
wrapper a width or height (**L6**): it positions itself with top / left / right / bottom, and a
`width: '100%'` on top of that pushes it off-screen. Insets don't clip: a child bigger than the area
still draws outside it, which is what L1 and L8 catch.

Decentraland Studio projects pass `UI_CANVAS` from `./runtime/uiTheme`
(`{ virtualWidth: 1920, virtualHeight: 1080, screenInset: 'interactable' }`) to every `addUiRenderer`.

## Where each kind of UI goes

Positions are inside the interactable area unless the row says otherwise.

| UI | Where | Why |
|---|---|---|
| Status the player glances at (timer, score, health) | top-centre, or along the top edge | both thumbs are busy; the eyes go up, not to the corners under the thumbs |
| Messages that ask for nothing (toasts, objectives, "you found the key") | top-centre, under the status row | out of the way of both thumbs (L7) |
| Context hints ("tap the door") | bottom-centre, above the action buttons' height | next to where the action happens |
| Dialogs that ask for an action | centred in the **area** (L7); the dim backdrop on the whole screen | on a phone the screen's centre puts a wide dialog's buttons over the chat column (L1) |
| Frequent actions | bottom-right, the right-thumb zone (D1) | see `thumb-and-dialogs.md` |
| Rare / destructive actions (exit, settings, mute) | top-right or top-left corner of the area (D2) | slow to reach on purpose |
| Full-screen effects (vignette, flash, fade) | the whole screen, `pointerFilter: 'none'` | they must never take a tap (L5) |

Never put anything pressable in the left 436 units of a phone: the chat column, the emote button and the
joystick's touch zone (the left 40% of the screen, from a third of the height down) are there, and scene
UI drawn over the joystick zone steals the touches that should start a walk.

## One layout for both canvases (D6)

Lay out with flex (`justifyContent`, `alignItems`, `margin`, percentages of the area) rather than fixed
left/top offsets. Then the same tree fits a 1056-wide mobile area and a ~1440-wide desktop area. Branch on
`isMobile()` only where a rule needs it — usually only for things that only exist on a phone (custom
touch buttons, hiding native controls), and for bigger text where the mobile canvas makes it too small.
A stack that fills 900 units of height on desktop does not fit in 643 on a phone (L8): plan the column
heights against 643 first.
