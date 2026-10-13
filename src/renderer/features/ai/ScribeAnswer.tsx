import { sourceLabelWords, type ScribeCitation, type ScribeTurn } from '@shared/scribe'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { openRecordSheet } from '@renderer/features/records/openRecord'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useAssistantStore } from './assistantStore'
import { answerSegments, citationWhere, shownRef } from './scribeAnswerView'

/** A `[n]` marker inside the answer (the Query answer's look, F-5.7). */
const CITE_BUTTON =
  'rounded-sm px-0.5 align-baseline text-xs font-medium text-accent hover:bg-surface-raised hover:underline focus-visible:outline-2 focus-visible:outline-accent disabled:text-fg-muted disabled:hover:bg-transparent disabled:hover:no-underline'

/** What a dotted sentence's title says: it names the book but kept no citation (P3-D13). */
export const NOT_CHECKED_TITLE = 'Not checked against the book'
/** What a dimmed sentence's title says: the quote check found it unsupported. */
export const UNSUPPORTED_TITLE = 'Its quote does not say this'

/**
 * Opens what a citation rests on (plan P3 §5): a scene at the quoted passage (or a Research page,
 * which opens the same way), a record's sheet for its Pinned, Ideas or who-knows line. Null when
 * there is nothing to open (computed lines, the outline, a record gone since).
 */
function openerOf(
  citation: ScribeCitation,
  categoryOf: (recordId: string) => string | null
): (() => void) | null {
  const { open } = citation
  if (open === null) return null
  switch (open.kind) {
    case 'scene':
      return () =>
        void useAssistantStore
          .getState()
          .openScene({ nodeId: open.id, title: citation.title }, citation.quote)
    case 'research':
      return () => {
        openPassage(open.id, (doc) => locateText(doc, citation.quote)).catch((err: unknown) =>
          toast.error(describeError(err))
        )
      }
    case 'record': {
      const categoryId = categoryOf(open.id)
      return categoryId === null ? null : () => openRecordSheet(open.id, categoryId)
    }
  }
}

/**
 * Ms Scribe's answer in the chat (F-16.25, plan P3 §5; story memory v2 turns, while v1 keeps
 * `QueryAnswer`): the answer with each `[n]` marker a chip, the sentences that name the book with
 * no kept citation underlined dotted ("Not checked against the book"), the ones the quote check
 * found unsupported dimmed ("Its quote does not say this"); then the Sources, each with its label
 * in words ("happened", "later in the book", "your notes", "source document", "filed from <doc>",
 * "not canon", "planned", "idea scene", "computed from your book", "your to-do", and an Idea "your
 * idea, not in the book"), where it is, its quote and "quote checked" or "quote and sentence
 * checked"; a click opens the scene at the passage, the record's sheet or the Research page. Under
 * them the scope line ("Searched every scene up to 14.2 for distrust, suspicion") and "Read chapter
 * 9 (9.1–9.6) too" when Self-Route widened. A Not found answer reads in the not-found style.
 * Nothing here enters the manuscript.
 */
export function ScribeAnswer({
  answer,
  scribe
}: {
  answer: string
  scribe: ScribeTurn
}): React.JSX.Element {
  const records = useRecordStore((s) => s.byId)
  const categoryOf = (recordId: string): string | null => records[recordId]?.categoryId ?? null
  if (scribe.notFound) {
    return (
      <p
        data-testid="scribe-not-found"
        className="m-0 break-words whitespace-pre-wrap text-fg-muted italic"
      >
        {answer}
      </p>
    )
  }
  const byNumber = new Map(scribe.citations.map((citation) => [citation.n, citation]))
  return (
    <div data-testid="scribe-answer" className="flex flex-col gap-1.5">
      <p className="m-0 break-words whitespace-pre-wrap">
        {answerSegments(answer, scribe).map((segment, index) => {
          if (segment.kind === 'cite') {
            const citation = byNumber.get(segment.n)
            return citation === undefined ? (
              `[${segment.n}]`
            ) : (
              <CiteChip key={index} citation={citation} open={openerOf(citation, categoryOf)} />
            )
          }
          if (segment.kind === 'text') return segment.text
          if (segment.kind === 'notChecked') {
            return (
              <span
                key={index}
                data-testid="scribe-not-checked"
                title={NOT_CHECKED_TITLE}
                className="underline decoration-fg-subtle decoration-dotted underline-offset-2"
              >
                {segment.text}
              </span>
            )
          }
          return (
            <span
              key={index}
              data-testid="scribe-unsupported"
              title={UNSUPPORTED_TITLE}
              className="text-fg-muted opacity-60"
            >
              {segment.text}
            </span>
          )
        })}
      </p>
      {scribe.citations.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <p className="m-0 text-xs font-medium text-fg-muted">Sources</p>
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {scribe.citations.map((citation) => (
              <li key={citation.n}>
                <Source citation={citation} open={openerOf(citation, categoryOf)} />
              </li>
            ))}
          </ol>
        </div>
      )}
      {scribe.scope === null ? null : (
        <p data-testid="scribe-scope" className="m-0 text-xs text-fg-muted">
          {scribe.scope}
        </p>
      )}
      {scribe.widened === null ? null : (
        <p data-testid="scribe-widened" className="m-0 text-xs text-fg-muted">
          Read {scribe.widened.ref} too
        </p>
      )}
    </div>
  )
}

/** A `[n]` marker: a chip naming its source ("Source 1: happened, 1.1 ¶1"); a click opens it. */
function CiteChip({
  citation,
  open
}: {
  citation: ScribeCitation
  open: (() => void) | null
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="scribe-cite"
      data-n={citation.n}
      aria-label={`Source ${citation.n}: ${citationWhere(citation)}`}
      title={citationWhere(citation)}
      disabled={open === null}
      onClick={open ?? undefined}
      className={CITE_BUTTON}
    >
      [{citation.n}]
    </button>
  )
}

/** One source: where and what it is, its quote, how far it was checked; a click opens it. */
function Source({
  citation,
  open
}: {
  citation: ScribeCitation
  open: (() => void) | null
}): React.JSX.Element {
  const where = shownRef(citation.ref)
  // A page's reference names its record already ("Mara's Ideas ¶1"): its title would repeat it.
  const title = citation.title === '' || where.startsWith(citation.title) ? '' : citation.title
  const body = (
    <>
      <span className="block font-medium text-fg">
        [{citation.n}] {where}
        {title === '' ? '' : ` · ${title}`}
      </span>
      <span data-testid="scribe-source-label" className="block text-fg-muted">
        {sourceLabelWords(citation.label, citation.doc)}
      </span>
      <span className="block text-fg-muted italic">“{citation.quote}”</span>
      <span data-testid="scribe-source-checked" className="block text-fg-subtle">
        {citation.checked === 'cite' ? 'quote and sentence checked' : 'quote checked'}
      </span>
    </>
  )
  const box = 'w-full rounded-md border border-line px-2 py-1 text-left text-xs'
  return open === null ? (
    <div data-testid="scribe-source" data-label={citation.label} className={box}>
      {body}
    </div>
  ) : (
    <button
      type="button"
      data-testid="scribe-source"
      data-label={citation.label}
      title={`Open ${title === '' ? where : title}`}
      onClick={open}
      className={`${box} hover:bg-surface-raised`}
    >
      {body}
    </button>
  )
}
