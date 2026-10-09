import type { TodoItem } from '@shared/todo'
import { openAssistant } from '@renderer/features/ai/aiActions'
import { useContinuityStore } from '@renderer/features/ai/continuityStore'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'

/** Goes to the item's passage (or its scene when it has no quote); nothing for an item with no scene. */
export function goToTodo(item: Pick<TodoItem, 'nodeId' | 'quote'>): void {
  const { nodeId, quote } = item
  if (nodeId === null) return
  if (quote === null) {
    useTreeStore.getState().select(nodeId)
    return
  }
  void openPassage(nodeId, (doc) => locateText(doc, quote))
}

/**
 * A contradiction's fix stays a proposal in the Continuity view (F-13.4): its scene opens and the
 * assistant shows the view, where the author applies or dismisses the fix.
 */
export function openContinuityFix(item: Pick<TodoItem, 'nodeId'>): void {
  if (item.nodeId !== null) useTreeStore.getState().select(item.nodeId)
  const continuity = useContinuityStore.getState()
  continuity.load().catch(() => undefined)
  continuity.setViewOpen(true)
  openAssistant()
}
