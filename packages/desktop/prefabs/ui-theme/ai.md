---
prefab: ui-theme
---

# UI Theme — AI guide

## When to use

Place one UI Theme from the library. Pick Accent Color and Dark or Light in its inspector, then Play. Run Progress, Announcer, and the 2D UI modes of Game Flow, Server Clock and Leaderboard share the palette. A single color change restyles their buttons, timers, scores, progress indicators and results together; text contrast is derived automatically. Keep one theme per scene.

## API

- `accentColor`: six-digit hex color, edited with a color picker.
- `appearance`: Dark or Light.

For custom UI, import `sceneUiTheme` from `~runtime/uiTheme`, `UiPanel`, `UiText`, `UiButton`, `ProgressPips`, `UiNotice` from `~runtime/uiComponents`, and place every panel with `addHudItem(slot, render)` from `~runtime/hudLayout` (its header documents the slots) instead of `ReactEcsRenderer.addUiRenderer`. Each panel declares width and height and is at most `HUD_COLUMN_WIDTH` wide; handlers go on actual buttons. Inspect a screenshot in the real preview, including completion.

`ColorHex`, `EntityName`, `EntityNames`, `ZoneName` and `ZoneNames` from `~runtime/authoring` are string aliases that give constructor parameters color or entity pickers. Plural references are ordered comma-separated names; creators pick and reorder them in the inspector. Names must be unique and contain no commas. The assistant can provide arrays to the plural parameters.

## Do / Don't

- Use one theme per scene, readable text (16 px or more) and small non-blocking HUDs.
- Never put UI in the bottom corners or the screen's left edge: phones draw the joystick and the jump/E/F buttons there. Results, shops and rule cards use the `modal` slot, which hides the touch controls while open.
- No hover-only states and no emoji in text; buttons at least 48 px tall.
- Do not write a separate palette for each prefab or use default pink SDK buttons.
- Verify running and finished states in a real preview screenshot.

## Example

Place UI Theme with accentColor "#59E0AC" and appearance "Dark", then place Run Progress and Announcer.
Their buttons, progress indicators, result panel and messages all share mint accents on dark surfaces.
Choose a new accent in the inspector to change them together. No scene script is needed.
