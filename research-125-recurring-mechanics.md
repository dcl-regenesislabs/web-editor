# Spike #125: recurring mechanics in published Decentraland scenes

## How this was measured

- **Sample:** 720 places from the public Places API (top by `like_score`, the most active right now, and every `game`-tagged place in the top 300). Of those, **415 had a live Genesis City deployment** I could fetch from the Catalyst: 240 SDK7 and 175 SDK6, 295 of them tagged `game`, from about 348 different creators.
- **What was read:** each scene's deployed bundle (`bin/index.js` / `bin/game.js`) and, for Creator Hub scenes, `assets/scene/main.composite`.
- **Three signals:**
  1. **Creator Hub composites** (173 of 240 SDK7 scenes use asset-packs). This is the cleanest data: the components, actions and triggers creators actually placed.
  2. **Scene-specific player-facing text.** I took the string literals in each bundle and dropped any string that appears in 8 or more scenes, which removes SDK, asset-packs and library text. Then I matched mechanic keywords ("leaderboard", "checkpoint", "harvest", "talk to", …) against what was left.
  3. **Library and API markers** that only get bundled when a scene uses them (`@dcl-sdk/utils` triggers, `MessageBus`, `isServer`, colyseus, cannon).
- **Caveat:** bundles are minified and ship the whole SDK, so the percentages are indicative, not exact. I left out keywords that were too generic to trust (`key`, `round`, `match`, `it`, `item`, `press E`).

## What the data says

### What Creator Hub creators place (173 scenes)

| Kind | Top entries (number of scenes) |
|---|---|
| Components | Animator 85 · VisibilityComponent 73 · Actions 72 · Triggers 70 · VideoPlayer 67 · **VideoScreen 63** · **AdminTools 59** · States 46 · PointerEvents 43 · TextShape 22 · Script 18 · LightSource 17 · Tween 12 · AudioSource 11 |
| Triggers | on_click 46 · on_player_leaves_area 41 · on_input_action 36 · on_player_enters_area 35 · on_spawn 18 · on_state_change 16 |
| Actions | set_state 46 · batch 38 · play_animation 29 · open_link 29 · **move_player_here 28** · **play_default_emote 28** · set_visibility 27 · random 26 · show/hide_text 26 · play_sound 25 · move_player 20 · start_delay 16 · teleport_player 12 · start_tween 12 · call_script_method 10 · attach_to_player 5 · change_camera 5 |

So no-code scenes are mostly click or walk-in → animate, show text, play a sound, teleport or emote, plus a video screen and admin tools.

### Game mechanics in scene code (398 scenes with a bundle, 283 of them games)

| Mechanic | Scenes | % of games | Creators | Examples |
|---|---:|---:|---:|---|
| Score / points | 94 | 28% | 89 | SK8centraLAND, Game Night Arena, Grill Master |
| Level / XP | 103 | 26% | 91 | Chicks Coop, Oasis Arcade, WonderMine |
| Reward / claim / airdrop / free wearable | 98 | 20% | 88 | Oasis Arcade, WonderMine, CBD Plaza |
| Quest / mission / objective | 72 | 22% | 69 | Oasis Arcade, Recall Rush, Color Pop |
| Shop / buy / MANA price | 75 | 20% | 64 | WonderMine, Crypto Whale, Oasis Arcade |
| Health / damage / lives | 76 | 19% | 68 | The Great Escape, Grill Master |
| Collectible / coin / gem | 70 | 19% | 53 | SK8centraLAND, Oasis Arcade |
| Fall reset / try again | 68 | 17% | 60 | Liquid Labyrinth, WonderMine |
| Leaderboard / ranking | 56 | 15% | 54 | Color Pop, Game Night Arena |
| Timer / countdown | 55 | 14% | 51 | Grill Master, WonderMine |
| Elevator / moving platform | 53 | 13% | 49 | Game Night Arena, WonderMine |
| Teleport / portal | 51 | 12% | 41 | META G, CBD Plaza |
| Daily / streak / energy | 42 | 12% | 36 | Oasis Arcade, Color Pop |
| Win / lose / podium | 39 | 11% | 33 | Game Night Arena, Liquid Labyrinth |
| NPC dialog | 44 | 11% | 40 | WonderMine, Meta GamiMall, RAGE Parkour |
| Pet / creature / hatch | 38 | 11% | 30 | Ethermon family, Chubs Club |
| Casino / cards / dice / board games | 40 | 11% | 36 | Euchre, Oasis Arcade |
| Farming / harvest | 42 | 10% | 38 | Old McTiger's Farm, Chicks Coop |
| Inventory / backpack | 42 | 9% | 36 | WonderMine, Ethermon District |
| Enemy / wave / boss | 38 | 9% | 33 | Math Kittens, Ethermon |
| Shoot / weapon | 27 | 9% | 24 | Color Pop, The Great Escape |
| Mining / dig | 30 | 8% | 24 | WonderMine, Meta GamiMall |
| Trivia / quiz | 31 | 8% | 27 | Game Night Arena, Grill Master |
| Craft / recipe | 27 | 7% | 22 | WonderMine, Grill Master |
| Parkour / obstacle | 29 | 7% | 23 | RAGE Parkour, Festive Trail |
| Ball game (soccer, basket, golf) | 25 | 6% | 22 | GolfCraft, Angry Avatars |
| Team | 22 | 5% | 19 | Euchre, Ethermon |
| Fishing | 19 | 5% | 18 | Portal Lake, Old McTiger's Farm |
| Race / kart / vehicle | 14 | 5% | 13 | NFT World City |
| Checkpoint / respawn | 10 | 3% | 10 | Tower Smash Arena, Antrom RPG |

### Infrastructure markers (SDK7, 240 scenes)

`@dcl-sdk/utils` triggers 58% · `TriggerArea` 52% · `MessageBus` 35% · auth-server `isServer` 27% · asset-packs runtime 72% · colyseus 6% (49% of SDK6 scenes that bundle their libraries) · `localStorage` 7% · cannon physics 3%.

### What the most active places right now are about

WonderMine (mine, loot, craft wearables), WOW Nightswarm (horde survival), Portal Lake (fishing, come back later), Antrom RPG (farm, craft, fight), GolfCraft (minigolf, craft materials, seasonal wearables), PaleoVault (dig, hatch, level creatures, offline earnings), Old McTiger's Farm, Bull & Bear (predictions and accuracy ranking).

**The pattern:** the most visited games are **gather → inventory → craft or level up → claim a wearable**, with a daily reason to come back. That loop has no prefab today.

## Mechanics list with verdicts

Effort means building it from scratch without a prefab (S under a day, M a few days, L more than a week).

| # | Mechanic | Seen in | How often | Effort | Covered today | Verdict |
|---|---|---|---|---|---|---|
| 1 | Click or walk-in → animate, text, sound, teleport, emote | Creator Hub actions and triggers | very high (40–60%) | S | asset-packs + `trigger-zone` | **skip** |
| 2 | Video screen and streams | VideoScreen in 63 of 173 composites | high | S | `video-screen` | **skip** |
| 3 | Admin and moderation | AdminTools in 59 of 173 composites | high | M | `admin-tools` | **skip** |
| 4 | Score, leaderboard, timer, rounds | 15–28% of games | high | M | `leaderboard`, `game-flow`, `server-clock` | **skip** (covered) |
| 5 | End-of-match podium and win/lose screen | 11% of games, gap named in #108 | medium | S | partly in `game-flow` | **build** as a `game-flow` extension |
| 6 | Health, damage, fall reset, checkpoints | 17–19% (checkpoints 3%) | high | M | `health-respawn`, `run-progress` | **skip** |
| 7 | Sit spots | 11% | medium | S | `sit-spot` + chairs | **skip** |
| 8 | **Resource node + inventory + crafting** (mine, harvest, fish, dig, then craft) | WonderMine, Portal Lake, Farm, PaleoVault, GolfCraft, Antrom; 8–11% each, together the top genre among active places | high in active games | L | `pickup-item` and `work-station` cover carrying and transforming only, not a backpack or harvest-and-respawn | **build** (prototype #1) |
| 9 | **Player progression: XP, level, daily streak, energy, saved across visits** | 26% XP, 12% daily | high | L (needs persistent storage) | none | **build** (prototype #2); check that the auth server can store data per player |
| 10 | **Quest / objective tracker** (steps, HUD checklist, completion) | 22% of games | high | M | none (`run-progress` only for courses) | **build** |
| 11 | **NPC with dialog** (AvatarShape, dialog tree, idle emote) | 11% (SDK6 npc-scene-utils in 29%) | medium | M | none; depends on #86 for outfits | **build** |
| 12 | Reward / claim wearable or POAP | 20% of games, in most game descriptions | high | M | `admin-tools` airdrop tab only | **needs platform support**: a dispenser prefab tied to the Rewards service, validated by the server |
| 13 | Shop / buy with MANA | 20% | medium | L | none | **needs engine support** (transactions); a soft-currency shop could come with #9 |
| 14 | Collectibles / coins counted per player | 19% | medium | S | `run-progress` collectibles, per course | **build** as part of #8/#9 (one shared currency) |
| 15 | Elevators and moving platforms | 13% | medium | S single-player, L multiplayer | asset-packs tween | **needs engine support** (#38 grounded sync) |
| 16 | Teleporter or portal pad | 12%, plus 40 move/teleport actions | medium | S | asset-packs actions | **skip** (maybe a thin prefab later) |
| 17 | Trivia / quiz | 8% | low | S | none | **later**: cheap, low frequency |
| 18 | Shooting, enemies, waves | 9% (WOW Nightswarm among the most active) | medium | L | `spawner` + `health-respawn` | **needs engine support** (projectiles, raycast, #36) |
| 19 | Ball games and throwing | 6% | low | L | `pickup-item` throws | **needs engine support** (#36 owned physics) |
| 20 | Vehicles, karts, races | 5% | low | L | none | **needs engine support** (#37 attach) |
| 21 | Pets and creatures that follow you | 11% (mostly one family of scenes) | low | M | asset-packs `follow_player` | **skip** for now |
| 22 | Casino, cards, board games | 11% | low | L | none | **skip** (niche and regulated) |

## Recommendation

1. **Prototype first:** the *Resource Node + Inventory* pair (#8). A node is a rock, tree, fishing spot or crop plot that the player harvests by holding E, that gives N items and comes back after a set time. The inventory holds those items per player, with an owned server-side count and a HUD slot. A Work Station recipe then turns items into something else. This is the loop behind most of the currently active games, and it builds on `pickup-item` and `work-station`.
2. **Prototype second:** *Player Progress* (#9), with XP, level, a daily streak and saving across visits. It turns every other prefab into a reason to come back. First check what the auth server can persist per player (#41).
3. **Follow-up issues:** Quest tracker (#10), NPC dialog (#11, with #86), Reward dispenser (#12, a platform conversation) and the `game-flow` podium (#5).
