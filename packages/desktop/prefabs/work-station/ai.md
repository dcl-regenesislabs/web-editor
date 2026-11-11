---
prefab: work-station
---

# Work Station — AI guide

A spot where a carried item is put down and taken back, and optionally worked
on until it becomes another kind: chop, wash, cook. The Multiplayer Server
decides; the player sees the result at once.

The project copy is normally custom/work_station/ — check what is on disk.
Items come from the Pickup Item prefab; read custom/pickup_item/ai.md too.

## When to use

Counters, chopping boards, sinks, stoves, ovens, delivery windows, crafting
benches: anything that holds one carried item. Never write your own put-down /
progress-bar / hold-F code: this prefab does all of it, on phones too.

## API

Params (set them in the placePrefab request):

- `mode`: "counter" (holds one item), "hold to work" (progress only while a
  player holds F / the phone's second button and stays near; letting go keeps
  the progress), "timed" (progress runs by itself once the item is down —
  cooking; after one turn it continues into the next recipe, so
  "Soup > Burnt Soup" burns it).
- `turns`: recipes, "Tomato > Chopped Tomato, Lettuce > Chopped Lettuce".
- `seconds`: seconds each turn takes.
- `accepts`: comma-separated kinds it takes; empty takes anything.
- `combines`: putting one kind on another, "Bread + Cheese > Sandwich" (either
  order). Without a combine, an occupied station refuses a second item.
- `putVerb`, `takeVerb`, `workVerb`: prompt words ("{item}" places the kind),
  in the scene's language. `workVerb` defaults to "Chop": set "Wash", "Knead"…
- `range`: metres to use it (default 2).
- `itemHeight`: where the item sits above the station's origin (the default
  box top is at 0.9).

The station's Name is its id. Its look is the "Work Station Top" child: replace
that box with a model (or put a model on it). A progress bar floats over the
station while work runs. Every round start empties every station.

Each kind a station makes needs a look: place a Pickup Item with `supply` "look
only" and that `kind` (e.g. "Chopped Tomato" with its model) anywhere.

Script hooks live in `src/scripts/runtime/carry.ts` (`./runtime/carry`) — read
the module header there: `onStation(name, fn)` for put/take/combine/done events,
`setRecipe` / `setCombine` (call on BOTH sides, outside `isServer()`),
`putOnStation` / `takeFromStation` / `stationItem` / `stationProgress`.

## Do / Don't

- DON'T count progress or swap kinds in your own `game.every`; use `turns` or
  `setRecipe`.
- DO react to a delivery with `onStation` inside `if (isServer())`, then clear
  the station with `takeFromStation`.
- DON'T put one Work Station on top of another; give each its own Name.

## Example

"A co-op cooking game: chop tomatoes and serve them for points". Place:
Pickup Item "Tomato Crate" (`kind` "Tomato", `supply` "endless"); Pickup Item
"Chopped Tomato Look" (`kind` "Chopped Tomato", `supply` "look only"); Work
Station "Chopping Board" (`mode` "hold to work", `turns` "Tomato > Chopped
Tomato", `seconds` 3); Work Station "Serving Window" (`accepts` "Chopped
Tomato", `putVerb` "Serve"). Then src/scripts/Serving.ts:

```ts
import { Entity } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { game } from './runtime/game'
import { onStation, takeFromStation } from './runtime/carry'

export class Serving {
  constructor(public src: string, public entity: Entity) {}
  start(): void {
    if (!isServer()) return
    onStation('Serving Window', (event) => {
      if (event.type !== 'put' || event.player === undefined) return
      takeFromStation('Serving Window')
      const rows = (Array.isArray(game.state.served) ? game.state.served : []) as Array<{ player: string; score: number }>
      const mine = rows.find((row) => row.player === event.player)
      const others = rows.filter((row) => row !== mine)
      game.setState({ served: [...others, { player: event.player, score: (mine?.score ?? 0) + 10 }] })
    })
  }
}
```

A Leaderboard with `boardKey` "served" shows it.
