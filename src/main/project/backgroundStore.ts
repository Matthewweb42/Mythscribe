import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  BACKGROUND_EXTENSIONS,
  BACKGROUND_MAX_BYTES,
  BACKGROUNDS_DIR,
  backgroundExtension,
  backgroundUrl,
  type Background,
  BACKGROUND_ID_CHARS,
  backgroundDisplayName,
  backgroundFileName
} from '@shared/focus'
import { AppError } from '../ipc/errors'
import { ASSETS_DIR } from './projectStore'

/**
 * The focus-mode backgrounds of a project (F-6.2) are the image files in
 * `<Project>.mythscribe/assets/backgrounds/`, named `<id>.<ext>` with a minted id. The folder
 * is the record: nothing about a background is stored anywhere else, so copying the project
 * folder copies them and the list is always what is on disk.
 */
export function backgroundsDir(folder: string): string {
  return path.join(folder, ASSETS_DIR, BACKGROUNDS_DIR)
}

function toBackground(fileName: string): Background {
  const dot = fileName.lastIndexOf('.')
  return {
    id: fileName.slice(0, dot),
    name: backgroundDisplayName(fileName),
    url: backgroundUrl(fileName)
  }
}

/** Every background in the folder, by file name; a missing folder answers empty. */
export function listBackgrounds(folder: string): Background[] {
  const dir = backgroundsDir(folder)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && backgroundExtension(entry.name) !== null)
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map(toBackground)
}

/**
 * Copies `source` into the folder under a minted id and answers the new background. Refuses a
 * type outside `BACKGROUND_EXTENSIONS` or a file over `BACKGROUND_MAX_BYTES` with VALIDATION
 * (before reading it); a missing source is NOT_FOUND.
 */
export function addBackground(folder: string, source: string): Background {
  const name = path.basename(source)
  const ext = backgroundExtension(name)
  if (ext === null) {
    throw new AppError(
      'VALIDATION',
      `${name} is not an image MythScribe can use (${BACKGROUND_EXTENSIONS.join(', ')})`,
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
  if (stat.size > BACKGROUND_MAX_BYTES) {
    const limit = Math.round(BACKGROUND_MAX_BYTES / (1024 * 1024))
    throw new AppError('VALIDATION', `${name} is larger than ${limit} MB`, { source })
  }
  const dir = backgroundsDir(folder)
  fs.mkdirSync(dir, { recursive: true })
  const fileName = backgroundFileName(
    name,
    randomUUID().replace(/-/g, '').slice(0, BACKGROUND_ID_CHARS)
  )
  fs.copyFileSync(source, path.join(dir, fileName), fs.constants.COPYFILE_EXCL)
  return toBackground(fileName)
}

/** Deletes the background with this id; NOT_FOUND when no file carries it. */
export function removeBackground(folder: string, id: string): void {
  const found = listBackgrounds(folder).find((b) => b.id === id)
  if (!found) throw new AppError('NOT_FOUND', `No background ${id}`, { id })
  // The stored file is `<id>.<ext>`; `name` is the display name without the short id.
  fs.rmSync(path.join(backgroundsDir(folder), `${found.id}.${backgroundExtension(found.name)}`))
}
