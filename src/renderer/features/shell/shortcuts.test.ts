import { describe, expect, it } from 'vitest'
import {
  APP_SHORTCUTS,
  EDITOR_SHORTCUTS,
  SHORTCUT_IDS,
  formatShortcut,
  matchesShortcut
} from './shortcuts'

const event = (
  key: string,
  mods: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {}
): Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods
})

// jsdom reports a Linux platform, so `ctrl` is the Ctrl key here and Cmd is the foreign one.
describe('shortcuts (F-2.7)', () => {
  it('lists every id once with a label and a chord', () => {
    expect(Object.keys(APP_SHORTCUTS).sort()).toEqual([...SHORTCUT_IDS].sort())
    for (const id of SHORTCUT_IDS) {
      expect(APP_SHORTCUTS[id].id).toBe(id)
      expect(APP_SHORTCUTS[id].label.length).toBeGreaterThan(0)
      expect(APP_SHORTCUTS[id].chord.key.length).toBeGreaterThan(0)
    }
  })

  it('matches the exact chord, either letter case, and nothing looser or stricter', () => {
    const scene = APP_SHORTCUTS.insertScene.chord
    expect(matchesShortcut(event('S', { ctrlKey: true, shiftKey: true }), scene)).toBe(true)
    expect(matchesShortcut(event('s', { ctrlKey: true, shiftKey: true }), scene)).toBe(true)
    expect(matchesShortcut(event('s', { ctrlKey: true }), scene)).toBe(false)
    expect(matchesShortcut(event('s', { shiftKey: true }), scene)).toBe(false)
    expect(
      matchesShortcut(event('s', { ctrlKey: true, shiftKey: true, altKey: true }), scene)
    ).toBe(false)
    expect(matchesShortcut(event('s', { metaKey: true, shiftKey: true }), scene)).toBe(false)
    expect(
      matchesShortcut(event('S', { ctrlKey: true, shiftKey: true, metaKey: true }), scene)
    ).toBe(false)
    expect(matchesShortcut(event(',', { ctrlKey: true }), APP_SHORTCUTS.settings.chord)).toBe(true)
    expect(
      matchesShortcut(event(',', { ctrlKey: true, shiftKey: true }), APP_SHORTCUTS.settings.chord)
    ).toBe(false)
  })

  it('F11 alone is focus mode (F-6.1); a modifier makes it something else', () => {
    const chord = APP_SHORTCUTS.focusMode.chord
    expect(chord).toEqual({ key: 'F11' })
    expect(APP_SHORTCUTS.focusMode.group).toBe('app')
    expect(matchesShortcut(event('F11'), chord)).toBe(true)
    expect(matchesShortcut(event('F11', { ctrlKey: true }), chord)).toBe(false)
    expect(matchesShortcut(event('F11', { shiftKey: true }), chord)).toBe(false)
    expect(matchesShortcut(event('F1'), chord)).toBe(false)
  })

  it('formats a chord for display', () => {
    expect(formatShortcut(APP_SHORTCUTS.insertScene.chord)).toBe('Ctrl+Shift+S')
    expect(formatShortcut(APP_SHORTCUTS.settings.chord)).toBe('Ctrl+,')
    expect(formatShortcut(APP_SHORTCUTS.focusMode.chord)).toBe('F11')
  })
})

describe('shortcuts additions for the menu and the reference (F-7.1, F-7.7)', () => {
  it('lists Save as a display chord in the app group', () => {
    expect(APP_SHORTCUTS.save).toEqual({
      id: 'save',
      label: 'Save',
      chord: { key: 's', ctrl: true },
      group: 'app'
    })
    expect(formatShortcut(APP_SHORTCUTS.save.chord)).toBe('Ctrl+S')
  })

  it('lists the editor chords with a label each and no duplicates of label and chord', () => {
    expect(EDITOR_SHORTCUTS.length).toBeGreaterThan(10)
    const seen = new Set<string>()
    for (const shortcut of EDITOR_SHORTCUTS) {
      expect(shortcut.label.length).toBeGreaterThan(0)
      const key = `${shortcut.label}:${formatShortcut(shortcut.chord)}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
    expect(EDITOR_SHORTCUTS.map((s) => s.label)).toContain('Accept the ghost text')
    // Strikethrough has no chord: Ctrl+Shift+S is Insert scene (F-2.7).
    expect(EDITOR_SHORTCUTS.map((s) => formatShortcut(s.chord))).not.toContain('Ctrl+Shift+S')
  })
})
