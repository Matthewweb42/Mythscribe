import { useState } from 'react'
import {
  DEFAULT_CATEGORY_COLOR,
  TAG_CATEGORIES,
  TAG_CATEGORY_LABEL,
  TAG_NAME_MAX,
  TagCategory
} from '@shared/tags'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useTagStore } from './tagStore'
import { defaultCategoryFor, type CategoryFilter } from './categoryFilter'

const FIELD = 'min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-sm'

/**
 * The create form at the foot of the Tags tab (F-4.2): name, category, and color. The category
 * follows the active filter and the color follows the category until the author picks one by
 * hand. The parent remounts the form (keyed on the filter) when the filter changes, so the
 * defaults re-apply without an effect. New tags are not opened; the list simply gains a row.
 */
export function TagForm({ filter }: { filter: CategoryFilter }): React.JSX.Element {
  const create = useTagStore((s) => s.create)
  const [name, setName] = useState('')
  const [category, setCategory] = useState<TagCategory>(() => defaultCategoryFor(filter))
  /** The hand-picked color, or null while the color still follows the category. */
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const color = picked ?? DEFAULT_CATEGORY_COLOR[category]
  const trimmed = name.trim()

  const submit = async (): Promise<void> => {
    if (trimmed.length === 0 || busy) return
    setBusy(true)
    try {
      await create({ name: trimmed, category, color })
      setName('')
      setPicked(null)
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      aria-label="New tag"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      className="flex shrink-0 flex-col gap-1.5 border-t border-line p-2"
    >
      <input
        aria-label="Tag name"
        placeholder="New tag"
        value={name}
        maxLength={TAG_NAME_MAX}
        onChange={(event) => setName(event.target.value)}
        className={FIELD}
      />
      <div className="flex gap-1.5">
        <select
          aria-label="Category"
          value={category}
          onChange={(event) => setCategory(TagCategory.parse(event.target.value))}
          className={`${FIELD} flex-1`}
        >
          {TAG_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {TAG_CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
        <input
          type="color"
          aria-label="Color"
          value={color}
          onChange={(event) => setPicked(event.target.value)}
          className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-line bg-bg p-0.5"
        />
        <button
          type="submit"
          disabled={trimmed.length === 0 || busy}
          className="shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-surface-raised disabled:opacity-50 disabled:hover:bg-transparent"
        >
          Create tag
        </button>
      </div>
    </form>
  )
}
