import { useState } from 'react'
import { categoryOf } from '@shared/categories'
import { THREAD_KIND } from '@shared/threads'
import { TODO_LINE_MAX, type TodoItem } from '@shared/todo'
import { useCategoryStore } from '@renderer/features/entities/categoryStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { openContinuityFix } from './todoJump'
import { applyPick, canAdd } from './todoPick'
import { useTodoStore } from './todoStore'

const BUTTON =
  'rounded-md border border-line px-2 py-1 text-xs hover:bg-surface-raised disabled:opacity-50'
const PRIMARY =
  'rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50'

/** The item on show, open or settled while going through (two stable selections, no new object). */
function useCardItem(id: string): { item: TodoItem; settled: 'done' | 'dismissed' | null } | null {
  const open = useTodoStore((s) => s.items.find((each) => each.id === id))
  const decided = useTodoStore((s) => s.review?.decided.find((each) => each.item.id === id))
  if (open !== undefined) return { item: open, settled: null }
  return decided === undefined ? null : { item: decided.item, settled: decided.status }
}

/**
 * One To do item on the deck (F-9.16): why it was flagged, the passage (the editor has jumped to
 * it), the suggestions (each labelled a suggestion: an option to choose, never a fact), and the
 * editable line. Picking a suggestion only fills the line; Add writes it as the author's own text
 * where the card says, and marks the item done. Cancel writes nothing. The suggestions are asked
 * for when the card is first shown (the store does it as the deck moves, with Use AI on); with
 * AI off the card offers only its actions.
 */
export function TodoCard({ id }: { id: string }): React.JSX.Element | null {
  const shown = useCardItem(id)
  const composer = useTodoStore((s) => (s.composer?.id === id ? s.composer : null))
  const suggesting = useTodoStore((s) => s.suggesting.includes(id))
  const suggestError = useTodoStore((s) => s.suggestErrors[id] ?? null)
  if (shown === null) return null
  const { item, settled } = shown
  const addable = canAdd(item.target)
  const open = (text: string): void => useTodoStore.getState().openComposer(item.id, text)

  return (
    <div className="flex flex-col gap-2" data-testid="todo-card" data-rule={item.rule}>
      <p className="m-0 text-sm font-medium">{item.subject}</p>
      <p className="m-0 text-sm text-fg-muted">{item.why}</p>
      {item.quote === null ? null : (
        <q className="text-xs break-words text-fg-subtle italic">{item.quote}</q>
      )}
      {settled !== null ? (
        <p className="m-0 text-xs text-fg-muted">
          {settled === 'done' ? 'Done.' : 'Dismissed: it will not come back.'}
        </p>
      ) : (
        <>
          {item.suggestions.length > 0 ? (
            <ul
              aria-label="Suggestions"
              className="m-0 flex list-none flex-col gap-1 p-0"
              data-testid="todo-suggestions"
            >
              {item.suggestions.map((suggestion) => (
                <li key={suggestion} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 shrink-0 rounded-full border border-line px-1.5 text-[10px] tracking-wide text-fg-subtle uppercase">
                    Suggestion
                  </span>
                  <span className="min-w-0 flex-1">{suggestion}</span>
                  {addable ? (
                    <button
                      type="button"
                      className={BUTTON}
                      aria-label={`Use: ${suggestion}`}
                      onClick={() => open(suggestion)}
                    >
                      Use
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : suggesting ? (
            <p className="m-0 text-xs text-fg-muted" role="status" data-testid="todo-suggesting">
              Finding suggestions…
            </p>
          ) : suggestError !== null ? (
            <p className="m-0 text-xs text-fg-muted" data-testid="todo-suggest-error">
              No suggestions: {suggestError}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            {addable && composer === null ? (
              <button type="button" className={BUTTON} onClick={() => open('')}>
                {item.target.kind === 'newRecord' ? 'Make a record' : 'Write my own line'}
              </button>
            ) : null}
            {item.rule === 'continuity' ? (
              <button type="button" className={BUTTON} onClick={() => openContinuityFix(item)}>
                Open the fix
              </button>
            ) : null}
          </div>
          {composer === null || !addable ? null : <Composer item={item} text={composer.text} />}
        </>
      )}
    </div>
  )
}

/**
 * The editable line and Add. A new record also gets its category: the item's guess first (a
 * character for a name the book keeps using), any other one a pick away (threads are made on
 * the Threads section, not here).
 */
function Composer({ item, text }: { item: TodoItem; text: string }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const target = item.target
  const record = target.kind === 'newRecord' ? target : null
  const [category, setCategory] = useState(record?.category ?? '')
  const categories = useCategoryStore((s) => s.categories)
  const add = (): void => {
    setBusy(true)
    applyPick(item, text, record === null ? {} : { category })
      .catch((err: unknown) => toast.error(describeError(err)))
      .finally(() => setBusy(false))
  }
  const label =
    record === null
      ? `Add to ${item.targetLabel}`
      : `New ${categoryOf(category, categories).noun}: ${record.name} (a line about it, optional)`
  return (
    <div className="flex flex-col gap-1.5" data-testid="todo-composer">
      {record === null ? null : (
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          Category
          <select
            data-testid="todo-category"
            value={category}
            disabled={busy}
            onChange={(event) => setCategory(event.target.value)}
            className="min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-sm text-fg"
          >
            {categories
              .filter((each) => each.id !== THREAD_KIND)
              .map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-xs text-fg-muted">
        {label}
        <textarea
          data-testid="todo-line"
          value={text}
          maxLength={TODO_LINE_MAX}
          rows={2}
          // The deck's keys never fire while typing here.
          autoFocus
          onChange={(event) => useTodoStore.getState().setComposerText(event.target.value)}
          className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-fg"
        />
      </label>
      <div className="flex gap-1.5">
        <button
          type="button"
          className={PRIMARY}
          disabled={busy || (!record && text.trim() === '')}
          data-testid="todo-add"
          onClick={add}
        >
          {record ? 'Make the record' : 'Add'}
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy}
          onClick={() => useTodoStore.getState().closeComposer()}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
