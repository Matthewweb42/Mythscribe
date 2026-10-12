import { useState } from 'react'
import type { CardEntryName } from '@shared/memory/dismissed'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useMemoryStore } from './memoryStore'
import { cardCheckedNote, type CardChecked } from './memoryView'

const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'

/**
 * ⓘ and *Not right* for a value the scene's card gives (F-16.18; design Part 1, "every line the AI
 * wrote has ⓘ and Not right"): the scene's POV, place, time or year, or a character on the page.
 * The quote with *Go there*, its paragraph and how it was checked; *Not right* sends the value to
 * Dismissed (`memory:cardNotRight`), so Here, the card and the typed-detail conflicts leave it out
 * and the typed detail stands; *Undo* in Dismissed brings it back.
 */
export function CardValueInfo({
  nodeId,
  field,
  value,
  shown,
  quote,
  p,
  checked
}: {
  nodeId: string
  field: CardEntryName
  /** The card's value (a record's id for `pov` and `present`). */
  value: string
  /** The value as the author reads it ("Mara Vell", "the quay"). */
  shown: string
  quote: string
  p: number
  checked: CardChecked
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const goThere = (): void => {
    openPassage(nodeId, (doc) => locateText(doc, quote)).catch((err: unknown) =>
      toast.error(describeError(err))
    )
  }
  const notRight = async (): Promise<void> => {
    setBusy(true)
    await useMemoryStore.getState().cardNotRight({ nodeId, field, value })
    setBusy(false)
  }
  return (
    <span
      role="group"
      aria-label={`Where this comes from: ${shown}`}
      data-testid="card-value-info"
      className="flex w-full flex-wrap items-baseline gap-1 rounded-md border border-line bg-surface px-1.5 py-1 text-xs"
    >
      <q className="min-w-0 flex-1">{quote}</q>
      <button type="button" className={SMALL} onClick={goThere}>
        Go there
      </button>
      <button type="button" className={SMALL} disabled={busy} onClick={() => void notRight()}>
        Not right
      </button>
      <span className="w-full text-fg-muted">{`¶${p + 1} · ${cardCheckedNote(checked)}`}</span>
    </span>
  )
}
