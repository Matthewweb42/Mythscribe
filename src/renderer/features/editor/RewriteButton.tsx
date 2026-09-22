import { useCallback } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { Wand2 } from 'lucide-react'
import { AI_DATA_SHARING, AI_DIAL_LABEL, isFeatureAllowed } from '@shared/aiSettings'
import { REWRITE_TEXT_MAX, REWRITE_TEXT_MIN } from '@shared/rewrite'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { captureRewriteText } from './rewriteTarget'
import { useRewriteStore } from './rewriteStore'

const BUTTON =
  'flex shrink-0 items-center gap-1 rounded-md whitespace-nowrap px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'

const MAX_LABEL = REWRITE_TEXT_MAX.toLocaleString()

/**
 * "Rewrite in my voice" in the single-document toolbar (F-14.10): enabled while the selection
 * holds 20–4,000 characters of plain text, the AI dial allows the feature (Suggest or higher,
 * toggle on), and no rewrite is in progress; the title says which condition is missing.
 * Mouse-down is swallowed so the selection survives the click. The click hands the editor to
 * the rewrite store, which captures the passage and shows the panel.
 */
export function RewriteButton({
  editor,
  nodeId
}: {
  editor: Editor | null
  nodeId: string
}): React.JSX.Element {
  const selector = useCallback(
    () => (editor ? captureRewriteText(editor).text.length : 0),
    [editor]
  )
  const length = useEditorState({ editor, selector }) ?? 0
  const settings = useAiSettingsStore((s) => s.settings)
  const busy = useRewriteStore((s) => s.session !== null)
  const start = useRewriteStore((s) => s.start)

  const { minDial } = AI_DATA_SHARING.rewrite
  const allowed = settings !== null && isFeatureAllowed(settings, 'rewrite')
  const inRange = length >= REWRITE_TEXT_MIN && length <= REWRITE_TEXT_MAX
  let title = 'Rewrite the selection in your voice'
  if (settings === null || settings.dial < minDial) {
    title = `Rewrite in my voice needs the AI dial at ${AI_DIAL_LABEL[minDial]} or higher (Settings, AI tab)`
  } else if (!allowed) {
    title = 'Rewrite in my voice is turned off for this project (Settings, AI tab)'
  } else if (busy) {
    title = 'A rewrite is already in progress'
  } else if (length > REWRITE_TEXT_MAX) {
    title = `The selection is over ${MAX_LABEL} characters`
  } else if (!inRange) {
    title = `Select ${REWRITE_TEXT_MIN}–${MAX_LABEL} characters to rewrite them in your voice`
  }

  return (
    <button
      type="button"
      aria-label="Rewrite in my voice"
      title={title}
      disabled={!editor || !allowed || busy || !inRange}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (editor) start(nodeId, editor)
      }}
      className={BUTTON}
    >
      <Wand2 size={14} aria-hidden="true" />
      Rewrite
    </button>
  )
}
