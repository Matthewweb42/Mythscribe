import { useId, useState } from 'react'
import { ChevronRight, Sparkles } from 'lucide-react'
import type { Entity } from '@shared/ipc/contract'
import {
  FACT_STATUSES,
  FACT_STATUS_LABEL,
  FactStatus,
  isFieldFact,
  type Fact,
  type FactValueAt,
  type SheetFieldAt
} from '@shared/facts'
import { observedAttributeLabel } from '@shared/observedFacts'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useEntityStore } from './entityStore'
import { useFactStore } from './factStore'
import {
  FACTS_COMPACT,
  asOfValue,
  parseAsOf,
  useRecordFacts,
  useSheetAt,
  useStoryClock,
  type AsOf,
  type StoryClock
} from './factView'

/**
 * The record's dated facts on its sheet (F-9.13). What the AI read in the scenes is shown beside
 * the author's own text, never in it (D1, confirmed): under a replace field (an age, a role) the
 * newest value as of the viewed scene, under any other field the details stated so far, each
 * marked as the AI's, with the scene it holds from, a jump to the passage, its status, and Hide.
 * A field's history lists every value in reading order, later ones marked, and is where the
 * author dates a line of their own at a scene (D4). The "As of" picker (D3) chooses the scene the
 * sheet is read at: now (the open scene, else the latest written), any scene, or the end.
 */

const LABEL = 'text-xs font-medium text-fg-muted'
const BUTTON =
  'rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-raised disabled:opacity-60 disabled:hover:bg-transparent'
const LINK_BUTTON = 'text-xs text-fg-muted underline hover:text-fg'
const CONTROL = 'rounded-md border border-line bg-bg px-1.5 py-0.5 text-xs'

/** "As of": now, a scene, or the end of the book (D3). */
export function AsOfPicker({
  value,
  onChange,
  clock
}: {
  value: AsOf
  onChange: (next: AsOf) => void
  clock: StoryClock
}): React.JSX.Element {
  const id = useId()
  const now = clock.nowId === null ? 'nothing written yet' : clock.titleOf(clock.nowId)
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className={LABEL}>
        As of
      </label>
      <select
        id={id}
        value={asOfValue(value)}
        onChange={(event) => onChange(parseAsOf(event.target.value))}
        className={CONTROL}
      >
        <option value="now">Now ({now})</option>
        {clock.order.map((sceneId) => (
          <option key={sceneId} value={`scene:${sceneId}`}>
            {clock.titleOf(sceneId)}
          </option>
        ))}
        <option value="end">End of the book</option>
      </select>
    </div>
  )
}

/** Runs a store action, toasting a failure. */
async function run(task: () => Promise<unknown>): Promise<void> {
  try {
    await task()
  } catch (err) {
    toast.error(describeError(err))
  }
}

/** The AI's mark on a value, or the author's for a line they dated. */
function OriginMark({ value }: { value: FactValueAt }): React.JSX.Element {
  return value.origin === 'ai' ? (
    <span
      data-testid="fact-ai-mark"
      title="Read from the scene by the AI"
      className="flex shrink-0 items-center gap-0.5 text-[11px] text-accent"
    >
      <Sparkles size={11} aria-hidden="true" />
      AI
    </span>
  ) : (
    <span className="shrink-0 text-[11px] text-fg-subtle">Yours</span>
  )
}

/** The scene a value holds from: the first source's title. */
function sceneLine(value: FactValueAt, clock: StoryClock): string {
  const first = value.sources[0]?.nodeId ?? null
  return first === null ? 'a deleted scene' : clock.titleOf(first)
}

/** One value on the sheet: mark, value, scene, passage jumps, status, and Hide (or Remove for the author's). */
function FactValueRow({
  entity,
  attribute,
  value,
  clock,
  later = false
}: {
  entity: Entity
  attribute: string
  value: FactValueAt
  clock: StoryClock
  later?: boolean
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const label = observedAttributeLabel(entity.kind, attribute)
  const act = async (task: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    await run(task)
    setBusy(false)
  }
  const removeAuthorLine = (): Promise<unknown> =>
    Promise.all(
      value.sources
        .filter((source) => source.origin === 'author' && source.nodeId !== null)
        .map((source) =>
          useEntityStore
            .getState()
            .update(entity.id, { fields: { [attribute]: '' }, asOf: source.nodeId })
        )
    )
  return (
    <li
      aria-label={`${label}: ${value.value}`}
      data-later={later ? 'true' : undefined}
      className={`flex flex-col gap-0.5 rounded-md border border-line px-2 py-1 ${later ? 'opacity-60' : ''}`}
    >
      <div className="flex items-baseline gap-2">
        <OriginMark value={value} />
        <span className="min-w-0 flex-1 text-sm wrap-anywhere">{value.value}</span>
        {value.status === 'canon' ? null : (
          <span className="shrink-0 rounded-full border border-line px-1.5 text-[11px] text-fg-muted">
            {FACT_STATUS_LABEL[value.status]}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-subtle">
          <span>
            From {sceneLine(value, clock)}
            {later ? ' (later)' : ''}
          </span>
          {value.sources.map((source) =>
            source.quote === null || source.nodeId === null ? null : (
              <button
                key={source.factId}
                type="button"
                aria-label={`Go to passage in ${clock.titleOf(source.nodeId)}`}
                title={source.quote}
                onClick={() => {
                  const nodeId = source.nodeId
                  const quote = source.quote
                  if (nodeId === null || quote === null) return
                  void openPassage(nodeId, (doc) => locateText(doc, quote))
                }}
                className={LINK_BUTTON}
              >
                Go to passage
              </button>
            )
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <select
            aria-label={`Status of ${label}: ${value.value}`}
            value={value.status}
            disabled={busy}
            onChange={(event) => {
              const status = FactStatus.safeParse(event.target.value)
              if (!status.success) return
              void act(() => useFactStore.getState().setStatus(value.factIds, status.data))
            }}
            className={CONTROL}
          >
            {FACT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {FACT_STATUS_LABEL[status]}
              </option>
            ))}
          </select>
          {value.origin === 'ai' ? (
            <button
              type="button"
              disabled={busy}
              title="Hide this for good; reading the scene again will not bring it back"
              onClick={() => void act(() => useFactStore.getState().setHidden(value.factIds, true))}
              className={BUTTON}
            >
              Hide
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(removeAuthorLine)}
              className={BUTTON}
            >
              Remove
            </button>
          )}
        </span>
      </div>
    </li>
  )
}

/**
 * What the scenes state about one field, under the author's text: the value as of the viewed
 * scene (replace) or the details so far (accumulate), then the history with "From scene…".
 * A field nothing is dated in shows only "From a scene…", and only once the author has filled
 * it; an empty one shows nothing.
 */
export function FieldFacts({
  entity,
  field,
  clock,
  showLabel = false
}: {
  entity: Entity
  field: SheetFieldAt
  clock: StoryClock
  showLabel?: boolean
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const label = observedAttributeLabel(entity.kind, field.attribute)
  const shown =
    field.mode === 'replace' ? (field.current === null ? [] : [field.current]) : field.details
  // A field with nothing dated: only one the author has filled offers to date a change (D4).
  if (field.history.length === 0) {
    return showLabel || field.baseline === null ? null : (
      <FromScene entity={entity} field={field} clock={clock} />
    )
  }
  return (
    <div className="flex flex-col gap-1">
      {showLabel ? <span className={LABEL}>{label}</span> : null}
      {shown.length === 0 ? (
        <p className="m-0 text-xs text-fg-subtle">Not stated yet at this point of the story.</p>
      ) : (
        <ul
          role="list"
          aria-label={`${label} from the scenes`}
          className="m-0 flex list-none flex-col gap-1 p-0"
        >
          {shown.map((value) => (
            <FactValueRow
              key={value.factIds[0]}
              entity={entity}
              attribute={field.attribute}
              value={value}
              clock={clock}
            />
          ))}
        </ul>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 self-start ${LINK_BUTTON}`}
      >
        <ChevronRight size={12} aria-hidden="true" className={open ? 'rotate-90' : undefined} />
        {`${label} history (${field.history.length})`}
      </button>
      {open ? (
        <div className="flex flex-col gap-1 pl-3">
          <ul
            role="list"
            aria-label={`${label} history`}
            className="m-0 flex list-none flex-col gap-1 p-0"
          >
            {field.history.map((value) => (
              <FactValueRow
                key={value.factIds[0]}
                entity={entity}
                attribute={field.attribute}
                value={value}
                clock={clock}
                later={value.later}
              />
            ))}
          </ul>
          <FromScene entity={entity} field={field} clock={clock} open />
        </div>
      ) : null}
    </div>
  )
}

/**
 * "From scene…" (D4): the author dates a value of their own at a scene. Collapsed to one link
 * under a field with no history; shown open inside a field's history.
 */
function FromScene({
  entity,
  field,
  clock,
  open = false
}: {
  entity: Entity
  field: SheetFieldAt
  clock: StoryClock
  open?: boolean
}): React.JSX.Element | null {
  const [editing, setEditing] = useState(open)
  const [sceneId, setSceneId] = useState(clock.nowId ?? clock.order[0] ?? '')
  const [text, setText] = useState('')
  const label = observedAttributeLabel(entity.kind, field.attribute)
  if (entity.template !== 'structured' || clock.order.length === 0) return null
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={`self-start ${LINK_BUTTON}`}
      >
        {`${label} from a scene…`}
      </button>
    )
  }
  const save = async (): Promise<void> => {
    const value = text.trim()
    if (value === '' || sceneId === '') return
    await run(() =>
      useEntityStore
        .getState()
        .update(entity.id, { fields: { [field.attribute]: value }, asOf: sceneId })
    )
    setText('')
  }
  return (
    <div
      role="group"
      aria-label={`${label} from a scene`}
      className="flex flex-wrap items-center gap-1.5"
    >
      <select
        aria-label="Scene"
        value={sceneId}
        onChange={(event) => setSceneId(event.target.value)}
        className={CONTROL}
      >
        {clock.order.map((id) => (
          <option key={id} value={id}>
            {clock.titleOf(id)}
          </option>
        ))}
      </select>
      <input
        aria-label={`${label} from that scene on`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className={`${CONTROL} min-w-0 flex-1`}
      />
      <button
        type="button"
        disabled={text.trim() === ''}
        onClick={() => void save()}
        className={BUTTON}
      >
        Add
      </button>
    </div>
  )
}

/** The hidden values of a record, each with Restore; nothing when none is hidden. */
export function HiddenFacts({
  entity,
  facts
}: {
  entity: Entity
  facts: readonly Fact[]
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  // F-9.14: relationships and thread events have their own blocks; only field facts list here.
  const hidden = facts.filter(
    (fact) => fact.hidden && fact.entityId === entity.id && isFieldFact(fact)
  )
  if (hidden.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 self-start ${LINK_BUTTON}`}
      >
        <ChevronRight size={12} aria-hidden="true" className={open ? 'rotate-90' : undefined} />
        Show hidden ({hidden.length})
      </button>
      {open ? (
        <ul role="list" aria-label="Hidden facts" className="m-0 flex list-none flex-col gap-1 p-0">
          {hidden.map((fact) => {
            const label = observedAttributeLabel(entity.kind, fact.attribute)
            return (
              <li
                key={fact.id}
                aria-label={`${label}: ${fact.value}`}
                className="flex items-baseline gap-2 text-fg-muted"
              >
                <span className={`shrink-0 ${LABEL}`}>{label}</span>
                <span className="min-w-0 flex-1 text-sm wrap-anywhere">{fact.value}</span>
                <button
                  type="button"
                  onClick={() =>
                    void run(() => useFactStore.getState().setHidden([fact.id], false))
                  }
                  className={BUTTON}
                >
                  Restore
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * The reference card's view (F-9.13): the first values the scenes state as of now, each with its
 * jump; "+ n more" past `FACTS_COMPACT`. Nothing until a scene has stated something.
 */
export function CompactFacts({ entity }: { entity: Entity }): React.JSX.Element | null {
  const facts = useRecordFacts(entity.id)
  const clock = useStoryClock()
  const fields = useSheetAt(entity, facts, { type: 'now' }, clock)
  const values = fields.flatMap((field) =>
    (field.mode === 'replace'
      ? field.current === null
        ? []
        : [field.current]
      : field.details
    ).map((value) => ({ attribute: field.attribute, value }))
  )
  if (values.length === 0) return null
  const shown = values.slice(0, FACTS_COMPACT)
  return (
    <section aria-label="From the scenes" className="flex flex-col gap-1">
      <h3 className={`m-0 font-normal ${LABEL}`}>From the scenes</h3>
      <ul role="list" aria-label="Facts" className="m-0 flex list-none flex-col gap-1 p-0">
        {shown.map(({ attribute, value }) => {
          const label = observedAttributeLabel(entity.kind, attribute)
          const found = value.sources.find((each) => each.quote !== null && each.nodeId !== null)
          const source =
            found?.nodeId == null || found.quote === null
              ? null
              : { nodeId: found.nodeId, quote: found.quote }
          return (
            <li
              key={value.factIds[0]}
              aria-label={`${label}: ${value.value}`}
              className="flex flex-col"
            >
              <span className="text-sm">
                <span className={LABEL}>{label}</span> {value.value}
              </span>
              {source === null ? null : (
                <button
                  type="button"
                  aria-label={`Go to passage in ${clock.titleOf(source.nodeId)}`}
                  title={source.quote}
                  onClick={() => {
                    void openPassage(source.nodeId, (doc) => locateText(doc, source.quote))
                  }}
                  className={`self-start ${LINK_BUTTON}`}
                >
                  {clock.titleOf(source.nodeId)}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {values.length > shown.length ? (
        <p className="m-0 text-xs text-fg-subtle">+ {values.length - shown.length} more</p>
      ) : null}
    </section>
  )
}
