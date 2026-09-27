import fs from 'node:fs'

/**
 * Writes through a sibling temp file and renames, as the app-state store does, so a failed write
 * leaves no half file where the author expected a whole one. Shared by every text file the app
 * writes for the author: the AI disclosure report (F-14.6) and the entity library (F-9.5).
 */
export function writeTextAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}
