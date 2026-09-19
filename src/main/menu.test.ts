import { Menu, type MenuItemConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectInfo } from '@shared/ipc/contract'
import { MENU, menuItems, type MenuItemId } from '@shared/menu'
import type { EmitTarget } from './ipc/registry'
import { ProjectManager } from './project/manager'
import { buildMenuTemplate, installApplicationMenu } from './menu'

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => ({ template })),
    setApplicationMenu: vi.fn()
  }
}))

const info: ProjectInfo = {
  id: '1',
  name: 'Serial',
  format: 'webnovel',
  path: '/tmp/Serial.mythscribe',
  created: 'c',
  modified: 'm',
  lastOpened: 'l',
  schemaVersion: 1
}

/** The submenu of the top-level entry with this label. */
function submenu(
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions[] {
  const section = template.find((entry) => entry.label === label)
  if (!section || !Array.isArray(section.submenu)) throw new Error(`no ${label} submenu`)
  return section.submenu
}

function item(template: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions {
  for (const section of template) {
    if (!Array.isArray(section.submenu)) continue
    const found = section.submenu.find((entry) => entry.id === id)
    if (found) return found
  }
  throw new Error(`no item ${id}`)
}

/** The template handed to `Menu.buildFromTemplate` on its n-th call. */
const built = (n: number): MenuItemConstructorOptions[] =>
  vi.mocked(Menu.buildFromTemplate).mock.calls[n]![0] as MenuItemConstructorOptions[]

beforeEach(() => {
  vi.mocked(Menu.buildFromTemplate).mockClear()
  vi.mocked(Menu.setApplicationMenu).mockClear()
})

describe('buildMenuTemplate (F-7.1)', () => {
  const onAction = vi.fn<(id: MenuItemId) => void>()

  it('renders the six sections in order on Windows and Linux, with every item present', () => {
    const template = buildMenuTemplate(MENU, { format: null, platform: 'linux' }, onAction)
    expect(template.map((s) => s.label)).toEqual([
      'File',
      'Edit',
      'Insert',
      'View',
      'Tools',
      'Help'
    ])
    for (const entry of menuItems()) expect(item(template, entry.id).label).toBeDefined()
    expect(submenu(template, 'File').map((e) => e.type ?? e.id)).toEqual([
      'newProject',
      'openProject',
      'separator',
      'saveDocument',
      'separator',
      'closeProject'
    ])
  })

  it('puts the app menu first on macOS, and nowhere else', () => {
    const mac = buildMenuTemplate(MENU, { format: null, platform: 'darwin' }, onAction)
    expect(mac[0]).toEqual({ role: 'appMenu' })
    expect(mac.slice(1).map((s) => s.label)).toEqual([
      'File',
      'Edit',
      'Insert',
      'View',
      'Tools',
      'Help'
    ])
    const win = buildMenuTemplate(MENU, { format: null, platform: 'win32' }, onAction)
    expect(win.some((s) => s.role === 'appMenu')).toBe(false)
  })

  it('binds the F-2.7 chords as accelerators', () => {
    const template = buildMenuTemplate(MENU, { format: 'novel', platform: 'linux' }, onAction)
    expect(item(template, 'insertScene').accelerator).toBe('CmdOrCtrl+Shift+S')
    expect(item(template, 'insertChapter').accelerator).toBe('CmdOrCtrl+Shift+C')
    expect(item(template, 'insertPart').accelerator).toBe('CmdOrCtrl+Shift+P')
    expect(item(template, 'saveDocument').accelerator).toBe('CmdOrCtrl+S')
    expect(item(template, 'openSettings').accelerator).toBe('CmdOrCtrl+,')
    expect(item(template, 'toggleAssistant').accelerator).toBe('CmdOrCtrl+K')
    expect(item(template, 'toggleFocusMode').accelerator).toBe('F11')
    expect(item(template, 'newProject').accelerator).toBeUndefined()
  })

  it('disables the project items without a project and enables them with one', () => {
    const closed = buildMenuTemplate(MENU, { format: null, platform: 'linux' }, onAction)
    expect(item(closed, 'saveDocument').enabled).toBe(false)
    expect(item(closed, 'insertScene').enabled).toBe(false)
    expect(item(closed, 'openSettings').enabled).toBe(true)
    expect(item(closed, 'newProject').enabled).toBe(true)
    expect(item(closed, 'undo').enabled).toBe(true)
    expect(item(closed, 'openAbout').enabled).toBe(true)
    const open = buildMenuTemplate(MENU, { format: 'novel', platform: 'linux' }, onAction)
    expect(item(open, 'saveDocument').enabled).toBe(true)
    expect(item(open, 'insertScene').enabled).toBe(true)
  })

  it('labels the Insert items by the format', () => {
    const template = buildMenuTemplate(MENU, { format: 'webnovel', platform: 'linux' }, onAction)
    expect(submenu(template, 'Insert').map((e) => e.label)).toEqual([
      'Scene',
      'Chapter',
      'Arc',
      undefined,
      'Scene break'
    ])
  })

  it('gives the Edit items their Electron role and no click; every other item clicks through', () => {
    const template = buildMenuTemplate(MENU, { format: 'novel', platform: 'linux' }, onAction)
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste'] as const) {
      const entry = item(template, role)
      expect(entry.role).toBe(role)
      expect(entry.click).toBeUndefined()
    }
    const save = item(template, 'saveDocument')
    expect(save.role).toBeUndefined()
    save.click?.(undefined as never, undefined, undefined as never)
    expect(onAction).toHaveBeenLastCalledWith('saveDocument')
    item(template, 'openAbout').click?.(undefined as never, undefined, undefined as never)
    expect(onAction).toHaveBeenLastCalledWith('openAbout')
  })
})

describe('installApplicationMenu (F-7.1)', () => {
  it('sets the menu at once, rebuilds it when the project changes, and emits clicks to the target window', () => {
    const send = vi.fn()
    const win: EmitTarget = { isDestroyed: () => false, webContents: { send } }
    const listeners: ((info: ProjectInfo | null) => void)[] = []
    const fakeManager: Pick<ProjectManager, 'current' | 'onChange'> = {
      current: vi.fn(() => null as ProjectInfo | null),
      onChange: (listener) => {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      }
    }
    const off = installApplicationMenu({
      manager: fakeManager,
      platform: 'linux',
      target: () => win
    })
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1)
    const first = built(0)
    expect(item(first, 'saveDocument').enabled).toBe(false)

    vi.mocked(fakeManager.current).mockReturnValue(info)
    listeners.forEach((l) => l(info))
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(2)
    const second = built(1)
    expect(item(second, 'saveDocument').enabled).toBe(true)
    expect(item(second, 'insertPart').label).toBe('Arc')

    item(second, 'openShortcuts').click?.(undefined as never, undefined, undefined as never)
    expect(send).toHaveBeenCalledWith('menu:action', { id: 'openShortcuts' })
    off()
    expect(listeners).toEqual([])
  })

  it('drops a click when there is no window to send it to', () => {
    const manager = new ProjectManager()
    installApplicationMenu({ manager, platform: 'win32', target: () => null })
    const template = built(0)
    expect(() =>
      item(template, 'openAbout').click?.(undefined as never, undefined, undefined as never)
    ).not.toThrow()
  })
})
