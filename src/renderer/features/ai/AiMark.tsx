/**
 * The small "AI" mark on something the AI made or applied itself, not the author (CLAUDE.md, AI
 * rule 1): a plan link applied automatically, a secret the reader found. `title` says what.
 */
export function AiMark({ title }: { title: string }): React.JSX.Element {
  return (
    <span title={title} className="rounded border border-line px-0.5 text-[10px] font-medium">
      AI
    </span>
  )
}
