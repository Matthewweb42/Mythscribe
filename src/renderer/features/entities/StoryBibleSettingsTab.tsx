import { useId, useState } from 'react'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { CATEGORY_FIELD_LABEL_MAX, CATEGORY_FIELDS_MAX } from '@shared/categories'
import { ENTITY_TEMPLATES, type EntityFieldDef } from '@shared/entities'
import type { StoryCategory } from '@shared/categories'
import {
  WRITE_UP_LENGTHS,
  type StoryBibleSettings,
  WRITE_UP_LENGTH_LABEL,
  WRITE_UP_ROLES,
  WRITE_UP_ROLE_LABEL,
  WriteUpRole,
  writeUpRoleOf,
  writeUpStyleOf,
  type WriteUpLength,
  type WriteUpStyle
} from '@shared/storyBibleSettings'
import { THREAD_KIND } from '@shared/threads'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useCategoryStore } from './categoryStore'
import { useEntityStore } from './entityStore'
import { ENTITY_TEMPLATE_LABEL } from './entityView'
import { useStoryBibleSettingsStore } from './storyBibleSettingsStore'

const SECTION = 'flex flex-col gap-2'
const HEADING = 'm-0 text-sm font-semibold'
const NOTE = 'm-0 text-xs text-fg-muted'
const BUTTON =
  'rounded-md border border-line px-2.5 py-1 text-xs hover:bg-surface-raised disabled:opacity-60 disabled:hover:bg-transparent'
const ICON_BUTTON =
  'rounded p-1 text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent'

/** One row of the field editor: a field the category has (`id`) or one being added (no id yet). */
interface FieldRow {
  key: string
  id: string | null
  label: string
  multiline: boolean
}

let rowKey = 0
const toRows = (fields: readonly EntityFieldDef[]): FieldRow[] =>
  fields
    .filter((field) => field.id !== 'notes')
    .map((field) => ({ key: `row-${++rowKey}`, ...field }))

/**
 * Settings › Story bible (F-9.19; requested by the author 2026-10-10): the view a new sheet opens
 * in, and per category its fields (add, remove, rename, reorder; the library's categories and the
 * project's own; Notes stays last) and the write-up style of its Blank page (F-9.18: which fields
 * get a heading and which flow into the opening paragraphs, and the length). The view and the
 * style are story-bible settings (`storyBibleSettingsStore`, applied at once); the fields are the
 * category's (`category:setFields`, saved with a button, since a removed field's text moves into
 * Notes on every sheet of the category, which asks first).
 */
export function StoryBibleSettingsTab(): React.JSX.Element {
  const settings = useStoryBibleSettingsStore((s) => s.settings)
  const update = useStoryBibleSettingsStore((s) => s.update)
  const categories = useCategoryStore((s) => s.categories).filter(
    (category) => category.id !== THREAD_KIND
  )
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? 'character')
  const category = categories.find((each) => each.id === categoryId) ?? categories[0]
  const uid = useId()

  if (settings === null || category === undefined) {
    return <p className={NOTE}>Open a project to change its story-bible settings.</p>
  }

  return (
    <div className="flex flex-col gap-6" data-testid="story-bible-settings">
      <section className={SECTION} aria-labelledby={`${uid}-new`}>
        <h3 id={`${uid}-new`} className={HEADING}>
          New sheets open in
        </h3>
        <div role="radiogroup" aria-labelledby={`${uid}-new`} className="flex gap-4">
          {ENTITY_TEMPLATES.map((template) => (
            <label key={template} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name={`${uid}-template`}
                checked={settings.defaultTemplate === template}
                onChange={() => update({ defaultTemplate: template })}
              />
              {ENTITY_TEMPLATE_LABEL[template]}
            </label>
          ))}
        </div>
        <p className={NOTE}>
          Every sheet has both views and you can switch any time; the AI keeps them in step
          (Settings › AI › Sheet write-ups).
        </p>
      </section>

      <section className={SECTION} aria-labelledby={`${uid}-category`}>
        <div className="flex items-center gap-2">
          <h3 id={`${uid}-category`} className={HEADING}>
            Category
          </h3>
          <select
            aria-label="Category"
            value={category.id}
            onChange={(event) => setCategoryId(event.target.value)}
            className="rounded-md border border-line bg-bg px-1.5 py-1 text-sm"
          >
            {categories.map((each) => (
              <option key={each.id} value={each.id}>
                {each.name}
              </option>
            ))}
          </select>
        </div>
        {/* Keyed by the stored fields: another category, or a save, starts the editor afresh. */}
        <CategoryEditor
          key={`${category.id}:${JSON.stringify(category.fields)}`}
          category={category}
          settings={settings}
        />
      </section>
    </div>
  )
}

/** One category's fields and write-up style (F-9.19). */
function CategoryEditor({
  category,
  settings
}: {
  category: StoryCategory
  settings: StoryBibleSettings
}): React.JSX.Element {
  const update = useStoryBibleSettingsStore((s) => s.update)
  const [rows, setRows] = useState<FieldRow[]>(() => toRows(category.fields))
  const [newLabel, setNewLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const uid = useId()

  const style: WriteUpStyle = writeUpStyleOf(settings, category.id)
  const notes = category.fields.find((field) => field.id === 'notes')
  const saved = JSON.stringify(toComparable(category.fields))
  const dirty = JSON.stringify(toComparable(rows)) !== saved

  const setStyle = (patch: Partial<WriteUpStyle>): void => {
    update({ writeUp: { ...settings.writeUp, [category.id]: { ...style, ...patch } } })
  }

  const move = (index: number, by: -1 | 1): void => {
    const next = [...rows]
    const [row] = next.splice(index, 1)
    if (row === undefined) return
    next.splice(index + by, 0, row)
    setRows(next)
  }

  const addRow = (): void => {
    const label = newLabel.trim()
    if (label === '') return
    setRows([...rows, { key: `row-${++rowKey}`, id: null, label, multiline: true }])
    setNewLabel('')
  }

  const save = async (): Promise<void> => {
    const removed = category.fields.filter(
      (field) => field.id !== 'notes' && !rows.some((row) => row.id === field.id)
    )
    const holding = useEntityStore
      .getState()
      .ids.map((id) => useEntityStore.getState().byId[id])
      .filter(
        (sheet) =>
          sheet?.kind === category.id &&
          removed.some((field) => (sheet.fields[field.id] ?? '').trim() !== '')
      ).length
    if (holding > 0) {
      const ok = await dialogs.confirm({
        title: `Remove ${removed.map((field) => `"${field.label}"`).join(', ')}?`,
        message: `${holding === 1 ? '1 sheet has' : `${holding} sheets have`} text there. It moves into each sheet's Notes as "Label: text"; nothing is deleted.`,
        confirmLabel: 'Remove and move into Notes'
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      await useCategoryStore.getState().setFields(
        category.id,
        rows.map((row) => ({
          ...(row.id === null ? {} : { id: row.id }),
          label: row.label,
          multiline: row.multiline
        }))
      )
      toast.success(`Saved the fields of ${category.name}.`)
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const roleSelect = (field: EntityFieldDef): React.JSX.Element => (
    <select
      aria-label={`How ${field.label} shows on the page`}
      value={writeUpRoleOf(style, field)}
      onChange={(event) => {
        const role = WriteUpRole.safeParse(event.target.value)
        if (role.success) setStyle({ roles: { ...style.roles, [field.id]: role.data } })
      }}
      className="shrink-0 rounded-md border border-line bg-bg px-1.5 py-1 text-xs"
    >
      {WRITE_UP_ROLES.map((role) => (
        <option key={role} value={role}>
          {WRITE_UP_ROLE_LABEL[role]}
        </option>
      ))}
    </select>
  )

  return (
    <>
      <h4 className="m-0 text-xs font-medium text-fg-muted">
        Fields, in page order, and how each shows on the Blank page
      </h4>
      <ol
        aria-label={`Fields of ${category.name}`}
        className="m-0 flex list-none flex-col gap-1.5 p-0"
      >
        {rows.map((row, index) => {
          const field = category.fields.find((each) => each.id === row.id)
          return (
            <li key={row.key} className="flex items-center gap-1.5">
              <input
                aria-label={`Field ${index + 1} name`}
                value={row.label}
                maxLength={CATEGORY_FIELD_LABEL_MAX}
                onChange={(event) =>
                  setRows(
                    rows.map((each) =>
                      each.key === row.key ? { ...each, label: event.target.value } : each
                    )
                  )
                }
                className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm"
              />
              {field === undefined || dirty ? null : roleSelect(field)}
              <button
                type="button"
                aria-label={`Move ${row.label} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
                className={ICON_BUTTON}
              >
                <ArrowUp size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Move ${row.label} down`}
                disabled={index === rows.length - 1}
                onClick={() => move(index, 1)}
                className={ICON_BUTTON}
              >
                <ArrowDown size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Remove ${row.label}`}
                onClick={() => setRows(rows.filter((each) => each.key !== row.key))}
                className={ICON_BUTTON}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          )
        })}
        {notes === undefined ? null : (
          <li className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 px-2 py-1 text-sm text-fg-muted">
              {notes.label} (always last)
            </span>
            {dirty ? null : roleSelect(notes)}
          </li>
        )}
      </ol>
      <div className="flex items-center gap-1.5">
        <input
          aria-label="New field name"
          placeholder="New field"
          value={newLabel}
          maxLength={CATEGORY_FIELD_LABEL_MAX}
          onChange={(event) => setNewLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') addRow()
          }}
          className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm"
        />
        <button
          type="button"
          disabled={newLabel.trim() === '' || rows.length >= CATEGORY_FIELDS_MAX}
          onClick={addRow}
          className={BUTTON}
        >
          Add field
        </button>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!dirty || busy}
          onClick={() => void save()}
          className={BUTTON}
        >
          Save fields
        </button>
        {dirty ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => setRows(toRows(category.fields))}
            className={BUTTON}
          >
            Undo changes
          </button>
        ) : null}
      </div>
      <p className={NOTE}>
        Renaming keeps every sheet&apos;s text. A removed field&apos;s text moves into Notes on each
        sheet. A field only one sheet needs can be added on that sheet instead.
        {dirty ? ' Save the fields to choose how the new ones show on the page.' : ''}
      </p>

      <div
        role="radiogroup"
        aria-label="Length of the write-up"
        className="flex items-center gap-4"
      >
        <span className="text-xs font-medium text-fg-muted">Length of the write-up</span>
        {WRITE_UP_LENGTHS.map((length: WriteUpLength) => (
          <label key={length} className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name={`${uid}-length`}
              checked={style.length === length}
              onChange={() => setStyle({ length })}
            />
            {WRITE_UP_LENGTH_LABEL[length]}
          </label>
        ))}
      </div>
      <p className={NOTE}>
        Heading fields get a heading of their own on the Blank page; Paragraph fields are woven into
        the opening paragraphs. A change shows on each page at its next write-up.
      </p>
    </>
  )
}

/** What the editor compares to tell an unsaved change: ids, names, kinds, order (Notes aside). */
function toComparable(
  fields: readonly { id: string | null; label: string; multiline: boolean }[]
): unknown {
  return fields
    .filter((field) => field.id !== 'notes')
    .map((field) => [field.id, field.label.trim(), field.multiline])
}
