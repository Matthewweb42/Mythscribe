import { useMemo } from 'react'
import { tagFilterView } from '@renderer/features/manuscript/tagFilter'
import type { TreeIndex } from '@renderer/features/manuscript/treeStore'
import { filterLabelOf, useLabelStore, type LabelSurface } from './labelStore'

/** "3 documents carry Wry" / "1 document carries Wry" / "No documents carry Wry". */
export function labelCountLabel(count: number, name: string): string {
  if (count === 0) return `No documents carry ${name}`
  if (count === 1) return `1 document carries ${name}`
  return `${count} documents carry ${name}`
}

/**
 * What a surface's label filter leaves on screen (F-16.7): the nodes carrying the label and their
 * ancestors, as v1's tag filter does (`tagFilterView`); null while the surface is unfiltered.
 */
export function useLabelFilterView(
  surface: LabelSurface,
  index: Pick<TreeIndex, 'rootIds' | 'childrenOf'>
): { visible: Set<string>; matches: Set<string>; colour: string } | null {
  const label = useLabelStore((s) => filterLabelOf(s, surface))
  const byNode = useLabelStore((s) => s.byNode)
  return useMemo(() => {
    if (label === undefined) return null
    const view = tagFilterView(index, byNode, label.id)
    return { visible: view.visible, matches: new Set(view.matches), colour: label.colour }
  }, [index, byNode, label])
}
