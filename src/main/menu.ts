import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { NovelFormat } from '@shared/ipc/contract'
import {
  MENU,
  isMenuItemEnabled,
  isSeparator,
  menuAccelerator,
  menuItemChord,
  menuItemLabel,
  type MenuItemId,
  type MenuSection
} from '@shared/menu'
import { emit, type EmitTarget } from './ipc/registry'
import type { ProjectManager } from './project/manager'

/** What the native template depends on: the open project's format (null when none) and the OS. */
export interface MenuContext {
  format: NovelFormat | null
  platform: NodeJS.Platform
}

/**
 * The native application menu (F-7.1) as an Electron template, built from the one definition
 * in `@shared/menu`: labels (Insert items by format), the F-2.7 chords as accelerators,
 * `enabled` from `when`, Electron roles for the Edit items, and `onAction` for everything
 * else. macOS gets the standard app menu first, which the roles need. Pure, so it is tested
 * without Electron; `installApplicationMenu` is the wiring.
 */
export function buildMenuTemplate(
  menu: readonly MenuSection[],
  context: MenuContext,
  onAction: (id: MenuItemId) => void
): MenuItemConstructorOptions[] {
  const sections = menu.map((section): MenuItemConstructorOptions => ({
    id: section.id,
    label: section.label,
    submenu: section.entries.map((entry): MenuItemConstructorOptions => {
      if (isSeparator(entry)) return { type: 'separator' }
      const chord = menuItemChord(entry)
      const base: MenuItemConstructorOptions = {
        id: entry.id,
        label: menuItemLabel(entry, context.format),
        enabled: isMenuItemEnabled(entry, context.format !== null),
        ...(chord ? { accelerator: menuAccelerator(chord) } : {})
      }
      return entry.editRole
        ? { ...base, role: entry.editRole }
        : { ...base, click: () => onAction(entry.id) }
    })
  }))
  return context.platform === 'darwin' ? [{ role: 'appMenu' }, ...sections] : sections
}

export interface InstallMenuDeps {
  manager: Pick<ProjectManager, 'current' | 'onChange'>
  platform: NodeJS.Platform
  /** The window a click goes to: the focused one, else the first. */
  target: () => EmitTarget | null
}

/**
 * Builds and sets the application menu, and rebuilds it whenever the project changes so the
 * `project` items enable and the Insert labels follow the format. Each click emits
 * `menu:action` to the target window; the renderer's `runMenuAction` does the work. Returns
 * the unsubscribe from the manager.
 */
export function installApplicationMenu({ manager, platform, target }: InstallMenuDeps): () => void {
  const apply = (): void => {
    const template = buildMenuTemplate(
      MENU,
      { format: manager.current()?.format ?? null, platform },
      (id) => {
        const win = target()
        if (win) emit([win], 'menu:action', { id })
      }
    )
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }
  apply()
  return manager.onChange(apply)
}
