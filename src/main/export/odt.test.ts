import { describe, expect, it } from 'vitest'
import { BUILTIN_COMPILE_FORMATS } from '@shared/compileFormat'
import { readZip, readZipDirectory } from '../backups/zip'
import { odfText, renderOdt } from './odt'
import { sampleBook, xmlError } from './testBook'

const MODIFIED = new Date('2026-10-07T10:00:00Z')

function files(buffer: Buffer): Map<string, string> {
  return new Map(readZip(buffer).map((e) => [e.name, e.data.toString('utf8')]))
}

describe('renderOdt (Compile v2)', () => {
  it('writes a well-formed package with the mimetype first and stored', () => {
    for (const format of BUILTIN_COMPILE_FORMATS) {
      const buffer = renderOdt(sampleBook(format, 'odt'), MODIFIED)
      const directory = readZipDirectory(buffer)
      expect(directory[0]).toMatchObject({ name: 'mimetype', method: 0 })
      const all = files(buffer)
      expect(all.get('mimetype')).toBe('application/vnd.oasis.opendocument.text')
      for (const [name, xml] of all)
        if (name.endsWith('.xml')) expect(xmlError(xml), `${format.id} ${name}`).toBeNull()
      // Every automatic style the content uses is defined.
      const content = all.get('content.xml') ?? ''
      for (const [, name] of content.matchAll(/text:style-name="([PT]\d+)"/g))
        expect(content).toContain(`style:name="${name}"`)
    }
  })

  it('carries the paperback page, furniture masters, and the body numbering restart', () => {
    const all = files(renderOdt(sampleBook('paperback-6x9', 'odt'), MODIFIED))
    const styles = all.get('styles.xml') ?? ''
    expect(styles).toContain('style:page-usage="mirrored"')
    expect(styles).toContain('fo:page-width="6in" fo:page-height="9in"')
    expect(styles).toContain('fo:margin-left="0.875in" fo:margin-right="0.6in"')
    expect(styles).toContain('<style:header-left>')
    expect(styles).toContain('<text:page-number text:select-page="current">1</text:page-number>')
    expect(styles).toContain(
      'style:name="Opener" style:page-layout-name="pm2" style:next-style-name="Standard"'
    )
    const content = all.get('content.xml') ?? ''
    expect(content).toContain('style:master-page-name="Front"')
    expect(content).toContain('style:master-page-name="Opener"')
    expect(content).toContain('style:page-number="1"')
    expect(content).toContain('text:outline-level="2"')
  })

  it('writes Editor copy notes as annotations and Book details as metadata', () => {
    const all = files(renderOdt(sampleBook('editor-copy', 'odt'), MODIFIED))
    const content = all.get('content.xml') ?? ''
    expect(content.match(/<office:annotation>/g)).toHaveLength(2)
    expect(content).toContain('Check the tide tables.')
    const meta = all.get('meta.xml') ?? ''
    expect(meta).toContain('<dc:title>The Salt Road</dc:title>')
    expect(meta).toContain('<dc:language>en-GB</dc:language>')
    expect(meta).toContain('<meta:keyword>salt</meta:keyword>')
  })

  it('keeps runs of spaces and tabs', () => {
    expect(odfText(' a  b\tc & d')).toBe('<text:s/>a <text:s text:c="1"/>b<text:tab/>c &amp; d')
  })
})
