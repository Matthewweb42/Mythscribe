import { useMemo } from 'react'
import type { Editor } from '@tiptap/core'
import {
  CRITIQUE_CATEGORY_LABEL,
  CRITIQUE_SCENE_CHAR_BUDGET,
  type CritiqueNote
} from '@shared/critique'
import { normalizeProposalNote, PROPOSAL_NOTE_MAX } from '@shared/proposal'
import { diffWords } from '@shared/rewrite'
import { formatRequestCost } from '@renderer/features/ai/usageFormat'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { useCritiqueStore, type CritiqueSession } from './critiqueStore'
import { HonestySelect } from './HonestySelect'
import { useRewriteStore } from './rewriteStore'

const BUTTON =
  'flex items-center gap-1 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'
const PRIMARY_BUTTON =
  'flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent'
const QUOTE_BUTTON =
  'm-0 block w-full cursor-pointer border-0 border-l-2 border-line bg-transparent px-2 py-0.5 text-left text-sm italic text-fg-muted hover:border-accent hover:text-fg'

/** What the panel says under a note whose quote is no longer in the document. */
export const PASSAGE_GONE_MESSAGE = 'That passage has changed; ask again for notes on it'
/** Why Apply is refused while the rewrite panel owns the editor's target. */
export const REWRITE_BUSY_MESSAGE = 'Finish the rewrite first'

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
        <p data-testid="critique-pending" className="m-0 text-xs text-fg-muted" aria-live="polite">
          Your editor is making notes.
        </p>
        <div className="flex gap-2">
          <button type="button" data-testid="critique-stop" onClick={stop} className={BUTTON}>
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
          <button type="button" data-testid="critique-close" onClick={close} className={BUTTON}>
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
          className={BUTTON}
        >
          Ask again…
        </button>
        <button type="button" data-testid="critique-close" onClick={close} className={BUTTON}>
          Close
        </button>
        <span data-testid="critique-cost" className="text-xs text-fg-subtle">
          {`${result.model} · ${formatRequestCost(result.costUsd)}${result.cached ? ' · cached' : ''}`}
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
  const segments = useMemo(
    () => (note.fix === null ? [] : diffWords(note.quote, note.fix)),
    [note.quote, note.fix]
  )
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
        {note.flagged ? (
          <span
            data-testid="critique-flag"
            className="text-xs text-warning"
            title={note.violation ?? 'does not match the voice profile'}
          >
            {`⚠ Off-voice fix: ${note.violation ?? 'does not match the voice profile'}`}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        data-testid="critique-quote"
        title="Show this passage in the scene"
        onClick={() => {
          if (editor) show(index, editor)
        }}
        className={QUOTE_BUTTON}
      >
        {note.quote}
      </button>
      <p className="m-0 text-xs text-fg-muted">{note.why}</p>
      {note.fix === null ? null : (
        <p data-testid="critique-fix-diff" className="rewrite-diff m-0 whitespace-pre-wrap text-sm">
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
            className={PRIMARY_BUTTON}
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
