import { BookOpen, FileText, Layers, type LucideIcon } from 'lucide-react'
import type { HierarchyLevel } from '@shared/labels'

/** Each hierarchy level's glyph and colour, shared by the tree's `LevelIcon` and the create bar (F-2.2). */
export const LEVEL_GLYPH: Record<HierarchyLevel, { icon: LucideIcon; color: string }> = {
  part: { icon: Layers, color: 'text-level-part' },
  chapter: { icon: BookOpen, color: 'text-level-chapter' },
  scene: { icon: FileText, color: 'text-level-scene' }
}
