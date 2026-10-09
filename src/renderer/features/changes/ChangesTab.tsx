import { useMemo } from 'react'
import {
  CHANGE_KIND_LABEL,
  CHANGE_SOURCE_LABEL,
  type ChangeEntry,
  type ChangeSource
} from '@shared/changes'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useChangesStore } from './changesStore'

const ACTION =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-60'

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

/** The rows of one run, in the order the log lists them. */
interface RunGroup {
  runId: string
  createdAt: string
  nodeId: string | null
  source: ChangeSource
  entries: ChangeEntry[]
}

/**
 * The log's rows by run, each run once where its newest row stands (F-9.15): a chat turn or an
 * Organise plan is recorded change by change, so a reading can be logged between two of its rows,
 * and an older page can bring more of a run already shown. The store keeps the rows in main's
 * order (newest first), so the page cursor stays its last row.
 */
function groupRuns(entries: readonly ChangeEntry[]): RunGroup[] {
  const groups = new Map<string, RunGroup>()
  for (const entry of entries) {
    const held = groups.get(entry.runId)
    if (held !== undefined) held.entries.push(entry)
    else
      groups.set(entry.runId, {
        runId: entry.runId,
        createdAt: entry.createdAt,
        nodeId: entry.nodeId,
        source: entry.source,
        entries: [entry]
      })
  }
  return [...groups.values()]
}

/**
 * The Changes section (F-9.13): every change the AI applied on its own while reading the scenes
 * (a fact, a sheet, a tag, a tag on a scene), newest first and grouped by reading, each with the
 * scene and the passage behind it and an Undo; "Undo run" takes back a whole reading. An
 * Undo is for good: the next reading does not redo it.
 *
 * F-9.15: the one log of story-bible changes. Runs of Organise, an upload's Apply, and a chat
 * turn are listed by their source instead of a scene. A merge or a deletion is listed without
 * an Undo ("No undo"), as Organise's rule has it.
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
        What the AI changed in your story bible: while reading your scenes, in Organise, from an
        upload, or from the chat. Undo takes one back for good.
      </p>
      {groups.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">Nothing yet.</p>
      ) : (
        <ul role="list" aria-label="Changes" className="m-0 flex list-none flex-col gap-3 p-0">
          {groups.map((group) => {
            // "Undo run" is for a run of several changes Undo can take back, one still applied.
            const undoable = group.entries.filter((entry) => entry.undoable)
            const runUndo =
              undoable.length > 1 && undoable.some((entry) => entry.status === 'applied')
            const scene = titleOf(group.nodeId)
            const reading = group.source === 'reading'
            const heading = reading ? scene : CHANGE_SOURCE_LABEL[group.source]
            return (
              <li
                key={group.runId}
                aria-label={reading ? `Reading of ${scene}` : heading}
                className="flex flex-col gap-1 rounded-md border border-line p-2"
              >
                <div className="flex items-center gap-1 text-xs whitespace-nowrap text-fg-subtle">
                  <span className="shrink-0 tabular-nums">{shortTime(group.createdAt)}</span>
                  <span aria-hidden="true" className="shrink-0">
                    ·
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={heading}>
                    {heading}
                  </span>
                  {runUndo ? (
                    <button
                      type="button"
                      disabled={pending.includes(group.runId)}
                      onClick={() => run(useChangesStore.getState().undoRun(group.runId))}
                      className={`shrink-0 ${ACTION}`}
                    >
                      Undo run
                    </button>
                  ) : null}
                </div>
                <ul role="list" className="m-0 flex list-none flex-col gap-2 p-0">
                  {group.entries.map((entry) => (
                    <li
                      key={entry.id}
                      aria-label={`${CHANGE_KIND_LABEL[entry.kind]}: ${entry.label}`}
                      className={`flex min-w-0 flex-col gap-0.5 ${entry.status === 'undone' ? 'opacity-60' : ''}`}
                    >
                      <div className="flex min-w-0 items-baseline gap-1.5 text-xs whitespace-nowrap">
                        <span className="shrink-0 text-[10px] tracking-wide text-fg-subtle uppercase">
                          {CHANGE_KIND_LABEL[entry.kind]}
                        </span>
                        <span
                          title={entry.label}
                          className={`min-w-0 flex-1 truncate text-sm ${entry.status === 'undone' ? 'line-through' : ''}`}
                        >
                          {entry.label}
                        </span>
                        {entry.status === 'undone' ? (
                          <span className="shrink-0 px-1.5 py-0.5 text-fg-subtle">Undone</span>
                        ) : !entry.undoable ? (
                          <span
                            title="Merges, deletions, and new categories cannot be undone."
                            className="shrink-0 px-1.5 py-0.5 text-fg-subtle"
                          >
                            No undo
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={pending.includes(entry.id) || pending.includes(group.runId)}
                            onClick={() => run(useChangesStore.getState().undo(entry.id))}
                            className={`shrink-0 ${ACTION}`}
                          >
                            Undo
                          </button>
                        )}
                      </div>
                      {entry.quote === null ? null : (
                        <div className="flex min-w-0 items-end gap-1.5 text-xs">
                          <q
                            title={entry.quote}
                            className="line-clamp-2 min-w-0 flex-1 break-words text-fg-muted italic"
                          >
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
                              className={`shrink-0 whitespace-nowrap ${ACTION}`}
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
