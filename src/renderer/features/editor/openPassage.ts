import type { Node as PmNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { aliasKey } from '@shared/aliases'
import { nameWords, type MentionRange } from '@shared/mentions'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { editorFor, OPEN_SCENE_TIMEOUT_MS } from './activeEditorStore'
import { locateText, type TextRange } from './locateText'
import { centreCaret } from './typewriter'

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
  locate: (doc: PmNode) => TextRange | null,
  options?: { centre?: boolean }
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
  if (options?.centre === true) centreOnceLaidOut(editor.view, range.from)
}

/**
 * Puts `pos` at the middle of the view once the editor has painted (Ms Scribe's sources,
 * 2026-10-15): a scene just opened restores its own scroll first, and its layout settles over
 * the next frames, so the passage is centred two frames on, as focus mode centres its caret.
 */
export function centreOnceLaidOut(view: EditorView, pos: number): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (view.isDestroyed || pos > view.state.doc.content.size) return
      centreCaret(view, undefined, pos)
    })
  })
}

/**
 * Opens the document and selects one recorded mention of `name` (F-4.12) or of one of its
 * `aliases` (F-4.14). The stored range comes from the last saved document, so it is used only
 * when it still spells one of those names; live typing above it moves everything, and then the
 * names are searched for instead, the main name first. None found means the author rewrote the
 * sentence: `openPassage` says so.
 */
export function openMention(
  nodeId: string,
  range: MentionRange,
  name: string,
  aliases: readonly string[] = []
): Promise<void> {
  const spellings = [name, ...aliases.map(aliasKey)]
    .map((each) => nameWords(each).join(' '))
    .filter((words) => words !== '')
  return openPassage(nodeId, (doc) => {
    const [from, to] = range
    if (from < to && to <= doc.content.size) {
      const text = doc.textBetween(from, to, ' ').toLowerCase()
      if (spellings.some((words) => words.toLowerCase() === text)) return { from, to }
    }
    // The tag's name is kebab-case, the prose may capitalize it: the search ignores case.
    for (const words of spellings) {
      const found = locateText(doc, words, { ignoreCase: true })
      if (found !== null) return found
    }
    return null
  })
}

/**
 * Opens the document and selects one mention the name scan of story memory v2 recorded (F-16.6's
 * *Named in*). `text` is the mention as the scan read it and `names` the record's names. Each is
 * taken as written, never as a tag name, so a hyphen stays inside the name ("Anne-Marie"). The
 * stored range is used while it still reads one of them, case ignored; otherwise the first place
 * one of them is written, the mention's own text first. None found: `openPassage` says so.
 */
export function openNameMention(
  nodeId: string,
  range: MentionRange,
  text: string,
  names: readonly string[]
): Promise<void> {
  const spellings = [text, ...names].filter((each) => each.trim() !== '')
  return openPassage(nodeId, (doc) => {
    const [from, to] = range
    if (from < to && to <= doc.content.size) {
      const here = doc.textBetween(from, to, ' ').toLowerCase()
      if (spellings.some((each) => each.toLowerCase() === here)) return { from, to }
    }
    for (const each of spellings) {
      const found = locateText(doc, each, { ignoreCase: true })
      if (found !== null) return found
    }
    return null
  })
}
