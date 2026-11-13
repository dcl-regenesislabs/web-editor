import type { Entity } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { registerPickup } from '~runtime/carry'
import { declareInteractButtons } from '~runtime/interactPrompt'

// the emote files ship in this prefab's emotes/ folder; "from the floor" holds the picker still while it plays
const PICK_EMOTES = {
  'from a table': { file: 'emotes/Pickup_Table_emote.glb', holdSeconds: 0 },
  'from the floor': { file: 'emotes/Pickup_Floor_emote.glb', holdSeconds: 1.9 }
}

export class PickupItem {
  constructor(
    public src: string,
    public entity: Entity,
    /** What this is, e.g. "Tomato". Stations, recipes and scripts match items by this word. */
    public kind: string = 'Item',
    /** "one item" is this thing itself; "endless" hands out a new one every time (a crate); "look only" is hidden and only gives the kind its look. */
    public supply: 'one item' | 'endless' | 'look only' = 'one item',
    /** The prompt's verb; "{item}" marks where the kind goes, otherwise it follows the verb. */
    public pickVerb: string = 'Pick up',
    public dropVerb: string = 'Drop',
    public throwable: boolean = false,
    public throwVerb: string = 'Throw',
    /** Metres a player can be from it to pick it up. */
    public range: number = 2,
    /** Size in the hand, relative to the placed size. */
    public heldScale: number = 1,
    /** After a script uses it up, it comes back home after this many seconds; 0 waits for the next round. */
    public returnSeconds: number = 0,
    /** The picker reaches for it: "from the floor" squats and holds them still for 2 s. Off keeps a fast game fast. */
    public pickAnimation: 'none' | 'from a table' | 'from the floor' = 'none'
  ) {}

  start(): void {
    const emote = this.pickAnimation === 'none' ? null : PICK_EMOTES[this.pickAnimation]
    // src is the script's directory (custom/<slug>/scripts); the emotes sit one level up
    const root = this.src.replace(/\/scripts\/?$/, '')
    registerPickup({
      entity: this.entity,
      kind: this.kind,
      supply: this.supply,
      range: this.range,
      pickVerb: this.pickVerb,
      dropVerb: this.dropVerb,
      throwVerb: this.throwVerb,
      throwable: this.throwable,
      heldScale: this.heldScale,
      returnSeconds: this.returnSeconds,
      pickEmote: emote === null ? '' : `${root}/${emote.file}`,
      pickHoldSeconds: emote?.holdSeconds ?? 0
    })
    if (isServer() || this.supply === 'look only') return
    declareInteractButtons(this.throwable ? 'throw' : undefined)
  }
}
