import { BalanceNotice } from '@renderer/features/account/BalanceNotice'
import { DraftStatus } from '@renderer/features/drafts/DraftStatus'
import { GoalsStrip } from '@renderer/features/goals/GoalsStrip'
import { formatDelta, formatWords } from './wordFormat'

/**
 * The line under the editor (F-3.3): the word count of what is shown and, for one document, how
 * much of it was written this session. A stacked folder shows only its combined count: its
 * rollup also moves when scenes are moved, duplicated, or deleted, so a delta there would not
 * mean "written". Presentational; the counts come from the caller so one document can count
 * live while a folder reads the saved rollup. `aiPercent` is the share of the document's
 * characters accepted from the AI (F-14.6), shown only while it is above zero. Three pieces read
 * a store of their own: `DraftStatus` (F-8.5, the active draft's name once there are two or
 * more; a click opens the Drafts dialog), `GoalsStrip` (F-10.3, today's words against the targets; a click opens
 * the Goals dialog) and `BalanceNotice` (F-15.5, AI-BILLING-SPEC E1), pushed to the far end: the
 * MythScribe Cloud balance whenever this project spends it, nothing otherwise.
 */
export function StatusBar({
  words,
  delta,
  aiPercent
}: {
  words: number
  delta?: number
  aiPercent?: number
}): React.JSX.Element {
  return (
    <footer
      data-testid="status-bar"
      className="flex shrink-0 items-center gap-3 border-t border-line bg-surface px-6 py-1 text-xs text-fg-muted"
    >
      <span data-testid="status-words">{formatWords(words)}</span>
      {delta !== undefined ? (
        <span data-testid="status-delta">{formatDelta(delta)} this session</span>
      ) : null}
      {aiPercent !== undefined && aiPercent > 0 ? (
        <span
          data-testid="status-ai"
          title="Share of this document's characters accepted from the AI"
        >
          {aiPercent}% AI
        </span>
      ) : null}
      <DraftStatus />
      <GoalsStrip />
      <BalanceNotice />
    </footer>
  )
}
