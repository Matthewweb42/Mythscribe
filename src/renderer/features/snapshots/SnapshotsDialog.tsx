import { useEffect, useId, useState } from 'react'
import {
  defaultSnapshotName,
  SNAPSHOT_NAME_MAX,
  SNAPSHOT_NOTE_MAX,
  type SnapshotInfo,
  type SnapshotScope
} from '@shared/snapshots'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { StatsFrame } from '@renderer/features/stats/StatsFrame'
import { describeError } from '@renderer/lib/errors'
import { SnapshotCompare } from './SnapshotCompare'
import { useSnapshotStore } from './snapshotStore'

const BUTTON =
  'rounded-md border border-line px-2.5 py-1 text-xs hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'
const FIELD = 'w-full rounded-md border border-line bg-bg px-2 py-1 text-sm'

const plural = (count: number, noun: string): string =>
  `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`

const when = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** A document snapshot's document title; an empty title reads "Untitled". */
const titleOf = (snapshot: SnapshotInfo): string => (snapshot.nodeTitle ?? '') || 'Untitled'

/** What a snapshot covers: "Whole project · N documents" or the document's title. */
function snapshotScopeText(snapshot: SnapshotInfo): string {
  if (snapshot.scope === 'project')
    return `Whole project · ${plural(snapshot.docCount, 'document')}`
  return titleOf(snapshot)
}

const FILTERS = ['all', 'document', 'milestones'] as const
type Filter = (typeof FILTERS)[number]

/** The document open in the editor (not a folder, not an entity page), or null. */
function useOpenDocument(): { id: string; title: string } | null {
  const entityId = useEntityStore((s) => s.selectedId)
  const node = useTreeStore((s) => (s.selectedId === null ? undefined : s.byId[s.selectedId]))
  if (entityId !== null || node?.kind !== 'document') return null
  return { id: node.id, title: node.title }
}

/**
 * The Snapshots dialog (F-8.6), shell dialog `snapshots` from Tools › Snapshots…: a form that
 * takes a snapshot of the open document or the whole project (name, note, milestone flag), and
 * the snapshots newest first, filtered to all, the open document's, or the milestones, each with
 * Compare with current, Restore…, Edit…, and Delete…. The list is asked for again on open, after
 * the pending saves are flushed.
 */
export function SnapshotsDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const snapshots = useSnapshotStore((s) => s.snapshots)
  const [comparing, setComparing] = useState<string | null>(null)

  useEffect(() => {
    const load = async (): Promise<void> => {
      // A failed save is reported by the autosave itself; the stored list is still worth showing.
      await flushPendingSaves().catch(() => undefined)
      await useSnapshotStore.getState().load()
    }
    load().catch((err: unknown) => toast.error(describeError(err)))
  }, [])

  let body: React.ReactNode
  if (snapshots === null) {
    body = <p className="m-0 text-xs text-fg-muted">Loading…</p>
  } else if (comparing !== null && snapshots.some((s) => s.id === comparing)) {
    body = (
      <SnapshotCompare
        snapshots={snapshots}
        initialId={comparing}
        onBack={() => setComparing(null)}
      />
    )
  } else {
    body = (
      <>
        <TakeForm />
        <SnapshotList snapshots={snapshots} onCompare={setComparing} />
      </>
    )
  }

  return (
    <StatsFrame
      title={comparing !== null ? 'Compare snapshots' : 'Snapshots'}
      widthClassName="w-[min(860px,94vw)]"
      onClose={onClose}
    >
      {body}
    </StatsFrame>
  )
}

function TakeForm(): React.JSX.Element {
  const openDoc = useOpenDocument()
  const busy = useSnapshotStore((s) => s.busy)
  const [scope, setScope] = useState<SnapshotScope>(openDoc ? 'document' : 'project')
  const [name, setName] = useState(() => defaultSnapshotName(new Date()))
  const [note, setNote] = useState('')
  const [milestone, setMilestone] = useState(false)
  const nameId = useId()
  const noteId = useId()
  // The open document can change (or close) while the dialog is up; the project is always there.
  const effectiveScope: SnapshotScope = openDoc ? scope : 'project'
  const nameEmpty = name.trim() === ''

  const onTake = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (nameEmpty) return
    const ok = await useSnapshotStore
      .getState()
      .take(
        effectiveScope === 'document' && openDoc
          ? { scope: 'document', nodeId: openDoc.id, name, note, milestone }
          : { scope: 'project', name, note, milestone }
      )
    if (ok) {
      setName(defaultSnapshotName(new Date()))
      setNote('')
      setMilestone(false)
    }
  }

  return (
    <form
      aria-label="Take snapshot"
      onSubmit={(event) => void onTake(event)}
      className="flex flex-col gap-2 rounded-md border border-line px-3 py-2"
    >
      <fieldset className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 border-0 p-0 text-sm">
        <legend className="mb-1 p-0 text-sm font-semibold">Take snapshot</legend>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="snapshot-scope"
            checked={effectiveScope === 'document'}
            disabled={openDoc === null}
            onChange={() => setScope('document')}
          />
          {openDoc ? `This document (${openDoc.title || 'Untitled'})` : 'This document'}
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="snapshot-scope"
            checked={effectiveScope === 'project'}
            onChange={() => setScope('project')}
          />
          Whole project
        </label>
      </fieldset>
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-xs text-fg-muted">
          Name
        </label>
        <input
          id={nameId}
          type="text"
          value={name}
          maxLength={SNAPSHOT_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          className={FIELD}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={noteId} className="text-xs text-fg-muted">
          Note
        </label>
        <textarea
          id={noteId}
          rows={2}
          value={note}
          maxLength={SNAPSHOT_NOTE_MAX}
          onChange={(event) => setNote(event.target.value)}
          className={FIELD}
        />
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={milestone}
            onChange={(event) => setMilestone(event.target.checked)}
          />
          Milestone
        </label>
        <button type="submit" disabled={busy || nameEmpty} className={`${BUTTON} ml-auto`}>
          Take snapshot
        </button>
      </div>
    </form>
  )
}

function SnapshotList({
  snapshots,
  onCompare
}: {
  snapshots: readonly SnapshotInfo[]
  onCompare: (id: string) => void
}): React.JSX.Element {
  const openDoc = useOpenDocument()
  const [filter, setFilter] = useState<Filter>('all')
  const filterId = useId()
  const effective: Filter = filter === 'document' && openDoc === null ? 'all' : filter
  const shown = snapshots.filter((s) =>
    effective === 'milestones'
      ? s.kind === 'milestone'
      : effective === 'document'
        ? s.scope === 'document' && s.nodeId === openDoc?.id
        : true
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <label htmlFor={filterId}>Show</label>
        <select
          id={filterId}
          value={effective}
          onChange={(event) => setFilter(FILTERS.find((f) => f === event.target.value) ?? 'all')}
          className="rounded-md border border-line bg-surface px-2 py-1"
        >
          <option value="all">All</option>
          <option value="document" disabled={openDoc === null}>
            This document
          </option>
          <option value="milestones">Milestones</option>
        </select>
      </div>
      {shown.length === 0 ? (
        <p className="m-0 text-sm text-fg-muted">
          {snapshots.length === 0 ? 'No snapshots yet.' : 'No snapshots match.'}
        </p>
      ) : (
        <ul aria-label="Snapshots" className="m-0 flex list-none flex-col gap-1.5 p-0">
          {shown.map((snapshot) => (
            <SnapshotRow key={snapshot.id} snapshot={snapshot} onCompare={onCompare} />
          ))}
        </ul>
      )}
    </div>
  )
}

function SnapshotRow({
  snapshot,
  onCompare
}: {
  snapshot: SnapshotInfo
  onCompare: (id: string) => void
}): React.JSX.Element {
  const busy = useSnapshotStore((s) => s.busy)
  const [editing, setEditing] = useState(false)

  const onRestore = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Restore "${snapshot.name}"?`,
      message:
        snapshot.scope === 'project'
          ? `Every document it holds takes the text it had then. The text they have now is kept first as an automatic snapshot.`
          : `"${titleOf(snapshot)}" takes the text it had then. The text it has now is kept first as an automatic snapshot.`,
      confirmLabel: 'Restore',
      danger: true
    })
    if (ok) await useSnapshotStore.getState().restore(snapshot.id)
  }

  const onDelete = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Delete "${snapshot.name}"?`,
      message:
        'The snapshot and the text it holds are deleted for good. Your documents are not affected.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (ok) await useSnapshotStore.getState().remove(snapshot.id)
  }

  return (
    <li
      data-testid="snapshot-row"
      className="flex flex-col gap-1 rounded-md border border-line px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{snapshot.name}</span>
        {snapshot.kind === 'milestone' ? (
          <span className="rounded-full bg-accent px-2 py-0.5 text-[0.65rem] font-medium text-accent-fg">
            Milestone
          </span>
        ) : null}
        {snapshot.kind === 'auto' ? (
          <span className="rounded-full border border-line px-2 py-0.5 text-[0.65rem] font-medium text-fg-muted">
            Auto
          </span>
        ) : null}
        <span className="text-xs text-fg-muted">{snapshotScopeText(snapshot)}</span>
        <span className="text-xs text-fg-muted">{when(snapshot.created)}</span>
        <span className="text-xs text-fg-muted">{plural(snapshot.wordCount, 'word')}</span>
      </div>
      {snapshot.note !== '' ? (
        <p className="m-0 whitespace-pre-wrap text-sm text-fg-muted">{snapshot.note}</p>
      ) : null}
      {editing ? (
        <EditForm snapshot={snapshot} onDone={() => setEditing(false)} />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => onCompare(snapshot.id)}
            aria-label={`Compare ${snapshot.name} with current`}
            className={BUTTON}
          >
            Compare with current
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onRestore()}
            aria-label={`Restore ${snapshot.name}…`}
            className={BUTTON}
          >
            Restore…
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(true)}
            aria-label={`Edit ${snapshot.name}…`}
            className={BUTTON}
          >
            Edit…
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onDelete()}
            aria-label={`Delete ${snapshot.name}…`}
            className={BUTTON}
          >
            Delete…
          </button>
        </div>
      )}
    </li>
  )
}

/** The inline Edit… form: name, note, and the milestone flag; only changed fields are sent. */
function EditForm({
  snapshot,
  onDone
}: {
  snapshot: SnapshotInfo
  onDone: () => void
}): React.JSX.Element {
  const busy = useSnapshotStore((s) => s.busy)
  const [name, setName] = useState(snapshot.name)
  const [note, setNote] = useState(snapshot.note)
  const wasMilestone = snapshot.kind === 'milestone'
  const [milestone, setMilestone] = useState(wasMilestone)
  const nameId = useId()
  const noteId = useId()
  const nameEmpty = name.trim() === ''

  const onSave = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (nameEmpty) return
    const changes = {
      ...(name.trim() !== snapshot.name ? { name } : {}),
      ...(note.trim() !== snapshot.note ? { note } : {}),
      // An automatic snapshot left unflagged stays automatic, so `false` is sent only to unflag.
      ...(milestone !== wasMilestone ? { milestone } : {})
    }
    if (Object.keys(changes).length === 0) {
      onDone()
      return
    }
    if (await useSnapshotStore.getState().update({ id: snapshot.id, ...changes })) onDone()
  }

  return (
    <form
      aria-label={`Edit ${snapshot.name}`}
      onSubmit={(event) => void onSave(event)}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-xs text-fg-muted">
          Name
        </label>
        <input
          id={nameId}
          type="text"
          value={name}
          maxLength={SNAPSHOT_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
          className={FIELD}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={noteId} className="text-xs text-fg-muted">
          Note
        </label>
        <textarea
          id={noteId}
          rows={2}
          value={note}
          maxLength={SNAPSHOT_NOTE_MAX}
          onChange={(event) => setNote(event.target.value)}
          className={FIELD}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <label className="mr-auto flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={milestone}
            onChange={(event) => setMilestone(event.target.checked)}
          />
          Milestone
        </label>
        <button type="button" onClick={onDone} className={BUTTON}>
          Cancel
        </button>
        <button type="submit" disabled={busy || nameEmpty} className={BUTTON}>
          Save
        </button>
      </div>
    </form>
  )
}
