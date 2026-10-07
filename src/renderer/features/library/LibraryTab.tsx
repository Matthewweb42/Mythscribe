import { FilePlus2 } from 'lucide-react'
import {
  CONTEXT_FILE_STATE_LABEL,
  CONTEXT_FILE_TYPE_LABEL,
  isSortable,
  type ContextFile
} from '@shared/contextLibrary'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useLibraryStore } from './libraryStore'

const ACTION =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-60'

/** The date a file was added or last updated, short and local. */
const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** Runs a store action and toasts its failure; the actions toast their own outcomes. */
const run = (action: Promise<void>): void => {
  action.catch((err: unknown) => toast.error(describeError(err)))
}

/**
 * The Library sidebar tab (F-9.8): every file uploaded to the project's context library with its
 * type, date, and whether it has been sorted into the story bible. Add more files (or drop them
 * anywhere on the window), open an original in the OS, upload a newer version of one (only what
 * changed is sorted next time), and sort or re-sort a file.
 */
export function LibraryTab(): React.JSX.Element {
  const files = useLibraryStore((s) => s.files)
  const busy = useLibraryStore((s) => s.flow !== null)
  const add = useLibraryStore((s) => s.add)
  const sort = useLibraryStore((s) => s.sort)
  const unsorted = files.filter((file) => file.state === 'new' || file.state === 'changed')
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-2 pt-2">
        <button
          type="button"
          data-testid="library-add"
          onClick={() => run(add())}
          className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-sm hover:bg-surface-raised"
        >
          <FilePlus2 size={14} aria-hidden="true" /> Add files…
        </button>
        {unsorted.length > 0 ? (
          <button
            type="button"
            data-testid="library-sort-all"
            disabled={busy}
            onClick={() => run(sort(unsorted.map((file) => file.id)))}
            className="rounded-md bg-accent px-2 py-1 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
          >
            {`Sort ${unsorted.length === 1 ? '1 file' : `${unsorted.length} files`}`}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {files.length === 0 ? (
          <p className="m-0 px-1 text-sm text-fg-muted">
            No files yet. Add worldbuilding documents, character notes, maps, or art (Word,
            Markdown, text, PDF, images), or drop them anywhere on the window. The AI sorts them
            into your story bible after you review it.
          </p>
        ) : (
          <ul className="m-0 list-none p-0" role="list" aria-label="Library files">
            {files.map((file) => (
              <FileRow key={file.id} file={file} busy={busy} />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

function FileRow({ file, busy }: { file: ContextFile; busy: boolean }): React.JSX.Element {
  const open = useLibraryStore((s) => s.open)
  const update = useLibraryStore((s) => s.update)
  const sort = useLibraryStore((s) => s.sort)
  return (
    <li
      className="m-0 mb-1 list-none rounded-md px-2 py-1.5 hover:bg-surface-raised"
      data-testid="library-file"
      data-file-name={file.name}
    >
      <p className="m-0 truncate text-sm font-medium" title={file.name}>
        {file.name}
      </p>
      <p className="m-0 text-xs text-fg-muted">
        {`${CONTEXT_FILE_TYPE_LABEL[file.type]} · ${shortDate(file.modified)} · `}
        <span data-testid="library-file-state">{CONTEXT_FILE_STATE_LABEL[file.state]}</span>
      </p>
      <div className="mt-0.5 flex flex-wrap gap-1">
        <button
          type="button"
          aria-label={`Open ${file.name}`}
          onClick={() => run(open(file.id))}
          className={ACTION}
        >
          Open
        </button>
        <button
          type="button"
          aria-label={`Update ${file.name}`}
          onClick={() => run(update(file.id))}
          className={ACTION}
        >
          Update…
        </button>
        {isSortable(file.state) ? (
          <button
            type="button"
            aria-label={`${file.state === 'processed' ? 'Sort again' : 'Sort'} ${file.name}`}
            disabled={busy}
            onClick={() => run(sort([file.id]))}
            className={ACTION}
          >
            {file.state === 'processed' ? 'Sort again' : 'Sort'}
          </button>
        ) : null}
      </div>
    </li>
  )
}
