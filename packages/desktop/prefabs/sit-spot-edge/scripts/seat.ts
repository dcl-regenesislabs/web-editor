// Sit on this seat. The behaviour is the shared ~runtime/seat module (Creator
// Hub's Seat.ts, with synced occupancy), so every seat prefab runs one copy of
// it; this file only names what the inspector shows and the actions it offers.
import type { Entity } from '@dcl/sdk/ecs'
import { SeatBehavior } from '~runtime/seat'

// emote .glb files bundled in this prefab's folder (Genesis Plaza-style custom
// poses, played via triggerSceneEmote); empty = the predefined chair emotes
const SCENE_EMOTES: string[] = ['emotes/Sit_Edge1_emote.glb', 'emotes/Sit_Edge2_emote.glb']

export class Seat extends SeatBehavior {
  constructor(
    public src: string,
    public entity: Entity,
    /** Text shown when the player points at the seat. */
    public hoverText: string = 'Sit Here',
    /** Shown as the hover hint, and on screen when the Sit action is called, while every spot is taken. Leave empty for no message. */
    public takenMessage: string = 'Seat is taken'
  ) {
    super(src, entity, hoverText, takenMessage, { sceneEmotes: SCENE_EMOTES })
  }

  /**
   * Sits the player on the nearest free sit spot, or shows the taken message if every spot is taken
   * @action
   */
  sit(): void {
    super.sit()
  }

  /**
   * Marks every sit spot of this seat as free
   * @action
   */
  markAsFree(): void {
    super.markAsFree()
  }
}
