import { ThreadItem } from '@renderer/features/memory/threads/ThreadsList'
import { noStepsNamingText } from '@renderer/features/memory/threads/threadsView'
import { useNameOf } from '@renderer/features/memory/knows/useNameOf'
import { useSheetMemory } from '@renderer/features/memory/memoryStore'
import { AsOfPicker } from './AsOfPicker'
import { useAsOf } from './asOf'

const HEADING = 'm-0 text-xs font-semibold tracking-wide text-fg-muted uppercase'

/**
 * A named record's **Threads, as of [scene ▾]** (F-16.23; plan P2b §5.2): each thread with a step
 * as of the scene whose paragraph names it, with the thread's own status and those steps (ⓘ and
 * *Not right* on each); with none, the scoped "No scene shows a thread step naming Mara (checked up
 * to 1.2)" (P2b rule 9).
 */
export function ThreadsSection({ recordId }: { recordId: string }): React.JSX.Element {
  const { asOf, scenes, setAsOf } = useAsOf()
  const sheet = useSheetMemory(recordId, asOf)
  const nameOf = useNameOf()
  const threads = sheet?.threads ?? null
  return (
    <section aria-label="Threads" className="flex flex-col gap-1" data-testid="threads-section">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={HEADING}>Threads</h3>
        <AsOfPicker scenes={scenes} value={asOf} onChange={setAsOf} />
      </div>
      {sheet === undefined ? (
        <p className="m-0 text-xs text-fg-muted">Reading…</p>
      ) : threads === null ? null : threads.threads.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted" data-testid="threads-none">
          {noStepsNamingText(nameOf(recordId), threads.checkedUpTo)}
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {threads.threads.map((thread) => (
            <li key={thread.recordId}>
              <ThreadItem thread={thread} checkedUpTo={threads.checkedUpTo} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
