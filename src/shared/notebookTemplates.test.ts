import { describe, expect, it } from 'vitest'
import { docToText } from './docText'
import { notebookDocFromText } from './notebook'
import {
  NOTEBOOK_STARTER_FOLDERS,
  NOTEBOOK_TEMPLATE_IDS,
  NOTEBOOK_TEMPLATES,
  STYLE_GUIDE_TITLE,
  builtInTemplateForFolder,
  inTemplates,
  layoutOnTemplate,
  myTemplatePages,
  notebookTemplate,
  templateDoc,
  templateForFolder,
  templateSections,
  templatedFolders,
  type TemplateTreeItem
} from './notebookTemplates'
import { TiptapNode, type TiptapNodeT } from './tiptap'

/** What the notes editor's schema takes (`buildExtensions`); the renderer test loads them too. */
const NODE_TYPES = new Set(['doc', 'paragraph', 'heading', 'text'])

function walk(node: TiptapNodeT, visit: (node: TiptapNodeT) => void): void {
  visit(node)
  for (const child of node.content ?? []) walk(child, visit)
}

const item = (
  id: string,
  kind: TemplateTreeItem['kind'],
  parentId: string | null,
  position: number,
  title = id
): TemplateTreeItem => ({ id, kind, parentId, position, title })

describe('the built-in note templates', () => {
  it('are the nine of the plan, each a valid document of its headings', () => {
    expect(NOTEBOOK_TEMPLATES.map((t) => t.name)).toEqual([
      'Character',
      'Place',
      'Group / faction',
      'Item',
      'Magic or power system',
      'Event',
      'Timeline',
      'Chapter plan',
      'Style guide'
    ])
    for (const id of NOTEBOOK_TEMPLATE_IDS) {
      const template = notebookTemplate(id)
      const doc = templateDoc(template)
      expect(TiptapNode.safeParse(doc).success).toBe(true)
      walk(doc, (node) => expect(NODE_TYPES.has(node.type)).toBe(true))
      expect(templateSections(doc)).toEqual(template.headings)
      const headings = (doc.content ?? []).filter((block) => block.type === 'heading')
      expect(headings).toHaveLength(template.headings.length)
      expect(headings.every((h) => h.attrs?.level === 2)).toBe(true)
    }
  })

  it('has the Character headings and a Style guide page titled as Copyediting reads it', () => {
    expect(notebookTemplate('character').headings).toEqual([
      'Role',
      'Appearance',
      'Wants',
      'Fears',
      'Voice and speech',
      'Powers',
      'Relationships',
      'Arc',
      'First appears'
    ])
    const guide = notebookTemplate('styleGuide')
    expect(guide.pageTitle).toBe(STYLE_GUIDE_TITLE)
    expect(STYLE_GUIDE_TITLE.toLowerCase()).toBe('style guide')
    expect(docToText(templateDoc(guide))).toContain('Dialogue punctuation')
  })

  it('maps folder names to their kind', () => {
    expect(builtInTemplateForFolder('Characters')?.id).toBe('character')
    expect(builtInTemplateForFolder(' places ')?.id).toBe('place')
    expect(builtInTemplateForFolder('Factions')?.id).toBe('group')
    expect(builtInTemplateForFolder('Magic')?.id).toBe('magic')
    expect(builtInTemplateForFolder('Timeline')?.id).toBe('timeline')
    expect(builtInTemplateForFolder('World')).toBeNull()
    expect(builtInTemplateForFolder('Plot')).toBeNull()
  })
})

describe('the author’s templates', () => {
  const items = [
    item('Characters', 'folder', null, 0),
    item('Minor', 'folder', 'Characters', 0),
    item('Templates', 'folder', null, 1),
    item('Villain', 'page', 'Templates', 1),
    item('Character', 'page', 'Templates', 0),
    item('Deep', 'folder', 'Templates', 2),
    item('Ship', 'page', 'Deep', 0),
    item('Mara', 'page', 'Characters', 1),
    item('World', 'folder', null, 2)
  ]

  it('are the pages inside a Templates folder, in the tree’s order', () => {
    expect(myTemplatePages(items).map((page) => page.id)).toEqual(['Character', 'Villain', 'Ship'])
    expect(inTemplates(items, 'Deep')).toBe(true)
    expect(inTemplates(items, 'Characters')).toBe(false)
    expect(inTemplates(items, null)).toBe(false)
  })

  it('a folder takes the author’s template of its name before the built-in, from the folder outwards', () => {
    expect(templateForFolder(items, 'Characters')).toEqual({
      kind: 'mine',
      pageId: 'Character',
      name: 'Character'
    })
    expect(templateForFolder(items, 'Minor')).toMatchObject({ kind: 'mine', pageId: 'Character' })
    const noOwn = items.filter((each) => each.id !== 'Character')
    expect(templateForFolder(noOwn, 'Characters')).toMatchObject({
      kind: 'builtIn',
      template: { id: 'character' }
    })
    expect(templateForFolder(items, 'World')).toBeNull()
    expect(templateForFolder(items, 'Templates')).toBeNull()
    expect(templateForFolder(items, null)).toBeNull()
  })

  it('lists each templated folder once where its template starts, in the tree’s order (notes fixes)', () => {
    const tree = [
      ...items,
      item('Places', 'folder', null, 3),
      item('Cities', 'folder', 'Places', 0),
      item('Villains', 'folder', 'Characters', 2)
    ]
    expect(
      templatedFolders(tree).map(({ folder, template }) => [
        folder.id,
        template.kind === 'mine' ? template.pageId : template.template.id
      ])
    ).toEqual([
      ['Characters', 'Character'],
      // Characters › Villains takes the author’s Villain template; Minor only inherits.
      ['Villains', 'Villain'],
      ['Places', 'place']
    ])
  })
})

describe('layoutOnTemplate', () => {
  const character = templateDoc(notebookTemplate('character'))

  it('puts her lines under the sections they name and keeps the rest empty', () => {
    const laid = layoutOnTemplate(
      character,
      'A smuggler from the reef.\n## Role\nThe hero’s rival\nFears: the sea\nand drowning\nArc:'
    )
    expect(laid?.filled).toEqual(['Role', 'Fears'])
    expect(laid?.empty).toEqual([
      'Appearance',
      'Wants',
      'Voice and speech',
      'Powers',
      'Relationships',
      'Arc',
      'First appears'
    ])
    const lines = docToText(laid?.content ?? { type: 'doc' }).split('\n')
    expect(lines.slice(0, 7)).toEqual([
      'A smuggler from the reef.',
      'Role',
      'The hero’s rival',
      'Appearance',
      '',
      'Wants',
      ''
    ])
    expect(lines).toContain('the sea')
    expect(lines).toContain('and drowning')
    expect(laid?.content.content?.[1]).toMatchObject({ type: 'heading', attrs: { level: 2 } })
  })

  it('keeps free text whole above the empty sections', () => {
    const laid = layoutOnTemplate(character, 'Mara keeps a skull above her door.')
    expect(laid?.filled).toEqual([])
    expect(docToText(laid?.content ?? { type: 'doc' }).split('\n')[0]).toBe(
      'Mara keeps a skull above her door.'
    )
  })

  it('fills an author’s label lines on their own line', () => {
    const mine = notebookDocFromText('Ship sheet\nCaptain:\nCrew:\n\nNotes go here')
    const laid = layoutOnTemplate(mine, 'Captain: Rook\nCrew: six\nand a cat')
    expect(docToText(laid?.content ?? { type: 'doc' })).toBe(
      'Ship sheet\nCaptain: Rook\nCrew:\nsix\nand a cat'
    )
    expect(laid?.filled).toEqual(['Captain', 'Crew'])
  })

  it('is null for a template with no sections', () => {
    expect(layoutOnTemplate(notebookDocFromText('Just a page'), 'Text')).toBeNull()
    expect(layoutOnTemplate(null, 'Text')).toBeNull()
  })
})

describe('the notes binder’s sections and templates (2026-10-16)', () => {
  it('a section follows no template itself; a folder inside one takes its own', () => {
    const items: TemplateTreeItem[] = [
      { ...item('outline', 'folder', null, 0, 'Outline'), role: 'outline' },
      { ...item('timeline', 'folder', null, 1, 'Timeline'), role: 'timeline' },
      { ...item('documents', 'folder', null, 2, 'Documents'), role: 'documents' },
      item('plans', 'folder', 'outline', 0, 'Chapter plans'),
      item('beats', 'folder', 'outline', 1, 'Beats'),
      item('characters', 'folder', 'documents', 0, 'Characters')
    ]
    expect(templateForFolder(items, 'outline')).toBeNull()
    expect(templateForFolder(items, 'timeline')).toBeNull()
    expect(templateForFolder(items, 'beats')).toBeNull()
    expect(templateForFolder(items, 'plans')).toMatchObject({
      kind: 'builtIn',
      template: { id: 'chapterPlan' }
    })
    expect(templateForFolder(items, 'characters')).toMatchObject({
      kind: 'builtIn',
      template: { id: 'character' }
    })
    expect(NOTEBOOK_STARTER_FOLDERS).not.toContain('Timeline')
  })
})
