import { categoryFieldIds, type StoryCategory } from '@shared/categories'
import { REPLACE_FIELDS } from '@shared/facts'
import type { Entity } from '@shared/ipc/contract'
import { SCENE_BRIEF_FIELD_MAX } from '@shared/sceneMeta'
import { clipTodo, type TodoItem, type TodoTarget } from '@shared/todo'
import { rewriteNotes, setSheetField } from '@renderer/features/ai/agentApply'
import { patchSceneMeta } from '@renderer/features/editor/sceneMetaStore'
import { appendNotePoints } from '@renderer/features/editor/sceneSuggestStore'
import { getCategory } from '@renderer/features/entities/categoryStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { ipc } from '@renderer/lib/ipc'
import { useTodoStore } from './todoStore'

/** Whether Add can write anywhere for this target. */
export function canAdd(target: TodoTarget): boolean {
  return target.kind !== 'none'
}

/**
 * A field's value with the author's line added: the line alone into an empty field or a
 * single-valued one (an age, a role: the author chose the value), else after what is there, on a
 * new line in a multi-line field and after "; " in a one-line field.
 */
export function withLine(
  current: string,
  line: string,
  field: string,
  category: StoryCategory
): string {
  if (current.trim() === '' || REPLACE_FIELDS.includes(field)) return line
  const multiline = category.fields.find((each) => each.id === field)?.multiline ?? true
  return `${current.trimEnd()}${multiline ? '\n' : '; '}${line}`
}

/** The field a new record's line describes it in: Description, else Background, else none. */
function describeField(category: StoryCategory): string | null {
  const ids = categoryFieldIds(category)
  if (ids.includes('description')) return 'description'
  if (ids.includes('background')) return 'background'
  return null
}

async function entityOf(id: string): Promise<Entity> {
  return useEntityStore.getState().byId[id] ?? (await ipc().invoke('entity:get', { id }))
}

/**
 * Writes the author's line where the item points (F-9.16, Q2): a sheet field, a blank sheet's
 * page, a scene's notes, a field of its brief, or a new record, each through the renderer's own
 * owner of that record (the entity store, the notes write path, the scene-metadata store), so a
 * pending edit there is never overwritten. The line is the author's text: no AI mark, no proposal.
 * Then the item is settled as done. Never touches a scene's text.
 */
export async function applyPick(item: TodoItem, text: string): Promise<void> {
  const line = text.trim()
  const { target } = item
  switch (target.kind) {
    case 'field': {
      if (line === '') throw new Error('Write a line to add first')
      const entity = await entityOf(target.entityId)
      const category = getCategory(entity.kind)
      const current = entity.fields[target.field] ?? ''
      await setSheetField(
        target.entityId,
        target.field,
        withLine(current, line, target.field, category)
      )
      break
    }
    case 'page': {
      if (line === '') throw new Error('Write a line to add first')
      const entity = await entityOf(target.entityId)
      const body = (entity.body ?? '').trimEnd()
      await useEntityStore
        .getState()
        .update(target.entityId, { body: body === '' ? line : `${body}\n\n${line}` })
      break
    }
    case 'notes':
      if (line === '') throw new Error('Write a line to add first')
      await rewriteNotes(target.nodeId, (stored) => appendNotePoints(stored, [line]))
      break
    case 'brief': {
      if (line === '') throw new Error('Write a line to add first')
      const field = target.field
      await patchSceneMeta(target.nodeId, (meta) => ({
        ...meta,
        brief: { ...meta.brief, [field]: clipTodo(line, SCENE_BRIEF_FIELD_MAX) }
      }))
      break
    }
    case 'newRecord': {
      const field = describeField(getCategory(target.category))
      await useEntityStore.getState().create({
        kind: target.category,
        name: target.name,
        template: 'structured',
        ...(line !== '' && field !== null ? { fields: { [field]: line } } : {})
      })
      break
    }
    case 'none':
      throw new Error('This item has nowhere to add a line')
  }
  await useTodoStore.getState().settle(item.id, 'done')
}
