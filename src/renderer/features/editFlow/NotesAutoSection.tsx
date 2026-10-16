import { useEffect, useId, useState } from 'react'
import { priceFor } from '@shared/ai'
import {
  EDIT_FLOW_TIER,
  NOTES_AUTO_CAP_MAX,
  NOTES_AUTO_CAP_MIN,
  type EditFlowPlanResult,
  type EditFlowSpec
} from '@shared/editFlow'
import { useHostedPricing } from '@renderer/features/account/hostedPricing'
import { formatUsd } from '@renderer/features/ai/usageFormat'
import { quoteEstimate, useFeatureModel } from '@renderer/features/editPass/passQuote'
import { useStoryMemory } from '@renderer/features/project/storyMemory'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useEditFlowStore } from './editFlowStore'

const FIELD = 'w-20 rounded-md border border-line bg-bg px-2 py-1 text-sm'

/** The whole book on Quick Update notes: one request per chapter, so its price over its requests. */
const BOOK_NOTES: EditFlowSpec = {
  categories: ['updateNotes'],
  depth: 'quick',
  scope: { kind: 'book', nodeId: null }
}

/**
 * Settings › AI, story memory v1 (notes redesign phase 3): "Update my notes after I finish a
 * chapter", off by default, with the price of one chapter's update under it (the book's Quick
 * Update notes over its requests, a chapter each, on the fast model) and the daily cap (1–50
 * runs, 10 by default), committed on blur or Enter. Per project: the book decides.
 */
export function NotesAutoSection(): React.JSX.Element | null {
  const memory = useStoryMemory()
  const auto = useEditFlowStore((s) => s.auto)
  const hintId = useId()
  useEffect(() => {
    if (memory !== 'v1') return
    useEditFlowStore
      .getState()
      .loadAuto()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [memory])
  if (memory !== 'v1' || auto === null) return null
  return (
    <div className="flex flex-col gap-1" data-testid="notes-auto">
      <label className="flex items-center gap-2 font-medium">
        <input
          type="checkbox"
          role="switch"
          aria-describedby={hintId}
          checked={auto.on}
          onChange={(event) =>
            void useEditFlowStore.getState().setAuto({ ...auto, on: event.target.checked })
          }
        />
        <span>Update my notes after I finish a chapter</span>
      </label>
      <p id={hintId} className="m-0 text-xs text-fg-muted">
        When you open a scene in another chapter after writing in one, the edit flow’s Update notes
        reads that chapter and writes what is new into your notes, each change with Undo. Closing
        the app never runs it.
      </p>
      <ChapterPrice />
      <CapField value={auto.dailyCap} />
    </div>
  )
}

/** About what one chapter's update costs, on the fast model. */
function ChapterPrice(): React.JSX.Element {
  const [plan, setPlan] = useState<EditFlowPlanResult | null | 'none'>(null)
  const { model, source } = useFeatureModel('editFlow', EDIT_FLOW_TIER.quick)
  const pricing = useHostedPricing()
  useEffect(() => {
    let live = true
    ipc()
      .invoke('editFlow:plan', BOOK_NOTES)
      .then(
        (value) => {
          if (live) setPlan(value.requests > 0 ? value : 'none')
        },
        () => {
          if (live) setPlan('none')
        }
      )
    return () => {
      live = false
    }
  }, [])
  let line = 'Pricing…'
  if (plan === 'none') line = 'The price per chapter shows once the book has text.'
  else if (plan !== null) {
    const tokensIn = Math.ceil(plan.tokensIn / plan.requests)
    const tokensOut = Math.ceil(plan.tokensOut / plan.requests)
    const price = priceFor(model, tokensIn, tokensOut)
    const { quote } = quoteEstimate(
      {
        scenes: plan.scenes,
        words: plan.words,
        chunks: 1,
        tokensIn,
        tokensOut,
        costUsd: price.costUsd,
        priced: price.priced
      },
      model,
      source === 'cloud',
      pricing
    )
    const usd =
      quote === null ? (price.priced ? price.costUsd : null) : quote.priced ? quote.costUsd : null
    line =
      usd === null
        ? `${model} has no published price here, so the cost per chapter is not estimated.`
        : `About ${formatUsd(usd)} a chapter on ${model}.`
  }
  return (
    <p className="m-0 text-xs text-fg-muted" data-testid="notes-auto-price">
      {line}
    </p>
  )
}

/** The daily cap, committed on blur or Enter; a blank, out-of-range or unchanged value restores it. */
function CapField({ value }: { value: number }): React.JSX.Element {
  const hintId = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    const runs = Number(draft.trim())
    setDraft(null)
    if (
      !Number.isInteger(runs) ||
      runs < NOTES_AUTO_CAP_MIN ||
      runs > NOTES_AUTO_CAP_MAX ||
      runs === value
    ) {
      return
    }
    const auto = useEditFlowStore.getState().auto
    if (auto !== null) void useEditFlowStore.getState().setAuto({ ...auto, dailyCap: runs })
  }
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-3">
        <span>Updates a day, at most</span>
        <input
          type="number"
          inputMode="numeric"
          min={NOTES_AUTO_CAP_MIN}
          max={NOTES_AUTO_CAP_MAX}
          step="1"
          aria-describedby={hintId}
          value={draft ?? String(value)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
          }}
          className={FIELD}
        />
      </label>
      <p id={hintId} className="m-0 text-xs text-fg-muted">
        {`From ${NOTES_AUTO_CAP_MIN} to ${NOTES_AUTO_CAP_MAX}; the count starts again at midnight.`}
      </p>
    </div>
  )
}
