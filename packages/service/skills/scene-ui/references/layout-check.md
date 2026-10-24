# Checking the layout

Rules: **L1–L8**. The point: a layout bug found by measuring costs a minute; found on a phone it costs a
build, a QR scan and a play-through. Measure first, then send the creator to the phone for what only a
hand can judge.

## Getting a layout dump

A dump is the *computed* layout: the rectangle every UI node actually got after flex layout, plus the
areas and the canvas. Use whichever source the session can reach, and run it on **both** canvases.

| Source | What it gives | How |
|---|---|---|
| Decentraland editor | the Bevy dump below plus a picture, of whatever is on screen now (only nodes with an `elementId`; the rest are counted in `unmeasured`) | the `ui_layout` tool during a playtest. `playtest start` lays the game out on desktop; `playtest start` with `platform: "mobile"` as on a phone (until `stop`). Measuring changes nothing: open each dialog and panel with `playtest click`/`input`, then measure it. Use it whenever the tool is available |
| Mobile client (Godot) debug channel | every scene UI node (`ui_scene`) and every native control (`app_ui`) in the same canvas units; on a real phone or an emulated one | desktop: `cargo run -- debug-hub` in godot-explorer, run the client with `--emulate-android` (1600 × 720) or `--emulate-ios`; phone: `adb reverse tcp:9231 tcp:9231`. Send `{"type":"SCENE_INSPECTOR_CMD","cmd":"ui_scene","args":{"scene_id":…},"id":"1"}` to the hub on `:9230`. Works on production builds too (inspection verbs only). |
| Desktop explorer MCP (`unity-explorer-mcp` skill) | `ui_list`: pressable scene UI (`stack:sdk`) with screen rects, plus the client's own UI (`stack:ugui`); occlusion as `blockedBy` | desktop canvas only; labels and images are not listed, so L4/L8 need a screenshot |
| Bevy explorer (web) | every on-screen scene UI node that has an `elementId`, as a `UiLayoutFeedback` component the engine writes on it: `rect`, `visibleRect`, `visible`, `drawOrder`, in canvas units; the canvas is the root's `UiCanvasInformation` | read the scene's CRDT (`/crdt_snapshot` through the editor's engine console) while the scene runs. For the mobile canvas send `/mobile_ui on` through the editor, then `/reload <scene>`: the editor makes the canvas 1600 × 720-shaped (3D view included), and the scene is told it runs on mobile and gets the mobile interactable area. Native controls are not drawn and `screenInsetArea` reads 0, so take L2 zones from the table below. **Experimental**, not in a release yet |
| No explorer | the numbers in your `uiTransform`s | compute rects by hand for fixed sizes; say which rules you could only estimate |

Whatever the source, bring it to this shape before checking (units = canvas units, origin top-left):

```jsonc
{
  "platform": "mobile",                       // or "desktop"
  "canvas": { "width": 1600, "height": 720 },
  "screenInset":  { "left": 108, "top": 32, "right": 108, "bottom": 45 },
  "interactable": { "left": 436, "top": 32, "right": 108, "bottom": 45 },
  "nativeControls": [                          // only the ones visible right now
    { "id": "jump", "rect": [1336, 519, 156, 156] },
    { "id": "joystick-zone", "rect": [0, 240, 640, 480] }
  ],
  "nodes": [
    { "entity": 512, "parent": 0, "order": 7, "rect": [1180, 520, 96, 96],
      "visible": true, "pointer": true, "text": null, "fontSize": null, "clipped": false,
      "kind": "area" }                          // "area" for InteractableArea/ScreenInsetArea wrappers
  ]
}
```

Explorers report **canvas units** (the screen's logical pixels), not your virtual units. The rules
below are in virtual units, so divide every size and `fontSize` by
`scale = min(canvas.width / virtualWidth, canvas.height / virtualHeight)` first (virtualWidth/Height:
1920 × 1080 on desktop, 1600 × 720 on mobile). Example: a 1512 × 823 browser gives scale 0.762, so a
button the dump reports 50.5 tall is 66 virtual units — under L3.

`order` is the drawing order (later = on top). `pointer` is true when the node takes presses (it has
`onMouseDown`, a `uiInputBinding`, an input or dropdown, or pointer events, and is not
`pointerFilter: 'none'`).

## The rules as checks

Let `A` be the interactable area on mobile and the screen inset area on desktop, as a rect:
`[left, top, W − left − right, H − top − bottom]`. Only visible nodes count.

| Rule | Fails when |
|---|---|
| **L1** | a `pointer` node's rect is not fully inside `A` |
| **L2** | a `pointer` node, or a node with a background or text that does not cover the whole canvas, intersects a visible native control's rect (desktop has none) |
| **L3** | a `pointer` node is shorter than 80 on its short side (the main action than 96), or two `pointer` nodes are closer than 16 |
| **L4** | a text node's `fontSize` < 24 on mobile (< 20 if marked secondary), or its text is clipped |
| **L5** | a `pointer` node is covered (intersects) by a node with a higher `order` that also has `pointer` and is not its descendant |
| **L6** | a node of `kind: "area"` has an explicit width or height in its `uiTransform` |
| **L7** | a dialog (a node holding ≥ 1 button and a backdrop) is off the centre of `A` by more than 5% of the canvas; a toast without buttons is not in the top third |
| **L8** | a visible node's rect leaves the canvas, or a column's content height exceeds the area's height |

Report each failure with the rule, the node and the numbers: `L3 node 512 (Use button): 96×64, short side 64 < 80`.
Fix, take a new dump, repeat until clean. Then do the same on the other canvas. A dump covers only what
is on screen: open each dialog and panel and measure it open, on both canvases. Say which screens you
measured and which you checked only in the code.

## Simulating the mobile canvas without a phone

The mobile client numbers for a 1600 × 720 phone, landscape (for checks without a mobile client):

- screen inset: 108 / 32 / 108 / 45
- interactable: 436 / 32 / 108 / 45
- native controls with everything visible: large button `[1336, 519, 156, 156]`, arc buttons 80 wide
  around `(1414, 597)` at radius 167 (cluster ≈ `[1211, 394, 281, 281]`), joystick zone `[0, 240, 640, 480]`,
  emote `[108, 595, 80, 80]`, chat column `[108, 32, 328, 643]`.

Hidden buttons leave the cluster smaller (see `touch-controls.md`); with all hidden, only the joystick
zone and the left column remain.

## What a clean check does not prove

Thumb comfort (D1–D2), whether a dialog reads well (D3), feedback timing (D4), text legibility at arm's
length and the real phone's notch all need a hand and an eye. That is H1: a clean check is when you ask
the creator to try it on a phone, not instead of it.
