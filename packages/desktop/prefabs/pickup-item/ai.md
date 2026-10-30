---
prefab: pickup-item
claims-state: game.state.carry
claims-rpc: carry.act
claims-messages: carry.event
---

# Pickup Item — AI guide

Something a player picks up, carries in the right hand, drops or throws. The
Multiplayer Server decides the one holder; every player sees who holds what.

The project copy is normally custom/pickup_item/ — check what is on disk.

## When to use

Anything a player picks up and carries: a ball, a key, a box, a package, an
ingredient. Place ONE per item, or ONE with `supply` "endless" for a crate that
hands out the same thing forever. Never hand-roll AvatarAttach, a holder map, an
E-key system or a "[E] Pick up" label: this prefab does all of it, on phones too.
Putting items on counters, chopping and cooking is the Work Station prefab; if
placed, read custom/work_station/ai.md.

## API

Params (set them in the placePrefab request):

- `kind`: what it is ("Tomato"). Stations, recipes and scripts match this word,
  trimmed and case-insensitively.
- `supply`: "one item" (this thing; hidden at home while someone has it),
  "endless" (a crate: each pick makes a new one, the crate stays), "look only"
  (hidden; only gives its `kind` a look, e.g. the "Chopped Tomato" a station
  makes — place one anywhere for every kind a station or script creates).
- `pickVerb`, `dropVerb`, `throwVerb`: prompt words. "{item}" marks where the
  kind goes ("Coger {item}"), otherwise it follows the verb. Use the scene's language.
- `throwable`: F (the phone's second button) throws it ~6 m ahead.
- `range`: metres to pick it up (default 2).
- `heldScale`: size in the hand relative to the placed size.
- `returnSeconds`: a "one item" a script used up comes home after this; 0 waits
  for the next round.

The look is the entity's own model: give the Pickup Item entity the GltfContainer
(or keep the box and set its Material). Child models are copied too. Its Name is
the item id. Every round start empties all hands and sends items home.

Controls: E / the phone's main button picks up; with nothing near it drops.
One floating label sits over the nearest usable thing ("[E] Pick up Tomato" on
desktop, "Pick up Tomato" on a phone). The player sees the pick at once; if the
server refuses (someone was faster) it rolls back with a short notice. The
prefab declares its touch buttons (E, jump, and F when throwable).

No carry pose: the item rides in the right hand. No looping carry emote ships
with the editor, and the pinned SDK cannot stop a looping emote.

Script API: `src/scripts/runtime/carry.ts`, imported as `./runtime/carry` —
read the module header in that file (heldBy, holderOf, onCarry, giveItem,
takeItem…). Never restate it from memory.

## Do / Don't

- DON'T keep your own "who holds what" state or a `game.onRequest('pickup', …)`;
  read `heldBy(player)` / `holderOf(name)`.
- DO call `giveItem` / `takeItem` only inside `if (isServer())`.
- DON'T move, hide or delete the Pickup Item entity yourself; the module hides
  it and draws a copy in the hand.
- DON'T use Spawner copies as pickups: they are client-local and nameless. Use
  `supply` "endless".

## Example

"Players carry the key to the gate to open it": place a Pickup Item named
"Gate Key" (`kind` "Key", the key model on it) and a Trigger Area "Gate Zone".
Then src/scripts/GateKey.ts:

```ts
import { Entity } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { game } from './runtime/game'
import { heldBy, takeItem } from './runtime/carry'

export class GateKey {
  constructor(public src: string, public entity: Entity) {}
  start(): void {
    if (!isServer()) return
    game.onEnterArea('Gate Zone', (player) => {
      if (heldBy(player)?.kind !== 'Key') return
      takeItem(player)
      game.setState({ gateOpen: true })
    })
  }
}
```

For carry-to-station flows (chop, cook, deliver), see the Work Station guide.
