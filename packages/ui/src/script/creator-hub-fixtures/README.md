# Creator Hub script fixtures

Verbatim copies of real smart-item files from decentraland/creator-hub
(`packages/asset-packs/packs/smart_items/assets/`, main at `ebf0cb5d`, 2026-11-10),
read by `parser-creator-hub.test.ts` and `creator-hub-admin-toolkit.test.ts`.
Scripts end in `.txt` so the editor's typecheck and lint leave them alone: they
import `@dcl/asset-packs` and `~system/EngineApi`, which this repo does not install.

| File | From | What it exercises |
| --- | --- | --- |
| `AdminTools.ts.txt` | `admin_toolkit/AdminTools.ts` (creator-hub#1748) | object and array params, `@components`, `@actionsOf`, `@format wallet`, an enum |
| `locomotion-settings.ts.txt` | `locomotion_settings/locomotion-settings.ts` (creator-hub#1513) | `Slider<min, max, step>` |
| `admin_toolkit.composite.json` | `admin_toolkit/composite.json` (creator-hub#1748) | what placing Creator Hub's Admin Tools writes: a Placeholder and a Script, no `asset-packs::AdminTools` |
| `Door.ts.txt` | `wooden_door/Door.ts` (creator-hub#1604, #1667) | `@event` tags in the constructor's JSDoc |

To refresh one, copy the file again from Creator Hub and keep the name.
