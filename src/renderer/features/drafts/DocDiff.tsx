import { useMemo } from 'react'
import type { DraftDocDiff } from '@shared/drafts'
import { collapseUnchanged } from './diffContext'

const BUTTON =
  'rounded-md border border-line px-2.5 py-1 text-xs hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'

/**
 * One changed document of a comparison (drafts F-8.5, snapshots F-8.6): where it sits, how many
 * words moved, the inline word diff (removed text struck through, added text highlighted, long
 * unchanged stretches collapsed), and an optional action button (a revert or a restore) when
 * `actionLabel` is given.
 */
export function DocDiff({
  doc,
  actionLabel,
  busy,
  onAction
}: {
  doc: DraftDocDiff
  actionLabel: string | null
  busy: boolean
  onAction: () => void
}): React.JSX.Element {
  const shown = useMemo(() => collapseUnchanged(doc.segments), [doc.segments])
  const title = doc.title || 'Untitled'
  return (
    <section
      aria-label={title}
      data-testid="draft-diff"
      className="flex flex-col gap-1.5 rounded-md border border-line bg-surface px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
        <h3 className="m-0 text-sm font-semibold">
          {doc.path.length > 0 ? (
            <span className="font-normal text-fg-muted">{`${doc.path.join(' › ')} › `}</span>
          ) : null}
          {title}
        </h3>
        <span className="text-xs text-fg-muted">
          {`+${doc.wordsAdded.toLocaleString()} / −${doc.wordsRemoved.toLocaleString()} words`}
        </span>
        {actionLabel !== null ? (
          <button type="button" disabled={busy} onClick={onAction} className={`${BUTTON} ml-auto`}>
            {actionLabel}
          </button>
        ) : null}
      </div>
      <p data-testid="draft-diff-text" className="rewrite-diff m-0 whitespace-pre-wrap text-sm">
        {shown.map((segment, i) =>
          segment.op === 'gap' ? (
            <span
              key={i}
              className="text-fg-subtle"
              title={`${segment.chars} unchanged characters`}
            >
              {' … '}
            </span>
          ) : segment.op === 'del' ? (
            <del key={i}>{segment.text}</del>
          ) : segment.op === 'add' ? (
            <ins key={i}>{segment.text}</ins>
          ) : (
            <span key={i}>{segment.text}</span>
          )
        )}
      </p>
    </section>
  )
}
