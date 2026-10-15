import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SuggestionScope, type SuggestionView } from '@shared/memory/views'
import { ReviewDeck } from '@renderer/features/review/ReviewDeck'
import type { ReviewDecision, ReviewDeckItem } from '@renderer/features/review/reviewDeckModel'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useMemoryStore } from '../memoryStore'
import { acceptAllLabel, applyText, proofText, suggestionGroups } from './suggestionView'

/**
 * The suggestions on the review deck (F-16.17, plan `Suggestions.md`): one card per suggestion,
 * grouped by character on the rail with **Accept all for Mara**, *Accept* (A), *Later* (S) and
 * *Dismiss* (R). Decisions stay here until **Apply** (or the end of the deck with nothing left for
 * later): the accepted become memory, the dismissed go to the Dismissed list, the later ones wait.
 * Used by the status bar's side work (every suggestion of the draft) and by *Rebuild memory*'s
 * summary (the rebuild's own, `scope.claimIds`). Reads the list again whenever the number waiting
 * moves (a reading, an answer in the panel), keeping the decisions on what is still there.
 */
export function SuggestionsReview({
  scope,
  compact = false,
  autoFocus = false,
  actions,
  empty
}: {
  scope: SuggestionScope
  compact?: boolean
  autoFocus?: boolean
  actions?: ReactNode
  /** What shows when nothing waits. */
  empty: string
}): React.JSX.Element {
  const [list, setList] = useState<SuggestionView[] | null>(null)
  const [decisions, setDecisions] = useState<Record<string, ReviewDecision>>({})
  // The decisions as of now: the deck applies at its end in the same event as the last decision,
  // before React has rendered it.
  const latest = useRef<Record<string, ReviewDecision>>({})
  const decide = (next: Record<string, ReviewDecision>): void => {
    latest.current = next
    setDecisions(next)
  }
  const [busy, setBusy] = useState(false)
  const waiting = useMemoryStore((s) => s.status?.suggestions ?? 0)
  const scopeKey = JSON.stringify(scope)

  /** Takes a fresh list, keeping the decisions on what is still there. */
  const take = useCallback((answer: SuggestionView[]): void => {
    setList(answer)
    const kept: Record<string, ReviewDecision> = {}
    for (const each of answer) {
      const decision = latest.current[each.id]
      if (decision !== undefined) kept[each.id] = decision
    }
    latest.current = kept
    setDecisions(kept)
  }, [])
  const ask = useCallback(
    () => ipc().invoke('memory:suggestions', SuggestionScope.parse(JSON.parse(scopeKey))),
    [scopeKey]
  )
  const read = async (): Promise<void> => take(await ask())

  useEffect(() => {
    let live = true
    ask()
      .then((answer) => {
        if (live) take(answer)
      })
      .catch((err: unknown) => toast.error(describeError(err)))
    return () => {
      live = false
    }
  }, [ask, take, waiting])

  const items = useMemo<ReviewDeckItem[]>(
    () =>
      (list ?? []).map((each) => ({
        id: each.id,
        group: each.recordId ?? '',
        decision: decisions[each.id] ?? 'pending'
      })),
    [list, decisions]
  )
  const groups = useMemo(() => suggestionGroups(list ?? []), [list])
  const byId = useMemo(() => new Map((list ?? []).map((each) => [each.id, each])), [list])
  const decided = (decision: ReviewDecision): string[] =>
    (list ?? []).flatMap((each) => (latest.current[each.id] === decision ? [each.id] : []))

  const apply = async (): Promise<void> => {
    const accepted = decided('accepted')
    const dismissed = decided('rejected')
    if (accepted.length === 0 && dismissed.length === 0) return
    setBusy(true)
    try {
      const store = useMemoryStore.getState()
      await store.acceptSuggestions(accepted)
      await store.dismissSuggestions(dismissed)
      await read()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  if (list === null) return <p className="m-0 px-3 py-3 text-sm text-fg-muted">Reading…</p>
  if (list.length === 0) {
    return (
      <>
        <p className="m-0 flex-1 px-3 py-3 text-sm text-fg-muted" data-testid="suggestions-none">
          {empty}
        </p>
        {actions === undefined ? null : (
          <div className="flex shrink-0 justify-end border-t border-line px-3 py-2">{actions}</div>
        )}
      </>
    )
  }
  return (
    <ReviewDeck
      label="Suggestions"
      testId="suggestions-review"
      items={items}
      groups={groups}
      renderCard={(id) => {
        const suggestion = byId.get(id)
        return suggestion === undefined ? null : <SuggestionCard suggestion={suggestion} />
      }}
      onDecide={(ids, decision) => {
        const next = { ...latest.current }
        for (const id of ids) next[id] = decision
        decide(next)
      }}
      reject
      rejectLabel="Dismiss"
      skipLabel="Later"
      groupAcceptLabel={acceptAllLabel}
      apply={{
        label: () => applyText(decided('accepted').length, decided('rejected').length),
        onApply: () => void apply()
      }}
      applyOnFinish
      busy={busy}
      compact={compact}
      autoFocus={autoFocus}
      actions={actions}
    />
  )
}

/** One suggestion's card: whose, the line, who says it, the quote and where it is. */
function SuggestionCard({ suggestion }: { suggestion: SuggestionView }): React.JSX.Element {
  return (
    <div className="space-y-2 text-sm" data-testid="suggestion-card">
      <p className="m-0">
        <span className="font-medium">{suggestion.name}</span>
        {' · '}
        {suggestion.line}
        {suggestion.note === null ? null : (
          <span className="text-fg-muted"> ({suggestion.note})</span>
        )}
      </p>
      <blockquote className="m-0 border-l-2 border-line pl-2 text-fg-muted italic">
        “{suggestion.quote}”
      </blockquote>
      <p className="m-0 text-xs text-fg-subtle">
        {suggestion.ref === '' ? '' : `In ${suggestion.ref} · `}
        {proofText(suggestion.proof)}
      </p>
    </div>
  )
}
