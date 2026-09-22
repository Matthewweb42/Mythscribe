/**
 * The one registry of app-level keyboard shortcuts (F-2.7): every listener reads its chord
 * from here, and the menu (F-7.1) renders the same chords as accelerators, so it lives in
 * `shared` where main can read it too. `ctrl` means Ctrl on Windows and Linux and Cmd on
 * macOS. The renderer's `features/shell/shortcuts.ts` adds the platform-aware matching and
 * display. `EDITOR_SHORTCUTS` lists the chords the Tiptap extensions own, for the shortcuts
 * reference (F-7.7) only: nothing here binds them.
 */
export interface Chord {
  /** Compared case-insensitively against `KeyboardEvent.key`. */
  key: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
}

export const SHORTCUT_GROUPS = ['app', 'insert'] as const
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number]

export interface Shortcut {
  id: ShortcutId
  label: string
  chord: Chord
  group: ShortcutGroup
}

export const SHORTCUT_IDS = [
  'save',
  'settings',
  'assistant',
  'focusMode',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'insertScene',
  'insertChapter',
  'insertPart'
] as const
export type ShortcutId = (typeof SHORTCUT_IDS)[number]

export const APP_SHORTCUTS: Record<ShortcutId, Shortcut> = {
  /** Display and the native accelerator only: inside the editor the `SaveShortcut` extension owns Ctrl+S. */
  save: { id: 'save', label: 'Save', chord: { key: 's', ctrl: true }, group: 'app' },
  settings: { id: 'settings', label: 'Settings', chord: { key: ',', ctrl: true }, group: 'app' },
  assistant: {
    id: 'assistant',
    label: 'AI assistant',
    chord: { key: 'k', ctrl: true },
    group: 'app'
  },
  focusMode: { id: 'focusMode', label: 'Focus mode', chord: { key: 'F11' }, group: 'app' },
  /**
   * F-7.10: the browser chords. `=` is what a US layout reports for the key marked `+`; the
   * renderer's listener takes `+` for it too, for the layouts (and the numpad) that report that.
   */
  zoomIn: { id: 'zoomIn', label: 'Zoom in', chord: { key: '=', ctrl: true }, group: 'app' },
  zoomOut: { id: 'zoomOut', label: 'Zoom out', chord: { key: '-', ctrl: true }, group: 'app' },
  zoomReset: {
    id: 'zoomReset',
    label: 'Reset zoom',
    chord: { key: '0', ctrl: true },
    group: 'app'
  },
  insertScene: {
    id: 'insertScene',
    label: 'Insert scene',
    chord: { key: 's', ctrl: true, shift: true },
    group: 'insert'
  },
  insertChapter: {
    id: 'insertChapter',
    label: 'Insert chapter',
    chord: { key: 'c', ctrl: true, shift: true },
    group: 'insert'
  },
  insertPart: {
    id: 'insertPart',
    label: 'Insert part',
    chord: { key: 'p', ctrl: true, shift: true },
    group: 'insert'
  }
}

/** A chord the editor owns, for the shortcuts reference (F-7.7). */
export interface EditorShortcut {
  label: string
  chord: Chord
}

/**
 * The chords bound inside the editing surface, in the order the reference lists them: the
 * StarterKit marks and blocks (F-3.1), the alignment keymap, save (F-3.2), ghost text (F-5.3),
 * the `#` suggestion (F-4.6), and the Escape that leaves focus mode (F-6.1). Strikethrough has
 * no chord: Ctrl+Shift+S is Insert scene (F-2.7).
 */
export const EDITOR_SHORTCUTS: readonly EditorShortcut[] = [
  { label: 'Bold', chord: { key: 'b', ctrl: true } },
  { label: 'Italic', chord: { key: 'i', ctrl: true } },
  { label: 'Underline', chord: { key: 'u', ctrl: true } },
  { label: 'Heading 1', chord: { key: '1', ctrl: true, alt: true } },
  { label: 'Heading 2', chord: { key: '2', ctrl: true, alt: true } },
  { label: 'Heading 3', chord: { key: '3', ctrl: true, alt: true } },
  { label: 'Paragraph', chord: { key: '0', ctrl: true, alt: true } },
  { label: 'Quote', chord: { key: 'b', ctrl: true, shift: true } },
  { label: 'Align left', chord: { key: 'l', ctrl: true, shift: true } },
  { label: 'Align center', chord: { key: 'e', ctrl: true, shift: true } },
  { label: 'Align right', chord: { key: 'r', ctrl: true, shift: true } },
  { label: 'Justify', chord: { key: 'j', ctrl: true, shift: true } },
  { label: 'Undo', chord: { key: 'z', ctrl: true } },
  { label: 'Redo', chord: { key: 'z', ctrl: true, shift: true } },
  { label: 'Save now', chord: { key: 's', ctrl: true } },
  { label: 'Accept the ghost text', chord: { key: 'Tab' } },
  { label: 'Accept one word of the ghost text', chord: { key: 'Tab', shift: true } },
  { label: 'Dismiss the ghost text', chord: { key: 'Escape' } },
  { label: 'Insert a #tag', chord: { key: '#' } },
  { label: 'Leave focus mode', chord: { key: 'Escape' } }
]
