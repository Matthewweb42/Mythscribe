import { ExternalLink } from 'lucide-react'
import { researchSourceLine } from '@shared/research'
import { useCanWrite } from '@renderer/features/account/appAccessStore'
import { LabelPicker } from '@renderer/features/labels/LabelPicker'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useFilingStore } from './filingStore'
import { PageEditor } from './PageEditor'
import { useResearchStore } from './researchStore'
import { useResearchDoc } from './researchView'

/**
 * A Research document in the main pane (F-16.8): its title; where its text came from, with *Open
 * original* for an upload ("Converted from PDF", an image's caption page); the page's *Not canon*
 * switch; its labels (F-16.7); and the page itself, edited with the page schema.
 */
export function ResearchPage({ nodeId }: { nodeId: string }): React.JSX.Element {
  const title = useTreeStore((s) => s.byId[nodeId]?.title ?? '')
  const doc = useResearchDoc(nodeId)
  const writable = useCanWrite()
  const source = researchSourceLine(doc)

  const openOriginal = (): void => {
    useResearchStore
      .getState()
      .openOriginal(nodeId)
      .catch((err: unknown) => toast.error(describeError(err)))
  }
  const switchNotCanon = (): void => {
    useResearchStore
      .getState()
      .setNotCanon(nodeId, !doc.notCanon)
      .catch((err: unknown) => toast.error(describeError(err)))
  }

  return (
    <section
      aria-label="Research document"
      data-testid="research-page"
      data-not-canon={doc.notCanon ? 'true' : undefined}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2">
        <h2 className="m-0 min-w-0 truncate text-base font-medium">{title}</h2>
        {source !== null ? (
          <span className="flex items-center gap-2 text-xs text-fg-muted">
            <span data-testid="research-source">{source}</span>
            <button
              type="button"
              onClick={openOriginal}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-fg-muted hover:bg-surface-raised hover:text-fg"
            >
              <ExternalLink size={12} aria-hidden="true" />
              Open original
            </button>
          </span>
        ) : null}
        <FileIntoSheets nodeId={nodeId} />
        <label className="ml-auto flex items-center gap-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            role="switch"
            aria-checked={doc.notCanon}
            checked={doc.notCanon}
            disabled={!writable}
            onChange={switchNotCanon}
          />
          Whole page Not canon
        </label>
        {/* F-16.7: the page's labels, to filter Research by. */}
        <div className="basis-full">
          <LabelPicker nodeId={nodeId} />
        </div>
      </header>
      {doc.notCanon ? (
        <p className="m-0 border-b border-line bg-surface px-4 py-1 text-xs text-fg-muted">
          Not canon: ideas and maybes. Nothing on this page is treated as true.
        </p>
      ) : null}
      <PageEditor
        owner={{ kind: 'research', id: nodeId }}
        label="Research page"
        placeholder={doc.fileType === 'image' ? 'Write a caption…' : 'Write research notes…'}
      />
    </section>
  )
}

/**
 * F-16.9: *File into sheets* (the AI files the page into records' Pinned notes, once); afterwards
 * "Filed on <date>", with *Undo filing* while the session can still take that filing back. Off for a page marked Not canon, an image's caption page, and while another
 * filing is under way, and with AI off it says what to switch on (the store's toast).
 */
function FileIntoSheets({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const doc = useResearchDoc(nodeId)
  const writable = useCanWrite()
  const busy = useFilingStore((s) => s.flow !== null)
  const undoable = useFilingStore((s) => s.undoDocId === nodeId)
  if (doc.fileType === 'image') return null
  if (doc.filedAt !== null) {
    return (
      <span className="flex items-center gap-2 text-xs text-fg-muted">
        <span data-testid="research-filed">{`Filed on ${doc.filedAt.slice(0, 10)}`}</span>
        {undoable ? (
          <button
            type="button"
            data-testid="research-undo-filing"
            disabled={!writable}
            onClick={() => void useFilingStore.getState().undo(nodeId)}
            className="rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-raised disabled:opacity-50"
          >
            Undo filing
          </button>
        ) : null}
      </span>
    )
  }
  return (
    <button
      type="button"
      data-testid="research-file"
      disabled={!writable || busy || doc.notCanon}
      title={doc.notCanon ? 'A Not canon page is never filed as true' : undefined}
      onClick={() => void useFilingStore.getState().start(nodeId)}
      className="rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-raised disabled:opacity-50"
    >
      File into sheets
    </button>
  )
}
