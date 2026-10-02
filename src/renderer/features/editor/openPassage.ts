import type { Node as PmNode } from '@tiptap/pm/model'
import { nameWords, type MentionRange } from '@shared/mentions'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { editorFor, OPEN_SCENE_TIMEOUT_MS } from './activeEditorStore'
import { locateText, type TextRange } from './locateText'

/** The toast when a passage another feature points at is no longer in the document (F-5.7, F-4.12). */
export const PASSAGE_GONE_MESSAGE = 'That passage is no longer in the scene'
export { OPEN_SCENE_TIMEOUT_MS }

/**
 * Opens `nodeId` and selects the passage `locate` finds in its document (F-5.7's cited quotes,
 * F-4.12's mentions). The tree's selection drives the editor pane, so selecting the node opens
 * the document; the editor it mounts may not exist yet, hence the wait. When the document opened
 * but the passage is gone, the author is told and the caret is left alone — the scene is open all
 * the same.
 */
export async function openPassage(
  nodeId: string,
  locate: (doc: PmNode) => TextRange | null
): Promise<void> {
  useTreeStore.getState().select(nodeId)
  const editor = await editorFor(nodeId)
  if (editor === null || editor.isDestroyed) return
  const range = locate(editor.state.doc)
  if (range === null) {
    toast.error(PASSAGE_GONE_MESSAGE)
    return
  }
  editor.chain().focus().setTextSelection(range).scrollIntoView().run()
}

/**
 * Opens the document and selects one recorded mention of `name` (F-4.12). The stored range comes
 * from the last saved document, so it is used only when it still spells the tag's words; live
 * typing above it moves everything, and then the words are searched for instead. Neither found
 * means the author rewrote the sentence: `openPassage` says so.
 */
export function openMention(nodeId: string, range: MentionRange, name: string): Promise<void> {
  const words = nameWords(name).join(' ')
  return openPassage(nodeId, (doc) => {
    const [from, to] = range
    if (
      from < to &&
      to <= doc.content.size &&
      doc.textBetween(from, to, ' ').toLowerCase() === words.toLowerCase()
    ) {
      return { from, to }
    }
    // The tag's name is kebab-case, the prose may capitalize it: the search ignores case.
    return locateText(doc, words, { ignoreCase: true })
  })
}
