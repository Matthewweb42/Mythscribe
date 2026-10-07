import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTEXT_FILE_MAX_BYTES } from '@shared/contextLibrary'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { countTextWords, extractContextText } from './extract'
import {
  addContextFiles,
  getContextFileRow,
  libraryDir,
  listContextFiles,
  markContextFileProcessed,
  readContextText,
  storedPath,
  type ContextSource,
  type LibraryDb
} from './libraryStore'
import { textPdf } from './pdfFixture'

let tmp: string
let session: ProjectSession
let db: LibraryDb

const source = (name: string, data: string | Buffer): ContextSource => ({
  name,
  read: () => (typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-library-'))
  session = createProject(projectFolderFor(tmp, 'Lib'), 'Lib', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('extractContextText (F-9.8)', () => {
  it('reads text and Markdown as they are, a BOM and CRLFs removed', async () => {
    expect(await extractContextText('txt', Buffer.from('\uFEFFOne\r\n\r\n\r\n\r\nTwo\r\n'))).toBe(
      'One\n\nTwo'
    )
    expect(await extractContextText('md', Buffer.from('# Mara\n\nShe is 34.'))).toBe(
      '# Mara\n\nShe is 34.'
    )
    expect(await extractContextText('txt', Buffer.from('  \n\n '))).toBeNull()
  })

  it('reads a Word file through the manuscript importer, headings as their own paragraphs', async () => {
    const docx = fs.readFileSync(path.join(__dirname, '../import/fixtures/sample.docx'))
    const text = await extractContextText('docx', docx)
    expect(text).not.toBeNull()
    expect(text?.split('\n\n').length).toBeGreaterThan(2)
  })

  it('reads the text layer of a PDF, and finds none in a PDF without one (no OCR)', async () => {
    expect(
      await extractContextText('pdf', textPdf(['Mara Vell is a ferrywoman.', 'She is 34.']))
    ).toBe('Mara Vell is a ferrywoman.\nShe is 34.')
    expect(await extractContextText('pdf', textPdf([]))).toBeNull()
  })

  it('never reads an image', async () => {
    expect(await extractContextText('image', Buffer.from('not really a png'))).toBeNull()
    expect(countTextWords(null)).toBe(0)
    expect(countTextWords(' two  words ')).toBe(2)
  })
})

describe('addContextFiles (F-9.8)', () => {
  it('stores originals under assets/library and lists them with their state', async () => {
    const result = await addContextFiles(db, session.folder, [
      source('World notes.md', '# Mara\n\nShe is 34.'),
      source('map.png', Buffer.from([137, 80, 78, 71])),
      source('scan.pdf', textPdf([]))
    ])
    expect(result.changed).toHaveLength(3)
    expect(result.unchanged).toBe(0)
    expect(result.skipped).toEqual([])
    const byName = Object.fromEntries(result.files.map((file) => [file.name, file]))
    expect(byName['World notes.md']).toMatchObject({ type: 'md', state: 'new', words: 5 })
    expect(byName['map.png']).toMatchObject({ type: 'image', state: 'reference', words: 0 })
    expect(byName['scan.pdf']).toMatchObject({ type: 'pdf', state: 'noText' })
    const stored = fs.readdirSync(libraryDir(session.folder))
    expect(stored).toHaveLength(3)
    expect(stored.some((name) => /^World-notes\.[0-9a-f]{8}\.md$/.test(name))).toBe(true)
    const row = getContextFileRow(db, byName['World notes.md']!.id)!
    expect(await readContextText(session.folder, row)).toBe('# Mara\n\nShe is 34.')
  })

  it('skips an unsupported, an unreadable, and an oversized file with the reason', async () => {
    const result = await addContextFiles(db, session.folder, [
      source('book.epub', 'x'),
      { name: 'gone.txt', read: () => fs.readFileSync(path.join(tmp, 'missing.txt')) },
      { name: 'huge.txt', read: () => Buffer.alloc(CONTEXT_FILE_MAX_BYTES + 1) },
      source('ok.txt', 'fine')
    ])
    expect(result.skipped.map((s) => s.name)).toEqual(['book.epub', 'gone.txt', 'huge.txt'])
    expect(result.skipped[2]?.reason).toMatch(/larger than 25 MB/)
    expect(result.files.map((f) => f.name)).toEqual(['ok.txt'])
  })

  it('treats a file of the same name as an update: identical is unchanged, different replaces the original', async () => {
    const first = await addContextFiles(db, session.folder, [source('notes.md', 'One.\n\nTwo.')])
    const id = first.changed[0]!
    const oldStored = getContextFileRow(db, id)!.stored
    markContextFileProcessed(db, id, 'One.\n\nTwo.', '2026-10-07T10:00:00.000Z')
    expect(listContextFiles(db)[0]?.state).toBe('processed')

    const same = await addContextFiles(db, session.folder, [source('NOTES.md', 'One.\n\nTwo.')])
    expect(same).toMatchObject({ changed: [], unchanged: 1 })

    const updated = await addContextFiles(db, session.folder, [
      source('notes.md', 'One.\n\nThree.')
    ])
    expect(updated.changed).toEqual([id])
    expect(updated.files).toHaveLength(1)
    expect(updated.files[0]).toMatchObject({
      state: 'changed',
      processedAt: '2026-10-07T10:00:00.000Z'
    })
    const row = getContextFileRow(db, id)!
    expect(row.processedText).toBe('One.\n\nTwo.')
    expect(row.stored).not.toBe(oldStored)
    expect(fs.existsSync(path.join(libraryDir(session.folder), oldStored))).toBe(false)
  })

  it('updates the row the author chose, whatever the new file is called', async () => {
    const first = await addContextFiles(db, session.folder, [source('draft-1.txt', 'Old.')])
    const id = first.changed[0]!
    const result = await addContextFiles(db, session.folder, [source('draft-2.txt', 'New.')], id)
    expect(result.changed).toEqual([id])
    expect(result.files.map((f) => f.name)).toEqual(['draft-2.txt'])
    await expect(
      addContextFiles(db, session.folder, [source('x.txt', 'x')], 'nope')
    ).rejects.toThrow(AppError)
  })

  it('refuses a stored name that reaches outside the library folder', () => {
    expect(() => storedPath(session.folder, '../project.db')).toThrow(/not a stored library file/)
  })
})
