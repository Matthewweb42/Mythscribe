import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { docToText } from '@shared/docText'
import { notebookTitleFromFileName } from '@shared/notebook'
import { textPdf } from '../library/pdfFixture'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import type { TreeDb } from '../tree/treeStore'
import { importNotebookFiles, notebookPageFromFile } from './notebookImport'
import { createNotebookItem, getNotebookPage, listNotebook } from './notebookStore'

const SAMPLE_DOCX = path.join(import.meta.dirname, '..', 'import', 'fixtures', 'sample.docx')

let tmp: string
let session: ProjectSession
let db: TreeDb

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-notebook-import-'))
  session = createProject(projectFolderFor(tmp, 'Notes'), 'Notes', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.connection.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const source = (name: string, text: string, folders: string[] = []) => ({
  name,
  folders,
  read: () => Buffer.from(text, 'utf8')
})

describe('notebookPageFromFile', () => {
  it('keeps a Markdown file’s headings and paragraphs', async () => {
    const page = await notebookPageFromFile(
      'reef.md',
      Buffer.from('# The reef\n\nQuillback rockfish *live* deep.\n\n#### Deeper\n\nMore.\n')
    )
    if (!('content' in page)) throw new Error('expected a page')
    const blocks = page.content.content ?? []
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'heading', 'paragraph'])
    expect(blocks[0]?.attrs).toEqual({ level: 1 })
    // A heading deeper than the editor's three levels is a level-3 one.
    expect(blocks[2]?.attrs).toEqual({ level: 3 })
    expect(docToText(page.content)).toContain('Quillback rockfish live deep.')
  })

  it('reads a Word file through the manuscript importer, headings kept', async () => {
    const page = await notebookPageFromFile('sample.docx', fs.readFileSync(SAMPLE_DOCX))
    if (!('content' in page)) throw new Error('expected a page')
    expect(page.content.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
    expect(docToText(page.content)).toContain('Chapter One')
    expect(docToText(page.content)).toContain('The bell rang twice & then stopped.')
  })

  it('reads plain text and a PDF’s text layer as paragraphs', async () => {
    const text = await notebookPageFromFile('a.txt', Buffer.from('First line.\n\nSecond line.\n'))
    if (!('content' in text)) throw new Error('expected a page')
    expect(text.content.content?.map((b) => b.type)).toEqual(['paragraph', 'paragraph'])
    const pdf = await notebookPageFromFile('map.pdf', textPdf(['The northern pass', 'is closed']))
    if (!('content' in pdf)) throw new Error('expected a page')
    expect(docToText(pdf.content)).toContain('The northern pass')
  })

  it('skips images, unknown types, and files with no text, saying why', async () => {
    expect(await notebookPageFromFile('art.png', Buffer.from([1, 2, 3]))).toEqual({
      skip: 'An image has no text to make a page from.'
    })
    const epub = await notebookPageFromFile('book.epub', Buffer.from('x'))
    expect('skip' in epub && epub.skip.includes('Word (.docx)')).toBe(true)
    expect(await notebookPageFromFile('empty.md', Buffer.from('\n\n'))).toEqual({
      skip: 'No text found in the file.'
    })
  })
})

describe('importNotebookFiles', () => {
  it('makes one page per file, titled by its name, at the top level', async () => {
    const result = await importNotebookFiles(db, null, [
      source('Mara.md', '# Mara\n\nGrey eyes.'),
      source('Places.txt', 'The quay.')
    ])
    expect(result.skipped).toEqual([])
    expect(result.items.map((i) => [i.kind, i.title, i.parentId])).toEqual([
      ['page', 'Mara', null],
      ['page', 'Places', null]
    ])
    expect(getNotebookPage(db, result.items[0]?.id ?? '').plain).toContain('Grey eyes.')
  })

  it('keeps a dropped folder’s structure, each folder made once, under the chosen folder', async () => {
    const into = createNotebookItem(db, { parentId: null, kind: 'folder', title: 'Imports' })
    const result = await importNotebookFiles(db, into.id, [
      source('a.md', 'A.', ['World']),
      source('b.md', 'B.', ['World', 'Magic']),
      source('c.md', 'C.', ['World'])
    ])
    const byTitle = new Map(listNotebook(db).map((item) => [item.title, item]))
    const world = byTitle.get('World')
    const magic = byTitle.get('Magic')
    expect(world).toMatchObject({ kind: 'folder', parentId: into.id })
    expect(magic).toMatchObject({ kind: 'folder', parentId: world?.id })
    expect(byTitle.get('a')?.parentId).toBe(world?.id)
    expect(byTitle.get('b')?.parentId).toBe(magic?.id)
    expect(byTitle.get('c')?.parentId).toBe(world?.id)
    expect(result.items.filter((i) => i.kind === 'folder')).toHaveLength(2)
  })

  it('skips what cannot become a page and still imports the rest', async () => {
    const result = await importNotebookFiles(db, null, [
      source('art.jpg', 'x'),
      { name: 'big.md', folders: [], size: 26 * 1024 * 1024, read: () => Buffer.from('x') },
      { name: 'broken.docx', folders: [], read: () => Buffer.from('not a zip') },
      source('ok.md', 'Fine.')
    ])
    expect(result.items.map((i) => i.title)).toEqual(['ok'])
    expect(result.skipped.map((s) => s.name)).toEqual(['art.jpg', 'big.md', 'broken.docx'])
    expect(result.skipped[1]?.reason).toBe('The file is larger than 25 MB.')
    expect(result.skipped[2]?.reason).toMatch(/^Could not read the file/)
  })
})

describe('notebookTitleFromFileName', () => {
  it('drops the extension and keeps dotted names', () => {
    expect(notebookTitleFromFileName('Mara.md')).toBe('Mara')
    expect(notebookTitleFromFileName('v1.2 notes.txt')).toBe('v1.2 notes')
    expect(notebookTitleFromFileName('.md')).toBe('.md')
    expect(notebookTitleFromFileName('  .txt')).toBe('Untitled')
  })
})
