import { useEffect } from 'react'
import type { Editor } from '@tiptap/core'
import { NOT_CANON_ATTR } from '@shared/memory/pageMarks'
import { writtenResearchDoc, type ResearchDoc } from '@shared/research'
import { resolveGenericTarget } from '@renderer/features/manuscript/placement'
import type { TreeIndex } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useResearchStore } from './researchStore'

/**
 * The Research section's view helpers (F-16.8): what the page, the page editor and the tab read
 * off the stores, kept apart from the components.
 */

/** Whether every paragraph the selection touches is marked Not canon (the toggle's pressed state). */
export function selectionNotCanon(editor: Editor): boolean {
  const { from, to } = editor.state.selection
  let any = false
  let every = true
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (node.type.name !== 'paragraph') return true
    any = true
    if (node.attrs[NOT_CANON_ATTR] !== true) every = false
    return false
  })
  return any && every
}

/** A page the meta list does not hold yet (a copy made by Duplicate) is fetched once. */
const refreshed = new Set<string>()

/**
 * The meta of Research document `nodeId`: what the store holds, else written and canon. The list
 * holds every Research document once loaded, so a missing one (a duplicate's copy) means the list
 * is stale, and it is read again once.
 */
export function useResearchDoc(nodeId: string): ResearchDoc {
  const doc = useResearchStore((s) => s.docs[nodeId])
  const loaded = useResearchStore((s) => s.loaded)
  useEffect(() => {
    if (doc !== undefined || !loaded || refreshed.has(nodeId)) return
    refreshed.add(nodeId)
    useResearchStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [doc, loaded, nodeId])
  return doc ?? writtenResearchDoc(nodeId)
}

/** Forgets which pages were fetched again. For tests. */
export function resetResearchPageRefresh(): void {
  refreshed.clear()
}

/** The Research root's id in the tree, or null (a v1 project, or the tree not loaded yet). */
export function researchRootOf(index: Pick<TreeIndex, 'rootIds' | 'byId'>): string | null {
  return index.rootIds.find((id) => index.byId[id]?.sectionType === 'research') ?? null
}

/**
 * Where new Research goes: beside or inside the selection when it is in Research (a folder takes
 * it as its last child, a document has it right after), else at the end of the Research root.
 */
export function researchTarget(
  index: TreeIndex,
  selectedId: string | null
): { parentId: string; afterId?: string } | null {
  const root = researchRootOf(index)
  if (root === null) return null
  if (selectedId !== null && index.sectionOf[selectedId] === 'research') {
    return resolveGenericTarget(index, selectedId) ?? { parentId: root }
  }
  return { parentId: root }
}
