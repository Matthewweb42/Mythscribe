import type { Chord } from '@shared/shortcuts'

/**
 * The renderer's entry to the shortcut registry (F-2.7): the chords themselves live in
 * `@shared/shortcuts` (the menu, F-7.1, renders them as native accelerators from main), this
 * file adds what needs the platform: matching a keyboard event and rendering a chord for
 * display. Editor-internal chords belong to the Tiptap extensions and are listed, not bound,
 * in `EDITOR_SHORTCUTS`.
 */
export {
  APP_SHORTCUTS,
  EDITOR_SHORTCUTS,
  SHORTCUT_GROUPS,
  SHORTCUT_IDS,
  type Chord,
  type EditorShortcut,
  type Shortcut,
  type ShortcutGroup,
  type ShortcutId
} from '@shared/shortcuts'

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
