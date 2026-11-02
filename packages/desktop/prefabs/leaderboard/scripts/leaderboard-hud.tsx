import ReactEcs, { UiEntity } from '@dcl/sdk/react-ecs'
import { isMobile } from '@dcl/sdk/platform'
import { sceneUiTheme } from '~runtime/uiTheme'
import { UiPanel, UiText, uiSizes } from '~runtime/uiComponents'
import { addHudItem, HUD_COLUMN_WIDTH } from '~runtime/hudLayout'
import { formatScore, rowLabel, type BoardRow, type BoardSort } from './pure/board'

export function mountLeaderboardHud(position: 'left' | 'right', read: () => {
  title: string; rows: BoardRow[]; sort: BoardSort; empty: string
}): () => void {
  return addHudItem(position === 'left' ? 'left' : 'right', () => {
    const theme = sceneUiTheme()
    const board = read()
    const phone = isMobile()
    const size = uiSizes('hud', { dense: phone })
    const text = phone ? size.small : 18
    const row = phone ? 30 : 36
    const pad = phone ? 10 : 20
    const heading = phone ? 32 : 60
    const rows = board.rows.slice(0, phone ? 3 : 10)
    return <UiPanel theme={theme} uiTransform={{ width: HUD_COLUMN_WIDTH, height: 2 * pad + heading + Math.max(1, rows.length) * row, padding: pad }}>
      <UiText value={board.title} color={theme.text} size={size.title} height={phone ? 32 : 36} />
      {!phone && <UiText value={board.sort === 'asc' ? 'FASTEST TIMES' : 'HIGH SCORES'} color={theme.muted} size={size.small} height={24} />}
      {rows.length === 0 && <UiText value={board.empty} color={theme.muted} size={text} height={row} />}
      {rows.map((entry) => <UiEntity key={entry.player} uiTransform={{ width: '100%', height: row, pointerFilter: 'none' }}>
        <UiText value={String(entry.rank).padStart(2, '0')} color={theme.accentText} size={text} mono uiTransform={{ width: 36 }} height={row} />
        <UiText value={rowLabel(entry)} color={theme.text} size={text} uiTransform={{ width: 176 }} height={row} />
        <UiText value={formatScore(entry.score, board.sort)} color={theme.text} size={text} mono align="middle-right" uiTransform={{ width: 88 }} height={row} />
      </UiEntity>)}
    </UiPanel>
  }, { order: 20 })
}
