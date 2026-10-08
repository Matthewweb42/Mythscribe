import { BUILTIN_CATEGORIES } from '@shared/categories'
import {
  ORGANISE_CHUNK_CHARS,
  ORGANISE_INDEX_CHARS,
  ORGANISE_MAX_CHUNKS,
  ORGANISE_MAX_OPS,
  ORGANISE_MAX_TOKENS,
  ORGANISE_RETRY_MAX_TOKENS,
  ORGANISE_SCOPE_LABEL,
  type OrganiseScope
} from '@shared/organise'
import { TAG_CATEGORIES } from '@shared/tags'
import type { AiMessage } from '../providers/types'

/**
 * The organise prompt (F-9.10), version 1: the author's tags, story-bible sheets, notes, and
 * outline in, a plan of typed operations out (`OrganiseOp`, resolved in main by
 * `OrganiseResolver`). A run sends one request per chunk of the listing; every request carries
 * the same rules and the same index of every tag and sheet (so a chunk may name a tag or sheet
 * listed elsewhere), then the task and its chunk. The manuscript's text is never sent.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules (the same for every request of every
 * project), the index (the same for every request of one run), then the task and the chunk.
 */
export const ORGANISE_PROMPT_VERSION = 'organise.v1'

/** The rules. The opening sentence is how the e2e's fake OpenAI recognises an organise request. */
export const ORGANISE_RULES =
  "You organise a novelist's project notes inside a writing app. You see the tags (t1…), the " +
  'story-bible sheets (s1…), the notes of documents and the outline (n1…). Propose changes as ' +
  'operations; the author reviews them. Never invent facts and never write story prose: merge, ' +
  'move, tidy, and fill only from what is listed. Sheet categories: ' +
  `${BUILTIN_CATEGORIES.map((category) => `${category.id} (${category.hint})`).join(', ')}, ` +
  `and any listed with the project. Tag categories: ${TAG_CATEGORIES.join(', ')}.\n` +
  'Operations, with ids exactly as listed:\n' +
  '- {"op":"mergeTags","keep":"t1","merge":["t2"]}: one tag; the merged names become its ' +
  'aliases. Keep the one with the full name.\n' +
  '- {"op":"tag","tag":"t1","name":"…","category":"character","parent":"t4","aliases":["…"]}: ' +
  'any of these; "parent":"" for the top level; "aliases" is the whole list.\n' +
  '- {"op":"deleteTag","tag":"t1"}: only a tag nothing uses.\n' +
  '- {"op":"mergeSheets","keep":"s1","merge":["s2"]}: sheets about one thing.\n' +
  '- {"op":"sheet","sheet":"s1","name":"…","category":"magic","set":{"Field":"text"},' +
  '"add":{"Field":"text"},"aliases":["…"]}: any of these; "set" replaces a field\'s text (to ' +
  'tidy or de-duplicate it), "add" adds to it (an empty field filled from notes or observed ' +
  'facts); fields by label, "page" for the page.\n' +
  '- {"op":"newSheet","category":"history","name":"…","fields":{"Field":"text"}}\n' +
  '- {"op":"deleteSheet","sheet":"s1"}: only an empty sheet.\n' +
  '- {"op":"category","name":"Ships","singular":"ship","fields":["Crew"]}: a new category, ' +
  'only when several sheets fit none; then name it in other operations.\n' +
  '- {"op":"notes","id":"n3","points":["…"]}: the document\'s notes rewritten as these ' +
  'points; leave out facts you moved into a sheet, lose nothing else.\n' +
  '- {"op":"rename","id":"n3","title":"…"}, {"op":"move","id":"n3","in":"n2","after":"n4"} ' +
  '("after":"" for first), {"op":"merge","id":"n3","into":"n4"}, {"op":"delete","id":"n5"} ' +
  '(an empty folder only): the binder.\n' +
  'Give each a short "why". Titles, nicknames, and spellings of one name are aliases, not tags ' +
  'or sheets of their own. Do what the instruction asks; with none, what clearly helps. At most ' +
  `${ORGANISE_MAX_OPS} operations. Reply with JSON only: {"reply":"one sentence","ops":[…]}.`

/** The user turn of the one retry after an answer that was cut off or did not parse. */
export const ORGANISE_RETRY_TURN =
  'Your last answer was cut off or was not one JSON object. Answer again with one short JSON ' +
  'object: the most useful operations only, and short texts.'

/** Characters kept of one field value, of a page, of one fact, and of one document's notes. */
const VALUE_CHARS = 300
const PAGE_CHARS = 400
const FACT_CHARS = 100
const FACTS_SHOWN = 5
const NOTES_CHARS = 800

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

export interface OrganiseTagLine {
  ref: string
  name: string
  category: string
  /** The parent's ref, or null at the top level. */
  parent: string | null
  aliases: readonly string[]
  docs: number
  mentions: number
  /** The linked sheet's ref, or null. */
  sheet: string | null
}

export interface OrganiseSheetLine {
  ref: string
  kind: string
  name: string
  aliases: readonly string[]
  /** Field values by label, empty ones left out. */
  fields: readonly { label: string; value: string }[]
  /** Labels of the template's fields that are empty. */
  empty: readonly string[]
  page: string
  /** Observed facts (F-5.16) as "attribute: value". */
  facts: readonly string[]
}

export interface OrganiseNoteLine {
  ref: string
  title: string
  notes: string
}

export interface OrganiseOutlineLine {
  ref: string
  depth: number
  title: string
  level: string
  /** Words of a document; null for a folder. */
  words: number | null
}

/** Everything a run may list, already in refs. */
export interface OrganiseListing {
  /** The project's own categories (the library is in the rules). */
  categories: readonly { id: string; name: string }[]
  tags: readonly OrganiseTagLine[]
  sheets: readonly OrganiseSheetLine[]
  notes: readonly OrganiseNoteLine[]
  outline: readonly OrganiseOutlineLine[]
  /** The local findings in refs ("Likely duplicates: t3 + t7"), or '' for none. */
  findings: string
}

export function tagLine(tag: OrganiseTagLine): string {
  const parts = [`${tag.ref} #${tag.name}`, tag.category]
  if (tag.parent !== null) parts.push(`under ${tag.parent}`)
  if (tag.aliases.length > 0) parts.push(`also: ${tag.aliases.join(', ')}`)
  parts.push(`${tag.docs} docs, ${tag.mentions} mentions`)
  if (tag.sheet !== null) parts.push(`sheet ${tag.sheet}`)
  return parts.join(' · ')
}

export function sheetIndexLine(sheet: OrganiseSheetLine): string {
  const also = sheet.aliases.length > 0 ? ` · also: ${sheet.aliases.join(', ')}` : ''
  return `${sheet.ref} ${sheet.kind} · ${sheet.name}${also}`
}

export function sheetDetailLine(sheet: OrganiseSheetLine): string {
  const parts = [`${sheet.ref} ${sheet.name}`]
  if (sheet.fields.length > 0) {
    parts.push(sheet.fields.map((f) => `${f.label}=${clip(f.value, VALUE_CHARS)}`).join('; '))
  }
  if (sheet.empty.length > 0) parts.push(`empty: ${sheet.empty.join(', ')}`)
  if (sheet.page.trim() !== '') parts.push(`page: ${clip(sheet.page, PAGE_CHARS)}`)
  if (sheet.facts.length > 0) {
    const shown = sheet.facts.slice(0, FACTS_SHOWN).map((fact) => clip(fact, FACT_CHARS))
    const more = sheet.facts.length - shown.length
    parts.push(`observed: ${shown.join('; ')}${more > 0 ? ` (+${more})` : ''}`)
  }
  return parts.join(' · ')
}

export function noteLine(note: OrganiseNoteLine): string {
  return `${note.ref} ${note.title} · notes: ${clip(note.notes, NOTES_CHARS)}`
}

export function outlineLine(line: OrganiseOutlineLine): string {
  const words = line.words === null ? '' : `, ${line.words.toLocaleString('en-US')} words`
  return `${'  '.repeat(line.depth)}${line.ref} ${line.title} (${line.level}${words})`
}

/** Lines in order until `max` characters, then a count of what was left off. */
function capped(lines: readonly string[], max: number, noun: string): string {
  let budget = max
  const kept: string[] = []
  for (const line of lines) {
    if (line.length + 1 > budget) break
    budget -= line.length + 1
    kept.push(line)
  }
  const left = lines.length - kept.length
  if (left > 0) kept.push(`(${left} more ${noun} not shown)`)
  return kept.length > 0 ? kept.join('\n') : '(none)'
}

/** The index every request carries: the project's categories, every tag, and every sheet by name. */
export function organiseIndex(listing: OrganiseListing): string {
  const own =
    listing.categories.length === 0
      ? ''
      : `Project categories: ${listing.categories.map((c) => `${c.id} (${c.name})`).join(', ')}\n\n`
  const tags = listing.tags.map(tagLine)
  const sheets = listing.sheets.map(sheetIndexLine)
  const half = Math.floor(ORGANISE_INDEX_CHARS / 2)
  return (
    `${own}Tags:\n${capped(tags, half, 'tags')}\n\n` +
    `Sheets:\n${capped(sheets, ORGANISE_INDEX_CHARS - half, 'sheets')}`
  )
}

/**
 * The listing in chunks of at most `ORGANISE_CHUNK_CHARS`: the sheets in detail, the notes, and
 * the outline, as the scopes ask; at most `ORGANISE_MAX_CHUNKS`, the last one saying how much
 * was left off. Always at least one chunk (empty when only tags are asked about).
 */
export function organiseChunks(
  listing: OrganiseListing,
  scopes: readonly OrganiseScope[]
): string[] {
  const sections: { title: string; lines: string[] }[] = []
  if (scopes.includes('sheets') && listing.sheets.length > 0) {
    sections.push({ title: 'Sheets in detail:', lines: listing.sheets.map(sheetDetailLine) })
  }
  if (scopes.includes('notes') && listing.notes.length > 0) {
    sections.push({ title: 'Notes:', lines: listing.notes.map(noteLine) })
  }
  if (scopes.includes('binder') && listing.outline.length > 0) {
    sections.push({ title: 'Outline:', lines: listing.outline.map(outlineLine) })
  }
  const chunks: string[] = []
  let current = ''
  let left = 0
  for (const section of sections) {
    let first = true
    for (const line of section.lines) {
      const piece = first ? `${section.title}\n${line}` : line
      const sep = current === '' ? '' : first ? '\n\n' : '\n'
      if (current !== '' && current.length + sep.length + piece.length > ORGANISE_CHUNK_CHARS) {
        if (chunks.length + 1 >= ORGANISE_MAX_CHUNKS) {
          left += 1
          continue
        }
        chunks.push(current)
        // A section that runs on into the next chunk names itself again.
        current = `${section.title}\n${line}`
        first = false
        continue
      }
      current += sep + piece
      first = false
    }
  }
  if (current !== '') chunks.push(current)
  if (left > 0 && chunks.length > 0) {
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1] ?? ''}\n(${left} more lines not shown)`
  }
  return chunks.length > 0 ? chunks : ['']
}

export interface BuildOrganisePromptInput {
  /** `organiseIndex(listing)`, the same for every request of a run. */
  index: string
  /** One of `organiseChunks(listing, scopes)`. */
  chunk: string
  part: number
  parts: number
  scopes: readonly OrganiseScope[]
  instruction: string
  /** The local findings in refs, sent with the first part only; '' for none. */
  findings: string
  retry?: boolean
}

export interface BuiltOrganisePrompt {
  version: typeof ORGANISE_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildOrganisePrompt(input: BuildOrganisePromptInput): BuiltOrganisePrompt {
  const scope = input.scopes.map((s) => ORGANISE_SCOPE_LABEL[s].toLowerCase()).join(', ')
  const lines = [`Organise: ${scope}.`]
  const instruction = input.instruction.trim()
  lines.push(
    instruction === ''
      ? 'No instruction: do what clearly helps.'
      : `The author asks: ${instruction}`
  )
  if (input.parts > 1) {
    lines.push(
      input.part === 1
        ? `Part 1 of ${input.parts}; the tags are yours in this part.`
        : `Part ${input.part} of ${input.parts}; the tags were done in part 1, change only what this part lists.`
    )
  }
  if (input.part === 1 && input.findings !== '') lines.push(input.findings)
  if (input.chunk !== '') lines.push(input.chunk)
  const messages: AiMessage[] = [
    { role: 'system', content: ORGANISE_RULES },
    { role: 'user', content: input.index },
    { role: 'user', content: lines.join('\n\n') }
  ]
  if (input.retry === true) messages.push({ role: 'user', content: ORGANISE_RETRY_TURN })
  return {
    version: ORGANISE_PROMPT_VERSION,
    messages,
    maxTokens: input.retry === true ? ORGANISE_RETRY_MAX_TOKENS : ORGANISE_MAX_TOKENS
  }
}
