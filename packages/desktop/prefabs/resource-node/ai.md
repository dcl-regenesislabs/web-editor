---
prefab: resource-node
claims-globals: __dclHarvest_v1
claims-state: game.state.harvest
claims-rpc: harvest.act
claims-messages: harvest.event
---

# Resource Node — AI guide

A rock, tree, bush or fishing spot players gather from. The player presses E
beside it, stays while a bar fills, and its kind lands in their right hand as a
carried item. After a few uses it runs out, says when it comes back, and refills. The
Multiplayer Server decides who gathers and what is left.

The project copy is normally custom/resource_node/ — check what is on disk, a
second copy is custom/resource_node_2/.

## When to use

Any gather step: chop a tree for Wood, mine a rock for Stone, fish a pond, pick
berries. Place ONE per node; its Name is its id. What it gives is an ordinary
carried item, so Work Station recipes ("Wood > Plank") and the carry API work on
it unchanged; if placed, read custom/work_station/ai.md and
custom/pickup_item/ai.md. Never hand-roll a gather timer, a charges counter, a
respawn timer or an "[E] Mine" label: this prefab does all of it, on phones too.

## API

Params (set them in the placePrefab request):

- `kind`: what a player gets ("Wood"), matched trimmed and case-insensitively.
- `gatherVerb`: the prompt word ("Chop", "Mine", "Fish"). "{item}" marks where
  the kind goes, otherwise it follows the verb. Use the scene's language.
- `seconds`: how long the player stays beside it for one; 0 is instant.
- `uses`: how many it gives before it runs out; 0 never runs out.
- `respawnSeconds`: from running out to coming back full; 0 waits for the next
  round.
- `whenEmpty`: "show timer" (default) keeps it in place, solid, with a floating
  countdown; "hide" makes it disappear (its own collider off) until it is back.
- `emptyText`: the countdown line, "{time}" marks where "0:24" goes ("Vuelve en
  {time}"). `emptyRoundText`: the line when `respawnSeconds` is 0. Use the
  scene's language.
- `range`: metres to start gathering; walking further away cancels it.
- `barHeight`: where the progress bar and the countdown float above the node's
  origin.

The look is the node entity's own model: give it a GltfContainer (or keep the
sphere and set its Material).

What the item looks like in the hand comes from a Pickup Item with the same
`kind`. Place one with `supply` "look only" for every kind a node gives; without
it the hand shows a plain box.

Controls: E / the phone's main button starts gathering when the hand is empty.
With something in hand the node offers nothing: the player drops or uses it
first. Only one player gathers a node at a time.

Script API: `src/scripts/runtime/harvest.ts`, imported as `./runtime/harvest`.
Read the module header in that file (onHarvest, usesLeft, isGathering,
refillNode). Never restate it from memory. What lands in the hand is handled by
`./runtime/carry` (heldBy, takeItem).

Every round start refills every node.

## Do / Don't

- DON'T keep your own charges or cooldown map; read `usesLeft(name)`.
- DO call `refillNode` only inside `if (isServer())`.
- DON'T hide, move or delete the node entity yourself, or add your own "empty"
  sign; set `whenEmpty` and the texts instead.
- DO give each node its own Name; two nodes with one Name are refused.

## Example

"Players chop trees and turn the wood into planks at a saw bench": place a
Resource Node named "Oak Tree" (`kind` "Wood", `gatherVerb` "Chop", tree model),
a Pickup Item named "Wood Look" (`kind` "Wood", `supply` "look only"), a Pickup
Item "Plank Look" (`kind` "Plank", "look only") and a Work Station "Saw Bench"
(`mode` "hold to work", `turns` "Wood > Plank", `workVerb` "Saw"). No script is
needed. To count planks, src/scripts/PlankCount.ts:

```ts
import { Entity } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { game } from './runtime/game'
import { onStation } from './runtime/carry'

export class PlankCount {
  constructor(public src: string, public entity: Entity) {}
  start(): void {
    if (!isServer()) return
    onStation('Saw Bench', (event) => {
      if (event.type !== 'done') return
      const planks = Number(game.state.planks ?? 0) + 1
      game.setState({ planks })
    })
  }
}
```
