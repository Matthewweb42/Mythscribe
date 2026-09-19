import type { NovelFormat } from '@shared/ipc/contract'
import { CreateNodeBar } from '@renderer/features/manuscript/CreateNodeBar'
import { ManuscriptTree } from '@renderer/features/manuscript/ManuscriptTree'
import { TagFilterBar } from '@renderer/features/manuscript/TagFilterBar'

/**
 * The Manuscript tab of the sidebar (F-7.3): the tag filter (F-4.10) above the document tree
 * (F-2.1), with the create buttons (F-2.2) pinned under it. Rendered inside the sidebar's tab
 * panel, a column flex box.
 */
export function ManuscriptTab({ format }: { format: NovelFormat }): React.JSX.Element {
  return (
    <>
      <TagFilterBar />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ManuscriptTree format={format} />
      </div>
      <CreateNodeBar format={format} />
    </>
  )
}
