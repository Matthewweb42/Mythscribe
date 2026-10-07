import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ASSET_ID_CHARS,
  IMAGE_EXTENSIONS,
  IMAGE_MAX_BYTES,
  assetFileName,
  imageExtension,
  type AssetDir
} from '@shared/assets'
import { AppError } from '../ipc/errors'
import { ASSETS_DIR } from './projectStore'

/**
 * The image files a project carries in `<Project>.mythscribe/assets/<dir>/` (F-6.2 backgrounds,
 * F-9.3 entity images): one place that copies an image in under a minted file name and takes it
 * out again, so copying the project folder copies its images and no caller writes the rules for
 * accepted types, size, or naming a second time.
 */
export function assetDir(folder: string, dir: AssetDir): string {
  return path.join(folder, ASSETS_DIR, dir)
}

/**
 * Copies `source` into the project's `assets/<dir>/` under a minted file name and answers that
 * name (`<stem>.<8 hex>.<ext>`, `fallbackStem` when nothing of the original stem survives).
 * Refuses a type outside `IMAGE_EXTENSIONS` or a file over `IMAGE_MAX_BYTES` with VALIDATION
 * (before reading it); a missing source is NOT_FOUND. The copy never overwrites: the minted id
 * is new, and `COPYFILE_EXCL` makes a collision a failure rather than a lost file.
 */
export function addImageAsset(
  folder: string,
  dir: AssetDir,
  source: string,
  fallbackStem: string,
  /** The name the stored file is named after; the source file name unless the caller knows better (F-9.8). */
  name: string = path.basename(source)
): string {
  const ext = imageExtension(name)
  if (ext === null) {
    throw new AppError(
      'VALIDATION',
      `${name} is not an image MythScribe can use (${IMAGE_EXTENSIONS.join(', ')})`,
      { source }
    )
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(source)
  } catch {
    throw new AppError('NOT_FOUND', `No file at ${source}`, { source })
  }
  if (!stat.isFile()) throw new AppError('VALIDATION', `${name} is not a file`, { source })
  if (stat.size > IMAGE_MAX_BYTES) {
    const limit = Math.round(IMAGE_MAX_BYTES / (1024 * 1024))
    throw new AppError('VALIDATION', `${name} is larger than ${limit} MB`, { source })
  }
  const target = assetDir(folder, dir)
  fs.mkdirSync(target, { recursive: true })
  const fileName = assetFileName(
    name,
    randomUUID().replace(/-/g, '').slice(0, ASSET_ID_CHARS),
    fallbackStem
  )
  fs.copyFileSync(source, path.join(target, fileName), fs.constants.COPYFILE_EXCL)
  return fileName
}

/**
 * Deletes a stored image asset by file name; a file that is already gone is not an error, so a
 * row pointing at nothing still cleans up. A name carrying a path separator or `..` is refused
 * with VALIDATION: a hand-edited row must never reach outside `assets/<dir>/`.
 */
export function removeImageAsset(folder: string, dir: AssetDir, fileName: string): void {
  if (
    fileName === '' ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0')
  ) {
    throw new AppError('VALIDATION', `"${fileName}" is not a stored image name`, { dir, fileName })
  }
  fs.rmSync(path.join(assetDir(folder, dir), fileName), { force: true })
}
