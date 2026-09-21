import { describe, expect, it } from 'vitest'
import { APP_SHORTCUTS } from './shortcuts'
import {
  DOCS_URL,
  MENU,
  MENU_ITEM_IDS,
  MENU_SECTION_IDS,
  isAllowedExternalUrl,
  isMenuItemEnabled,
  isSeparator,
  menuAccelerator,
  menuItemChord,
  menuItemLabel,
  menuItems,
  type MenuItem
} from './menu'

describe('menu definition (F-7.1)', () => {
  it('lists the six sections in order with the spec labels', () => {
    expect(MENU.map((s) => s.id)).toEqual([...MENU_SECTION_IDS])
    expect(MENU.map((s) => s.label)).toEqual(['File', 'Edit', 'Insert', 'View', 'Tools', 'Help'])
  })

  it('uses every item id exactly once, and every id is an item', () => {
    const ids = menuItems().map((item) => item.id)
    expect([...ids].sort()).toEqual([...MENU_ITEM_IDS].sort())
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never starts or ends a section with a separator, nor doubles one', () => {
    for (const section of MENU) {
      const entries = section.entries
      expect(isSeparator(entries[0]!)).toBe(false)
      expect(isSeparator(entries[entries.length - 1]!)).toBe(false)
      for (let i = 1; i < entries.length; i++) {
        expect(isSeparator(entries[i]!) && isSeparator(entries[i - 1]!)).toBe(false)
      }
    }
  })

  it('binds the F-2.7 chords to the Insert, View, and Tools items and Ctrl+S to Save', () => {
    const byId = Object.fromEntries(menuItems().map((item) => [item.id, item]))
    expect(byId.insertScene?.shortcut).toBe('insertScene')
    expect(byId.insertChapter?.shortcut).toBe('insertChapter')
    expect(byId.insertPart?.shortcut).toBe('insertPart')
    expect(byId.toggleAssistant?.shortcut).toBe('assistant')
    expect(byId.toggleFocusMode?.shortcut).toBe('focusMode')
    expect(byId.openSettings?.shortcut).toBe('settings')
    expect(byId.saveDocument?.shortcut).toBe('save')
    expect(menuItemChord(byId.saveDocument!)).toEqual(APP_SHORTCUTS.save.chord)
    expect(menuItemChord(byId.newProject!)).toBeNull()
  })

  it('gives every Edit item a role and nothing else one', () => {
    for (const item of menuItems()) {
      const isEdit = ['undo', 'redo', 'cut', 'copy', 'paste'].includes(item.id)
      expect(item.editRole !== undefined).toBe(isEdit)
      if (isEdit) expect(item.editRole).toBe(item.id)
    }
  })

  it('needs a project for everything but File › New/Open, Edit, Tools › Settings, and Help', () => {
    const always = menuItems()
      .filter((item) => item.when === 'always')
      .map((item) => item.id)
    expect(always).toEqual([
      'newProject',
      'openProject',
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'openSettings',
      'openDocumentation',
      'openShortcuts',
      'checkForUpdates',
      'openAbout'
    ])
    const [save] = menuItems().filter((item) => item.id === 'saveDocument')
    expect(isMenuItemEnabled(save!, false)).toBe(false)
    expect(isMenuItemEnabled(save!, true)).toBe(true)
    const [about] = menuItems().filter((item) => item.id === 'openAbout')
    expect(isMenuItemEnabled(about!, false)).toBe(true)
  })

  it('offers Check for updates… in Help, just before About (F-15.7)', () => {
    const help = MENU.find((section) => section.id === 'help')
    const ids = (help?.entries ?? [])
      .filter((entry): entry is MenuItem => !isSeparator(entry))
      .map((entry) => entry.id)
    expect(ids).toEqual(['openDocumentation', 'openShortcuts', 'checkForUpdates', 'openAbout'])
    const [check] = menuItems().filter((item) => item.id === 'checkForUpdates')
    expect(check?.label).toBe('Check for updates…')
    expect(isMenuItemEnabled(check!, false)).toBe(true)
  })

  it('labels the Insert items by the format, and everything else as written', () => {
    const [scene] = menuItems().filter((item) => item.id === 'insertScene')
    const [part] = menuItems().filter((item) => item.id === 'insertPart')
    expect(menuItemLabel(scene!, null)).toBe('Scene')
    expect(menuItemLabel(scene!, 'novel')).toBe('Scene')
    expect(menuItemLabel(scene!, 'webnovel')).toBe('Scene')
    expect(menuItemLabel(part!, 'webnovel')).toBe('Arc')
    const [about] = menuItems().filter((item) => item.id === 'openAbout')
    expect(menuItemLabel(about!, 'webnovel')).toBe('About MythScribe')
  })

  it('renders chords as Electron accelerators', () => {
    expect(menuAccelerator(APP_SHORTCUTS.insertScene.chord)).toBe('CmdOrCtrl+Shift+S')
    expect(menuAccelerator(APP_SHORTCUTS.settings.chord)).toBe('CmdOrCtrl+,')
    expect(menuAccelerator(APP_SHORTCUTS.focusMode.chord)).toBe('F11')
    expect(menuAccelerator({ key: 'x', ctrl: true, alt: true, shift: true })).toBe(
      'CmdOrCtrl+Alt+Shift+X'
    )
  })

  it('opens only https pages on mythscribe.app', () => {
    expect(isAllowedExternalUrl(DOCS_URL)).toBe(true)
    expect(isAllowedExternalUrl('https://mythscribe.app/privacy.html')).toBe(true)
    expect(isAllowedExternalUrl('http://mythscribe.app/docs/')).toBe(false)
    expect(isAllowedExternalUrl('https://www.mythscribe.app/docs/')).toBe(false)
    expect(isAllowedExternalUrl('https://mythscribe.app.evil.com/')).toBe(false)
    expect(isAllowedExternalUrl('https://example.com/?u=mythscribe.app')).toBe(false)
    expect(isAllowedExternalUrl('not a url')).toBe(false)
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
  })
})
