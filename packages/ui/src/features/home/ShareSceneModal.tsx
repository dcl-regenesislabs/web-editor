import { useEffect, useState } from 'react'
import type { EditorShell } from '@dcl-editor/contract'
import { Button, CopyField, Modal } from '../../ds'
import { log } from '../../log'

// A link another account opens to make its own copy of the scene. The scene
// itself is never theirs to change: the link only reads it.
export function ShareSceneModal(props: { shell: EditorShell; dir: string; title: string; onClose: () => void }): JSX.Element {
  const { shell, dir } = props
  // undefined while the account is asked
  const [link, setLink] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (shell.projectShareLink?.(dir) ?? Promise.resolve(null)).then(
      (found) => live && setLink(found),
      (error: unknown) => {
        log.warn('could not read whether the scene is shared', error)
        if (!live) return
        setLink(null)
        setErr(error instanceof Error ? error.message : String(error))
      }
    )
    return () => {
      live = false
    }
  }, [dir])

  const set = async (shared: boolean): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      setLink((await shell.setProjectShared?.(dir, shared)) ?? null)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Share a copy of “${props.title}”`}
      size="md"
      className="eui-home-modal eui-share-modal"
      onClose={props.onClose}
      footer={
        <>
          {link !== null && link !== undefined && (
            <Button variant="danger" size="md" disabled={busy} onClick={() => void set(false)}>Stop sharing</Button>
          )}
          <span style={{ flex: 1 }} />
          {link === null && (
            <Button variant="primary" size="md" disabled={busy} onClick={() => void set(true)}>
              {busy ? 'Creating…' : 'Create link'}
            </Button>
          )}
          <Button variant="ghost" size="md" onClick={props.onClose}>Done</Button>
        </>
      }
    >
      {link === undefined ? (
        <p>Checking your account…</p>
      ) : link === null ? (
        <p>
          Anyone signed in with the link can make their own copy of this scene. Your scene stays yours: nothing they do
          reaches it.
        </p>
      ) : (
        <>
          <p>
            Anyone signed in with this link can make their own copy of the scene as it is when they open it, your latest
            changes included. Stop sharing to make the link stop working; sharing again makes a new one.
          </p>
          <CopyField label="Link" value={link} />
        </>
      )}
      {err !== null && <div className="eui-script-err">{err}</div>}
    </Modal>
  )
}
