import { ExternalLink } from 'lucide-react'
import { researchSourceLine } from '@shared/research'
import { useCanWrite } from '@renderer/features/account/appAccessStore'
import { LabelPicker } from '@renderer/features/labels/LabelPicker'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
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
