# Creator Hub script fixtures

Verbatim copies of real smart-item scripts from decentraland/creator-hub
(`packages/asset-packs/packs/smart_items/assets/`, main at `ebf0cb5d`, 2026-11-10),
read by `parser-creator-hub.test.ts`. They end in `.txt` so the editor's typecheck
and lint leave them alone: they import `@dcl/asset-packs` and `~system/EngineApi`,
which this repo does not install.

| File | From | What it exercises |
| --- | --- | --- |
| `AdminTools.ts.txt` | `admin_toolkit/AdminTools.ts` (creator-hub#1748) | object and array params, `@components`, `@actionsOf`, `@format wallet`, an enum |
| `locomotion-settings.ts.txt` | `locomotion_settings/locomotion-settings.ts` (creator-hub#1513) | `Slider<min, max, step>` |
| `Door.ts.txt` | `wooden_door/Door.ts` (creator-hub#1604, #1667) | `@event` tags in the constructor's JSDoc |

To refresh one, copy the file again from Creator Hub and keep the name.
