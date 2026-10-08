import { describe, expect, it } from 'vitest'
import { defaultExportFormatting, type ExportOptions } from '@shared/bookExport'
import { CompileFormat } from '@shared/compileFormat'
import { exportDialogFormat } from './exportDialog'

const options = (over: Partial<ExportOptions['formatting']> = {}): ExportOptions => ({
  format: 'pdf',
  scope: { kind: 'manuscript' },
  includeFront: true,
  includeEnd: false,
  formatting: { ...defaultExportFormatting('~'), ...over }
})

describe('exportDialogFormat (F-12.1 dialog on the Compile v2 writers)', () => {
  it('turns the dialog options into a valid format', () => {
    const format = exportDialogFormat(options())
    expect(CompileFormat.safeParse(format).success).toBe(true)
    expect(format.sceneSeparator).toEqual({ kind: 'text', text: '~' })
    expect(format.typography).toMatchObject({
      font: 'liberationSerif',
      size: 12,
      lineSpacing: { mode: 'multiple', value: 1.5 },
      indent: 1.5,
      paragraphSpacing: 0
    })
    expect(format.pageSetup).toMatchObject({
      size: 'letter',
      width: 8.5,
      height: 11,
      mirrored: false
    })
    expect(format.sections.chapter).toMatchObject({
      numbering: 'none',
      showTitle: true,
      pageBreak: 'newPage'
    })
    expect(format.matter).toMatchObject({ titlePage: 'none', frontMatter: true, endMatter: false })
    expect(format.headersFooters.recto.footer).toEqual({ left: '', center: '', right: '' })
  })

  it('follows sans, A4, no indents, and chapters in the flow', () => {
    const format = exportDialogFormat(
      options({
        font: 'sans',
        pageSize: 'a4',
        indentParagraphs: false,
        chapterNewPage: false,
        fontSize: 10
      })
    )
    expect(format.typography).toMatchObject({ font: 'sourceSans3', indent: 0, paragraphSpacing: 8 })
    expect(format.pageSetup.size).toBe('a4')
    expect(format.sections.part.pageBreak).toBe('none')
    expect(format.sections.chapter.size).toBe(14)
  })
})
