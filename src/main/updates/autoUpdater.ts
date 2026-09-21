import { autoUpdater } from 'electron-updater'
import type { AppUpdaterLike } from './updateService'

/**
 * The one place `electron-updater` is touched (F-15.7). `autoUpdater` is a lazy getter on the
 * package: reading it builds the updater for this platform (NSIS, Mac, AppImage), which only
 * makes sense in a packaged build, so nothing reads it until `index.ts` decides this build can
 * update itself. The rest of main sees the structural `AppUpdaterLike` instead of the package.
 */
export function loadAutoUpdater(): AppUpdaterLike {
  return autoUpdater
}
