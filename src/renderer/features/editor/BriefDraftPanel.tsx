import { BRIEF_SCENE_CHAR_BUDGET, SCENE_BRIEF_FIELDS } from '@shared/sceneMeta'
import { RequestCost } from '@renderer/features/ai/RequestCost'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useBriefDraftStore } from './briefDraftStore'

const LINK_BUTTON = 'rounded px-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg'
const SECTION = 'm-0 shrink-0 border-b border-line bg-surface px-4 py-2'

/**
 * The brief draft (F-14.3) in the assistant panel's results (2026-10-06): the pending line with
 * its Cancel, an expected failure with its next step and Close, or the five drafted lines with
 * the scene they are for, what they cost, and the two ways to settle them. Nothing while idle.
 */
export function BriefDraftPanel(): React.JSX.Element | null {
  const state = useBriefDraftStore((s) => s.draft)
  const cancel = useBriefDraftStore((s) => s.cancel)
  const accept = useBriefDraftStore((s) => s.accept)
  const discard = useBriefDraftStore((s) => s.discard)
  const title = useTreeStore((s) => (state ? (s.byId[state.nodeId]?.title ?? '') : ''))
  if (state === null) return null
  if (state.status === 'pending') {
    return (
      <p role="status" className={`${SECTION} flex items-center gap-2 text-xs text-fg-muted`}>
        <span>Drafting the brief…</span>
        <button
          type="button"
          data-testid="brief-draft-cancel"
          onClick={cancel}
          className={LINK_BUTTON}
        >
          Cancel
        </button>
      </p>
    )
  }
  if (state.status === 'error') {
    return (
      <p
        role="status"
        data-testid="brief-draft-error"
        className={`${SECTION} flex flex-wrap items-center gap-2 text-xs text-danger`}
      >
        <span>
          {state.message} {state.nextStep}
        </span>
        <button type="button" onClick={discard} className={LINK_BUTTON}>
          Close
        </button>
      </p>
    )
  }
  return (
    <div role="group" aria-label="Brief draft" className={`${SECTION} flex flex-col gap-1`}>
      <p className="m-0 text-xs font-medium text-fg-muted">
        Scene brief draft{title ? ` · ${title}` : ''}
      </p>
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
        <span data-testid="brief-draft-cost">
          <RequestCost request={state} />
        </span>
        <button type="button" onClick={() => void accept()} className={LINK_BUTTON}>
          Use draft
        </button>
        <button type="button" onClick={discard} className={LINK_BUTTON}>
          Discard
        </button>
      </p>
    </div>
  )
}
