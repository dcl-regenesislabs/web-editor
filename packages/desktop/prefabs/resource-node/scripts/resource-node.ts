import type { Entity } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { registerNode } from '~runtime/harvest'
import { declareInteractButtons } from '~runtime/interactPrompt'

export class ResourceNode {
  constructor(
    public src: string,
    public entity: Entity,
    /** What a player gets, e.g. "Wood". Work Stations, recipes and scripts match items by this word. */
    public kind: string = 'Wood',
    /** The prompt's verb, e.g. "Chop", "Mine", "Fish"; "{item}" marks where the kind goes, otherwise it follows the verb. */
    public gatherVerb: string = 'Gather',
    /** Seconds a player stays beside it for one; 0 is instant. */
    public seconds: number = 2,
    /** How many it gives before it runs out; 0 never runs out. */
    public uses: number = 3,
    /** Seconds from running out to coming back; 0 waits for the next round. */
    public respawnSeconds: number = 30,
    /** While it is empty: "show timer" keeps it in place with a floating countdown; "hide" makes it disappear until it is back. */
    public whenEmpty: 'show timer' | 'hide' = 'show timer',
    /** The countdown line; "{time}" marks where the wait goes ("0:24"), otherwise it follows the text. */
    public emptyText: string = 'Back in {time}',
    /** The line shown instead when it only comes back with the next round (respawnSeconds 0). */
    public emptyRoundText: string = 'Back next round',
    /** Metres a player can be from it to gather, and must stay within while gathering. */
    public range: number = 2,
    /** Height above the node's origin where the progress bar floats. */
    public barHeight: number = 1.6
  ) {}

  start(): void {
    registerNode({
      entity: this.entity,
      kind: this.kind,
      gatherVerb: this.gatherVerb,
      seconds: this.seconds,
      uses: this.uses,
      respawnSeconds: this.respawnSeconds,
      whenEmpty: this.whenEmpty,
      emptyText: this.emptyText,
      emptyRoundText: this.emptyRoundText,
      range: this.range,
      barHeight: this.barHeight
    })
    if (isServer()) return
    declareInteractButtons()
  }
}
