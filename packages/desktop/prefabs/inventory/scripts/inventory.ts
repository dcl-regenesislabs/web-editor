import type { Entity } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { registerInventory } from '~runtime/inventory'
import { mountInventoryHud } from '~runtime/inventoryHud'

export class Inventory {
  constructor(
    public src: string,
    public entity: Entity,
    /** How many different kinds fit at once; 0 is no limit. */
    public slots: number = 8,
    /** The most of one kind a player can keep; 0 is no limit. */
    public stackSize: number = 99,
    /** Kinds the bag takes, comma-separated, e.g. "Wood, Stone"; empty takes anything. */
    public accepts: string = '',
    /** The bag is saved with the player's data and is still there on their next visit. */
    public keepBetweenVisits: boolean = true,
    /** Every bag empties when a new round starts. */
    public emptyEachRound: boolean = false,
    /** The Bag button's and window's title. */
    public title: string = 'Bag',
    /** The window's button that puts what the player holds into the bag. */
    public storeVerb: string = 'Store',
    /** Shown under each kind in the window: tap it to take one into the hand. */
    public takeVerb: string = 'Take out',
    /** Shown in the window while the bag is empty. */
    public emptyText: string = 'Nothing here yet',
    /** Shown when something does not fit. */
    public fullText: string = 'Your bag is full',
    /** Shown when a player takes one out while holding something. */
    public handsFullText: string = 'Your hands are full',
    /** Shown when a player stores with nothing in their hands. */
    public emptyHandsText: string = 'Nothing in your hands'
  ) {}

  start(): void {
    const registered = registerInventory({
      slots: this.slots,
      stackSize: this.stackSize,
      accepts: this.accepts,
      keepBetweenVisits: this.keepBetweenVisits,
      emptyEachRound: this.emptyEachRound,
      fullText: this.fullText,
      handsFullText: this.handsFullText,
      emptyHandsText: this.emptyHandsText
    })
    if (!registered || isServer()) return
    mountInventoryHud({ title: this.title, storeVerb: this.storeVerb, takeVerb: this.takeVerb, emptyText: this.emptyText })
  }
}
