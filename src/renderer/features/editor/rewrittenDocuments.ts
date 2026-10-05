import { useGoalsStore } from '@renderer/features/goals/goalsStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDocumentStore } from './documentStore'

/** A document main rewrote outside the editor, with its new saved word count when it has one. */
export interface RewrittenDocument {
  id: string
  wordCount: number | null
}

/**
 * `countsAsWriting: false` (drafts) moves the session baseline with the counts, so the status
 * bar's session delta does not jump by the difference between two drafts.
 */
export interface RefreshOptions {
  countsAsWriting: boolean
}

/**
 * The renderer's side of a main-side rewrite of document text (crash recovery F-8.3, drafts
 * F-8.5): the tree's word counts take main's figures, the loaded documents among `written` are
 * read again (`documentStore.reload`, which rebuilds their mounted editors, so undo never crosses
 * the rewrite), and the goals ask for their status again. Callers flush pending saves before
 * asking main to rewrite, so no unsaved typing is dropped here.
 */
export async function refreshRewrittenDocuments(
  written: readonly RewrittenDocument[],
  { countsAsWriting }: RefreshOptions = { countsAsWriting: true }
): Promise<void> {
  const tree = useTreeStore.getState()
  for (const { id, wordCount } of written) {
    if (wordCount === null) continue
    if (countsAsWriting) tree.setWordCount(id, wordCount)
    else tree.rebaseWordCount(id, wordCount)
  }
  await useDocumentStore.getState().reload(written.map((each) => each.id))
  if (written.length > 0) useGoalsStore.getState().refreshSoon()
}
