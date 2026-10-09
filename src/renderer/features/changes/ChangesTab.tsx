import { useMemo } from 'react'
import { CHANGE_KIND_LABEL, type ChangeEntry } from '@shared/changes'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useChangesStore } from './changesStore'

const ACTION =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-60'
const LINK_BUTTON = 'text-xs text-fg-muted underline hover:text-fg'

/** When a run was logged, short and local. */
const shortTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

/** Runs a store action and toasts its failure (a sheet the author has made theirs, say). */
const run = (action: Promise<void>): void => {
  action.catch((err: unknown) => toast.error(describeError(err)))
}

/** The rows of one reading, in the order the log lists them. */
interface RunGroup {
  runId: string
  createdAt: string
  nodeId: string | null
  entries: ChangeEntry[]
}

function groupRuns(entries: readonly ChangeEntry[]): RunGroup[] {
  const groups: RunGroup[] = []
  for (const entry of entries) {
    const last = groups.at(-1)
    if (last?.runId === entry.runId) last.entries.push(entry)
    else
      groups.push({
        runId: entry.runId,
        createdAt: entry.createdAt,
        nodeId: entry.nodeId,
        entries: [entry]
      })
  }
  return groups
}

/**
 * The Changes section (F-9.13): every change the AI applied on its own while reading the scenes
 * (a fact, a sheet, a tag, a tag on a scene), newest first and grouped by reading, each with the
 * scene and the passage behind it and an Undo; "Undo this run" takes back a whole reading. An
 * Undo is for good: the next reading does not redo it.
 */
export function ChangesTab(): React.JSX.Element {
  const entries = useChangesStore((s) => s.entries)
  const more = useChangesStore((s) => s.more)
  const pending = useChangesStore((s) => s.pending)
  const byId = useTreeStore((s) => s.byId)
  const groups = useMemo(() => groupRuns(entries), [entries])
  const titleOf = (nodeId: string | null): string =>
    nodeId === null ? 'a deleted scene' : (byId[nodeId]?.title ?? 'a deleted scene')

  return (
    <div data-testid="changes-tab" className="min-h-0 flex-1 overflow-y-auto p-2">
      <p className="m-0 mb-2 text-xs text-fg-muted">
        What the AI added to the story bible on its own while reading your scenes. Undo takes one
        back for good.
      </p>
      {groups.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">Nothing yet.</p>
      ) : (
        <ul role="list" aria-label="Changes" className="m-0 flex list-none flex-col gap-3 p-0">
          {groups.map((group) => {
            const open = group.entries.some((entry) => entry.status === 'applied')
            const scene = titleOf(group.nodeId)
            return (
              <li
                key={group.runId}
                aria-label={`Reading of ${scene}`}
                className="flex flex-col gap-1 rounded-md border border-line p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-xs text-fg-subtle">
                    {shortTime(group.createdAt)} · {scene}
                  </span>
                  {open && group.entries.length > 1 ? (
                    <button
                      type="button"
                      disabled={pending.includes(group.runId)}
                      onClick={() => run(useChangesStore.getState().undoRun(group.runId))}
                      className={ACTION}
                    >
                      Undo this run
                    </button>
                  ) : null}
                </div>
                <ul role="list" className="m-0 flex list-none flex-col gap-1 p-0">
                  {group.entries.map((entry) => (
                    <li
                      key={entry.id}
                      aria-label={`${CHANGE_KIND_LABEL[entry.kind]}: ${entry.label}`}
                      className={`flex flex-col gap-0.5 ${entry.status === 'undone' ? 'opacity-60' : ''}`}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="shrink-0 text-[11px] text-fg-subtle">
                          {CHANGE_KIND_LABEL[entry.kind]}
                        </span>
                        <span
                          className={`min-w-0 flex-1 text-sm wrap-anywhere ${entry.status === 'undone' ? 'line-through' : ''}`}
                        >
                          {entry.label}
                        </span>
                        {entry.status === 'undone' ? (
                          <span className="shrink-0 text-xs text-fg-subtle">Undone</span>
                        ) : (
                          <button
                            type="button"
                            disabled={pending.includes(entry.id) || pending.includes(group.runId)}
                            onClick={() => run(useChangesStore.getState().undo(entry.id))}
                            className={ACTION}
                          >
                            Undo
                          </button>
                        )}
                      </div>
                      {entry.quote === null ? null : (
                        <div className="flex items-baseline gap-2 pl-2">
                          <q className="min-w-0 flex-1 text-xs text-fg-muted italic">
                            {entry.quote}
                          </q>
                          {entry.nodeId === null ? null : (
                            <button
                              type="button"
                              aria-label={`Go to passage in ${scene}`}
                              onClick={() => {
                                const { nodeId, quote } = entry
                                if (nodeId === null || quote === null) return
                                void openPassage(nodeId, (doc) => locateText(doc, quote))
                              }}
                              className={LINK_BUTTON}
                            >
                              Go to passage
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            )
          })}
        </ul>
      )}
      {more ? (
        <button
          type="button"
          onClick={() => run(useChangesStore.getState().loadMore())}
          className={`mt-2 ${ACTION}`}
        >
          Show older changes
        </button>
      ) : null}
    </div>
  )
}
