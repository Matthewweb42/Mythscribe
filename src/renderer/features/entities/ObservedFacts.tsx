import { useEffect, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { Entity } from '@shared/ipc/contract'
import {
  groupFacts,
  observedAttributeLabel,
  type FactGroup,
  type ObservedFact
} from '@shared/observedFacts'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useEntityDraftStore } from './entityDraftStore'
import { useEntityStore } from './entityStore'
import { useObservedFactStore } from './observedFactStore'
import {
  OBSERVED_FACTS_COMPACT,
  isOnSheet,
  readingOrder,
  sheetTarget,
  sheetTextAt,
  withFactAdded,
  type SheetText
} from './observedFactView'

const LABEL = 'text-xs font-medium text-fg-muted'
const BUTTON =
  'rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-raised disabled:opacity-60 disabled:hover:bg-transparent'
const LINK_BUTTON = 'text-xs text-fg-muted underline hover:text-fg'

/** Stable empty list, so a selector for an entity not yet read does not re-render on every store change. */
const NO_FACTS: readonly ObservedFact[] = []

/** The row's name for assistive technology and the tests: "Age: 34". */
const rowName = (entity: Pick<Entity, 'kind'>, group: FactGroup): string =>
  `${observedAttributeLabel(entity.kind, group.attribute)}: ${group.value}`

/**
 * "From the manuscript" (F-5.16): what the AI read about this entity in the author's scenes,
 * kept apart from the author's own sheet. One row per attribute and value, with every scene that
 * states it; two values of one attribute are both shown in reading order and marked `Differs`.
 * `Go to passage` opens the scene with the quoted words selected, `Add to sheet` copies the value
 * into the author's page, and `Hide` puts a wrong row away for good (it can be restored from the
 * hidden list). The compact form is the reference card's: the first rows and their passages only.
 * Nothing is rendered until the entity has facts.
 */
export function ObservedFacts({
  entity,
  compact = false
}: {
  entity: Entity
  compact?: boolean
}): React.JSX.Element | null {
  const facts = useObservedFactStore((s) => s.byEntity[entity.id] ?? NO_FACTS)
  const titles = useTreeStore((s) => s.byId)
  const index = useTreeStore(
    useShallow((s) => ({ byId: s.byId, childrenOf: s.childrenOf, rootIds: s.rootIds }))
  )
  const draft = useEntityDraftStore((s) => (s.draft?.id === entity.id ? s.draft : null))
  const [busy, setBusy] = useState(false)
  const [showHidden, setShowHidden] = useState(false)

  useEffect(() => {
    useObservedFactStore
      .getState()
      .load(entity.id)
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [entity.id])

  const order = useMemo(() => readingOrder(index), [index])
  const groups = useMemo(() => groupFacts(facts, order), [facts, order])
  // The hidden rows merge the same way the visible ones do, so one Restore brings a whole row back.
  const hiddenGroups = useMemo(
    () =>
      groupFacts(
        facts.filter((fact) => fact.hidden).map((fact) => ({ ...fact, hidden: false })),
        order
      ),
    [facts, order]
  )

  if (groups.length === 0 && (compact || hiddenGroups.length === 0)) return null

  // What the page shows right now: the draft while the author is typing, else the stored row.
  const sheet: SheetText =
    draft === null
      ? { fields: entity.fields, body: entity.body ?? '' }
      : { fields: draft.fields, body: draft.body }

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await task()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  /**
   * An author edit like any other: while the page's draft is open it goes through the draft (so
   * the field shows it and the next autosave does not write the old text back), else straight
   * through the entity store.
   */
  const addToSheet = async (group: FactGroup): Promise<void> => {
    const target = sheetTarget(entity, group.attribute)
    if (target === null) return
    const drafts = useEntityDraftStore.getState()
    const open = drafts.draft?.id === entity.id ? drafts.draft : null
    const stored = useEntityStore.getState().byId[entity.id] ?? entity
    const current: SheetText =
      open === null
        ? { fields: stored.fields, body: stored.body ?? '' }
        : { fields: open.fields, body: open.body }
    const next = withFactAdded(entity, current, target, group.attribute, group.value)
    if (next === null) {
      toast.error('There is no room left on the sheet for this.')
      return
    }
    const patch = target.type === 'body' ? { body: next } : { fields: { [target.field]: next } }
    if (open === null) {
      await useEntityStore.getState().update(entity.id, patch)
      return
    }
    drafts.edit(patch)
    await drafts.flush() // reports its own failure and keeps the draft
  }

  const setHidden = (group: FactGroup, hidden: boolean): Promise<void> =>
    run(() => useObservedFactStore.getState().setHidden(group.factIds, hidden))

  const sources = (group: FactGroup): React.JSX.Element => (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      {group.sources.map((source) => {
        const title = titles[source.nodeId]?.title ?? 'the scene'
        return (
          <button
            key={source.factId}
            type="button"
            aria-label={`Go to passage in ${title}`}
            title={source.quote}
            onClick={() => void openPassage(source.nodeId, (doc) => locateText(doc, source.quote))}
            className={LINK_BUTTON}
          >
            {title}
          </button>
        )
      })}
    </span>
  )

  const differs = (
    <span className="shrink-0 rounded-full border border-warning px-1.5 text-[11px] text-warning">
      Differs
    </span>
  )

  const shown = compact ? groups.slice(0, OBSERVED_FACTS_COMPACT) : groups
  const more = groups.length - shown.length

  return (
    <section
      aria-label="From the manuscript"
      data-testid="observed-facts"
      className="flex flex-col gap-1.5"
    >
      <div>
        <h3 className={`m-0 font-normal ${LABEL}`}>From the manuscript</h3>
        {compact ? null : (
          <p className="m-0 text-xs text-fg-subtle">
            Read from your scenes by the AI. Kept apart from your sheet until you add it.
          </p>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">Every row is hidden.</p>
      ) : (
        <ul
          role="list"
          aria-label="Observed facts"
          className="m-0 flex list-none flex-col gap-1.5 p-0"
        >
          {shown.map((group) => {
            const target = compact ? null : sheetTarget(entity, group.attribute)
            const onSheet = target !== null && isOnSheet(sheetTextAt(sheet, target), group.value)
            return (
              <li
                key={group.factIds[0]}
                aria-label={rowName(entity, group)}
                className={
                  compact
                    ? 'flex flex-col gap-0.5'
                    : 'flex flex-col gap-1 rounded-md border border-line p-2'
                }
              >
                <div className="flex items-baseline gap-2">
                  <span className={`shrink-0 ${LABEL}`}>
                    {observedAttributeLabel(entity.kind, group.attribute)}
                  </span>
                  <span className="min-w-0 flex-1 text-sm wrap-anywhere">{group.value}</span>
                  {group.differs ? differs : null}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {sources(group)}
                  {compact ? null : (
                    <span className="flex shrink-0 items-center gap-1.5">
                      {target === null ? null : onSheet ? (
                        <span className="text-xs text-fg-subtle">On sheet</span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(() => addToSheet(group))}
                          className={BUTTON}
                        >
                          Add to sheet
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        title="Hide this for good; reading the scene again will not bring it back"
                        onClick={() => void setHidden(group, true)}
                        className={BUTTON}
                      >
                        Hide
                      </button>
                    </span>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {more > 0 ? <p className="m-0 text-xs text-fg-subtle">+ {more} more</p> : null}
      {compact || hiddenGroups.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            aria-expanded={showHidden}
            onClick={() => setShowHidden(!showHidden)}
            className={`flex items-center gap-1 self-start ${LINK_BUTTON}`}
          >
            <ChevronRight
              size={12}
              aria-hidden="true"
              className={showHidden ? 'rotate-90' : undefined}
            />
            Show hidden ({hiddenGroups.length})
          </button>
          {showHidden ? (
            <ul
              role="list"
              aria-label="Hidden facts"
              className="m-0 flex list-none flex-col gap-1 p-0"
            >
              {hiddenGroups.map((group) => (
                <li
                  key={group.factIds[0]}
                  aria-label={rowName(entity, group)}
                  className="flex items-baseline gap-2 text-fg-muted"
                >
                  <span className={`shrink-0 ${LABEL}`}>
                    {observedAttributeLabel(entity.kind, group.attribute)}
                  </span>
                  <span className="min-w-0 flex-1 text-sm wrap-anywhere">{group.value}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setHidden(group, false)}
                    className={BUTTON}
                  >
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </section>
  )
}
