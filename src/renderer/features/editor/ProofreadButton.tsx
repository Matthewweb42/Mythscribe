import { useCallback } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { SpellCheck2 } from 'lucide-react'
import { AI_DATA_SHARING, AI_DIAL_LABEL, isFeatureAllowed } from '@shared/aiSettings'
import { PROOFREAD_TEXT_MIN } from '@shared/proofread'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { proofreadSelection, useProofreadStore } from './proofreadStore'

const BUTTON =
  'flex shrink-0 items-center gap-1 rounded-md whitespace-nowrap px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'

/**
 * "Proofread" in the single-document toolbar (F-14.12): enabled while the scene holds at least
 * `PROOFREAD_TEXT_MIN` characters, the AI dial allows the feature (Ask or higher, toggle on),
 * and no pass is in progress; the title says which condition is missing, and whether the
 * selection or the scene will be proofread. Mouse-down is swallowed so the selection survives
 * the click. The click hands the editor to the proofread store, which reads the selection,
 * flushes the autosave, and asks main.
 */
export function ProofreadButton({
  editor,
  nodeId
}: {
  editor: Editor | null
  nodeId: string
}): React.JSX.Element {
  const lengthOf = useCallback(() => (editor ? editor.state.doc.textContent.length : 0), [editor])
  const selectedOf = useCallback(
    () => (editor ? proofreadSelection(editor) !== null : false),
    [editor]
  )
  const length = useEditorState({ editor, selector: lengthOf }) ?? 0
  const selected = useEditorState({ editor, selector: selectedOf }) ?? false
  const settings = useAiSettingsStore((s) => s.settings)
  const busy = useProofreadStore((s) => s.session !== null)
  const start = useProofreadStore((s) => s.start)

  const { minDial } = AI_DATA_SHARING.proofread
  const allowed = settings !== null && isFeatureAllowed(settings, 'proofread')
  const longEnough = length >= PROOFREAD_TEXT_MIN
  let title = selected ? 'Proofread the selection' : 'Proofread this scene'
  if (settings === null || settings.dial < minDial) {
    title = `Proofread needs the AI dial at ${AI_DIAL_LABEL[minDial]} or higher (Settings, AI tab)`
  } else if (!allowed) {
    title = 'Proofread is turned off for this project (Settings, AI tab)'
  } else if (busy) {
    title = 'A proofreading pass is already in progress'
  } else if (!longEnough) {
    title = `Write ${PROOFREAD_TEXT_MIN} characters before proofreading`
  }

  return (
    <button
      type="button"
      aria-label="Proofread"
      title={title}
      disabled={!editor || !allowed || busy || !longEnough}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (editor) start(nodeId, editor)
      }}
      className={BUTTON}
    >
      <SpellCheck2 size={14} aria-hidden="true" />
      Proofread
    </button>
  )
}
