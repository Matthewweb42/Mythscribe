import pagedPolyfillUrl from '../../../../node_modules/pagedjs/dist/paged.polyfill.min.js?url'
import { bookFontUrl, fontFaceCss, formatFonts } from '@shared/bookFonts'
import { furnishPagedPages, printDocument, webDocument } from '@shared/compileHtml'
import type { CompiledBook } from '@shared/compileModel'

/**
 * The compile window's live preview frame (Compile v2, CV3): the same print page the PDF is made
 * from (`printDocument`, the bundled fonts on the asset scheme), laid out by the same Paged.js
 * in an iframe of the visible window (never throttled), then the same furniture pass
 * (`furnishPagedPages`). The app's content security policy, which the frame inherits, allows no
 * inline script, so the polyfill loads as a file of the app and the window drives it from
 * outside. Reflowable outputs (EPUB, HTML, text, Markdown) show the web page instead.
 */

/** The outputs that are laid out in pages (the print preview); the rest preview reflowable. */
export const PAGED_OUTPUTS = ['pdf', 'docx', 'odt', 'rtf'] as const

export function isPagedOutput(output: CompiledBook['output']): boolean {
  return (PAGED_OUTPUTS as readonly string[]).includes(output)
}

/** The preview's HTML for `book`: the print page or, for reflowable outputs, the web page. */
export function previewHtml(book: CompiledBook): string {
  if (!isPagedOutput(book.output)) return webDocument(book)
  return printDocument(book, { fontFaceCss: fontFaceCss(formatFonts(book.format), bookFontUrl) })
}

/** The preview's own screen styling: grey desk, pages as sheets, zoom. Not part of the book. */
export function previewChromeCss(zoom: number): string {
  return [
    '@media screen {',
    '  html { background: #6b6b6b; }',
    '  body { margin: 0; }',
    '  .pagedjs_pages { display: flex; flex-direction: column; align-items: center; padding: 16px 0; zoom: ' +
      zoom +
      '; }',
    '  .pagedjs_page { background: #fff; margin: 0 auto 16px; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.45); }',
    '}'
  ].join('\n')
}

interface PagedPolyfill {
  preview: () => Promise<unknown>
}

function polyfillOf(win: Window): PagedPolyfill | null {
  const candidate: unknown = Reflect.get(win, 'PagedPolyfill')
  if (typeof candidate !== 'object' || candidate === null) return null
  const preview: unknown = Reflect.get(candidate, 'preview')
  if (typeof preview !== 'function') return null
  return { preview: () => Promise.resolve(preview.call(candidate)) }
}

function loaded(frame: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve) => frame.addEventListener('load', () => resolve(), { once: true }))
}

function loadScript(doc: Document, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = doc.createElement('script')
    script.src = src
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener(
      'error',
      () => reject(new Error('The page layout engine did not load')),
      {
        once: true
      }
    )
    doc.head.appendChild(script)
  })
}

function addStyle(doc: Document, css: string, id: string): void {
  const style = doc.createElement('style')
  style.id = id
  style.textContent = css
  doc.head.appendChild(style)
}

export const PREVIEW_CHROME_ID = 'ms-preview-chrome'

/** Sets the zoom of a laid-out preview. */
export function setPreviewZoom(frame: HTMLIFrameElement, zoom: number): void {
  const style = frame.contentDocument?.getElementById(PREVIEW_CHROME_ID)
  if (style) style.textContent = previewChromeCss(zoom)
}

export interface LayoutResult {
  /** Pages laid out; null for a reflowable preview. */
  pages: number | null
}

/**
 * Loads `book` into `frame` and lays it out. `stale()` is asked after every wait; once it says
 * true the run stops (a newer layout has replaced the frame's document). Answers null when it
 * stopped.
 */
export async function layoutPreview(
  frame: HTMLIFrameElement,
  book: CompiledBook,
  zoom: number,
  stale: () => boolean
): Promise<LayoutResult | null> {
  const ready = loaded(frame)
  frame.srcdoc = previewHtml(book)
  await ready
  if (stale()) return null
  const win = frame.contentWindow
  const doc = frame.contentDocument
  if (win === null || doc === null) return null
  if (!isPagedOutput(book.output)) {
    // The web page names the fonts with fallbacks; the preview has the bundled ones at hand.
    addStyle(doc, fontFaceCss(formatFonts(book.format), bookFontUrl), 'ms-preview-fonts')
    return { pages: null }
  }
  Reflect.set(win, 'PagedConfig', { auto: false })
  await loadScript(doc, pagedPolyfillUrl)
  if (stale()) return null
  const polyfill = polyfillOf(win)
  if (polyfill === null) throw new Error('The page layout engine did not start')
  await polyfill.preview()
  if (stale()) return null
  furnishPagedPages(doc)
  addStyle(doc, previewChromeCss(zoom), PREVIEW_CHROME_ID)
  return { pages: doc.querySelectorAll('.pagedjs_page').length }
}
