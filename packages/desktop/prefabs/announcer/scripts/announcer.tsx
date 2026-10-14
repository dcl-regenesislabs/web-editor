import ReactEcs from '@dcl/sdk/react-ecs'
import type { Entity } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { game } from '~runtime/game'
import { sceneUiTheme } from '~runtime/uiTheme'
import { UiNotice } from '~runtime/uiComponents'
import { addHudItem } from '~runtime/hudLayout'
import { onZone } from '~runtime/zoneBus'
import type { ZoneName } from '~runtime/authoring'
import { clampHold, toastText } from './pure/toast'

const ANNOUNCE = 'announce'

export class Announcer {
  private text = ''
  private leftS = 0

  constructor(
    public src: string,
    public entity: Entity,
    /** How long a message stays up. */
    public holdSeconds: number = 4,
    /** Text size at 1920×1080. */
    public fontSize: number = 20,
    public zone: ZoneName = '',
    public message: string = 'Welcome!',
    public when: 'enter' | 'exit' = 'enter'
  ) {}

  start(): void {
    if (isServer()) { return }
    addHudItem('top', () => this.render(), { order: 40 })
    game.onBroadcast(ANNOUNCE, (data: unknown) => this.show(data))
    if (this.zone !== '') onZone(this.zone, this.when, (event) => {
      if (event.local) this.show({ text: this.message })
    })
  }

  update(dt: number): void {
    if (isServer()) { return }
    if (this.leftS <= 0) return
    this.leftS -= dt
    if (this.leftS <= 0) this.text = ''
  }

  private show(data: unknown): void {
    const text = toastText(data)
    if (text === null) return
    this.text = text
    this.leftS = clampHold(this.holdSeconds)
  }

  private render(): ReactEcs.JSX.Element | null {
    if (this.text === '') return null
    return <UiNotice theme={sceneUiTheme()} text={this.text} fontSize={this.fontSize} uiTransform={{ width: 520, maxWidth: '100%' }} />
  }
}
