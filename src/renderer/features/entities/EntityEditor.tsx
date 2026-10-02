import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ImagePlus, Pin, Tag as TagIcon, Trash2, X } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import {
  ENTITY_BODY_MAX,
  ENTITY_FIELDS,
  ENTITY_FIELD_MAX,
  ENTITY_KIND_NOUN,
  ENTITY_NAME_MAX,
  ENTITY_TEMPLATES,
  WORLD_CATEGORY_SUGGESTIONS,
  entityImageUrl,
  kindHasImage,
  type EntityFields,
  type EntityTemplate
} from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import { openMention } from '@renderer/features/editor/openPassage'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useReferenceStore } from '@renderer/features/references/referenceStore'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useMentionStore } from '@renderer/features/tags/mentionStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { sceneRowsForTag } from '@renderer/features/tags/tagUsage'
import { describeError } from '@renderer/lib/errors'
import { ObservedFacts } from './ObservedFacts'
import { useEntityDraftStore } from './entityDraftStore'
import { useEntityStore } from './entityStore'
import { ENTITY_TEMPLATE_LABEL } from './entityView'

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
  const draft = useEntityDraftStore((s) => (s.draft?.id === id ? s.draft : null))
  const status = useEntityDraftStore((s) => s.status)
  const edit = useEntityDraftStore((s) => s.edit)
  // F-9.6: whether this entity has a card in the quick reference panel.
  const pinned = useReferenceStore((s) => s.pins.some((p) => p.type === 'entity' && p.id === id))
  const [busy, setBusy] = useState(false)
  const uid = useId()
  const missing = entity === undefined

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

  if (!entity) return null

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
              {capitalize(ENTITY_KIND_NOUN[entity.kind])} · {ENTITY_TEMPLATE_LABEL[entity.template]}
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

        {kindHasImage(entity.kind) ? (
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

        {entity.template === 'structured' ? (
          <div className="flex flex-col gap-3">
            {ENTITY_FIELDS[entity.kind].map((field) => {
              const controlId = `${uid}-${field.id}`
              const value = values.fields[field.id] ?? ''
              return (
                <div key={field.id} className="flex flex-col gap-1">
                  <label htmlFor={controlId} className={LABEL}>
                    {field.label}
                  </label>
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
                </div>
              )
            })}
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
            className={`${CONTROL} min-h-[60vh] resize-none leading-relaxed`}
          />
        )}

        <ObservedFacts entity={entity} />

        <EntityScenes entity={entity} />

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

/** "In 3 scenes" / "In 1 scene" / "Not in any scene yet" (F-9.4). */
function inScenesLabel(count: number): string {
  if (count === 0) return 'Not in any scene yet'
  return count === 1 ? 'In 1 scene' : `In ${count} scenes`
}

/**
 * Where the entity appears (F-9.4): every document its tag is linked to (F-4.4) or its name
 * occurs in (F-4.12), in tree order. A row that carries a mention jumps to the first occurrence;
 * one that is only tagged selects the document, which closes this page (F-9.3). The lists are
 * asked for when the page opens and refreshed by main's own events, so a scan that lands while
 * the page is open shows up without a reload.
 */
function EntityScenes({ entity }: { entity: Entity }): React.JSX.Element {
  const tagId = entity.tagId
  const tag = useTagStore(useShallow((s) => (tagId === null ? undefined : s.byId[tagId])))
  const byId = useTreeStore((s) => s.byId)
  const index = useTreeStore(useShallow((s) => ({ rootIds: s.rootIds, childrenOf: s.childrenOf })))
  const tagIdsByNode = useDocumentTagStore((s) => s.tagIdsByNode)
  const mentions = useMentionStore((s) => (tagId === null ? undefined : s.byTag[tagId]))

  useEffect(() => {
    if (tagId === null) return
    const report = (err: unknown): void => {
      toast.error(describeError(err))
    }
    useDocumentTagStore.getState().loadAll().catch(report)
    useMentionStore.getState().loadForTag(tagId).catch(report)
  }, [tagId])

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
                  <button
                    type="button"
                    onClick={() => {
                      if (row.first !== null) void openMention(row.id, row.first, tag.name)
                      else useTreeStore.getState().select(row.id)
                    }}
                    className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
                  >
                    <span className="min-w-0 flex-1 truncate">{row.title}</span>
                    {row.parentTitle === null ? null : (
                      <span className="shrink-0 truncate text-xs text-fg-subtle">
                        {row.parentTitle}
                      </span>
                    )}
                    {row.tagged ? (
                      <span title="Tagged" className="shrink-0 text-fg-subtle">
                        <TagIcon size={12} aria-hidden="true" />
                        <span className="sr-only">Tagged</span>
                      </span>
                    ) : null}
                    {row.mentionCount === 0 ? null : (
                      <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
                        ×{row.mentionCount}
                      </span>
                    )}
                  </button>
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
