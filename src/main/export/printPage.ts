import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fontFaceCss, formatFonts } from '@shared/bookFonts'
import { PAGED_FURNITURE_HANDLER, printDocument } from '@shared/compileHtml'
import type { CompiledBook } from '@shared/compileModel'

/**
 * The print page the PDF writer lays out (Compile v2, CV2): the shared print HTML with the
 * format's bundled fonts as `file://` `@font-face` rules, then Paged.js (told not to start on its
 * own) and the furniture handler. Pure, so tests read it without Electron.
 */

/** A `<script>` body that cannot close its own element early. */
function inlineScript(source: string): string {
  return `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`
}

const PRINT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src file:; img-src file: data:"

export function printPageHtml(book: CompiledBook, fontsDir: string, pagedPolyfill: string): string {
  const fonts = fontFaceCss(
    formatFonts(book.format),
    (dir, file) => pathToFileURL(path.join(fontsDir, dir, file)).href
  )
  const head = [
    // Only the page's own inline style and script, and local fonts and images.
    `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`,
    inlineScript('window.PagedConfig = { auto: false }'),
    inlineScript(pagedPolyfill),
    inlineScript(PAGED_FURNITURE_HANDLER)
  ].join('\n')
  return printDocument(book, { fontFaceCss: fonts, head })
}
