import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { state } from '@scene/state'
import { useStore } from './core/store'
import { useEditorShortcuts } from './shortcuts'
import { REBUILDING_FOR_PLAY } from './actions/playback'
import { getBootPhase, isViewportReady } from './boot/boot'
import { Toolbar } from './panels/Toolbar'
import { HierarchyPanel } from './panels/HierarchyPanel'
import { InspectorPanel } from './panels/InspectorPanel'
import { DeleteEntityDialog, NewEntityDialog, PlayEditWarningDialog } from './panels/dialogs'
import { CreatePrefabDialog } from './panels/CreatePrefabDialog'
import { ShortcutsOverlay } from './panels/ShortcutsOverlay'
import { AssetsPanel } from './panels/AssetsPanel'
import { PrefabDropLayer, PrefabsPanel } from './panels/PrefabsPanel'
import { AiPanel } from './panels/AiPanel'
import { aiStore, canAskAssistant } from './panels/ai-store'
import { chrome, toggleRightPanel, trackRightDock } from './core/chrome'
import { dragCapture } from './core/drag'
import { isLeftView, type LeftView } from './panels/left-view'
import { hasReadyMadePrefabs, sceneEmptiness } from './panels/empty-scene'
import { prefabStore } from './panels/prefab-store'
import { renameRequested } from './panels/reveal'
import { assetsReview } from './panels/assets-review'
import { storedValue, usePersistentEnum, usePersistentFlag, usePersistentNum } from './core/persist'
import { autoSaveStatus } from './core/autosave'
import { IconButton, Splitter, Toast as DsToast } from './ds'
import { IconSidebarLeft, IconSidebarRight } from './icons'
import { PhonePreviewPane } from './features/preview/PhonePreviewPane'

// Draggable right edge of the left dock.
function LeftResize(props: { width: number; onResize: (w: number) => void }): JSX.Element {
  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const startX = e.clientX
    const base = props.width
    dragCapture(e, (ev) => props.onResize(Math.max(248, Math.min(680, base + (ev.clientX - startX)))))
  }
  return (
    <div
      className="eui-left-resize"
      style={{ left: `calc(var(--edge-pad, 12px) + ${props.width - 5}px)` }}
      onPointerDown={onDown}
    />
  )
}

// Same drag, mirrored: the right column's left edge. Both panels in the column
// share the one width.
function RightResize(props: { width: number; onResize: (w: number) => void }): JSX.Element {
  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const startX = e.clientX
    const base = props.width
    dragCapture(e, (ev) => props.onResize(Math.max(280, Math.min(560, base + (startX - ev.clientX)))))
  }
  return (
    <div
      className="eui-right-resize"
      style={{ right: `calc(var(--edge-pad, 12px) + ${props.width - 5}px)` }}
      onPointerDown={onDown}
    />
  )
}

const DOCK_MIN_H = 200
// The inspector keeps its header plus a few rows however tall the assistant gets.
const INSPECTOR_MIN_H = 180
const COL_GAPS = 20
const LEFT_RISE_MS = 300

function maxDockHeight(colHeight: number): number {
  return Math.max(DOCK_MIN_H, colHeight - INSPECTOR_MIN_H - COL_GAPS)
}

function useElementHeight(el: HTMLElement | null): number {
  const [h, setH] = useState(() => window.innerHeight - 24)
  useEffect(() => {
    if (el === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (el.clientHeight > 0) setH(el.clientHeight)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return h
}

export function App(props: { playing?: boolean }): JSX.Element {
  const playing = props.playing === true
  const phase = useStore(getBootPhase)
  const viewport = useStore(isViewportReady)
  const ready = phase === 'ready'
  const frozen = useStore(() => state.frozen)
  const playEditWarn = useStore(() => state.playEditWarn)
  const deleteConfirm = useStore(() => state.deleteConfirm)
  const [newEntityOpen, setNewEntityOpen] = useState(false)
  const [createPrefab, setCreatePrefab] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [leftView, setLeftView] = usePersistentEnum<LeftView>('left-view', 'scene', isLeftView)
  const [leftWidth, setLeftWidth] = usePersistentNum('left-w', 300)
  const [leftOpen, setLeftOpen] = usePersistentFlag('left', true)
  const [leftSettled, setLeftSettled] = useState(false)
  useEffect(() => {
    if (!leftOpen) return setLeftSettled(false)
    const timer = setTimeout(() => setLeftSettled(true), LEFT_RISE_MS)
    return () => clearTimeout(timer)
  }, [leftOpen])
  const [rightWidth, setRightWidth] = usePersistentNum('right-w', 340)
  const [aiHeight, setAiHeight] = usePersistentNum('ai-h', 520)
  const [inspectorMin, setInspectorMin] = usePersistentFlag('right-min', false)
  const rightOpen = useStore(() => chrome.rightOpen)
  const aiMin = useStore(() => aiStore.collapsed)
  const aiMode = useStore(() => aiStore.mode)
  const aiHere = useStore(canAskAssistant)
  // Play the assistant runs (its playtest) is not the creator's: its turn and its
  // stop control stay on screen until that Play ends.
  const turnRunning = useStore(() => aiStore.turnRunning)
  const [assistantPlay, setAssistantPlay] = useState(false)
  useEffect(() => {
    if (!playing) setAssistantPlay(false)
    else if (turnRunning) setAssistantPlay(true)
  }, [playing, turnRunning])
  const dockInPlay = aiMode === 'studio' || assistantPlay || turnRunning
  // over a full-screen game there is nothing to edit, so a write then is not the creator's
  const editWarnHere = !playing || dockInPlay
  useEffect(() => {
    if (playEditWarn && !editWarnHere) state.playEditWarn = false
  }, [playEditWarn, editWarnHere])
  // the Studio is the code editor too, with or without an assistant beside it
  const studioHere = aiHere || aiMode === 'studio'
  // Who gets the column's leftover height: the inspector unless it is minimized,
  // in which case the docked chat takes it. Two minimized panels are two title
  // bars stacked at the top, with the viewport showing through below.
  const splitShown = !inspectorMin && aiHere && aiMode === 'dock' && !aiMin
  // A stored height from a taller window (or a since-shrunk column) would push
  // the composer off the bottom — clamp on the way out, not just while dragging.
  const [colEl, setColEl] = useState<HTMLDivElement | null>(null)
  const dockMax = maxDockHeight(useElementHeight(colEl))
  // the Studio's own chat column is what the drawer must clear while it is open
  useEffect(() => {
    if (colEl === null || aiMode === 'studio') return
    return trackRightDock(colEl)
  }, [colEl, rightOpen, aiMode])

  const dockHeight = Math.max(DOCK_MIN_H, Math.min(aiHeight, dockMax))
  // The dock is one unit: the inspector and the assistant show and hide together
  // (chrome.rightOpen), and neither can be dismissed on its own — only minimized
  // to its title bar. The Studio is the assistant's other mode, so it paints
  // full-screen from inside this same column and survives the dock being hidden.
  const rightCol = (
    <>
      <div
        ref={setColEl}
        className="eui-right-col"
        style={{ width: rightWidth }}
        hidden={(!rightOpen && aiMode !== 'studio') || (!ready && !studioHere) || (playing && !dockInPlay)}
      >
        {ready && rightOpen && <InspectorPanel min={inspectorMin} onToggleMin={() => setInspectorMin(!inspectorMin)} />}
        {ready && rightOpen && splitShown && (
          <Splitter label="Resize inspector and assistant" value={dockHeight} min={DOCK_MIN_H} max={dockMax} onChange={setAiHeight} />
        )}
        {studioHere && <AiPanel shown={rightOpen} fill={!ready || inspectorMin} height={dockHeight} />}
      </div>
      {rightOpen && (!playing || dockInPlay) && (ready || studioHere) && <RightResize width={rightWidth} onResize={setRightWidth} />}
    </>
  )
  const showPrefabs = (): void => {
    setLeftOpen(true)
    setLeftView('prefabs')
  }
  useEditorShortcuts(shortcutsOpen, setShortcutsOpen, showPrefabs)
  const firstRun = useRef(storedValue('left-view') === null)
  const emptyScene = useStore(sceneEmptiness)
  useEffect(() => {
    if (!firstRun.current || emptyScene === null) return
    firstRun.current = false
    if (emptyScene && hasReadyMadePrefabs()) setLeftView('prefabs')
  }, [emptyScene])
  const prefabReveal = useStore(() => prefabStore.reveal)
  const libraryReveal = useStore(() => prefabStore.revealLibrary)
  useEffect(() => {
    if (prefabReveal === null && libraryReveal === null) return
    showPrefabs()
  }, [prefabReveal, libraryReveal])
  const reviewAsks = useStore(() => assetsReview.asks)
  // App remounts when the chrome comes back: only an ask made since then opens the panel
  const seenAsks = useRef(reviewAsks)
  useEffect(() => {
    if (reviewAsks === seenAsks.current) return
    seenAsks.current = reviewAsks
    setLeftOpen(true)
    setLeftView('assets')
  }, [reviewAsks])
  const renamePending = useStore(renameRequested)
  useEffect(() => {
    if (!renamePending) return
    setLeftOpen(true)
    setLeftView('scene')
  }, [renamePending])

  return (
    <>
      {rightCol}
      <PhonePreviewPane
        left={leftOpen && ready ? leftWidth + 24 : 12}
        right={rightOpen ? rightWidth + 24 : 12}
        panelControls={<>
          <IconButton tip={leftOpen ? 'Hide hierarchy' : 'Show hierarchy'} active={leftOpen} aria-pressed={leftOpen} onClick={() => setLeftOpen(!leftOpen)}>
            <IconSidebarLeft />
          </IconButton>
          <IconButton tip={rightOpen ? 'Hide inspector & assistant' : 'Show inspector & assistant'} active={rightOpen} aria-pressed={rightOpen} onClick={toggleRightPanel}>
            <IconSidebarRight />
          </IconButton>
        </>}
      />
      {!ready ? (
        <div className="eui-boot">
          {phase === 'waiting-engine'
            ? 'Editor — waiting for engine…'
            : viewport
              ? 'Attaching editor tools…'
              : 'Editor — waiting for scene…'}
        </div>
      ) : (
        <>
          <PrefabDropLayer />
          <div className={leftSettled ? 'eui-play-hide eui-left-settled' : 'eui-play-hide'} hidden={playing}>
            <Toolbar
              leftOpen={leftOpen}
              rightOpen={rightOpen}
              onToggleLeft={() => setLeftOpen(!leftOpen)}
              onToggleRight={toggleRightPanel}
              onShortcuts={() => setShortcutsOpen(true)}
            />
            {leftOpen &&
              (leftView === 'scene' ? (
                <HierarchyPanel
                  width={leftWidth}
                  onNewEntity={() => setNewEntityOpen(true)}
                  onCreatePrefab={() => setCreatePrefab(true)}
                  onView={setLeftView}
                />
              ) : leftView === 'prefabs' ? (
                <PrefabsPanel
                  width={leftWidth}
                  onView={setLeftView}
                  onCreatePrefab={() => setCreatePrefab(true)}
                />
              ) : (
                <AssetsPanel width={leftWidth} onView={setLeftView} />
              ))}
            {leftOpen && <LeftResize width={leftWidth} onResize={setLeftWidth} />}
          </div>
          {!frozen && <div className="eui-play-frame" aria-hidden />}
          <Toast />
          {newEntityOpen && <NewEntityDialog onClose={() => setNewEntityOpen(false)} />}
          {createPrefab && (
            <CreatePrefabDialog onClose={() => setCreatePrefab(false)} />
          )}
          {playEditWarn && editWarnHere && <PlayEditWarningDialog />}
          {deleteConfirm !== null && <DeleteEntityDialog />}
          {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
        </>
      )}
    </>
  )
}

const FAILURE = /fail|could not|not saved|blocked|⚠/i

function Toast(): JSX.Element | null {
  const msg = useStore(() => state.saveStatus)
  const saveFailed = useStore(() => state.frozen && autoSaveStatus() === 'error')
  useEffect(() => {
    if (msg === '' || msg === 'saving…' || msg === REBUILDING_FOR_PLAY) return
    const t = setTimeout(() => {
      state.saveStatus = ''
    }, 5000)
    return () => clearTimeout(t)
  }, [msg])
  // outlives the 5s toast: the edits stay unsaved until a later save succeeds
  if (saveFailed) return <DsToast alert>Save failed — your latest changes are not saved. Your next edit tries again.</DsToast>
  if (msg === '' || msg === 'saving…') return null
  return <DsToast alert={FAILURE.test(msg)}>{msg}</DsToast>
}
