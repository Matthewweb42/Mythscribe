/**
 * The one registry of app-level keyboard shortcuts (F-2.7): every listener reads its chord
 * from here, the Insert menu (F-7.1) and the shortcuts reference (F-7.7) will read the same
 * table. `ctrl` means Ctrl on Windows and Linux and Cmd on macOS. Editor-internal chords
 * (bold, undo, Ctrl+S) belong to the Tiptap extensions and are not listed.
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
  'settings',
  'assistant',
  'focusMode',
  'insertScene',
  'insertChapter',
  'insertPart'
] as const
export type ShortcutId = (typeof SHORTCUT_IDS)[number]

export const APP_SHORTCUTS: Record<ShortcutId, Shortcut> = {
  settings: { id: 'settings', label: 'Settings', chord: { key: ',', ctrl: true }, group: 'app' },
  assistant: {
    id: 'assistant',
    label: 'AI assistant',
    chord: { key: 'k', ctrl: true },
    group: 'app'
  },
  focusMode: { id: 'focusMode', label: 'Focus mode', chord: { key: 'F11' }, group: 'app' },
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

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * Whether a keyboard event is exactly this chord: the primary modifier is Cmd on macOS and
 * Ctrl elsewhere (the other one must be up), Shift and Alt must match, and the key compares
 * case-insensitively so Shift chords match whichever case the platform reports.
 */
export function matchesShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  chord: Chord
): boolean {
  const primary = IS_MAC ? event.metaKey : event.ctrlKey
  const other = IS_MAC ? event.ctrlKey : event.metaKey
  if (primary !== (chord.ctrl ?? false) || other) return false
  if (event.shiftKey !== (chord.shift ?? false)) return false
  if (event.altKey !== (chord.alt ?? false)) return false
  return event.key.toLowerCase() === chord.key.toLowerCase()
}

/** The chord for display: `Ctrl+Shift+S`, or `⌘⇧S` on macOS. */
export function formatShortcut(chord: Chord): string {
  const key = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key
  if (IS_MAC) {
    return `${chord.ctrl ? '⌘' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${key}`
  }
  const parts: string[] = []
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}
