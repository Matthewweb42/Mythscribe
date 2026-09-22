import mammoth from 'mammoth'
import type { ImportBlock } from './blocks'
import { htmlToBlocks } from './html'

/**
 * Manuscript import (F-12.2): the DOCX reader. Mammoth is the only dependency that reads Word
 * files, and this is the only module that imports it — everything downstream sees import blocks.
 * It keeps the author's heading styles (Heading 1/2 become `h1`/`h2`), which is exactly what the
 * structure heuristics need, and it is pure JavaScript, so no native build joins the tree.
 */
export async function readDocx(buffer: Buffer): Promise<ImportBlock[]> {
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      // Empty paragraphs are the blank-line signal a manuscript uses for scene breaks, so they
      // must survive the conversion; mammoth drops them by default.
      ignoreEmptyParagraphs: false,
      // Images are not imported. Answering an empty `src` keeps mammoth from base64-encoding
      // every picture in the file into a string the importer would only throw away.
      convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' }))
    }
  )
  return htmlToBlocks(result.value)
}
