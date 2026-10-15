import { useState } from 'react'
import { Info } from 'lucide-react'
import type { SuggestionView } from '@shared/memory/views'
import { ClaimInfoCard } from '../ClaimInfo'
import { useMemoryStore } from '../memoryStore'
import { suggestionText } from './suggestionView'

const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-50 aria-expanded:bg-surface-raised aria-expanded:text-fg'

/**
 * Needs a look's "Suggestions from this scene" (F-16.17, plan `Suggestions.md`): each line a
 * reading proved in the open scene, with **ⓘ** (its quote and where it is), **Accept** and
 * **Dismiss**, and **Accept all**. Nothing here is memory until accepted; each answer offers *Undo*
 * in a toast, and a dismissed line is on the Dismissed list.
 */
export function SuggestionList({
  suggestions
}: {
  suggestions: readonly SuggestionView[]
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await work()
    } finally {
      setBusy(false)
    }
  }
  const store = useMemoryStore.getState
  return (
    <div data-testid="suggestions">
      <ul className="m-0 list-none p-0">
        {suggestions.map((suggestion) => (
          <SuggestionRow
            key={suggestion.id}
            suggestion={suggestion}
            busy={busy}
            onAccept={() => void run(() => store().acceptSuggestions([suggestion.id]))}
            onDismiss={() => void run(() => store().dismissSuggestions([suggestion.id]))}
          />
        ))}
      </ul>
      {suggestions.length > 1 ? (
        <button
          type="button"
          className={`${SMALL} mt-1`}
          disabled={busy}
          data-testid="suggestions-accept-all"
          onClick={() =>
            void run(() => store().acceptSuggestions(suggestions.map((each) => each.id)))
          }
        >
          Accept all ({suggestions.length})
        </button>
      ) : null}
    </div>
  )
}

function SuggestionRow({
  suggestion,
  busy,
  onAccept,
  onDismiss
}: {
  suggestion: SuggestionView
  busy: boolean
  onAccept: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const [info, setInfo] = useState(false)
  const text = suggestionText(suggestion)
  return (
    <li
      data-testid="suggestion-line"
      className="flex min-w-0 flex-wrap items-baseline gap-x-1 py-0.5 text-sm"
    >
      <span className="min-w-0">{text}</span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          aria-label={`Where this comes from: ${text}`}
          title="Where this comes from"
          aria-expanded={info}
          onClick={() => setInfo((open) => !open)}
          className={`${SMALL} flex items-center`}
        >
          <Info size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={SMALL}
          disabled={busy}
          aria-label={`Accept: ${text}`}
          onClick={onAccept}
        >
          Accept
        </button>
        <button
          type="button"
          className={SMALL}
          disabled={busy}
          aria-label={`Dismiss: ${text}`}
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </span>
      {info ? <ClaimInfoCard claimId={suggestion.id} /> : null}
    </li>
  )
}
