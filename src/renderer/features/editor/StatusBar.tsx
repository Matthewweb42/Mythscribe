import { formatDelta, formatWords } from './wordFormat'

/**
 * The line under the editor (F-3.3): the word count of what is shown and, for one document, how
 * much of it was written this session. A stacked folder shows only its combined count: its
 * rollup also moves when scenes are moved, duplicated, or deleted, so a delta there would not
 * mean "written". Presentational; the counts come from the caller so one document can count
 * live while a folder reads the saved rollup.
 */
export function StatusBar({ words, delta }: { words: number; delta?: number }): React.JSX.Element {
  return (
    <footer
      data-testid="status-bar"
      className="flex shrink-0 items-center gap-3 border-t border-line bg-surface px-6 py-1 text-xs text-fg-muted"
    >
      <span data-testid="status-words">{formatWords(words)}</span>
      {delta !== undefined ? (
        <span data-testid="status-delta">{formatDelta(delta)} this session</span>
      ) : null}
    </footer>
  )
}
