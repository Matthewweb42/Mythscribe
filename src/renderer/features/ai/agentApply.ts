import type { Editor } from '@tiptap/core'
import { describeEdit, type AgentEdit } from '@shared/agent'
import { clearSelectionOf } from '@shared/bibleClear'
import { NO_UNDO_REASON, changeLabel } from '@shared/changes'
import type { EntityFieldId, EntityFields } from '@shared/entities'
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
import {
  forgetRecords,
  logAppliedChange,
  logAppliedChanges,
  refreshLibraryAndNotes,
  useChangesStore,
  type ChangeRun
} from '@renderer/features/changes/changesStore'
// The story-bible edits (F-5.25) go through Organise's own apply, which in turn uses this file
// for binder edits; both only call each other at run time.
import { applyOrganiseAction } from '@renderer/features/organise/organiseApply'
import { useEntityDraftStore } from '@renderer/features/entities/entityDraftStore'
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
 *
 * F-9.15: an edit of the story bible (a sheet field, a tag on a scene, a deleted sheet or tag) is
 * logged in the Changes log under `run` (the chat turn), and its undo is the log's, so the chat's
 * Undo and Changes are one owner. Text, notes, and structure keep their own undo here.
 */
export async function applyAgentEdit(
  edit: AgentEdit,
  proposalId: string,
  run: ChangeRun
): Promise<(() => Promise<void>) | null> {
  const label = changeLabel(describeEdit(edit))
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
      return logAppliedChange(
        run,
        {
          kind: 'sheetEdit',
          label,
          undo: {
            type: 'restoreSheet',
            entityId: edit.entityId,
            before: { fields: { [edit.field]: edit.before } },
            after: { fields: { [edit.field]: edit.after } }
          }
        },
        () => setSheetField(edit.entityId, edit.field, edit.before)
      )
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
      if (edit.add) await links.add(edit.nodeId, tagId)
      else await links.remove(edit.nodeId, tagId)
      return logAppliedChange(
        run,
        {
          kind: 'tagLink',
          label,
          undo: { type: edit.add ? 'unlinkTag' : 'linkTag', nodeId: edit.nodeId, tagId }
        },
        edit.add
          ? () => useDocumentTagStore.getState().remove(edit.nodeId, tagId)
          : () => useDocumentTagStore.getState().add(edit.nodeId, tagId)
      )
    }
    case 'delete': {
      if (edit.target === 'node') {
        await useTreeStore.getState().remove(edit.id)
        return null
      }
      if (edit.target === 'sheet') await useEntityStore.getState().remove(edit.id)
      else await useTagStore.getState().remove(edit.id)
      return logAppliedChange(
        run,
        {
          kind: 'delete',
          label,
          targetId: edit.id,
          undo: { type: 'none', reason: NO_UNDO_REASON.delete }
        },
        null
      )
    }
    case 'clear': {
      // F-5.25: the open sheet page and unsaved notes are saved first, so the backup and the
      // Undo hold what is on screen. Main backs up, clears, and logs one row; its Undo is ours.
      await useEntityDraftStore.getState().flush()
      await useNotesStore.getState().flush()
      const result = await ipc().invoke('bible:clear', {
        selection: clearSelectionOf(edit.options),
        run: run.run
      })
      const draft = useEntityDraftStore.getState().draft
      if (draft !== null && result.removedEntityIds.includes(draft.id)) {
        useEntityDraftStore.getState().close()
      }
      forgetRecords(result.removedEntityIds, result.removedTagIds)
      refreshLibraryAndNotes()
      const id = result.entry.id
      return () => useChangesStore.getState().undo(id)
    }
    case 'tagMany': {
      // F-5.25: one tag on or off many documents; each link is a row of the turn's run, and the
      // Undo takes them all back. A failure part-way puts back what it did, then reports.
      const tagId = await tagIdFor(edit.tag, edit.add)
      const set = (nodeId: string, on: boolean): Promise<void> =>
        on
          ? useDocumentTagStore.getState().add(nodeId, tagId)
          : useDocumentTagStore.getState().remove(nodeId, tagId)
      const done: string[] = []
      try {
        for (const node of edit.nodes) {
          await set(node.nodeId, edit.add)
          done.push(node.nodeId)
        }
      } catch (err) {
        for (const nodeId of done.reverse()) await set(nodeId, !edit.add)
        throw err
      }
      return logAppliedChanges(
        run,
        edit.nodes.map((node) => ({
          kind: 'tagLink' as const,
          label: changeLabel(describeEdit({ kind: 'tag', ...node, tag: edit.tag, add: edit.add })),
          undo: {
            type: edit.add ? ('unlinkTag' as const) : ('linkTag' as const),
            nodeId: node.nodeId,
            tagId
          }
        })),
        async () => {
          for (const node of [...edit.nodes].reverse()) await set(node.nodeId, !edit.add)
        }
      )
    }
    case 'moveMany': {
      // F-5.25: each item to the end of the folder in turn; the Undo moves them back newest first.
      const back: { nodeId: string; parentId: string; previous: string | null }[] = []
      for (const node of edit.nodes) {
        const tree = useTreeStore.getState()
        const parentId = tree.byId[node.nodeId]?.parentId ?? null
        if (parentId === null) throw new AgentEditError(`${node.title} is no longer in the project`)
        const siblings = tree.childrenOf[parentId] ?? []
        const index = siblings.indexOf(node.nodeId)
        const previous = index > 0 ? (siblings[index - 1] ?? null) : null
        const last =
          (tree.childrenOf[edit.parentId] ?? []).filter((id) => id !== node.nodeId).at(-1) ?? null
        await tree.move(node.nodeId, edit.parentId, last)
        back.push({ nodeId: node.nodeId, parentId, previous })
      }
      return async () => {
        for (const step of [...back].reverse()) {
          await useTreeStore.getState().move(step.nodeId, step.parentId, step.previous)
        }
      }
    }
    case 'tagRename':
      return applyOrganiseAction(
        {
          kind: 'tag',
          tagId: edit.tagId,
          name: edit.name,
          patch: { name: edit.after },
          before: { name: edit.name },
          parentName: null,
          beforeParentName: null
        },
        new Map(),
        proposalId,
        run
      )
    case 'sheetPatch': {
      // One logged change per sheet (Organise's own sheet change); the Undo takes them back in turn.
      const undos: (() => Promise<void>)[] = []
      for (const sheet of edit.sheets) {
        const undo = await applyOrganiseAction(
          {
            kind: 'sheet',
            entityId: sheet.entityId,
            name: sheet.name,
            patch: {
              ...(edit.rename === null ? {} : { name: edit.rename }),
              ...(edit.to === null ? {} : { kind: edit.to })
            },
            before: {
              ...(edit.rename === null ? {} : { name: sheet.name }),
              ...(edit.to === null ? {} : { kind: sheet.kind })
            }
          },
          new Map(),
          proposalId,
          run
        )
        if (undo !== null) undos.push(undo)
      }
      return undos.length === 0
        ? null
        : async () => {
            for (const undo of [...undos].reverse()) await undo()
          }
    }
    case 'sheetMerge':
      return applyOrganiseAction(
        {
          kind: 'mergeSheets',
          target: edit.target,
          sources: edit.sources,
          withText: edit.withText
        },
        new Map(),
        proposalId,
        run
      )
    case 'sheetCreate':
      return applyOrganiseAction(
        { kind: 'createSheet', category: edit.category, name: edit.name, fields: {}, aliases: [] },
        new Map(),
        proposalId,
        run
      )
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
export async function rewriteNotes(
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

/** A sheet's text as its owner holds it now. */
export interface SheetText {
  fields: EntityFields
  body: string
}

/**
 * Changes a sheet through its one owner. When the sheet's page is open, that is the page's
 * draft: the change is made there (the author's unsaved typing is kept, and the page shows the
 * change) and written at once, so the draft never writes the old text back over it. Otherwise it
 * is the entity store, reading the sheet first if the store does not hold it. `fields` is merged
 * over the sheet's own; an empty `body` means no page.
 */
export async function patchSheet(
  entityId: string,
  change: (sheet: SheetText) => { fields?: EntityFields; body?: string }
): Promise<void> {
  const drafts = useEntityDraftStore.getState()
  if (drafts.draft?.id === entityId) {
    drafts.edit(change({ fields: drafts.draft.fields, body: drafts.draft.body }))
    await useEntityDraftStore.getState().flush()
    const after = useEntityDraftStore.getState()
    // Written and not typed into since: the page starts again from the row as stored. A failed
    // write keeps the change in the draft, which reports it and tries again on the next edit.
    const stored = useEntityStore.getState().byId[entityId]
    if (after.draft?.id === entityId && after.status === 'saved' && stored !== undefined) {
      after.open(stored)
    }
    return
  }
  const store = useEntityStore.getState()
  const entity = store.byId[entityId] ?? (await ipc().invoke('entity:get', { id: entityId }))
  const patch = change({ fields: entity.fields, body: entity.body ?? '' })
  await store.update(entityId, {
    ...(patch.fields === undefined ? {} : { fields: { ...entity.fields, ...patch.fields } }),
    ...(patch.body === undefined ? {} : { body: patch.body === '' ? null : patch.body })
  })
}

/** Sets one field of a sheet through its one owner (`patchSheet`). */
export async function setSheetField(
  entityId: string,
  field: EntityFieldId,
  value: string
): Promise<void> {
  await patchSheet(entityId, () => ({ fields: { [field]: value } }))
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
