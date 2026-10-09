import { categoryFieldIds, type StoryCategory } from '@shared/categories'
import { REPLACE_FIELDS } from '@shared/facts'
import type { EntityKind } from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import { SCENE_BRIEF_FIELD_MAX } from '@shared/sceneMeta'
import { clipTodo, type TodoItem, type TodoTarget } from '@shared/todo'
import { patchSheet, rewriteNotes } from '@renderer/features/ai/agentApply'
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
 * A new record is made in `options.category` when the author picked one, else the item's guess.
 * Then the item is settled as done. Never touches a scene's text.
 */
export async function applyPick(
  item: TodoItem,
  text: string,
  options: { category?: EntityKind } = {}
): Promise<void> {
  const line = text.trim()
  const { target } = item
  switch (target.kind) {
    case 'field': {
      if (line === '') throw new Error('Write a line to add first')
      const category = getCategory((await entityOf(target.entityId)).kind)
      await patchSheet(target.entityId, (sheet) => ({
        fields: {
          [target.field]: withLine(sheet.fields[target.field] ?? '', line, target.field, category)
        }
      }))
      break
    }
    case 'page': {
      if (line === '') throw new Error('Write a line to add first')
      await patchSheet(target.entityId, (sheet) => {
        const body = sheet.body.trimEnd()
        return { body: body === '' ? line : `${body}\n\n${line}` }
      })
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
      const kind = options.category ?? target.category
      const field = describeField(getCategory(kind))
      await useEntityStore.getState().create({
        kind,
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
