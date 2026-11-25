# Emotes in scenes

What a scene can do with avatar emotes today, what the editor ships, and what is still open.
Researched 2026-11-03 from bevy-explorer's source and docs.decentraland.org. Nothing below about
the marketplace or generation is built yet.

## What the engine plays

| Call | Plays | Notes |
|---|---|---|
| `triggerEmote({ predefinedEmote })` | a base emote by name (`wave`, `clap`, `openChest`, `lever`, `sittingChair1`…) | bevy passes the string through as an emote URN (`crates/dcl/src/js/restricted_actions.rs`), so a marketplace `urn:` probably works too; untested, undocumented |
| `triggerSceneEmote({ src, loop })` | a `*_emote.glb` from the scene's own files | the player must stand still in the scene; walking cuts it short; **no sound** (`crates/avatar/src/animate.rs`), so pair an AudioSource |
| AvatarShape `expressionTriggerId` (NPCs) | a base name, a scene file or a marketplace URN | always full-body and not looping (`crates/avatar/src/lib.rs`) |
| `AvatarAttach` | an entity on any of 26 anchor points | local player, other players or NPCs (`crates/avatar/src/attach.rs`); the Pickup Item already uses it |

A scene emote file: the Decentraland rig (`Armature`, bones `Avatar_*`, 62 of them), one clip named
`<Name>_Avatar`, at most 300 frames at 30 fps, at most 3 MB. A prop emote adds an `Armature_Prop`
and a `<Name>_Prop` clip of the same length (≤3k triangles, 2 materials, 2 textures).

## What ships

The Pickup Item's `pickAnimation`: "from a table" (a reach, 1.2 s) and "from the floor" (a squat,
1.9 s, the player held still with an InputModifier while it plays). Off by default: an
animation on every pick slows a fast game.

The two files are keyframed, not mocap: `packages/desktop/scripts/make-pickup-emotes.mjs` writes
them onto the seat emote's rig. Edit the poses there and run it again:

```bash
node packages/desktop/scripts/make-pickup-emotes.mjs
```

## TODO

- [ ] **A catalog of emotes for basic game actions.** Pick up, put down, push a button, pull a lever,
  open a chest or door, throw, swing, cheer, lose, sit, dance loops. Ship them like the sound
  library: our own CC0 `_emote.glb` files, tagged, that the assistant searches and copies into a
  scene. Open questions:
  - Where they come from. CMU mocap is free for commercial use. Mixamo forbids redistributing its
    files, and a scene emote is a downloadable file. Rokoko's terms vary by pack.
  - A Node retargeter from Mixamo/BVH skeletons onto `Avatar_*`.
  - A validator for the limits above.
  - A few prop templates (chest, lever, sword) with parametric timing.
- [ ] **Generating emotes in real time from a prompt.**
  - Hosted text-to-motion: Viggle returns a Mixamo-skeleton GLB for about $0.10; Meshy and
    DeepMotion are the alternatives.
  - Then our retargeter and the validator, then a preview before it lands in the scene.
  - Not self-hosted for now. HY-Motion's license excludes the EU, UK and South Korea, outputs
    included. The HumanML3D/AMASS-trained models (MoMask, T2M-GPT, MDM) are non-commercial.
  - Prop emotes that touch an object need templates; generation can't place a hand on a lid.
- [ ] **Marketplace emotes by URN.**
  - `https://marketplace-api.decentraland.org/v1/catalog?category=emote` (no auth) lists them with
    a thumbnail, URN, loop and prop/sound flags.
  - A URN on an NPC is the platform's sanctioned use.
  - Copying a marketplace GLB into a scene is not allowed (the IP belongs to the creator/holder).
  - Playing a URN on the player through `triggerEmote` needs testing in bevy and Unity first.
- [ ] **Scene emote sound in bevy-explorer.** `triggerSceneEmote` drops the file's audio.
- [ ] **An emote picker in the NPC inspector.** `expressionTriggerId` is free text today.
- [ ] **Face the item.** The avatar reaches the way it already faces; turning it toward the item
  first (movePlayerTo with a look-at, which needs ALLOW_TO_MOVE_PLAYER_INSIDE_SCENE) would aim
  the reach.
- [ ] **The pick moment.** The item jumps to the hand when the pick is predicted, before the hand
  reaches it. Showing it in hand at the grab frame would read better.
