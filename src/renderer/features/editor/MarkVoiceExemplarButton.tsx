import { useCallback } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { Quote } from 'lucide-react'
import { VOICE_EXEMPLAR_MAX, VOICE_EXEMPLAR_TEXT_MAX, VOICE_EXEMPLAR_TEXT_MIN } from '@shared/voice'
import { useVoiceStore } from '@renderer/features/ai/voiceStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { selectedText } from './selectedText'

const BUTTON =
  'flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'

const MAX_LABEL = VOICE_EXEMPLAR_TEXT_MAX.toLocaleString()

/**
 * "Mark voice exemplar" in the single-document toolbar (F-14.1): enabled while the selection
 * holds 80–2,000 characters of plain text and the project has room for another exemplar; the
 * title says which condition is missing. Mouse-down is swallowed so the selection survives the
 * click. Marking goes through the voice store (main snapshots the text with the scene's POV
 * and a kind) and toasts the new count; a refusal toasts its message.
 */
export function MarkVoiceExemplarButton({
  editor,
  nodeId
}: {
  editor: Editor | null
  nodeId: string
}): React.JSX.Element {
  const selector = useCallback(() => (editor ? selectedText(editor).length : 0), [editor])
  const length = useEditorState({ editor, selector }) ?? 0
  const count = useVoiceStore((s) => s.exemplars?.length ?? 0)
  const add = useVoiceStore((s) => s.add)

  const full = count >= VOICE_EXEMPLAR_MAX
  const inRange = length >= VOICE_EXEMPLAR_TEXT_MIN && length <= VOICE_EXEMPLAR_TEXT_MAX
  let title = 'Mark the selection as a voice exemplar'
  if (full) {
    title = `Your voice profile already holds ${VOICE_EXEMPLAR_MAX} exemplars (remove one in Settings, AI tab)`
  } else if (length > VOICE_EXEMPLAR_TEXT_MAX) {
    title = `The selection is over ${MAX_LABEL} characters`
  } else if (!inRange) {
    title = `Select ${VOICE_EXEMPLAR_TEXT_MIN}–${MAX_LABEL} characters to mark them as a voice exemplar`
  }

  const mark = (): void => {
    if (!editor) return
    add(nodeId, selectedText(editor))
      .then(() => {
        const total = useVoiceStore.getState().exemplars?.length ?? count + 1
        toast.success(`Added to your voice profile (${total} of ${VOICE_EXEMPLAR_MAX})`)
      })
      .catch((err: unknown) => toast.error(describeError(err)))
  }

  return (
    <button
      type="button"
      aria-label="Mark voice exemplar"
      title={title}
      disabled={!editor || full || !inRange}
      onMouseDown={(event) => event.preventDefault()}
      onClick={mark}
      className={BUTTON}
    >
      <Quote size={14} aria-hidden="true" />
      Voice exemplar
    </button>
  )
}
