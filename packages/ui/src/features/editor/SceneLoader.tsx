import { useEffect, useRef, useState } from 'react'
import type { ServersReady } from '@dcl-editor/contract'
import { Button, Spinner } from '../../ds'
import { setDataLayerRealm } from '../../engine/datalayer'
import { isHosted } from '../../engine/hosted'
import { folderName } from '../../lib/format'
import { useStore } from '../../core/store'
import { AiPanel } from '../../panels/AiPanel'
import { aiStore, openCodeAt } from '../../panels/ai-store'
import { BackButton } from './BackButton'
import { Editor } from './Editor'
import { errorLocation, stripAnsi, useSceneHealth } from './scene-health'

// Scene-loading lifecycle: the page lands here (with ?project, no realm) while
// main starts the scene servers. Streams build logs; on servers-ready it mounts
// the editor (iframe in background, engine-init overlay until ready); on error
// it shows the failure + logs instead of a frozen screen.
export function SceneLoader(props: { project: string }): JSX.Element {
  const shell = window.editorShell
  const [ready, setReady] = useState<ServersReady | null>(null)
  // each push is a new preview of the project (a relaunch after its parcels changed), which the editor
  // puts the engine on; the pull only stands in for a push this page missed
  const [session, setSession] = useState(0)
  const applied = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  // hosted the id is a slug the creator never typed: name the scene by its title
  const [title, setTitle] = useState<string | null>(null)
  const pre = useRef<HTMLPreElement>(null)
  // A code error in the scene kills `sdk-commands start` at the bundling step,
  // so the server never comes up and main gives up after its restarts. With the
  // server dead there is NO file watcher — fixing the file triggers nothing —
  // which is why this screen needs an explicit Try again, unlike the in-editor
  // flow where a rebuild lands on save.
  const health = useSceneHealth()
  const studio = useStore(() => aiStore.mode === 'studio')
  useEffect(() => {
    if (shell === undefined) return
    const apply = (info: ServersReady): void => {
      // the host page URL has no ?realm — give the data-layer the realm so model
      // import/upload (which write files over the data-layer) can connect.
      // Hosted, the project store is handed in and there is nothing to dial.
      if (!isHosted()) setDataLayerRealm(info.realm)
      applied.current = true
      setSession((n) => n + 1)
      setReady(info)
    }
    void shell.getState().then((s) => {
      setLogs(s.logs.slice(-80))
      setTitle(s.projects.find((p) => p.path === props.project)?.title ?? null)
    })
    shell.onStackLog((line) => setLogs((prev) => [...prev.slice(-200), line]))
    shell.onServersReady?.(apply)
    shell.onServersError?.((msg) => setError(msg))
    // On a reload the servers are already up but the push won't re-fire — pull
    // the cached payload. Null on first load; the push above delivers it then.
    void shell.requestReady?.().then((info) => {
      if (info !== null && info !== undefined && !applied.current) apply(info)
    })
  }, [])
  useEffect(() => {
    if (pre.current !== null) pre.current.scrollTop = pre.current.scrollHeight
  }, [logs])

  if (ready !== null) {
    const p = new URLSearchParams()
    p.set('realm', ready.realm)
    p.set('systemScene', ready.systemScene)
    p.set('position', ready.position)
    if (ready.spawn !== '') p.set('spawn', ready.spawn)
    if (ready.spawnPoints !== '[]') p.set('spawnPoints', ready.spawnPoints)
    p.set('project', props.project)
    return <Editor params={p} preview={session} />
  }
  // the creator's own code stopped the server — lead with their error, not ours
  const codeError = error !== null && health !== null
  // hosted, the project stays open after a failed first build, so its code can be fixed here
  const where = codeError && isHosted() ? errorLocation(health) : null
  if (studio && isHosted() && error !== null) {
    return (
      <div className="eui-loading-studio">
        <AiPanel shown fill height={360} />
      </div>
    )
  }
  // a scene that is only on the account is fetched first: say how far along it is
  const downloading = [...logs].reverse().find((line) => line.startsWith('Downloading'))
  return (
    <div className="eui-loading">
      <div className="eui-loading-card">
        {error === null ? <Spinner size="xl" /> : <div className="eui-loading-x">✖</div>}
        <div className="eui-loading-title">
          {error === null
            ? `Starting ${isHosted() ? (title ?? 'your scene') : folderName(props.project)}…`
            : codeError
              ? 'Your scene has a code error'
              : 'Failed to start the scene'}
        </div>
        <div className="eui-loading-sub">
          {error === null
            ? isHosted()
              ? (downloading ?? 'Building the scene.')
              : 'Building the scene and launching the local servers.'
            : codeError
              ? 'The scene can’t build until it’s fixed. Fix the file, then try again.'
              : error}
        </div>
        {codeError && <pre className="eui-loading-log err">{health.lines.join('\n')}</pre>}
        {error !== null && !codeError && (
          <pre ref={pre} className="eui-loading-log">
            {logs.length > 0 ? logs.map(stripAnsi).join('\n') : '…'}
          </pre>
        )}
        {where !== null && (
          <Button variant="primary" size="lg" onClick={() => openCodeAt(where.path, where.line)}>
            Open the code
          </Button>
        )}
        {error !== null && (
          <Button variant="secondary" size="lg" onClick={() => void shell?.openProject(props.project)}>
            Try again
          </Button>
        )}
        <BackButton />
      </div>
    </div>
  )
}
