import path from 'node:path'
import { ASSET_SCHEME, BACKGROUNDS_DIR, backgroundExtension } from '@shared/focus'
import { ASSETS_DIR } from './projectStore'

/**
 * Resolves an asset URL the renderer asked for (F-6.2) to a file inside the open project's
 * folder, or null for anything that is not `mythscribe-asset://backgrounds/<file>` with one
 * plain path segment and an allowed image extension. Pure: no filesystem access, so the
 * protocol handler can trust the answer never leaves `<root>/assets/backgrounds/`.
 */
export function assetPathFor(root: string, url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${ASSET_SCHEME}:` || parsed.hostname !== BACKGROUNDS_DIR) return null
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
  if (backgroundExtension(file) === null) return null
  const dir = path.join(root, ASSETS_DIR, BACKGROUNDS_DIR)
  const resolved = path.join(dir, file)
  const relative = path.relative(dir, resolved)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return resolved
}
