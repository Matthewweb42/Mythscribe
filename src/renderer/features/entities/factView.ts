import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { categoryOf } from '@shared/categories'
import { sheetAt, type Fact, type SheetFieldAt } from '@shared/facts'
import type { Entity } from '@shared/ipc/contract'
import { resolveNow } from '@shared/storyTime'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { useOpenSceneId } from '@renderer/features/references/sceneEntities'
import {
  descendantDocuments,
  useTreeStore,
  type TreeIndex
} from '@renderer/features/manuscript/treeStore'
import { useCategoryStore } from './categoryStore'
import { useFactStore } from './factStore'

/** How many values the reference card shows before "+ n more" (F-9.13). */
export const FACTS_COMPACT = 3

/**
 * The manuscript's documents in reading order (D2: a story position is the reading order of the
 * manuscript; front and end matter are not story time). What `sheetAt` dates facts by.
 */
export function manuscriptOrder(
  index: Pick<TreeIndex, 'byId' | 'childrenOf' | 'rootIds'>
): string[] {
  const root = index.rootIds.find((id) => index.byId[id]?.sectionType === 'manuscript')
  return root === undefined ? [] : descendantDocuments(index, root)
}

/** Where a sheet is read at: now (D3), a chosen scene, or the end of the book. */
export type AsOf = { type: 'now' } | { type: 'scene'; id: string } | { type: 'end' }

/** The `<select>` value an `AsOf` is written as, and back. */
export function asOfValue(asOf: AsOf): string {
  return asOf.type === 'scene' ? `scene:${asOf.id}` : asOf.type
}

export function parseAsOf(value: string): AsOf {
  if (value.startsWith('scene:')) return { type: 'scene', id: value.slice('scene:'.length) }
  return value === 'end' ? { type: 'end' } : { type: 'now' }
}

/** The manuscript order, now (the open scene, else the latest written one), and their titles. */
export interface StoryClock {
  order: string[]
  nowId: string | null
  titleOf: (id: string) => string
}

/** The story clock of the open project, from the tree store; re-renders as the tree changes. */
export function useStoryClock(): StoryClock {
  const index = useTreeStore(
    useShallow((s) => ({ byId: s.byId, childrenOf: s.childrenOf, rootIds: s.rootIds }))
  )
  const openId = useOpenSceneId()
  return useMemo(() => {
    const order = manuscriptOrder(index)
    const documents = order.map((id) => ({ id, wordCount: index.byId[id]?.wordCount ?? 0 }))
    const now = resolveNow(documents, openId)
    return {
      order,
      nowId: now.nowId,
      titleOf: (id: string) => index.byId[id]?.title ?? 'a deleted scene'
    }
  }, [index, openId])
}

/** The scene id a sheet is read at for `asOf`; null is the end of the book. */
export function positionOf(asOf: AsOf, clock: StoryClock): string | null {
  if (asOf.type === 'end') return null
  if (asOf.type === 'scene') return clock.order.includes(asOf.id) ? asOf.id : null
  return clock.nowId
}

/** Stable empty list, so a selector for a record not yet read does not re-render on every change. */
const NO_FACTS: readonly Fact[] = []

/** The record's facts from the store, loaded when the record is shown. */
export function useRecordFacts(entityId: string): readonly Fact[] {
  const facts = useFactStore((s) => s.byEntity[entityId] ?? NO_FACTS)
  useEffect(() => {
    useFactStore
      .getState()
      .load(entityId)
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [entityId])
  return facts
}

/** The record as of `asOf` (`sheetAt`): one row per template field and per attribute only facts carry. */
export function useSheetAt(
  entity: Entity,
  facts: readonly Fact[],
  asOf: AsOf,
  clock: StoryClock
): SheetFieldAt[] {
  const categories = useCategoryStore((s) => s.categories)
  const attributes = useMemo(
    () => categoryOf(entity.kind, categories).fields.map((field) => field.id),
    [entity.kind, categories]
  )
  const position = positionOf(asOf, clock)
  return useMemo(
    () =>
      sheetAt({
        facts,
        fields: entity.template === 'structured' ? entity.fields : {},
        attributes,
        order: clock.order,
        position
      }),
    [facts, entity.fields, entity.template, attributes, clock.order, position]
  )
}
