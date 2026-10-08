import { afterEach, describe, expect, it } from 'vitest'
import { BookDetails } from '@shared/bookDetails'
import { BUILTIN_COMPILE_FORMATS, type CompileOutput } from '@shared/compileFormat'
import { furnishPagedPages, PAGED_FURNITURE_HANDLER } from '@shared/compileHtml'
import { compileBook, type CompiledBook } from '@shared/compileModel'
import { isPagedOutput, previewChromeCss, previewHtml } from './pagedFrame'

function book(output: CompileOutput): CompiledBook {
  const format = BUILTIN_COMPILE_FORMATS.find((f) => f.id === 'builtin:paperback-6x9')
  if (!format) throw new Error('no paperback')
  return compileBook({
    source: {
      front: [],
      manuscript: [
        {
          id: 's1',
          kind: 'document',
          level: 'scene',
          depth: 0,
          title: 'Opening',
          meta: null,
          tags: [],
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Rain.' }] }]
          },
          synopsis: '',
          notes: null
        }
      ],
      end: []
    },
    format,
    output,
    details: BookDetails.parse({ title: 'Salt Road' }),
    projectName: 'P',
    scope: { kind: 'manuscript' },
    excluded: []
  })
}

/** Two laid-out pages the way Paged.js leaves them: a bare front page, then the body. */
const PAGES = `
  <div class="pagedjs_page"><div class="ms-front gen-toc"><a href="#s-body">Body</a></div></div>
  <div class="pagedjs_page"><div class="ms-restart ms-opener" id="s-body">Body</div></div>
  <div class="pagedjs_page"><p>More</p></div>`

afterEach(() => {
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'Paged')
})

describe('the preview frame (F-12.4)', () => {
  it('previews paged outputs as the print page with the bundled fonts on the asset scheme', () => {
    expect(isPagedOutput('pdf')).toBe(true)
    expect(isPagedOutput('epub')).toBe(false)
    const html = previewHtml(book('pdf'))
    expect(html).toContain(
      "url('mythscribe-asset://book-fonts/eb-garamond/eb-garamond-latin-400-normal.woff2')"
    )
    expect(html).toContain('@page')
    expect(html).not.toContain('<script')
    const web = previewHtml(book('epub'))
    expect(web).not.toContain('@page')
    expect(web).toContain('Rain.')
    expect(previewChromeCss(0.5)).toContain('zoom: 0.5;')
  })

  it('furnishes laid-out pages: bare front and opener pages, folios, contents numbers', () => {
    document.body.innerHTML = PAGES
    furnishPagedPages(document)
    const pages = Array.from(document.querySelectorAll<HTMLElement>('.pagedjs_page'))
    expect(pages.map((p) => p.classList.contains('ms-bare'))).toEqual([true, true, false])
    expect(pages.map((p) => p.getAttribute('data-ms-folio'))).toEqual(['1', '1', '2'])
    expect(pages[2]?.style.getPropertyValue('--ms-folio')).toBe('"2"')
    expect(document.querySelector('.gen-toc a')?.getAttribute('data-folio')).toBe('1')
  })

  it('builds the PDF printer’s Paged.js handler from the same function', () => {
    // The printer's handler is inline script carrying this function's own source (the e2e
    // checks the printed PDF); the preview calls the function itself.
    expect(PAGED_FURNITURE_HANDLER).toContain(furnishPagedPages.toString())
    expect(PAGED_FURNITURE_HANDLER).toContain('furnish(document)')
    expect(PAGED_FURNITURE_HANDLER).toContain('window.Paged.registerHandlers(MythScribeFurniture)')
  })
})
