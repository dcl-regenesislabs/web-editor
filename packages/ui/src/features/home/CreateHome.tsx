// The scene list on the HUD's Create page (the hosted editor's only home). The
// page around it is the HUD's; this draws its body in the HUD's look.
import { useEffect, useRef, useState } from 'react'
import { TRASH_DAYS, type EditorShell, type HostState, type ProjectImportResult, type ProjectInfo, type ProjectSync } from '@dcl-editor/contract'
import { LinkButton, Toast, useOutsideClose } from '../../ds'
import { registerCss } from '../../ds/styles/registry'
import { useStore } from '../../core/store'
import { hostedRoute } from '../../engine/hosted'
import { useAuth } from '../account/auth'
import { ensureWorlds } from '../worlds/worlds-store'
import { WorldsSection } from '../worlds/WorldsSection'
import { relTime } from '../../lib/format'
import { PublishModal } from '../publish/PublishModal'
import { PublishOutcomeToast } from '../publish/PublishOutcomeToast'
import { SceneSettingsModal } from '../scene-settings/SceneSettingsModal'
import { ImportResultModal } from '../sync/ImportResultModal'
import { LOADING_LINE, syncLabel, syncLine, useSyncStatus } from '../sync/sync'
import { NewSceneModal } from './NewSceneModal'
import { SceneMenu } from './SceneCard'
import css from './create.css?inline'

registerCss('feature/create', 'features', css)

// Read on the light-DOM side: inside the shadow root the editor's tokens share these names.
const HUD_TOKENS: Array<[string, string]> = [
  ['--hud-brand', 'var(--brand, #ff2d55)'],
  ['--hud-brand-hover', 'var(--brand-hover, #ff4d70)'],
  ['--hud-accent', 'var(--accent, #ff743a)'],
  ['--hud-text', 'var(--text, #fcfcfc)'],
  ['--hud-font-family', "var(--font-family, 'Inter Variable', 'Inter', system-ui, -apple-system, sans-serif)"],
  ['--hud-r-sm', 'var(--r-sm, 8px)'],
  ['--hud-r-lg', 'var(--r-lg, 16px)'],
  ['--hud-r-pill', 'var(--r-pill, 999px)'],
  ['--hud-fill-3', 'var(--fill-3, rgba(255, 255, 255, 0.08))'],
  ['--hud-fill-4', 'var(--fill-4, rgba(255, 255, 255, 0.1))'],
  ['--hud-fill-5', 'var(--fill-5, rgba(255, 255, 255, 0.12))'],
  ['--hud-ink-95', 'var(--ink-95, rgba(255, 255, 255, 0.95))'],
  ['--hud-ink-7', 'var(--ink-7, rgba(255, 255, 255, 0.7))'],
  ['--hud-ink-6', 'var(--ink-6, rgba(255, 255, 255, 0.6))'],
  ['--hud-ink-45', 'var(--ink-45, rgba(255, 255, 255, 0.45))'],
  ['--hud-dur-fast', 'var(--dur-fast, 140ms)'],
  ['--hud-ease-spring', 'var(--ease-spring, cubic-bezier(0.34, 1.56, 0.64, 1))']
]

export function captureHudTokens(el: HTMLElement): void {
  for (const [name, value] of HUD_TOKENS) el.style.setProperty(name, value)
}

const CREATE_INTRO = 'Build scenes right here. Open one to walk into it and start building.'

type Tab = 'scenes' | 'worlds' | 'trash'

const TAB_LABEL: Record<Tab, string> = { scenes: 'Your scenes', worlds: 'Worlds', trash: 'Trash' }

export function CreateHome(): JSX.Element | null {
  const shell = window.editorShell
  const [cfg, setCfg] = useState<HostState | null>(null)
  const [trash, setTrash] = useState<ProjectInfo[]>([])
  const [tab, setTab] = useState<Tab>('scenes')
  const [creating, setCreating] = useState(false)
  const [importMenu, setImportMenu] = useState(false)
  const [imported, setImported] = useState<ProjectImportResult | null>(null)
  const [publish, setPublish] = useState<{ p: ProjectInfo; world: string | null } | null>(null)
  const [worldsFocus, setWorldsFocus] = useState<string | null>(null)
  const [trashed, setTrashed] = useState<ProjectInfo | null>(null)
  useEffect(() => {
    if (trashed === null) return
    const t = setTimeout(() => setTrashed(null), 8000)
    return () => clearTimeout(t)
  }, [trashed])
  const importRef = useRef<HTMLDivElement>(null)
  useOutsideClose(importMenu, importRef, () => setImportMenu(false))
  const refresh = (): void => {
    void shell?.getState().then(setCfg)
    void shell?.trashedProjects?.().then(setTrash)
  }
  const sync = useSyncStatus()
  const listRevision = sync?.revision
  useEffect(refresh, [listRevision])
  const auth = useAuth()
  useEffect(ensureWorlds, [auth.wallet])
  const notice = useStore(() => hostedRoute.notice)
  useEffect(() => {
    if (notice === null) return
    const t = setTimeout(() => (hostedRoute.notice = null), 8000)
    return () => clearTimeout(t)
  }, [notice])
  if (shell === undefined) return null

  const open = (id: string): void => void shell.openProject(id)
  const runImport = (kind: 'zip' | 'folder'): void => {
    setImportMenu(false)
    void shell.importProject?.(kind).then((result) => {
      if (result === null) return
      setImported(result)
      refresh()
    })
  }
  const scenes = [...(cfg?.projects ?? [])].sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0))
  // nothing may read as synced while the list is still arriving; a guest's line says no such thing
  const loading = cfg === null || sync?.loading === true
  const line = sync !== null && sync.account !== 'on' ? syncLine(sync) : loading ? LOADING_LINE : sync === null ? null : syncLine(sync)

  return (
    <div className="eui-create">
      <header className="eui-create-head">
        <h1>Create</h1>
        <div className="eui-create-tabs" role="tablist">
          {(['scenes', 'worlds', 'trash'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`eui-create-pill ${tab === t ? 'on' : ''}`}
              onClick={() => {
                setTab(t)
                setWorldsFocus(null)
              }}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <span className="eui-create-grow" />
        {tab !== 'worlds' && shell.importProject !== undefined && (
          <div className="eui-create-import" ref={importRef}>
            <button
              className="eui-create-action"
              title="A .zip of a scene, from the desktop editor or an export"
              onClick={() => (shell.canImportFolder === true ? setImportMenu((v) => !v) : runImport('zip'))}
            >
              Import
            </button>
            {importMenu && (
              <div className="eui-ctx eui-create-menu">
                <button className="eui-menu-item" onClick={() => runImport('zip')}>A .zip file</button>
                <button className="eui-menu-item" onClick={() => runImport('folder')}>A scene folder</button>
              </div>
            )}
          </div>
        )}
        {tab !== 'worlds' && (
          <button className="eui-create-action primary" onClick={() => setCreating(true)}>+ New scene</button>
        )}
      </header>

      {tab === 'scenes' ? (
        <>
          <p className="eui-create-intro">{CREATE_INTRO}</p>
          {line !== null && <p className={`eui-create-sync ${line.tone}`} role="status">{line.text}</p>}
          {sync?.usage !== undefined && <p className="eui-create-sync quiet">{usageLine(sync.usage)}</p>}
          <div className="eui-create-grid" aria-busy={loading}>
            {loading && scenes.length === 0 && [0, 1, 2].map((i) => (
              <div key={i} className="eui-create-card skeleton" aria-hidden="true">
                <div className="eui-create-thumb" />
                <div className="eui-create-meta"><span className="eui-create-skel-line" /></div>
              </div>
            ))}
            {scenes.map((p) => (
              <CreateCard
                key={p.path}
                p={p}
                sync={sync?.projects[p.path] ?? p.sync}
                shell={shell}
                onOpen={() => open(p.path)}
                onChanged={refresh}
                onPublish={() => setPublish({ p, world: p.world })}
                onTrashed={() => setTrashed(p)}
              />
            ))}
            <button className="eui-create-tile" onClick={() => setCreating(true)}>
              <span className="plus" aria-hidden="true">+</span>
              <span>New scene</span>
            </button>
          </div>
        </>
      ) : tab === 'worlds' ? (
        <WorldsSection
          key={worldsFocus ?? 'all'}
          projects={scenes}
          initialWorld={worldsFocus}
          onOpenScene={open}
          onPublishScene={(p, world) => setPublish({ p, world })}
        />
      ) : (
        <>
          <p className="eui-create-intro">Scenes in the trash are deleted for good 30 days after they were put there.</p>
          {trash.length === 0 ? (
            <p className="eui-create-empty">The trash is empty.</p>
          ) : (
            <div className="eui-create-grid">
              {trash.map((p) => (
                <div key={p.path} className="eui-create-card trashed">
                  <Thumb p={p} />
                  <div className="eui-create-meta">
                    <span className="eui-create-name">{p.title}</span>
                    {p.deletedAt !== undefined && <span className="eui-create-where">{daysLeftLine(p.deletedAt)}</span>}
                    <button
                      className="eui-create-pill small"
                      onClick={() => void shell.restoreProject?.(p.path).then(refresh)}
                    >
                      Restore
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {creating && (
        <NewSceneModal
          shell={shell}
          onClose={() => setCreating(false)}
          onCreated={(dir) => {
            setCreating(false)
            open(dir)
          }}
        />
      )}
      {imported !== null && (
        <ImportResultModal
          result={imported}
          onClose={() => setImported(null)}
          onOpen={(id) => {
            setImported(null)
            open(id)
          }}
        />
      )}
      {publish !== null && (
        <PublishModal
          dir={publish.p.path}
          sceneTitle={publish.p.title}
          currentWorld={publish.world}
          onClose={() => {
            setPublish(null)
            refresh()
          }}
          onManageWorld={(name) => {
            setPublish(null)
            refresh()
            setWorldsFocus(name)
            setTab('worlds')
          }}
        />
      )}
      {notice !== null && <Toast>{notice}</Toast>}
      {notice === null && trashed !== null && (
        <Toast>
          “{trashed.title}” is in the trash.
          <LinkButton
            onClick={() => {
              const undo = trashed
              setTrashed(null)
              void shell.restoreProject?.(undo.path).then(refresh)
            }}
          >
            Undo
          </LinkButton>
        </Toast>
      )}
      <PublishOutcomeToast />
    </div>
  )
}

const DAY_MS = 24 * 60 * 60 * 1000
const MB = 1024 * 1024

function daysLeftLine(deletedAt: number): string {
  const days = Math.max(0, Math.ceil((deletedAt + TRASH_DAYS * DAY_MS - Date.now()) / DAY_MS))
  return days <= 1 ? 'Deleted for good within a day' : `Deleted for good in ${days} days`
}

function usageLine(usage: { bytes: number; limit: number }): string {
  const used = usage.bytes / MB
  return `${used < 10 ? used.toFixed(1) : Math.round(used)} of ${Math.round(usage.limit / MB)} MB of your account's scene storage used. Trashed scenes count until they are deleted for good.`
}

function Thumb(props: { p: ProjectInfo }): JSX.Element {
  return (
    <div className="eui-create-thumb">{props.p.thumbnail !== null && <img src={props.p.thumbnail} alt="" />}</div>
  )
}

function whereLine(p: ProjectInfo, sync: ProjectSync | undefined): string {
  if (p.remoteOnly === true) return 'On your account · opening it downloads it'
  const where = syncLabel(sync) ?? 'On this device only'
  return p.lastOpened !== undefined ? `${where} · opened ${relTime(p.lastOpened)}` : where
}

function CreateCard(props: {
  p: ProjectInfo
  sync?: ProjectSync
  shell: EditorShell
  onOpen: () => void
  onChanged: () => void
  onPublish: () => void
  onTrashed: () => void
}): JSX.Element {
  const { p, shell } = props
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [settings, setSettings] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(menu, ref, () => setMenu(false))
  const after = (op?: Promise<unknown>): void => {
    setMenu(false)
    void Promise.resolve(op).then(() => props.onChanged())
  }
  const open = (): void => {
    if (!menu && !renaming && !settings) props.onOpen()
  }
  const world = p.published?.world ?? p.world
  return (
    <div
      ref={ref}
      className={`eui-create-card ${menu ? 'menu-open' : ''}`}
      role="button"
      tabIndex={0}
      data-sync={p.remoteOnly === true ? 'remote' : props.sync?.state}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          open()
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu(true)
      }}
    >
      <Thumb p={p} />
      <button
        className="eui-create-more"
        aria-label={`More for ${p.title}`}
        onClick={(e) => {
          e.stopPropagation()
          setMenu((v) => !v)
        }}
      >
        ⋯
      </button>
      <div className="eui-create-meta">
        {renaming ? (
          <input
            className="eui-create-rename"
            autoFocus
            defaultValue={p.title}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setRenaming(false)
              const v = e.target.value.trim()
              if (v !== '' && v !== p.title) after(shell.renameProject?.(p.path, v))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <span className="eui-create-name">{p.title}</span>
        )}
        <span className="eui-create-where" title={props.sync?.message}>{whereLine(p, props.sync)}</span>
        {world !== null ? (
          <span className="eui-create-world">◆ {world}</span>
        ) : (
          <span className="eui-create-where">Not published</span>
        )}
      </div>
      {menu && (
        <SceneMenu
          p={p}
          shell={shell}
          sync={props.sync}
          onOpen={props.onOpen}
          onRename={() => {
            setMenu(false)
            setRenaming(true)
          }}
          onSettings={() => {
            setMenu(false)
            setSettings(true)
          }}
          onPublish={() => {
            setMenu(false)
            props.onPublish()
          }}
          onRemove={() => setMenu(false)}
          onTrashed={props.onTrashed}
          after={after}
          favourites={false}
        />
      )}
      {settings && <SceneSettingsModal dir={p.path} onClose={() => setSettings(false)} onSaved={props.onChanged} />}
    </div>
  )
}
