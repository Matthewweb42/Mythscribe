import { useMemo, useState } from 'react'
import { isManuscriptDocument, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { listOutline } from '@renderer/features/outline/outlineRows'

/**
 * The as-of scene of the views that read the book up to a scene (F-16.18, F-16.22; the
 * `AsOfPicker`): the manuscript's scenes in reading order, and the scene each view starts on.
 */

export interface AsOfScene {
  id: string
  title: string
}

/** The manuscript's scenes in the order the Outline shows them, each with its title. */
export function useManuscriptScenes(): AsOfScene[] {
  const rootIds = useTreeStore((s) => s.rootIds)
  const childrenOf = useTreeStore((s) => s.childrenOf)
  const sectionOf = useTreeStore((s) => s.sectionOf)
  const byId = useTreeStore((s) => s.byId)
  return useMemo(
    () =>
      listOutline(rootIds, childrenOf, sectionOf).flatMap(({ id }) => {
        const node = byId[id]
        return node !== undefined && isManuscriptDocument({ byId, sectionOf }, id)
          ? [{ id, title: node.title.trim() === '' ? 'Untitled scene' : node.title }]
          : []
      }),
    [rootIds, childrenOf, sectionOf, byId]
  )
}

/** The manuscript scene open in the editor, or null. */
export function useOpenScene(): string | null {
  return useTreeStore((s) =>
    s.selectedId !== null && isManuscriptDocument(s, s.selectedId) ? s.selectedId : null
  )
}

/**
 * A view's as-of scene: it starts on `start` (by default the open scene); the author's pick holds
 * until she picks again; a scene no longer in the manuscript reads as the end of the book. Answers
 * the scene (null: the end of the book), the scenes to pick from, and the setter.
 */
export function useAsOf(start?: string | null): {
  asOf: string | null
  scenes: AsOfScene[]
  setAsOf: (asOf: string | null) => void
} {
  const open = useOpenScene()
  const [asOf, setAsOf] = useState<string | null>(start === undefined ? open : start)
  const scenes = useManuscriptScenes()
  const picked = asOf !== null && scenes.some((scene) => scene.id === asOf) ? asOf : null
  return { asOf: picked, scenes, setAsOf }
}
