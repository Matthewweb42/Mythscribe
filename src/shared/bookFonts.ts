import { BOOK_FONT_INFO, type BookFont, type CompileFormat } from './compileFormat'

/**
 * The bundled book fonts (Compile v2, CV2): every `BookFont` ships under `resources/fonts/<dir>/`
 * with its SIL Open Font License beside it (`OFL.txt`), so a compiled PDF looks the same on any
 * machine and embeds its fonts for KDP and IngramSpark. Regular, italic, bold, and bold italic;
 * the Google-sourced families (via Fontsource 5.3.0) come as Latin and Latin Extended WOFF2
 * subsets told apart by `unicode-range`, Liberation Serif 2.1.5 as whole TTF files.
 *
 * Only the print PDF (and the compile window's preview) loads the files. DOCX, ODT, and RTF name
 * the family (`officeFontName`), HTML and EPUB name it with fallbacks (`fontStack`).
 */

export interface BookFontFace {
  file: string
  weight: 400 | 700
  style: 'normal' | 'italic'
  /** Null: the file covers every character it has. */
  unicodeRange: string | null
}

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

/** The folder under `resources/fonts/` each font lives in. */
export const BOOK_FONT_DIRS: Record<BookFont, string> = {
  ebGaramond: 'eb-garamond',
  libreBaskerville: 'libre-baskerville',
  crimsonPro: 'crimson-pro',
  liberationSerif: 'liberation-serif',
  courierPrime: 'courier-prime',
  sourceSans3: 'source-sans-3'
}

const STYLES: { weight: 400 | 700; style: 'normal' | 'italic' }[] = [
  { weight: 400, style: 'normal' },
  { weight: 400, style: 'italic' },
  { weight: 700, style: 'normal' },
  { weight: 700, style: 'italic' }
]

const LIBERATION_FILES: Record<string, string> = {
  '400normal': 'LiberationSerif-Regular.ttf',
  '400italic': 'LiberationSerif-Italic.ttf',
  '700normal': 'LiberationSerif-Bold.ttf',
  '700italic': 'LiberationSerif-BoldItalic.ttf'
}

/** The font files of one family, each with its weight, style, and character range. */
export function bookFontFaces(font: BookFont): BookFontFace[] {
  if (font === 'liberationSerif') {
    return STYLES.map(({ weight, style }) => ({
      file: LIBERATION_FILES[`${weight}${style}`] ?? '',
      weight,
      style,
      unicodeRange: null
    }))
  }
  const dir = BOOK_FONT_DIRS[font]
  return (['latin', 'latin-ext'] as const).flatMap((subset) =>
    STYLES.map(({ weight, style }) => ({
      file: `${dir}-${subset}-${weight}-${style}.woff2`,
      weight,
      style,
      unicodeRange: subset === 'latin' ? LATIN : LATIN_EXT
    }))
  )
}

const GENERIC: Record<'serif' | 'mono' | 'sans', string> = {
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'Courier New', Courier, monospace",
  sans: 'Arial, Helvetica, sans-serif'
}

/** A CSS `font-family` value: the family, then fallbacks of its kind. */
export function fontStack(font: BookFont): string {
  const info = BOOK_FONT_INFO[font]
  return `'${info.family}', ${GENERIC[info.kind]}`
}

/**
 * The family name DOCX, ODT, and RTF ask for. Those files name a font rather than carry it, so
 * the Times-like Liberation Serif asks for Times New Roman, the font every agent's Word has and
 * the one it is metric-compatible with (decided by Claude, unconfirmed); the others ask for
 * themselves and fall back to the reader's default when not installed.
 */
export function officeFontName(font: BookFont): string {
  return font === 'liberationSerif' ? 'Times New Roman' : BOOK_FONT_INFO[font].family
}

/** Code runs print in Courier Prime. */
export const CODE_FONT: BookFont = 'courierPrime'

/** Every font a format prints with: body, headings, each level's own, and the code font. */
export function formatFonts(format: CompileFormat): BookFont[] {
  const fonts = new Set<BookFont>([
    format.typography.font,
    format.typography.headingFont,
    CODE_FONT
  ])
  for (const layout of Object.values(format.sections))
    if (layout.font !== null) fonts.add(layout.font)
  return [...fonts]
}

/** `@font-face` rules for `fonts`, each file's URL from `urlFor(dir, file)`. */
export function fontFaceCss(
  fonts: Iterable<BookFont>,
  urlFor: (dir: string, file: string) => string
): string {
  const rules: string[] = []
  for (const font of fonts) {
    const dir = BOOK_FONT_DIRS[font]
    for (const face of bookFontFaces(font)) {
      const format = face.file.endsWith('.woff2') ? 'woff2' : 'truetype'
      rules.push(
        `@font-face { font-family: '${BOOK_FONT_INFO[font].family}'; font-style: ${face.style}; font-weight: ${face.weight}; ` +
          `src: url('${urlFor(dir, face.file)}') format('${format}');` +
          `${face.unicodeRange === null ? '' : ` unicode-range: ${face.unicodeRange};`} }`
      )
    }
  }
  return rules.join('\n')
}
