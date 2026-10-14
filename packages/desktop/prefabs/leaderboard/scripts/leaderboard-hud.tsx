import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { isMobile } from '@dcl/sdk/platform'
import { sceneUiTheme } from '~runtime/uiTheme'
import { UiPanel, UiText } from '~runtime/uiComponents'
import { addHudItem, HUD_COLUMN_WIDTH } from '~runtime/hudLayout'
import { formatScore, rowLabel, type BoardRow, type BoardSort } from './pure/board'

const ROW = 36

export function mountLeaderboardHud(position: 'left' | 'right', read: () => {
  title: string; rows: BoardRow[]; sort: BoardSort; empty: string
}): () => void {
  return addHudItem(position === 'left' ? 'left' : 'right', () => {
    const theme = sceneUiTheme()
    const board = read()
    // a phone's screen is a third shorter
    const rows = board.rows.slice(0, isMobile() ? 5 : 10)
    return <UiPanel theme={theme} uiTransform={{ width: HUD_COLUMN_WIDTH, height: 100 + Math.max(1, rows.length) * ROW, padding: 20 }}>
      <UiText value={board.title} color={theme.text} size={24} height={36} />
      <UiText value={board.sort === 'asc' ? 'FASTEST TIMES' : 'HIGH SCORES'} color={theme.muted} size={16} height={24} />
      {rows.length === 0 && <UiText value={board.empty} color={theme.muted} size={16} height={ROW} />}
      {rows.map((row) => <UiEntity key={row.player} uiTransform={{ width: '100%', height: ROW, pointerFilter: 'none' }}>
        <UiText value={String(row.rank).padStart(2, '0')} color={theme.accentText} size={16} mono uiTransform={{ width: 36 }} height={ROW} />
        <UiText value={rowLabel(row)} color={theme.text} size={18} uiTransform={{ width: 176 }} height={ROW} />
        <UiText value={formatScore(row.score, board.sort)} color={theme.text} size={18} mono align="middle-right" uiTransform={{ width: 88 }} height={ROW} />
      </UiEntity>)}
    </UiPanel>
  }, { order: 20 })
}
