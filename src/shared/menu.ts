import { z } from 'zod'
import type { NovelFormat } from './ipc/contract'
import { levelLabel, type HierarchyLevel } from './labels'
import { APP_SHORTCUTS, type Chord, type ShortcutId } from './shortcuts'

/**
 * The one menu definition (F-7.1): main renders it as the native application menu (with the
 * F-2.7 chords as accelerators) and the renderer as the in-app menu bar, and every click on
 * either side becomes one `menu:action` handled by `runMenuAction`. Items whose feature is not
 * built are absent, never disabled or stubbed: Export…, Import… (F-12.x), Find and Find &
 * Replace (F-10.x), Character, Setting, World-building note (F-9.x), References (F-7.4), Word
 * count, Statistics, Goals, Drafts, Snapshots (F-10.x, F-8.x) join the definition with their
 * features. Edit items carry an Electron role, so the native menu edits natively; the in-app
 * bar routes them through `menu:edit` to the same `webContents` commands.
 */
export const MENU_ITEM_IDS = [
  'newProject',
  'openProject',
  'saveDocument',
  'closeProject',
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'insertScene',
  'insertChapter',
  'insertPart',
  'insertSceneBreak',
  'toggleSidebar',
  'toggleNotes',
  'toggleAssistant',
  'toggleFocusMode',
  'openTags',
  'openSettings',
  'openDocumentation',
  'openShortcuts',
  'openAbout'
] as const
export const MenuItemId = z.enum(MENU_ITEM_IDS)
export type MenuItemId = z.infer<typeof MenuItemId>

/** The Electron edit roles the Edit menu uses; `menu:edit` calls the `webContents` method of the same name. */
export const EDIT_ROLES = ['undo', 'redo', 'cut', 'copy', 'paste'] as const
export const EditRole = z.enum(EDIT_ROLES)
export type EditRole = z.infer<typeof EditRole>

/** When an item is enabled: always, or only while a project is open. */
export type MenuWhen = 'always' | 'project'

export interface MenuItem {
  id: MenuItemId
  /** The label as shown; `level` items are relabelled per format by `menuItemLabel`. */
  label: string
  /** The app shortcut shown beside the item and bound as the native accelerator. */
  shortcut?: ShortcutId
  /** An Electron edit role: the native menu handles it itself, the in-app bar sends `menu:edit`. */
  editRole?: EditRole
  /** The hierarchy level this Insert item creates, so its label follows the project's format. */
  level?: HierarchyLevel
  when: MenuWhen
}

export interface MenuSeparator {
  separator: true
}

export type MenuEntry = MenuItem | MenuSeparator

export const MENU_SECTION_IDS = ['file', 'edit', 'insert', 'view', 'tools', 'help'] as const
export type MenuSectionId = (typeof MENU_SECTION_IDS)[number]

export interface MenuSection {
  id: MenuSectionId
  label: string
  entries: readonly MenuEntry[]
}

const SEPARATOR: MenuSeparator = { separator: true }

export const MENU: readonly MenuSection[] = [
  {
    id: 'file',
    label: 'File',
    entries: [
      { id: 'newProject', label: 'New project', when: 'always' },
      { id: 'openProject', label: 'Open project…', when: 'always' },
      SEPARATOR,
      { id: 'saveDocument', label: 'Save', shortcut: 'save', when: 'project' },
      SEPARATOR,
      { id: 'closeProject', label: 'Close project', when: 'project' }
    ]
  },
  {
    id: 'edit',
    label: 'Edit',
    entries: [
      { id: 'undo', label: 'Undo', editRole: 'undo', when: 'always' },
      { id: 'redo', label: 'Redo', editRole: 'redo', when: 'always' },
      SEPARATOR,
      { id: 'cut', label: 'Cut', editRole: 'cut', when: 'always' },
      { id: 'copy', label: 'Copy', editRole: 'copy', when: 'always' },
      { id: 'paste', label: 'Paste', editRole: 'paste', when: 'always' }
    ]
  },
  {
    id: 'insert',
    label: 'Insert',
    entries: [
      {
        id: 'insertScene',
        label: 'Scene',
        shortcut: 'insertScene',
        level: 'scene',
        when: 'project'
      },
      {
        id: 'insertChapter',
        label: 'Chapter',
        shortcut: 'insertChapter',
        level: 'chapter',
        when: 'project'
      },
      { id: 'insertPart', label: 'Part', shortcut: 'insertPart', level: 'part', when: 'project' },
      SEPARATOR,
      { id: 'insertSceneBreak', label: 'Scene break', when: 'project' }
    ]
  },
  {
    id: 'view',
    label: 'View',
    entries: [
      { id: 'toggleSidebar', label: 'Sidebar', when: 'project' },
      { id: 'toggleNotes', label: 'Notes', when: 'project' },
      { id: 'toggleAssistant', label: 'AI assistant', shortcut: 'assistant', when: 'project' },
      SEPARATOR,
      { id: 'toggleFocusMode', label: 'Focus mode', shortcut: 'focusMode', when: 'project' }
    ]
  },
  {
    id: 'tools',
    label: 'Tools',
    entries: [
      { id: 'openTags', label: 'Tags', when: 'project' },
      SEPARATOR,
      { id: 'openSettings', label: 'Settings', shortcut: 'settings', when: 'project' }
    ]
  },
  {
    id: 'help',
    label: 'Help',
    entries: [
      { id: 'openDocumentation', label: 'Documentation', when: 'always' },
      { id: 'openShortcuts', label: 'Keyboard shortcuts', when: 'always' },
      SEPARATOR,
      { id: 'openAbout', label: 'About MythScribe', when: 'always' }
    ]
  }
]

export function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return 'separator' in entry
}

/** Every item of the definition in menu order, separators left out. */
export function menuItems(menu: readonly MenuSection[] = MENU): MenuItem[] {
  return menu.flatMap((section) => section.entries.filter((e): e is MenuItem => !isSeparator(e)))
}

/** The item's label for this project: Insert items take the format's level name (Episode, Arc…). */
export function menuItemLabel(item: MenuItem, format: NovelFormat | null): string {
  if (item.level && format) return levelLabel(format, item.level)
  return item.label
}

/** Whether the item can run now: `project` items need an open project. */
export function isMenuItemEnabled(item: MenuItem, hasProject: boolean): boolean {
  return item.when === 'always' || hasProject
}

/** The item's chord, when it has an app shortcut. */
export function menuItemChord(item: MenuItem): Chord | null {
  return item.shortcut ? APP_SHORTCUTS[item.shortcut].chord : null
}

/**
 * The chord as an Electron accelerator: `CmdOrCtrl+Shift+S`, `CmdOrCtrl+,`, `F11`. `ctrl` is
 * Cmd on macOS and Ctrl elsewhere, which is exactly what `CmdOrCtrl` means.
 */
export function menuAccelerator(chord: Chord): string {
  const parts: string[] = []
  if (chord.ctrl) parts.push('CmdOrCtrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  return parts.join('+')
}

/** Where Help › Documentation goes (F-15.10's docs page). */
export const DOCS_URL = 'https://mythscribe.app/docs/'

/** The only site the app opens in the browser; `menu:openExternal` refuses everything else. */
export const EXTERNAL_HOST = 'mythscribe.app'

/** Whether `menu:openExternal` may open this: an `https` URL on the app's own site. */
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && parsed.hostname === EXTERNAL_HOST
}
