import { useEffect, useId, useState, type FocusEvent, type MouseEvent } from 'react'
import { Image, MessageSquare, Minimize2, RefreshCw, StickyNote } from 'lucide-react'
import { OVERLAY_DARKNESS, OVERLAY_WIDTH, clampInt, defaultFocusSettings } from '@shared/focus'
import { useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { useLiveDocStats } from '@renderer/features/editor/liveDocStats'
import { VibeWriteToggle } from '@renderer/features/editor/VibeWriteToggle'
import { formatWords } from '@renderer/features/editor/wordFormat'
import { SHOW_ZONE_PX, useAutoHide } from './autoHide'
import { BackgroundManager } from './BackgroundManager'
import { useBackgroundStore } from './backgroundStore'
import { useFocusStore } from './focusStore'

const BUTTON =
  'flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 aria-pressed:bg-surface-raised aria-pressed:text-accent'
const SLIDER = 'flex items-center gap-1.5 text-xs text-fg-muted'

/** Keeps the editor's caret: a click on a toggle never moves keyboard focus into the bar. */
const keepCaret = (event: MouseEvent<HTMLButtonElement>): void => event.preventDefault()

/**
 * The focus-mode control bar (F-6.5): a toolbar fixed to the bottom edge that hides itself
 * (`data-visible`) and shows when the pointer comes within `SHOW_ZONE_PX` of the edge, while
 * it is over the bar, while keyboard focus is inside it, or while its Backgrounds dialog is
 * open, plus an intro on entering focus mode; the timing lives in `useAutoHide`. Left to right:
 * Backgrounds (the same `BackgroundManager` as Settings → Editor), Rotate (the rotation
 * setting), VibeWrite (the toolbar's toggle), Notes and AI assistant (the focus store's
 * session flags, never the persisted layout), the darkness and width sliders (the overlay
 * setting, as in Settings → Editor), the active editor's live word count, and Exit. Mounted
 * by `App` inside `<main>` only in focus mode, outside the editor's scroll container.
 */
export function FocusControlBar(): React.JSX.Element {
  const { visible, hold } = useAutoHide()
  const settings = useBackgroundStore((s) => s.settings)
  const setRotation = useBackgroundStore((s) => s.setRotation)
  const setOverlay = useBackgroundStore((s) => s.setOverlay)
  const panels = useFocusStore((s) => s.panels)
  const togglePanel = useFocusStore((s) => s.togglePanel)
  const exit = useFocusStore((s) => s.exit)
  const activeEditor = useActiveEditorStore((s) => s.active?.editor ?? null)
  const live = useLiveDocStats(activeEditor)
  const [managerOpen, setManagerOpen] = useState(false)
  const darknessId = useId()
  const widthId = useId()

  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      hold('edge', window.innerHeight - event.clientY <= SHOW_ZONE_PX)
    }
    document.addEventListener('pointermove', onPointerMove)
    return () => document.removeEventListener('pointermove', onPointerMove)
  }, [hold])

  useEffect(() => {
    hold('dialog', managerOpen)
  }, [hold, managerOpen])

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) hold('focus', false)
  }

  const { rotation, overlay } = settings ?? defaultFocusSettings()
  const loaded = settings !== null

  return (
    <>
      <div
        role="toolbar"
        aria-label="Focus controls"
        data-testid="focus-control-bar"
        data-visible={visible}
        className="focus-control-bar"
        onPointerEnter={() => hold('bar', true)}
        onPointerLeave={() => hold('bar', false)}
        onFocus={() => hold('focus', true)}
        onBlur={onBlur}
      >
        <button type="button" onClick={() => setManagerOpen(true)} className={BUTTON}>
          <Image size={14} aria-hidden="true" />
          Backgrounds…
        </button>
        <button
          type="button"
          aria-pressed={rotation.enabled}
          disabled={!loaded}
          title={`Rotate backgrounds every ${rotation.intervalMinutes} min (Settings, Editor tab)`}
          onMouseDown={keepCaret}
          onClick={() => setRotation({ enabled: !rotation.enabled })}
          className={BUTTON}
        >
          <RefreshCw size={14} aria-hidden="true" />
          Rotate
        </button>
        <VibeWriteToggle error={null} />
        <button
          type="button"
          aria-pressed={panels.notes}
          onMouseDown={keepCaret}
          onClick={() => togglePanel('notes')}
          className={BUTTON}
        >
          <StickyNote size={14} aria-hidden="true" />
          Notes
        </button>
        <button
          type="button"
          aria-pressed={panels.assistant}
          onMouseDown={keepCaret}
          onClick={() => togglePanel('assistant')}
          className={BUTTON}
        >
          <MessageSquare size={14} aria-hidden="true" />
          AI assistant
        </button>
        <span className={SLIDER}>
          <label htmlFor={darknessId}>Darkness</label>
          <input
            id={darknessId}
            type="range"
            min={OVERLAY_DARKNESS.min}
            max={OVERLAY_DARKNESS.max}
            step={1}
            value={overlay.darkness}
            disabled={!loaded}
            onChange={(event) =>
              setOverlay({ darkness: clampInt(Number(event.target.value), OVERLAY_DARKNESS) })
            }
          />
          <span data-testid="focus-darkness-value">{overlay.darkness} %</span>
        </span>
        <span className={SLIDER}>
          <label htmlFor={widthId}>Width</label>
          <input
            id={widthId}
            type="range"
            min={OVERLAY_WIDTH.min}
            max={OVERLAY_WIDTH.max}
            step={1}
            value={overlay.width}
            disabled={!loaded}
            onChange={(event) =>
              setOverlay({ width: clampInt(Number(event.target.value), OVERLAY_WIDTH) })
            }
          />
          <span data-testid="focus-width-value">{overlay.width} %</span>
        </span>
        <span data-testid="focus-words" className="ml-auto text-xs text-fg-muted">
          {live ? formatWords(live.words) : ''}
        </span>
        <button type="button" onClick={() => void exit()} className={BUTTON}>
          <Minimize2 size={14} aria-hidden="true" />
          Exit focus mode
        </button>
      </div>
      {managerOpen ? <BackgroundManager onClose={() => setManagerOpen(false)} /> : null}
    </>
  )
}
