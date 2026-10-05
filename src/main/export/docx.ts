import type { ExportFormatting } from '@shared/bookExport'
import { zipBuffer } from '../backups/zip'
import { startsPage, type Align, type BookBlock, type BookUnit, type Inline } from './model'
import { escapeXml } from './xml'

/**
 * The DOCX export (F-12.1): a minimal WordprocessingML package written by hand and zipped with
 * the backup zip writer, so no dependency. Formatting lives in `word/styles.xml` (Normal carries
 * the font, size, line spacing, and first-line indent; BodyFirst the unindented first paragraph
 * after a title, heading, or scene break), so an author restyling the file in Word changes one
 * style, not every paragraph.
 */

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/** Twips (1/20 pt). Letter is 8.5 × 11 in, A4 210 × 297 mm; margins are 1 in. */
const PAGE: Record<ExportFormatting['pageSize'], { w: number; h: number }> = {
  letter: { w: 12240, h: 15840 },
  a4: { w: 11906, h: 16838 }
}
const MARGIN = 1440
const INDENT = 720

const FONTS: Record<ExportFormatting['font'], string> = {
  serif: 'Times New Roman',
  sans: 'Arial'
}

const JUSTIFY: Record<Align, string> = {
  left: 'left',
  center: 'center',
  right: 'right',
  justify: 'both'
}

const plain = {
  kind: 'text',
  text: '',
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false
} as const

function runXml(run: Inline): string {
  if (run.kind === 'hardBreak') return '<w:r><w:br/></w:r>'
  // In CT_RPr's sequence: rFonts, b, i, strike, u.
  const props = [
    run.code ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>' : '',
    run.bold ? '<w:b/>' : '',
    run.italic ? '<w:i/>' : '',
    run.strike ? '<w:strike/>' : '',
    run.underline ? '<w:u w:val="single"/>' : ''
  ].join('')
  const rPr = props.length > 0 ? `<w:rPr>${props}</w:rPr>` : ''
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`
}

interface ParagraphProps {
  style: string
  align?: Align | null
  pageBreak: boolean
  /** Extra left indent in twips (block quotes). */
  indent: number
}

function paragraphXml(content: string, props: ParagraphProps): string {
  // CT_PPr order: pStyle, keepNext…, pageBreakBefore, …, ind, …, jc.
  const pPr = [
    `<w:pStyle w:val="${props.style}"/>`,
    props.pageBreak ? '<w:pageBreakBefore/>' : '',
    props.indent > 0 ? `<w:ind w:left="${props.indent}" w:right="${props.indent}"/>` : '',
    props.align !== undefined && props.align !== null
      ? `<w:jc w:val="${JUSTIFY[props.align]}"/>`
      : ''
  ].join('')
  return `<w:p><w:pPr>${pPr}</w:pPr>${content}</w:p>`
}

function bodyXml(units: readonly BookUnit[], formatting: ExportFormatting): string {
  const out: string[] = []
  // Whether the next body paragraph is the first after a title, heading, or break (no indent).
  let first = true
  const block = (b: BookBlock, pageBreak: boolean, indent: number): void => {
    switch (b.kind) {
      case 'title':
        out.push(
          paragraphXml(runXml({ ...plain, text: b.text }), {
            style: b.level === 'part' ? 'Heading1' : 'Heading2',
            pageBreak,
            indent
          })
        )
        first = true
        return
      case 'heading':
        out.push(
          paragraphXml(b.runs.map(runXml).join(''), {
            style: `Heading${b.level + 2}`,
            align: b.align,
            pageBreak,
            indent
          })
        )
        first = true
        return
      case 'paragraph': {
        const unindented = first || b.align === 'center' || b.align === 'right'
        out.push(
          paragraphXml(b.runs.map(runXml).join(''), {
            style: unindented ? 'BodyFirst' : 'Normal',
            align: b.align,
            pageBreak,
            indent
          })
        )
        first = false
        return
      }
      case 'quote':
        b.blocks.forEach((inner, index) => block(inner, pageBreak && index === 0, indent + INDENT))
        first = true
        return
      case 'sceneBreak':
        out.push(
          paragraphXml(runXml({ ...plain, text: formatting.sceneBreak }), {
            style: 'SceneBreak',
            pageBreak,
            indent
          })
        )
        first = true
    }
  }
  units.forEach((unit, unitIndex) => {
    first = true
    unit.blocks.forEach((b, blockIndex) => {
      block(b, startsPage(unitIndex, blockIndex, b, formatting.chapterNewPage), 0)
    })
  })
  const page = PAGE[formatting.pageSize]
  out.push(
    `<w:sectPr><w:pgSz w:w="${page.w}" w:h="${page.h}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`
  )
  return out.join('')
}

function documentXml(units: readonly BookUnit[], formatting: ExportFormatting): string {
  return `${XML_DECL}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${bodyXml(units, formatting)}</w:body></w:document>`
}

function headingStyle(level: number, halfPoints: number, centred: boolean): string {
  return (
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>` +
    '<w:basedOn w:val="Normal"/><w:next w:val="BodyFirst"/><w:uiPriority w:val="9"/><w:qFormat/>' +
    `<w:pPr><w:keepNext/><w:spacing w:before="480" w:after="240"/><w:ind w:firstLine="0"/>${centred ? '<w:jc w:val="center"/>' : ''}<w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/></w:rPr></w:style>`
  )
}

function stylesXml(formatting: ExportFormatting): string {
  const font = FONTS[formatting.font]
  const size = formatting.fontSize * 2
  const line = Math.round(240 * formatting.lineSpacing)
  const firstLine = formatting.indentParagraphs ? INDENT : 0
  // Without indents, paragraphs are told apart by a gap instead.
  const after = formatting.indentParagraphs ? 0 : Math.round(size * 5)
  return (
    `${XML_DECL}<w:styles xmlns:w="${W_NS}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>` +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:val="en-US"/>` +
    '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>' +
    `<w:spacing w:before="0" w:after="${after}" w:line="${line}" w:lineRule="auto"/>` +
    '</w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>' +
    `<w:pPr><w:ind w:firstLine="${firstLine}"/></w:pPr></w:style>` +
    '<w:style w:type="paragraph" w:styleId="BodyFirst"><w:name w:val="Body First"/>' +
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:ind w:firstLine="0"/></w:pPr></w:style>' +
    headingStyle(1, Math.round(size * 1.8), true) +
    headingStyle(2, Math.round(size * 1.4), true) +
    headingStyle(3, Math.round(size * 1.2), false) +
    headingStyle(4, Math.round(size * 1.1), false) +
    headingStyle(5, size, false) +
    '<w:style w:type="paragraph" w:styleId="SceneBreak"><w:name w:val="Scene Break"/>' +
    '<w:basedOn w:val="Normal"/><w:next w:val="BodyFirst"/><w:qFormat/>' +
    '<w:pPr><w:spacing w:before="240" w:after="240"/><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr></w:style>' +
    '</w:styles>'
  )
}

const CONTENT_TYPES =
  `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '</Types>'

const ROOT_RELS =
  `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '</Relationships>'

const DOCUMENT_RELS =
  `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>'

/** W3CDTF without milliseconds, as Word writes it. */
export function w3cdtf(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`
}

function coreXml(title: string, modified: Date): string {
  const stamp = w3cdtf(modified)
  return (
    `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    '</cp:coreProperties>'
  )
}

export function renderDocx(
  units: readonly BookUnit[],
  formatting: ExportFormatting,
  title: string,
  modified = new Date()
): Buffer {
  const file = (name: string, text: string): { name: string; data: Buffer } => ({
    name,
    data: Buffer.from(text, 'utf8')
  })
  return zipBuffer(
    [
      file('[Content_Types].xml', CONTENT_TYPES),
      file('_rels/.rels', ROOT_RELS),
      file('word/document.xml', documentXml(units, formatting)),
      file('word/styles.xml', stylesXml(formatting)),
      file('word/_rels/document.xml.rels', DOCUMENT_RELS),
      file('docProps/core.xml', coreXml(title, modified))
    ],
    modified
  )
}
