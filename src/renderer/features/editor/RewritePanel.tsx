import { useMemo } from 'react'
import type { Editor } from '@tiptap/core'
import { normalizeProposalNote, PROPOSAL_NOTE_MAX } from '@shared/proposal'
import { diffWords } from '@shared/rewrite'
import { describeRequest } from '@renderer/features/ai/usageFormat'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { useRewriteStore, type RewriteSession } from './rewriteStore'

const BUTTON =
  'flex items-center gap-1 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'
const PRIMARY_BUTTON =
  'flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50 disabled:hover:bg-accent'

/** What the panel says under Accept once the passage changed under a pending rewrite. */
export const PASSAGE_CHANGED_MESSAGE = 'The passage changed; select it again'

/**
 * The rewrite proposal (F-14.10) above the single-document editor, shown while the rewrite
 * store holds a session for this document. Streaming shows the draft as it arrives with Stop;
 * once main has checked the answer the panel shows a word-level diff against the passage
 * (deletions struck through, insertions tinted), the fidelity badge with the violation when
 * the answer is off-voice (F-14.7), the model and cost line, and Accept / Reject / Regenerate…
 * (F-14.5, with an optional note). An edit inside the passage keeps the diff but disables
 * Accept with the reason; a failure shows its message and next step with Close.
 */
export function RewritePanel({
  id,
  editor
}: {
  id: string
  editor: Editor | null
}): React.JSX.Element | null {
  const session = useRewriteStore((s) => (s.session?.nodeId === id ? s.session : null))
  if (session === null) return null
  return (
    <section
      aria-label="Rewrite"
      data-testid="rewrite-panel"
      className="flex shrink-0 flex-col gap-2 border-b border-line bg-surface px-4 py-2 text-sm"
    >
      <Body session={session} editor={editor} />
    </section>
  )
}

function Body({
  session,
  editor
}: {
  session: RewriteSession
  editor: Editor | null
}): React.JSX.Element {
  const stop = useRewriteStore((s) => s.stop)
  const accept = useRewriteStore((s) => s.accept)
  const reject = useRewriteStore((s) => s.reject)
  const regenerate = useRewriteStore((s) => s.regenerate)
  const { result } = session
  const segments = useMemo(
    () => (result === null ? [] : diffWords(session.original, result.text)),
    [session.original, result]
  )

  if (session.status === 'streaming') {
    return (
      <>
        <Header title="Rewriting in your voice…" />
        <p
          data-testid="rewrite-draft"
          className="m-0 whitespace-pre-wrap text-fg-muted"
          aria-live="polite"
        >
          {session.draft || 'Drafting…'}
        </p>
        <div className="flex gap-2">
          <button type="button" data-testid="rewrite-stop" onClick={stop} className={BUTTON}>
            Stop
          </button>
        </div>
      </>
    )
  }

  if (session.status === 'error' || result === null) {
    return (
      <>
        <Header title="Rewrite failed" />
        <p role="alert" data-testid="rewrite-error" className="m-0 text-xs text-danger">
          {session.error ?? 'Something went wrong'}
        </p>
        <div className="flex gap-2">
          <button type="button" data-testid="rewrite-close" onClick={reject} className={BUTTON}>
            Close
          </button>
        </div>
      </>
    )
  }

  const invalid = session.status === 'invalid'
  const askAndRegenerate = (): void => {
    void dialogs
      .prompt({
        title: "What's off about this rewrite?",
        message: 'Optional. Your note goes into the next request and stays with this proposal.',
        placeholder: 'e.g. keep the short sentences, less about the weather',
        confirmLabel: 'Regenerate',
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
      <Header title="Rewrite in your voice">
        {result.flagged ? (
          <span
            data-testid="rewrite-flag"
            className="text-xs text-warning"
            title={result.violation ?? 'does not match the voice profile'}
          >
            {`⚠ Off-voice: ${result.violation ?? 'does not match the voice profile'}`}
          </span>
        ) : null}
      </Header>
      <p data-testid="rewrite-diff" className="rewrite-diff m-0 whitespace-pre-wrap">
        {segments.map((segment, index) =>
          segment.kind === 'del' ? (
            <del key={index}>{segment.text}</del>
          ) : segment.kind === 'ins' ? (
            <ins key={index}>{segment.text}</ins>
          ) : (
            <span key={index}>{segment.text}</span>
          )
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="rewrite-accept"
          disabled={invalid || editor === null}
          title={invalid ? PASSAGE_CHANGED_MESSAGE : 'Replace the passage with this rewrite'}
          onClick={() => {
            if (editor) accept(editor)
          }}
          className={PRIMARY_BUTTON}
        >
          Accept
        </button>
        <button type="button" data-testid="rewrite-reject" onClick={reject} className={BUTTON}>
          Reject
        </button>
        {invalid ? null : (
          <button
            type="button"
            data-testid="rewrite-regenerate"
            onClick={askAndRegenerate}
            className={BUTTON}
          >
            Regenerate…
          </button>
        )}
        <span data-testid="rewrite-cost" className="text-xs text-fg-subtle">
          {describeRequest(result)}
        </span>
        {invalid ? (
          <span data-testid="rewrite-invalid" className="text-xs text-warning">
            {PASSAGE_CHANGED_MESSAGE}
          </span>
        ) : null}
      </div>
    </>
  )
}

function Header({
  title,
  children
}: {
  title: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs font-medium text-fg">{title}</span>
      {children}
    </div>
  )
}
