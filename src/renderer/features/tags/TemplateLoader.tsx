import { useEffect, useState } from 'react'
import { TAG_TEMPLATES } from '@shared/tagTemplates'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useCustomTemplateStore } from './customTemplateStore'
import { loadSummary, tagsLabel } from './loadSummary'
import { TagTemplatesDialog } from './TagTemplatesDialog'
import { promptTemplateName } from './templateName'
import { useTagStore } from './tagStore'

const FIELD = 'min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-sm'
const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-surface-raised disabled:opacity-50 disabled:hover:bg-transparent'

/** A select value: `builtin:<id>` for a seeded template, `custom:<id>` for one of the author's. */
const BUILTIN = 'builtin:'
const CUSTOM = 'custom:'
const DEFAULT_CHOICE = `${BUILTIN}standard-fiction`

/**
 * The template row of the Tags tab: pick a seeded template (F-4.3) or one of the author's own
 * (F-4.11) and load it into the bank after a confirmation; save the bank as a new template; and
 * open the manager to rename, trim, or delete saved ones. Main creates the tags it can and
 * reports the names it skipped; the store merges the new rows, and the toast tells both counts.
 */
export function TemplateLoader({ bankEmpty }: { bankEmpty: boolean }): React.JSX.Element {
  const loadTemplate = useTagStore((s) => s.loadTemplate)
  const loadCustomTemplate = useTagStore((s) => s.loadCustomTemplate)
  const custom = useCustomTemplateStore((s) => s.templates)
  const ensureLoaded = useCustomTemplateStore((s) => s.ensureLoaded)
  const saveTemplate = useCustomTemplateStore((s) => s.save)
  const [choice, setChoice] = useState(DEFAULT_CHOICE)
  const [busy, setBusy] = useState(false)
  const [managing, setManaging] = useState(false)

  useEffect(() => {
    ensureLoaded().catch((err: unknown) => toast.error(describeError(err)))
  }, [ensureLoaded])

  // A deleted template cannot stay selected.
  const selected =
    choice.startsWith(CUSTOM) && !custom.some((t) => `${CUSTOM}${t.id}` === choice)
      ? DEFAULT_CHOICE
      : choice

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

  const submit = (): Promise<void> =>
    run(async () => {
      const builtin = TAG_TEMPLATES.find((t) => `${BUILTIN}${t.id}` === selected)
      const own = custom.find((t) => `${CUSTOM}${t.id}` === selected)
      const label = builtin?.label ?? own?.name
      const count = builtin?.tags.length ?? own?.tags.length ?? 0
      if (label === undefined) return
      const ok = await dialogs.confirm({
        title: `Load the ${label} template?`,
        message: builtin
          ? `Adds ${count} tags across every category. Tags already in the bank are skipped.`
          : `Adds up to ${tagsLabel(count)}. Tags already in the bank are skipped.`,
        confirmLabel: 'Load'
      })
      if (!ok) return
      const { created, skipped } = builtin
        ? await loadTemplate(builtin.id)
        : await loadCustomTemplate(own?.id ?? '')
      const summary = loadSummary(created.length, skipped.length)
      if (created.length === 0) toast.info(summary)
      else toast.success(summary)
    })

  const saveBank = (): Promise<void> =>
    run(async () => {
      const name = await promptTemplateName()
      if (name === null) return
      const template = await saveTemplate(name.trim())
      setChoice(`${CUSTOM}${template.id}`)
      toast.success(`Saved "${template.name}" with ${tagsLabel(template.tags.length)}`)
    })

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-2 pt-2">
      <form
        aria-label="Tag templates"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        className="flex gap-1.5"
      >
        <select
          aria-label="Template"
          value={selected}
          onChange={(event) => setChoice(event.target.value)}
          className={`${FIELD} flex-1`}
        >
          <optgroup label="Built-in">
            {TAG_TEMPLATES.map((template) => (
              <option key={template.id} value={`${BUILTIN}${template.id}`}>
                {template.label}
              </option>
            ))}
          </optgroup>
          {custom.length > 0 ? (
            <optgroup label="Your templates">
              {custom.map((template) => (
                <option key={template.id} value={`${CUSTOM}${template.id}`}>
                  {template.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <button type="submit" disabled={busy} className={BUTTON}>
          Load
        </button>
      </form>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => void saveBank()}
          disabled={busy || bankEmpty}
          title={bankEmpty ? 'Add tags to save them as a template' : undefined}
          className={BUTTON}
        >
          Save bank as template…
        </button>
        <button
          type="button"
          onClick={() => setManaging(true)}
          disabled={custom.length === 0}
          className={BUTTON}
        >
          Manage…
        </button>
      </div>
      {managing ? <TagTemplatesDialog onClose={() => setManaging(false)} /> : null}
    </div>
  )
}
