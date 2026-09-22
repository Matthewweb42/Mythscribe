import fs from 'node:fs/promises'
import path from 'node:path'
import { importFormatOf, type ImportFormat } from '@shared/import'
import { AppError } from '../ipc/errors'
import type { ImportBlock } from './blocks'
import { readDocx } from './docx'
import { readMarkdown, readPlainText } from './text'

/**
 * Manuscript import (F-12.2): picks the reader for the file the author chose and turns it into
 * blocks. Every way this can fail is the author's to act on — the wrong kind of file, a file
 * another program has open, a file with nothing in it — so each one is a VALIDATION error whose
 * message the toast can show as it stands.
 */
export interface ManuscriptFile {
  blocks: ImportBlock[]
  format: ImportFormat
  /** The file's base name, extension included. */
  name: string
}

export async function readManuscript(filePath: string): Promise<ManuscriptFile> {
  const name = path.basename(filePath)
  const format = importFormatOf(name)
  if (format === null) {
    throw new AppError(
      'VALIDATION',
      'Unsupported file type. Import a Word (.docx), Markdown (.md), or plain-text (.txt) file.',
      { name }
    )
  }

  let blocks: ImportBlock[]
  try {
    blocks =
      format === 'docx'
        ? await readDocx(await fs.readFile(filePath))
        : readFromText(await fs.readFile(filePath, 'utf8'), format)
  } catch (err) {
    throw new AppError('VALIDATION', `Could not read the file: ${messageOf(err)}`, { name })
  }

  if (!blocks.some((block) => block.type === 'paragraph')) {
    throw new AppError('VALIDATION', 'The file has no text to import.', { name })
  }
  return { blocks, format, name }
}

function readFromText(text: string, format: Exclude<ImportFormat, 'docx'>): ImportBlock[] {
  return format === 'md' ? readMarkdown(text) : readPlainText(text)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
