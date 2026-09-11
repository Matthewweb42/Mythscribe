import { z } from 'zod'
import type { NovelFormat } from './ipc/contract'

/**
 * Node vocabulary shared by the database schema, the seed, and the UI.
 * Labels depend on the project format (F-1.3, F-1.5): a webnovel calls its
 * manuscript "Volume 1" and its parts "Arcs"; an epic calls its manuscript "Series".
 */

export const SECTION_TYPES = ['front', 'manuscript', 'end'] as const
export const SectionType = z.enum(SECTION_TYPES)
export type SectionType = z.infer<typeof SectionType>

export const HIERARCHY_LEVELS = ['part', 'chapter', 'scene'] as const
export const HierarchyLevel = z.enum(HIERARCHY_LEVELS)
export type HierarchyLevel = z.infer<typeof HierarchyLevel>

export const NODE_KINDS = ['folder', 'document'] as const
export const NodeKind = z.enum(NODE_KINDS)
export type NodeKind = z.infer<typeof NodeKind>

const FORMAT_LABEL: Record<NovelFormat, string> = {
  novel: 'Novel',
  epic: 'Epic',
  webnovel: 'Web novel'
}

const MANUSCRIPT_LABEL: Record<NovelFormat, string> = {
  novel: 'Manuscript',
  epic: 'Series',
  webnovel: 'Volume 1'
}

const PART_LABEL: Record<NovelFormat, string> = {
  novel: 'Part',
  epic: 'Part',
  webnovel: 'Arc'
}

/** Display name of a project format (F-1.5), as shown in the wizard, recents, and the shell. */
export function formatLabel(format: NovelFormat): string {
  return FORMAT_LABEL[format]
}

/** Display name of one of the three root sections for the given format. */
export function sectionLabel(format: NovelFormat, sectionType: SectionType): string {
  switch (sectionType) {
    case 'front':
      return 'Front Matter'
    case 'manuscript':
      return MANUSCRIPT_LABEL[format]
    case 'end':
      return 'End Matter'
  }
}

/** Display name of a hierarchy level for the given format. */
export function levelLabel(format: NovelFormat, level: HierarchyLevel): string {
  switch (level) {
    case 'part':
      return PART_LABEL[format]
    case 'chapter':
      return 'Chapter'
    case 'scene':
      return 'Scene'
  }
}

/**
 * Where a hierarchy level may live (F-2.2 create, F-2.4 move): a part under the manuscript root,
 * a chapter under a part, a scene under a chapter. Generic nodes (no level) may live in any folder.
 * One owner for the structural rule; main validates with it and the renderer gates drops with it.
 */
export function canPlaceLevel(
  level: HierarchyLevel | null,
  parent: { sectionType: SectionType | null; hierarchyLevel: HierarchyLevel | null }
): boolean {
  switch (level) {
    case null:
      return true
    case 'part':
      return parent.sectionType === 'manuscript'
    case 'chapter':
      return parent.hierarchyLevel === 'part'
    case 'scene':
      return parent.hierarchyLevel === 'chapter'
  }
}

/** Title given to a newly created node (F-2.2): "Untitled Arc", "Untitled Chapter", "Untitled document". */
export function defaultNodeTitle(
  format: NovelFormat,
  kind: NodeKind,
  hierarchyLevel: HierarchyLevel | null
): string {
  return `Untitled ${hierarchyLevel ? levelLabel(format, hierarchyLevel) : kind}`
}

/** One-line description of the starter skeleton seeded into a new project (F-1.3). */
export function skeletonSummary(format: NovelFormat): string {
  return `${sectionLabel(format, 'manuscript')} → ${levelLabel(format, 'part')} 1–2 → ${levelLabel(format, 'chapter')} 1–3 → ${levelLabel(format, 'scene')} 1`
}
