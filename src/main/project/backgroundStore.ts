import fs from 'node:fs'
import {
  BACKGROUNDS_DIR,
  backgroundExtension,
  backgroundUrl,
  type Background,
  backgroundDisplayName
} from '@shared/focus'
import { AppError } from '../ipc/errors'
import { addImageAsset, assetDir, removeImageAsset } from './imageAssets'

/**
 * The focus-mode backgrounds of a project (F-6.2) are the image files in
 * `<Project>.mythscribe/assets/backgrounds/`, named `<id>.<ext>` with a minted id. The folder
 * is the record: nothing about a background is stored anywhere else, so copying the project
 * folder copies them and the list is always what is on disk. The copying itself is
 * `imageAssets.ts`, shared with the entity images (F-9.3).
 */
export function backgroundsDir(folder: string): string {
  return assetDir(folder, BACKGROUNDS_DIR)
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
  return toBackground(addImageAsset(folder, BACKGROUNDS_DIR, source, 'background'))
}

/** Deletes the background with this id; NOT_FOUND when no file carries it. */
export function removeBackground(folder: string, id: string): void {
  const found = listBackgrounds(folder).find((b) => b.id === id)
  if (!found) throw new AppError('NOT_FOUND', `No background ${id}`, { id })
  // The stored file is `<id>.<ext>`; `name` is the display name without the short id.
  removeImageAsset(folder, BACKGROUNDS_DIR, `${found.id}.${backgroundExtension(found.name)}`)
}
