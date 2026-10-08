/**
 * Escaping for the XML and HTML the compile writers produce (F-12.1, Compile v2). Characters XML 1.0 cannot hold
 * (control characters other than tab, newline, and carriage return; lone surrogates; U+FFFE and
 * U+FFFF) are dropped, so a stray byte pasted into a scene cannot make a DOCX or EPUB unreadable.
 */

/** Whether a code point is in XML 1.0's `Char` production. */
function isXmlChar(code: number): boolean {
  if (code < 0x20) return code === 0x09 || code === 0x0a || code === 0x0d
  if (code >= 0xd800 && code <= 0xdfff) return false
  return code !== 0xfffe && code !== 0xffff
}

/** The text without characters XML 1.0 cannot hold; iterating by code point keeps pairs whole. */
export function xmlSafe(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code !== undefined && isXmlChar(code)) out += char
  }
  return out
}

export function escapeXml(text: string): string {
  return xmlSafe(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
