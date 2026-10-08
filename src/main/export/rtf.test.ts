import { describe, expect, it } from 'vitest'
import { BUILTIN_COMPILE_FORMATS } from '@shared/compileFormat'
import { renderRtf, rtfText } from './rtf'
import { sampleBook } from './testBook'

/** Whether every `{` has its `}` (escaped braces aside). */
function balanced(rtf: string): boolean {
  let depth = 0
  for (let i = 0; i < rtf.length; i++) {
    const c = rtf[i]
    if (c === '\\') i++
    else if (c === '{') depth++
    else if (c === '}' && --depth < 0) return false
  }
  return depth === 0
}

describe('renderRtf (Compile v2)', () => {
  it('writes a balanced RTF document for every built-in format', () => {
    for (const format of BUILTIN_COMPILE_FORMATS) {
      const rtf = renderRtf(sampleBook(format, 'rtf'))
      expect(rtf.startsWith('{\\rtf1\\ansi'), format.id).toBe(true)
      expect(balanced(rtf), format.id).toBe(true)
      // Pure ASCII: everything else is a \u escape.
      expect(/^[\t\n -~]*$/.test(rtf), format.id).toBe(true)
    }
  })

  it('sets Standard Manuscript page, spacing, header, and sections', () => {
    const rtf = renderRtf(sampleBook('standard-manuscript', 'rtf'))
    expect(rtf).toContain('{\\f0\\fnil Times New Roman;}')
    expect(rtf).toContain('\\paperw12240\\paperh15840\\margl1440\\margr1440\\margt1440\\margb1440')
    expect(rtf).toContain('\\fi720\\sl480\\slmult1')
    expect(rtf).toContain('Marlowe / THE SALT ROAD / {\\field{\\*\\fldinst PAGE}{\\fldrslt 1}}')
    expect(rtf).toContain('\\sect\\sectd\\sbkpage\\pgnrestart\\pgnstarts1')
    expect(rtf).toContain('Chapter One\\line The Storm')
  })

  it('mirrors a paperback with facing headers and bare openers', () => {
    const rtf = renderRtf(sampleBook('paperback-6x9', 'rtf'))
    expect(rtf).toContain('\\facingp\\margmirror')
    expect(rtf).toContain('\\sbkodd')
    expect(rtf).toContain('\\titlepg')
    expect(rtf).toContain('{\\headerl ')
    expect(rtf).toContain('\\sl-300\\slmult0')
  })

  it('writes Editor copy notes as annotations', () => {
    const rtf = renderRtf(sampleBook('editor-copy', 'rtf'))
    expect(rtf.match(/\\chatn\{\\\*\\annotation/g)).toHaveLength(2)
  })

  it('escapes control characters and writes Unicode as \\u', () => {
    expect(rtfText('a{b}\\c\t“é”😀')).toBe(
      'a\\{b\\}\\\\c\\tab \\u8220?\\u233?\\u8221?\\u-10179?\\u-8704?'
    )
  })
})
