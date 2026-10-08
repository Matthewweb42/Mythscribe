import type { Editor } from '@tiptap/core'
import type { AgentEdit } from '@shared/agent'
import type { EntityFieldId } from '@shared/entities'
import { AI_ORIGIN_MARK } from '@shared/provenance'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { editorFor } from '@renderer/features/editor/activeEditorStore'
import {
  AgentEditError,
  appendBlocks,
  cutFromParagraph,
  insertParagraphs,
  paragraphsFrom,
  replacePassage,
  undoInsertParagraphs,
  undoReplacePassage
} from '@renderer/features/editor/agentEditing'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { useNotesStore } from '@renderer/features/editor/notesStore'
import { patchSceneMeta } from '@renderer/features/editor/sceneMetaStore'
import { appendNotePoints } from '@renderer/features/editor/sceneSuggestStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { ipc } from '@renderer/lib/ipc'

/**
 * Applies one of the chat agent's edits (F-5.22) through the same paths the author's own clicks
 * take, so every store stays the one owner of its records: text goes through the scene's live
 * editor (opened for the purpose, so Ctrl+Z works and the author sees it land), the synopsis
 * through the scene-metadata store, notes through the notes write path, sheets and tags through
 * their stores, structure through the tree store. Answers the undo, or null for an edit that has
 * none (a deletion, a merge; both always asked first). Throws with a message for the author when
 * the book has moved on and the edit no longer fits.
 */
export async function applyAgentEdit(
  edit: AgentEdit,
  proposalId: string
): Promise<(() => Promise<void>) | null> {
  switch (edit.kind) {
    case 'text': {
      const undo = replacePassage(
        await openEditor(edit.nodeId),
        edit.find,
        edit.replace,
        proposalId
      )
      return async () => undoReplacePassage(await openEditor(edit.nodeId), undo)
    }
    case 'insert': {
      const text = insertParagraphs(
        await openEditor(edit.nodeId),
        edit.after,
        edit.text,
        proposalId
      )
      return async () => undoInsertParagraphs(await openEditor(edit.nodeId), text)
    }
    case 'synopsis': {
      await patchSceneMeta(edit.nodeId, (meta) => ({ ...meta, synopsis: edit.after }))
      return () => patchSceneMeta(edit.nodeId, (meta) => ({ ...meta, synopsis: edit.before }))
    }
    case 'notes': {
      const points = notePoints(edit.add)
      let after: TiptapNodeT = EMPTY_DOC
      const before = await rewriteNotes(edit.nodeId, (stored) => {
        after = appendNotePoints(stored, points)
        return after
      })
      return async () => {
        await rewriteNotes(edit.nodeId, (stored) => {
          if (JSON.stringify(stored) !== JSON.stringify(after)) {
            throw new AgentEditError('The notes changed since; edit them by hand')
          }
          return before
        })
      }
    }
    case 'sheet': {
      await setSheetField(edit.entityId, edit.field, edit.after)
      return () => setSheetField(edit.entityId, edit.field, edit.before)
    }
    case 'create': {
      const node = await useTreeStore
        .getState()
        .createIn(edit.level, edit.parentId, edit.afterId, edit.title)
      if (node === null) throw new AgentEditError('The project closed')
      if (edit.text !== '') await writeDocument(node.id, proseDocument(edit.text, proposalId))
      return () => useTreeStore.getState().remove(node.id)
    }
    case 'rename': {
      await useTreeStore.getState().rename(edit.nodeId, edit.after)
      return () => useTreeStore.getState().rename(edit.nodeId, edit.title)
    }
    case 'move': {
      const tree = useTreeStore.getState()
      const parentId = tree.byId[edit.nodeId]?.parentId ?? null
      if (parentId === null) throw new AgentEditError(`${edit.title} is no longer in the project`)
      const siblings = tree.childrenOf[parentId] ?? []
      const index = siblings.indexOf(edit.nodeId)
      const previous = index > 0 ? (siblings[index - 1] ?? null) : null
      await tree.move(edit.nodeId, edit.parentId, edit.afterId)
      return () => useTreeStore.getState().move(edit.nodeId, parentId, previous)
    }
    case 'split': {
      const parentId = useTreeStore.getState().byId[edit.nodeId]?.parentId ?? null
      if (parentId === null) throw new AgentEditError(`${edit.title} is no longer in the project`)
      // The new scene is written before anything leaves the old one, so a failure loses nothing.
      const moved = paragraphsFrom(await openEditor(edit.nodeId), edit.at)
      const node = await useTreeStore
        .getState()
        .createIn('scene', parentId, edit.nodeId, edit.newTitle)
      if (node === null) throw new AgentEditError('The project closed')
      await writeDocument(node.id, moved)
      const cut = cutFromParagraph(await openEditor(edit.nodeId), edit.at)
      return async () => {
        await useTreeStore.getState().remove(node.id)
        appendBlocks(await openEditor(edit.nodeId), cut)
      }
    }
    case 'merge': {
      await useDocumentStore.getState().flush()
      const source = (await ipc().invoke('document:get', { id: edit.nodeId })).content
      if (source !== null) appendBlocks(await openEditor(edit.intoId), source)
      await useDocumentStore.getState().flush()
      await useTreeStore.getState().remove(edit.nodeId)
      return null
    }
    case 'tag': {
      const tagId = await tagIdFor(edit.tag, edit.add)
      const links = useDocumentTagStore.getState()
      if (edit.add) {
        await links.add(edit.nodeId, tagId)
        return () => useDocumentTagStore.getState().remove(edit.nodeId, tagId)
      }
      await links.remove(edit.nodeId, tagId)
      return () => useDocumentTagStore.getState().add(edit.nodeId, tagId)
    }
    case 'delete': {
      if (edit.target === 'node') await useTreeStore.getState().remove(edit.id)
      else if (edit.target === 'sheet') await useEntityStore.getState().remove(edit.id)
      else await useTagStore.getState().remove(edit.id)
      return null
    }
  }
}

/** Opens a document in the editor pane (the tree's selection drives it) and answers its live editor. */
export async function openEditor(nodeId: string): Promise<Editor> {
  useTreeStore.getState().select(nodeId)
  const editor = await editorFor(nodeId)
  if (editor === null || editor.isDestroyed) throw new AgentEditError('The scene did not open')
  return editor
}

/** The points an edit adds to the notes: one per line, without the bullet the model may have written. */
export function notePoints(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line !== '')
}

/**
 * Rewrites a node's notes from what is stored (the author's unsaved notes are saved first, and
 * a loaded record is read again so its editor shows the result). Answers what was stored before.
 */
async function rewriteNotes(
  nodeId: string,
  change: (stored: TiptapNodeT) => TiptapNodeT
): Promise<TiptapNodeT> {
  await useNotesStore.getState().flush()
  const stored = (await ipc().invoke('notes:get', { id: nodeId })).notes ?? EMPTY_DOC
  await ipc().invoke('notes:save', { id: nodeId, notes: change(stored) })
  if (useNotesStore.getState().docs[nodeId] !== undefined) {
    await useNotesStore.getState().reload([nodeId])
  }
  return stored
}

async function setSheetField(entityId: string, field: EntityFieldId, value: string): Promise<void> {
  const store = useEntityStore.getState()
  const entity = store.byId[entityId] ?? (await ipc().invoke('entity:get', { id: entityId }))
  await store.update(entityId, { fields: { ...entity.fields, [field]: value } })
}

/** Saves a document main has not had yet (a new scene) and records its word count in the tree. */
async function writeDocument(nodeId: string, content: TiptapNodeT): Promise<void> {
  const saved = await ipc().invoke('document:save', { id: nodeId, content })
  useTreeStore.getState().setWordCount(nodeId, saved.wordCount)
}

/** Prose as a stored document: a paragraph per blank-line block, every text AI-origin marked. */
export function proseDocument(text: string, proposalId: string): TiptapNodeT {
  const mark = { type: AI_ORIGIN_MARK, attrs: { proposalId, accepted: text.length } }
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter((paragraph) => paragraph !== '')
  return {
    type: 'doc',
    content: paragraphs.map((paragraph) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: paragraph, marks: [mark] }]
    }))
  }
}

/** The bank's tag of that name; one to add that does not exist yet is created under Custom. */
async function tagIdFor(name: string, create: boolean): Promise<string> {
  const bank = useTagStore.getState()
  const existing = Object.values(bank.byId).find((tag) => tag.name === name)
  if (existing) return existing.id
  if (!create) throw new AgentEditError(`There is no tag #${name}`)
  return (await bank.create({ name, category: 'custom' })).id
}
