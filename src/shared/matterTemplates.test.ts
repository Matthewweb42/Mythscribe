import { describe, expect, it } from 'vitest'
import {
  MATTER_TEMPLATE_IDS,
  MATTER_TEMPLATES,
  MatterTemplateId,
  matterTemplate,
  matterTemplatesFor
} from './matterTemplates'
import { TiptapNode, type TiptapNodeT } from './tiptap'
import { countWords } from './wordCount'

/** What `buildExtensions` accepts (F-3.1): anything else is dropped by the editor on load. */
const NODE_TYPES = new Set(['doc', 'paragraph', 'heading', 'blockquote', 'text', 'hardBreak'])
const MARK_TYPES = new Set(['bold', 'italic', 'underline', 'strike', 'code'])

function walk(node: TiptapNodeT, visit: (node: TiptapNodeT) => void): void {
  visit(node)
  for (const child of node.content ?? []) walk(child, visit)
}

const FRONT_TITLES = [
  'Title Page',
  'Copyright Page',
  'Dedication',
  'Epigraph',
  'Foreword',
  'Preface',
  'Table of Contents'
]
const END_TITLES = [
  'Acknowledgments',
  'About the Author',
  "Author's Note",
  'Afterword',
  'Appendix',
  'Glossary',
  'Bibliography'
]

describe('MATTER_TEMPLATES', () => {
  it('lists seven front-matter then seven end-matter templates, titled as the spec names them', () => {
    expect(MATTER_TEMPLATES).toHaveLength(14)
    expect(MATTER_TEMPLATES.slice(0, 7).map((t) => t.section)).toEqual(Array(7).fill('front'))
    expect(MATTER_TEMPLATES.slice(7).map((t) => t.section)).toEqual(Array(7).fill('end'))
    expect(MATTER_TEMPLATES.map((t) => t.title)).toEqual([...FRONT_TITLES, ...END_TITLES])
  })

  it('has unique ids that match the id tuple in order', () => {
    const ids = MATTER_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...MATTER_TEMPLATE_IDS])
    for (const id of ids) expect(MatterTemplateId.safeParse(id).success).toBe(true)
  })

  it('has content that parses as a Tiptap document with some words in it', () => {
    for (const template of MATTER_TEMPLATES) {
      const parsed = TiptapNode.safeParse(template.content)
      expect(parsed.success, template.id).toBe(true)
      expect(template.content.type).toBe('doc')
      expect(countWords(template.content), template.id).toBeGreaterThan(0)
    }
  })

  it('uses only node and mark types the editor schema accepts', () => {
    for (const template of MATTER_TEMPLATES) {
      walk(template.content, (node) => {
        expect(NODE_TYPES.has(node.type), `${template.id}: node ${node.type}`).toBe(true)
        for (const mark of node.marks ?? []) {
          expect(MARK_TYPES.has(mark.type), `${template.id}: mark ${mark.type}`).toBe(true)
        }
        if (node.type === 'text') expect(node.text?.length, template.id).toBeGreaterThan(0)
        if (node.type === 'heading') {
          expect([1, 2, 3]).toContain(node.attrs?.level)
        }
        const align = node.attrs?.textAlign
        if (align !== undefined) {
          expect(['left', 'center', 'right', 'justify']).toContain(align)
          expect(['paragraph', 'heading']).toContain(node.type)
        }
      })
    }
  })

  it('fills the title page and epigraph the way the spec sketches them', () => {
    const title = matterTemplate('title-page').content.content ?? []
    const h1 = title.find((n) => n.type === 'heading')
    expect(h1?.attrs).toEqual({ level: 1, textAlign: 'center' })
    expect(h1?.content?.[0]?.text).toBe('[Book Title]')
    expect(title.some((n) => n.content?.[0]?.text === '[Author Name]')).toBe(true)

    const epigraph = matterTemplate('epigraph').content.content ?? []
    const quote = epigraph.find((n) => n.type === 'blockquote')
    expect(quote?.content?.[0]?.content?.[0]).toMatchObject({
      text: '[Quote]',
      marks: [{ type: 'italic' }]
    })
    expect(epigraph.at(-1)).toMatchObject({ attrs: { textAlign: 'right' } })
  })
})

describe('lookups', () => {
  it('matterTemplate round-trips every id', () => {
    for (const id of MATTER_TEMPLATE_IDS) expect(matterTemplate(id).id).toBe(id)
  })

  it('matterTemplatesFor lists a section in spec order', () => {
    expect(matterTemplatesFor('front').map((t) => t.title)).toEqual(FRONT_TITLES)
    expect(matterTemplatesFor('end').map((t) => t.title)).toEqual(END_TITLES)
  })
})
