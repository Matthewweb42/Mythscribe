import { useEffect, useId, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Sparkles } from 'lucide-react'
import { AI_DATA_SHARING, AI_DIAL_LABEL, isFeatureAllowed } from '@shared/aiSettings'
import { docToText } from '@shared/docText'
import { SUMMARY_TEXT_MIN, type StoredSceneSummary } from '@shared/summary'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useDocumentStore } from './documentStore'
import { useSummaryStore } from './summaryStore'

const BUTTON =
  'flex shrink-0 items-center gap-1 rounded-md whitespace-nowrap px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-expanded:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted'
const CHIP = 'rounded-full border border-line bg-surface-raised px-2 py-0.5 text-xs'

/**
 * The scene summary (F-5.6) in the metadata pane: what main wrote in the background after the
 * author stopped typing, behind a disclosure under the brief. Nothing to accept — a summary is
 * derived index data, not text offered to the manuscript — so the block only reads: the status
 * of the node's run, the summary with its key points and the characters present, and a
 * Summarize now button for the author who will not wait for the debounce. It shows for a
 * manuscript document alone (`available`); front matter, end matter, and folders get no block.
 * `onOpen` grows the tag bar the way opening the brief does.
 */
export function SummaryBlock({
  id,
  onOpen
}: {
  id: string
  onOpen: () => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const sectionId = useId()
  const state = useSummaryStore((s) => s.byNode[id] ?? null)
  const load = useSummaryStore((s) => s.load)
  const summarize = useSummaryStore((s) => s.summarize)
  const settings = useAiSettingsStore((s) => s.settings)
  const content = useDocumentStore((s) => s.docs[id]?.content ?? null)
  const textLength = useMemo(() => (content ? docToText(content).length : 0), [content])

  useEffect(() => {
    void load(id)
  }, [id, load])

  if (!state?.available) return null

  const pending = state.status === 'pending'
  const { minDial } = AI_DATA_SHARING.summary
  let blocked: string | null = null
  if (settings === null || settings.dial < minDial) {
    blocked = `Summarising a scene needs the AI dial at ${AI_DIAL_LABEL[minDial]} or higher (Settings, AI tab)`
  } else if (!isFeatureAllowed(settings, 'summary')) {
    blocked = 'Scene summaries are turned off for this project (Settings, AI tab)'
  } else if (pending) {
    blocked = 'A summary is already on the way'
  } else if (textLength < SUMMARY_TEXT_MIN) {
    blocked = `Write ${SUMMARY_TEXT_MIN.toLocaleString()} characters before asking for a summary`
  }

  let hint = ''
  if (pending) hint = 'Updating…'
  else if (state.stale) hint = 'Out of date'

  return (
    <>
      {/* Same as the brief's row: the pane may be narrow, so the row wraps, the labels do not. */}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? sectionId : undefined}
          onClick={() => {
            if (open) {
              setOpen(false)
            } else {
              setOpen(true)
              onOpen()
            }
          }}
          className={BUTTON}
        >
          {open ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
          <span className="font-medium">Summary</span>
        </button>
        <span data-testid="summary-status" className="text-xs text-fg-subtle">
          {hint}
        </span>
        <button
          type="button"
          data-testid="summary-refresh"
          onClick={() => void summarize(id)}
          disabled={blocked !== null}
          title={blocked ?? 'Summarise this scene now'}
          className={`ml-auto ${BUTTON}`}
        >
          {pending ? (
            <Loader2 size={14} aria-hidden="true" className="animate-spin" />
          ) : (
            <Sparkles size={14} aria-hidden="true" />
          )}
          Summarize now
        </button>
      </div>
      {open ? (
        <div id={sectionId} data-testid="summary-section" className="flex flex-col gap-1">
          {state.error !== null ? (
            <p role="alert" data-testid="summary-error" className="m-0 text-xs text-danger">
              {`${state.error.message} ${state.error.nextStep}`.trim()}
            </p>
          ) : null}
          {state.summary !== null ? (
            <SummaryBody summary={state.summary} />
          ) : state.error === null ? (
            <p data-testid="summary-empty" className="m-0 text-xs text-fg-subtle">
              No summary yet. It is written after you pause typing.
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

/** The stored row itself: the summary, its key points, the characters present, and what wrote it. */
function SummaryBody({ summary }: { summary: StoredSceneSummary }): React.JSX.Element {
  return (
    <>
      <p data-testid="summary-text" className="m-0 text-xs">
        {summary.summary}
      </p>
      {summary.keyPoints.length > 0 ? (
        <ul
          role="list"
          aria-label="Key points"
          data-testid="summary-key-points"
          className="m-0 flex list-disc flex-col gap-0.5 pl-4"
        >
          {summary.keyPoints.map((point) => (
            <li key={point} className="text-xs">
              {point}
            </li>
          ))}
        </ul>
      ) : null}
      {summary.characters.length > 0 ? (
        <ul
          role="list"
          aria-label="Characters present"
          data-testid="summary-characters"
          className="m-0 flex list-none flex-wrap gap-1 p-0"
        >
          {summary.characters.map((name) => (
            <li key={name} className={CHIP}>
              {name}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="m-0 text-xs text-fg-subtle">{summary.model}</p>
    </>
  )
}
