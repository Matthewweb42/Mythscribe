import { docToText } from './docText'
import type { NotebookKind } from './notebook'
import type { TiptapNodeT } from './tiptap'

/**
 * Note templates (notes redesign phase 6, `docs/research/notes-redesign-2026-10-15/templates.md`):
 * the built-in page shapes as data, the author's own templates (the pages in a Notes folder named
 * Templates), the starter set for an empty Notes, and the local layout that puts Ms Scribe's text
 * for a new page on its folder's template. A template only makes an ordinary free page: headings
 * with an empty line under each, all editable, nothing locked. Pure: no database, no editor.
 */

export const NOTEBOOK_TEMPLATE_IDS = [
  'character',
  'place',
  'group',
  'item',
  'magic',
  'event',
  'timeline',
  'chapterPlan',
  'styleGuide'
] as const
export type NotebookTemplateId = (typeof NOTEBOOK_TEMPLATE_IDS)[number]

export interface NotebookTemplate {
  id: NotebookTemplateId
  /** The menu's label, and the name Ms Scribe's tool result gives it. */
  name: string
  /** The new page's title, selected in the tree for the author to type over. */
  pageTitle: string
  headings: readonly string[]
  /** Folder titles (caseless) whose new pages Ms Scribe lays out on this template. */
  folders: readonly string[]
}

/**
 * The page the edit flow's Copyediting follows (`src/main/editFlow/run.ts`: a note page titled
 * "Style guide", any case); the built-in Style guide template makes a page of exactly this title.
 */
export const STYLE_GUIDE_TITLE = 'Style guide'

/** The Notes folder whose pages are the author's own templates (any case, at any depth). */
export const TEMPLATES_FOLDER_TITLE = 'Templates'

export const NOTEBOOK_TEMPLATES: readonly NotebookTemplate[] = [
  {
    id: 'character',
    name: 'Character',
    pageTitle: 'New character',
    headings: [
      'Role',
      'Appearance',
      'Wants',
      'Fears',
      'Voice and speech',
      'Powers',
      'Relationships',
      'Arc',
      'First appears'
    ],
    folders: ['characters', 'character', 'cast', 'people']
  },
  {
    id: 'place',
    name: 'Place',
    pageTitle: 'New place',
    headings: [
      'Where it is',
      'What it looks like',
      'Sounds and smells',
      'Who lives there',
      'History',
      'What happens here',
      'First appears'
    ],
    folders: ['places', 'place', 'locations', 'location']
  },
  {
    id: 'group',
    name: 'Group / faction',
    pageTitle: 'New group',
    headings: [
      'Purpose',
      'Leader',
      'Members',
      'Beliefs',
      'Allies and enemies',
      'Resources',
      'History',
      'First appears'
    ],
    folders: [
      'groups',
      'group',
      'factions',
      'faction',
      'organisations',
      'organizations',
      'groups and factions'
    ]
  },
  {
    id: 'item',
    name: 'Item',
    pageTitle: 'New item',
    headings: [
      'What it is',
      'Appearance',
      'What it does',
      'Who has it',
      'Where it came from',
      'Rules and limits',
      'First appears'
    ],
    folders: ['items', 'item', 'objects', 'artifacts', 'artefacts']
  },
  {
    id: 'magic',
    name: 'Magic or power system',
    pageTitle: 'New power system',
    headings: [
      'What it is',
      'Who can use it',
      'How it works',
      'Costs and limits',
      'What it cannot do',
      'How it looks and feels',
      'Known users',
      'Open questions'
    ],
    folders: ['magic', 'powers', 'magic system', 'magic systems', 'power system', 'power systems']
  },
  {
    id: 'event',
    name: 'Event',
    pageTitle: 'New event',
    headings: [
      'When',
      'Where',
      'Who was there',
      'What happened',
      'Why it matters',
      'Who knows',
      'Shown in'
    ],
    folders: ['events', 'event']
  },
  {
    id: 'timeline',
    name: 'Timeline',
    pageTitle: 'Timeline',
    headings: ['Before the story', 'During the story', 'After the story'],
    folders: ['timeline', 'timelines']
  },
  {
    id: 'chapterPlan',
    name: 'Chapter plan',
    pageTitle: 'New chapter plan',
    headings: ['Goal', 'Point of view', 'Setting', 'Beats', 'Conflict', 'Turn', 'Ends on', 'Notes'],
    folders: ['chapter plans', 'chapters', 'outline']
  },
  {
    id: 'styleGuide',
    name: 'Style guide',
    pageTitle: STYLE_GUIDE_TITLE,
    headings: [
      'Spelling choices',
      'Capitalised terms',
      'Numbers',
      'Dialogue punctuation',
      'Swearing'
    ],
    folders: []
  }
]

/** The starter set's top-level folders (with a Style guide page beside them). */
export const NOTEBOOK_STARTER_FOLDERS = [
  'Characters',
  'Places',
  'World',
  'Plot',
  'Timeline'
] as const

export function notebookTemplate(id: NotebookTemplateId): NotebookTemplate {
  const found = NOTEBOOK_TEMPLATES.find((template) => template.id === id)
  if (found === undefined) throw new Error(`No note template ${id}`)
  return found
}

export function isNotebookTemplateId(value: string): value is NotebookTemplateId {
  return (NOTEBOOK_TEMPLATE_IDS as readonly string[]).includes(value)
}

/** A built-in template's page: each heading (level 2) with an empty line under it. */
export function templateDoc(template: NotebookTemplate): TiptapNodeT {
  return {
    type: 'doc',
    content: template.headings.flatMap((heading) => [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: heading }] },
      { type: 'paragraph' }
    ])
  }
}

const key = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/\s*[:：]\s*$/, '')
    .toLowerCase()

/** Whether a folder title names the Templates folder (any case). */
export function isTemplatesFolder(title: string): boolean {
  return key(title) === key(TEMPLATES_FOLDER_TITLE)
}

/** The fields of a notebook row the template helpers read. */
export interface TemplateTreeItem {
  id: string
  parentId: string | null
  kind: NotebookKind
  title: string
  position: number
}

/** Whether an item under `parentId` sits inside a Templates folder (at any depth). */
export function inTemplates(items: readonly TemplateTreeItem[], parentId: string | null): boolean {
  const byId = new Map(items.map((item) => [item.id, item]))
  const seen = new Set<string>()
  for (let at = parentId; at !== null && !seen.has(at);) {
    seen.add(at)
    const item = byId.get(at)
    if (item === undefined) return false
    if (item.kind === 'folder' && isTemplatesFolder(item.title)) return true
    at = item.parentId
  }
  return false
}

/** The author's own templates: every page inside a Templates folder, in the tree's order. */
export function myTemplatePages<T extends TemplateTreeItem>(items: readonly T[]): T[] {
  const children = new Map<string | null, T[]>()
  const ids = new Set(items.map((item) => item.id))
  for (const item of items) {
    const parent = item.parentId !== null && ids.has(item.parentId) ? item.parentId : null
    const list = children.get(parent) ?? []
    list.push(item)
    children.set(parent, list)
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position)
  const found: T[] = []
  const walk = (parent: string | null, inside: boolean): void => {
    for (const item of children.get(parent) ?? []) {
      if (item.kind === 'page') {
        if (inside) found.push(item)
      } else {
        walk(item.id, inside || isTemplatesFolder(item.title))
      }
    }
  }
  walk(null, false)
  return found
}

/** The built-in template a folder's title asks for (Characters → Character), or null. */
export function builtInTemplateForFolder(title: string): NotebookTemplate | null {
  const wanted = key(title)
  return NOTEBOOK_TEMPLATES.find((template) => template.folders.includes(wanted)) ?? null
}

/** The template a folder's new pages follow: one of the author's, or a built-in. */
export type FolderTemplate =
  { kind: 'mine'; pageId: string; name: string } | { kind: 'builtIn'; template: NotebookTemplate }

/**
 * The template Ms Scribe lays a new page in `folderId` out on: from the folder outwards, the first
 * folder whose title names one of the author's templates (the folder's title, that title without
 * a final "s", or the built-in's name: Characters → a "Character" page in Templates) or a built-in
 * (`builtInTemplateForFolder`). None inside a Templates folder, nor at the top level.
 */
export function templateForFolder(
  items: readonly TemplateTreeItem[],
  folderId: string | null
): FolderTemplate | null {
  if (folderId === null || inTemplates(items, folderId)) return null
  const mine = myTemplatePages(items)
  const byId = new Map(items.map((item) => [item.id, item]))
  const seen = new Set<string>()
  for (let at: string | null = folderId; at !== null && !seen.has(at);) {
    seen.add(at)
    const folder = byId.get(at)
    if (folder === undefined) break
    const builtIn = builtInTemplateForFolder(folder.title)
    const names = new Set(
      [folder.title, folder.title.replace(/s\s*$/i, ''), builtIn?.name ?? '']
        .map(key)
        .filter((name) => name !== '')
    )
    const own = mine.find((page) => names.has(key(page.title)))
    if (own !== undefined) return { kind: 'mine', pageId: own.id, name: own.title }
    if (builtIn !== null) return { kind: 'builtIn', template: builtIn }
    at = folder.parentId
  }
  return null
}

const blockText = (block: TiptapNodeT): string => docToText({ type: 'doc', content: [block] })

/** A short label line of a template ("Age:"), which a filled page writes as "Age: 34". */
const LABEL_LINE = /^[^:：]{1,40}[:：]$/

/** The section a template block opens (its key), or null for an ordinary line. */
function markerOf(block: TiptapNodeT): string | null {
  const text = blockText(block).trim()
  if (text === '') return null
  if (block.type === 'heading') return key(text)
  if (block.type === 'paragraph' && LABEL_LINE.test(text)) return key(text)
  return null
}

/** A template page's sections as she should write them: its headings and label lines, in order. */
export function templateSections(content: TiptapNodeT | null): string[] {
  return (content?.content ?? []).flatMap((block) =>
    markerOf(block) === null
      ? []
      : [
          blockText(block)
            .trim()
            .replace(/\s*[:：]$/, '')
        ]
  )
}

const paragraph = (line: string): TiptapNodeT =>
  line === ''
    ? { type: 'paragraph' }
    : { type: 'paragraph', content: [{ type: 'text', text: line }] }

function trimLines(lines: readonly string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] ?? '').trim() === '') start++
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--
  return lines.slice(start, end)
}

export interface TemplateLayout {
  content: TiptapNodeT
  /** The sections her text filled, as the template names them. */
  filled: string[]
  /** The sections left as the template has them. */
  empty: string[]
}

/**
 * Her text for a new page put on a template, locally: a line that is a section's name (`## Role`,
 * `Role`, `Role:`) starts that section, and `Role: a smuggler` starts it with the rest of the line;
 * every other line goes to the section above it, or before the first section when none is above.
 * Each section she wrote replaces the template's lines under it (a label line takes a one-line
 * answer on its own line, "Age: 34"); the rest stay as the template has them. Nothing of hers is
 * dropped. Null when the template has no sections.
 */
export function layoutOnTemplate(
  skeleton: TiptapNodeT | null,
  text: string
): TemplateLayout | null {
  const blocks = skeleton?.content ?? []
  const markers = blocks.flatMap((block, at) => {
    const marker = markerOf(block)
    return marker === null ? [] : [{ at, key: marker, block }]
  })
  if (markers.length === 0) return null
  const known = new Set(markers.map((marker) => marker.key))
  const buckets = new Map<string, string[]>()
  const preamble: string[] = []
  let current: string[] = preamble
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const whole = key(raw)
    const labelled = /^\s*(?:#+\s*)?([^:：]{1,40})[:：]\s*(\S.*)$/.exec(raw)
    if (whole !== '' && known.has(whole)) {
      current = buckets.get(whole) ?? []
      buckets.set(whole, current)
    } else if (labelled !== null && known.has(key(labelled[1] ?? ''))) {
      const at = key(labelled[1] ?? '')
      current = buckets.get(at) ?? []
      buckets.set(at, current)
      current.push((labelled[2] ?? '').trim())
    } else {
      current.push(raw)
    }
  }
  const out: TiptapNodeT[] = []
  const mine = trimLines(preamble)
  const first = markers[0]?.at ?? 0
  if (mine.length > 0) out.push(...mine.map(paragraph))
  else out.push(...blocks.slice(0, first))
  const filled: string[] = []
  const empty: string[] = []
  markers.forEach((marker, index) => {
    const end = markers[index + 1]?.at ?? blocks.length
    const name = blockText(marker.block)
      .trim()
      .replace(/\s*[:：]$/, '')
    const lines = trimLines(buckets.get(marker.key) ?? [])
    if (lines.length === 0) {
      empty.push(name)
      out.push(...blocks.slice(marker.at, end))
      return
    }
    filled.push(name)
    const [head, ...rest] = lines
    if (marker.block.type !== 'heading' && rest.length === 0 && head !== undefined) {
      out.push(paragraph(`${blockText(marker.block).trim()} ${head.trim()}`))
      return
    }
    out.push(marker.block, ...lines.map(paragraph))
  })
  return { content: { type: 'doc', content: out }, filled, empty }
}
