import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { Editor } from '@tiptap/core'
import type { NovelFormat } from '@shared/ipc/contract'
import { levelLabel } from '@shared/labels'
import { TiptapNode } from '@shared/tiptap'
import {
  estimatedPages,
  textStats,
  WORDS_PER_PAGE,
  type TextStats,
  type WordCountReport
} from '@shared/wordCount'
import { useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

interface WordCountDialogProps {
  format: NovelFormat
  onClose: () => void
}

/** One row of the table: what is counted, its name, and the counts. */
interface CountRow {
  key: string
  scope: string
  name: string | null
  stats: TextStats
}

/** The live editor's selection as stats, or null when nothing is selected. */
function selectionStats(editor: Editor): TextStats | null {
  const { from, to, empty } = editor.state.selection
  if (empty) return null
  const json: unknown = editor.state.doc.cut(from, to).toJSON()
  const parsed = TiptapNode.safeParse(json)
  return parsed.success ? textStats(parsed.data) : null
}

/**
 * Tools › Word count… (F-10.4): words, characters with and without spaces, and estimated pages
 * for the selection (when there is one), the open document, its chapter, and the manuscript. The
 * selection and the document are counted from the live editor the moment the dialog opens; the
 * drafts are then flushed and main counts the chapter and the manuscript from the stored
 * documents (`stats:wordCount`), so unsaved typing is included. Without an open document the
 * chapter follows the tree selection. Escape, Close, and the backdrop close it.
 */
export function WordCountDialog({ format, onClose }: WordCountDialogProps): React.JSX.Element {
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  const [live] = useState(() => {
    const active = useActiveEditorStore.getState().active
    if (active === null || active.editor.isDestroyed) return null
    return {
      id: active.id,
      title: useTreeStore.getState().byId[active.id]?.title ?? null,
      selection: selectionStats(active.editor),
      document: textStats(active.editor.getJSON())
    }
  })
  const [report, setReport] = useState<WordCountReport | null>(null)

  useEffect(() => {
    closeButton.current?.focus()
    let cancelled = false
    const nodeId = live?.id ?? useTreeStore.getState().selectedId
    const load = async (): Promise<void> => {
      // A failed save is reported by the autosave itself; the stored counts are still worth showing.
      await useDocumentStore
        .getState()
        .flush()
        .catch(() => undefined)
      const answer = await ipc().invoke('stats:wordCount', { nodeId })
      if (!cancelled) setReport(answer)
    }
    load().catch((err: unknown) => toast.error(describeError(err)))
    return () => {
      cancelled = true
    }
  }, [live])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const rows: CountRow[] = []
  if (live?.selection)
    rows.push({ key: 'selection', scope: 'Selection', name: null, stats: live.selection })
  if (live)
    rows.push({ key: 'document', scope: 'Document', name: live.title, stats: live.document })
  if (report?.chapter)
    rows.push({
      key: 'chapter',
      scope: levelLabel(format, 'chapter'),
      name: report.chapter.title,
      stats: report.chapter.stats
    })
  if (report)
    rows.push({ key: 'manuscript', scope: 'Manuscript', name: null, stats: report.manuscript })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="flex max-h-[90vh] w-[560px] max-w-[94vw] flex-col gap-3 overflow-y-auto rounded-lg border border-line bg-surface-raised px-5 py-4 shadow-panel"
      >
        <h2 id={titleId} className="m-0 text-lg font-semibold">
          Word count
        </h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col" className="pb-1 font-medium">
                <span className="sr-only">Scope</span>
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                Words
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                Characters
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                No spaces
              </th>
              <th scope="col" className="pb-1 text-right font-medium">
                Pages
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.key}
                data-testid={`word-count-${row.key}`}
                className="border-t border-line"
              >
                <th scope="row" className="max-w-[12rem] py-1.5 pr-3 text-left font-normal">
                  <span className="font-medium">{row.scope}</span>
                  {row.name !== null ? (
                    <span className="block truncate text-xs text-fg-muted">{row.name}</span>
                  ) : null}
                </th>
                <td className="py-1.5 text-right tabular-nums" data-testid="words">
                  {row.stats.words.toLocaleString()}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {row.stats.characters.toLocaleString()}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {row.stats.charactersNoSpaces.toLocaleString()}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {estimatedPages(row.stats.words).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {report === null ? <p className="m-0 text-xs text-fg-muted">Counting…</p> : null}
        <p className="m-0 text-xs text-fg-muted">
          Pages are estimated at {WORDS_PER_PAGE} words a page.
        </p>
        <div className="flex justify-end">
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
