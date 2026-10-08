import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BOOK_FONT_DIRS,
  bookFontFaces,
  fontFaceCss,
  fontStack,
  formatFonts,
  officeFontName
} from './bookFonts'
import { BOOK_FONTS, BUILTIN_COMPILE_FORMATS } from './compileFormat'

const FONTS_DIR = path.resolve('resources', 'fonts')

describe('bundled book fonts (Compile v2)', () => {
  it('ships every face of every font with its SIL Open Font License', () => {
    for (const font of BOOK_FONTS) {
      const dir = path.join(FONTS_DIR, BOOK_FONT_DIRS[font])
      const licence = fs.readFileSync(path.join(dir, 'OFL.txt'), 'utf8')
      expect(licence, font).toContain('SIL Open Font License')
      const faces = bookFontFaces(font)
      expect(faces.length, font).toBeGreaterThanOrEqual(4)
      for (const face of faces)
        expect(fs.existsSync(path.join(dir, face.file)), face.file).toBe(true)
      // Regular, italic, bold, bold italic.
      expect(new Set(faces.map((f) => `${f.weight}${f.style}`))).toEqual(
        new Set(['400normal', '400italic', '700normal', '700italic'])
      )
    }
  })

  it('writes @font-face rules with each file URL and character range', () => {
    const css = fontFaceCss(
      ['ebGaramond', 'liberationSerif'],
      (dir, file) => `file:///f/${dir}/${file}`
    )
    expect(css).toContain(
      "@font-face { font-family: 'EB Garamond'; font-style: italic; font-weight: 700; src: url('file:///f/eb-garamond/eb-garamond-latin-ext-700-italic.woff2') format('woff2'); unicode-range: U+0100-02BA"
    )
    expect(css).toContain(
      "src: url('file:///f/liberation-serif/LiberationSerif-Regular.ttf') format('truetype'); }"
    )
    expect(css.match(/@font-face/g)).toHaveLength(8 + 4)
  })

  it('names fonts for each kind of output', () => {
    expect(fontStack('courierPrime')).toBe("'Courier Prime', 'Courier New', Courier, monospace")
    expect(officeFontName('liberationSerif')).toBe('Times New Roman')
    expect(officeFontName('crimsonPro')).toBe('Crimson Pro')
    const manuscript = BUILTIN_COMPILE_FORMATS[0]
    if (!manuscript) throw new Error('no formats')
    expect(formatFonts(manuscript)).toEqual(['liberationSerif', 'courierPrime'])
  })
})
