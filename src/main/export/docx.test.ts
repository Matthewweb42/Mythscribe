import { describe, expect, it } from 'vitest'
import { BUILTIN_COMPILE_FORMATS } from '@shared/compileFormat'
import { readZip } from '../backups/zip'
import { renderDocx } from './docx'
import { builtinFormat, sampleBook, xmlError } from './testBook'

const MODIFIED = new Date('2026-10-07T10:00:00Z')

function parts(buffer: Buffer): Map<string, string> {
  return new Map(readZip(buffer).map((entry) => [entry.name, entry.data.toString('utf8')]))
}

function docx(formatId: string): Map<string, string> {
  return parts(renderDocx(sampleBook(formatId, 'docx'), { modified: MODIFIED }))
}

/** The document's paragraphs as plain text, in order. */
function paragraphTexts(xml: string): string[] {
  return [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)].map((m) =>
    [...(m[1] ?? '').matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/g)]
      .map((t) => t[1])
      .join('')
  )
}

describe('renderDocx (Compile v2)', () => {
  it('writes a well-formed package whose content types and relationships name every part', () => {
    for (const format of BUILTIN_COMPILE_FORMATS) {
      const files = parts(renderDocx(sampleBook(format, 'docx'), { modified: MODIFIED }))
      for (const [name, xml] of files) expect(xmlError(xml), `${format.id} ${name}`).toBeNull()
      const types = files.get('[Content_Types].xml') ?? ''
      const rels = files.get('word/_rels/document.xml.rels') ?? ''
      for (const name of files.keys()) {
        if (!name.startsWith('word/') || name.includes('_rels')) continue
        expect(types, `${format.id} ${name}`).toContain(`PartName="/${name}"`)
        if (name !== 'word/document.xml')
          expect(rels, `${format.id} ${name}`).toContain(`Target="${name.slice(5)}"`)
      }
      // Every r:id the document uses is a relationship.
      for (const [, id] of (files.get('word/document.xml') ?? '').matchAll(/r:id="(rId\d+)"/g))
        expect(rels).toContain(`Id="${id}"`)
    }
  })

  it('sets Standard Manuscript exactly: Times-like 12 pt, double-spaced, 1 in margins, ½ in indent', () => {
    const files = docx('standard-manuscript')
    const styles = files.get('word/styles.xml') ?? ''
    expect(styles).toContain('w:ascii="Times New Roman"')
    expect(styles).toContain('<w:sz w:val="24"/>')
    expect(styles).toContain('w:line="480" w:lineRule="auto"')
    expect(styles).toMatch(/w:styleId="Normal">.*<w:ind w:firstLine="720"\/>/)
    expect(styles).toContain('<w:lang w:val="en-GB"/>')
    const document = files.get('word/document.xml') ?? ''
    expect(document).toContain('<w:pgSz w:w="12240" w:h="15840"/>')
    expect(document).toContain('w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"')
    // The title page is its own section; the body restarts at page 1.
    expect(document.match(/<w:sectPr>/g)).toHaveLength(
      document.match(/<w:type w:val=/g)?.length ?? 0
    )
    expect(document).toContain('<w:pgNumType w:start="1"/>')
    expect(document).not.toContain('w:titlePg')
  })

  it('prints the Shunn first page, the header, chapter headings, and # scene breaks', () => {
    const files = docx('standard-manuscript')
    const texts = paragraphTexts(files.get('word/document.xml') ?? '')
    expect(texts.slice(0, 5)).toEqual([
      'Ada M. Marlowe' + 'about 100 words',
      '12 Harbour Lane',
      'ada@example.com',
      'The Salt Road',
      'by Ada Marlowe'
    ])
    expect(texts).toContain('Chapter OneThe Storm')
    expect(texts).toContain('#')
    // The body's header reads "Surname / TITLE / page"; the title page's is empty.
    const headers = [...files.entries()].filter(([name]) => name.startsWith('word/header'))
    const furnished = headers.filter(([, xml]) =>
      paragraphTexts(xml).includes('Marlowe / THE SALT ROAD / ')
    )
    expect(furnished).toHaveLength(1)
    expect(furnished[0]?.[1]).toContain('<w:fldSimple w:instr=" PAGE ">')
    expect(headers.some(([, xml]) => !/<w:t[ >]/.test(xml))).toBe(true)
  })

  it('lays out a paperback: mirrored margins with gutter, facing headers, bare openers on odd pages', () => {
    const files = docx('paperback-6x9')
    const settings = files.get('word/settings.xml') ?? ''
    expect(settings).toContain('<w:mirrorMargins/>')
    expect(settings).toContain('<w:evenAndOddHeaders/>')
    expect(settings).toContain('<w:autoHyphenation/>')
    const document = files.get('word/document.xml') ?? ''
    expect(document).toContain('<w:pgSz w:w="8640" w:h="12960"/>')
    expect(document).toContain('w:gutter="180"')
    expect(document).toContain('<w:type w:val="oddPage"/>')
    expect(document).toContain('<w:titlePg/>')
    expect(document).toContain('w:type="even"')
    const headers = [...files.values()].join('')
    expect(headers).toContain('Ada Marlowe')
    // `{title}` on rectos.
    expect(headers).toContain('The Salt Road')
    const styles = files.get('word/styles.xml') ?? ''
    expect(styles).toContain('w:ascii="EB Garamond"')
    expect(styles).toContain('w:line="300" w:lineRule="exact"')
    expect(styles).toMatch(/w:styleId="ChapterTitle">.*<w:smallCaps\/>.*<w:outlineLvl w:val="1"\/>/)
  })

  it('writes notes as comments in the Editor copy', () => {
    const files = docx('editor-copy')
    const comments = files.get('word/comments.xml') ?? ''
    expect(comments).toContain('Check the tide tables.')
    expect(comments).toContain('Scene note.')
    expect(comments).toContain('w:author="Ada Marlowe"')
    const document = files.get('word/document.xml') ?? ''
    expect(document.match(/<w:commentReference w:id="\d+"\/>/g)).toHaveLength(2)
    expect(files.get('[Content_Types].xml')).toContain('/word/comments.xml')
  })

  it('opens chapters with a framed drop cap and links the contents to bookmarks', () => {
    const files = docx('ebook')
    const document = files.get('word/document.xml') ?? ''
    expect(document).toContain('w:dropCap="drop"')
    expect(document).toContain(
      '<w:instrText xml:space="preserve"> TOC \\o "1-2" \\h \\z \\u </w:instrText>'
    )
    const anchors = [...document.matchAll(/w:anchor="([^"]+)"/g)].map((m) => m[1])
    expect(anchors.length).toBeGreaterThan(0)
    for (const anchor of anchors) expect(document).toContain(`w:name="${anchor}"`)
  })

  it('marks bold and italic and escapes text', () => {
    const format = builtinFormat('plain-text')
    const document = parts(renderDocx(sampleBook(format, 'docx'), { modified: MODIFIED })).get(
      'word/document.xml'
    )
    expect(document).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Bold</w:t>')
    expect(document).toContain('<w:rPr><w:i/></w:rPr><w:t xml:space="preserve">italic</w:t>')
    expect(document).toContain('she said &amp; left.')
  })
})
