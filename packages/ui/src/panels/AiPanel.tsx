// The AI assistant surface. One component, two modes (ai-store.ts):
//  - 'dock'   : chat under the inspector in the right dock (quick asks)
//  - 'studio' : file rail + editor + chat, full-screen under the topbar
// It is never unmounted while the CLI exists — minimizing or hiding the dock
// only stops it being drawn, so the transcript, the CLI session and a turn
// still streaming all survive.
// Chat/session state lives here so it follows the creator between modes: the
// presentation pieces (features/ai/*) are stateless and are re-parented between
// the two layouts, which would reset any state they owned. It drives the
// Claude CLI (main process), which edits project files on disk — Scripts
// under src/scripts/ and the scene's entry point src/index.ts; in Studio those
// edits arrive as an accept/reject diff via the CodeEditor handle — nothing runs
// in the scene until the creator accepts. The web shell runs tools in the browser.
import { useEffect, useRef, useState } from 'react'
import type { AiEvent, AiImageAttachment, AiProvider, AiProviderInfo, AiTranscript } from '@dcl-editor/contract'
import { ASSISTANT_MAX_IMAGE_BYTES } from '@dcl-editor/contract'
import { Button, labelTip, Modal } from '../ds'
import { useStore } from '../core/store'
import { state } from '@scene/state'
import { type CodeEditorHandle } from '../script/code-editor'
import { IconBot, IconChevron, IconNewChat } from '../icons'
import { onBuiltModel } from '../features/ai/built-models'
import { onThumbnail } from '../features/ai/built-thumbnails'
import { aiStore, canAskAssistant, clearRevealLine, closeDoc, leaveStudio, openDoc, openStudio, refreshFileRail, setMode, setSelection, setStudioChordHandler, setStudioFile, toggleAssistantCollapsed, vendorRuntimeAfterTurn } from './ai-store'
import { uiSelectEntity } from '../actions/selection'
import { QuickOpen } from '../features/ai/QuickOpen'
import { StudioShell } from '../features/ai/StudioShell'
import { Composer } from '../features/ai/Composer'
import { ErrorDetails } from '../features/ai/ErrorDetails'
import { AiEmpty, AiSetup, MessageList, type ChatMsg } from '../features/ai/transcript'
import { type ToolUse } from '../features/ai/activity'
import { keptTranscript, MAX_ATTACH, readImages, restoredTranscript, sameFile } from '../features/ai/chat-helpers'
import { buildContext, entityScriptFiles, selectedEntities } from '../ai/context'
import { ensurePrefabsLoaded } from './prefab-store'
import { isPrimaryMod } from '../lib/keys'
import { projectFiles } from '../assets'

export function AiPanel(props: { shown: boolean; fill: boolean; height: number }): JSX.Element | null {
  const shell = window.editorShell
  const collapsed = useStore(() => aiStore.collapsed)
  const mode = useStore(() => aiStore.mode)
  // Mounted is not visible: minimized to its title bar, or inside a hidden dock,
  // the chat is still alive (transcript, CLI session, a turn mid-flight) — it
  // just isn't on screen, so it must not take focus or claim keys.
  const visible = mode === 'studio' || (props.shown && !collapsed)
  const file = useStore(() => aiStore.file)
  const tabs = useStore(() => aiStore.tabs)
  const selection = useStore(() => aiStore.selection)
  const [providers, setProviders] = useState<AiProviderInfo[]>([])
  const [rechecking, setRechecking] = useState(false)
  const [provider, setProvider] = useState<AiProvider>('claude')
  const [model, setModel] = useState('default')
  const [messages, setMessages] = useState<ChatMsg[]>([])
  // the kept chat of an earlier session: shown, never sent back as context
  const [history, setHistory] = useState<ChatMsg[]>([])
  const kept = useRef<AiTranscript | null>(null)
  const owner = useStore(() => shell?.aiTranscript?.()?.owner ?? null)
  const lastOwner = useRef(owner)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AiImageAttachment[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const addImages = (files: Iterable<File>): void => {
    const picked = [...files]
    const hosted = current?.transport === 'service'
    if (hosted && picked.some((f) => f.size > ASSISTANT_MAX_IMAGE_BYTES)) {
      setErrorDetail('Use images of at most 2 MB each.')
      return
    }
    void readImages(picked, MAX_ATTACH - attachments.length, hosted ? ASSISTANT_MAX_IMAGE_BYTES : undefined).then(
      (imgs) => imgs.length > 0 && setAttachments((prev) => [...prev, ...imgs].slice(0, MAX_ATTACH))
    )
  }
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    aiStore.turnRunning = busy
    return () => {
      aiStore.turnRunning = false
    }
  }, [busy])
  const [fileStatus, setFileStatus] = useState<{ text: string; kind: 'dim' | 'ok' | 'err' }>({ text: '', kind: 'dim' })
  const [dirty, setDirty] = useState(false)
  const railKey = useStore(() => aiStore.railVersion)
  const [confirmWipe, setConfirmWipe] = useState<{ label: string } | null>(null)
  const [showQuickOpen, setShowQuickOpen] = useState(false)
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const lastPrompt = useRef<string | null>(null)
  const activeTurn = useRef<string | null>(null)
  const editorRef = useRef<CodeEditorHandle>(null)
  const openFileTouched = useRef(false)
  const stopRef = useRef<() => void>(() => {}) // latest stop(), for the Escape handler
  useStore(() => state.activeEntity)
  useStore(() => state.selected)
  useStore(() => state.snapshot)
  const entities = selectedEntities()
  const current = providers.find((p) => p.id === provider)
  const available = current?.available ?? false
  const anyAvailable = providers.some((p) => p.available)

  useEffect(() => {
    if (shell?.onAiEvent === undefined) return
    void shell.aiReset?.()

    const addTools = (turnId: string, items: ToolUse[]): void => {
      if (items.length === 0) return
      setMessages((prev) =>
        prev.map((m) => (m.role === 'assistant' && m.turnId === turnId ? { ...m, tools: [...m.tools, ...items] } : m))
      )
    }

    const finishTurn = async (turnId: string): Promise<void> => {
      addTools(turnId, await vendorRuntimeAfterTurn())
    }

    return shell.onAiEvent((e: AiEvent) => {
      if (e.kind === 'started') activeTurn.current = e.turnId
      else if (e.turnId !== activeTurn.current) return
      if (e.kind === 'tool' && (e.tool === 'Edit' || e.tool === 'Write')) {
        if (aiStore.file !== null && sameFile(e.detail, aiStore.file)) openFileTouched.current = true
        if (e.tool === 'Write') refreshFileRail()
      }
      setMessages((prev) => {
        const next = [...prev]
        let i = next.findIndex((m) => m.role === 'assistant' && m.turnId === e.turnId)
        if (i < 0)
          for (let j = next.length - 1; j >= 0; j--) {
            const m = next[j]
            if (m.role === 'assistant' && !m.done && m.turnId === undefined) {
              i = j
              break
            }
          }
        if (i < 0) {
          if (e.kind === 'started') next.push({ role: 'assistant', turnId: e.turnId, text: '', tools: [], done: false })
          return next
        }
        const msg = next[i] as Extract<ChatMsg, { role: 'assistant' }>
        if (e.kind === 'started') next[i] = { ...msg, turnId: e.turnId }
        else if (e.kind === 'text') next[i] = { ...msg, turnId: e.turnId, text: msg.text + e.text }
        else if (e.kind === 'tool') next[i] = { ...msg, turnId: e.turnId, tools: [...msg.tools, { tool: e.tool, detail: e.detail, ...(e.label === undefined ? {} : { label: e.label }) }] }
        else if (e.kind === 'error') next[i] = e.resumable === true ? { ...msg, paused: e.message } : { ...msg, error: e.message }
        else if (e.kind === 'done') next[i] = { ...msg, done: true }
        return next
      })
      if (e.kind === 'done') {
        activeTurn.current = null
        setBusy(false)
        const ed = editorRef.current
        if (ed !== null && aiStore.mode === 'studio' && aiStore.file !== null) {
          ed.freeze(false)
          if (openFileTouched.current) void ed.reviewAgainstDisk()
        }
        openFileTouched.current = false
        if (e.ok) void finishTurn(e.turnId)
      }
    })
  }, [])

  useEffect(() => {
    if (shell?.aiProviders === undefined) return
    void shell.aiProviders().then((list) => {
      setProviders(list)
      const first = list.find((p) => p.available) ?? list[0]
      if (first !== undefined) {
        setProvider(first.id)
        setModel(first.defaultModel)
      }
    })
  }, [])

  useEffect(() => {
    kept.current = null
    setHistory([])
    // another wallet signed in: what is on screen is not theirs
    if (lastOwner.current !== owner) setMessages([])
    lastOwner.current = owner
    const handle = shell?.aiTranscript?.()
    if (handle == null || handle.owner !== owner) return
    let live = true
    handle.load().then(
      (value) => {
        if (!live) return
        setHistory(restoredTranscript(value))
        kept.current = handle
      },
      (error: unknown) => console.warn('could not restore the assistant chat:', error)
    )
    return () => {
      live = false
    }
  }, [owner])

  useEffect(() => {
    const handle = kept.current
    if (busy || handle === null) return
    handle.save(keptTranscript([...history, ...messages])).catch((error: unknown) => console.warn('could not keep the assistant chat:', error))
  }, [history, messages, busy])

  useEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, history, visible, mode])

  useEffect(() => {
    if (!visible) return
    inputRef.current?.focus()
    ensurePrefabsLoaded()
  }, [visible])

  // Escape steps back OUT of the assistant, one layer at a time: dismiss the
  // error modal → cancel a confirm → stop a running turn → leave the Studio for
  // the chat dock. It never removes the assistant: the dock is half the right
  // panel, and losing the open file tabs to one keystroke was exactly the bug.
  // In the dock with nothing to unwind, Escape belongs to the editor (clear the
  // selection) — the assistant is always on screen, so it can't own the key.
  // CodeMirror sees the key first (element handlers run before this document
  // listener); if it consumed it (autocomplete, search…) it preventDefaults and
  // we leave it alone — otherwise Escape leaves the Studio even from the editor.
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (errorDetail !== null) {
        setErrorDetail(null)
        return
      }
      const fromEditor = e.composedPath().some((el) => el instanceof HTMLElement && el.classList.contains('cm-editor'))
      if (fromEditor && e.defaultPrevented) return
      if (showQuickOpen) {
        setShowQuickOpen(false)
        return
      }
      if (confirmWipe !== null) {
        setConfirmWipe(null)
        return
      }
      if (busy) {
        stopRef.current()
        return
      }
      if (mode !== 'studio') return
      // through the navigation guard: flush a dirty buffer (keep the Studio on a
      // failed save), and never leave over a pending AI diff
      leaveTabRef.current(leaveStudio)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible, mode, busy, errorDetail, confirmWipe, showQuickOpen])

  const reveal = useStore(() => aiStore.revealLine)
  useEffect(() => {
    if (reveal === null || reveal.file !== file) return
    let cancelled = false
    const t = setTimeout(() => {
      if (cancelled) return
      editorRef.current?.revealLine(reveal.line)
      clearRevealLine()
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [reveal, file])

  // a model the assistant built shows as a card in the reply being written
  useEffect(() => onBuiltModel((model) => setMessages((prev) => {
    let i = prev.length - 1
    while (i >= 0 && prev[i].role !== 'assistant') i--
    if (i < 0) return prev
    const msg = prev[i] as Extract<ChatMsg, { role: 'assistant' }>
    const next = [...prev]
    next[i] = { ...msg, models: [...(msg.models ?? []).filter((m) => m.name !== model.name), model] }
    return next
  })), [])
  useEffect(() => onThumbnail((thumbnail) => setMessages((prev) => {
    let i = prev.length - 1
    while (i >= 0 && prev[i].role !== 'assistant') i--
    if (i < 0) return prev
    const msg = prev[i] as Extract<ChatMsg, { role: 'assistant' }>
    const next = [...prev]
    next[i] = { ...msg, thumbnails: [...(msg.thumbnails ?? []).filter((t) => t.path !== thumbnail.path), thumbnail] }
    return next
  })), [])
  const prefill = useStore(() => aiStore.prefill)
  useEffect(() => {
    if (prefill === null) return
    setInput((cur) => (cur.trim() === '' ? prefill : `${cur.replace(/\s*$/, '')}\n\n${prefill}`))
    aiStore.prefill = null
    const ta = inputRef.current
    if (ta !== null) {
      ta.focus()
      requestAnimationFrame(() => ta.setSelectionRange(ta.value.length, ta.value.length))
    }
  }, [prefill])

  // Guard on every way of leaving the current tab (tab click/✕, ⌘W, tab cycling,
  // quick-open, the file rail, Escape-close). A streaming turn owns the editor
  // and a pending AI diff must be accepted or discarded, not navigated away; a
  // dirty buffer is flushed first, and a FAILED flush keeps the tab open — the
  // buffer is the only copy of the edits.
  const leaveTab = (then: () => void): void => {
    const ed = editorRef.current
    if (ed === null) {
      then()
      return
    }
    if (busy) {
      setFileStatus({ text: 'Wait for the assistant to finish', kind: 'dim' })
      return
    }
    if (ed.isReviewing()) {
      setFileStatus({ text: 'Accept or discard the change first', kind: 'dim' })
      return
    }
    if (!ed.isDirty()) {
      then()
      return
    }
    ed.flush().then(then, (err: unknown) => setFileStatus({ text: `Save failed — keeping the tab open: ${String(err)}`, kind: 'err' }))
  }
  const leaveTabRef = useRef(leaveTab)
  leaveTabRef.current = leaveTab

  // Studio keys handled in this window: ⌘⇧[ / ⌘⇧] tab cycling, and ⌘P quick
  // open. e.code, not e.key — shifted brackets produce different characters per
  // layout. Platform-primary modifier only: on a Mac, Ctrl+[ is an Escape alias
  // in text fields and CodeMirror.
  // In the desktop app the main process claims ⌘P (play/pause outside the
  // Studio) and it arrives as the 'goto-file' chord instead — this KeyP branch
  // never fires there. It exists for the web bundle, where nothing intercepts
  // the key and CodeMirror focus keeps it from the shortcuts dispatcher.
  useEffect(() => {
    if (mode !== 'studio') return
    const onKey = (e: KeyboardEvent): void => {
      if (!isPrimaryMod(e) || e.altKey) return
      if (e.code === 'KeyP' && !e.shiftKey) {
        e.preventDefault()
        setShowQuickOpen((v) => !v)
      } else if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault()
        const t = aiStore.tabs
        const f = aiStore.file
        if (t.length < 2 || f === null) return
        const i = t.indexOf(f)
        const next = t[(i + (e.code === 'BracketRight' ? 1 : -1) + t.length) % t.length]
        leaveTabRef.current(() => setStudioFile(next))
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      setShowQuickOpen(false)
    }
  }, [mode])

  // ⌘W (close tab), ⌘F (find in file) and ⌘Z/⌘⇧Z (text undo) are intercepted by
  // the main process; boot.ts offers them here first. ⌘W/⌘F are claimed even
  // when they can't act (no file open, read-only preview) — falling through to
  // "switch to the Move tool" / "fly the camera at the selection" behind an open
  // Studio would be far more surprising than a no-op. Undo/redo are claimed only
  // while the code editor has focus, so scene undo still works from the gutter.
  useEffect(() => {
    if (mode !== 'studio') return
    setStudioChordHandler((c) => {
      switch (c) {
        case 'close-tab': {
          const f = aiStore.file
          if (f !== null) leaveTabRef.current(() => closeDoc(f))
          return true
        }
        case 'find':
          editorRef.current?.openSearch()
          return true
        case 'undo':
          return editorRef.current?.textUndo() ?? false
        case 'redo':
          return editorRef.current?.textRedo() ?? false
        case 'goto-file':
          setShowQuickOpen((v) => !v)
          return true
      }
    })
    return () => setStudioChordHandler(null)
  }, [mode])

  // with no assistant there is no dock; the Studio is still the code editor
  const assistant = useStore(canAskAssistant)
  if (shell === undefined || (!assistant && mode !== 'studio')) return null

  const scriptFiles = entityScriptFiles() // scripts on the selected entity → Studio entry from the dock

  // Re-probe the CLIs (after the user installs/signs in) without restarting.
  // Not instant: finding a CLI installed under a version manager means asking
  // the user's login shell for its PATH, so the button reports it is working.
  const recheck = (): void => {
    const probe = shell.aiProviders?.()
    if (probe === undefined) return
    setRechecking(true)
    void probe
      .then((list) => {
        setProviders(list)
        if (!list.some((p) => p.id === provider && p.available)) {
          const first = list.find((p) => p.available)
          if (first !== undefined) {
            setProvider(first.id)
            setModel(first.defaultModel)
          }
        }
      })
      .catch((err: unknown) => console.error('recheck failed:', err))
      .finally(() => setRechecking(false))
  }

  // resuming keeps the composer and the original ask, so a later Retry resends that, not "Continue"
  const send = (text: string, resuming = false): void => {
    const t = text.trim()
    if ((t === '' && attachments.length === 0) || busy || !available) return
    const asked = t === '' ? 'Look at the attached image.' : t
    if (!resuming) lastPrompt.current = asked
    const sel = aiStore.selection
    const imgs = resuming ? [] : attachments
    const run = (): void => {
      openFileTouched.current = false
      setMessages((prev) => [
        ...prev,
        { role: 'user', text: asked, images: imgs.length > 0 ? imgs.map((i) => i.dataUrl) : undefined },
        { role: 'assistant', text: '', tools: [], done: false }
      ])
      if (!resuming) {
        setInput('')
        setAttachments([])
      }
      setBusy(true)
      void (async () => {
        const files = await projectFiles().catch((): string[] => [])
        return await shell.aiSend?.({ provider, model, text: asked, context: buildContext(sel, aiStore.file, files), images: imgs.length > 0 ? imgs : undefined })
      })().catch((err: unknown) => {
        setMessages((prev) => {
          const next = [...prev]
          for (let i = next.length - 1; i >= 0; i--) {
            const m = next[i]
            if (m.role === 'assistant' && !m.done) {
              next[i] = { ...m, done: true, error: String(err) }
              break
            }
          }
          return next
        })
        setBusy(false)
        editorRef.current?.freeze(false)
      })
    }
    // Studio + open file: save the buffer so the CLI edits the latest, baseline
    // it for the diff, and freeze the editor so human + AI can't diverge.
    const ed = editorRef.current
    if (mode === 'studio' && file !== null && ed !== null) {
      void ed
        .flush()
        .catch(() => {})
        .then(() => {
          ed.snapshot()
          ed.freeze(true)
          run()
        })
    } else run()
  }

  const retry = (): void => {
    if (lastPrompt.current !== null) send(lastPrompt.current)
  }
  const resume = (): void => {
    if (shell.aiCanResume?.() === true) {
      send('Continue where you left off.', true)
      return
    }
    if (lastPrompt.current === null) return
    setMessages((prev) => [...prev, { role: 'note', text: 'The paused conversation was lost, so this starts your request over' }])
    send(lastPrompt.current)
  }
  const stop = (): void => {
    void shell.aiStop?.()
    activeTurn.current = null
    setBusy(false)
    editorRef.current?.freeze(false)
    setMessages((prev) => prev.map((m) => (m.role === 'assistant' && !m.done ? { ...m, done: true } : m)))
  }
  stopRef.current = stop
  const doWipe = (): void => {
    if (shell.aiForget !== undefined) void shell.aiForget()
    else {
      void shell.aiStop?.()
      void shell.aiReset?.()
    }
    activeTurn.current = null
    setMessages([])
    setBusy(false)
    editorRef.current?.freeze(false)
    setHistory([])
  }

  // a running turn is stopped by doWipe, so clearing never waits on it
  const newChat = (
    <button
      className="eui-ai-headbtn icon eui-ai-newchat"
      disabled={messages.length === 0 && history.length === 0}
      onClick={() => setConfirmWipe({ label: 'Start a new chat? This clears the conversation for this scene.' })}
      {...labelTip('New chat')}
    >
      <IconNewChat />
    </button>
  )

  // The conversation column (messages + composer) — identical in both modes.
  const chat = (
    <div className="eui-ai-chat">
      <div className="eui-ai-body" ref={scrollRef}>
        {!available && <AiSetup providers={providers} current={current} anyAvailable={anyAvailable} onRecheck={recheck} rechecking={rechecking} />}
        {available && messages.length === 0 && history.length === 0 && <AiEmpty current={current} studio={mode === 'studio'} onExample={send} />}
        {history.length > 0 && (
          <>
            <div className="eui-ai-note">Earlier conversation — the assistant doesn’t remember it</div>
            <div className="eui-ai-earlier">
              <MessageList messages={history} hosted={current?.transport === 'service'} onShowDetail={setErrorDetail} onChoose={messages.length === 0 ? (text) => send(text) : undefined} />
            </div>
            {messages.length > 0 && <div className="eui-ai-note">New conversation</div>}
          </>
        )}
        <MessageList messages={messages} hosted={current?.transport === 'service'} onRetry={retry} onContinue={resume} onShowDetail={setErrorDetail} onChoose={(text) => send(text)} />
      </div>
      <Composer
        available={available}
        busy={busy}
        input={input}
        onInput={setInput}
        inputRef={inputRef}
        onSend={send}
        onStop={stop}
        entities={entities}
        onUnselectEntity={(id) => uiSelectEntity(id, true, true)}
        selection={selection}
        onClearSelection={() => setSelection(null)}
        attachments={attachments}
        onAddImages={addImages}
        onRemoveImage={(i) => setAttachments((prev) => prev.filter((_, j) => j !== i))}
        fileRef={fileRef}
        confirm={confirmWipe}
        onConfirmYes={() => {
          if (confirmWipe !== null) doWipe()
          setConfirmWipe(null)
        }}
        onConfirmCancel={() => setConfirmWipe(null)}
      />
    </div>
  )

  const errorModal =
    errorDetail !== null ? (
      <Modal
        title="Assistant error"
        className="eui-ai-errmodal"
        onClose={() => setErrorDetail(null)}
        footer={
          <>
            <Button onClick={() => void navigator.clipboard?.writeText(errorDetail)}>Copy</Button>
            <Button variant="primary" onClick={() => setErrorDetail(null)}>Close</Button>
          </>
        }
      >
        <ErrorDetails message={errorDetail} hosted={current?.transport === 'service'} />
      </Modal>
    ) : null

  if (mode === 'studio') {
    return (
      <>
        {errorModal}
        {showQuickOpen && <QuickOpen onOpen={(p) => leaveTab(() => openDoc(p))} onClose={() => setShowQuickOpen(false)} />}
        <StudioShell
          file={file}
          tabs={tabs}
          dirty={dirty}
          railKey={railKey}
          fileStatus={fileStatus}
          editorRef={editorRef}
          onLeaveTab={leaveTab}
          onOpenDoc={openDoc}
          onDirty={setDirty}
          onStatus={(text, kind) => setFileStatus({ text, kind })}
          onAsk={
            assistant
              ? (s) => {
                  setSelection(s)
                  inputRef.current?.focus()
                }
              : undefined
          }
          chat={assistant ? chat : null}
          headActions={assistant ? newChat : null}
        />
      </>
    )
  }

  return (
    <>
      {errorModal}
      <aside
        className={`eui-ai-panel${collapsed ? ' min' : ''}`}
        style={collapsed || props.fill ? undefined : { height: props.height, flex: '0 0 auto' }}
      >
      <header className="eui-ai-head">
        <button
          className={`eui-ai-headbtn icon${collapsed ? ' min' : ''}`}
          onClick={toggleAssistantCollapsed}
          data-tip={collapsed ? 'Expand the assistant' : 'Minimize to the title bar'}
          aria-label={collapsed ? 'Expand the assistant' : 'Minimize the assistant'}
        >
          <IconChevron />
        </button>
        <span className="eui-ai-title">
          <IconBot /> Assistant
        </span>
        <span style={{ flex: 1 }} />
        {!collapsed && newChat}
        {!collapsed && (
          <button
            className="eui-ai-headbtn eui-ai-studiobtn"
            onClick={() => {
              if (scriptFiles.length > 0 && (file === null || !scriptFiles.includes(file))) openStudio(scriptFiles[0], scriptFiles)
              else setMode('studio')
            }}
            data-tip="Open Studio (files + editor + chat)"
          >
            ⤢ Code
          </button>
        )}
      </header>
      {!collapsed && chat}
      </aside>
    </>
  )
}
