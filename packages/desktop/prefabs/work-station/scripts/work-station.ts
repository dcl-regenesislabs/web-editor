import type { Entity } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { registerStation } from '~runtime/carry'
import { declareInteractButtons } from '~runtime/interactPrompt'

export class WorkStation {
  constructor(
    public src: string,
    public entity: Entity,
    /** "counter" holds one item; "hold to work" turns it while a player holds F (the phone's second button); "timed" turns it by itself (cooking). */
    public mode: 'counter' | 'hold to work' | 'timed' = 'counter',
    /** What work turns into what, e.g. "Tomato > Chopped Tomato, Lettuce > Chopped Lettuce". */
    public turns: string = '',
    /** Seconds of work (or of waiting, when timed) each turn takes. */
    public seconds: number = 3,
    /** Kinds this station takes, comma-separated; empty takes anything. */
    public accepts: string = '',
    /** Putting one kind on another makes a third, e.g. "Bread + Cheese > Sandwich". */
    public combines: string = '',
    public putVerb: string = 'Put down',
    public takeVerb: string = 'Take',
    public workVerb: string = 'Chop',
    /** Metres a player can be from it to use it. */
    public range: number = 2,
    /** Height above the station's origin where an item sits. */
    public itemHeight: number = 1.05
  ) {}

  start(): void {
    registerStation({
      entity: this.entity,
      mode: this.mode === 'hold to work' ? 'hold' : this.mode,
      accepts: this.accepts,
      turns: this.turns,
      combines: this.combines,
      seconds: this.seconds,
      range: this.range,
      itemHeight: this.itemHeight,
      putVerb: this.putVerb,
      takeVerb: this.takeVerb,
      workVerb: this.workVerb
    })
    if (isServer()) return
    declareInteractButtons(this.mode === 'hold to work' ? 'chop' : undefined)
  }
}
