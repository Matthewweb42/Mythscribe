import type { Editor } from '@tiptap/core'
import { PROOFREAD_CHAR_BUDGET, PROOFREAD_KIND_LABEL, type ProofreadFix } from '@shared/proofread'
import { describeRequest } from '@renderer/features/ai/usageFormat'
import { REWRITE_BUSY_MESSAGE } from './applyFix'
import { FIX_BUTTON, FIX_PRIMARY_BUTTON, FIX_QUOTE_BUTTON, FixDiff, OffVoiceFlag } from './FixDiff'
import { useProofreadStore, type ProofreadFixState, type ProofreadSession } from './proofreadStore'
import { useRewriteStore } from './rewriteStore'

/** What the panel says under a fix whose quote is no longer in the document. */
export const PROOFREAD_GONE_MESSAGE = 'That passage has changed; proofread it again'

/** What the panel says when main proofread only the head of the text. */
export const PROOFREAD_TRUNCATED_MESSAGE = `Proofread the first ${PROOFREAD_CHAR_BUDGET.toLocaleString('en-US')} characters; select the rest to proofread it.`

/**
 * The proofreading pass on this scene (F-14.12), shown while the proofread store holds a
 * session for this document. Pending shows the wait with Stop; the answer shows one card per
 * fix: the kind, the passage it quotes (a click selects it in the text), a word-level diff of
 * the passage against the fix, and Accept / Reject; Accept all takes every open fix. An
 * accepted fix replaces exactly that passage through the editor (AI-origin marked, F-14.6).
 * Close settles the proposal if no fix settled it already.
 */
export function ProofreadPanel({
  id,
  editor
}: {
  id: string
  editor: Editor | null
}): React.JSX.Element | null {
  const session = useProofreadStore((s) => (s.session?.nodeId === id ? s.session : null))
  if (session === null) return null
  return (
    <section
      aria-label="Proofread"
      data-testid="proofread-panel"
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
  session: ProofreadSession
  editor: Editor | null
}): React.JSX.Element {
  const stop = useProofreadStore((s) => s.stop)
  const close = useProofreadStore((s) => s.close)
  const acceptAll = useProofreadStore((s) => s.acceptAll)
  const rewriting = useRewriteStore((s) => s.session !== null)
  const { result } = session
  const scope = session.scope === 'selection' ? 'Selection' : 'Scene'

  const header = (title: string): React.JSX.Element => (
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</h3>
      <span data-testid="proofread-scope" className="text-xs text-fg-subtle">
        {scope}
      </span>
    </div>
  )

  if (session.status === 'pending') {
    return (
      <>
        {header('Proofreading…')}
        <p data-testid="proofread-pending" className="m-0 text-xs text-fg-muted" aria-live="polite">
          Checking spelling, typos, grammar, and punctuation.
        </p>
        <div className="flex gap-2">
          <button type="button" data-testid="proofread-stop" onClick={stop} className={FIX_BUTTON}>
            Stop
          </button>
        </div>
      </>
    )
  }

  if (session.status === 'error' || result === null) {
    return (
      <>
        {header('Proofread failed')}
        <p role="alert" data-testid="proofread-error" className="m-0 text-xs text-danger">
          {session.error ?? 'Something went wrong'}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="proofread-close"
            onClick={close}
            className={FIX_BUTTON}
          >
            Close
          </button>
        </div>
      </>
    )
  }

  const anyOpen = session.states.includes('open')

  return (
    <>
      {header('Proofread')}
      {result.truncated ? (
        <p data-testid="proofread-truncated" className="m-0 text-xs text-warning">
          {PROOFREAD_TRUNCATED_MESSAGE}
        </p>
      ) : null}
      {session.fixes.length === 0 ? (
        <p data-testid="proofread-empty" className="m-0 text-xs text-fg-muted">
          No errors found.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {session.fixes.map((fix, index) => (
            <Fix
              key={`${fix.quote}:${index}`}
              fix={fix}
              index={index}
              state={session.states[index] ?? 'open'}
              editor={editor}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {session.fixes.length === 0 ? null : (
          <button
            type="button"
            data-testid="proofread-accept-all"
            disabled={!anyOpen || rewriting || editor === null}
            title={rewriting ? REWRITE_BUSY_MESSAGE : 'Accept every open fix'}
            onClick={() => {
              if (editor) acceptAll(editor)
            }}
            className={FIX_PRIMARY_BUTTON}
          >
            Accept all
          </button>
        )}
        <button type="button" data-testid="proofread-close" onClick={close} className={FIX_BUTTON}>
          Close
        </button>
        <span data-testid="proofread-cost" className="text-xs text-fg-subtle">
          {describeRequest(result)}
        </span>
      </div>
    </>
  )
}

function Fix({
  fix,
  index,
  state,
  editor
}: {
  fix: ProofreadFix
  index: number
  state: ProofreadFixState
  editor: Editor | null
}): React.JSX.Element {
  const show = useProofreadStore((s) => s.show)
  const accept = useProofreadStore((s) => s.accept)
  const reject = useProofreadStore((s) => s.reject)
  const rewriting = useRewriteStore((s) => s.session !== null)
  const open = state === 'open'

  let title = 'Replace the quoted passage with this fix'
  if (state === 'applied') title = 'This fix is already in the scene'
  else if (state === 'rejected') title = 'You turned this fix down'
  else if (state === 'stale') title = PROOFREAD_GONE_MESSAGE
  else if (rewriting) title = REWRITE_BUSY_MESSAGE
  else if (editor === null) title = 'The document is still loading'

  return (
    <li
      data-testid="proofread-fix"
      data-kind={fix.kind}
      data-state={state}
      className={`flex flex-col gap-1 rounded-md border-l-2 bg-surface-raised p-2 ${open ? 'border-warning' : 'border-line opacity-70'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-sm bg-warning/15 px-1.5 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-warning">
          {PROOFREAD_KIND_LABEL[fix.kind]}
        </span>
        {fix.flagged ? <OffVoiceFlag violation={fix.violation} testId="proofread-flag" /> : null}
      </div>
      <button
        type="button"
        data-testid="proofread-quote"
        title="Show this passage in the scene"
        disabled={!open}
        onClick={() => {
          if (editor) show(index, editor)
        }}
        className={FIX_QUOTE_BUTTON}
      >
        {fix.quote}
      </button>
      <FixDiff quote={fix.quote} fix={fix.fix} testId="proofread-fix-diff" />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="proofread-accept"
          disabled={!open || rewriting || editor === null}
          title={title}
          onClick={() => {
            if (editor) accept(index, editor)
          }}
          className={FIX_PRIMARY_BUTTON}
        >
          {state === 'applied' ? 'Accepted' : 'Accept'}
        </button>
        <button
          type="button"
          data-testid="proofread-reject"
          disabled={!open}
          onClick={() => reject(index)}
          className={FIX_BUTTON}
        >
          {state === 'rejected' ? 'Rejected' : 'Reject'}
        </button>
        {state === 'stale' ? (
          <span data-testid="proofread-stale" className="text-xs text-warning">
            {PROOFREAD_GONE_MESSAGE}
          </span>
        ) : null}
      </div>
    </li>
  )
}
