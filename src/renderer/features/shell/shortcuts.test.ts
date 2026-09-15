import { describe, expect, it } from 'vitest'
import { APP_SHORTCUTS, SHORTCUT_IDS, formatShortcut, matchesShortcut } from './shortcuts'

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

  it('formats a chord for display', () => {
    expect(formatShortcut(APP_SHORTCUTS.insertScene.chord)).toBe('Ctrl+Shift+S')
    expect(formatShortcut(APP_SHORTCUTS.settings.chord)).toBe('Ctrl+,')
    expect(formatShortcut({ key: 'F11' })).toBe('F11')
  })
})
