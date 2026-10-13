import { useState } from 'react'
import { Info } from 'lucide-react'
import type { RecordOrigin } from '@shared/memory/records'
import type { TopicQuoteView } from '@shared/memory/views'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useMemoryStore } from '../memoryStore'
import { revealLines } from './knowsView'

const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 aria-expanded:bg-surface-raised aria-expanded:text-fg'

/** What ⓘ on a secret or thread reads: its label, who made it and its reveals. */
export interface TopicInfoTopic {
  recordId: string
  label: string
  origin: RecordOrigin
  defining: TopicQuoteView | null
  merged: TopicQuoteView[]
}

/** Opens the reveal's scene with its quote selected. */
function goThere(quote: TopicQuoteView): void {
  openPassage(quote.nodeId, (doc) => locateText(doc, quote.quote)).catch((err: unknown) =>
    toast.error(describeError(err))
  )
}

/**
 * ⓘ on a secret or thread (F-16.22; plan P2b §4.2): its defining reveal with *Go there*, "checked
 * by a second AI read" and what that reading cost; each reveal merged into it ("also read as
 * “the map sale” in 1.2: merged into this secret") with *Split*; and *Not a secret* / *Not a
 * thread* when the AI made it (it goes to Dismissed, where *Undo* brings it back).
 * One the author made says so.
 */
export function TopicInfoCard({
  topic,
  kind
}: {
  topic: TopicInfoTopic
  kind: 'secret' | 'thread'
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }
  const split = (quote: TopicQuoteView): Promise<void> =>
    run(async () => {
      const made = await useMemoryStore.getState().splitTopic(quote.topicQuoteId)
      if (made !== null) toast.success(`“${quote.label}” is a ${kind} of its own again.`)
    })
  const notOne = (): Promise<void> =>
    run(async () => {
      const gone = await useMemoryStore.getState().topicNotRight(topic.recordId)
      if (gone) toast.info(`“${topic.label}” went to Dismissed; Undo there brings it back.`)
    })
  return (
    <div
      role="group"
      aria-label={`Where ${topic.label} comes from`}
      data-testid="topic-info"
      className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs"
    >
      {topic.defining === null ? (
        <p className="m-0 text-fg-muted">
          {topic.origin === 'ai' ? `No scene reveals this ${kind} now.` : `You made this ${kind}.`}
        </p>
      ) : (
        <Reveal quote={topic.defining} kind={kind} />
      )}
      {topic.merged.map((quote) => (
        <Reveal
          key={quote.topicQuoteId}
          quote={quote}
          kind={kind}
          action={
            <button
              type="button"
              className={SMALL}
              disabled={busy}
              aria-label={`Split “${quote.label}” off`}
              onClick={() => void split(quote)}
            >
              Split
            </button>
          }
        />
      ))}
      {topic.origin === 'ai' ? (
        <button
          type="button"
          className={`${SMALL} mt-1`}
          disabled={busy}
          onClick={() => void notOne()}
        >
          {kind === 'secret' ? 'Not a secret' : 'Not a thread'}
        </button>
      ) : null}
    </div>
  )
}

function Reveal({
  quote,
  kind,
  action = null
}: {
  quote: TopicQuoteView
  kind: 'secret' | 'thread'
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={`mb-1 ${quote.stale ? 'opacity-60' : ''}`} data-testid="topic-reveal">
      <div className="flex items-start gap-1">
        <q className="min-w-0 flex-1 text-fg">{quote.quote}</q>
        <button
          type="button"
          className={SMALL}
          onClick={() => goThere(quote)}
          aria-label={`Go there: ${quote.quote}`}
        >
          Go there
        </button>
        {action}
      </div>
      <ul className="m-0 list-none p-0 text-fg-muted">
        {revealLines(quote, kind).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  )
}

/** The ⓘ button beside a secret's or thread's label, opening `TopicInfoCard` below it. */
export function TopicInfoButton({
  topic,
  kind
}: {
  topic: TopicInfoTopic
  kind: 'secret' | 'thread'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label={`Where this comes from: ${topic.label}`}
        title="Where this comes from"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={`${SMALL} flex items-center`}
      >
        <Info size={12} aria-hidden="true" />
      </button>
      {open ? <TopicInfoCard topic={topic} kind={kind} /> : null}
    </>
  )
}
