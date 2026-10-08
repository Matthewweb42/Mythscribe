import { AgentEditError } from '@renderer/features/editor/agentEditing'
import { appendNotePoints } from '@renderer/features/editor/sceneSuggestStore'
import { applyAgentEdit, rewriteNotes } from '@renderer/features/ai/agentApply'
import { useCategoryStore } from '@renderer/features/entities/categoryStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import type { OrganiseAction, SheetPatch } from '@shared/organise'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'

/**
 * Applies one change of an Organise plan (F-9.10) through the stores the author's own clicks use,
 * so every store stays the one owner of its records: tags through the tag store, sheets through
 * the entity store (a merge through `entity:merge`), a new category through the category store,
 * notes through the notes write path, the binder through the chat agent's structure edits.
 * Nothing here touches manuscript text. Answers the undo, or null for a change that has none (a
 * merge, a deletion, a new category; those always ask first).
 *
 * `categoryIds` maps the id a proposed category had in the plan to the id it got once created,
 * so a sheet moved into it lands there; applying a new category records its id there.
 */
export async function applyOrganiseAction(
  action: OrganiseAction,
  categoryIds: Map<string, string>,
  proposalId: string
): Promise<(() => Promise<void>) | null> {
  switch (action.kind) {
    case 'mergeTags': {
      await useTagStore.getState().mergeInto(
        action.target.id,
        action.sources.map((source) => source.id)
      )
      return null
    }
    case 'tag': {
      await useTagStore.getState().update(action.tagId, action.patch)
      return async () => {
        await useTagStore.getState().update(action.tagId, action.before)
      }
    }
    case 'deleteTag': {
      await useTagStore.getState().remove(action.tagId)
      return null
    }
    case 'mergeSheets': {
      await useEntityStore.getState().mergeSheets(
        action.target.id,
        action.sources.map((source) => source.id)
      )
      return null
    }
    case 'sheet': {
      await useEntityStore.getState().update(action.entityId, sheetPatch(action.patch, categoryIds))
      return async () => {
        await useEntityStore
          .getState()
          .update(action.entityId, sheetPatch(action.before, categoryIds))
      }
    }
    case 'createSheet': {
      const store = useEntityStore.getState()
      const tagsBefore = useTagStore.getState().byId
      const created = await store.create({
        kind: categoryIds.get(action.category) ?? action.category,
        name: action.name,
        template: 'structured',
        fields: action.fields
      })
      if (action.aliases.length > 0) {
        await useEntityStore.getState().update(created.id, { aliases: action.aliases })
      }
      // A new sheet makes its own #name tag (F-9.4); undoing the sheet removes that tag too.
      const madeTag = created.tagId !== null && tagsBefore[created.tagId] === undefined
      return async () => {
        await useEntityStore.getState().remove(created.id)
        if (madeTag && created.tagId !== null) await useTagStore.getState().remove(created.tagId)
      }
    }
    case 'deleteSheet': {
      await useEntityStore.getState().remove(action.entityId)
      return null
    }
    case 'category': {
      const created = await useCategoryStore.getState().create({
        name: action.name,
        noun: action.noun,
        fields: action.fields
      })
      categoryIds.set(action.id, created.id)
      return null
    }
    case 'notes': {
      let after: TiptapNodeT = EMPTY_DOC
      const before = await rewriteNotes(action.nodeId, () => {
        after = appendNotePoints(EMPTY_DOC, action.points)
        return after
      })
      return async () => {
        await rewriteNotes(action.nodeId, (stored) => {
          if (JSON.stringify(stored) !== JSON.stringify(after)) {
            throw new AgentEditError('The notes changed since; edit them by hand')
          }
          return before
        })
      }
    }
    case 'binder': {
      const edit = action.edit
      // Deleting a folder deletes what is in it: check again now, since the plan or the author
      // may have filled it after the plan was made.
      if (edit.kind === 'delete' && edit.target === 'node') {
        const children = useTreeStore.getState().childrenOf[edit.id] ?? []
        if (children.length > 0) throw new AgentEditError(`${edit.name} is no longer empty`)
      }
      return applyAgentEdit(edit, proposalId)
    }
  }
}

/** A sheet patch as `entity:update` takes it: a proposed category under the id it now has. */
function sheetPatch(patch: SheetPatch, categoryIds: ReadonlyMap<string, string>): SheetPatch {
  return patch.kind === undefined
    ? patch
    : { ...patch, kind: categoryIds.get(patch.kind) ?? patch.kind }
}
