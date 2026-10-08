import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultExportFormatting, type ExportFormat, type ExportProgress } from '@shared/bookExport'
import { BUILTIN_COMPILE_FORMATS, COMPILE_OUTPUTS } from '@shared/compileFormat'
import type { CompiledBook } from '@shared/compileModel'
import { readZip } from '../backups/zip'
import { saveDocument } from '../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { setBookDetails } from '../project/settingsStore'
import { compileToFile, exportBook } from './run'

let tmp: string
let session: ProjectSession
let db: TreeDb

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-export-run-'))
  session = createProject(projectFolderFor(tmp, 'Run'), 'Run', 'novel')
  db = session.connection.orm
  const scene = listNodes(db).find((r) => r.hierarchyLevel === 'scene')
  if (!scene) throw new Error('seed changed')
  saveDocument(db, scene.id, {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The storm broke.' }] }]
  })
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function run(format: ExportFormat): Promise<{
  file: string
  progress: ExportProgress[]
  renderPdf: ReturnType<typeof vi.fn<(book: CompiledBook) => Promise<Buffer>>>
  words: number
}> {
  const file = path.join(tmp, `book.${format}`)
  const progress: ExportProgress[] = []
  const renderPdf = vi.fn<(book: CompiledBook) => Promise<Buffer>>(() =>
    Promise.resolve(Buffer.from('%PDF-1.4 fake'))
  )
  const result = await exportBook(db, {
    options: {
      format,
      scope: { kind: 'manuscript' },
      includeFront: true,
      includeEnd: true,
      formatting: defaultExportFormatting('* * *')
    },
    projectName: 'Run',
    projectFolder: session.folder,
    path: file,
    requestId: 'req-1',
    onProgress: (p) => progress.push(p),
    renderPdf
  })
  expect(result).toEqual({ path: file, format, words: 3 })
  return { file, progress, renderPdf, words: result.words }
}

describe('exportBook (F-12.1)', () => {
  it('writes Markdown atomically and reports every stage under the request id', async () => {
    const { file, progress } = await run('md')
    expect(fs.readFileSync(file, 'utf8')).toContain('The storm broke.')
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    expect(progress.map((p) => [p.requestId, p.stage, p.done, p.total])).toEqual([
      ['req-1', 'collect', 0, 1],
      ['req-1', 'collect', 1, 1],
      ['req-1', 'render', 0, 1],
      ['req-1', 'render', 1, 1],
      ['req-1', 'write', 0, 1],
      ['req-1', 'write', 1, 1]
    ])
  })

  it('prints the compiled book through the injected PDF renderer', async () => {
    const { file, renderPdf } = await run('pdf')
    expect(fs.readFileSync(file, 'utf8')).toBe('%PDF-1.4 fake')
    expect(renderPdf).toHaveBeenCalledOnce()
    const [book] = renderPdf.mock.calls[0] ?? []
    expect(book?.output).toBe('pdf')
    expect(book?.format.pageSetup.size).toBe('letter')
    expect(book?.words).toBe(3)
  })

  it('writes DOCX and EPUB as zips', async () => {
    for (const format of ['docx', 'epub'] as const) {
      const { file } = await run(format)
      const bytes = fs.readFileSync(file)
      expect(bytes.toString('latin1', 0, 2)).toBe('PK')
      const names = readZip(bytes).map((e) => e.name)
      expect(names).toContain(format === 'docx' ? 'word/document.xml' : 'OEBPS/content.opf')
    }
  })
})

describe('compileToFile (Compile v2)', () => {
  const pdf = vi.fn<(book: CompiledBook) => Promise<Buffer>>(() =>
    Promise.resolve(Buffer.from('%PDF-1.7 fake'))
  )

  it('writes every output with a built-in format', async () => {
    const format = BUILTIN_COMPILE_FORMATS.find((f) => f.id === 'builtin:editor-copy')
    if (!format) throw new Error('no editor copy')
    for (const output of COMPILE_OUTPUTS) {
      const file = path.join(tmp, `book.${output}`)
      const result = await compileToFile(db, {
        format,
        output,
        scope: { kind: 'manuscript' },
        projectName: 'Run',
        projectFolder: session.folder,
        path: file,
        requestId: 'c1',
        onProgress: () => undefined,
        renderPdf: pdf
      })
      expect(result).toEqual({ path: file, output, words: 3 })
      const bytes = fs.readFileSync(file)
      if (output === 'docx' || output === 'epub' || output === 'odt')
        expect(bytes.toString('latin1', 0, 2)).toBe('PK')
      else if (output === 'rtf') expect(bytes.toString('latin1', 0, 6)).toBe('{\\rtf1')
      else if (output !== 'pdf') expect(bytes.toString('utf8')).toContain('The storm broke.')
    }
  })

  it('puts the Book details cover into the EPUB', async () => {
    const covers = path.join(session.folder, 'assets', 'covers')
    fs.mkdirSync(covers, { recursive: true })
    fs.writeFileSync(path.join(covers, 'cover.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    setBookDetails(db, { cover: 'cover.png' })
    const format = BUILTIN_COMPILE_FORMATS.find((f) => f.id === 'builtin:ebook')
    if (!format) throw new Error('no ebook')
    const file = path.join(tmp, 'book.epub')
    await compileToFile(db, {
      format,
      output: 'epub',
      scope: { kind: 'manuscript' },
      projectName: 'Run',
      projectFolder: session.folder,
      path: file,
      requestId: 'c2',
      onProgress: () => undefined,
      renderPdf: pdf
    })
    const names = readZip(fs.readFileSync(file)).map((e) => e.name)
    expect(names).toContain('OEBPS/images/cover.png')
    expect(names).toContain('OEBPS/cover.xhtml')
  })
})
