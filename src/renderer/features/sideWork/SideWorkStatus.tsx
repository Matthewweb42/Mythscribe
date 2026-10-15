import type { ReactNode } from 'react'
import { openAssistant } from '@renderer/features/ai/aiActions'
import { AiWaitText } from '@renderer/features/ai/AiWaitText'
import { AI_WAIT_CLASS } from '@renderer/features/ai/aiWaitPhrases'
import { uploadInPanel, useLibraryStore } from '@renderer/features/library/libraryStore'
import { useMemoryStore } from '@renderer/features/memory/memoryStore'
import { suggestionCountText } from '@renderer/features/memory/suggestions/suggestionView'
import { useOrganiseStore } from '@renderer/features/organise/organiseStore'
import { hideSideWork, showSideWork, useShownSideWork, type SideWork } from './sideWork'
import { useAssistantName } from '@renderer/features/shell/viewStore'

const ITEM =
  'rounded px-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:text-fg'

/**
 * Side work in the status bar (2026-10-10): one item per run going on in the background —
 * Organise ("Organising…", then "Organise: ready to review", or its failure) and the upload's
 * sort (its progress, then "Upload: ready to review", or its failure). A click shows the run in
 * the assistant column (opening the column if it is closed) and hides the other; a second click
 * goes back to the conversation. Nothing while no run is under way. F-16.17 (plan
 * `Suggestions.md`): "4 suggestions" while story memory's suggestions wait (or their review shows).
 */
export function SideWorkStatus(): React.JSX.Element | null {
  const organise = useOrganiseStore((s) => (s.open ? s.phase : null))
  const flow = useLibraryStore((s) => (uploadInPanel(s.flow) ? s.flow : null))
  const suggestions = useSuggestionsWaiting()
  const shown = useShownSideWork()
  if (organise === null && flow === null && suggestions === null) return null
  return (
    <span className="flex items-center gap-2" aria-live="polite">
      {organise !== null ? (
        <Item work="organise" shown={shown === 'organise'}>
          {organise === 'running' ? (
            <AiWaitText phrases={ORGANISING} announce={false} />
          ) : organise === 'failed' ? (
            <span className="text-danger">Organise failed</span>
          ) : (
            'Organise: ready to review'
          )}
        </Item>
      ) : null}
      {flow !== null ? (
        <Item work="upload" shown={shown === 'upload'}>
          {flow.stage === 'running' ? (
            flow.progress === null ? (
              <AiWaitText phrases={SORTING} announce={false} />
            ) : (
              <span className={`tabular-nums ${AI_WAIT_CLASS}`}>
                {`Sorting uploads · ${flow.progress.done} of ${flow.progress.total}`}
              </span>
            )
          ) : flow.stage === 'failed' ? (
            <span className="text-danger">Upload sort failed</span>
          ) : (
            'Upload: ready to review'
          )}
        </Item>
      ) : null}
      {suggestions !== null ? (
        <Item work="suggestions" shown={shown === 'suggestions'}>
          {suggestionCountText(suggestions)}
        </Item>
      ) : null}
    </span>
  )
}

/** How many suggestions wait, or null while none do and their review is not showing. */
function useSuggestionsWaiting(): number | null {
  const count = useMemoryStore((s) => s.status?.suggestions ?? 0)
  const shown = useMemoryStore((s) => s.suggestionsShown)
  return count > 0 || shown ? count : null
}

const ORGANISING = ['Organising…']
const SORTING = ['Sorting uploads…']

function Item({
  work,
  shown,
  children
}: {
  work: SideWork
  shown: boolean
  children: ReactNode
}): React.JSX.Element {
  const assistantName = useAssistantName()
  return (
    <button
      type="button"
      data-testid={`side-work-${work}`}
      aria-pressed={shown}
      title={shown ? 'Back to the conversation' : `Show it in the ${assistantName} column`}
      onClick={() => {
        if (shown) {
          hideSideWork(work)
          return
        }
        showSideWork(work)
        openAssistant()
      }}
      className={ITEM}
    >
      {children}
    </button>
  )
}

/**
 * The status line for side work under a main pane that has no status bar of its own (a sheet,
 * a cork board, the empty state, the Edits workspace), so the item is always within reach.
 * Nothing while no run is under way.
 */
export function SideWorkBar(): React.JSX.Element | null {
  const organise = useOrganiseStore((s) => s.open)
  const upload = useLibraryStore((s) => uploadInPanel(s.flow))
  const suggestions = useSuggestionsWaiting()
  if (!organise && !upload && suggestions === null) return null
  return (
    <footer
      data-testid="side-work-bar"
      className="flex shrink-0 items-center gap-3 border-t border-line bg-surface px-6 py-1 text-xs text-fg-muted"
    >
      <SideWorkStatus />
    </footer>
  )
}
