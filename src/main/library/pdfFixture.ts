/**
 * Test fixture (F-9.8): a one-page PDF whose text layer holds `lines` in Helvetica, built by hand
 * with a correct cross-reference table, so the PDF reader is exercised without a binary fixture.
 * An empty list makes a page with no text at all — what a scanned document looks like to a reader
 * without OCR.
 */
export function textPdf(lines: readonly string[]): Buffer {
  const shown = lines.map((line, i) => `${i === 0 ? '' : '0 -16 Td '}(${line}) Tj`).join(' ')
  const stream = `BT /F1 12 Tf 72 720 Td ${shown} ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
