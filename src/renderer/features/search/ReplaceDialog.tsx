import { useEffect, useId, useRef } from 'react'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import {
  REPLACEMENT_MAX,
  REPLACE_MAX_DOCUMENTS,
  REPLACE_QUERY_MAX,
  type ReplacePreviewItem,
  type ReplaceSample
} from '@shared/replace'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { describeReplaceCounts, useReplaceStore } from './replaceStore'
import { SEARCH_INPUT_CLASS, SearchFrame } from './SearchFrame'

/** The title of the confirm before anything is written; not the dialog's own, so the two tell apart. */
const CONFIRM_TITLE = 'Replace across documents'

/** The find and replace dialog (F-10.2), shown while the replace store says it is open. */
export function ReplaceDialog(): React.JSX.Element | null {
  const open = useReplaceStore((s) => s.open)
  return open ? <ReplaceDialogBody /> : null
}

/** One occurrence as it will change: the match struck through, the replacement after it. */
function SampleLine({ sample }: { sample: ReplaceSample }): React.JSX.Element {
  const { text, range } = sample.before
  const [from, to] = range
  const [insFrom, insTo] = sample.after.range
  const inserted = sample.after.text.slice(insFrom, insTo)
  return (
    <li className="text-xs whitespace-pre-wrap text-fg-muted">
      {text.slice(0, from)}
      <del className="rounded-sm bg-surface px-0.5 text-fg-subtle">{text.slice(from, to)}</del>
      {inserted !== '' ? (
        <ins className="rounded-sm bg-accent px-0.5 text-accent-fg no-underline">{inserted}</ins>
      ) : null}
      {text.slice(to)}
    </li>
  )
}

const occurrences = (count: number): string =>
  `${count.toLocaleString()} occurrence${count === 1 ? '' : 's'}`

/** One previewed document: its checkbox, where it is, how many occurrences, and the samples. */
function PreviewGroup({
  item,
  included,
  onToggle
}: {
  item: ReplacePreviewItem
  included: boolean
  onToggle: () => void
}): React.JSX.Element {
  const more = item.count - item.samples.length
  return (
    <li data-testid="replace-document" className="border-b border-line px-4 py-2 last:border-b-0">
      <label className="flex cursor-pointer items-baseline gap-2 text-sm">
        <input
          type="checkbox"
          aria-label={`Replace in ${item.title}`}
          checked={included}
          onChange={onToggle}
          className="self-center"
        />
        <span className="min-w-0 truncate font-medium">{item.title}</span>
        <span className="min-w-0 shrink truncate text-xs text-fg-muted">{item.location}</span>
        <span className="ml-auto shrink-0 text-xs text-fg-muted">{occurrences(item.count)}</span>
      </label>
      <ul
        aria-label={`Changes in ${item.title}`}
        className={`m-0 mt-1 flex list-none flex-col gap-0.5 p-0 pl-6 ${included ? '' : 'opacity-50'}`}
      >
        {item.samples.map((sample, index) => (
          <SampleLine key={index} sample={sample} />
        ))}
        {more > 0 ? (
          <li className="text-xs text-fg-subtle">+{more.toLocaleString()} more</li>
        ) : null}
      </ul>
    </li>
  )
}

/**
 * Find, Replace with, the two options, the scope, and the preview: one group per document that
 * holds the text, each with a checkbox (ticked by default) and up to five sample lines showing
 * the change. Nothing is written until the footer button is pressed and the confirm that names
 * the counts is accepted. After a commit the footer offers `Undo last replace` until the next
 * commit, a successful undo, or the project closing.
 */
function ReplaceDialogBody(): React.JSX.Element {
  const titleId = useId()
  const scopeName = useId()
  const find = useRef<HTMLInputElement>(null)
  const query = useReplaceStore((s) => s.query)
  const replacement = useReplaceStore((s) => s.replacement)
  const matchCase = useReplaceStore((s) => s.matchCase)
  const wholeWord = useReplaceStore((s) => s.wholeWord)
  const scope = useReplaceStore((s) => s.scope)
  const scopeNode = useReplaceStore((s) => s.scopeNode)
  // A lone document has nothing in it: its scope reads "Only <title>".
  const scopeIsDocument = useTreeStore((s) =>
    scopeNode === null ? false : s.byId[scopeNode.id]?.kind === 'document'
  )
  const preview = useReplaceStore((s) => s.preview)
  const answered = useReplaceStore((s) => s.answered)
  const excluded = useReplaceStore((s) => s.excluded)
  const status = useReplaceStore((s) => s.status)
  const error = useReplaceStore((s) => s.error)
  const busy = useReplaceStore((s) => s.busy)
  const undoable = useReplaceStore((s) => s.undoable)
  const store = useReplaceStore.getState

  useEffect(() => {
    find.current?.focus()
    find.current?.select()
  }, [])

  const items = preview?.items ?? []
  const ticked = items.filter((item) => !excluded.includes(item.id))
  const total = ticked.reduce((sum, item) => sum + item.count, 0)
  const counts = describeReplaceCounts(total, ticked.length)
  const canCommit = status === 'done' && answered !== null && ticked.length > 0 && !busy

  const commit = async (): Promise<void> => {
    if (!canCommit || answered === null) return
    const confirmed = await dialogs.confirm({
      title: CONFIRM_TITLE,
      message:
        answered.replacement === ''
          ? `Delete ${counts} of “${answered.query}”? You can undo this until the next replace or until the project is closed.`
          : `Replace ${counts} of “${answered.query}” with “${answered.replacement}”? You can undo this until the next replace or until the project is closed.`,
      confirmLabel: answered.replacement === '' ? 'Delete' : 'Replace'
    })
    if (confirmed) await store().commit()
    // The button that had the focus is disabled now; Escape must still reach the dialog.
    find.current?.focus()
  }

  const undo = async (): Promise<void> => {
    await store().undo()
    // The button is gone once the undo is spent, and the focus would go with it.
    find.current?.focus()
  }

  const message =
    query === ''
      ? 'Type the text to find.'
      : status === 'error'
        ? (error ?? 'The preview failed.')
        : status === 'done' && items.length === 0
          ? `No document holds “${answered?.query ?? query}”.`
          : status === 'searching' && items.length === 0
            ? 'Looking…'
            : null

  return (
    <SearchFrame
      titleId={titleId}
      title="Replace in project"
      testId="replace-dialog"
      closeLabel="Close replace"
      onClose={store().close}
    >
      <div className="flex flex-col gap-2 px-4 pt-2 pb-3">
        <input
          ref={find}
          type="text"
          aria-label="Find"
          autoComplete="off"
          spellCheck={false}
          maxLength={REPLACE_QUERY_MAX}
          placeholder="Find in documents"
          value={query}
          onChange={(event) => store().setQuery(event.target.value)}
          className={SEARCH_INPUT_CLASS}
        />
        <input
          type="text"
          aria-label="Replace with"
          autoComplete="off"
          spellCheck={false}
          maxLength={REPLACEMENT_MAX}
          placeholder="Replace with (leave empty to delete)"
          value={replacement}
          onChange={(event) => store().setReplacement(event.target.value)}
          className={SEARCH_INPUT_CLASS}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={matchCase}
              onChange={(event) => store().setMatchCase(event.target.checked)}
            />
            Match case
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={wholeWord}
              onChange={(event) => store().setWholeWord(event.target.checked)}
            />
            Whole word
          </label>
          {scopeNode !== null ? (
            <div role="radiogroup" aria-label="Replace in" className="ml-auto flex min-w-0 gap-3">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name={scopeName}
                  checked={scope === 'all'}
                  onChange={() => store().setScope('all')}
                />
                All documents
              </label>
              <label className="flex min-w-0 cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  name={scopeName}
                  checked={scope === 'selection'}
                  onChange={() => store().setScope('selection')}
                />
                <span className="truncate">
                  {scopeIsDocument
                    ? `Only ${scopeNode.title}`
                    : `${scopeNode.title} and everything in it`}
                </span>
              </label>
            </div>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-line">
        {message !== null ? (
          <p role="status" className="m-0 px-4 py-4 text-sm text-fg-muted">
            {message}
          </p>
        ) : null}
        <ul aria-label="Documents to change" className="m-0 list-none p-0">
          {items.map((item) => (
            <PreviewGroup
              key={item.id}
              item={item}
              included={!excluded.includes(item.id)}
              onToggle={() => store().toggleDocument(item.id)}
            />
          ))}
        </ul>
        {preview?.truncated ? (
          <p className="m-0 border-t border-line px-4 py-2 text-xs text-fg-muted">
            Showing the first {REPLACE_MAX_DOCUMENTS} of {preview.total} documents. Replace these,
            then the rest will be listed.
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
        {undoable !== null ? (
          <button
            type="button"
            disabled={busy}
            title={`Puts back ${describeReplaceCounts(undoable.total, undoable.documents)}; a document edited since is left as it is.`}
            onClick={() => void undo()}
            className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60"
          >
            Undo last replace
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          disabled={!canCommit}
          onClick={() => void commit()}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
        >
          {canCommit ? `Replace ${counts}` : 'Replace'}
        </button>
      </div>
    </SearchFrame>
  )
}
