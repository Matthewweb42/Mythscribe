import type { ExportOptions } from '@shared/bookExport'
import type { CompiledEntry } from '@shared/compile'
import type { SectionType } from '@shared/labels'
import type { TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import type { NodeRow } from '../db/schema'
import { compiledEntry, compileSection } from '../document/compileStore'
import { AppError } from '../ipc/errors'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { bodyBlocks, docBlocks, type BookBlock, type BookUnit } from './model'

/**
 * The book an export prints (F-12.1): the units in reading order (front matter, the body, end
 * matter) and the words of the text they print. Collected from the stored documents, so the
 * renderer flushes its stores before asking.
 */
export interface Book {
  units: BookUnit[]
  words: number
}

/** A document with something to print: its content counts at least one word. */
function printable(entry: CompiledEntry): entry is CompiledEntry & { content: TiptapNodeT } {
  return entry.kind === 'document' && entry.content !== null && countWords(entry.content) > 0
}

function wordsOf(entries: readonly CompiledEntry[]): number {
  let words = 0
  for (const entry of entries) if (printable(entry)) words += countWords(entry.content)
  return words
}

/**
 * Front or end matter: each child of the section root is one unit, whose documents print their
 * text only (a "Title page" document must not print "Title page"). A unit with nothing to print
 * is left out.
 */
function matterUnits(
  db: TreeDb,
  section: SectionType,
  rows: readonly NodeRow[]
): { units: BookUnit[]; words: number } {
  const units: BookUnit[] = []
  let words = 0
  let current: { title: string; entries: CompiledEntry[] } | null = null
  const close = (): void => {
    if (current === null) return
    const docs = current.entries.filter(printable)
    const blocks: BookBlock[] = docs.flatMap((entry) => docBlocks(entry.content))
    if (blocks.length > 0) {
      units.push({ kind: 'matter', title: current.title, blocks })
      words += wordsOf(docs)
    }
  }
  for (const entry of compileSection(db, section, {}, rows)) {
    if (entry.depth === 0) {
      close()
      current = { title: entry.title, entries: [] }
    }
    current?.entries.push(entry)
  }
  close()
  return { units, words }
}

/**
 * The book for `options`: the manuscript, the chosen chapters (with the parts that hold them as
 * titles), or one document from any section printed alone. Front and end matter come along when
 * asked, except for a single document. Nothing to print is VALIDATION.
 */
export function collectBook(db: TreeDb, options: ExportOptions, projectName: string): Book {
  const rows = listNodes(db)
  const { scope } = options
  let body: CompiledEntry[]
  let bodyTitle = projectName
  if (scope.kind === 'document') {
    const row = rows.find((r) => r.id === scope.id)
    if (row === undefined) throw new AppError('NOT_FOUND', 'Document not found', { id: scope.id })
    if (row.kind !== 'document') {
      throw new AppError('VALIDATION', 'Only a document can be exported on its own', {
        id: scope.id
      })
    }
    body = [compiledEntry(row, 0, new Map())]
    bodyTitle = row.title
  } else {
    body = compileSection(
      db,
      'manuscript',
      scope.kind === 'chapters' ? { only: new Set(scope.ids) } : {},
      rows
    )
  }

  const single = scope.kind === 'document'
  const front = options.includeFront && !single ? matterUnits(db, 'front', rows) : null
  const end = options.includeEnd && !single ? matterUnits(db, 'end', rows) : null
  const units: BookUnit[] = [...(front?.units ?? [])]
  // A body without a word of text prints nothing, titles included.
  const bodyWords = wordsOf(body)
  if (bodyWords > 0) units.push({ kind: 'body', title: bodyTitle, blocks: bodyBlocks(body) })
  units.push(...(end?.units ?? []))
  if (units.length === 0) throw new AppError('VALIDATION', 'Nothing to export.')
  return { units, words: (front?.words ?? 0) + bodyWords + (end?.words ?? 0) }
}
