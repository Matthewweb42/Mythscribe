import type { ThreadEventView } from '@shared/threads'
import { locateText } from '@renderer/features/editor/locateText'
import { openPassage } from '@renderer/features/editor/openPassage'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'

/** Goes to the event's passage (or its scene when it has no quote). */
export function goToEvent(event: ThreadEventView): void {
  const { nodeId, quote } = event
  if (nodeId === null) return
  if (quote === null) {
    useTreeStore.getState().select(nodeId)
    return
  }
  void openPassage(nodeId, (doc) => locateText(doc, quote))
}
