import { useId } from 'react'
import { Plus } from 'lucide-react'
import type { RecordKind } from '@shared/memory/records'
import { THREAD_CATEGORY_ID } from '@shared/memory/topics'
import type { SceneRefView, ThreadMemoryView, ThreadStepView } from '@shared/memory/views'
import { AiMark } from '@renderer/features/ai/AiMark'
import { openRecordSheet } from '@renderer/features/records/openRecord'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { ClaimLine } from '../ClaimLine'
import { TopicInfoButton } from '../knows/TopicInfo'
import { useMemoryStore, useThreads } from '../memoryStore'
import { staleNote } from '../memoryView'
import { mutedStepNote, noStepsText, stepText, threadStatusText } from './threadsView'

const HEADING = 'm-0 mt-3 mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase'
const SMALL =
  'flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg'

/** A step is about its thread: *Not about* offers nothing (`notRight.ts`: it does not apply). */
const NO_OTHER_RECORD: readonly RecordKind[] = []

/**
 * The Book's **Threads** (F-16.23; design §2.5 and §2.7, plan P2b §5.2) as of the scene the Book tab
 * is read as of: each thread the author made and each one the reader found (the AI mark), its
 * status ("open since 2.1 · last 7.3", "resolved in 20.1", "not yet in the book"), ⓘ (its reveals,
 * *Split*, *Not a thread* when the AI made it), and its steps as lines with ⓘ and *Not right*
 * ("advances 7.3: Johanna writes to Ashby"; remembered or rumoured ones muted: they move no status);
 * a thread with no step reads, muted and scoped, "No scene shows this thread yet (checked up to
 * 14.2)". *New thread* makes one of the author's.
 */
export function ThreadsList({ asOf }: { asOf: string | null }): React.JSX.Element {
  const headingId = useId()
  const memory = useThreads(asOf)
  return (
    <section aria-labelledby={headingId} data-testid="threads-list">
      <h3 id={headingId} className={HEADING}>
        Threads
      </h3>
      {memory === undefined ? (
        <p className="m-0 text-xs text-fg-muted">Reading…</p>
      ) : memory.threads.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">No plot thread found in the book yet.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {memory.threads.map((thread) => (
            <li key={thread.recordId}>
              <ThreadItem thread={thread} checkedUpTo={memory.checkedUpTo} />
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className={`${SMALL} mt-1`}
        onClick={() => useRecordStore.getState().startCreate(THREAD_CATEGORY_ID)}
      >
        <Plus size={12} aria-hidden="true" /> New thread
      </button>
    </section>
  )
}

/**
 * One thread as of a scene: its name (which opens its sheet), the AI mark when the reader found it,
 * its status, ⓘ, and its steps (`ThreadSteps`). The Book's Threads and a sheet's Threads show it.
 */
export function ThreadItem({
  thread,
  checkedUpTo
}: {
  thread: ThreadMemoryView
  checkedUpTo: SceneRefView | null
}): React.JSX.Element {
  return (
    <div role="group" aria-label={`Thread: ${thread.label}`} className="py-0.5" data-testid="thread">
      <div className="flex flex-wrap items-baseline gap-1">
        <p className="m-0 min-w-0 flex-1 text-sm" data-testid="thread-head">
          <button
            type="button"
            className="text-left hover:underline"
            onClick={() => openRecordSheet(thread.recordId, THREAD_CATEGORY_ID)}
          >
            {thread.label}
          </button>
          <span className="text-fg-muted"> · {threadStatusText(thread)}</span>
        </p>
        {thread.origin === 'ai' ? <AiMark title="Found by the AI in your book" /> : null}
        <TopicInfoButton topic={thread} kind="thread" />
      </div>
      <ThreadSteps thread={thread} checkedUpTo={checkedUpTo} />
    </div>
  )
}

/**
 * A thread's steps as of a scene, each a line with ⓘ and *Not right* (muted, with why, when it
 * moves no status); with none at all, the scoped "No scene shows this thread yet (checked up to
 * 1.2)" (P2b rule 9).
 */
export function ThreadSteps({
  thread,
  checkedUpTo
}: {
  thread: ThreadMemoryView
  checkedUpTo: SceneRefView | null
}): React.JSX.Element {
  const paused = useMemoryStore((s) => s.status?.paused ?? null)
  if (thread.steps.length === 0) {
    return (
      <p className="m-0 text-xs text-fg-muted italic" data-testid="thread-no-steps">
        {thread.later === 0 ? noStepsText(checkedUpTo) : 'Its first step comes later in the book.'}
      </p>
    )
  }
  return (
    <ul className="m-0 list-none p-0 pl-2" aria-label={`Steps of ${thread.label}`}>
      {thread.steps.map((step: ThreadStepView) => (
        <ClaimLine
          key={step.claimId}
          claimId={step.claimId}
          text={stepText(step)}
          note={mutedStepNote(step)}
          stale={step.stale}
          staleNote={staleNote(paused)}
          recordId={thread.recordId}
          notAboutKinds={NO_OTHER_RECORD}
          muted={!step.counted}
        />
      ))}
    </ul>
  )
}
