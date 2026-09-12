import { useState } from 'react'
import { TAG_TEMPLATES, TagTemplateId, tagTemplateById } from '@shared/tagTemplates'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useTagStore } from './tagStore'

const FIELD = 'min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-sm'

/** "Added 27 tags" / "Added 24 tags, skipped 3 already in the bank" / "All 27 tags are already in the bank". */
function loadSummary(created: number, skipped: number): string {
  if (created === 0) return `All ${skipped} tags are already in the bank`
  const added = created === 1 ? 'Added 1 tag' : `Added ${created} tags`
  return skipped === 0 ? added : `${added}, skipped ${skipped} already in the bank`
}

/**
 * The template row of the Tags tab (F-4.3): pick one of the seeded templates and load it into the
 * bank after a confirmation. Main creates the tags it can and reports the names it skipped; the
 * store merges the new rows, and the toast tells the author both counts.
 */
export function TemplateLoader(): React.JSX.Element {
  const loadTemplate = useTagStore((s) => s.loadTemplate)
  const [templateId, setTemplateId] = useState<TagTemplateId>('standard-fiction')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    const template = tagTemplateById(templateId)
    if (!template || busy) return
    const ok = await dialogs.confirm({
      title: `Load the ${template.label} template?`,
      message: `Adds ${template.tags.length} tags across every category. Tags already in the bank are skipped.`,
      confirmLabel: 'Load'
    })
    if (!ok) return
    setBusy(true)
    try {
      const { created, skipped } = await loadTemplate(template.id)
      const summary = loadSummary(created.length, skipped.length)
      if (created.length === 0) toast.info(summary)
      else toast.success(summary)
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      aria-label="Tag templates"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      className="flex shrink-0 gap-1.5 px-2 pt-2"
    >
      <select
        aria-label="Template"
        value={templateId}
        onChange={(event) => setTemplateId(TagTemplateId.parse(event.target.value))}
        className={`${FIELD} flex-1`}
      >
        {TAG_TEMPLATES.map((template) => (
          <option key={template.id} value={template.id}>
            {template.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={busy}
        className="shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-surface-raised disabled:opacity-50 disabled:hover:bg-transparent"
      >
        Load
      </button>
    </form>
  )
}
