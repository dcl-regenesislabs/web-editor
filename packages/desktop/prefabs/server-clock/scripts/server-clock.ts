import { Entity, TextShape, VisibilityComponent } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { initTimeSync, getServerTime, isTimeSyncReady } from '~runtime/timeSync'
import { mountStatusHud } from '~runtime/statusHud'

// Displays the Multiplayer Server's clock, NTP-synced, identical for every
// player — as floating 3D text, or as a 2D overlay on the player's client. Both
// halves start here: initTimeSync() registers the responder on the server and
// the asking half on the client, so placing the item is all the setup there is.

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

export class ServerClock {
  private accum = 0
  private time = '--:--:--'

  constructor(
    public src: string,
    public entity: Entity,
    /** Label above the time */ public label: string = 'SERVER TIME',
    /** Show in UTC instead of each viewer's timezone */ public utc: boolean = true,
    /** How the clock is shown */ public display: '3D text' | '2D UI' = '3D text',
    /** For "2D UI": where the clock sits on screen. */ public position: 'top' | 'top left' | 'top right' | 'bottom' = 'top'
  ) {}

  private get onScreen(): boolean {
    return this.display === '2D UI'
  }

  start(): void {
    initTimeSync()
    if (isServer()) return
    if (this.onScreen) {
      VisibilityComponent.createOrReplace(this.entity, { visible: false })
      TextShape.deleteFrom(this.entity)
      mountStatusHud(this.position, () => ({ label: this.label, value: this.time }))
    }
    this.render('--:--:--')
  }

  update(dt: number): void {
    if (isServer()) return
    this.accum += dt
    if (this.accum < 0.25) return
    this.accum = 0
    if (!isTimeSyncReady()) return
    this.render(this.formatTime(new Date(getServerTime())))
  }

  private formatTime(d: Date): string {
    const parts = this.utc
      ? [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
      : [d.getHours(), d.getMinutes(), d.getSeconds()]
    return parts.map(pad).join(':')
  }

  private render(time: string): void {
    if (this.onScreen) {
      this.time = time
      return
    }
    TextShape.createOrReplace(this.entity, {
      text: this.label === '' ? time : `${this.label}\n${time}`,
      fontSize: 4,
      textColor: { r: 1, g: 1, b: 1, a: 1 },
      outlineColor: { r: 0, g: 0, b: 0 },
      outlineWidth: 0.1
    })
  }
}
