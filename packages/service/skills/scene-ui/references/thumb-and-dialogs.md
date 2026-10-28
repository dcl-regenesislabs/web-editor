# Thumbs and dialogs

Rules: **D1–D6, L3, L4, L7**.

A phone in Decentraland is held sideways in two hands. The left thumb lives on the joystick. The right
thumb is the only free finger, and it rests bottom-right. Everything here follows from that.

## Zones (mobile canvas, inside the interactable area)

| Zone | Roughly | Use for |
|---|---|---|
| Right thumb | x > 60%, y > 45% of the screen | frequent actions (D1) |
| Top edge | the top 15% of the area | status to glance at; rare actions in its corners (D2) |
| Centre | the middle of the area (x ≈ 964 on a 1600 × 720 phone) | dialogs that ask for something (D3, L7) |
| Left column | x < 436 | nothing of yours: chat, emotes, joystick |

**D1 — Frequent actions under the right thumb.** Use, shoot, pick up, the item buttons: bottom-right. If
native buttons are still there, yours go just above or left of the cluster, never under it (L2). If you
hid the native buttons, their slots are the best spots on the screen — take them.

**D2 — Rare and destructive actions far from the thumbs.** Exit, settings, mute, leaderboard: a top
corner. Being a stretch is the point: nobody leaves a run by grazing a button.

## Sizes

**L3 — Touch targets.** The short side of anything pressable is ≥ 80 virtual units (about 7 mm on a
phone); the main action ≥ 96. Spacing between two targets ≥ 16. Desktop is fine with these sizes too, so
use one size for both. *(Proposed numbers, from 1 unit ≈ 0.09 mm; confirm on a device.)*

**L4 — Text.** On the mobile canvas: ≥ 24 for anything the player must read, ≥ 20 only for secondary
text, ≥ 28 for anything read while moving. No label clipped by its box: size the box for the text, or wrap.
*(Proposed.)*

## Dialogs

**D3 — A dialog that needs a decision:**
- Centred in the area (L7): on a phone the interactable area, whose centre is right of the screen's
  because of the chat column. The dim backdrop covers the whole screen and takes taps.
- One question, at most three choices. Two is better.
- The primary choice on the **right** (nearest the right thumb), the cancel/back choice on the left.
- A destructive choice (leave, delete, spend) is confirmed by a second dialog or names its consequence on
  the button ("LEAVE RUN"), never by a second tap on the same spot.
- Buttons ≥ 96 tall in a dialog.
- A tap outside closes it only when closing loses nothing.
- Hides the touch controls while open, restores them on close, through one close function (C7).
- No text input unless the dialog cannot work without it: the phone keyboard covers half the screen.

**Messages that ask for nothing** sit top-centre (L7), go away by themselves, and never take a tap.

## Feedback and density

**D4 — Pressed state.** A press shows its pressed look (colour, inset, scale) for ~120–150 ms before the
action runs — on a touch screen there is no hover to tell the player the tap landed. The same frame
plays a `click` (`game-sounds`), and a dialog plays `open` and `close`. A disabled button looks disabled,
says why nearby, and plays `error` when pressed.

**D5 — Least that works.** Show only what the player needs now. Inventory, settings, help: one button
that opens them. Buttons appear with their possibility (C5).

**D6 — One HUD for both.** The same layout on both platforms, flexing to the area. Branch on `isMobile()`
only for what exists on one platform. Desktop keeps keyboard shortcuts as a second path to every button,
and shows the key on the button ("E — open").
