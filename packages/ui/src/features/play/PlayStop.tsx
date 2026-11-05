import type { ReactNode } from 'react'
import { state } from '@scene/state'
import { uiPause } from '../../actions/playback'
import { uiSetPlayInspect } from '../../actions/viewport'
import { useStore } from '../../core/store'
import { labelTip } from '../../ds'
import { IconStopPlay } from '../../icons'
import { advancedOffered } from '../editor/entry-mode'

// The one piece of editor chrome left while playing: the game's state beside a
// way out. The scene's own UI owns the rest of the screen.
export function PlayStop(props: { onLogs: () => void; overLogs?: boolean; children?: ReactNode }): JSX.Element {
  const inspecting = useStore(() => state.playInspect)
  return (
    <div className={props.overLogs === true ? 'eui-play-bar over-logs' : 'eui-play-bar'}>
      {props.children}
      <span className="eui-play-note">Playing — changes won’t be saved</span>
      {/* inspecting is the whole editor over the game */}
      {advancedOffered() && (
        <button
          className="eui-play-btn"
          aria-pressed={inspecting}
          {...labelTip(inspecting ? 'Back to the full-screen game' : 'Show the editor over the running game. Changes revert on Stop')}
          onClick={() => uiSetPlayInspect(!inspecting)}
        >
          Inspect
        </button>
      )}
      <button className="eui-play-btn" {...labelTip('Scene and server logs')} onClick={props.onLogs}>
        Logs
      </button>
      <button
        className="eui-play-btn"
        {...labelTip('Playing — changes won’t be saved. Stop to go back to editing (F5)')}
        onClick={() => void uiPause()}
      >
        <IconStopPlay />
        Stop
        <kbd className="eui-kbd">F5</kbd>
      </button>
    </div>
  )
}
