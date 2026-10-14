import { useState } from 'react'
import { Info, X } from 'lucide-react'
import type { FindingSideView, FindingView } from '@shared/memory/findings'
import { useMemoryStore, type RightMark } from '@renderer/features/memory/memoryStore'
import type { FindingInfoState } from './findingInfo'
import { useFindingInfo } from './findingInfo'
import { findingInfoLines, findingRuleLine } from './findingView'
import { openQuote, openSide } from './openSide'

const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'
const ICON_BUTTON =
  'flex size-5 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-surface-raised hover:text-fg aria-expanded:bg-surface-raised disabled:opacity-30'

/**
 * One possible contradiction in Needs a look (F-16.27, F-16.29; plan P4 §4): the rule's words
 * ("Mara Vell’s eyes: grey (1.1) · brown (1.2)", "Hobb dies in 4.3 and is here in 9.1"), both
 * quotes each with *Go there*, *This one's right* under each side whose other side is a book
 * passage (P4-D17: it marks the other side not right and never edits the manuscript), *Not a
 * problem* (the one Dismissed list, with Undo) and ⓘ (how it was found, judged and confirmed, and
 * what judging it cost). `unclear`: an unclear finding, muted, with *Go there* and *Not a problem*
 * only (never counted, never underlined). `report`: drawn in *Check the book*'s report.
 */
export function FindingRow({
  finding,
  unclear = false
}: {
  finding: FindingView
  unclear?: boolean
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const info = useFindingInfo()
  const act = async (run: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await run()
    } finally {
      setBusy(false)
    }
  }
  const store = useMemoryStore.getState
  const line = findingRuleLine(finding)
  return (
    <li
      className={`rounded-md border border-line bg-surface px-2 py-1.5 ${unclear ? 'opacity-70' : ''}`}
      data-testid={unclear ? 'unclear-finding' : 'finding'}
      data-rule={finding.rule}
    >
      <div className="flex items-start gap-1">
        <p className="m-0 min-w-0 flex-1 font-medium">{line}</p>
        {unclear ? null : <FindingInfoButton info={info} line={line} />}
      </div>
      <ul className="m-0 mt-1 list-none space-y-1 p-0">
        {(['a', 'b'] as const).map((key) => (
          <FindingSide
            key={key}
            side={finding[key]}
            right={!unclear && finding.actions.right[key]}
            busy={busy}
            onRight={() =>
              void act(() =>
                store().findingAction({ findingId: finding.id, action: 'right', side: key })
              )
            }
          />
        ))}
      </ul>
      <FindingInfoLines info={info} finding={finding} />
      <div className="mt-1 flex flex-wrap gap-1">
        <button
          type="button"
          className={SMALL}
          disabled={busy}
          aria-label={`Not a problem: ${line}`}
          onClick={() =>
            void act(() => store().findingAction({ findingId: finding.id, action: 'notProblem' }))
          }
        >
          Not a problem
        </button>
      </div>
    </li>
  )
}

/** ⓘ on a finding: how it was found, judged and confirmed, and what it cost. */
export function FindingInfoButton({
  info,
  line
}: {
  info: FindingInfoState
  line: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={ICON_BUTTON}
      aria-label={`How this was found: ${line}`}
      aria-expanded={info.open}
      aria-controls={info.id}
      onClick={info.toggle}
    >
      <Info size={12} aria-hidden="true" />
    </button>
  )
}

/** ⓘ's lines, while open. */
export function FindingInfoLines({
  info,
  finding
}: {
  info: FindingInfoState
  finding: FindingView
}): React.JSX.Element | null {
  if (!info.open) return null
  return (
    <ul id={info.id} className="m-0 mt-1 list-none p-0 text-fg-muted" data-testid="finding-info">
      {findingInfoLines(finding).map((each) => (
        <li key={each}>{each}</li>
      ))}
    </ul>
  )
}

/** One side: where it is, its quote, *Go there*, and (when offered) *This one's right*. */
function FindingSide({
  side,
  right,
  busy,
  onRight
}: {
  side: FindingSideView
  right: boolean
  busy: boolean
  onRight: () => void
}): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-baseline gap-1 text-fg-muted">
      <span className="shrink-0 tabular-nums">{side.label}</span>
      <q className="min-w-0 flex-1 text-fg">{side.quote}</q>
      <button
        type="button"
        className={SMALL}
        aria-label={`Go there: ${side.label}`}
        onClick={() => openSide(side)}
      >
        Go there
      </button>
      {right ? (
        <button
          type="button"
          className={SMALL}
          disabled={busy}
          aria-label={`This one's right: ${side.value} (${side.label})`}
          onClick={onRight}
        >
          This one’s right
        </button>
      ) : null}
    </li>
  )
}

/**
 * The unclear findings (design §2.4: "unclear is shown as unclear"): a collapsed "Unclear (n)"
 * line under Conflicts, each row muted with *Go there* and *Not a problem*; never counted.
 */
export function UnclearFindings({
  findings
}: {
  findings: readonly FindingView[]
}): React.JSX.Element | null {
  if (findings.length === 0) return null
  return (
    <details className="mt-2 text-xs" data-testid="unclear-findings">
      <summary className="cursor-pointer text-fg-muted">Unclear ({findings.length})</summary>
      <ul className="m-0 mt-1 list-none space-y-2 p-0">
        {findings.map((finding) => (
          <FindingRow key={finding.id} finding={finding} unclear />
        ))}
      </ul>
    </details>
  )
}

/**
 * The short line *This one's right* leaves (P4-D17): "Marked “brown” (1.2) not right", with *Go
 * there* (the scene, to fix the prose; nothing was edited), *Undo* (its Dismissed row goes and the
 * finding comes back) and ×.
 */
export function RightMarkLine({ mark }: { mark: RightMark }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const store = useMemoryStore.getState
  const words = `Marked “${mark.value}” (${mark.ref}) not right`
  return (
    <li
      className="flex flex-wrap items-center gap-1 rounded-md bg-surface-raised px-2 py-1"
      data-testid="right-mark"
    >
      <span className="min-w-0 flex-1">{words}</span>
      {mark.nodeId === null ? null : (
        <button
          type="button"
          className={SMALL}
          onClick={() => openQuote(mark.nodeId ?? '', mark.quote)}
        >
          Go there
        </button>
      )}
      <button
        type="button"
        className={SMALL}
        disabled={busy || mark.dismissedId === null}
        onClick={() => {
          setBusy(true)
          void store()
            .undoRightMark(mark.findingId)
            .finally(() => setBusy(false))
        }}
      >
        Undo
      </button>
      <button
        type="button"
        className={ICON_BUTTON}
        aria-label={`Close: ${words}`}
        onClick={() => store().dropRightMark(mark.findingId)}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </li>
  )
}
