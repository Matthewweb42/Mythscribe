import { useMemo } from 'react'
import { diffWords } from '@shared/rewrite'

/** The quiet, the primary, and the quoted-passage buttons of a card that offers an AI fix. */
export const FIX_BUTTON =
  'flex items-center gap-1 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'
export const FIX_PRIMARY_BUTTON =
  'flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent'
export const FIX_QUOTE_BUTTON =
  'm-0 block w-full cursor-pointer border-0 border-l-2 border-line bg-transparent px-2 py-0.5 text-left text-sm italic text-fg-muted hover:border-accent hover:text-fg'

/**
 * The word-level diff of a quoted passage against its suggested fix, in the rewrite panel's
 * `.rewrite-diff` styles. Shared by the editor's notes (F-14.8) and the continuity findings
 * (F-13.4).
 */
export function FixDiff({
  quote,
  fix,
  testId
}: {
  quote: string
  fix: string
  testId: string
}): React.JSX.Element {
  const segments = useMemo(() => diffWords(quote, fix), [quote, fix])
  return (
    <p data-testid={testId} className="rewrite-diff m-0 whitespace-pre-wrap text-sm">
      {segments.map((segment, i) =>
        segment.kind === 'del' ? (
          <del key={i}>{segment.text}</del>
        ) : segment.kind === 'ins' ? (
          <ins key={i}>{segment.text}</ins>
        ) : (
          <span key={i}>{segment.text}</span>
        )
      )}
    </p>
  )
}

/** The mark on a fix that failed the voice fidelity check (F-14.7), with what it broke. */
export function OffVoiceFlag({
  violation,
  testId
}: {
  violation: string | null
  testId: string
}): React.JSX.Element {
  const reason = violation ?? 'does not match the voice profile'
  return (
    <span data-testid={testId} className="text-xs text-warning" title={reason}>
      {`⚠ Off-voice fix: ${reason}`}
    </span>
  )
}
