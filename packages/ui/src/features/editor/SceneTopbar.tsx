import { useEffect, useRef, useState } from 'react'
import type { OpenPreview } from '@dcl-editor/contract'
import { Button, MenuItem, Spinner, labelTip } from '../../ds'
import { useAuth } from '../account/auth'
import { usePublish } from '../publish/publish-flow'
import { useStore } from '../../core/store'
import { GlobeIcon, openExternal } from '../worlds/common'
import { state } from '@scene/state'
import { AccountBadge } from '../account/account'
import { PublishModal } from '../publish/PublishModal'
import { canPublish } from '../publish/publish-preflight'
import { restartToUpdate, useUpdateStatus } from '../update/update'
import { SceneSettingsModal } from '../scene-settings/SceneSettingsModal'
import { MobilePreviewModal } from '../preview/MobilePreviewModal'
import { backLabel, backToProjects, reloadEditor, useLeaving } from './nav'
import { openCodeEditor } from '../../panels/ai-store'
import { IconCode, IconPlay } from '../../icons'
import { uiPlay } from '../../actions/playback'
import { SyncChip } from '../sync/SyncChip'
import { getHost } from '../../engine/hosted'
import { useRevealNearPointer } from './topbar-reveal'
import { setAdvanced } from '../../core/chrome'
import { canAskAssistant } from '../../panels/ai-store'
import { advancedOffered } from './entry-mode'

const TerminalIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="1" y="2.5" width="14" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
    <path d="M4 6l2.5 2L4 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 10.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

const ArrowLeftIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const PhoneIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="4.5" y="1.5" width="7" height="13" rx="1.8" stroke="currentColor" strokeWidth="1.4" />
    <path d="M7 12.5h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

const MonitorIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
    <path d="M6 14h4M8 11.5V14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

const ChevronDownIcon = (): JSX.Element => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const GearIcon = (): JSX.Element => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.4" />
    <path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
)

// Slim top bar over the viewport: scene name on the left, settings + back-to-
// home on the right. Replaces the old floating ⌂ button. In entry mode it keeps only what a
// creator building by asking needs: back, Publish, the phone preview and the way to the
// whole editor, always shown and with no band of its own over the world.
export function SceneTopbar(props: { logsOpen: boolean; onToggleLogs: () => void; project?: string | null; entry?: boolean }): JSX.Element {
  const entry = props.entry === true
  const scene = useStore(() => state.scene)
  const [menuOpen, setMenuOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [world, setWorld] = useState<string | null>(null)
  const upd = useUpdateStatus()
  const [updateHint, setUpdateHint] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mobilePreview, setMobilePreview] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewFail, setPreviewFail] = useState<Extract<OpenPreview, { ok: false }>['reason'] | null>(null)
  // launch an external preview client; failures show as a note inside the menu
  const runPreview = (fn: (() => Promise<OpenPreview>) | undefined): void => {
    if (fn === undefined) return
    void fn().then((r) => {
      if (r.ok) setPreviewOpen(false)
      else setPreviewFail(r.reason)
    })
  }
  const title = scene?.title ?? scene?.hash ?? 'Loading scene…'
  const home = backToProjects
  const leaving = useLeaving()
  const host = getHost()
  const project = props.project ?? null
  const auth = useAuth()
  const guest = auth.external && auth.wallet === null
  const job = usePublish()
  const publishingNow = job.phase === 'building' || job.phase === 'uploading'
  // the scene's current target world (for pre-selecting in the publish modal)
  useEffect(() => {
    if (project === null || window.editorShell === undefined) return
    void window.editorShell.getState().then((s) => {
      setWorld(s.projects.find((p) => p.path === project)?.world ?? null)
    })
  }, [project, publishing])
  const barRef = useRef<HTMLDivElement>(null)
  useRevealNearPointer(barRef)
  const phone = window.editorShell?.phonePreview
  // entry mode has no toolbar: Play is here, and Stop is the play bar's own
  const canPlay = useStore(() => state.status === 'ready' && state.frozen)
  const modeSwitch = canAskAssistant() && advancedOffered() && (
    <button
      className="eui-topbar-btn wide"
      data-tip={entry ? 'Show the whole editor: hierarchy, inspector, assets, logs' : 'Show only the assistant'}
      onClick={() => setAdvanced(entry)}
    >
      {entry ? 'Advanced' : 'Simple'}
    </button>
  )
  return (
    <div className={`eui-topbar${entry ? ' entry' : ''}`} ref={barRef}>
      <button className="eui-topbar-home" {...labelTip(leaving ? 'Saving…' : backLabel())} onClick={home} disabled={leaving} aria-busy={leaving}>
        {leaving ? <Spinner size="xs" /> : <ArrowLeftIcon />}
      </button>
      <div className="eui-topbar-title">
        <span className="eui-title">{title}</span>
      </div>
      <span style={{ flex: 1 }} />
      {project !== null && <SyncChip project={project} />}
      {!entry && window.editorShell !== undefined && project !== null && (
        <button className="eui-topbar-btn wide" data-tip="Browse and edit your scene's code" onClick={openCodeEditor}>
          <IconCode /> Code
        </button>
      )}
      {entry && (phone !== undefined || window.editorShell?.mobilePreview !== undefined) && (
        <button
          className="eui-topbar-btn wide"
          data-tip="Try the scene as it plays on a phone"
          onClick={() => {
            if (phone !== undefined) runPreview(() => phone('embedded'))
            else setMobilePreview(true)
          }}
        >
          <PhoneIcon /> Phone
        </button>
      )}
      {entry && previewFail !== null && (
        <span className="eui-topbar-entry-note" role="status">
          {previewFail === 'no-scene' ? 'The scene is still starting. Try again in a moment.' : 'The phone preview couldn’t open on this page.'}
        </span>
      )}
      {entry && canPlay && (
        <button className="eui-topbar-btn wide" data-tip="Play the scene as a player" onClick={() => void uiPlay()}>
          <IconPlay /> Play
        </button>
      )}
      {entry ? modeSwitch : null}
      {canPublish(window.editorShell) && project !== null && (
        <Button
          variant={guest ? 'secondary' : 'primary'}
          className={`eui-topbar-publish${publishingNow ? ' busy' : ''}`}
          tip={guest ? 'Sign in to publish' : publishingNow ? `Publishing to ${job.world ?? 'your world'}…` : undefined}
          onClick={() => setPublishing(true)}
        >
          {publishingNow && <Spinner size="xs" />}
          Publish
        </Button>
      )}
      {!entry && modeSwitch}
      {!entry && (window.editorShell?.mobilePreview !== undefined || window.editorShell?.phonePreview !== undefined) && (
        <div className="eui-topbar-menu-wrap">
          <button
            className={`eui-topbar-btn wide ${previewOpen ? 'on' : ''}`}
            onClick={() => {
              setPreviewFail(null) // a stale failure note must not survive a re-open
              setPreviewOpen((v) => !v)
            }}
          >
            Preview
            <ChevronDownIcon />
          </button>
          {previewOpen && (
            <>
              <div className="eui-topbar-scrim" onClick={() => setPreviewOpen(false)} />
              <div className="eui-ctx eui-topbar-menu">
                {window.editorShell?.webPreview !== undefined && (
                  <MenuItem icon={<GlobeIcon />} onClick={() => runPreview(window.editorShell?.webPreview)}>
                    In your browser
                  </MenuItem>
                )}
                {window.editorShell?.phonePreview !== undefined && (
                  <MenuItem icon={<PhoneIcon />} onClick={() => runPreview(window.editorShell?.phonePreview)}>
                    As a phone
                  </MenuItem>
                )}
                {window.editorShell?.mobilePreview !== undefined && (
                  <MenuItem
                    icon={<PhoneIcon />}
                    onClick={() => {
                      setPreviewOpen(false)
                      setMobilePreview(true)
                    }}
                  >
                    On your phone…
                  </MenuItem>
                )}
                {window.editorShell?.unityPreview !== undefined && (
                  <MenuItem icon={<MonitorIcon />} onClick={() => runPreview(window.editorShell?.unityPreview)}>
                    In Decentraland Desktop
                  </MenuItem>
                )}
                {previewFail === 'no-scene' && (
                  <span className="eui-menu-note eui-topbar-note">The scene server is still starting — try again in a moment.</span>
                )}
                {previewFail === 'unavailable' && (
                  <span className="eui-menu-note eui-topbar-note">The phone preview couldn't open on this page.</span>
                )}
                {previewFail === 'no-client' && (
                  <span className="eui-menu-note eui-topbar-note">
                    Decentraland Desktop isn't installed.{' '}
                    <button className="eui-link" onClick={() => openExternal('https://dcl.gg/explorer')}>
                      Get it
                    </button>
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {!entry && <button
        className={`eui-topbar-btn ${props.logsOpen ? 'on' : ''}`}
        {...labelTip(props.logsOpen ? 'Hide logs' : 'Show build / server logs')}
        onClick={props.onToggleLogs}
      >
        <TerminalIcon />
      </button>}
      {!entry && window.editorShell !== undefined && (
        <div className="eui-topbar-menu-wrap">
          <button
            className={`eui-topbar-btn ${upd.state === 'downloaded' ? 'eui-has-update' : ''}`}
            {...labelTip(upd.state === 'downloaded' ? 'Settings — update ready' : 'Settings')}
            onClick={() => {
              setUpdateHint(false) // a stale "deploy running" hint must not survive a re-open
              setMenuOpen((v) => !v)
            }}
          >
            <GearIcon />
            {upd.state === 'downloaded' && <span className="eui-update-dot" />}
          </button>
          {menuOpen && (
            <>
              <div className="eui-topbar-scrim" onClick={() => setMenuOpen(false)} />
              <div className="eui-ctx eui-topbar-menu">
                {project !== null && window.editorShell?.sceneSettings !== undefined && (
                  <button
                    className="eui-menu-item"
                    onClick={() => {
                      setMenuOpen(false)
                      setSettingsOpen(true)
                    }}
                  >
                    Scene settings…
                  </button>
                )}
                <button className="eui-menu-item" onClick={home}>{backLabel()}</button>
                {host !== null && (
                  <button className="eui-menu-item" onClick={() => host.exit()}>Back to Decentraland</button>
                )}
                <button className="eui-menu-item" onClick={reloadEditor}>Reload editor</button>
                {upd.state === 'downloaded' && (
                  <button
                    className="eui-menu-item"
                    onClick={() => {
                      // stays open on refusal so the busy hint is seen
                      void restartToUpdate().then((r) => {
                        if (r.ok) setMenuOpen(false)
                        else setUpdateHint(true)
                      })
                    }}
                  >
                    Restart to update to v{upd.version}
                  </button>
                )}
                {updateHint && <span className="eui-menu-note">Finish the current deploy first</span>}
              </div>
            </>
          )}
        </div>
      )}
      {window.editorShell !== undefined && <AccountBadge />}
      {settingsOpen && project !== null && (
        <SceneSettingsModal
          dir={project}
          onClose={() => setSettingsOpen(false)}
          // parcels/base/spawn feed the engine's launch params — relaunch the
          // scene so the preview actually reflects the new layout
          onSaved={(layoutChanged) => {
            const shell = window.editorShell
            if (layoutChanged) void (shell?.relaunchProject ?? shell?.openProject)?.(project)
          }}
        />
      )}
      {mobilePreview && <MobilePreviewModal onClose={() => setMobilePreview(false)} />}
      {publishing && project !== null && (
        <PublishModal
          dir={project}
          sceneTitle={typeof title === 'string' ? title : 'this scene'}
          currentWorld={world}
          onClose={() => setPublishing(false)}
        />
      )}
    </div>
  )
}
