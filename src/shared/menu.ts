import { z } from 'zod'
import type { NovelFormat } from './ipc/contract'
import { levelLabel, type HierarchyLevel } from './labels'
import { APP_SHORTCUTS, type Chord, type ShortcutId } from './shortcuts'

/**
 * The one menu definition (F-7.1): main renders it as the native application menu (with the
 * F-2.7 chords as accelerators) and the renderer as the in-app menu bar, and every click on
 * either side becomes one `menu:action` handled by `runMenuAction`. Items whose feature is not
 * built are absent, never disabled or stubbed: Export… arrived with F-12.1 (Compile… and Book
 * details… with F-12.4, Export… now opening the compile window),
 * Character, Setting, and World-building note arrived with F-9.3, References with F-9.6, Search
 * project… with F-10.1, Replace in project… with F-10.2, Find… and Replace… with F-3.10, Goals… with F-10.3, Word count… with F-10.4, Compiled preview with F-3.12, Drafts… with F-8.5, Snapshots… with F-8.6. Edit items carry an Electron role, so the native menu
 * edits natively; the in-app bar routes them through `menu:edit` to the same `webContents`
 * commands.
 */
export const MENU_ITEM_IDS = [
  'newProject',
  'openProject',
  'importManuscript',
  'compileManuscript',
  'exportManuscript',
  'openBookDetails',
  'saveDocument',
  'closeProject',
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'findInDocument',
  'replaceInDocument',
  'searchProject',
  'replaceProject',
  'insertScene',
  'insertChapter',
  'insertPart',
  'insertCharacter',
  'insertSetting',
  'insertWorldItem',
  'insertSceneBreak',
  'toggleSidebar',
  'toggleNotes',
  'toggleAssistant',
  'toggleReferences',
  'toggleTags',
  'resetLayout',
  'openCompile',
  'toggleFocusMode',
  'togglePageEdges',
  'switchTheme',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'openTags',
  'openGoals',
  'openWordCount',
  'openStatistics',
  'openDrafts',
  'openSnapshots',
  'openSettings',
  'openDocumentation',
  'openShortcuts',
  'checkForUpdates',
  'openAbout',
  'openDeveloperTools',
  'openChromiumDevTools'
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
      // F-12.2: the import goes into the open project, so it waits for one.
      { id: 'importManuscript', label: 'Import manuscript…', when: 'project' },
      // F-12.4 (Compile v2): the compile window; Export… is kept as an alias that opens it.
      { id: 'compileManuscript', label: 'Compile…', when: 'project' },
      { id: 'exportManuscript', label: 'Export…', when: 'project' },
      // F-12.4: the project's publishing facts, which compile prints.
      { id: 'openBookDetails', label: 'Book details…', when: 'project' },
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
      { id: 'paste', label: 'Paste', editRole: 'paste', when: 'always' },
      SEPARATOR,
      // F-3.10: the find bar of the open document, with and without its replace row.
      { id: 'findInDocument', label: 'Find…', shortcut: 'find', when: 'project' },
      { id: 'replaceInDocument', label: 'Replace…', shortcut: 'replace', when: 'project' },
      // F-10.1: the project-wide search dialog.
      { id: 'searchProject', label: 'Search project…', shortcut: 'search', when: 'project' },
      // F-10.2: the project-wide find and replace dialog.
      {
        id: 'replaceProject',
        label: 'Replace in project…',
        shortcut: 'replaceProject',
        when: 'project'
      }
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
      // F-9.3: each opens the creation dialog of its kind.
      { id: 'insertCharacter', label: 'Character', when: 'project' },
      { id: 'insertSetting', label: 'Setting', when: 'project' },
      { id: 'insertWorldItem', label: 'World-building note', when: 'project' },
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
      // F-9.6: the quick reference panel.
      { id: 'toggleReferences', label: 'References', when: 'project' },
      // The tags column, which replaced the tag bar above the editor (2026-10-06).
      { id: 'toggleTags', label: 'Tags', when: 'project' },
      // Layout 3c: the columns back to the default arrangement and widths.
      { id: 'resetLayout', label: 'Reset layout', when: 'project' },
      // F-3.12: the read-only compiled preview of the manuscript.
      { id: 'openCompile', label: 'Compiled preview', when: 'project' },
      SEPARATOR,
      { id: 'toggleFocusMode', label: 'Focus mode', shortcut: 'focusMode', when: 'project' },
      SEPARATOR,
      // F-7.11, F-7.8, and F-7.10: the sheet, the theme, and the zoom are app-wide, so they work
      // on the welcome screen too. Switch theme cycles (the menu model has no submenus).
      { id: 'togglePageEdges', label: 'Page edges', when: 'always' },
      { id: 'switchTheme', label: 'Switch theme', when: 'always' },
      { id: 'zoomIn', label: 'Zoom in', shortcut: 'zoomIn', when: 'always' },
      { id: 'zoomOut', label: 'Zoom out', shortcut: 'zoomOut', when: 'always' },
      { id: 'zoomReset', label: 'Reset zoom', shortcut: 'zoomReset', when: 'always' }
    ]
  },
  {
    id: 'tools',
    label: 'Tools',
    entries: [
      { id: 'openTags', label: 'Tags', when: 'project' },
      { id: 'openGoals', label: 'Goals…', when: 'project' },
      { id: 'openWordCount', label: 'Word count…', when: 'project' },
      { id: 'openStatistics', label: 'Statistics…', when: 'project' },
      // F-8.5: the project's named drafts of the manuscript text.
      { id: 'openDrafts', label: 'Drafts…', when: 'project' },
      // F-8.6: snapshots of a document or the project, to compare and restore.
      { id: 'openSnapshots', label: 'Snapshots…', when: 'project' },
      SEPARATOR,
      { id: 'openSettings', label: 'Settings', shortcut: 'settings', when: 'always' }
    ]
  },
  {
    id: 'help',
    label: 'Help',
    entries: [
      { id: 'openDocumentation', label: 'Documentation', when: 'always' },
      { id: 'openShortcuts', label: 'Keyboard shortcuts', when: 'always' },
      SEPARATOR,
      { id: 'checkForUpdates', label: 'Check for updates…', when: 'always' },
      { id: 'openAbout', label: 'About MythScribe', when: 'always' }
    ]
  }
]

/**
 * Help › Developer (2026-10-07): present only while developer tools are on (Settings ›
 * Advanced), absent otherwise like any item whose feature is not there. The menu model has no
 * submenus, so they follow a separator at the end of Help.
 */
export const DEVELOPER_MENU_ENTRIES: readonly MenuEntry[] = [
  SEPARATOR,
  { id: 'openDeveloperTools', label: 'Developer tools', when: 'always' },
  { id: 'openChromiumDevTools', label: 'Chromium DevTools', when: 'always' }
]

/** The menu as shown now: `MENU`, plus Help's developer items while developer tools are on. */
export function menuFor(options: { devTools: boolean }): readonly MenuSection[] {
  if (!options.devTools) return MENU
  return MENU.map((section) =>
    section.id === 'help'
      ? { ...section, entries: [...section.entries, ...DEVELOPER_MENU_ENTRIES] }
      : section
  )
}

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
