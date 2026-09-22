import { useCallback } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { NotebookPen } from 'lucide-react'
import { AI_DATA_SHARING, AI_DIAL_LABEL, isFeatureAllowed } from '@shared/aiSettings'
import { CRITIQUE_TEXT_MIN } from '@shared/critique'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useCritiqueStore } from './critiqueStore'

const BUTTON =
  'flex shrink-0 items-center gap-1 rounded-md whitespace-nowrap px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'

const MIN_LABEL = CRITIQUE_TEXT_MIN.toLocaleString()

/**
 * "Editor's notes" in the single-document toolbar (F-14.8): enabled while the scene holds at
 * least `CRITIQUE_TEXT_MIN` characters, the AI dial allows the feature (Ask or higher, toggle
 * on), and no critique is in progress; the title says which condition is missing. The click
 * hands the document id to the critique store, which flushes the autosave and asks main.
 */
export function CritiqueButton({
  editor,
  nodeId
}: {
  editor: Editor | null
  nodeId: string
}): React.JSX.Element {
  const selector = useCallback(() => (editor ? editor.state.doc.textContent.length : 0), [editor])
  const length = useEditorState({ editor, selector }) ?? 0
  const settings = useAiSettingsStore((s) => s.settings)
  const busy = useCritiqueStore((s) => s.session !== null)
  const start = useCritiqueStore((s) => s.start)

  const { minDial } = AI_DATA_SHARING.critique
  const allowed = settings !== null && isFeatureAllowed(settings, 'critique')
  const longEnough = length >= CRITIQUE_TEXT_MIN
  let title = "Get an editor's notes on this scene"
  if (settings === null || settings.dial < minDial) {
    title = `Editor's notes needs the AI dial at ${AI_DIAL_LABEL[minDial]} or higher (Settings, AI tab)`
  } else if (!allowed) {
    title = "Editor's notes is turned off for this project (Settings, AI tab)"
  } else if (busy) {
    title = "Editor's notes are already on the way"
  } else if (!longEnough) {
    title = `Write ${MIN_LABEL} characters before asking for editor's notes`
  }

  return (
    <button
      type="button"
      aria-label="Editor's notes"
      title={title}
      disabled={!editor || !allowed || busy || !longEnough}
      onClick={() => start(nodeId)}
      className={BUTTON}
    >
      <NotebookPen size={14} aria-hidden="true" />
      {"Editor's notes"}
    </button>
  )
}
