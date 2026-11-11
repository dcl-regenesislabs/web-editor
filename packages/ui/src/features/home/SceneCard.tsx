import { useRef, useState } from 'react'
import type { EditorShell, ProjectInfo, ProjectSync } from '@dcl-editor/contract'
import { Chip, labelTip, useOutsideClose } from '../../ds'
import { relTime } from '../../lib/format'
import { canPublish } from '../publish/publish-preflight'
import { SceneSettingsModal } from '../scene-settings/SceneSettingsModal'
import { ShareSceneModal } from './ShareSceneModal'
import { syncLabel } from '../sync/sync'

export const FolderIcon = (): JSX.Element => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
)

function sceneSub(p: ProjectInfo): string {
  if (p.missing === true) return 'Folder not found'
  if (p.remoteOnly === true) return 'On your account'
  return p.world !== null ? p.world : `${p.parcels} parcel${p.parcels === 1 ? '' : 's'}`
}

export function SceneCard(props: {
  p: ProjectInfo
  // where the account's copy stands, when the shell keeps one
  sync?: ProjectSync
  shell: EditorShell
  onOpen: () => void
  onChanged: () => void
  onRemove: (p: ProjectInfo) => void
  onPublish: () => void
}): JSX.Element {
  const { p, shell } = props
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [settings, setSettings] = useState(false)
  const [sharing, setSharing] = useState(false)
  const synced = syncLabel(props.sync)
  // a scene that is only on the account has nothing here to rename, copy or delete yet
  const here = p.missing !== true && p.remoteOnly !== true
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClose(menu, ref, () => setMenu(false))

  const after = (op?: Promise<unknown>): void => {
    setMenu(false)
    void Promise.resolve(op).then(() => props.onChanged())
  }
  const open = (): void => {
    if (!menu && !renaming && p.missing !== true) props.onOpen()
  }

  return (
    <div
      ref={ref}
      className={`eui-scene-card ${p.missing === true ? 'missing' : ''} ${menu ? 'menu-open' : ''}`}
      role="button"
      tabIndex={0}
      data-tip={p.path}
      data-sync={p.remoteOnly === true ? 'remote' : props.sync?.state}
      onClick={open}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !renaming) {
          e.preventDefault()
          open()
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu(true)
      }}
    >
      <div className="eui-scene-thumb">
        {p.thumbnail !== null ? <img src={p.thumbnail} alt="" /> : <div className="eui-scene-thumb-fallback"><FolderIcon /></div>}
      </div>
      {p.favourite === true && <span className="eui-scene-pin" data-tip="Favourite">★</span>}
      <div className="eui-scene-meta">
        {renaming ? (
          <input
            className="eui-scene-rename"
            autoFocus
            defaultValue={p.title}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setRenaming(false)
              const v = e.target.value.trim()
              if (v !== '' && v !== p.title) after(shell.renameProject?.(p.path, v))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <span className="eui-scene-name">{p.title}</span>
        )}
        {p.world !== null && p.missing !== true ? (
          <span className="eui-scene-sub">
            <Chip tone="primary" tip="This scene publishes to your world">◆ {p.world}</Chip>
          </span>
        ) : (
          <span className="eui-scene-sub">{sceneSub(p)}</span>
        )}
        {p.remoteOnly === true && <span className="eui-scene-ago">Not on this device yet. Opening it downloads it.</span>}
        {here && (p.lastOpened !== undefined || synced !== null) && (
          <span className="eui-scene-ago" data-tip={props.sync?.message}>
            {[p.lastOpened !== undefined ? `opened ${relTime(p.lastOpened)}` : null, synced].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>

      <div className="eui-scene-actions">
        {here && (
          <button
            className={`eui-scene-iact ${p.favourite === true ? 'on' : ''}`}
            data-tip={p.favourite === true ? 'Unfavourite' : 'Favourite'}
            onClick={(e) => {
              e.stopPropagation()
              after(shell.toggleFavourite?.(p.path))
            }}
          >
            {p.favourite === true ? '★' : '☆'}
          </button>
        )}
        <button
          className="eui-scene-iact"
          {...labelTip('More')}
          onClick={(e) => {
            e.stopPropagation()
            setMenu((v) => !v)
          }}
        >
          ⋯
        </button>
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
          onShare={() => {
            setMenu(false)
            setSharing(true)
          }}
          onPublish={() => {
            setMenu(false)
            props.onPublish()
          }}
          onRemove={() => {
            setMenu(false)
            props.onRemove(p)
          }}
          after={after}
        />
      )}
      {sharing && <ShareSceneModal shell={shell} dir={p.path} title={p.title} onClose={() => setSharing(false)} />}
      {settings && (
        <SceneSettingsModal
          dir={p.path}
          onClose={() => setSettings(false)}
          onSaved={props.onChanged} // title/thumbnail feed the card — refresh it
        />
      )}
    </div>
  )
}

// A scene's menu, from its ⋯ button or a right-click.
export function SceneMenu(props: {
  p: ProjectInfo
  shell: EditorShell
  onOpen: () => void
  onRename: () => void
  onSettings: () => void
  // where the list can show the share dialog
  onShare?: () => void
  onPublish: () => void
  onRemove: () => void
  after: (op?: Promise<unknown>) => void
  // a scene put in the shell's own trash, which can be undone
  onTrashed?: () => void
  // false where the list has no favourites shelf
  favourites?: boolean
  sync?: ProjectSync
}): JSX.Element {
  const { p, shell, after } = props
  const here = p.missing !== true && p.remoteOnly !== true
  return (
    <div className="eui-ctx eui-scene-menu" onClick={(e) => e.stopPropagation()}>
      {p.remoteOnly === true && (
        <button className="eui-menu-item" onClick={props.onOpen}>Download and open<span className="hint">↵</span></button>
      )}
      {here && (
        <>
          <button className="eui-menu-item" onClick={props.onOpen}>Open<span className="hint">↵</span></button>
          {props.favourites !== false && (
            <button className="eui-menu-item" onClick={() => after(shell.toggleFavourite?.(p.path))}>
              {p.favourite === true ? 'Unfavourite' : 'Favourite'}
            </button>
          )}
          {shell.revealInFinder !== undefined && (
            <button className="eui-menu-item" onClick={() => after(shell.revealInFinder?.(p.path))}>Reveal in Finder</button>
          )}
          <button className="eui-menu-item" onClick={props.onRename}>Rename</button>
          <button className="eui-menu-item" onClick={() => after(shell.duplicateProject?.(p.path))}>Duplicate</button>
          {shell.exportProject !== undefined && (
            <button className="eui-menu-item" onClick={() => after(shell.exportProject?.(p.path))}>Export as .zip</button>
          )}
          {props.onShare !== undefined && shell.setProjectShared !== undefined && props.sync?.otherAccount !== true && (
            <button className="eui-menu-item" onClick={props.onShare}>Share a copy…</button>
          )}
          {shell.sceneSettings !== undefined && (
            <button className="eui-menu-item" onClick={props.onSettings}>Scene settings…</button>
          )}
          <div className="eui-menu-sep" />
          {canPublish(shell) && (
            <>
              <button className="eui-menu-item" onClick={props.onPublish}>
                {p.world !== null ? `Publish to ${p.world}…` : 'Publish to a world…'}
              </button>
              <div className="eui-menu-sep" />
            </>
          )}
        </>
      )}
      {shell.removeFromRecents !== undefined && (
        <button className="eui-menu-item" onClick={props.onRemove}>Remove from list</button>
      )}
      {here && (
        <button
          className="eui-menu-item danger"
          onClick={() =>
            after(
              shell.deleteProject?.(p.path).then((done) => {
                if (done && shell.restoreProject !== undefined) props.onTrashed?.()
              })
            )
          }
        >
          {shell.restoreProject === undefined
            ? 'Delete from disk…'
            : props.sync?.otherAccount === true
              ? 'Remove from this device'
              : 'Move to trash'}
        </button>
      )}
    </div>
  )
}
