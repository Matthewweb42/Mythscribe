import type { Editor } from '@tiptap/core'
import {
  CRITIQUE_CATEGORY_LABEL,
  CRITIQUE_SCENE_CHAR_BUDGET,
  type CritiqueNote
} from '@shared/critique'
import { normalizeProposalNote, PROPOSAL_NOTE_MAX } from '@shared/proposal'
import { AiWaitText } from '@renderer/features/ai/AiWaitText'
import { AI_WAIT_PHRASES } from '@renderer/features/ai/aiWaitPhrases'
import { RequestCost } from '@renderer/features/ai/RequestCost'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { REWRITE_BUSY_MESSAGE } from './applyFix'
import { useCritiqueStore, type CritiqueSession } from './critiqueStore'
import { FIX_BUTTON, FIX_PRIMARY_BUTTON, FIX_QUOTE_BUTTON, FixDiff, OffVoiceFlag } from './FixDiff'
import { HonestySelect } from './HonestySelect'
import { useRewriteStore } from './rewriteStore'

/** What the panel says under a note whose quote is no longer in the document. */
export const PASSAGE_GONE_MESSAGE = 'That passage has changed; ask again for notes on it'
export { REWRITE_BUSY_MESSAGE }

/**
 * The editor's notes on this scene (F-14.8), shown while the critique store holds a session
 * for this document. Pending shows the wait with Stop; the answer shows one card per note: the
 * category, the passage it cites (a click selects it in the text), what is wrong or what works,
 * and, for an issue with a fix, a word-level diff of the passage against the fix with Apply,
 * which replaces exactly that passage through the editor (AI-origin marked, F-14.6). Praise
 * always cites a passage: main dropped every note it could not find, and the count says so.
 * The honesty setting (F-14.4 settings, per project) sits in the header in every state, and
 * "Ask again…" regenerates with the author's note (F-14.5). Close settles the proposal by how
 * many fixes were applied.
 */
export function CritiquePanel({
  id,
  editor
}: {
  id: string
  editor: Editor | null
}): React.JSX.Element | null {
  const session = useCritiqueStore((s) => (s.session?.nodeId === id ? s.session : null))
  if (session === null) return null
  return (
    <section
      aria-label="Editor's notes"
      data-testid="critique-panel"
      className="flex max-h-[45vh] shrink-0 flex-col gap-2 overflow-y-auto border-b border-line bg-surface px-4 py-2 text-sm"
    >
      <Body session={session} editor={editor} />
    </section>
  )
}

function Body({
  session,
  editor
}: {
  session: CritiqueSession
  editor: Editor | null
}): React.JSX.Element {
  const stop = useCritiqueStore((s) => s.stop)
  const close = useCritiqueStore((s) => s.close)
  const regenerate = useCritiqueStore((s) => s.regenerate)
  const { result } = session

  if (session.status === 'pending') {
    return (
      <>
        <HonestySelect title="Reading the scene…" testId="critique-honesty" />
        <AiWaitText
          phrases={AI_WAIT_PHRASES.critique}
          testId="critique-pending"
          className="text-xs"
        />
        <div className="flex gap-2">
          <button type="button" data-testid="critique-stop" onClick={stop} className={FIX_BUTTON}>
            Stop
          </button>
        </div>
      </>
    )
  }

  if (session.status === 'error' || result === null) {
    return (
      <>
        <HonestySelect title="Editor's notes failed" testId="critique-honesty" />
        <p role="alert" data-testid="critique-error" className="m-0 text-xs text-danger">
          {session.error ?? 'Something went wrong'}
        </p>
        <div className="flex gap-2">
          <button type="button" data-testid="critique-close" onClick={close} className={FIX_BUTTON}>
            Close
          </button>
        </div>
      </>
    )
  }

  const askAndRegenerate = (): void => {
    void dialogs
      .prompt({
        title: 'What should the notes do differently?',
        message: 'Optional. Your note goes into the next request and stays with this proposal.',
        placeholder: 'e.g. focus on the pacing, skip the line edits',
        confirmLabel: 'Ask again',
        validate: (value) =>
          value.trim().length > PROPOSAL_NOTE_MAX
            ? `Keep the note under ${PROPOSAL_NOTE_MAX} characters.`
            : null
      })
      .then((answer) => {
        if (answer === null) return
        regenerate(normalizeProposalNote(answer))
      })
  }

  return (
    <>
      <HonestySelect title="Editor's notes" testId="critique-honesty" />
      {result.truncated ? (
        <p data-testid="critique-truncated" className="m-0 text-xs text-warning">
          {`Only the first ${CRITIQUE_SCENE_CHAR_BUDGET.toLocaleString()} characters were read.`}
        </p>
      ) : null}
      {session.notes.length === 0 ? (
        <p data-testid="critique-empty" className="m-0 text-xs text-fg-muted">
          No notes.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {session.notes.map((note, index) => (
            <Note
              key={`${note.quote}:${index}`}
              note={note}
              index={index}
              session={session}
              editor={editor}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="critique-regenerate"
          onClick={askAndRegenerate}
          className={FIX_BUTTON}
        >
          Ask again…
        </button>
        <button type="button" data-testid="critique-close" onClick={close} className={FIX_BUTTON}>
          Close
        </button>
        <span data-testid="critique-cost" className="text-xs text-fg-subtle">
          <RequestCost request={result} />
        </span>
        {result.dropped > 0 ? (
          <span data-testid="critique-dropped" className="text-xs text-fg-subtle">
            {`${result.dropped} uncited ${result.dropped === 1 ? 'note' : 'notes'} dropped`}
          </span>
        ) : null}
      </div>
    </>
  )
}

function Note({
  note,
  index,
  session,
  editor
}: {
  note: CritiqueNote
  index: number
  session: CritiqueSession
  editor: Editor | null
}): React.JSX.Element {
  const show = useCritiqueStore((s) => s.show)
  const applyFix = useCritiqueStore((s) => s.applyFix)
  const rewriting = useRewriteStore((s) => s.session !== null)
  const applied = session.applied[index] === true
  const stale = session.stale[index] === true
  const praise = note.kind === 'praise'

  let title = 'Replace the quoted passage with this fix'
  if (applied) title = 'This fix is already in the scene'
  else if (stale) title = PASSAGE_GONE_MESSAGE
  else if (rewriting) title = REWRITE_BUSY_MESSAGE
  else if (editor === null) title = 'The document is still loading'

  return (
    <li
      data-testid="critique-note"
      data-kind={note.kind}
      className={`flex flex-col gap-1 rounded-md border-l-2 bg-surface-raised p-2 ${praise ? 'border-success' : 'border-warning'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-sm px-1.5 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide ${praise ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}
        >
          {praise
            ? `Works: ${CRITIQUE_CATEGORY_LABEL[note.category]}`
            : CRITIQUE_CATEGORY_LABEL[note.category]}
        </span>
        {note.flagged ? <OffVoiceFlag violation={note.violation} testId="critique-flag" /> : null}
      </div>
      <button
        type="button"
        data-testid="critique-quote"
        title="Show this passage in the scene"
        onClick={() => {
          if (editor) show(index, editor)
        }}
        className={FIX_QUOTE_BUTTON}
      >
        {note.quote}
      </button>
      <p className="m-0 text-xs text-fg-muted">{note.why}</p>
      {note.fix === null ? null : (
        <FixDiff quote={note.quote} fix={note.fix} testId="critique-fix-diff" />
      )}
      {note.fix === null ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="critique-apply"
            disabled={applied || stale || rewriting || editor === null}
            title={title}
            onClick={() => {
              if (editor) applyFix(index, editor)
            }}
            className={FIX_PRIMARY_BUTTON}
          >
            {applied ? 'Applied' : 'Apply'}
          </button>
          {stale ? (
            <span data-testid="critique-stale" className="text-xs text-warning">
              {PASSAGE_GONE_MESSAGE}
            </span>
          ) : null}
        </div>
      )}
    </li>
  )
}
