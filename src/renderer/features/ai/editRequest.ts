import type { AiSettings } from '@shared/aiSettings'
import type { RouteEdit } from '@shared/assistantRoute'
import { EDIT_PASS_EXCERPT_MAX, EDIT_PASS_LABEL, EDIT_PASS_TEXT_MIN } from '@shared/editPass'
import {
  choicePass,
  EDIT_TARGET_TITLE_MAX,
  findChapter,
  targetPhrase,
  type EditChoice,
  type EditTarget
} from '@shared/editRequest'
import { featureActionReason } from '@shared/quickActions'
import { quotePassNow, type PassQuote } from '@renderer/features/editPass/passQuote'
import { runningPass, useEditPassStore } from '@renderer/features/editPass/editPassStore'
import { descendantDocuments, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { listOutline } from '@renderer/features/outline/outlineRows'
import { aiActionReason, startSceneAction, type OpenScene } from './aiActions'

/**
 * The chat's edit requests (F-5.26, requested by the author 2026-10-11), renderer side: what a
 * routed edit covers (`resolveEditTarget`), why a choice cannot run now (`editChoiceReason`),
 * what it would cost (`quoteChoice`), and starting it (`runEditChoice`): an edit pass through the
 * edit-pass store (its changes come back as tracked changes in the editor and its review deck),
 * or Editor's notes through the scene action. The assistant store records the turn.
 */

/** Why an edit request has nothing to work on. */
export const EDIT_NO_SCENE_MESSAGE = 'Open a scene first'
export const EDIT_NO_CHAPTER_MESSAGE = 'This scene is not in a chapter.'
export const EDIT_EMPTY_CHAPTER_MESSAGE = 'That chapter has no scenes yet.'
export const EDIT_PASS_RUNNING_MESSAGE =
  'An edit pass is already running. Stop it or wait for it to finish.'

/** The manuscript's chapters in reading order: folders marked as chapters, else every folder. */
function chapters(): { id: string; title: string }[] {
  const tree = useTreeStore.getState()
  const folders = listOutline(tree.rootIds, tree.childrenOf, tree.sectionOf)
    .map((row) => tree.byId[row.id])
    .filter((node) => node?.kind === 'folder')
    .flatMap((node) => (node === undefined ? [] : [node]))
  const marked = folders.filter((node) => node.hierarchyLevel === 'chapter')
  return (marked.length > 0 ? marked : folders).map((node) => ({ id: node.id, title: node.title }))
}

/**
 * What a routed edit covers, or why there is nothing to work on: a named chapter (by title or
 * number) or the open scene's chapter; the selected passage when it is long enough to edit and
 * fits one request (a longer one is the whole scene); otherwise the open scene.
 */
export function resolveEditTarget(edit: RouteEdit, open: OpenScene): EditTarget | string {
  const tree = useTreeStore.getState()
  const title = (id: string): string =>
    (tree.byId[id]?.title ?? 'Untitled').slice(0, EDIT_TARGET_TITLE_MAX)
  if (edit.target === 'chapter') {
    let chapterId: string | null
    if (edit.chapter !== null) {
      chapterId = findChapter(edit.chapter, chapters())
      if (chapterId === null) return `No chapter called “${edit.chapter}” in the manuscript.`
    } else {
      if (!open.scene || open.nodeId === null) return EDIT_NO_SCENE_MESSAGE
      const parent = tree.byId[open.nodeId]?.parentId ?? null
      chapterId = parent === null || tree.rootIds.includes(parent) ? null : parent
      if (chapterId === null) return EDIT_NO_CHAPTER_MESSAGE
    }
    const nodeIds = descendantDocuments(tree, chapterId)
    if (nodeIds.length === 0) return EDIT_EMPTY_CHAPTER_MESSAGE
    return { kind: 'chapter', nodeIds, title: title(chapterId), excerpt: null }
  }
  if (!open.scene || open.nodeId === null || open.editor === null) return EDIT_NO_SCENE_MESSAGE
  const scene: EditTarget = {
    kind: 'scene',
    nodeIds: [open.nodeId],
    title: title(open.nodeId),
    excerpt: null
  }
  if (edit.target !== 'selection') return scene
  const { from, to, empty } = open.editor.state.selection
  const text = empty ? '' : open.editor.state.doc.textBetween(from, to, '\n\n')
  if (text.trim().length < EDIT_PASS_TEXT_MIN || text.length > EDIT_PASS_EXCERPT_MAX) return scene
  return { ...scene, kind: 'selection', excerpt: text }
}

/**
 * Why `choice` cannot run on `target` now, or null: Editor's notes follow the scene action's
 * rules and need the target's scene open; a pass needs Use AI and the feature on, no other pass
 * running, and for a custom pass an instruction.
 */
export function editChoiceReason(
  choice: EditChoice,
  instruction: string | null,
  target: EditTarget,
  settings: AiSettings | null,
  open: OpenScene
): string | null {
  if (choice === 'critique') {
    if (open.nodeId !== target.nodeIds[0]) return `Open “${target.title}” first.`
    return aiActionReason('critique', settings, open, false)
  }
  if (choicePass(choice, instruction) === null) return 'Say what the custom pass should do.'
  return featureActionReason('editPass', {
    settings,
    scene: true,
    length: 1,
    minLength: 0,
    busy: runningPass(useEditPassStore.getState()) === null ? null : EDIT_PASS_RUNNING_MESSAGE
  })
}

/** The words the pass would read, per scene: the selection's own, or each scene's count. */
export function targetWords(target: EditTarget): number[] {
  if (target.excerpt !== null) return [target.excerpt.split(/\s+/u).filter(Boolean).length]
  const counts = useTreeStore.getState().wordCountRollup
  return target.nodeIds.map((id) => counts[id] ?? 0)
}

/** What `choice` would cost on `target` (null for Editor's notes, which is not a pass). */
export function quoteChoice(
  choice: EditChoice,
  instruction: string | null,
  target: EditTarget
): PassQuote | null {
  const pass = choicePass(choice, instruction)
  return pass === null ? null : quotePassNow(pass.type, targetWords(target))
}

/** What a started choice says on its turn. */
export function startedText(choice: EditChoice, target: EditTarget): string {
  const pass = choicePass(choice, null)
  const label = pass === null ? "Editor's notes" : EDIT_PASS_LABEL[pass.type]
  return `${label} started on ${targetPhrase(target)}. The changes come back as tracked changes in the editor to accept or reject.`
}

/**
 * Starts `choice` on `target` (the caller checked `editChoiceReason`): Editor's notes as the scene
 * action on the open scene, or the pass through the edit-pass store, which toasts a failure.
 * Answers the turn's text and the pass id, or null when the pass did not start.
 */
export async function runEditChoice(
  choice: EditChoice,
  instruction: string | null,
  target: EditTarget,
  open: OpenScene
): Promise<{ content: string; passId: string | null } | null> {
  const pass = choicePass(choice, instruction)
  if (pass === null) {
    if (open.editor === null || open.nodeId === null) return null
    return { content: startSceneAction('critique', open.nodeId, open.editor), passId: null }
  }
  const started = await useEditPassStore.getState().start({
    type: pass.type,
    instruction: pass.instruction,
    nodeIds: target.nodeIds,
    excerpt: target.excerpt
  })
  if (!started) return null
  return { content: startedText(choice, target), passId: useEditPassStore.getState().startedHere }
}
