import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ImagePlus, Trash2, X } from 'lucide-react'
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
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
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
