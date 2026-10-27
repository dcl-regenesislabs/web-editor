// A board on a panel. It reads one `game.state` key and paints it — nothing
// here decides a score, and nothing here stores one. The server writes the rows
// (see ai.md in this folder for the idiom); two boards pointed at two keys are
// two independent boards in one scene, and two pointed at the same key show the
// same thing on both walls.
//
// The panel is ordinary scene content: swap board-panel.glb for your own model
// and keep (or restyle) the text child — the script writes only its `text`, so
// font, size and colour stay exactly as authored.
// The text sits on the panel's -z face, where players read it (a TextShape reads
// from -z); a replacement model must face the same way.
import { TextShape, Transform, VisibilityComponent, engine, type Entity } from '@dcl/sdk/ecs'
import { isServer } from '@dcl/sdk/network'
import { game } from '~runtime/game'
import { boardRows, clampRows, renderPanel } from './pure/board'
import { runBoardKey } from '~runtime/pure/runBoard'
import { playerName } from '~runtime/playerPositions'
import { mountLeaderboardHud } from './leaderboard-hud'

const NAME_REFRESH_S = 1

const EMPTY_TIMES = 'No times yet — be the first!'
const EMPTY_SCORES = 'No scores yet — be the first!'

export class Leaderboard {
  private panel: Entity | null = null
  private painted = ''

  constructor(
    public src: string,
    public entity: Entity,
    /** The panel's title. */
    public title: string = 'Leaderboard',
    /** For "State key": the game.state key containing the server's scores. */
    public boardKey: string = 'leaderboard',
    /** For "State key": highest keeps points, lowest keeps best times. */
    public sort: 'desc' | 'asc' = 'desc',
    /** How many places the panel lists. */
    public rows: number = 8,
    public source: 'State key' | 'Run best times' = 'State key',
    /** For "Run best times": match the Course Id on Run Progress. */
    public courseId: string = 'course',
    public display: '3D panel' | '2D UI' = '3D panel',
    /** For "2D UI": the side of the screen. */
    public position: 'left' | 'right' = 'right'
  ) {}

  start(): void {
    if (isServer()) { return }
    if (this.display === '2D UI') {
      VisibilityComponent.createOrReplace(this.entity, { visible: false, propagateToChildren: true })
      mountLeaderboardHud(this.position, () => this.content())
      return
    }
    this.panel = this.findPanel()
    game.onStateChange(() => this.repaint())
    // Avatar names arrive after the rows do, and with no state change to repaint on.
    let wait = 0
    engine.addSystem((dt) => {
      wait += dt
      if (wait < NAME_REFRESH_S) return
      wait = 0
      this.repaint()
    })
    this.repaint()
  }

  private repaint(): void {
    const content = this.content()
    this.paint(
      renderPanel(content.title, content.rows, content.sort, content.empty)
    )
  }

  private content() {
    const runs = this.source === 'Run best times'
    const sort: 'asc' | 'desc' = runs ? 'asc' : this.sort
    const rows = boardRows(game.state[runs ? runBoardKey(this.courseId) : this.boardKey], sort, clampRows(this.rows))
      .map((row) => ({ ...row, name: playerName(row.player) ?? row.name }))
    return { title: this.title, sort, rows,
      empty: sort === 'asc' ? EMPTY_TIMES : EMPTY_SCORES }
  }

  // The text lives on a child so the model can be replaced without touching it.
  private findPanel(): Entity {
    for (const [entity, transform] of engine.getEntitiesWith(Transform)) {
      if (transform.parent === this.entity && TextShape.getOrNull(entity) !== null) return entity
    }
    return this.entity
  }

  private paint(text: string): void {
    const panel = this.panel
    if (panel === null || text === this.painted) return
    this.painted = text
    const shape = TextShape.getMutableOrNull(panel)
    if (shape !== null) {
      shape.text = text
      return
    }
    TextShape.createOrReplace(panel, { text, fontSize: 0.6, textWrapping: true, width: 1.5 })
  }
}
