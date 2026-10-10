import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ImagePlus, Pin, Trash2, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import {
  ENTITY_BODY_MAX,
  ENTITY_FIELD_MAX,
  ENTITY_NAME_MAX,
  ENTITY_TEMPLATES,
  WORLD_CATEGORY_SUGGESTIONS,
  entityImageUrl,
  type EntityFields,
  type EntityTemplate
} from '@shared/entities'
import { categoryOf } from '@shared/categories'
import { sheetFieldDefs } from '@shared/sheetSync'
import {
  FACT_STATUSES,
  FACT_STATUS_LABEL,
  FactStatus,
  sheetAt,
  type SheetFieldAt
} from '@shared/facts'
import type { Entity } from '@shared/ipc/contract'
import { useCategoryStore } from './categoryStore'
import { parseYear } from '@shared/timeline'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useReferenceStore } from '@renderer/features/references/referenceStore'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { AliasEditor } from '@renderer/features/tags/AliasEditor'
import { useMentionStore } from '@renderer/features/tags/mentionStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { sceneRowsForTag } from '@renderer/features/tags/tagUsage'
import { useTimelineStore } from '@renderer/features/timeline/timelineStore'
import { agesOnTimeline, ageText } from '@renderer/features/timeline/timelineView'
import { describeError } from '@renderer/lib/errors'
import { AsOfPicker, FieldFacts, HiddenFacts } from './SheetFacts'
import { SceneRowButton } from './SceneRowButton'
import { SheetSyncBar } from './SheetSyncBar'
import { UsageLog } from './UsageLog'
import { Relationships } from './Relationships'
import { ThreadEvents } from '@renderer/features/threads/ThreadEvents'
import { THREAD_KIND } from '@shared/threads'
import { useEntityDraftStore } from './entityDraftStore'
import { useEntityStore } from './entityStore'
import { ENTITY_TEMPLATE_LABEL, inScenesLabel } from './entityView'
import { positionOf, useRecordFacts, useStoryClock, type AsOf } from './factView'
import { useEntityUsage } from './useEntityUsage'

const CONTROL = 'w-full rounded-md border border-line bg-bg px-2 py-1.5 text-sm'
const LABEL = 'text-xs font-medium text-fg-muted'
const BUTTON =
  'rounded-md border border-line px-2.5 py-1 text-xs hover:bg-surface-raised disabled:opacity-60 disabled:hover:bg-transparent'

/** The first letter upper-cased ("character" → "Character"), for a noun that starts a line. */
const capitalize = (word: string): string => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`

/**
 * The entity page (F-9.3): the whole main pane while `entityStore.selectedId` is set, in place of
 * the manuscript editor. The name, the template toggle, the image (characters and settings), and
 * then either the kind's structured fields or one blank page. There is no Save button: every
 * keystroke goes into `entityDraftStore`, which writes it after a short debounce and says so in
 * the status line at the foot. Closing the page returns to the document that is still selected in
 * the tree. An entity deleted from its tab while open takes the page down with it.
 */
export function EntityEditor({ id }: { id: string }): React.JSX.Element | null {
  const entity = useEntityStore((s) => s.byId[id])
  const categories = useCategoryStore((s) => s.categories)
  const draft = useEntityDraftStore((s) => (s.draft?.id === id ? s.draft : null))
  const status = useEntityDraftStore((s) => s.status)
  const edit = useEntityDraftStore((s) => s.edit)
  // F-9.6: whether this entity has a card in the quick reference panel.
  const pinned = useReferenceStore((s) => s.pins.some((p) => p.type === 'entity' && p.id === id))
  const [busy, setBusy] = useState(false)
  const uid = useId()
  const missing = entity === undefined
  // F-9.13: the record's dated facts, read as of the scene the author picks (D3: now by default).
  const [asOf, setAsOf] = useState<AsOf>({ type: 'now' })
  const facts = useRecordFacts(id)
  const clock = useStoryClock()

  useEffect(() => {
    const row = useEntityStore.getState().byId[id]
    if (row) useEntityDraftStore.getState().open(row)
    return () => {
      useEntityDraftStore.getState().close()
    }
  }, [id])

  // Deleted from its tab while the page was open: there is nothing left to edit.
  useEffect(() => {
    if (missing) useEntityStore.getState().select(null)
  }, [missing])

  // F-9.18: the sheet sync (or an Undo) rewrote a view in main: the page shows it, unless the
  // author has an edit of their own still to save.
  useEffect(() => {
    if (entity) useEntityDraftStore.getState().adopt(entity)
  }, [entity])

  if (!entity) return null
  const category = categoryOf(entity.kind, categories)
  // F-9.18: the category's fields, then the sheet's own.
  const fieldDefs = sheetFieldDefs(category, entity.extraFields)
  const ownIds = new Set(entity.extraFields.map((field) => field.id))
  const sheet = sheetAt({
    facts,
    fields: entity.template === 'structured' ? entity.fields : {},
    attributes: fieldDefs.map((field) => field.id),
    order: clock.order,
    position: positionOf(asOf, clock)
  })
  const factsOf = (attribute: string): SheetFieldAt | undefined =>
    sheet.find((field) => field.attribute === attribute)
  const templateIds = new Set<string>(fieldDefs.map((field) => field.id))
  // Attributes only the scenes carry (a sheet moved to another category), and, on a blank page,
  // every attribute: shown with their label below the page.
  const loose = sheet.filter(
    (field) =>
      field.history.length > 0 && (entity.template === 'blank' || !templateIds.has(field.attribute))
  )
  const dated = facts.some((fact) => !fact.hidden)

  // Until the draft opens (the first paint, before the effect) the stored row is what is shown.
  const values = draft ?? {
    name: entity.name,
    fields: entity.fields,
    body: entity.body ?? ''
  }

  const run = async (task: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await task()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  /** The template is a column of its own, so the pending edits are written before it changes. */
  const switchTemplate = async (template: EntityTemplate): Promise<void> => {
    if (template === entity.template) return
    await useEntityDraftStore.getState().flush()
    await run(() => useEntityStore.getState().update(id, { template }))
  }

  const removeImage = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: `Remove the image of "${entity.name}"?`,
      message: 'This deletes the image file from the project folder. This cannot be undone.',
      confirmLabel: 'Remove',
      danger: true
    })
    if (!ok) return
    await run(() => useEntityStore.getState().removeImage(id))
  }

  const editField = (field: keyof EntityFields, value: string): void => {
    const fields: EntityFields = { [field]: value }
    edit({ fields })
  }

  /** F-9.18: a field of this sheet's own; the page has it at the next write-up. */
  const addField = async (): Promise<void> => {
    const label = await dialogs.prompt({
      title: 'Add a field to this sheet',
      message: `Only "${entity.name}" gets it; the ${category.noun} template stays as it is.`,
      confirmLabel: 'Add field',
      validate: (value) => (value.trim() === '' ? 'A field needs a name.' : null)
    })
    if (label === null) return
    await useEntityDraftStore.getState().flush()
    await run(() => useEntityStore.getState().addField(id, label.trim()))
  }

  /** F-9.18: removes a field of this sheet's own; its text moves into Notes. */
  const removeField = async (fieldId: string, label: string): Promise<void> => {
    await useEntityDraftStore.getState().flush()
    await run(() => useEntityStore.getState().removeField(id, fieldId))
    toast.success(`Removed "${label}"; its text is in Notes.`)
  }

  return (
    <article
      aria-label={entity.name}
      data-testid="entity-editor"
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <input
              aria-label="Name"
              value={values.name}
              maxLength={ENTITY_NAME_MAX}
              onChange={(event) => edit({ name: event.target.value })}
              className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-2xl font-semibold hover:border-line focus:border-line focus:outline-none"
            />
            <p className="m-0 px-1 text-sm text-fg-muted">
              {capitalize(category.noun)} · {ENTITY_TEMPLATE_LABEL[entity.template]}
              {entity.origin === 'ai' ? ' · Added by AI' : ''}
            </p>
          </div>
          <div role="group" aria-label="Template" className="flex shrink-0 gap-0.5">
            {ENTITY_TEMPLATES.map((template) => (
              <button
                key={template}
                type="button"
                aria-pressed={template === entity.template}
                disabled={busy}
                onClick={() => void switchTemplate(template)}
                className="rounded-md border border-line px-2 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:bg-surface-raised aria-pressed:text-fg disabled:opacity-60"
              >
                {ENTITY_TEMPLATE_LABEL[template]}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label={pinned ? 'Unpin from References' : 'Pin to References'}
            title={pinned ? 'Unpin from References' : 'Pin to References'}
            aria-pressed={pinned}
            onClick={() => {
              const references = useReferenceStore.getState()
              void (pinned
                ? references.unpin({ type: 'entity', id })
                : references.pin({ type: 'entity', id }))
            }}
            className="shrink-0 rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:bg-surface-raised aria-pressed:text-accent"
          >
            <Pin size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={`Close ${entity.name}`}
            title="Close"
            onClick={() => useEntityStore.getState().select(null)}
            className="shrink-0 rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {category.hasImage ? (
          <div className="flex items-start gap-3">
            {entity.image === null ? (
              <span
                aria-hidden="true"
                className="flex size-40 shrink-0 items-center justify-center rounded-md border border-dashed border-line bg-bg text-fg-subtle"
              >
                <ImagePlus size={24} />
              </span>
            ) : (
              <img
                alt=""
                src={entityImageUrl(entity.image)}
                className="size-40 shrink-0 rounded-md border border-line object-cover"
              />
            )}
            <div className="flex flex-col items-start gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => useEntityStore.getState().setImage(id))}
                className={BUTTON}
              >
                {entity.image === null ? 'Add image…' : 'Replace image…'}
              </button>
              {entity.image === null ? null : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void removeImage()}
                  className={`${BUTTON} flex items-center gap-1.5 hover:text-danger`}
                >
                  <Trash2 size={12} aria-hidden="true" />
                  Remove image
                </button>
              )}
            </div>
          </div>
        ) : null}

        <EntityTagBlock entity={entity} />
        <AliasEditor
          name={entity.name}
          aliases={entity.aliases}
          onChange={(aliases) => useEntityStore.getState().update(id, { aliases })}
        />

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className={LABEL}>
              Status
            </span>
            <select
              aria-label="Status"
              title="Canon is the story as written; a plan is intent; an idea is a maybe"
              value={entity.status}
              disabled={busy}
              onChange={(event) => {
                const next = FactStatus.safeParse(event.target.value)
                if (next.success)
                  void run(() => useEntityStore.getState().update(id, { status: next.data }))
              }}
              className="shrink-0 rounded-md border border-line bg-bg px-1.5 py-1 text-xs text-fg-muted"
            >
              {FACT_STATUSES.map((each) => (
                <option key={each} value={each}>
                  {FACT_STATUS_LABEL[each]}
                </option>
              ))}
            </select>
          </div>
          {dated ? <AsOfPicker value={asOf} onChange={setAsOf} clock={clock} /> : null}
        </div>

        {loose.length === 0 ? null : (
          <section aria-label="From the scenes" className="flex flex-col gap-2">
            <h3 className={`m-0 font-normal ${LABEL}`}>From the scenes</h3>
            {loose.map((field) => (
              <FieldFacts
                key={field.attribute}
                entity={entity}
                field={field}
                clock={clock}
                showLabel
              />
            ))}
          </section>
        )}

        {/* F-9.18: how this view stands against the other one. */}
        <SheetSyncBar entity={entity} view={entity.template} />

        {entity.template === 'structured' ? (
          <div className="flex flex-col gap-3">
            {fieldDefs.map((field) => {
              const stated = factsOf(field.id)
              const controlId = `${uid}-${field.id}`
              const value = values.fields[field.id] ?? ''
              return (
                <div key={field.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <label htmlFor={controlId} className={LABEL}>
                      {field.label}
                    </label>
                    {ownIds.has(field.id) ? (
                      <>
                        <span className="text-xs text-fg-subtle">· this sheet only</span>
                        <button
                          type="button"
                          aria-label={`Remove the field ${field.label}`}
                          title="Remove this field (its text moves into Notes)"
                          disabled={busy}
                          onClick={() => void removeField(field.id, field.label)}
                          className="rounded p-0.5 text-fg-subtle hover:bg-surface-raised hover:text-danger"
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </>
                    ) : null}
                  </div>
                  {field.multiline ? (
                    <AutoTextarea
                      id={controlId}
                      value={value}
                      onValue={(next) => editField(field.id, next)}
                    />
                  ) : (
                    <input
                      id={controlId}
                      value={value}
                      maxLength={ENTITY_FIELD_MAX}
                      list={field.id === 'category' ? `${uid}-categories` : undefined}
                      onChange={(event) => editField(field.id, event.target.value)}
                      className={CONTROL}
                    />
                  )}
                  {stated === undefined ? null : (
                    <FieldFacts entity={entity} field={stated} clock={clock} />
                  )}
                </div>
              )
            })}
            <div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void addField()}
                className={BUTTON}
              >
                Add a field to this sheet…
              </button>
            </div>
            {entity.kind === 'world' ? (
              <datalist id={`${uid}-categories`}>
                {WORLD_CATEGORY_SUGGESTIONS.map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
            ) : null}
          </div>
        ) : (
          <textarea
            aria-label="Page"
            value={values.body}
            maxLength={ENTITY_BODY_MAX}
            onChange={(event) => edit({ body: event.target.value })}
            className={`${CONTROL} min-h-[60vh] resize-none font-prose text-base leading-relaxed`}
          />
        )}

        {entity.kind === 'character' && entity.template === 'structured' ? (
          <AgeOnTimeline born={values.fields.born ?? ''} />
        ) : null}

        {entity.kind === 'character' || entity.kind === 'setting' ? (
          <UsageLog entity={entity} />
        ) : null}

        {/* F-9.14: a thread's events, or any other sheet's relationships, as of the viewed scene. */}
        {entity.kind === THREAD_KIND ? (
          <ThreadEvents entity={entity} facts={facts} clock={clock} />
        ) : (
          <Relationships
            entity={entity}
            facts={facts}
            position={positionOf(asOf, clock)}
            clock={clock}
          />
        )}

        <HiddenFacts entity={entity} facts={facts} />

        {entity.kind === 'world' ? <EntityScenes entity={entity} /> : null}

        <p role="status" className="m-0 h-4 text-xs text-fg-subtle">
          {draft === null || status === 'idle' || status === 'dirty'
            ? ''
            : status === 'saving'
              ? 'Saving…'
              : 'Saved'}
        </p>
      </div>
    </article>
  )
}

/**
 * A character's age at every timeline event with a year (F-11.2b), from the Born field as typed
 * (the draft, so it follows the keystrokes), in story order. Nothing while Born is blank; a hint
 * while it is not a whole number ("Year 1170" is not), since the age needs one.
 */
function AgeOnTimeline({ born }: { born: string }): React.JSX.Element | null {
  const events = useTimelineStore((s) => s.events)
  const year = parseYear(born)
  if (year === null) return null
  if (year === 'invalid') {
    return (
      <p className="m-0 text-xs text-fg-muted">
        Use a whole number to track age (1170, not "Year 1170").
      </p>
    )
  }
  const rows = agesOnTimeline(events, year)
  return (
    <section aria-label="Age on the timeline" className="flex flex-col gap-1">
      <h3 className={`m-0 font-normal ${LABEL}`}>Age on the timeline</h3>
      {rows.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">No timeline event has a year yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {rows.map((row) => (
            <li key={row.event.id} className="flex items-baseline gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{row.event.label}</span>
              {row.event.when ? (
                <span className="shrink-0 text-xs text-fg-subtle">{row.event.when}</span>
              ) : null}
              <span className="shrink-0 text-xs text-fg-subtle">Year {row.year}</span>
              <span className="shrink-0 text-xs text-fg-muted">
                {row.age < 0 ? ageText(row.age) : `age ${row.age}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * The entity's tag (F-9.4): the chip of the tag it was created with, and the way to the Tag
 * Manager for everything about it (colour, category, mentions, delete). An entity from before
 * F-9.4, or one whose tag the author deleted, has none and is offered one here; a name with no
 * letters or digits in it is refused by main and toasted.
 */
function EntityTagBlock({ entity }: { entity: Entity }): React.JSX.Element {
  const tagId = entity.tagId
  const tag = useTagStore(useShallow((s) => (tagId === null ? undefined : s.byId[tagId])))
  const [busy, setBusy] = useState(false)

  const openInTagManager = (): void => {
    if (!tag) return
    const layout = useLayoutStore.getState()
    if (!layout.layout.sidebar.open) layout.toggle('sidebar')
    layout.setSidebarTab('tags')
    useTagStore.getState().requestSelection(tag.id)
  }

  const createTag = async (): Promise<void> => {
    setBusy(true)
    try {
      await useEntityStore.getState().linkTag(entity.id)
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="group" aria-label="Tag" className="flex flex-wrap items-center gap-2">
      {tag ? (
        <>
          <span className="flex items-center gap-1.5 rounded-full border border-line bg-surface-raised px-2 py-0.5 text-xs">
            <span
              aria-hidden="true"
              style={{ backgroundColor: tag.color }}
              className="size-2.5 shrink-0 rounded-full"
            />
            <span className="max-w-48 truncate">#{tag.name}</span>
          </span>
          <button type="button" onClick={openInTagManager} className={BUTTON}>
            Open in Tag Manager
          </button>
        </>
      ) : (
        <>
          <span className="text-xs text-fg-muted">No tag yet.</span>
          <button type="button" disabled={busy} onClick={() => void createTag()} className={BUTTON}>
            Create tag
          </button>
        </>
      )}
    </div>
  )
}

/**
 * Where a world item appears (F-9.4): every document its tag is linked to (F-4.4) or its name
 * occurs in (F-4.12), in tree order. Characters and settings show the appearance log instead
 * (F-11.2c `UsageLog`), which lists the same rows plus the POV and the scenes set there.
 */
function EntityScenes({ entity }: { entity: Entity }): React.JSX.Element {
  const tagId = entity.tagId
  const tag = useTagStore(useShallow((s) => (tagId === null ? undefined : s.byId[tagId])))
  const byId = useTreeStore((s) => s.byId)
  const index = useTreeStore(useShallow((s) => ({ rootIds: s.rootIds, childrenOf: s.childrenOf })))
  const tagIdsByNode = useDocumentTagStore((s) => s.tagIdsByNode)
  const mentions = useMentionStore((s) => (tagId === null ? undefined : s.byTag[tagId]))
  useEntityUsage(tagId)

  const rows = useMemo(
    () => (tagId === null ? [] : sceneRowsForTag(index, byId, tagIdsByNode, mentions, tagId)),
    [index, byId, tagIdsByNode, mentions, tagId]
  )

  return (
    <section className="flex flex-col gap-1">
      <h3 className={`m-0 font-normal ${LABEL}`}>Scenes</h3>
      {tag === undefined ? (
        <p className="m-0 text-xs text-fg-muted">
          Create the tag to see where {entity.name} appears.
        </p>
      ) : (
        <>
          <p className="m-0 text-xs text-fg-muted">{inScenesLabel(rows.length)}</p>
          {rows.length === 0 ? null : (
            <ul role="list" aria-label={`Scenes with ${entity.name}`} className="m-0 list-none p-0">
              {rows.map((row) => (
                <li key={row.id}>
                  <SceneRowButton row={row} tagName={tag.name} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

/**
 * A field textarea that grows with its text instead of scrolling inside a fixed box, so a long
 * background reads as one page. The height is measured, not styled, so it follows the author's
 * interface size (F-7.10); the class floor keeps it usable before the first measurement.
 */
function AutoTextarea({
  id,
  value,
  onValue
}: {
  id: string
  value: string
  onValue: (value: string) => void
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      id={id}
      rows={2}
      value={value}
      maxLength={ENTITY_FIELD_MAX}
      onChange={(event) => onValue(event.target.value)}
      className={`${CONTROL} min-h-16 resize-none overflow-hidden leading-relaxed`}
    />
  )
}
