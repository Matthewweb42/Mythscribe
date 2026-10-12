import type { NovelFormat } from '@shared/ipc/contract'
import { CreateNodeBar } from '@renderer/features/manuscript/CreateNodeBar'
import { ManuscriptTree } from '@renderer/features/manuscript/ManuscriptTree'
import { TagFilterBar } from '@renderer/features/manuscript/TagFilterBar'
import { LabelFilterBar } from '@renderer/features/labels/LabelFilterBar'
import { useStoryMemory } from '@renderer/features/project/storyMemory'

/**
 * The Manuscript tab of the sidebar (F-7.3): the tag filter (F-4.10; F-16.7: the label filter in
 * story memory v2) above the document tree (F-2.1), with the create buttons (F-2.2) pinned under
 * it. Rendered inside the sidebar's tab panel, a column flex box.
 */
export function ManuscriptTab({ format }: { format: NovelFormat }): React.JSX.Element {
  const memory = useStoryMemory()
  return (
    <>
      {memory === 'v2' ? <LabelFilterBar surface="manuscript" /> : <TagFilterBar />}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ManuscriptTree format={format} />
      </div>
      <CreateNodeBar format={format} />
    </>
  )
}
