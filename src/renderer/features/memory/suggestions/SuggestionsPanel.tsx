import { SideWorkFrame } from '@renderer/features/sideWork/SideWorkFrame'
import { useTakesFocus } from '@renderer/features/sideWork/sideWork'
import { useMemoryStore } from '../memoryStore'
import { SuggestionsReview } from './SuggestionsReview'

/**
 * The suggestions as side work (F-16.17, plan `Suggestions.md`): the status bar's "4 suggestions"
 * opens every suggestion of the draft on the review deck in the assistant column, beside the
 * editor (never over it); "Back to the conversation" or Escape hides it, and what was left for
 * later waits under the same item.
 */
export function SuggestionsPanel(): React.JSX.Element {
  const hide = (): void => useMemoryStore.getState().setSuggestionsShown(false)
  const autoFocus = useTakesFocus()
  return (
    <SideWorkFrame title="Suggestions" testId="suggestions-panel" onEscape={hide} onHide={hide}>
      <p className="mt-1 mb-2 shrink-0 px-3 text-xs text-fg-muted">
        What the AI read in your scenes. Nothing is used until you accept it.
      </p>
      <SuggestionsReview scope={{}} compact autoFocus={autoFocus} empty="No suggestions waiting." />
    </SideWorkFrame>
  )
}
