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

  it('needs a project for everything but File › New/Open, Edit, View › Zoom, Tools › Settings, and Help', () => {
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
      'togglePageEdges',
      'zoomIn',
      'zoomOut',
      'zoomReset',
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

  it('offers Page edges and the three zoom items in View, after Focus mode, working without a project (F-7.10, F-7.11)', () => {
    const view = MENU.find((section) => section.id === 'view')
    expect(
      (view?.entries ?? []).map((entry) => (isSeparator(entry) ? 'separator' : entry.id))
    ).toEqual([
      'toggleSidebar',
      'toggleNotes',
      'toggleAssistant',
      'toggleReferences',
      'openCompile',
      'separator',
      'toggleFocusMode',
      'separator',
      'togglePageEdges',
      'zoomIn',
      'zoomOut',
      'zoomReset'
    ])
    const byId = Object.fromEntries(menuItems().map((item) => [item.id, item]))
    expect(byId.togglePageEdges?.label).toBe('Page edges')
    expect(menuItemChord(byId.togglePageEdges!)).toBeNull()
    expect(isMenuItemEnabled(byId.togglePageEdges!, false)).toBe(true)
    expect(byId.zoomIn?.label).toBe('Zoom in')
    expect(byId.zoomOut?.label).toBe('Zoom out')
    expect(byId.zoomReset?.label).toBe('Reset zoom')
    expect(menuItemChord(byId.zoomIn!)).toEqual(APP_SHORTCUTS.zoomIn.chord)
    expect(menuItemChord(byId.zoomReset!)).toEqual(APP_SHORTCUTS.zoomReset.chord)
    expect(isMenuItemEnabled(byId.zoomIn!, false)).toBe(true)
  })

  it('offers References in View after AI assistant, only with a project and without a shortcut (F-9.6)', () => {
    const byId = Object.fromEntries(menuItems().map((item) => [item.id, item]))
    expect(byId.toggleReferences?.label).toBe('References')
    expect(menuItemChord(byId.toggleReferences!)).toBeNull()
    expect(isMenuItemEnabled(byId.toggleReferences!, false)).toBe(false)
    expect(isMenuItemEnabled(byId.toggleReferences!, true)).toBe(true)
  })

  it('offers Compiled preview in View after References, only with a project and without a shortcut (F-3.12)', () => {
    const byId = Object.fromEntries(menuItems().map((item) => [item.id, item]))
    expect(byId.openCompile?.label).toBe('Compiled preview')
    expect(menuItemChord(byId.openCompile!)).toBeNull()
    expect(isMenuItemEnabled(byId.openCompile!, false)).toBe(false)
    expect(isMenuItemEnabled(byId.openCompile!, true)).toBe(true)
  })

  it('offers Search project… after the clipboard items of Edit, on Ctrl+Shift+F, only with a project (F-10.1)', () => {
    const edit = MENU.find((section) => section.id === 'edit')
    expect(
      (edit?.entries ?? []).map((entry) => (isSeparator(entry) ? 'separator' : entry.id))
    ).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'separator',
      'findInDocument',
      'replaceInDocument',
      'searchProject',
      'replaceProject'
    ])
    const [item] = menuItems().filter((entry) => entry.id === 'searchProject')
    expect(item?.label).toBe('Search project…')
    expect(item?.editRole).toBeUndefined()
    expect(menuItemChord(item!)).toEqual({ key: 'f', ctrl: true, shift: true })
    expect(menuAccelerator(menuItemChord(item!)!)).toBe('CmdOrCtrl+Shift+F')
    expect(isMenuItemEnabled(item!, false)).toBe(false)
    expect(isMenuItemEnabled(item!, true)).toBe(true)
  })

  it('offers Find… and Replace… before Search project…, on Ctrl+F and Ctrl+H, only with a project (F-3.10)', () => {
    const byId = Object.fromEntries(menuItems().map((item) => [item.id, item]))
    const find = byId.findInDocument!
    const replace = byId.replaceInDocument!
    expect([find.label, replace.label]).toEqual(['Find…', 'Replace…'])
    expect(menuAccelerator(menuItemChord(find)!)).toBe('CmdOrCtrl+F')
    expect(menuAccelerator(menuItemChord(replace)!)).toBe('CmdOrCtrl+H')
    expect(isMenuItemEnabled(find, false)).toBe(false)
    expect(isMenuItemEnabled(replace, true)).toBe(true)
  })

  it('offers Goals… in Tools after Tags, only with a project and without a shortcut (F-10.3)', () => {
    const tools = MENU.find((section) => section.id === 'tools')
    expect(
      (tools?.entries ?? []).map((entry) => (isSeparator(entry) ? 'separator' : entry.id))
    ).toEqual([
      'openTags',
      'openGoals',
      'openWordCount',
      'openStatistics',
      'openDrafts',
      'openSnapshots',
      'separator',
      'openSettings'
    ])
    const [item] = menuItems().filter((entry) => entry.id === 'openGoals')
    expect(item?.label).toBe('Goals…')
    expect(menuItemChord(item!)).toBeNull()
    expect(isMenuItemEnabled(item!, false)).toBe(false)
    expect(isMenuItemEnabled(item!, true)).toBe(true)
  })

  it('offers Drafts… after Statistics…, only with a project and without a shortcut (F-8.5)', () => {
    const [item] = menuItems().filter((entry) => entry.id === 'openDrafts')
    expect(item?.label).toBe('Drafts…')
    expect(menuItemChord(item!)).toBeNull()
    expect(isMenuItemEnabled(item!, false)).toBe(false)
    expect(isMenuItemEnabled(item!, true)).toBe(true)
  })

  it('offers Snapshots… after Drafts…, only with a project and without a shortcut (F-8.6)', () => {
    const [item] = menuItems().filter((entry) => entry.id === 'openSnapshots')
    expect(item?.label).toBe('Snapshots…')
    expect(menuItemChord(item!)).toBeNull()
    expect(isMenuItemEnabled(item!, false)).toBe(false)
    expect(isMenuItemEnabled(item!, true)).toBe(true)
  })

  it('offers Word count… after Goals…, only with a project and without a shortcut (F-10.4)', () => {
    const [item] = menuItems().filter((entry) => entry.id === 'openWordCount')
    expect(item?.label).toBe('Word count…')
    expect(menuItemChord(item!)).toBeNull()
    expect(isMenuItemEnabled(item!, false)).toBe(false)
    expect(isMenuItemEnabled(item!, true)).toBe(true)
  })

  it('offers Statistics… after Word count…, only with a project and without a shortcut (F-10.5)', () => {
    const [item] = menuItems().filter((entry) => entry.id === 'openStatistics')
    expect(item?.label).toBe('Statistics…')
    expect(menuItemChord(item!)).toBeNull()
    expect(isMenuItemEnabled(item!, false)).toBe(false)
    expect(isMenuItemEnabled(item!, true)).toBe(true)
  })

  it('offers Replace in project… right after it, on Ctrl+Shift+H, only with a project (F-10.2)', () => {
    const [item] = menuItems().filter((entry) => entry.id === 'replaceProject')
    expect(item?.label).toBe('Replace in project…')
    expect(item?.editRole).toBeUndefined()
    expect(menuItemChord(item!)).toEqual({ key: 'h', ctrl: true, shift: true })
    expect(menuAccelerator(menuItemChord(item!)!)).toBe('CmdOrCtrl+Shift+H')
    expect(isMenuItemEnabled(item!, false)).toBe(false)
    expect(isMenuItemEnabled(item!, true)).toBe(true)
  })

  it('offers Import manuscript… in File, after Open project…, only with a project (F-12.2)', () => {
    const file = MENU.find((section) => section.id === 'file')
    expect(
      (file?.entries ?? []).map((entry) => (isSeparator(entry) ? 'separator' : entry.id))
    ).toEqual([
      'newProject',
      'openProject',
      'importManuscript',
      'separator',
      'saveDocument',
      'separator',
      'closeProject'
    ])
    const [item] = menuItems().filter((entry) => entry.id === 'importManuscript')
    expect(item?.label).toBe('Import manuscript…')
    expect(menuItemChord(item!)).toBeNull()
    expect(isMenuItemEnabled(item!, false)).toBe(false)
    expect(isMenuItemEnabled(item!, true)).toBe(true)
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
    expect(menuAccelerator(APP_SHORTCUTS.zoomIn.chord)).toBe('CmdOrCtrl+=')
    expect(menuAccelerator(APP_SHORTCUTS.zoomOut.chord)).toBe('CmdOrCtrl+-')
    expect(menuAccelerator(APP_SHORTCUTS.zoomReset.chord)).toBe('CmdOrCtrl+0')
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
