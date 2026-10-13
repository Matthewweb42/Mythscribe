import type { AgentChange, AgentEdit } from '@shared/agent'
import { DEFAULT_ASSISTANT_MODE } from '@shared/aiSettings'
import { agentAccessFor } from '@shared/chat'
import { FIX_BUTTON, FIX_PRIMARY_BUTTON } from '@renderer/features/editor/FixDiff'
import { PLAN_NO_EDITS_MESSAGE, useAssistantStore } from './assistantStore'
import { useAiSettingsStore } from './aiSettingsStore'

/** The question a sheet line Ms Scribe could not place asks (F-16.26, decision 3 as changed). */
export const SHEET_LINE_QUESTION = 'Is this an idea or canon?'

type SheetLineChange = AgentChange & { edit: Extract<AgentEdit, { kind: 'sheetLine' }> }

/**
 * A sheet line Ms Scribe could not tell canon from an idea for (F-16.26; the author's decision 3
 * as she changed it, 2026-10-11): "Is this an idea or canon?" with two quick choices. *Idea* puts
 * the line in the record's Ideas, *Canon* in its Pinned; the choice is the click that lands it, in
 * Ask and in Auto, and the turn then shows the confirmation with its *Undo*. *Skip* leaves the
 * sheet alone. In Plan, which never writes, and while the conversation waits, the choices are off
 * (the `ClearCard` pattern).
 */
export function SheetLineCard({
  messageId,
  change,
  busy
}: {
  messageId: string
  change: SheetLineChange
  busy: boolean
}): React.JSX.Element {
  const pick = useAssistantStore((s) => s.pickSheetPlace)
  const skip = useAssistantStore((s) => s.skipChange)
  const waiting = useAssistantStore((s) => {
    const active = s.conversations?.active
    return active != null && s.pending[active] !== undefined
  })
  const mode = useAiSettingsStore((s) => s.settings?.chatMode ?? DEFAULT_ASSISTANT_MODE)
  const plan = agentAccessFor(mode) === 'read'
  const off = busy || plan || waiting
  const { name, text } = change.edit
  return (
    <div
      data-testid="agent-change"
      data-status="pending"
      className="flex flex-col gap-1 rounded-md border border-line p-2"
    >
      <p className="m-0 text-xs font-medium">{SHEET_LINE_QUESTION}</p>
      <p data-testid="sheet-line-text" className="m-0 text-xs text-fg-muted">
        For {name}’s sheet: “{text}”
      </p>
      {plan ? (
        <p data-testid="sheet-line-plan" className="m-0 text-xs text-warning">
          {PLAN_NO_EDITS_MESSAGE}
        </p>
      ) : null}
      <div role="group" aria-label={SHEET_LINE_QUESTION} className="flex gap-1">
        <button
          type="button"
          data-testid="sheet-line-idea"
          disabled={off}
          title={`Put it in ${name}’s Ideas: your idea, not in the book`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void pick(messageId, change.id, 'ideas')}
          className={FIX_BUTTON}
        >
          Idea
        </button>
        <button
          type="button"
          data-testid="sheet-line-canon"
          disabled={off}
          title={`Pin it on ${name}’s sheet as canon`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void pick(messageId, change.id, 'pinned')}
          className={FIX_PRIMARY_BUTTON}
        >
          Canon
        </button>
        <button
          type="button"
          data-testid="agent-change-skip"
          disabled={busy || waiting}
          onClick={() => skip(messageId, change.id)}
          className={FIX_BUTTON}
        >
          Skip
        </button>
      </div>
    </div>
  )
}
