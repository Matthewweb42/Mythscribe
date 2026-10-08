import { Check, Undo2 } from 'lucide-react'
import {
  describeEdit,
  isDeletion,
  isDraftIntent,
  isRewriteIntent,
  type AgentChange,
  type AgentEdit,
  type AgentStep
} from '@shared/agent'
import {
  FIX_BUTTON,
  FIX_PRIMARY_BUTTON,
  FixDiff,
  OffVoiceFlag
} from '@renderer/features/editor/FixDiff'
import { canUndoChange, useAssistantStore } from './assistantStore'

/** How much of a changed passage a log line quotes. */
const EXCERPT_CHARS = 80

const excerpt = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : flat
}

/** The newest words of a draft on its way, so the card follows it as it grows. */
const tail = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > EXCERPT_CHARS * 2 ? `…${flat.slice(-EXCERPT_CHARS * 2).trimStart()}` : flat
}

/**
 * The lookups of an agent turn (F-5.22): live while the answer is on its way, each line as it
 * starts ("Searching “ledger”…"); folded under "Looked up N things" once the answer is in.
 */
export function AgentSteps({
  steps,
  live
}: {
  steps: readonly AgentStep[]
  live: boolean
}): React.JSX.Element | null {
  if (steps.length === 0) return null
  const list = (
    <ol data-testid="agent-steps" className="m-0 flex list-none flex-col gap-0.5 p-0">
      {steps.map((step, index) => (
        <li
          key={`${index}-${step.label}`}
          data-testid="agent-step"
          className="text-xs text-fg-muted"
        >
          {step.label}
        </li>
      ))}
    </ol>
  )
  if (live) return list
  return (
    <details className="text-xs text-fg-subtle">
      <summary className="cursor-pointer select-none">
        Looked up {steps.length === 1 ? 'one thing' : `${steps.length} things`}
      </summary>
      {list}
    </details>
  )
}

/** What a pending edit shows under its heading: the current text with what goes struck through and what comes in colour. */
function EditPreview({ edit }: { edit: AgentEdit }): React.JSX.Element | null {
  if (
    (edit.kind === 'insert' || edit.kind === 'text') &&
    (isDraftIntent(edit) || isRewriteIntent(edit))
  ) {
    // 2026-10-07: the prose is drafted when it is wanted; the card says what it will be about.
    return (
      <p data-testid="agent-change-brief" className="m-0 text-xs text-fg-muted italic">
        {edit.kind === 'text' ? `“${excerpt(edit.find)}”: ` : ''}
        {edit.brief}
      </p>
    )
  }
  switch (edit.kind) {
    case 'text':
      return <FixDiff quote={edit.find} fix={edit.replace} testId="agent-change-diff" />
    case 'synopsis':
      return <FixDiff quote={edit.before} fix={edit.after} testId="agent-change-diff" />
    case 'sheet':
      return <FixDiff quote={edit.before} fix={edit.after} testId="agent-change-diff" />
    case 'rename':
      return <FixDiff quote={edit.title} fix={edit.after} testId="agent-change-diff" />
    case 'insert':
      return (
        <p data-testid="agent-change-diff" className="rewrite-diff m-0 whitespace-pre-wrap text-sm">
          {edit.after ? <span>…{excerpt(edit.after.slice(-EXCERPT_CHARS))} </span> : null}
          <ins>{edit.text}</ins>
        </p>
      )
    case 'notes':
      return (
        <p data-testid="agent-change-diff" className="rewrite-diff m-0 whitespace-pre-wrap text-sm">
          <ins>{edit.add}</ins>
        </p>
      )
    case 'create':
      return edit.text ? (
        <p data-testid="agent-change-diff" className="rewrite-diff m-0 whitespace-pre-wrap text-sm">
          <ins>{edit.text}</ins>
        </p>
      ) : null
    default:
      return null
  }
}

/**
 * An edit whose prose is being drafted or waits in the editor (2026-10-07): the card mirrors the
 * ghost text. While it is written the draft so far shows here too; once it shows in the editor,
 * Tab or Accept takes it and Escape or Dismiss drops it. The buttons keep the editor's focus.
 */
function DraftCard({
  change,
  text,
  onAccept,
  onDismiss
}: {
  change: AgentChange
  text: string
  onAccept: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const insertion = change.edit.kind === 'insert'
  const shown = change.status === 'shown'
  return (
    <div
      data-testid="agent-change"
      data-status={change.status}
      className="flex flex-col gap-1 rounded-md border border-accent p-2"
    >
      <p className="m-0 text-xs font-medium">{describeEdit(change.edit)}</p>
      <p role="status" className="m-0 text-xs text-fg-muted">
        {shown
          ? 'In the editor: Tab accepts, Escape dismisses.'
          : insertion
            ? 'Writing into the editor…'
            : 'Writing the new text…'}
      </p>
      {text !== '' ? (
        <p data-testid="agent-change-draft" className="m-0 text-sm whitespace-pre-wrap">
          <ins>{tail(text)}</ins>
        </p>
      ) : null}
      <div className="flex gap-1">
        {shown ? (
          <button
            type="button"
            data-testid="agent-change-accept"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onAccept}
            className={FIX_PRIMARY_BUTTON}
          >
            Accept
          </button>
        ) : null}
        <button
          type="button"
          data-testid="agent-change-skip"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onDismiss}
          className={FIX_BUTTON}
        >
          {shown ? 'Dismiss' : 'Stop'}
        </button>
      </div>
    </div>
  )
}

/** The line an applied, skipped, undone, or failed edit leaves in the chat. */
function logLine(change: AgentChange): string {
  const { edit } = change
  const head = describeEdit(edit)
  const detail =
    edit.kind === 'text' && edit.replace !== ''
      ? `: “${excerpt(edit.replace)}”`
      : edit.kind === 'insert'
        ? `: “${excerpt(edit.text)}”`
        : ''
  switch (change.status) {
    case 'applied':
      return `${head}${detail}`
    case 'skipped':
      return `Skipped: ${head}`
    case 'undone':
      return `Undone: ${head}`
    default:
      return `Could not apply: ${head}${change.error ? ` (${change.error})` : ''}`
  }
}

/**
 * The edits of an agent turn (F-5.22). A pending one is a card: what it does, the preview, and
 * Apply / Skip (a deletion says it deletes; an off-voice one carries the voice check's flag). At
 * Auto the applied ones arrive already applied. Every decided edit is one log line; an applied
 * one keeps its Undo while this session holds it. With two or more waiting, Apply all remaining
 * (never the deletions, which each need their own click).
 */
export function AgentChanges({
  messageId,
  changes
}: {
  messageId: string
  changes: readonly AgentChange[]
}): React.JSX.Element | null {
  const changing = useAssistantStore((s) => s.changing)
  const drafts = useAssistantStore((s) => s.drafts)
  const applyChange = useAssistantStore((s) => s.applyChange)
  const skipChange = useAssistantStore((s) => s.skipChange)
  const acceptChange = useAssistantStore((s) => s.acceptChange)
  const undoChange = useAssistantStore((s) => s.undoChange)
  const applyAll = useAssistantStore((s) => s.applyAll)
  if (changes.length === 0) return null
  const waiting = changes.filter(
    (change) => change.status === 'pending' && !isDeletion(change.edit)
  ).length
  return (
    <div className="flex flex-col gap-1.5">
      {changes.map((change) => {
        const busy = changing[change.id] === true
        if (change.status === 'writing' || change.status === 'shown') {
          return (
            <DraftCard
              key={change.id}
              change={change}
              text={drafts[change.id] ?? ''}
              onAccept={() => acceptChange(messageId, change.id)}
              onDismiss={() => skipChange(messageId, change.id)}
            />
          )
        }
        if (change.status !== 'pending') {
          return (
            <div
              key={change.id}
              data-testid="agent-change"
              data-status={change.status}
              className={`flex items-start gap-1.5 text-xs ${change.status === 'applied' ? 'text-fg' : change.status === 'failed' ? 'text-warning' : 'text-fg-muted'}`}
            >
              {change.status === 'applied' ? (
                <Check size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
              ) : null}
              <span className="min-w-0 flex-1 break-words">
                {logLine(change)}
                {change.notice !== null ? (
                  <span data-testid="agent-change-notice" className="block text-fg-muted">
                    {change.notice}
                  </span>
                ) : null}
              </span>
              {change.status === 'applied' && canUndoChange(change.id) ? (
                <button
                  type="button"
                  data-testid="agent-change-undo"
                  disabled={busy}
                  title="Undo this change"
                  onClick={() => void undoChange(messageId, change.id)}
                  className={FIX_BUTTON}
                >
                  <Undo2 size={12} aria-hidden="true" />
                  Undo
                </button>
              ) : null}
            </div>
          )
        }
        const deletion = isDeletion(change.edit)
        return (
          <div
            key={change.id}
            data-testid="agent-change"
            data-status="pending"
            className={`flex flex-col gap-1 rounded-md border p-2 ${deletion ? 'border-warning' : 'border-line'}`}
          >
            <p className="m-0 text-xs font-medium">{describeEdit(change.edit)}</p>
            {deletion ? (
              <p className="m-0 text-xs text-warning">
                This deletes; it always asks first, even in Auto.
              </p>
            ) : null}
            {change.violation !== null ? (
              <OffVoiceFlag violation={change.violation} testId="agent-change-flag" />
            ) : null}
            <EditPreview edit={change.edit} />
            <div className="flex gap-1">
              <button
                type="button"
                data-testid="agent-change-apply"
                disabled={busy}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void applyChange(messageId, change.id)}
                className={FIX_PRIMARY_BUTTON}
              >
                {deletion
                  ? 'Delete'
                  : isDraftIntent(change.edit) || isRewriteIntent(change.edit)
                    ? 'Write'
                    : 'Apply'}
              </button>
              <button
                type="button"
                data-testid="agent-change-skip"
                disabled={busy}
                onClick={() => skipChange(messageId, change.id)}
                className={FIX_BUTTON}
              >
                Skip
              </button>
            </div>
          </div>
        )
      })}
      {waiting >= 2 ? (
        <button
          type="button"
          data-testid="agent-apply-all"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void applyAll(messageId)}
          className={`self-start ${FIX_BUTTON}`}
        >
          Apply all remaining
        </button>
      ) : null}
    </div>
  )
}
