import { z } from 'zod'
import { ExportScope } from './bookExport'

/**
 * Compile formats (Compile v2, CV1): the one owner of what a compile can be told to do. A format
 * is output-agnostic (Scrivener's "format" vs "compile for"): it says how each level of the book
 * looks, the page, the headers and footers, the typography, which pages are generated, the
 * find-and-replace rules, and what else is included; the output (`CompileOutput`) is picked at
 * compile time, with `defaultOutput` preselected. Built-in formats live in code
 * (`BUILTIN_COMPILE_FORMATS`, ids prefixed `builtin:`); the author's own ("My formats") are
 * duplicates saved in the app-wide library (`AppState.compileFormats`), shared across projects.
 * The project remembers its last format, output, scope, and excluded documents in
 * `CompileProjectState` (settings row `COMPILE_STATE_KEY`).
 *
 * Units: page dimensions and margins in inches; font sizes, spacing before/after, and exact line
 * spacing in points; paragraph indent in em.
 */

export const COMPILE_FORMAT_VERSION = 1

// ---------------------------------------------------------------------------------------------
// Outputs

export const COMPILE_OUTPUTS = ['pdf', 'docx', 'epub', 'rtf', 'odt', 'html', 'txt', 'md'] as const
export const CompileOutput = z.enum(COMPILE_OUTPUTS)
export type CompileOutput = z.infer<typeof CompileOutput>

export const COMPILE_OUTPUT_LABELS: Record<CompileOutput, string> = {
  pdf: 'PDF',
  docx: 'Word document (DOCX)',
  epub: 'EPUB 3 ebook',
  rtf: 'Rich Text (RTF)',
  odt: 'OpenDocument Text (ODT)',
  html: 'Web page (HTML)',
  txt: 'Plain text',
  md: 'Markdown'
}

/** The file extension each output writes (without the dot). */
export const COMPILE_OUTPUT_EXTENSIONS: Record<CompileOutput, string> = {
  pdf: 'pdf',
  docx: 'docx',
  epub: 'epub',
  rtf: 'rtf',
  odt: 'odt',
  html: 'html',
  txt: 'txt',
  md: 'md'
}

/**
 * The final, publish-ready outputs: AI marks and `#` on tag tokens are always stripped from
 * these, whatever the format's `contents.keepTags` / `keepAiMarks` say (decided by Claude,
 * unconfirmed: "always on for final formats" read as PDF and EPUB).
 */
export const FINAL_OUTPUTS: readonly CompileOutput[] = ['pdf', 'epub']

// ---------------------------------------------------------------------------------------------
// Fonts (bundled, SIL OFL; the files and licences ship with CV2)

export const BOOK_FONTS = [
  'ebGaramond',
  'libreBaskerville',
  'crimsonPro',
  'liberationSerif',
  'courierPrime',
  'sourceSans3'
] as const
export const BookFont = z.enum(BOOK_FONTS)
export type BookFont = z.infer<typeof BookFont>

export interface BookFontInfo {
  label: string
  /** The CSS family name the writers declare in `@font-face` and use. */
  family: string
  kind: 'serif' | 'mono' | 'sans'
}

export const BOOK_FONT_INFO: Record<BookFont, BookFontInfo> = {
  ebGaramond: { label: 'EB Garamond', family: 'EB Garamond', kind: 'serif' },
  libreBaskerville: { label: 'Libre Baskerville', family: 'Libre Baskerville', kind: 'serif' },
  crimsonPro: { label: 'Crimson Pro', family: 'Crimson Pro', kind: 'serif' },
  /** Metric-compatible with Times New Roman: the "Times-like" manuscript font. */
  liberationSerif: {
    label: 'Liberation Serif (Times-like)',
    family: 'Liberation Serif',
    kind: 'serif'
  },
  courierPrime: { label: 'Courier Prime', family: 'Courier Prime', kind: 'mono' },
  sourceSans3: { label: 'Source Sans 3', family: 'Source Sans 3', kind: 'sans' }
}

// ---------------------------------------------------------------------------------------------
// Page setup

export const PAGE_SIZES = [
  'letter',
  'a4',
  'a5',
  'trim5x8',
  'trim5_25x8',
  'trim5_5x8_5',
  'trim6x9',
  'custom'
] as const
export const PageSize = z.enum(PAGE_SIZES)
export type PageSize = z.infer<typeof PageSize>

/** Width × height in inches; `custom` reads `PageSetup.width/height`. */
export const PAGE_SIZE_INFO: Record<
  Exclude<PageSize, 'custom'>,
  { label: string; width: number; height: number }
> = {
  letter: { label: 'US Letter (8.5 × 11 in)', width: 8.5, height: 11 },
  a4: { label: 'A4 (210 × 297 mm)', width: 8.27, height: 11.69 },
  a5: { label: 'A5 (148 × 210 mm)', width: 5.83, height: 8.27 },
  trim5x8: { label: 'Trim 5 × 8 in', width: 5, height: 8 },
  trim5_25x8: { label: 'Trim 5.25 × 8 in', width: 5.25, height: 8 },
  trim5_5x8_5: { label: 'Trim 5.5 × 8.5 in', width: 5.5, height: 8.5 },
  trim6x9: { label: 'Trim 6 × 9 in', width: 6, height: 9 }
}

const inches = (min: number, max: number): z.ZodNumber => z.number().min(min).max(max)

export const PageMargins = z.object({
  top: inches(0, 3),
  bottom: inches(0, 3),
  /** The binding side when `mirrored`; the left margin otherwise. */
  inside: inches(0, 3),
  /** The outer edge when `mirrored`; the right margin otherwise. */
  outside: inches(0, 3)
})
export type PageMargins = z.infer<typeof PageMargins>

export const PageSetup = z.object({
  size: PageSize,
  /** Used only when `size` is `custom`. */
  width: inches(2, 17),
  height: inches(2, 17),
  margins: PageMargins,
  /** Facing pages: inside/outside swap on versos (print books). */
  mirrored: z.boolean(),
  /** Extra binding margin added to `inside`. */
  gutter: inches(0, 1.5)
})
export type PageSetup = z.infer<typeof PageSetup>

/** The page's width and height in inches. */
export function pageDimensions(setup: PageSetup): { width: number; height: number } {
  if (setup.size === 'custom') return { width: setup.width, height: setup.height }
  const { width, height } = PAGE_SIZE_INFO[setup.size]
  return { width, height }
}

// ---------------------------------------------------------------------------------------------
// Typography

export const LineSpacing = z.discriminatedUnion('mode', [
  /** A multiple of the font's line height: 1, 1.15, 1.5, 2, … */
  z.object({ mode: z.literal('multiple'), value: z.number().min(0.8).max(3) }),
  /** An exact leading in points (print books). */
  z.object({ mode: z.literal('exact'), points: z.number().min(6).max(48) })
])
export type LineSpacing = z.infer<typeof LineSpacing>

export const Typography = z.object({
  font: BookFont,
  /** The default for section headings whose layout has no font of its own. */
  headingFont: BookFont,
  size: z.number().min(7).max(24),
  lineSpacing: LineSpacing,
  /** First-line indent of body paragraphs, in em; 0 for none. */
  indent: z.number().min(0).max(4),
  /** Space after each body paragraph in points (usually 0 when indenting). */
  paragraphSpacing: z.number().min(0).max(36),
  justify: z.boolean(),
  hyphenate: z.boolean(),
  /** Minimum lines kept together at a page top/bottom (widows and orphans); 0 turns it off. */
  widowControl: z.number().int().min(0).max(5)
})
export type Typography = z.infer<typeof Typography>

// ---------------------------------------------------------------------------------------------
// Section layouts

/**
 * The four levels a section can be: a part, a chapter, a scene placed at chapter level (directly
 * under a part or the manuscript root, e.g. a prologue; flexible nesting 2026-10-07), and a scene.
 */
export const SECTION_LEVELS = ['part', 'chapter', 'chapterScene', 'scene'] as const
export const SectionLevel = z.enum(SECTION_LEVELS)
export type SectionLevel = z.infer<typeof SectionLevel>

export const SECTION_LEVEL_LABELS: Record<SectionLevel, string> = {
  part: 'Part',
  chapter: 'Chapter',
  chapterScene: 'Chapter-level scene',
  scene: 'Scene'
}

/**
 * How a level's number prints. Chapters share one counter, and a chapter-level scene joins it
 * only when its own numbering is not `none` (a prologue is unnumbered by default); parts count
 * on their own; scenes count across the whole book.
 */
export const NUMBERING_STYLES = ['none', 'words', 'digits', 'roman'] as const
export const NumberingStyle = z.enum(NUMBERING_STYLES)
export type NumberingStyle = z.infer<typeof NumberingStyle>

export const TEXT_CASES = ['asIs', 'upper', 'smallCaps'] as const
export const TextCase = z.enum(TEXT_CASES)
export type TextCase = z.infer<typeof TextCase>

export const HEADING_ALIGNS = ['left', 'center', 'right'] as const
export const HeadingAlign = z.enum(HEADING_ALIGNS)
export type HeadingAlign = z.infer<typeof HeadingAlign>

/** Where a section starts: in the flow, on a new page, or on the next right-hand (odd) page. */
export const PAGE_BREAKS = ['none', 'newPage', 'newRecto'] as const
export const PageBreak = z.enum(PAGE_BREAKS)
export type PageBreak = z.infer<typeof PageBreak>

/**
 * The first paragraph after a section heading or a scene separator: indented like the rest, no
 * indent, a drop cap (no indent), the first line in small caps (no indent), or the first
 * `firstWords` words in small caps (no indent).
 */
export const FIRST_PARAGRAPH_STYLES = [
  'indent',
  'noIndent',
  'dropCap',
  'smallCapsLine',
  'smallCapsWords'
] as const
export const FirstParagraphStyle = z.enum(FIRST_PARAGRAPH_STYLES)
export type FirstParagraphStyle = z.infer<typeof FirstParagraphStyle>

export const SECTION_AFFIX_MAX = 60

/**
 * One level's layout. The heading reads `prefix + number + suffix`, then the node's title, on the
 * same line after a space or on the next line (`titleOnNewLine`). Examples: words + prefix
 * "Chapter " → "Chapter One"; digits + suffix "." + title → "1. The Storm"; roman + no prefix →
 * "IV"; numbering `none` + title → titles only. No number and no title → no heading.
 */
export const SectionLayout = z.object({
  showTitle: z.boolean(),
  numbering: NumberingStyle,
  prefix: z.string().max(SECTION_AFFIX_MAX),
  suffix: z.string().max(SECTION_AFFIX_MAX),
  titleOnNewLine: z.boolean(),
  /** Null: the format's `typography.headingFont`. */
  font: BookFont.nullable(),
  size: z.number().min(7).max(72),
  bold: z.boolean(),
  italic: z.boolean(),
  case: TextCase,
  align: HeadingAlign,
  spaceBefore: z.number().min(0).max(432),
  spaceAfter: z.number().min(0).max(216),
  pageBreak: PageBreak,
  firstParagraph: FirstParagraphStyle,
  /** Used by `smallCapsWords`. */
  firstWords: z.number().int().min(1).max(10)
})
export type SectionLayout = z.infer<typeof SectionLayout>

export const SectionLayouts = z.object({
  part: SectionLayout,
  chapter: SectionLayout,
  chapterScene: SectionLayout,
  scene: SectionLayout
})
export type SectionLayouts = z.infer<typeof SectionLayouts>

export const SEPARATOR_TEXT_MAX = 40

/**
 * What prints between two scenes (and for a scene break the author put inside a document): a
 * glyph or text line ("#", "* * *", "⁂"), a blank line, or a page break.
 */
export const Separator = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().trim().min(1).max(SEPARATOR_TEXT_MAX) }),
  z.object({ kind: z.literal('blankLine') }),
  z.object({ kind: z.literal('pageBreak') })
])
export type Separator = z.infer<typeof Separator>

// ---------------------------------------------------------------------------------------------
// Headers and footers

/**
 * The tokens a header or footer slot may hold. `{TITLE}` is the title in capitals (Shunn's
 * "Surname / TITLE / page"; decided by Claude, unconfirmed). `{page}` and `{chapter}` change per
 * page, so the writers fill them (`furnitureSegments` splits a slot for them).
 */
export const FURNITURE_TOKENS = [
  'author',
  'surname',
  'title',
  'TITLE',
  'chapter',
  'page',
  'wordcount'
] as const
export type FurnitureToken = (typeof FURNITURE_TOKENS)[number]

export const FURNITURE_SLOT_MAX = 120

export const FurnitureSlots = z.object({
  left: z.string().max(FURNITURE_SLOT_MAX),
  center: z.string().max(FURNITURE_SLOT_MAX),
  right: z.string().max(FURNITURE_SLOT_MAX)
})
export type FurnitureSlots = z.infer<typeof FurnitureSlots>

export const PageFurniture = z.object({ header: FurnitureSlots, footer: FurnitureSlots })
export type PageFurniture = z.infer<typeof PageFurniture>

export const HeadersFooters = z.object({
  /** Right-hand (odd) pages; every page when `facing` is off. */
  recto: PageFurniture,
  /** Left-hand (even) pages; used only when `facing` is on. */
  verso: PageFurniture,
  facing: z.boolean(),
  /**
   * No header or footer on a page where a section with a page break starts (chapter openers).
   * Generated front pages (title, copyright, dedication, epigraph, contents) never carry any.
   */
  hideOnOpeners: z.boolean()
})
export type HeadersFooters = z.infer<typeof HeadersFooters>

// ---------------------------------------------------------------------------------------------
// Front and back matter, contents, replacements, metadata

export const TITLE_PAGE_STYLES = ['none', 'page', 'manuscript'] as const
export const TitlePageStyle = z.enum(TITLE_PAGE_STYLES)
export type TitlePageStyle = z.infer<typeof TitlePageStyle>

/**
 * The generated pages (from Book details) and the project's own front and end matter sections.
 * Order: title page (`manuscript` = Shunn's first-page block), copyright, dedication, epigraph,
 * contents, the project's front matter, the body, the project's end matter, about the author,
 * also by. A generated page with nothing to print is left out.
 */
export const MatterSettings = z.object({
  titlePage: TitlePageStyle,
  copyrightPage: z.boolean(),
  dedication: z.boolean(),
  epigraph: z.boolean(),
  toc: z.boolean(),
  frontMatter: z.boolean(),
  endMatter: z.boolean(),
  aboutAuthor: z.boolean(),
  alsoBy: z.boolean()
})
export type MatterSettings = z.infer<typeof MatterSettings>

export const BODY_CONTENTS = ['text', 'synopsis', 'textAndSynopsis'] as const
export const BodyContents = z.enum(BODY_CONTENTS)
export type BodyContents = z.infer<typeof BodyContents>

/** Document notes: left out, printed after the text, or attached as comments (DOCX, ODT). */
export const NOTES_MODES = ['none', 'inline', 'comments'] as const
export const NotesMode = z.enum(NOTES_MODES)
export type NotesMode = z.infer<typeof NotesMode>

export const ContentSettings = z.object({
  body: BodyContents,
  notes: NotesMode,
  /** Tag tokens print as `#name` instead of `name` (never for `FINAL_OUTPUTS`). */
  keepTags: z.boolean(),
  /** Runs carry `ai: true` for AI-written text so a writer may mark it (never for `FINAL_OUTPUTS`). */
  keepAiMarks: z.boolean()
})
export type ContentSettings = z.infer<typeof ContentSettings>

export const REPLACEMENT_FIELD_MAX = 200
export const REPLACEMENTS_MAX = 50

/** Whether `find` compiles as a JavaScript regular expression (with the `u` flag). */
export function isValidPattern(find: string): boolean {
  try {
    new RegExp(find, 'u')
    return true
  } catch {
    return false
  }
}

export const Replacement = z
  .object({
    enabled: z.boolean(),
    find: z.string().min(1).max(REPLACEMENT_FIELD_MAX),
    replace: z.string().max(REPLACEMENT_FIELD_MAX),
    regex: z.boolean(),
    caseSensitive: z.boolean()
  })
  .refine((rule) => !rule.regex || isValidPattern(rule.find), {
    message: 'Not a valid regular expression',
    path: ['find']
  })
export type Replacement = z.infer<typeof Replacement>

export const MetadataSettings = z.object({
  /** The Book details cover image goes into the book (the EPUB cover; `BookMetadata.cover`). */
  includeCover: z.boolean(),
  /** Which `BookDetails.isbns` edition this format prints (matched ignoring case); '' = the first. */
  isbnEdition: z.string().max(60)
})
export type MetadataSettings = z.infer<typeof MetadataSettings>

// ---------------------------------------------------------------------------------------------
// The format

export const COMPILE_FORMAT_NAME_MAX = 60
export const CompileFormatName = z.string().trim().min(1).max(COMPILE_FORMAT_NAME_MAX)

export const CompileFormat = z.object({
  version: z.literal(COMPILE_FORMAT_VERSION),
  id: z.string().min(1).max(80),
  name: CompileFormatName,
  description: z.string().max(300),
  defaultOutput: CompileOutput,
  sections: SectionLayouts,
  sceneSeparator: Separator,
  pageSetup: PageSetup,
  headersFooters: HeadersFooters,
  typography: Typography,
  matter: MatterSettings,
  contents: ContentSettings,
  replacements: z.array(Replacement).max(REPLACEMENTS_MAX),
  metadata: MetadataSettings
})
export type CompileFormat = z.infer<typeof CompileFormat>

/** A stored format, or null when it no longer fits the schema (dropped, never a failed load). */
export function parseCompileFormat(json: unknown): CompileFormat | null {
  const parsed = CompileFormat.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** The library as stored in app state: every entry that still parses, the rest dropped. */
export const CompileFormatLibrary = z
  .array(z.unknown())
  .catch([])
  .transform((items) => items.map(parseCompileFormat).filter((f): f is CompileFormat => f !== null))
export const COMPILE_FORMATS_MAX = 100

// ---------------------------------------------------------------------------------------------
// Built-in formats

export const BUILTIN_FORMAT_PREFIX = 'builtin:'

export function isBuiltinFormatId(id: string): boolean {
  return id.startsWith(BUILTIN_FORMAT_PREFIX)
}

const slots = (left = '', center = '', right = ''): FurnitureSlots => ({ left, center, right })
const NO_FURNITURE: PageFurniture = { header: slots(), footer: slots() }

function layout(over: Partial<SectionLayout>): SectionLayout {
  return {
    showTitle: true,
    numbering: 'none',
    prefix: '',
    suffix: '',
    titleOnNewLine: false,
    font: null,
    size: 18,
    bold: false,
    italic: false,
    case: 'asIs',
    align: 'center',
    spaceBefore: 72,
    spaceAfter: 24,
    pageBreak: 'newPage',
    firstParagraph: 'noIndent',
    firstWords: 3,
    ...over
  }
}

/** A scene: no heading, in the flow, first paragraph unindented after a separator. */
const SCENE_PLAIN = layout({
  showTitle: false,
  size: 12,
  spaceBefore: 0,
  spaceAfter: 0,
  pageBreak: 'none'
})

const ALL_MATTER_OFF: MatterSettings = {
  titlePage: 'none',
  copyrightPage: false,
  dedication: false,
  epigraph: false,
  toc: false,
  frontMatter: false,
  endMatter: false,
  aboutAuthor: false,
  alsoBy: false
}

const PLAIN_CONTENTS: ContentSettings = {
  body: 'text',
  notes: 'none',
  keepTags: false,
  keepAiMarks: false
}

const ONE_INCH: PageMargins = { top: 1, bottom: 1, inside: 1, outside: 1 }

/** "--" → em dash and "..." → ellipsis; the clean-up most manuscripts want. */
const TYPOGRAPHIC_CLEANUP: Replacement[] = [
  { enabled: true, find: '--', replace: '—', regex: false, caseSensitive: true },
  { enabled: true, find: '...', replace: '…', regex: false, caseSensitive: true }
]

const builtin = (format: Omit<CompileFormat, 'version'>): CompileFormat => ({
  version: COMPILE_FORMAT_VERSION,
  ...format
})

/** Standard Manuscript Format (William Shunn): agent and editor submissions. */
const STANDARD_MANUSCRIPT = builtin({
  id: 'builtin:standard-manuscript',
  name: 'Standard Manuscript',
  description:
    'Agent submission (Shunn): 12 pt Times-like, double-spaced, 1" margins, "Surname / TITLE / page" header, contact block and word count on page one, chapters on new pages, centred # scene breaks.',
  defaultOutput: 'docx',
  sections: {
    part: layout({
      size: 12,
      case: 'upper',
      spaceBefore: 216,
      spaceAfter: 24,
      firstParagraph: 'indent'
    }),
    chapter: layout({
      numbering: 'words',
      prefix: 'Chapter ',
      showTitle: true,
      titleOnNewLine: true,
      size: 12,
      spaceBefore: 216,
      spaceAfter: 24,
      firstParagraph: 'indent'
    }),
    chapterScene: layout({ size: 12, spaceBefore: 216, spaceAfter: 24, firstParagraph: 'indent' }),
    scene: { ...SCENE_PLAIN, firstParagraph: 'indent' }
  },
  sceneSeparator: { kind: 'text', text: '#' },
  pageSetup: {
    size: 'letter',
    width: 8.5,
    height: 11,
    margins: ONE_INCH,
    mirrored: false,
    gutter: 0
  },
  headersFooters: {
    recto: { header: slots('', '', '{surname} / {TITLE} / {page}'), footer: slots() },
    verso: NO_FURNITURE,
    facing: false,
    hideOnOpeners: false
  },
  typography: {
    font: 'liberationSerif',
    headingFont: 'liberationSerif',
    size: 12,
    lineSpacing: { mode: 'multiple', value: 2 },
    // Half an inch at 12 pt.
    indent: 3,
    paragraphSpacing: 0,
    justify: false,
    hyphenate: false,
    widowControl: 0
  },
  matter: { ...ALL_MATTER_OFF, titlePage: 'manuscript' },
  contents: PLAIN_CONTENTS,
  replacements: [],
  metadata: { includeCover: false, isbnEdition: '' }
})

function paperback(id: string, name: string, size: 'trim6x9' | 'trim5x8'): CompileFormat {
  const small = size === 'trim5x8'
  return builtin({
    id,
    name,
    description: `Print-ready paperback PDF for KDP and IngramSpark: ${PAGE_SIZE_INFO[size].label}, mirrored margins with gutter, running heads (author on the left, title on the right), page numbers, chapters on a new page with no running head.`,
    defaultOutput: 'pdf',
    sections: {
      part: layout({
        numbering: 'words',
        prefix: 'Part ',
        titleOnNewLine: true,
        size: 20,
        case: 'smallCaps',
        spaceBefore: 144,
        pageBreak: 'newRecto'
      }),
      chapter: layout({
        numbering: 'words',
        prefix: 'Chapter ',
        titleOnNewLine: true,
        size: small ? 16 : 18,
        case: 'smallCaps',
        spaceBefore: small ? 72 : 96,
        spaceAfter: 36,
        firstParagraph: 'smallCapsWords'
      }),
      chapterScene: layout({
        size: small ? 16 : 18,
        case: 'smallCaps',
        spaceBefore: small ? 72 : 96,
        spaceAfter: 36,
        firstParagraph: 'smallCapsWords'
      }),
      scene: SCENE_PLAIN
    },
    sceneSeparator: { kind: 'text', text: '* * *' },
    pageSetup: {
      size,
      width: PAGE_SIZE_INFO[size].width,
      height: PAGE_SIZE_INFO[size].height,
      margins: small
        ? { top: 0.6, bottom: 0.6, inside: 0.625, outside: 0.5 }
        : { top: 0.75, bottom: 0.75, inside: 0.75, outside: 0.6 },
      mirrored: true,
      gutter: 0.125
    },
    headersFooters: {
      recto: { header: slots('', '{title}', ''), footer: slots('', '{page}', '') },
      verso: { header: slots('', '{author}', ''), footer: slots('', '{page}', '') },
      facing: true,
      hideOnOpeners: true
    },
    typography: {
      font: 'ebGaramond',
      headingFont: 'ebGaramond',
      size: small ? 11 : 11.5,
      lineSpacing: { mode: 'exact', points: small ? 14.5 : 15 },
      indent: 1.5,
      paragraphSpacing: 0,
      justify: true,
      hyphenate: true,
      widowControl: 2
    },
    matter: {
      titlePage: 'page',
      copyrightPage: true,
      dedication: true,
      epigraph: true,
      toc: false,
      frontMatter: true,
      endMatter: true,
      aboutAuthor: true,
      alsoBy: true
    },
    contents: PLAIN_CONTENTS,
    replacements: TYPOGRAPHIC_CLEANUP,
    metadata: { includeCover: false, isbnEdition: 'Paperback' }
  })
}

const EBOOK = builtin({
  id: 'builtin:ebook',
  name: 'Ebook',
  description:
    'EPUB 3 for Kindle (KDP), Apple Books, and Kobo: cover, full metadata, linked contents, clean reflowable styles.',
  defaultOutput: 'epub',
  sections: {
    part: layout({
      numbering: 'words',
      prefix: 'Part ',
      titleOnNewLine: true,
      size: 20,
      spaceBefore: 96
    }),
    chapter: layout({
      numbering: 'words',
      prefix: 'Chapter ',
      titleOnNewLine: true,
      size: 18,
      spaceBefore: 48,
      spaceAfter: 24,
      firstParagraph: 'dropCap'
    }),
    chapterScene: layout({ size: 18, spaceBefore: 48, spaceAfter: 24, firstParagraph: 'dropCap' }),
    scene: SCENE_PLAIN
  },
  sceneSeparator: { kind: 'text', text: '⁂' },
  pageSetup: {
    size: 'trim6x9',
    width: 6,
    height: 9,
    margins: { top: 0.5, bottom: 0.5, inside: 0.5, outside: 0.5 },
    mirrored: false,
    gutter: 0
  },
  headersFooters: {
    recto: NO_FURNITURE,
    verso: NO_FURNITURE,
    facing: false,
    hideOnOpeners: true
  },
  typography: {
    font: 'ebGaramond',
    headingFont: 'ebGaramond',
    size: 12,
    lineSpacing: { mode: 'multiple', value: 1.4 },
    indent: 1.5,
    paragraphSpacing: 0,
    justify: true,
    hyphenate: true,
    widowControl: 2
  },
  matter: {
    titlePage: 'page',
    copyrightPage: true,
    dedication: true,
    epigraph: true,
    toc: true,
    frontMatter: true,
    endMatter: true,
    aboutAuthor: true,
    alsoBy: true
  },
  contents: PLAIN_CONTENTS,
  replacements: TYPOGRAPHIC_CLEANUP,
  metadata: { includeCover: true, isbnEdition: 'Ebook' }
})

const LETTER_PAGE: PageSetup = {
  size: 'letter',
  width: 8.5,
  height: 11,
  margins: ONE_INCH,
  mirrored: false,
  gutter: 0
}

const READING_TYPOGRAPHY: Typography = {
  font: 'libreBaskerville',
  headingFont: 'libreBaskerville',
  size: 12,
  lineSpacing: { mode: 'multiple', value: 1.5 },
  indent: 1.5,
  paragraphSpacing: 0,
  justify: false,
  hyphenate: false,
  widowControl: 2
}

const PAGE_NUMBER_FOOTER: HeadersFooters = {
  recto: { header: slots(), footer: slots('', '{page}', '') },
  verso: NO_FURNITURE,
  facing: false,
  hideOnOpeners: false
}

const EDITOR_COPY = builtin({
  id: 'builtin:editor-copy',
  name: 'Editor copy',
  description:
    'A DOCX for an editor or beta reader: readable spacing, chapter titles, page numbers, and your document notes as comments.',
  defaultOutput: 'docx',
  sections: {
    part: layout({ size: 20 }),
    chapter: layout({ size: 16, spaceBefore: 36 }),
    chapterScene: layout({ size: 16, spaceBefore: 36 }),
    scene: SCENE_PLAIN
  },
  sceneSeparator: { kind: 'text', text: '* * *' },
  pageSetup: LETTER_PAGE,
  headersFooters: PAGE_NUMBER_FOOTER,
  typography: READING_TYPOGRAPHY,
  matter: { ...ALL_MATTER_OFF, titlePage: 'page', frontMatter: true, endMatter: true },
  contents: { ...PLAIN_CONTENTS, notes: 'comments' },
  replacements: [],
  metadata: { includeCover: false, isbnEdition: '' }
})

const OUTLINE = builtin({
  id: 'builtin:outline',
  name: 'Outline',
  description: 'Every part, chapter, and scene title with its synopsis; no manuscript text.',
  defaultOutput: 'docx',
  sections: {
    part: layout({ size: 18, align: 'left', spaceBefore: 24, spaceAfter: 12, pageBreak: 'none' }),
    chapter: layout({ size: 15, align: 'left', spaceBefore: 18, spaceAfter: 6, pageBreak: 'none' }),
    chapterScene: layout({
      size: 15,
      align: 'left',
      spaceBefore: 18,
      spaceAfter: 6,
      pageBreak: 'none'
    }),
    scene: layout({
      size: 12,
      bold: true,
      align: 'left',
      spaceBefore: 12,
      spaceAfter: 4,
      pageBreak: 'none'
    })
  },
  sceneSeparator: { kind: 'blankLine' },
  pageSetup: LETTER_PAGE,
  headersFooters: PAGE_NUMBER_FOOTER,
  typography: {
    ...READING_TYPOGRAPHY,
    lineSpacing: { mode: 'multiple', value: 1.15 },
    indent: 0,
    paragraphSpacing: 6
  },
  matter: { ...ALL_MATTER_OFF, titlePage: 'page' },
  contents: { ...PLAIN_CONTENTS, body: 'synopsis' },
  replacements: [],
  metadata: { includeCover: false, isbnEdition: '' }
})

const PLAIN_TEXT = builtin({
  id: 'builtin:plain-text',
  name: 'Plain text',
  description: 'The text alone: chapter titles, blank-line paragraphs, * * * between scenes.',
  defaultOutput: 'txt',
  sections: {
    part: layout({ size: 12, pageBreak: 'none', spaceBefore: 0, spaceAfter: 0 }),
    chapter: layout({ size: 12, pageBreak: 'none', spaceBefore: 0, spaceAfter: 0 }),
    chapterScene: layout({ size: 12, pageBreak: 'none', spaceBefore: 0, spaceAfter: 0 }),
    scene: SCENE_PLAIN
  },
  sceneSeparator: { kind: 'text', text: '* * *' },
  pageSetup: LETTER_PAGE,
  headersFooters: { recto: NO_FURNITURE, verso: NO_FURNITURE, facing: false, hideOnOpeners: false },
  typography: READING_TYPOGRAPHY,
  matter: { ...ALL_MATTER_OFF, frontMatter: true, endMatter: true },
  contents: PLAIN_CONTENTS,
  replacements: [],
  metadata: { includeCover: false, isbnEdition: '' }
})

/** The built-in formats, in the order the compile window lists them. */
export const BUILTIN_COMPILE_FORMATS: readonly CompileFormat[] = [
  STANDARD_MANUSCRIPT,
  paperback('builtin:paperback-6x9', 'Paperback 6 × 9', 'trim6x9'),
  paperback('builtin:paperback-5x8', 'Paperback 5 × 8', 'trim5x8'),
  EBOOK,
  EDITOR_COPY,
  OUTLINE,
  PLAIN_TEXT
]

export const DEFAULT_COMPILE_FORMAT_ID = STANDARD_MANUSCRIPT.id

/** A built-in or library format by id; null when neither has it. */
export function findCompileFormat(
  library: readonly CompileFormat[],
  id: string
): CompileFormat | null {
  return (
    BUILTIN_COMPILE_FORMATS.find((f) => f.id === id) ?? library.find((f) => f.id === id) ?? null
  )
}

/** The author's formats sorted by name (case-insensitive), for the "My formats" list. */
export function sortFormats(library: readonly CompileFormat[]): CompileFormat[] {
  return [...library].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )
}

/** Whether another library format (not `exceptId`) already has this name, ignoring case and spaces. */
export function formatNameTaken(
  library: readonly CompileFormat[],
  name: string,
  exceptId: string | null = null
): boolean {
  const key = name.trim().toLocaleLowerCase()
  return library.some((f) => f.id !== exceptId && f.name.trim().toLocaleLowerCase() === key)
}

/** "Name copy", "Name copy 2", … — the first not taken in the library. */
export function copyName(library: readonly CompileFormat[], name: string): string {
  const base = `${name} copy`.slice(0, COMPILE_FORMAT_NAME_MAX)
  if (!formatNameTaken(library, base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, COMPILE_FORMAT_NAME_MAX - String(n).length - 1)} ${n}`
    if (!formatNameTaken(library, candidate)) return candidate
  }
}

/** A deep copy of `source` under a new id and name (Duplicate → customise → save). */
export function duplicateFormat(source: CompileFormat, id: string, name: string): CompileFormat {
  return CompileFormat.parse({ ...structuredClone(source), id, name })
}

// ---------------------------------------------------------------------------------------------
// Per project: last format, output, scope, and the include checkboxes

export const COMPILE_STATE_KEY = 'compile.state'
export const COMPILE_EXCLUDED_MAX = 20_000

/** The compile quick picks: whole manuscript, selected chapters, current document. */
export const CompileScope = ExportScope
export type CompileScope = ExportScope

export const CompileProjectState = z.object({
  formatId: z.string().min(1).max(80),
  /** Null: the format's `defaultOutput`. */
  output: CompileOutput.nullable(),
  scope: CompileScope,
  /**
   * Node ids unticked "Include in compile" (any section). Stored as exclusions so a new document
   * is included by default; an excluded folder leaves out everything below it. An id of a node
   * that no longer exists is ignored.
   */
  excluded: z.array(z.string()).max(COMPILE_EXCLUDED_MAX)
})
export type CompileProjectState = z.infer<typeof CompileProjectState>

export function defaultCompileProjectState(): CompileProjectState {
  return {
    formatId: DEFAULT_COMPILE_FORMAT_ID,
    output: null,
    scope: { kind: 'manuscript' },
    excluded: []
  }
}

/** Ticks or unticks one node's "Include in compile" (pure; returns a new state). */
export function setIncluded(
  state: CompileProjectState,
  id: string,
  included: boolean
): CompileProjectState {
  const rest = state.excluded.filter((x) => x !== id)
  return { ...state, excluded: included ? rest : [...rest, id] }
}
