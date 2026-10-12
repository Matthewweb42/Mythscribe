import { DEFAULT_READING_IDLE_MINUTES } from '@shared/aiSettings'
import { passageParagraphs } from '@shared/mentions'
import { TiptapNode } from '@shared/tiptap'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { isManuscriptDocument, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { currentStoryMemory } from '@renderer/features/project/storyMemory'
import { ipc } from '@renderer/lib/ipc'

/**
 * When a scene is read (F-16.16; design §2.3 "When", plan P2a §3.1), story memory v2 only:
 *
 * - **Leaving a scene**: the last manuscript scene opened is remembered; opening another one
 *   settles it (pending saves flushed first, then `memory:settle` with reason `leave`). Opening the
 *   chat, the Outline, a sheet, a folder or a Research page is not leaving it.
 * - **The idle pause**: every save of the open scene restarts a timer of the project's
 *   `reading.idleMinutes` (2 to 5, 3 by default, P2a-D5); when it runs out the scene is settled
 *   with reason `idle` and the caret's paragraph (`passageParagraphs` numbering over the editor's
 *   JSON, the numbering main reads), which the gate skips while it has no closing punctuation.
 * - Closing the project waits on nothing: a scene left unread is read on the next open (P2a-D4).
 *
 * Main applies the gate and queues a reading only when a finished sentence changed; nothing is
 * sent from here. A failed settle is dropped: the scene is read when it is next left or opened.
 */

/** The manuscript scene open now (the one a leave would settle). */
let current: string | null = null
let idle: ReturnType<typeof setTimeout> | null = null
let unsubscribe: (() => void) | null = null

const MINUTE_MS = 60_000

function clearIdle(): void {
  if (idle !== null) clearTimeout(idle)
  idle = null
}

/** Asks main to read `nodeId` if the gate finds something to read. */
async function settle(
  nodeId: string,
  reason: 'leave' | 'idle',
  caretPara: number | null
): Promise<void> {
  try {
    await flushPendingSaves()
    await ipc().invoke('memory:settle', { nodeId, reason, caretPara })
  } catch {
    // A failed save toasts on its own; a closed project has nothing to read. The scene stays
    // unread and is read when it is next left or the project next opens.
  }
}

/**
 * The paragraph the caret is in, in the open editor of `nodeId` (its `passageParagraphs` index),
 * or null when that editor is not the active one.
 */
export function caretParagraph(nodeId: string): number | null {
  const active = useActiveEditorStore.getState().active
  if (active?.id !== nodeId || active.editor.isDestroyed) return null
  const doc = TiptapNode.safeParse(active.editor.getJSON())
  if (!doc.success) return null
  const head = active.editor.state.selection.head
  const paragraph = passageParagraphs(doc.data).find(
    (each) => each.from <= head && head <= each.to
  )
  return paragraph?.index ?? null
}

function onSelect(selectedId: string | null): void {
  if (currentStoryMemory() !== 'v2' || selectedId === null) return
  const tree = useTreeStore.getState()
  if (!isManuscriptDocument(tree, selectedId)) return
  const left = current
  current = selectedId
  if (left === selectedId) return
  clearIdle()
  if (left !== null && isManuscriptDocument(tree, left)) void settle(left, 'leave', null)
}

/** Starts the triggers for the open project (idempotent); the scene selected now is the open one. */
export function startReaderTriggers(): void {
  if (unsubscribe !== null) return
  const tree = useTreeStore.getState()
  current =
    tree.selectedId !== null && isManuscriptDocument(tree, tree.selectedId)
      ? tree.selectedId
      : null
  unsubscribe = useTreeStore.subscribe((state, previous) => {
    if (state.selectedId !== previous.selectedId) onSelect(state.selectedId)
  })
}

/** A document was saved (`documentStore`): the open scene's idle pause starts again. */
export function noteSaved(nodeId: string): void {
  if (unsubscribe === null || currentStoryMemory() !== 'v2' || nodeId !== current) return
  clearIdle()
  const minutes =
    useAiSettingsStore.getState().settings?.reading.idleMinutes ?? DEFAULT_READING_IDLE_MINUTES
  idle = setTimeout(() => {
    idle = null
    void settle(nodeId, 'idle', caretParagraph(nodeId))
  }, minutes * MINUTE_MS)
}

/** Stops the triggers (the project closed); the timer and the open scene go. Tests reset with it. */
export function stopReaderTriggers(): void {
  unsubscribe?.()
  unsubscribe = null
  clearIdle()
  current = null
}
