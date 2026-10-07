import type { ContextFileType } from '@shared/contextLibrary'
import { docToText } from '@shared/docText'
import { readDocx } from '../import/docx'

/**
 * The context library's text extraction (F-9.8): one plain text per uploaded document, paragraphs
 * separated by a blank line, which is what the chunker and the re-upload diff read. Word files go
 * through the manuscript importer's mammoth path (headings kept as their own paragraphs);
 * Markdown and text files are read as they are; a PDF's text layer is read with `unpdf`, a
 * dependency-free build of pdf.js — there is no OCR, so a scanned PDF has no text. Images are
 * never read. Answers null when there is no text at all, so the Library can say "No text found".
 */
export async function extractContextText(
  type: ContextFileType,
  data: Buffer
): Promise<string | null> {
  const text = await rawText(type, data)
  if (text === null) return null
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return normalized === '' ? null : normalized
}

async function rawText(type: ContextFileType, data: Buffer): Promise<string | null> {
  switch (type) {
    case 'image':
      return null
    case 'md':
    case 'txt':
      return data.toString('utf8').replace(/^\uFEFF/, '')
    case 'docx': {
      const blocks = await readDocx(data)
      const paragraphs: string[] = []
      for (const block of blocks) {
        if (block.type === 'heading') paragraphs.push(block.text)
        else if (block.type === 'paragraph') {
          paragraphs.push(docToText({ type: 'doc', content: [block.node] }))
        }
      }
      return paragraphs.join('\n\n')
    }
    case 'pdf':
      return readPdfText(data)
  }
}

/**
 * A PDF's text layer, page by page. `unpdf` is ESM with a CommonJS entry; it is imported lazily
 * so the main bundle does not load pdf.js until the first PDF arrives.
 */
async function readPdfText(data: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  const document = await getDocumentProxy(new Uint8Array(data))
  try {
    const { text } = await extractText(document, { mergePages: false })
    return text.map((page) => page.trim()).join('\n\n')
  } finally {
    await document.cleanup()
  }
}

/** Words in an extracted text, for the Library's row and the estimate's file count. */
export function countTextWords(text: string | null): number {
  if (text === null) return 0
  return text.split(/\s+/).filter((word) => word !== '').length
}
