import { BRIEF_SCENE_CHAR_BUDGET, SCENE_BRIEF_FIELDS } from '@shared/sceneMeta'
import { describeRequest } from '@renderer/features/ai/usageFormat'
import type { BriefDraft } from './briefDraft'

const LINK_BUTTON = 'rounded px-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg'

/**
 * What the brief draft (F-14.3) looks like beside the fields: the pending line with its Cancel,
 * an expected failure with its next step, or the five drafted lines with what they cost and the
 * two ways to settle them. Nothing while idle.
 */
export function BriefDraftPanel({ draft }: { draft: BriefDraft }): React.JSX.Element | null {
  const state = draft.state
  if (state === null) return null
  if (state.status === 'pending') {
    return (
      <p role="status" className="m-0 flex items-center gap-2 text-xs text-fg-muted">
        <span>Drafting the brief…</span>
        <button
          type="button"
          data-testid="brief-draft-cancel"
          onClick={draft.cancel}
          className={LINK_BUTTON}
        >
          Cancel
        </button>
      </p>
    )
  }
  if (state.status === 'error') {
    return (
      <p role="status" data-testid="brief-draft-error" className="m-0 text-xs text-danger">
        {state.message} {state.nextStep}
      </p>
    )
  }
  return (
    <div
      role="group"
      aria-label="Brief draft"
      className="rounded-md border border-dashed border-line p-1.5"
    >
      <ul
        role="list"
        aria-label="Drafted brief"
        className="m-0 flex list-none flex-col gap-0.5 p-0"
      >
        {SCENE_BRIEF_FIELDS.map(({ key, label }) => (
          <li key={key} className="text-xs">
            <span className="text-fg-subtle">{label}: </span>
            {state.brief[key].trim() || '—'}
          </li>
        ))}
      </ul>
      {state.truncated ? (
        <p className="mt-1 mb-0 text-xs text-fg-subtle">
          {`Drafted from the first ${BRIEF_SCENE_CHAR_BUDGET.toLocaleString()} characters.`}
        </p>
      ) : null}
      <p className="mt-1 mb-0 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
        <span data-testid="brief-draft-cost">{describeRequest(state)}</span>
        <button type="button" onClick={draft.accept} className={LINK_BUTTON}>
          Use draft
        </button>
        <button type="button" onClick={draft.discard} className={LINK_BUTTON}>
          Discard
        </button>
      </p>
    </div>
  )
}
