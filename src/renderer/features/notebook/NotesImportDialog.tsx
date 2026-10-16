import { useEffect, useId, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { priceFor } from '@shared/ai'
import { isFeatureAllowed } from '@shared/aiSettings'
import {
  NOTES_SORT_TIER,
  type NotesSortEstimate,
  type NotesSortEstimateInput
} from '@shared/notesSort'
import { useHostedPricing } from '@renderer/features/account/hostedPricing'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { formatCount } from '@renderer/features/ai/usageFormat'
import {
  confirmLine,
  estimateLine,
  quoteEstimate,
  useFeatureModel,
  type PassQuote
} from '@renderer/features/editPass/passQuote'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useAssistantName } from '@renderer/features/shell/viewStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useNotesSortStore, type NotesImportMode, type NotesSortChoice } from './notesSortStore'

const BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-50'
const PRIMARY =
  'rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50'

/**
 * How dropped or picked files come into Notes (notes structure part B, 2026-10-16), asked once
 * for the whole drop: **One page each** (the default), **Split at headings** (no AI), or **Sort
 * with Ms Scribe** (only while Use AI and the feature are on), whose price shows first, counted
 * locally as the edit flow's is, with the hosted confirm. A page's menu asks the same Sort for that
 * page. Open while `notesSortStore.choice` is set.
 */
export function NotesImportDialog(): React.JSX.Element | null {
  const choice = useNotesSortStore((s) => s.choice)
  return choice === null ? null : <ChoiceForm choice={choice} />
}

/** The sort's price for `input`, asked once per input (null while asking or when there is none). */
function useSortEstimate(input: NotesSortEstimateInput | null): {
  estimate: NotesSortEstimate | null
  error: string | null
} {
  const [state, setState] = useState<{
    input: NotesSortEstimateInput | null
    estimate: NotesSortEstimate | null
    error: string | null
  }>({ input: null, estimate: null, error: null })
  useEffect(() => {
    if (input === null) return
    let live = true
    ipc()
      .invoke('notesSort:estimate', input)
      .then(
        (estimate) => {
          if (live) setState({ input, estimate, error: null })
        },
        (err: unknown) => {
          if (live) setState({ input, estimate: null, error: describeError(err) })
        }
      )
    return () => {
      live = false
    }
  }, [input])
  return state.input === input && input !== null
    ? { estimate: state.estimate, error: state.error }
    : { estimate: null, error: null }
}

function estimateInputOf(choice: NotesSortChoice): NotesSortEstimateInput {
  if (choice.kind === 'page') return { pageIds: [choice.pageId] }
  if (choice.files !== null) return { files: choice.files }
  return { paths: choice.paths ?? [] }
}

function ChoiceForm({ choice }: { choice: NotesSortChoice }): React.JSX.Element {
  const titleId = useId()
  const name = useAssistantName()
  const allowed = useAiSettingsStore(
    (s) => s.settings !== null && isFeatureAllowed(s.settings, 'notesSort')
  )
  const running = useNotesSortStore((s) => s.running !== null)
  const [mode, setMode] = useState<NotesImportMode>(choice.kind === 'page' ? 'sort' : 'none')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const wantsPrice = mode === 'sort' && allowed
  const input = useMemo(() => (wantsPrice ? estimateInputOf(choice) : null), [wantsPrice, choice])
  const { estimate, error } = useSortEstimate(input)
  const { model, source } = useFeatureModel('notesSort', NOTES_SORT_TIER)
  const pricing = useHostedPricing()
  const priced: PassQuote | null = useMemo(() => {
    if (estimate === null) return null
    const price = priceFor(model, estimate.tokensIn, estimate.tokensOut)
    return quoteEstimate(
      {
        scenes: estimate.sources,
        words: estimate.words,
        chunks: estimate.requests,
        tokensIn: estimate.tokensIn,
        tokensOut: estimate.tokensOut,
        costUsd: price.costUsd,
        priced: price.priced
      },
      model,
      source === 'cloud',
      pricing
    )
  }, [estimate, model, source, pricing])

  const cancel = (): void => useNotesSortStore.getState().cancel()
  const sortReason =
    mode !== 'sort'
      ? null
      : !allowed
        ? `Sort with ${name} needs Use AI on for this project (Settings, AI).`
        : running
          ? `${name} is already sorting a document.`
          : (error ?? (estimate === null ? 'Pricing…' : null))
  const nothing = mode === 'sort' && estimate !== null && estimate.requests === 0

  const submit = async (): Promise<void> => {
    if (busy || sortReason !== null || nothing) return
    if (mode === 'sort' && priced?.quote?.needsConfirm === true && !confirming) {
      setConfirming(true)
      return
    }
    setBusy(true)
    try {
      await useNotesSortStore.getState().confirm(mode)
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }
  const onBackdropMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) cancel()
  }

  const heading =
    choice.kind === 'page'
      ? `Sort “${choice.title}” with ${name}`
      : choice.names.length === 1
        ? `Add “${choice.names[0] ?? ''}” to Notes`
        : `Add ${choice.names.length} files to Notes`
  const options: { value: NotesImportMode; label: string; help: string }[] = [
    { value: 'none', label: 'One page each', help: 'Each file becomes one page, as it is.' },
    {
      value: 'headings',
      label: 'Split at headings',
      help: 'A folder for each file, with a page for each of its main headings. No AI.'
    },
    ...(allowed
      ? [
          {
            value: 'sort' as const,
            label: `Sort with ${name}`,
            help: `${name} copies the text into smaller pages in your folders, never rewording it. Each file is also kept as one page.`
          }
        ]
      : [])
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={onBackdropMouseDown}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="notes-import-dialog"
        onKeyDown={onKeyDown}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        className="flex w-[460px] max-w-[90vw] flex-col gap-3 rounded-lg border border-line bg-surface-raised p-5 shadow-panel"
      >
        <h2 id={titleId} className="m-0 text-base font-semibold">
          {heading}
        </h2>
        {choice.kind === 'page' ? (
          <p className="m-0 text-sm text-fg-muted">
            {`${name} copies its text into smaller pages in your folders, never rewording it. The page stays as it is; one Undo takes the sort back.`}
          </p>
        ) : (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 p-0 text-sm">How should they come in?</legend>
            {options.map((option) => (
              <label key={option.value} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="notes-import-mode"
                  className="mt-1"
                  checked={mode === option.value}
                  onChange={() => {
                    setMode(option.value)
                    setConfirming(false)
                  }}
                />
                <span>
                  {option.label}
                  <span className="block text-xs text-fg-muted">{option.help}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {mode === 'sort' ? (
          <div className="flex flex-col gap-1" data-testid="notes-sort-price">
            {estimate !== null && priced !== null && !nothing ? (
              <>
                <p className="m-0 text-sm">
                  {`${formatCount(estimate.words, 'word')} · ${formatCount(estimate.requests, 'request')}`}
                </p>
                <p className="m-0 text-xs text-fg-muted">{estimateLine(priced)}</p>
              </>
            ) : (
              <p className="m-0 text-xs text-fg-muted">
                {nothing ? 'There is no text to sort.' : (sortReason ?? 'Pricing…')}
              </p>
            )}
            {confirming && priced?.quote ? (
              <p role="status" className="m-0 text-xs text-fg">
                {confirmLine(priced.quote)}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={cancel} className={BUTTON}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || sortReason !== null || nothing}
            className={PRIMARY}
          >
            {mode === 'sort'
              ? confirming
                ? 'Confirm and sort'
                : 'Sort'
              : choice.kind === 'page'
                ? 'Sort'
                : 'Add'}
          </button>
        </div>
      </form>
    </div>
  )
}
