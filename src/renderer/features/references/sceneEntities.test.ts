import { describe, expect, it } from 'vitest'
import type { Entity } from '@shared/ipc/contract'
import type { TagMentions } from '@shared/mentions'
import { entityFixture } from '@renderer/features/entities/entityFixture'
import { sceneEntityIds } from './sceneEntities'

const TAGS: Record<string, string> = {
  'e-aldous': 't-aldous',
  'e-mara': 't-mara',
  'e-forest': 't-forest',
  'e-blood': 't-blood'
}
/** The fixture with a linked tag on every entity but The Guild. */
const entities: Entity[] = entityFixture.map((entity) => ({
  ...entity,
  tagId: TAGS[entity.id] ?? null
}))

const mention = (tagId: string, ...starts: number[]): TagMentions => ({
  tagId,
  nodeId: 'sc-1',
  count: Math.max(starts.length, 1),
  ranges: starts.map((from) => [from, from + 4])
})

describe('sceneEntityIds (F-9.7)', () => {
  it('lists the entities the text names in the order of their first occurrence', () => {
    const ids = sceneEntityIds(entities, [mention('t-mara', 40, 12), mention('t-forest', 3)], [])
    expect(ids).toEqual(['e-forest', 'e-mara'])
  })

  it('puts entities that are only tagged after the named ones, by name', () => {
    const ids = sceneEntityIds(
      entities,
      [mention('t-mara', 5)],
      ['t-forest', 't-aldous', 't-mara', 't-unlinked']
    )
    expect(ids).toEqual(['e-mara', 'e-aldous', 'e-forest'])
  })

  it('leaves out an entity without a tag and a tag without an entity', () => {
    expect(sceneEntityIds(entities, [mention('t-nobody', 1)], ['t-nobody'])).toEqual([])
    expect(sceneEntityIds(entityFixture, [mention('t-mara', 1)], ['t-mara'])).toEqual([])
  })

  it('keeps a mention whose positions could not be read, after the placed ones', () => {
    const ids = sceneEntityIds(entities, [mention('t-blood'), mention('t-mara', 900)], [])
    expect(ids).toEqual(['e-mara', 'e-blood'])
  })
})
