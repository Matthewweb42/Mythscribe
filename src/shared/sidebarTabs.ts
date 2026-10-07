import { z } from 'zod'

/**
 * The sidebar tabs of F-7.3 in display order. This is the persisted vocabulary (the active tab
 * lives in the app-wide layout), so it is schema-stable and knows nothing about React; the
 * renderer's registry in `features/shell/sidebarTabs.ts` says which of these are built.
 */
export const SIDEBAR_TAB_IDS = [
  'manuscript',
  'characters',
  'settings',
  'world',
  'outline',
  'timeline',
  'tags',
  // F-14.15: the edit passes and their reports.
  'edits',
  // F-9.8: the context library, the author's uploaded worldbuilding files.
  'library'
] as const

export const SidebarTabId = z.enum(SIDEBAR_TAB_IDS)
export type SidebarTabId = z.infer<typeof SidebarTabId>
