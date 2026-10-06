import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { X } from 'lucide-react'
import { TAG_CATEGORY_LABEL } from '@shared/tags'
import type { CustomTagTemplate } from '@shared/tagTemplates'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useCustomTemplateStore } from './customTemplateStore'
import { tagsLabel } from './loadSummary'
import { promptTemplateName } from './templateName'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'

/**
 * The tag template manager (F-4.11): the author's saved templates, each with Rename…, Edit tags
 * (remove tags one at a time; saving again from a bank is how tags are added), and Delete after a
 * confirmation. Removing a template's last tag is refused: delete the template instead. Escape,
 * the close button, and a click on the backdrop close it.
 */
export function TagTemplatesDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  const templates = useCustomTemplateStore((s) => s.templates)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeButton.current?.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  const onBackdropMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }

  const run = async (task: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await task()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const rename = (template: CustomTagTemplate): Promise<void> =>
    run(async () => {
      const name = await promptTemplateName(template.name, `Rename "${template.name}"`)
      if (name === null || name.trim() === template.name) return
      await useCustomTemplateStore.getState().rename(template.id, name.trim())
    })

  const removeTag = (template: CustomTagTemplate, tagName: string): Promise<void> =>
    run(async () => {
      const keep = template.tags.map((tag) => tag.name).filter((name) => name !== tagName)
      await useCustomTemplateStore.getState().keepTags(template.id, keep)
    })

  const remove = (template: CustomTagTemplate): Promise<void> =>
    run(async () => {
      const ok = await dialogs.confirm({
        title: `Delete "${template.name}"?`,
        message: 'Tags already loaded from it stay in their projects.',
        confirmLabel: 'Delete',
        danger: true
      })
      if (!ok) return
      await useCustomTemplateStore.getState().remove(template.id)
      if (editing === template.id) setEditing(null)
    })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={onBackdropMouseDown}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="flex max-h-[85vh] w-[520px] max-w-[90vw] flex-col rounded-lg border border-line bg-surface-raised shadow-panel"
      >
        <div className="flex items-center justify-between gap-2 px-5 pt-4">
          <h2 id={titleId} className="m-0 text-base font-semibold">
            Tag templates
          </h2>
          <button
            ref={closeButton}
            type="button"
            aria-label="Close tag templates"
            title="Close"
            onClick={onClose}
            className="-mr-1.5 rounded-md p-1.5 text-fg-muted hover:bg-surface hover:text-fg"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="mx-5 mt-1 mb-0 text-xs text-fg-muted">
          Saved for every project. To add tags, save a bank again under a new name.
        </p>
        {templates.length === 0 ? (
          <p className="m-5 text-sm text-fg-muted">No saved templates.</p>
        ) : (
          <ul
            role="list"
            aria-label="Saved templates"
            className="m-0 list-none overflow-y-auto p-5"
          >
            {templates.map((template) => (
              <li
                key={template.id}
                aria-label={template.name}
                className="flex flex-col gap-1.5 border-b border-line py-2 last:border-b-0"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-auto min-w-0 truncate text-sm font-medium">
                    {template.name}
                    <span className="ml-1.5 text-xs font-normal text-fg-muted">
                      {tagsLabel(template.tags.length)}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void rename(template)}
                    disabled={busy}
                    className={BUTTON}
                  >
                    Rename…
                  </button>
                  <button
                    type="button"
                    aria-expanded={editing === template.id}
                    onClick={() => setEditing(editing === template.id ? null : template.id)}
                    className={BUTTON}
                  >
                    Edit tags
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(template)}
                    disabled={busy}
                    className="shrink-0 rounded-md border border-danger px-2 py-1 text-xs text-danger hover:bg-danger hover:text-danger-fg disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
                {editing === template.id ? (
                  <ul
                    role="list"
                    aria-label={`Tags in ${template.name}`}
                    className="m-0 flex list-none flex-wrap gap-1 p-0"
                  >
                    {template.tags.map((tag) => (
                      <li
                        key={tag.name}
                        className="flex items-center gap-1 rounded-full border border-line py-0.5 pr-1 pl-2 text-xs"
                        title={TAG_CATEGORY_LABEL[tag.category]}
                      >
                        <span
                          aria-hidden="true"
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: tag.color }}
                        />
                        {tag.name}
                        <button
                          type="button"
                          aria-label={`Remove ${tag.name} from ${template.name}`}
                          disabled={busy || template.tags.length === 1}
                          title={
                            template.tags.length === 1
                              ? 'A template keeps at least one tag; delete it instead'
                              : 'Remove'
                          }
                          onClick={() => void removeTag(template, tag.name)}
                          className="rounded-full p-0.5 text-fg-muted hover:bg-surface hover:text-fg disabled:opacity-40"
                        >
                          <X size={12} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
