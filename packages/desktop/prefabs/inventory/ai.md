---
prefab: inventory
claims-globals: __dclInventory_v1
claims-state: game.state.inventory
claims-rpc: inventory.act
claims-messages: inventory.event
---

# Inventory — AI guide

Every player's bag: a count per kind ("Wood ×7, Stone ×3") that the Multiplayer
Server keeps and, by default, saves with the player's data, so it is still there
on their next visit. The 1 key (a bag button on phones) or the Bag button on
screen opens a window where the player stores what they carry or takes one kind
out into their hand.

The project copy is normally custom/inventory/ — check what is on disk. Place
ONE per scene: a second one is refused.

## When to use

Anything players collect and keep more than one of: wood and stone, fish,
coins, keys, ingredients, crafted tools. Items reach the bag two ways: the
player stores what they carry (a Pickup Item; if placed, read
custom/pickup_item/ai.md), or a script calls `addItems`. A Work Station works
on a carried item, so the player takes one out of the bag into their hand and
carries it there (read custom/work_station/ai.md). Never hand-roll a per-player
item map, a backpack HUD or your own Storage rows for items.

## API

Params (set them in the placePrefab request):

- `slots`: how many different kinds fit at once; 0 is no limit.
- `stackSize`: the most of one kind a player keeps; 0 is no limit.
- `accepts`: kinds the bag takes, comma-separated ("Wood, Stone"); empty takes
  anything.
- `keepBetweenVisits`: true (default) saves the bag with the player's data.
- `emptyEachRound`: true empties every bag when a round starts.
- `title`, `storeVerb`, `takeVerb`, `emptyText`, `fullText`, `handsFullText`,
  `emptyHandsText`: the button, window and notice words. Use the scene's
  language.

Controls: the 1 key opens and closes the bag; on phones a bag touch button does.
The window frees the desktop cursor so it can be clicked. Don't bind the 1 key
or IA_ACTION_3 to anything else in a scene with an Inventory.

Script API: `src/scripts/runtime/inventory.ts`, imported as `./runtime/inventory`.
Read the module header in that file (countOf, bagOf, roomFor, onInventory,
addItems, removeItems). Never restate it from memory. What a player holds in
their hand is `./runtime/carry` (heldBy), a separate slot from the bag.

The bag is saved under the key 'inventory' of game.playerData: never write that
key yourself.

## Do / Don't

- DO call `addItems` / `removeItems` only inside `if (isServer())`; they answer
  how many went in and whether the items were there, so check the answer.
- DO check `roomFor` for a reward before spending with `removeItems`, which
  takes all `n` or nothing, so a player never goes below 0.
- DON'T keep your own count of a player's items; read `countOf`.
- DON'T draw your own bag HUD; set `title` and the texts instead.

## Example

"Players collect coins and trade 5 Coin for a key at a shop counter": place an
Inventory, Pickup Items named "Coin 1", "Coin 2"… (`kind` "Coin") and a Trigger
Area named "Shop". Players store each coin with the 1 key. Then
src/scripts/CoinShop.ts:

```ts
import { Entity } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { game } from './runtime/game'
import { addItems, removeItems, roomFor } from './runtime/inventory'

export class CoinShop {
  constructor(public src: string, public entity: Entity) {}
  start(): void {
    if (!isServer()) return
    game.onEnterArea('Shop', (player) => {
      if (roomFor(player, 'Key') < 1 || !removeItems(player, 'Coin', 5)) return
      addItems(player, 'Key', 1)
    })
  }
}
```
