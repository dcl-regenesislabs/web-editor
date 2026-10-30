import { InputAction, type Entity } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { registerPickup } from '~runtime/carry'
import { declareTouchButtons } from '~runtime/hudLayout'

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
    public returnSeconds: number = 0
  ) {}

  start(): void {
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
      returnSeconds: this.returnSeconds
    })
    if (isServer() || this.supply === 'look only') return
    const buttons = [InputAction.IA_PRIMARY, InputAction.IA_JUMP]
    if (this.throwable) buttons.push(InputAction.IA_SECONDARY)
    declareTouchButtons(buttons, { main: InputAction.IA_PRIMARY })
  }
}
