import Paragraph from '@tiptap/extension-paragraph'
import { IMPORTED_ORIGIN, PARAGRAPH_ORIGIN_ATTR } from '@shared/provenance'

/**
 * The paragraph with its import provenance (F-12.2): a paragraph the manuscript importer wrote
 * carries `attrs.origin = 'imported'` and renders it as `data-origin="imported"`, so imported
 * prose stays distinguishable from what the author typed afterwards (and from the AI-origin
 * mark, F-14.6, which lives on text instead). Nothing in the editor sets the attribute; it rides
 * on the document the importer stored, survives a round-trip through `getJSON`, and parses back
 * from the HTML flavour of the clipboard. StarterKit's own paragraph is off in `buildExtensions`
 * so this one is the schema's.
 */
export const OriginParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      [PARAGRAPH_ORIGIN_ATTR]: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-origin') === IMPORTED_ORIGIN ? IMPORTED_ORIGIN : null,
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes[PARAGRAPH_ORIGIN_ATTR] === IMPORTED_ORIGIN
            ? { 'data-origin': IMPORTED_ORIGIN }
            : {}
      }
    }
  }
})
