import { FilePlus, FolderPlus, Upload } from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import { LabelFilterBar } from '@renderer/features/labels/LabelFilterBar'
import { ManuscriptTree } from '@renderer/features/manuscript/ManuscriptTree'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useResearchStore } from './researchStore'
import { researchRootOf, researchTarget } from './researchView'

const BUTTON =
  'flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent'

/**
 * The Research section of the sidebar (F-16.8, story memory v2): the document tree with the
 * Research root alone (folders and documents, no hierarchy levels, scene details or compile
 * ticks), with Add files…, New note and New folder above it and the label filter (F-16.7) under
 * them. Uploads go through the library's open dialog and become editable pages; a note is a
 * written page.
 */
export function ResearchTab({ format }: { format: NovelFormat }): React.JSX.Element {
  const root = useTreeStore((s) => researchRootOf(s))
  const busy = useTreeStore((s) => s.busy)
  const run = (action: () => Promise<void>): void => {
    action().catch((err: unknown) => toast.error(describeError(err)))
  }
  const target = (): { parentId: string; afterId?: string } | null => {
    const state = useTreeStore.getState()
    return researchTarget(state, state.selectedId)
  }
  const folderOf = (): string | undefined => {
    const where = target()
    return where?.parentId
  }

  return (
    <>
      <div
        role="toolbar"
        aria-label="Research"
        className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1 text-xs"
      >
        <button
          type="button"
          disabled={root === null || busy}
          onClick={() => run(() => useResearchStore.getState().add(folderOf()))}
          className={BUTTON}
        >
          <Upload size={12} aria-hidden="true" />
          Add files…
        </button>
        <button
          type="button"
          disabled={root === null || busy}
          onClick={() =>
            run(async () => {
              const where = target()
              if (where !== null) await useResearchStore.getState().create(where)
            })
          }
          className={BUTTON}
        >
          <FilePlus size={12} aria-hidden="true" />
          New note
        </button>
        <button
          type="button"
          disabled={root === null || busy}
          onClick={() =>
            run(async () => {
              const where = target()
              if (where !== null) {
                await useTreeStore
                  .getState()
                  .createGeneric('folder', where.afterId ?? where.parentId)
              }
            })
          }
          className={BUTTON}
        >
          <FolderPlus size={12} aria-hidden="true" />
          New folder
        </button>
      </div>
      <LabelFilterBar surface="research" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {root === null ? (
          <p className="m-0 p-3 text-sm text-fg-muted">Research opens with the project.</p>
        ) : (
          <ManuscriptTree format={format} roots={[root]} />
        )}
      </div>
    </>
  )
}
