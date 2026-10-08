import type { ExportOptions } from '@shared/bookExport'
import {
  BUILTIN_COMPILE_FORMATS,
  type CompileFormat,
  type SectionLayout
} from '@shared/compileFormat'

/**
 * The F-12.1 Export dialog's options as a compile format, so the dialog prints through the
 * Compile v2 writers until the compile window (CV3) replaces it, then this file goes with it:
 * node titles as headings (nothing numbered), parts and chapters on new pages when asked, the
 * dialog's font (serif: Liberation Serif, Times-like; sans: Source Sans 3), size, line spacing,
 * page size with 1 in margins, indents (or spaced paragraphs), and scene break text; the
 * project's own front and end matter when asked; no generated pages, headers, or replacements.
 */
export function exportDialogFormat(options: ExportOptions): CompileFormat {
  const plain = BUILTIN_COMPILE_FORMATS.find((f) => f.id === 'builtin:plain-text')
  if (plain === undefined) throw new Error('The built-in Plain text format is missing')
  const { formatting } = options
  const font = formatting.font === 'serif' ? 'liberationSerif' : 'sourceSans3'
  const pageBreak = formatting.chapterNewPage ? 'newPage' : 'none'
  const title = (size: number, over: Partial<SectionLayout> = {}): SectionLayout => ({
    ...plain.sections.chapter,
    size,
    bold: true,
    spaceBefore: 24,
    spaceAfter: 12,
    pageBreak,
    firstParagraph: 'noIndent',
    ...over
  })
  const size = formatting.fontSize
  return {
    ...plain,
    id: 'export:dialog',
    name: 'Export',
    defaultOutput: options.format,
    sections: {
      part: title(Math.round(size * 1.8)),
      chapter: title(Math.round(size * 1.4)),
      chapterScene: title(Math.round(size * 1.4)),
      scene: plain.sections.scene
    },
    sceneSeparator: { kind: 'text', text: formatting.sceneBreak },
    pageSetup: {
      size: formatting.pageSize,
      width: formatting.pageSize === 'a4' ? 8.27 : 8.5,
      height: formatting.pageSize === 'a4' ? 11.69 : 11,
      margins: { top: 1, bottom: 1, inside: 1, outside: 1 },
      mirrored: false,
      gutter: 0
    },
    typography: {
      font,
      headingFont: font,
      size,
      lineSpacing: { mode: 'multiple', value: formatting.lineSpacing },
      indent: formatting.indentParagraphs ? 1.5 : 0,
      paragraphSpacing: formatting.indentParagraphs ? 0 : Math.round(size * 0.75),
      justify: false,
      hyphenate: false,
      widowControl: 2
    },
    matter: {
      ...plain.matter,
      titlePage: 'none',
      frontMatter: options.includeFront,
      endMatter: options.includeEnd
    },
    contents: { body: 'text', notes: 'none', keepTags: false, keepAiMarks: false },
    replacements: []
  }
}
