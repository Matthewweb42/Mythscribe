import { useCallback } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { Glasses } from 'lucide-react'
import { AI_DATA_SHARING, AI_DIAL_LABEL, isFeatureAllowed } from '@shared/aiSettings'
import { BETA_READER_TEXT_MIN } from '@shared/betaReader'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useBetaReaderStore } from './betaReaderStore'

const BUTTON =
  'flex shrink-0 items-center gap-1 rounded-md whitespace-nowrap px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'

const MIN_LABEL = BETA_READER_TEXT_MIN.toLocaleString()

/**
 * "Beta reader" in the single-document toolbar (F-14.11): enabled while the scene holds at
 * least `BETA_READER_TEXT_MIN` characters, the AI dial allows the feature (Ask or higher,
 * toggle on), and no read is in progress; the title says which condition is missing. The click
 * hands the document id to the beta reader store, which flushes the autosave and asks main.
 */
export function BetaReaderButton({
  editor,
  nodeId
}: {
  editor: Editor | null
  nodeId: string
}): React.JSX.Element {
  const selector = useCallback(() => (editor ? editor.state.doc.textContent.length : 0), [editor])
  const length = useEditorState({ editor, selector }) ?? 0
  const settings = useAiSettingsStore((s) => s.settings)
  const busy = useBetaReaderStore((s) => s.session !== null)
  const start = useBetaReaderStore((s) => s.start)

  const { minDial } = AI_DATA_SHARING.betaReader
  const allowed = settings !== null && isFeatureAllowed(settings, 'betaReader')
  const longEnough = length >= BETA_READER_TEXT_MIN
  let title = 'Read the manuscript up to this scene as a first-time reader'
  if (settings === null || settings.dial < minDial) {
    title = `Beta reader needs the AI dial at ${AI_DIAL_LABEL[minDial]} or higher (Settings, AI tab)`
  } else if (!allowed) {
    title = 'Beta reader is turned off for this project (Settings, AI tab)'
  } else if (busy) {
    title = 'The beta reader is already reading'
  } else if (!longEnough) {
    title = `Write ${MIN_LABEL} characters before asking for a beta read`
  }

  return (
    <button
      type="button"
      aria-label="Beta reader"
      title={title}
      disabled={!editor || !allowed || busy || !longEnough}
      onClick={() => start(nodeId)}
      className={BUTTON}
    >
      <Glasses size={14} aria-hidden="true" />
      Beta reader
    </button>
  )
}
