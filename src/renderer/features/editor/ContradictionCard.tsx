import { useEffect, useId, useRef, useState } from 'react'
import { useMemoryStore } from '@renderer/features/memory/memoryStore'
import { findingRuleLine, sideWhere } from '@renderer/features/memory/needsALook/findingView'
import { openSide } from '@renderer/features/memory/needsALook/openSide'
import { useContradictionCardStore, type ContradictionCardOpen } from './contradictionMarks'

const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg focus-visible:bg-surface-raised focus-visible:text-fg disabled:opacity-40'

/** The card's width (px), so it never opens past the window's right edge. */
const CARD_WIDTH = 320

/**
 * The hover card of a contradiction underline (F-16.28; design Part 1 "Writing", §2.4, plan P4
 * §5.2): the rule's line, then the other quote with where it is ("1.1: “Tomas's grey eyes”") or the
 * note's sentence ("Your note on Orrin: “Eyes: green”"), and the answers: *Go there* (the other
 * quote, or the note's page), *This one's right* (this underlined side is right, so the other is
 * marked not right; offered only when both sides are book passages, P4-D17) and *Not a problem*;
 * on a note conflict *Update my note* (only when offered, P4-D18) opens Needs a look's editor for
 * it. It opens on hover (and stays while the pointer is over the underline or the card), on a
 * click, or on Alt+Enter with the caret in the underlined paragraph (it takes the focus then);
 * Escape closes it, giving the focus back to the editor. It closes when its finding is answered or
 * goes from the scene's underlines. Mounted once in a story memory v2 project.
 */
export function ContradictionCard(): React.JSX.Element | null {
  const card = useContradictionCardStore((s) => s.card)
  if (card === null) return null
  return (
    <CardBody
      key={`${card.underline.findingId}:${card.underline.side}:${String(card.pinned)}`}
      card={card}
    />
  )
}

function CardBody({ card }: { card: ContradictionCardOpen }): React.JSX.Element {
  const { underline } = card
  const { finding, side } = underline
  const other = side === 'a' ? finding.b : finding.a
  const store = useContradictionCardStore.getState
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const headingId = useId()
  // Still underlined in its scene? An answer elsewhere, a reading or the switch took it away.
  const gone = useMemoryStore((s) => {
    const scene = s.scenes[card.nodeId]
    return (
      scene !== undefined &&
      !scene.underlines.some((each) => each.findingId === underline.findingId)
    )
  })

  useEffect(() => {
    if (gone) store().close()
  }, [gone, store])

  useEffect(() => {
    if (card.keyboard) ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [card.keyboard])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      store().close()
      card.returnFocus()
    }
    const onDown = (event: MouseEvent): void => {
      if (!card.pinned) return
      if (event.target instanceof Node && ref.current?.contains(event.target) === true) return
      store().close()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [card, store])

  const answer = async (run: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await run()
    } finally {
      setBusy(false)
      store().close()
    }
  }
  const memory = useMemoryStore.getState
  const noteSide = other.kind === 'note'
  const left = Math.max(8, Math.min(card.x, window.innerWidth - CARD_WIDTH - 8))

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={headingId}
      data-testid="contradiction-card"
      data-contradiction-card=""
      className="fixed z-50 flex flex-col gap-1 rounded-md border border-line bg-surface-raised px-2.5 py-2 text-xs shadow-lg"
      // Where the underline is: the only dynamic values.
      style={{ left, top: card.y, width: CARD_WIDTH }}
      onMouseEnter={() => store().cancelClose()}
      onMouseLeave={() => store().scheduleClose()}
    >
      <p id={headingId} className="m-0 font-medium">
        {findingRuleLine(finding)}
      </p>
      <p className="m-0 text-fg-muted" data-testid="contradiction-other">
        {sideWhere(other)}: <span className="text-fg">“{other.quote}”</span>
      </p>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className={SMALL}
          onClick={() => {
            store().close()
            openSide(other)
          }}
        >
          Go there
        </button>
        {!noteSide && finding.actions.right[side] ? (
          <button
            type="button"
            className={SMALL}
            disabled={busy}
            aria-label={`This one's right: ${finding[side].value} (${finding[side].label})`}
            onClick={() =>
              void answer(() =>
                memory().findingAction({ findingId: finding.id, action: 'right', side })
              )
            }
          >
            This one’s right
          </button>
        ) : null}
        {noteSide && finding.actions.updateNote ? (
          <button
            type="button"
            className={SMALL}
            onClick={() => {
              store().close()
              void memory().requestNoteEdit(finding.id)
            }}
          >
            Update my note
          </button>
        ) : null}
        <button
          type="button"
          className={SMALL}
          disabled={busy}
          onClick={() =>
            void answer(() =>
              memory().findingAction({ findingId: finding.id, action: 'notProblem' })
            )
          }
        >
          Not a problem
        </button>
      </div>
    </div>
  )
}
