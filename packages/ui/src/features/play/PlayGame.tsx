import { useEffect, useMemo, useRef, useState } from 'react'
import { state } from '@scene/state'
import { cmd } from '../../engine/cmd'
import { hostV1 } from '../../engine/hosted'
import { log } from '../../log'
import { Chip } from '../../ds'
import { useStore } from '../../core/store'
import { consumerStore, ensureConsumersLoaded } from '../../prefabs/consumers'
import { sceneScriptRows } from '../editor/scene-check-model'
import { usesGame } from '../../script/uses-game'
import { GAME_LOG_TAIL, GAME_POLL_MS, gameLife, gameStrip, parseGameLife, withProblems, type GameLife, type ServerPresence } from './game-life'
import { beginRun, runProblems } from './run-window'
import { readServerPresence } from './server-presence'

const TICK_MS = 1000

// `logsLink: false` where the surrounding bar already offers the logs
export function PlayGame(props: { onLogs: () => void; logsLink?: boolean }): JSX.Element | null {
  const scripts = useStore(() => consumerStore.scripts)
  const snapshot = useStore(() => state.snapshot)
  const [reported, setReported] = useState<{ life: GameLife; at: number } | null>(null)
  const [server, setServer] = useState<ServerPresence>('unknown')
  const [now, setNow] = useState(() => Date.now())
  const [problems, setProblems] = useState(0)
  const startedAt = useRef(Date.now())
  const seen = useRef<GameLife | null>(null)
  const attached = useMemo(() => sceneScriptRows(snapshot).map((row) => row.path), [snapshot])
  const game = useMemo(() => usesGame(scripts, attached), [scripts, attached])
  useEffect(() => ensureConsumersLoaded(), [])
  useEffect(() => {
    if (!game) return
    startedAt.current = Date.now()
    setNow(Date.now())
    const seeded = beginRun()
    setProblems(0)
    let live = true
    seen.current = null
    setServer('unknown')
    readServerPresence()
      .then((presence) => {
        if (live) setServer(presence)
      })
      .catch((e) => log.debug('server presence probe failed', e))
    const poll = (): void => {
      cmd
        .sceneLogs(GAME_LOG_TAIL)
        .then((text) => {
          if (!live) return
          setProblems(runProblems(text))
          const next = parseGameLife(text)
          if (next === null || next === seen.current) return
          seen.current = next
          setReported({ life: next, at: Date.now() })
        })
        .catch((e) => log.debug('game-life poll failed', e))
    }
    poll()
    seeded.then(poll).catch((e) => log.debug('shell backlog read failed', e))
    const polling = setInterval(poll, GAME_POLL_MS)
    const ticking = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => {
      live = false
      clearInterval(polling)
      clearInterval(ticking)
    }
  }, [game])
  if (!game) return null
  const restartServer = hostV1()?.previewChanged
  // the client's last unreachable line stays in the tail; `seen` keeps it from reddening the strip again
  const restart = (): void => {
    restartServer?.()
    startedAt.current = Date.now()
    setReported(null)
    setNow(Date.now())
  }
  const life = gameLife(reported?.life ?? null, now - startedAt.current, server)
  // a healthy running game is the normal case; the bar speaks only when something is off
  if (life === 'running' && problems === 0) return null
  const since = reported?.at ?? startedAt.current
  const strip = withProblems(gameStrip(life, (now - since) / 1000), problems)
  return (
    <div className="eui-play-game">
      <Chip tone={strip.tone} tip={strip.text}>
        {strip.text}
        {strip.logs && props.logsLink !== false && (
          <button className="eui-play-game-logs" onClick={props.onLogs}>
            Logs
          </button>
        )}
        {strip.restart && restartServer !== undefined && (
          <button className="eui-play-game-logs" onClick={restart}>
            Restart
          </button>
        )}
      </Chip>
    </div>
  )
}
