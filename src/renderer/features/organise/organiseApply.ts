import { NO_UNDO_REASON, changeLabel, type ChangeKind } from '@shared/changes'
import { AgentEditError } from '@renderer/features/editor/agentEditing'
import { appendNotePoints } from '@renderer/features/editor/sceneSuggestStore'
import { applyAgentEdit, rewriteNotes } from '@renderer/features/ai/agentApply'
import { logAppliedChange, type ChangeRun } from '@renderer/features/changes/changesStore'
import { useCategoryStore } from '@renderer/features/entities/categoryStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeOrganiseAction, type OrganiseAction, type SheetPatch } from '@shared/organise'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'

/**
 * Applies one change of an Organise plan (F-9.10) through the stores the author's own clicks use,
 * so every store stays the one owner of its records: tags through the tag store, sheets through
 * the entity store (a merge through `entity:merge`), a new category through the category store,
 * notes through the notes write path, the binder through the chat agent's structure edits.
 * Nothing here touches manuscript text. Answers the undo, or null for a change that has none (a
 * merge, a deletion, a new category; those always ask first).
 *
 * F-9.15: every story-bible change (a tag, a sheet, a merge, a deletion, a new category) is
 * logged in the Changes log under the plan's run, and its undo is the log's, so the plan screen
 * and Changes take it back through one owner. Notes and the binder are no story bible: they keep
 * their own undo here.
 *
 * `categoryIds` maps the id a proposed category had in the plan to the id it got once created,
 * so a sheet moved into it lands there; applying a new category records its id there.
 */
export async function applyOrganiseAction(
  action: OrganiseAction,
  categoryIds: Map<string, string>,
  proposalId: string,
  run: ChangeRun
): Promise<(() => Promise<void>) | null> {
  const label = changeLabel(describeOrganiseAction(action, (id) => categoryName(id, categoryIds)))
  /** Logs a change nothing can take back, under the plan's run. */
  const logFinal = async (
    kind: Extract<ChangeKind, 'merge' | 'delete' | 'category'>,
    targetId: string
  ): Promise<null> => {
    await logAppliedChange(
      run,
      { kind, label, targetId, undo: { type: 'none', reason: NO_UNDO_REASON[kind] } },
      null
    )
    return null
  }
  switch (action.kind) {
    case 'mergeTags': {
      await useTagStore.getState().mergeInto(
        action.target.id,
        action.sources.map((source) => source.id)
      )
      return logFinal('merge', action.target.id)
    }
    case 'tag': {
      await useTagStore.getState().update(action.tagId, action.patch)
      return logAppliedChange(
        run,
        {
          kind: 'tagEdit',
          label,
          undo: {
            type: 'restoreTag',
            tagId: action.tagId,
            before: action.before,
            after: action.patch
          }
        },
        async () => {
          await useTagStore.getState().update(action.tagId, action.before)
        }
      )
    }
    case 'deleteTag': {
      await useTagStore.getState().remove(action.tagId)
      return logFinal('delete', action.tagId)
    }
    case 'mergeSheets': {
      await useEntityStore.getState().mergeSheets(
        action.target.id,
        action.sources.map((source) => source.id)
      )
      return logFinal('merge', action.target.id)
    }
    case 'sheet': {
      const after = sheetPatch(action.patch, categoryIds)
      const before = sheetPatch(action.before, categoryIds)
      await useEntityStore.getState().update(action.entityId, after)
      return logAppliedChange(
        run,
        {
          kind: 'sheetEdit',
          label,
          undo: { type: 'restoreSheet', entityId: action.entityId, before, after }
        },
        async () => {
          await useEntityStore.getState().update(action.entityId, before)
        }
      )
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
      const madeTagId =
        created.tagId !== null && tagsBefore[created.tagId] === undefined ? created.tagId : null
      const modified = useEntityStore.getState().byId[created.id]?.modified ?? created.modified
      return logAppliedChange(
        run,
        {
          kind: 'record',
          label,
          undo: { type: 'deleteSheet', entityId: created.id, tagId: madeTagId, modified }
        },
        async () => {
          await useEntityStore.getState().remove(created.id)
          if (madeTagId !== null) await useTagStore.getState().remove(madeTagId)
        }
      )
    }
    case 'deleteSheet': {
      await useEntityStore.getState().remove(action.entityId)
      return logFinal('delete', action.entityId)
    }
    case 'category': {
      const created = await useCategoryStore.getState().create({
        name: action.name,
        noun: action.noun,
        fields: action.fields
      })
      categoryIds.set(action.id, created.id)
      return logFinal('category', created.id)
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
      return applyAgentEdit(edit, proposalId, run)
    }
  }
}

/** A category's name for the log line: the project's, else the id (a proposed one is created first). */
function categoryName(id: string, categoryIds: ReadonlyMap<string, string>): string {
  const real = categoryIds.get(id) ?? id
  return useCategoryStore.getState().categories.find((category) => category.id === real)?.name ?? id
}

/** A sheet patch as `entity:update` takes it: a proposed category under the id it now has. */
function sheetPatch(patch: SheetPatch, categoryIds: ReadonlyMap<string, string>): SheetPatch {
  return patch.kind === undefined
    ? patch
    : { ...patch, kind: categoryIds.get(patch.kind) ?? patch.kind }
}
