import { useCallback, useEffect, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { MessageSquareQuote, Wand2 } from 'lucide-react'
import { rewriteReason } from '@renderer/features/ai/aiActions'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { captureRewriteText } from './rewriteTarget'
import { useRewriteStore } from './rewriteStore'
import { askAboutSelection, rewriteSelection, selectionOffer } from './selectionActions'
import { useAssistantName } from '@renderer/features/shell/viewStore'

const BUTTON =
  'flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg hover:bg-surface disabled:opacity-40 disabled:hover:bg-transparent'
/** How far above (or below) the selection's first line the bubble sits, in px. */
const BUBBLE_GAP = 6
/** The room the bubble needs above the line; with less it goes under the line. */
const BUBBLE_ROOM = 40
/** The bubble's width at most, to keep it inside the window. */
const BUBBLE_WIDTH = 180

/**
 * The selection bubble (2026-10-06, "highlight a spot and then click rewrite"): while the
 * author has text selected in a document and the editor has the focus, a small bar floats above
 * the selection's first line with Rewrite (the rewrite flow, its result in the assistant panel)
 * and Ask AI (the passage goes to the composer as a quote). A button the dial or toggle forbids
 * is not shown; with neither allowed there is no bubble. Rewrite is disabled with the reason
 * while the selection is out of its bounds or a rewrite runs. Mouse-down is swallowed so the
 * selection survives the click. Positioned with `coordsAtPos` (no floating-UI dependency) on
 * every render, and rendered again on any scroll.
 */
export function SelectionBubble({
  editor,
  nodeId
}: {
  editor: Editor | null
  nodeId: string
}): React.JSX.Element | null {
  const selector = useCallback(() => {
    if (!editor || editor.isDestroyed) return null
    const { from, to, empty } = editor.state.selection
    if (empty || !editor.isEditable || !editor.isFocused) return null
    return { from, to, length: captureRewriteText(editor).text.length }
  }, [editor])
  const selection = useEditorState({
    editor,
    selector,
    equalityFn: (a, b) =>
      a === b ||
      (a !== null && b !== null && a.from === b.from && a.to === b.to && a.length === b.length)
  })
  const settings = useAiSettingsStore((s) => s.settings)
  const assistantName = useAssistantName()
  // Subscribed so the Rewrite button follows a rewrite starting and ending.
  useRewriteStore((s) => s.session !== null)
  const offer = selectionOffer(settings)
  // Bumped by any scroll while the bubble shows, so it is measured again where the text went.
  const [, setScrolled] = useState(0)

  useEffect(() => {
    if (selection === null) return
    const onScroll = (): void => setScrolled((n) => n + 1)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [selection])

  if (!editor || selection === null || (!offer.rewrite && !offer.ask)) return null
  const reason = offer.rewrite ? rewriteReason(settings, selection.length) : null
  // Above the selection's first line, or under it when the line is at the top of the window;
  // kept inside the window, so a selection that starts out of view still has its bubble at hand.
  const start = editor.view.coordsAtPos(selection.from)
  const above = start.top >= BUBBLE_ROOM
  const left = Math.max(4, Math.min(start.left, window.innerWidth - BUBBLE_WIDTH))
  const top = Math.min(
    Math.max(above ? start.top - BUBBLE_GAP : start.bottom + BUBBLE_GAP, 4),
    window.innerHeight - BUBBLE_ROOM
  )
  return (
    <div
      role="toolbar"
      aria-label="Selection"
      data-testid="selection-bubble"
      style={{ left, top }}
      onMouseDown={(event) => event.preventDefault()}
      className={`fixed z-30 ${above ? '-translate-y-full' : ''} flex items-center gap-0.5 rounded-md border border-line bg-surface-raised p-0.5 shadow-panel`}
    >
      {offer.rewrite ? (
        <button
          type="button"
          data-testid="selection-rewrite"
          disabled={reason !== null}
          title={reason ?? 'Rewrite the selection in your voice'}
          onClick={() => rewriteSelection(nodeId, editor)}
          className={BUTTON}
        >
          <Wand2 size={12} aria-hidden="true" />
          Rewrite
        </button>
      ) : null}
      {offer.ask ? (
        <button
          type="button"
          data-testid="selection-ask"
          title={`Ask ${assistantName} about the selection`}
          onClick={() => askAboutSelection(editor)}
          className={BUTTON}
        >
          <MessageSquareQuote size={12} aria-hidden="true" />
          Ask AI
        </button>
      ) : null}
    </div>
  )
}
