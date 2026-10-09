import { useId, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { Fact } from '@shared/facts'
import type { Entity } from '@shared/ipc/contract'
import {
  RELATION_INVERSE_LABEL,
  RELATION_LABEL,
  RELATION_LABEL_MAX,
  RELATION_TYPES,
  RelationType,
  relationTypeOf
} from '@shared/relations'
import { THREAD_KIND } from '@shared/threads'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useEntityStore } from './entityStore'
import { useFactStore } from './factStore'
import type { StoryClock } from './factView'

const LABEL = 'text-xs font-medium text-fg-muted'
const BUTTON =
  'rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-raised disabled:opacity-60 disabled:hover:bg-transparent'
const LINK_BUTTON = 'text-xs text-fg-muted underline hover:text-fg'
const CONTROL = 'min-w-0 rounded-md border border-line bg-bg px-1.5 py-0.5 text-xs'

/** One relationship as this sheet reads it: the type from this side, the other sheet, and the fact. */
interface RelationRow {
  fact: Fact
  type: RelationType
  label: string
  otherId: string
  later: boolean
}

/**
 * The relationships of a record as of the viewed scene (F-9.14, D5): every relationship fact that
 * names this sheet at either end, read from this side ("Mentor of Tomas" here, "Mentored by Mara"
 * on Tomas's sheet), the AI's marked with the scene and a jump to the passage, the author's own
 * marked "Yours". One stated after the viewed scene is listed dimmed as later. A wrong AI one is
 * hidden for good (the next reading does not bring it back); the author's own is removed. The
 * author adds one with a type, the other sheet, an optional label, and the scene it holds from.
 */
export function Relationships({
  entity,
  facts,
  position,
  clock
}: {
  entity: Entity
  facts: readonly Fact[]
  /** The viewed scene; null is the end of the book. */
  position: string | null
  clock: StoryClock
}): React.JSX.Element {
  const byId = useEntityStore((s) => s.byId)
  const at = (nodeId: string | null): number => (nodeId === null ? -1 : clock.order.indexOf(nodeId))
  const limit = position === null ? clock.order.length : clock.order.indexOf(position)

  const rows: RelationRow[] = []
  for (const fact of facts) {
    const type = relationTypeOf(fact.attribute)
    if (type === null || fact.hidden || fact.objectEntityId === null) continue
    const outgoing = fact.entityId === entity.id
    rows.push({
      fact,
      type,
      label: outgoing ? RELATION_LABEL[type] : RELATION_INVERSE_LABEL[type],
      otherId: outgoing ? fact.objectEntityId : fact.entityId,
      later: at(fact.nodeId) > limit
    })
  }
  rows.sort((a, b) => at(a.fact.nodeId) - at(b.fact.nodeId))

  return (
    <section aria-label="Relationships" className="flex flex-col gap-1.5">
      <h3 className={`m-0 font-normal ${LABEL}`}>Relationships</h3>
      {rows.length === 0 ? (
        <p className="m-0 text-xs text-fg-subtle">None yet.</p>
      ) : (
        <ul role="list" className="m-0 flex list-none flex-col gap-1 p-0">
          {rows.map((row) => (
            <RelationItem
              key={row.fact.id}
              row={row}
              otherName={byId[row.otherId]?.name ?? 'a deleted sheet'}
              clock={clock}
            />
          ))}
        </ul>
      )}
      <AddRelationship entity={entity} clock={clock} />
    </section>
  )
}

function RelationItem({
  row,
  otherName,
  clock
}: {
  row: RelationRow
  otherName: string
  clock: StoryClock
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const { fact } = row
  const act = async (task: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await task()
    } catch (err) {
      toast.error(describeError(err))
    }
    setBusy(false)
  }
  const nodeId = fact.nodeId
  const quote = fact.quote
  return (
    <li
      aria-label={`${row.label} ${otherName}`}
      data-later={row.later ? 'true' : undefined}
      className={`flex flex-col gap-0.5 rounded-md border border-line px-2 py-1 ${row.later ? 'opacity-60' : ''}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        {fact.origin === 'ai' ? (
          <span
            data-testid="relation-ai-mark"
            title="Read from the scene by the AI"
            className="flex shrink-0 items-center gap-0.5 text-[11px] text-accent"
          >
            <Sparkles size={11} aria-hidden="true" />
            AI
          </span>
        ) : (
          <span className="shrink-0 text-[11px] text-fg-subtle">Yours</span>
        )}
        <span className="text-sm">{row.label}</span>
        <button
          type="button"
          onClick={() => useEntityStore.getState().select(row.otherId)}
          className="text-sm font-medium underline-offset-2 hover:underline"
        >
          {otherName}
        </button>
        {fact.value !== '' ? (
          <span className="min-w-0 text-xs text-fg-muted wrap-anywhere">({fact.value})</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
          <span>
            {nodeId === null ? 'From the start' : `From ${clock.titleOf(nodeId)}`}
            {row.later ? ' (later)' : ''}
          </span>
          {nodeId !== null && quote !== null ? (
            <button
              type="button"
              aria-label={`Go to passage in ${clock.titleOf(nodeId)}`}
              title={quote}
              onClick={() => void openPassage(nodeId, (doc) => locateText(doc, quote))}
              className={LINK_BUTTON}
            >
              Go to passage
            </button>
          ) : null}
        </span>
        {fact.origin === 'ai' ? (
          <button
            type="button"
            disabled={busy}
            title="Hide this for good; reading the scene again will not bring it back"
            onClick={() => void act(() => useFactStore.getState().setHidden([fact.id], true))}
            className={BUTTON}
          >
            Hide
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => useFactStore.getState().remove(fact.id))}
            className={BUTTON}
          >
            Remove
          </button>
        )}
      </div>
    </li>
  )
}

/** The author's own relationship: type, other sheet, label, and the scene it holds from. */
function AddRelationship({
  entity,
  clock
}: {
  entity: Entity
  clock: StoryClock
}): React.JSX.Element {
  const uid = useId()
  const byId = useEntityStore((s) => s.byId)
  const others = Object.values(byId)
    .filter((each) => each.id !== entity.id && each.kind !== THREAD_KIND)
    .sort((a, b) => a.name.localeCompare(b.name))
  const [type, setType] = useState<RelationType>('friend')
  const [other, setOther] = useState('')
  const [label, setLabel] = useState('')
  const [from, setFrom] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async (): Promise<void> => {
    setBusy(true)
    try {
      await useFactStore.getState().create({
        kind: 'relation',
        entityId: entity.id,
        type,
        objectEntityId: other,
        label: label.trim(),
        nodeId: from === '' ? null : from
      })
      setOther('')
      setLabel('')
    } catch (err) {
      toast.error(describeError(err))
    }
    setBusy(false)
  }

  return (
    <div role="group" aria-label="Add a relationship" className="flex flex-wrap items-center gap-1">
      <label htmlFor={`${uid}-type`} className="sr-only">
        Relationship type
      </label>
      <select
        id={`${uid}-type`}
        value={type}
        onChange={(event) => {
          const next = RelationType.safeParse(event.target.value)
          if (next.success) setType(next.data)
        }}
        className={CONTROL}
      >
        {RELATION_TYPES.map((each) => (
          <option key={each} value={each}>
            {RELATION_LABEL[each]}
          </option>
        ))}
      </select>
      <label htmlFor={`${uid}-other`} className="sr-only">
        Other sheet
      </label>
      <select
        id={`${uid}-other`}
        value={other}
        onChange={(event) => setOther(event.target.value)}
        className={`${CONTROL} flex-1 basis-24`}
      >
        <option value="">Choose a sheet…</option>
        {others.map((each) => (
          <option key={each.id} value={each.id}>
            {each.name}
          </option>
        ))}
      </select>
      <input
        aria-label="Relationship label"
        placeholder="Label (optional)"
        value={label}
        maxLength={RELATION_LABEL_MAX}
        onChange={(event) => setLabel(event.target.value)}
        className={`${CONTROL} flex-1 basis-24`}
      />
      <label htmlFor={`${uid}-from`} className="sr-only">
        Holds from
      </label>
      <select
        id={`${uid}-from`}
        value={from}
        onChange={(event) => setFrom(event.target.value)}
        className={`${CONTROL} flex-1 basis-24`}
      >
        <option value="">From the start</option>
        {clock.order.map((sceneId) => (
          <option key={sceneId} value={sceneId}>
            From {clock.titleOf(sceneId)}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={busy || other === ''}
        onClick={() => void add()}
        className={BUTTON}
      >
        Add
      </button>
    </div>
  )
}
