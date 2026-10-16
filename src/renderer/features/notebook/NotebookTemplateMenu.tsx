import { useMemo } from 'react'
import { ContextMenu } from '@renderer/features/manuscript/ContextMenu'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useNotebookStore } from './notebookStore'
import { templateChoiceOf, templateMenuItems } from './templateMenu'

const failed = (err: unknown): void => {
  toast.error(describeError(err))
}

/**
 * The template menu at a point: picking one makes the page in `parentId` (a folder's menu), or,
 * when undefined, where New page puts one (the toolbar).
 */
export function NotebookTemplateMenu({
  x,
  y,
  parentId,
  onClose
}: {
  x: number
  y: number
  parentId?: string | null
  onClose: () => void
}): React.JSX.Element {
  const byId = useNotebookStore((s) => s.byId)
  const childrenOf = useNotebookStore((s) => s.childrenOf)
  const items = useMemo(() => templateMenuItems({ byId, childrenOf }), [byId, childrenOf])
  return (
    <ContextMenu
      x={x}
      y={y}
      items={items}
      onSelect={(itemId) => {
        onClose()
        const choice = templateChoiceOf(itemId)
        if (choice === null) return
        useNotebookStore.getState().createFromTemplate(choice, parentId).catch(failed)
      }}
      onClose={onClose}
    />
  )
}
