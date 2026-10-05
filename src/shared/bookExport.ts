import { z } from 'zod'

/**
 * Manuscript export (F-12.1): the one owner of what an export can be asked for. The renderer's
 * dialog builds `ExportOptions`, main collects the book in reading order and writes one file in
 * the chosen format, reporting `ExportProgress` as it goes.
 */

export const EXPORT_FORMATS = ['pdf', 'docx', 'epub', 'md'] as const
export const ExportFormat = z.enum(EXPORT_FORMATS)
export type ExportFormat = z.infer<typeof ExportFormat>

/** The file extension each format writes (without the dot). */
export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  pdf: 'pdf',
  docx: 'docx',
  epub: 'epub',
  md: 'md'
}

/** What the dialog and the save dialog's filter call each format. */
export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  pdf: 'PDF',
  docx: 'Word document (DOCX)',
  epub: 'EPUB',
  md: 'Markdown'
}

/**
 * What goes in: the whole manuscript section; the chosen chapters (with the parts that hold
 * them as headings); or one document from any section, printed alone.
 */
export const ExportScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manuscript') }),
  z.object({ kind: z.literal('chapters'), ids: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('document'), id: z.string() })
])
export type ExportScope = z.infer<typeof ExportScope>

export const EXPORT_FONTS = ['serif', 'sans'] as const
export const ExportFont = z.enum(EXPORT_FONTS)
export type ExportFont = z.infer<typeof ExportFont>

export const EXPORT_PAGE_SIZES = ['letter', 'a4'] as const
export const ExportPageSize = z.enum(EXPORT_PAGE_SIZES)
export type ExportPageSize = z.infer<typeof ExportPageSize>

export const EXPORT_LINE_SPACINGS = [1, 1.5, 2] as const
export const EXPORT_FONT_SIZE_MIN = 9
export const EXPORT_FONT_SIZE_MAX = 16

/**
 * The formatting choices. Font, size, line spacing, and page size shape PDF and DOCX (EPUB takes
 * font and spacing as a style the reader may override; Markdown has none of them). The scene
 * break text prints between scenes in every format.
 */
export const ExportFormatting = z.object({
  font: ExportFont,
  fontSize: z.number().int().min(EXPORT_FONT_SIZE_MIN).max(EXPORT_FONT_SIZE_MAX),
  lineSpacing: z.union([z.literal(1), z.literal(1.5), z.literal(2)]),
  pageSize: ExportPageSize,
  /** Each chapter (and part) starts on a new page in PDF and DOCX, and in its own EPUB file. */
  chapterNewPage: z.boolean(),
  /** First-line indent on body paragraphs, the way printed fiction sets them. */
  indentParagraphs: z.boolean(),
  sceneBreak: z.string().trim().min(1).max(20)
})
export type ExportFormatting = z.infer<typeof ExportFormatting>

export const ExportOptions = z.object({
  format: ExportFormat,
  scope: ExportScope,
  /** Front and end matter; ignored for a single-document export. */
  includeFront: z.boolean(),
  includeEnd: z.boolean(),
  formatting: ExportFormatting
})
export type ExportOptions = z.infer<typeof ExportOptions>

export function defaultExportFormatting(sceneBreak: string): ExportFormatting {
  return {
    font: 'serif',
    fontSize: 12,
    lineSpacing: 1.5,
    pageSize: 'letter',
    chapterNewPage: true,
    indentParagraphs: true,
    sceneBreak
  }
}

export const EXPORT_STAGES = ['collect', 'render', 'write'] as const
export const ExportStage = z.enum(EXPORT_STAGES)
export type ExportStage = z.infer<typeof ExportStage>

/** One step of a running export, pushed as `export:progress`; `done` of `total` within the stage. */
export const ExportProgress = z.object({
  requestId: z.string(),
  stage: ExportStage,
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative()
})
export type ExportProgress = z.infer<typeof ExportProgress>

export const ExportResult = z.object({
  path: z.string(),
  format: ExportFormat,
  words: z.number().int().nonnegative()
})
export type ExportResult = z.infer<typeof ExportResult>
