import { describe, expect, it } from 'vitest'
import { defaultExportFormatting } from '@shared/bookExport'
import { readZip } from '../backups/zip'
import { renderDocx } from './docx'
import type { BookUnit, Inline, Run } from './model'

const run = (text: string, marks: Partial<Run> = {}): Run => ({
  kind: 'text',
  text,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  ...marks
})
const p = (...runs: Inline[]): BookUnit['blocks'][number] => ({
  kind: 'paragraph',
  runs,
  align: null
})

const units: BookUnit[] = [
  { kind: 'matter', title: 'Dedication', blocks: [p(run('For M.'))] },
  {
    kind: 'body',
    title: 'Book',
    blocks: [
      { kind: 'title', level: 'chapter', text: 'Chapter One', inPart: true },
      p(run('First & <best>\u0001', { bold: true })),
      p(
        run('Next', { italic: true, underline: true, strike: true, code: true }),
        { kind: 'hardBreak' },
        run(' line ')
      ),
      { kind: 'sceneBreak' },
      { kind: 'paragraph', runs: [run('Centred')], align: 'center' },
      { kind: 'quote', blocks: [p(run('Quoted'))] },
      { kind: 'title', level: 'chapter', text: 'Chapter Two', inPart: true }
    ]
  }
]

function parts(buffer: Buffer): Map<string, string> {
  return new Map(readZip(buffer).map((entry) => [entry.name, entry.data.toString('utf8')]))
}

describe('renderDocx (F-12.1)', () => {
  it('writes the package parts with the title in the core properties', () => {
    const files = parts(
      renderDocx(
        units,
        defaultExportFormatting('* * *'),
        'My & Book',
        new Date('2026-10-05T10:00:00Z')
      )
    )
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/_rels/document.xml.rels',
      'docProps/core.xml'
    ])
    expect(files.get('docProps/core.xml')).toContain('<dc:title>My &amp; Book</dc:title>')
    expect(files.get('docProps/core.xml')).toContain('2026-10-05T10:00:00Z')
  })

  it('writes text with marks, breaks, styles, and page breaks', () => {
    const doc =
      parts(renderDocx(units, defaultExportFormatting('* * *'), 'Book')).get('word/document.xml') ??
      ''
    expect(doc).toContain(
      '<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">First &amp; &lt;best&gt;</w:t>'
    )
    expect(doc).toContain(
      '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:i/><w:strike/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">Next</w:t>'
    )
    expect(doc).toContain('<w:r><w:br/></w:r><w:r><w:t xml:space="preserve"> line </w:t></w:r>')
    // The unit after the matter starts a page; so does the later chapter.
    expect(doc).toContain(
      '<w:pPr><w:pStyle w:val="Heading2"/><w:pageBreakBefore/></w:pPr><w:r><w:t xml:space="preserve">Chapter One</w:t>'
    )
    expect(doc).toContain(
      '<w:pPr><w:pStyle w:val="Heading2"/><w:pageBreakBefore/></w:pPr><w:r><w:t xml:space="preserve">Chapter Two</w:t>'
    )
    // The first paragraph of the book is not a page break.
    expect(doc).toContain('<w:body><w:p><w:pPr><w:pStyle w:val="BodyFirst"/></w:pPr>')
    // After a title: unindented; then indented; after the scene break: unindented and centred text too.
    expect(doc).toContain('<w:pStyle w:val="BodyFirst"/></w:pPr><w:r><w:rPr><w:b/>')
    expect(doc).toContain('<w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:rFonts')
    expect(doc).toContain(
      '<w:pStyle w:val="SceneBreak"/></w:pPr><w:r><w:t xml:space="preserve">* * *</w:t>'
    )
    expect(doc).toContain(
      '<w:pStyle w:val="BodyFirst"/><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">Centred</w:t>'
    )
    expect(doc).toContain(
      '<w:ind w:left="720" w:right="720"/></w:pPr><w:r><w:t xml:space="preserve">Quoted</w:t>'
    )
    expect(doc).toContain('<w:pgSz w:w="12240" w:h="15840"/>')
    expect(doc).not.toContain('\u0001')
  })

  it('carries the formatting in the styles and the page size in the section', () => {
    const formatting = {
      ...defaultExportFormatting('*'),
      font: 'sans' as const,
      fontSize: 11,
      lineSpacing: 2 as const,
      pageSize: 'a4' as const,
      indentParagraphs: false,
      chapterNewPage: false
    }
    const files = parts(renderDocx(units, formatting, 'Book'))
    const styles = files.get('word/styles.xml') ?? ''
    expect(styles).toContain(
      '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/>'
    )
    expect(styles).toContain('<w:sz w:val="22"/>')
    expect(styles).toContain('w:line="480" w:lineRule="auto"')
    expect(styles).toContain(
      '<w:ind w:firstLine="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="BodyFirst">'
    )
    const doc = files.get('word/document.xml') ?? ''
    expect(doc).toContain('<w:pgSz w:w="11906" w:h="16838"/>')
    expect(doc).not.toContain(
      '<w:pageBreakBefore/></w:pPr><w:r><w:t xml:space="preserve">Chapter Two'
    )
  })
})
