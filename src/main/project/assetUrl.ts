import path from 'node:path'
import { ASSET_SCHEME, imageExtension, isAssetDir } from '@shared/assets'
import { BOOK_FONT_HOST, isBookFontFile } from '@shared/bookFonts'
import { ASSETS_DIR } from './projectStore'

/**
 * Resolves an asset URL the renderer asked for (F-6.2 backgrounds, F-9.3 entity images) to a
 * file inside the open project's folder, or null for anything that is not
 * `mythscribe-asset://<dir>/<file>` with one of the served `ASSET_DIRS` as the host, one plain
 * path segment, and an allowed image extension. Pure: no filesystem access, so the protocol
 * handler can trust the answer never leaves `<root>/assets/<dir>/`.
 */
export function assetPathFor(root: string, url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:` || !isAssetDir(parsed.hostname)) return null
  const segments = parsed.pathname.split('/')
  if (segments.length !== 2 || segments[0] !== '') return null
  let file: string
  try {
    file = decodeURIComponent(segments[1] ?? '')
  } catch {
    return null
  }
  if (file === '' || file === '.' || file === '..') return null
  if (file.includes('/') || file.includes('\\') || file.includes('\0')) return null
  if (imageExtension(file) === null) return null
  const dir = path.join(root, ASSETS_DIR, parsed.hostname)
  const resolved = path.join(dir, file)
  const relative = path.relative(dir, resolved)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return resolved
}

/**
 * Resolves the compile preview's font URL (`bookFontUrl`, Compile v2 CV3) to a file under the
 * bundled fonts folder, or null for anything that is not `mythscribe-asset://book-fonts/<dir>/
 * <file>` naming one of the shipped font files. Pure, like `assetPathFor`.
 */
export function bookFontPathFor(fontsDir: string, url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:` || parsed.hostname !== BOOK_FONT_HOST) return null
  const segments = parsed.pathname.split('/')
  if (segments.length !== 3 || segments[0] !== '') return null
  let dir: string
  let file: string
  try {
    dir = decodeURIComponent(segments[1] ?? '')
    file = decodeURIComponent(segments[2] ?? '')
  } catch {
    return null
  }
  if (!isBookFontFile(dir, file)) return null
  return path.join(fontsDir, dir, file)
}
