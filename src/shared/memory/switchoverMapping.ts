import { tagNameAsAlias } from '../aliases'
import type { EntityFieldDef } from '../entities'
import { LABEL_DEFAULT_COLOUR, LABEL_NAME_MAX, type LabelKind } from '../storyLabels'
import { HEX_COLOR, type TagCategory } from '../tags'
import type { TiptapNodeT } from '../tiptap'
import { tagNameAsWords } from './inlineTagReplace'
import { NOT_CANON_ATTR } from './pageMarks'
import { RECORD_NAME_MAX } from './records'

/**
 * The switch-over's mapping rules (F-16.15, plan P1 §6.2), pure and shared, so the conversion of a
 * v1 project and the v0 import in v2 (`legacyImport`) map tags and sheets the same way: which tag
 * becomes a record and which a label, what a record from a tag is called, and how a sheet's
 * filled fields read as Pinned lines. The pages they build are page-schema JSON (the paragraphs
 * and headings `PageParagraph` loads), so the renderer's corpus test can load them.
 */

/** The record category a tag of this category becomes; null for tags that become labels. */
export function recordCategoryOfTag(category: TagCategory): string | null {
  switch (category) {
    case 'character':
      return 'character'
    case 'setting':
      return 'setting'
    case 'worldBuilding':
      return 'world'
    case 'plotThread':
      return 'thread'
    case 'tone':
    case 'content':
    case 'custom':
      return null
  }
}

/** The label kind a tag of this category becomes; null for tags that become records. */
export function labelKindOfTag(category: TagCategory): LabelKind | null {
  switch (category) {
    case 'tone':
      return 'tone'
    case 'content':
      return 'content'
    case 'custom':
      return 'custom'
    case 'character':
    case 'setting':
    case 'worldBuilding':
    case 'plotThread':
      return null
  }
}

/**
 * A kebab tag name as a record's name ("mara-vell" → "Mara Vell", `tagNameAsAlias`), since a
 * name the author never spelled out reads as a proper noun in the prose.
 */
export function recordNameFromTag(name: string): string {
  return tagNameAsAlias(name).slice(0, RECORD_NAME_MAX).trim()
}

/** What a tag gives a record: its name, its category, and its other names. */
export interface RecordFromTag {
  name: string
  categoryId: string
  aliases: string[]
}

/** The record a name-category or plot-thread tag becomes; null for a label tag or a blank name. */
export function recordFromTag(tag: {
  name: string
  category: TagCategory
  aliases: readonly string[]
}): RecordFromTag | null {
  const categoryId = recordCategoryOfTag(tag.category)
  const name = recordNameFromTag(tag.name)
  if (categoryId === null || name === '') return null
  return { name, categoryId, aliases: tag.aliases.map((alias) => alias.trim()).filter(Boolean) }
}

/** What a tag gives a label. */
export interface LabelFromTag {
  name: string
  kind: LabelKind
  colour: string
}

/**
 * The label a tone, content or custom tag becomes: the name with hyphens as spaces ("needs
 * research"), the tag's colour kept (the kind's default when it is not a colour); null for a
 * record tag or a blank name.
 */
export function labelFromTag(tag: {
  name: string
  category: TagCategory
  color: string
}): LabelFromTag | null {
  const kind = labelKindOfTag(tag.category)
  const name = tagNameAsWords(tag.name).slice(0, LABEL_NAME_MAX).trim()
  if (kind === null || name === '') return null
  const colour = tag.color.toLowerCase()
  return { name, kind, colour: HEX_COLOR.test(colour) ? colour : LABEL_DEFAULT_COLOUR[kind] }
}

/** One line of a page as the conversion writes it. */
export interface PageLine {
  text: string
  notCanon?: boolean
  heading?: boolean
}

/** A value's paragraphs: split on blank lines, trimmed, empty ones dropped. */
export function textParagraphs(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
}

/** `label: value` lines: the first paragraph after the label, any further ones on their own. */
export function labelledLines(label: string, value: string): string[] {
  const [first, ...rest] = textParagraphs(value)
  if (first === undefined) return []
  return [`${label}: ${first}`, ...rest]
}

/**
 * A sheet's filled fields as Pinned lines (`Label: value`), in page order: the category's
 * template, then the sheet's own fields, then any stored value no field names any more (by its
 * raw id), so nothing the author typed is lost.
 */
export function pinnedFromFields(
  defs: readonly EntityFieldDef[],
  fields: Readonly<Partial<Record<string, string>>>
): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const def of defs) {
    seen.add(def.id)
    const value = fields[def.id]
    if (value !== undefined && value.trim() !== '') lines.push(...labelledLines(def.label, value))
  }
  for (const [id, value] of Object.entries(fields)) {
    if (seen.has(id) || value === undefined || value.trim() === '') continue
    lines.push(...labelledLines(id, value))
  }
  return lines
}

/** The heading of the block that holds sheet text the AI wrote before the switch-over (decision 8). */
export const FILED_BY_AI_HEADING = 'Filed by AI earlier: please check'

/** A paragraph's inline content: text with single line breaks as hard breaks. */
function inline(text: string): TiptapNodeT[] {
  const out: TiptapNodeT[] = []
  text.split('\n').forEach((part, at) => {
    if (at > 0) out.push({ type: 'hardBreak' })
    if (part !== '') out.push({ type: 'text', text: part })
  })
  return out
}

/** One page block: a paragraph (or a level-3 heading), marked Not canon when asked. */
export function pageBlock(line: PageLine): TiptapNodeT {
  const content = inline(line.text)
  const attrs: Record<string, unknown> = line.heading === true ? { level: 3 } : {}
  if (line.notCanon === true) attrs[NOT_CANON_ATTR] = true
  return {
    type: line.heading === true ? 'heading' : 'paragraph',
    ...(Object.keys(attrs).length === 0 ? {} : { attrs }),
    ...(content.length === 0 ? {} : { content })
  }
}

/** A page from lines; null when there are none (an empty page is stored as null). */
export function pageFromLines(lines: readonly PageLine[]): TiptapNodeT | null {
  if (lines.length === 0) return null
  return { type: 'doc', content: lines.map(pageBlock) }
}

/**
 * A record's Pinned page after the switch-over: the author's lines, then, when the AI wrote any of
 * the sheet's text, the "Filed by AI earlier: please check" heading and those lines, every one of
 * them Not canon (decision 8), so nothing the AI wrote reads as canon until she says so.
 */
export function pinnedPage(
  canon: readonly PageLine[],
  filedByAi: readonly string[]
): TiptapNodeT | null {
  const ai: PageLine[] =
    filedByAi.length === 0
      ? []
      : [
          { text: FILED_BY_AI_HEADING, heading: true, notCanon: true },
          ...filedByAi.map((text) => ({ text, notCanon: true }))
        ]
  return pageFromLines([...canon, ...ai])
}

/** A dated author line: `Label (from 12.1 'Title'): value`. */
export function datedLine(label: string, scene: string | null, value: string): string[] {
  return labelledLines(scene === null ? label : `${label} (from ${scene})`, value)
}

/** How a scene is named in a dated line: `12.1 'Title'` (its number, then its title). */
export function sceneReference(number: string, title: string): string {
  return number === '' ? `'${title}'` : `${number} '${title}'`
}
