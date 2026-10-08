import { describe, expect, it } from 'vitest'
import { printPageHtml } from './printPage'
import { sampleBook } from './testBook'

describe('printPageHtml (Compile v2 PDF)', () => {
  it('loads the bundled fonts from files, then Paged.js held back, then the furniture handler', () => {
    const html = printPageHtml(
      sampleBook('paperback-6x9', 'pdf'),
      '/opt/app/fonts',
      'POLYFILL</script>'
    )
    expect(html).toContain(
      "src: url('file:///opt/app/fonts/eb-garamond/eb-garamond-latin-400-normal.woff2') format('woff2')"
    )
    expect(html).not.toContain('liberation-serif')
    const config = html.indexOf('window.PagedConfig = { auto: false }')
    const polyfill = html.indexOf('POLYFILL<\\/script>')
    const handler = html.indexOf('window.Paged.registerHandlers')
    expect(config).toBeGreaterThan(-1)
    expect(polyfill).toBeGreaterThan(config)
    expect(handler).toBeGreaterThan(polyfill)
    expect(html.indexOf('</head>')).toBeGreaterThan(handler)
    expect(html).toContain('<html lang="en-GB">')
    expect(html).toContain('@page { size: 6in 9in;')
  })
})
