import { z } from 'zod'

/**
 * The sidebar's sections (F-7.3, F-9.11). This is the persisted vocabulary (the current section
 * lives in the app-wide layout and in the project session, F-1.7), so it is schema-stable and
 * knows nothing about React; the renderer's `sidebarSections.ts` builds the picker from it.
 *
 * A section is a tool (below) or a story-bible category, whose section id is its category id
 * (`character`, `setting`, `magic`, `c-ships`…). The two never collide: no tool id is a category
 * id, and project categories start with `c-`.
 */
export const SIDEBAR_TOOL_IDS = [
  'manuscript',
  'tags',
  'timeline',
  'outline',
  // F-14.15: the edit passes and their reports.
  'edits',
  // F-9.8: the context library, the author's uploaded worldbuilding files.
  'library',
  // F-9.13: what the AI added to the story bible on its own, with Undo.
  'changes'
] as const
export type SidebarToolId = (typeof SIDEBAR_TOOL_IDS)[number]

/** A section id: a tool's or a category's. Any well-formed id reads, so a later build's section survives. */
export const SidebarTabId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, 'Not a sidebar section')
export type SidebarTabId = z.infer<typeof SidebarTabId>

/** The section ids of F-9.2's three entity tabs, which F-9.11 turned into category sections. */
const LEGACY_SECTION_IDS: Readonly<Record<string, string>> = {
  characters: 'character',
  settings: 'setting'
}

/** A stored section id as today's: F-9.2's `characters` and `settings` are the category sections now. */
export function normalizeSectionId(id: string): string {
  return LEGACY_SECTION_IDS[id] ?? id
}

export function isSidebarToolId(id: string): id is SidebarToolId {
  return (SIDEBAR_TOOL_IDS as readonly string[]).includes(id)
}
