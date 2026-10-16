import { isManuscriptDocument, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { currentStoryMemory } from '@renderer/features/project/storyMemory'
import { ipc } from '@renderer/lib/ipc'

/**
 * When the author leaves a chapter after writing in it (notes redesign phase 3), story memory v1
 * only. The renderer owns the open scene and its saves, so it tracks the chapter of the last
 * manuscript scene opened and which chapters had a scene saved since they were entered (the
 * editor's autosave, `documentStore`: the author's typing, never an AI edit). Opening a scene
 * outside that chapter (another chapter, or a scene in none) is leaving it: pending saves are
 * flushed, then, if it was written in, `editFlow:chapterLeft` tells main, which decides whether
 * the automatic notes update runs (the switch, Use AI, the cap, the text since the last update).
 * Opening a note page, the Outline or a folder is not leaving it, and neither is closing the
 * project, so closing the app never spends. A failed call is dropped: the next leave catches up.
 */

/**
 * The chapter (the folder a scene sits in, not a section root) of `sceneId`, or null when it sits
 * straight under the manuscript.
 */
export function chapterOf(sceneId: string): string | null {
  const tree = useTreeStore.getState()
  const parent = tree.byId[sceneId]?.parentId ?? null
  if (parent === null || tree.rootIds.includes(parent)) return null
  return tree.byId[parent]?.kind === 'folder' ? parent : null
}

/** The chapter of the manuscript scene open now; null when none is, or it sits in no chapter. */
let current: string | null = null
/** Chapters with a scene saved since they were entered. */
const written = new Set<string>()
let unsubscribe: (() => void) | null = null

async function leave(chapterId: string): Promise<void> {
  try {
    // A save still waiting for the scene left counts, and main reads the text as saved.
    await flushPendingSaves()
    if (!written.delete(chapterId)) return
    await ipc().invoke('editFlow:chapterLeft', { chapterId })
  } catch {
    // A failed save toasts on its own; a closed project has nothing to update.
  }
}

function onSelect(selectedId: string | null): void {
  if (currentStoryMemory() !== 'v1' || selectedId === null) return
  if (!isManuscriptDocument(useTreeStore.getState(), selectedId)) return
  const next = chapterOf(selectedId)
  if (next === current) return
  const left = current
  current = next
  if (next !== null) written.delete(next)
  if (left !== null) void leave(left)
}

/** Starts the triggers for the open project (idempotent); the scene selected now is the open one. */
export function startChapterTriggers(): void {
  if (unsubscribe !== null) return
  const tree = useTreeStore.getState()
  current =
    tree.selectedId !== null && isManuscriptDocument(tree, tree.selectedId)
      ? chapterOf(tree.selectedId)
      : null
  written.clear()
  unsubscribe = useTreeStore.subscribe((state, previous) => {
    if (state.selectedId !== previous.selectedId) onSelect(state.selectedId)
  })
}

/** A document was saved from the editor (`documentStore`): its chapter was written in. */
export function noteChapterSaved(nodeId: string): void {
  if (unsubscribe === null || currentStoryMemory() !== 'v1') return
  if (!isManuscriptDocument(useTreeStore.getState(), nodeId)) return
  const chapter = chapterOf(nodeId)
  if (chapter !== null) written.add(chapter)
}

/** Stops the triggers (the project closed) without telling main anything. Tests reset with it. */
export function stopChapterTriggers(): void {
  unsubscribe?.()
  unsubscribe = null
  current = null
  written.clear()
}
