import { useState } from 'react'
import { passChangesText } from '@shared/editPass'
import { choicePass, EDIT_CHOICE_LABEL, type EditChoice, type EditTurn } from '@shared/editRequest'
import { useHostedPricing } from '@renderer/features/account/hostedPricing'
import { useEditPassStore } from '@renderer/features/editPass/editPassStore'
import { passTitle } from '@renderer/features/editPass/passFormat'
import {
  confirmLine,
  estimateLine,
  quotePass,
  usePassModel,
  type PassQuote
} from '@renderer/features/editPass/passQuote'
import { CONVERSATION_BUSY_MESSAGE, useOpenScene } from './aiActions'
import { useAiSettingsStore } from './aiSettingsStore'
import { PLAN_NO_EDITS_MESSAGE, useAssistantStore } from './assistantStore'
import { editChoiceReason, targetWords } from './editRequest'
import { formatCount, formatUsd } from './usageFormat'

const CHIP =
  'flex flex-col items-start rounded-md border border-line px-2 py-1 text-left text-xs hover:bg-surface-raised disabled:opacity-40 disabled:hover:bg-transparent'
const LINK =
  'self-start text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline disabled:opacity-40'

/**
 * An edit request's turn in the chat (F-5.26): before a pick, its choices as quick picks, each
 * with what it would cost (the Edits workspace's estimate; on MythScribe Cloud a quote over the
 * threshold asks once more before it starts); disabled with the reason in Plan (which never
 * edits), while the conversation waits, or when the choice cannot run now. After a pick, where
 * the pass stands, and once it is done the review deck over its tracked changes (or the report
 * of a developmental pass, which writes notes only).
 */
export function EditRequestCard({
  messageId,
  edit,
  busy
}: {
  messageId: string
  edit: EditTurn
  busy: boolean
}): React.JSX.Element {
  const settings = useAiSettingsStore((s) => s.settings)
  const open = useOpenScene()
  // Re-read when a pass starts or ends, so the "already running" reason follows it.
  useEditPassStore((s) => s.ids.map((id) => s.byId[id]?.status).join())
  const [confirming, setConfirming] = useState<{ choice: EditChoice; text: string } | null>(null)
  if (edit.picked !== null) return <PickedEdit edit={edit} />
  const pick = (choice: EditChoice): void => {
    setConfirming(null)
    void useAssistantStore.getState().pickEdit(messageId, choice)
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div role="group" aria-label="Kinds of edit" className="flex flex-wrap gap-1.5">
        {edit.choices.map((choice) => {
          const reason =
            settings?.chatMode === 'plan'
              ? PLAN_NO_EDITS_MESSAGE
              : busy
                ? CONVERSATION_BUSY_MESSAGE
                : editChoiceReason(choice, edit.instruction, edit.target, settings, open)
          return (
            <EditChoiceChip
              key={choice}
              choice={choice}
              edit={edit}
              reason={reason}
              onPick={(quote) => {
                if (quote?.quote?.needsConfirm === true) {
                  setConfirming({ choice, text: confirmLine(quote.quote) })
                  return
                }
                pick(choice)
              }}
            />
          )
        })}
      </div>
      {confirming !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" data-testid="edit-choice-quote" className="text-xs text-fg">
            {confirming.text}
          </span>
          <button
            type="button"
            data-testid="edit-choice-confirm"
            className={LINK}
            onClick={() => pick(confirming.choice)}
          >
            Confirm and start
          </button>
          <button type="button" className={LINK} onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** One quick pick: its label, what it would cost, and why it cannot run now (its tooltip). */
function EditChoiceChip({
  choice,
  edit,
  reason,
  onPick
}: {
  choice: EditChoice
  edit: EditTurn
  reason: string | null
  onPick: (quote: PassQuote | null) => void
}): React.JSX.Element {
  const pass = choicePass(choice, edit.instruction)
  const { model, source } = usePassModel(pass?.type ?? 'line')
  const pricing = useHostedPricing()
  const priced =
    pass === null
      ? null
      : quotePass(pass.type, targetWords(edit.target), model, source === 'cloud', pricing)
  const cost =
    priced === null
      ? null
      : priced.quote !== null
        ? priced.quote.priced
          ? `up to about ${formatUsd(priced.quote.costUsd)}`
          : null
        : priced.estimate.priced
          ? `about ${formatUsd(priced.estimate.costUsd)}`
          : null
  return (
    <button
      type="button"
      data-testid="edit-choice"
      data-choice={choice}
      disabled={reason !== null}
      title={reason ?? (priced === null ? undefined : estimateLine(priced))}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onPick(priced)}
      className={CHIP}
    >
      <span className="font-medium text-fg">{EDIT_CHOICE_LABEL[choice]}</span>
      {cost !== null ? <span className="text-[11px] text-fg-subtle">{cost}</span> : null}
    </button>
  )
}

/** Where the picked pass stands, and its review once it is done. */
function PickedEdit({ edit }: { edit: EditTurn }): React.JSX.Element | null {
  const pass = useEditPassStore((s) => (edit.passId === null ? undefined : s.byId[edit.passId]))
  if (pass === undefined) return null
  const store = useEditPassStore.getState()
  const done = new Set(pass.doneNodeIds).size
  return (
    <div
      data-testid="edit-request-status"
      data-status={pass.status}
      className="flex flex-col gap-1"
    >
      <p className="m-0 text-xs text-fg-muted">
        {pass.status === 'running'
          ? `${passTitle(pass)}: ${done} of ${formatCount(pass.nodeIds.length, 'scene')} read.`
          : pass.status === 'done'
            ? `${passTitle(pass)} finished: ${formatCount(pass.counts.pending, passChangesText(pass.type) ? 'change' : 'note')} to review.`
            : pass.status === 'failed'
              ? (pass.error ?? 'The pass stopped.')
              : 'The pass was stopped. Resume it from Edit reports.'}
      </p>
      {pass.status === 'done' && pass.counts.pending > 0 ? (
        passChangesText(pass.type) ? (
          <button
            type="button"
            data-testid="edit-request-review"
            className={LINK}
            onClick={() => void store.reviewPass(pass.id)}
          >
            Review the changes
          </button>
        ) : (
          <button
            type="button"
            data-testid="edit-request-report"
            className={LINK}
            onClick={() => void store.openReport(pass.id)}
          >
            Open the report
          </button>
        )
      ) : null}
    </div>
  )
}
