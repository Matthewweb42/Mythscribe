import { BUILTIN_CATEGORIES } from '@shared/categories'
import {
  ORGANISE_CHUNK_CHARS,
  ORGANISE_INDEX_CHARS,
  ORGANISE_MAX_OPS,
  ORGANISE_SCOPE_LABEL,
  ORGANISE_V2_MAX_CHUNKS,
  ORGANISE_V2_MAX_TOKENS,
  type OrganiseScope
} from '@shared/organise'
import { TAG_CATEGORIES } from '@shared/tags'
import type { AiMessage } from '../providers/types'
import {
  noteLine,
  outlineLine,
  sheetDetailLine,
  sheetIndexLine,
  tagLine,
  type OrganiseListing
} from './organise.v1'

/**
 * The organise prompt (F-9.10), version 2 (2026-10-08, "Organise at scale"): version 1 failed on
 * a large project, where one chunk's plan was cut off twice and the whole run was lost. Version 2
 * is built to be split:
 * - The tags are listed in detail in the chunks like everything else (version 1 listed them only
 *   in the index, which a large tag bank overflowed), and the index names every tag and sheet in
 *   one short line each, so far more of them fit.
 * - A chunk is a list of entries in sections (`OrganiseChunk`), so main can halve one at an entry
 *   boundary when its answer is cut off (`halveOrganiseChunk`) and name what a piece held when it
 *   gives up (`describeOrganiseChunk`).
 * - Every part changes only what it lists, and carries only the local findings about what it
 *   lists (version 1 sent every finding with part 1).
 * - The rules ask for a "why" of at most eight words. There is no retry turn: main halves instead.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules (the same for every request of every
 * project), the index (the same for every request of one run), then the task and the chunk.
 */
export const ORGANISE_PROMPT_V2_VERSION = 'organise.v2'

/**
 * The rules. The opening sentence is version 1's, byte for byte: the e2e's fake OpenAI
 * recognises an organise request by it.
 */
export const ORGANISE_V2_RULES =
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
  'Give each a "why" of at most 8 words. Titles, nicknames, and spellings of one name are ' +
  'aliases, not tags or sheets of their own. Do what the instruction asks; with none, what ' +
  `clearly helps. At most ${ORGANISE_MAX_OPS} operations. Reply with JSON only: ` +
  '{"reply":"one sentence","ops":[…]}.'

/** One listed tag, sheet, note, or outline row: its ref, a name for the author, and its line. */
export interface OrganiseEntry {
  ref: string
  name: string
  line: string
}

export type OrganiseSectionKind = 'tags' | 'sheets' | 'notes' | 'outline'

export interface OrganiseSection {
  kind: OrganiseSectionKind
  entries: readonly OrganiseEntry[]
}

/** One request's share of the listing, in sections; rendered by `renderOrganiseChunk`. */
export type OrganiseChunk = readonly OrganiseSection[]

const SECTION_TITLE: Record<OrganiseSectionKind, string> = {
  tags: 'Tags in detail:',
  sheets: 'Sheets in detail:',
  notes: 'Notes:',
  outline: 'Outline:'
}

/** What a section is called in a note to the author. */
const SECTION_NOUN: Record<OrganiseSectionKind, string> = {
  tags: 'tags',
  sheets: 'sheets',
  notes: 'notes of',
  outline: 'outline rows'
}

/** One local finding (F-9.10's local pass) in the run's refs. */
export interface OrganiseFinding {
  kind: 'duplicate' | 'unusedTag' | 'emptySheet'
  refs: readonly string[]
}

/** Everything a run may list, already in refs; the findings as data, so each part gets its own. */
export interface OrganiseListingV2 extends Omit<OrganiseListing, 'findings'> {
  findings: readonly OrganiseFinding[]
}

/** The index line of a tag: its ref, name, and category. */
export function tagIndexLine(tag: OrganiseListing['tags'][number]): string {
  return `${tag.ref} #${tag.name} · ${tag.category}`
}

/** Lines in order until `max` characters, then a count of what was left off. */
function capped(
  lines: readonly string[],
  max: number,
  noun: string
): { text: string; left: number } {
  let budget = max
  const kept: string[] = []
  for (const line of lines) {
    if (line.length + 1 > budget) break
    budget -= line.length + 1
    kept.push(line)
  }
  const left = lines.length - kept.length
  if (left > 0) kept.push(`(${left} more ${noun} not shown)`)
  return { text: kept.length > 0 ? kept.join('\n') : '(none)', left }
}

export interface OrganiseIndexV2 {
  text: string
  /** Tags and sheets the index had no room for (main names them in the plan's skipped notes). */
  leftOff: { tags: number; sheets: number }
}

/** The index every request carries: the project's categories, then every tag and sheet by name. */
export function organiseIndexV2(listing: OrganiseListingV2): OrganiseIndexV2 {
  const own =
    listing.categories.length === 0
      ? ''
      : `Project categories: ${listing.categories.map((c) => `${c.id} (${c.name})`).join(', ')}\n\n`
  const half = Math.floor(ORGANISE_INDEX_CHARS / 2)
  const tags = capped(listing.tags.map(tagIndexLine), half, 'tags')
  const sheets = capped(listing.sheets.map(sheetIndexLine), ORGANISE_INDEX_CHARS - half, 'sheets')
  return {
    text: `${own}Tags:\n${tags.text}\n\nSheets:\n${sheets.text}`,
    leftOff: { tags: tags.left, sheets: sheets.left }
  }
}

/** The sections the scopes ask for, every entry with its line. */
function sectionsOf(
  listing: OrganiseListingV2,
  scopes: readonly OrganiseScope[]
): OrganiseSection[] {
  const sections: OrganiseSection[] = []
  const add = (kind: OrganiseSectionKind, entries: OrganiseEntry[]): void => {
    if (entries.length > 0) sections.push({ kind, entries })
  }
  if (scopes.includes('tags')) {
    add(
      'tags',
      listing.tags.map((tag) => ({ ref: tag.ref, name: `#${tag.name}`, line: tagLine(tag) }))
    )
  }
  if (scopes.includes('sheets')) {
    add(
      'sheets',
      listing.sheets.map((sheet) => ({
        ref: sheet.ref,
        name: sheet.name,
        line: sheetDetailLine(sheet)
      }))
    )
  }
  if (scopes.includes('notes')) {
    add(
      'notes',
      listing.notes.map((note) => ({ ref: note.ref, name: note.title, line: noteLine(note) }))
    )
  }
  if (scopes.includes('binder')) {
    add(
      'outline',
      listing.outline.map((row) => ({ ref: row.ref, name: row.title, line: outlineLine(row) }))
    )
  }
  return sections
}

/** Adds an entry to the last section when it is of the same kind, else opens a section. */
function appendEntry(
  into: OrganiseSection[],
  kind: OrganiseSectionKind,
  entry: OrganiseEntry
): void {
  const last = into.at(-1)
  if (last?.kind === kind) {
    into[into.length - 1] = { kind, entries: [...last.entries, entry] }
  } else into.push({ kind, entries: [entry] })
}

export interface OrganiseChunksV2 {
  /** At least one chunk (an empty one when nothing is listed). */
  chunks: OrganiseChunk[]
  /** What the chunk cap left out, in sections; empty when everything was chunked. */
  leftOff: OrganiseChunk
}

/**
 * The listing in chunks of at most `ORGANISE_CHUNK_CHARS` (an entry longer than that alone in
 * its chunk), at most `ORGANISE_V2_MAX_CHUNKS`; what is past the cap is returned, never dropped.
 */
export function organiseChunksV2(
  listing: OrganiseListingV2,
  scopes: readonly OrganiseScope[]
): OrganiseChunksV2 {
  const chunks: OrganiseSection[][] = []
  const leftOff: OrganiseSection[] = []
  let current: OrganiseSection[] = []
  let size = 0
  const costIn = (
    into: OrganiseSection[],
    kind: OrganiseSectionKind,
    entry: OrganiseEntry
  ): number =>
    entry.line.length + 1 + (into.at(-1)?.kind === kind ? 0 : SECTION_TITLE[kind].length + 2)
  for (const { kind, entries } of sectionsOf(listing, scopes)) {
    for (const entry of entries) {
      if (chunks.length < ORGANISE_V2_MAX_CHUNKS && current.length > 0) {
        if (size + costIn(current, kind, entry) > ORGANISE_CHUNK_CHARS) {
          chunks.push(current)
          current = []
          size = 0
        }
      }
      if (chunks.length >= ORGANISE_V2_MAX_CHUNKS) {
        appendEntry(leftOff, kind, entry)
        continue
      }
      size += costIn(current, kind, entry)
      appendEntry(current, kind, entry)
    }
  }
  if (current.length > 0) chunks.push(current)
  return { chunks: chunks.length > 0 ? chunks : [[]], leftOff }
}

/** A chunk as the prompt lists it; a section that runs on into the next chunk names itself again. */
export function renderOrganiseChunk(chunk: OrganiseChunk): string {
  return chunk
    .map(
      (section) =>
        `${SECTION_TITLE[section.kind]}\n${section.entries.map((entry) => entry.line).join('\n')}`
    )
    .join('\n\n')
}

/** The chunk split at the entry nearest its middle, or null for a single entry. */
export function halveOrganiseChunk(chunk: OrganiseChunk): [OrganiseChunk, OrganiseChunk] | null {
  const flat = chunk.flatMap((section) =>
    section.entries.map((entry) => ({ kind: section.kind, entry }))
  )
  if (flat.length < 2) return null
  const at = Math.ceil(flat.length / 2)
  const regroup = (items: typeof flat): OrganiseChunk => {
    const sections: OrganiseSection[] = []
    for (const { kind, entry } of items) appendEntry(sections, kind, entry)
    return sections
  }
  return [regroup(flat.slice(0, at)), regroup(flat.slice(at))]
}

/** What a chunk holds, for a note to the author: "sheets Aldo to Fenn (12); notes of The mill". */
export function describeOrganiseChunk(chunk: OrganiseChunk): string {
  return chunk
    .map((section) => {
      const first = section.entries[0]?.name ?? ''
      const last = section.entries.at(-1)?.name ?? ''
      const count = section.entries.length
      const span = count === 1 ? `“${first}”` : `“${first}” to “${last}” (${count})`
      return `${SECTION_NOUN[section.kind]} ${span}`
    })
    .join('; ')
}

/** The refs a chunk lists. */
export function chunkRefs(chunk: OrganiseChunk): Set<string> {
  return new Set(chunk.flatMap((section) => section.entries.map((entry) => entry.ref)))
}

/**
 * The local findings about what a chunk lists, as one line ('' for none): a finding goes with
 * the chunk that lists its first ref, so a pair split across chunks is raised once.
 */
export function findingsFor(findings: readonly OrganiseFinding[], chunk: OrganiseChunk): string {
  const refs = chunkRefs(chunk)
  const mine = findings.filter((finding) => refs.has(finding.refs[0] ?? ''))
  const of = (kind: OrganiseFinding['kind']): OrganiseFinding[] =>
    mine.filter((finding) => finding.kind === kind)
  const parts: string[] = []
  const duplicates = of('duplicate')
  if (duplicates.length > 0) {
    parts.push(`Likely duplicates: ${duplicates.map((d) => d.refs.join(' + ')).join('; ')}.`)
  }
  const unused = of('unusedTag')
  if (unused.length > 0) parts.push(`Unused tags: ${unused.map((f) => f.refs[0]).join(', ')}.`)
  const empty = of('emptySheet')
  if (empty.length > 0) parts.push(`Empty sheets: ${empty.map((f) => f.refs[0]).join(', ')}.`)
  return parts.length === 0 ? '' : `Found locally (check them): ${parts.join(' ')}`
}

export interface BuildOrganisePromptV2Input {
  /** `organiseIndexV2(listing).text`, the same for every request of a run. */
  index: string
  /** One of `organiseChunksV2(listing, scopes).chunks`, or a half of one. */
  chunk: OrganiseChunk
  part: number
  parts: number
  scopes: readonly OrganiseScope[]
  instruction: string
  /** `findingsFor(listing.findings, chunk)`; '' for none. */
  findings: string
}

export interface BuiltOrganisePromptV2 {
  version: typeof ORGANISE_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildOrganisePromptV2(input: BuildOrganisePromptV2Input): BuiltOrganisePromptV2 {
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
      `Part ${input.part} of ${input.parts}: change only what this part lists; the index names the rest.`
    )
  }
  if (input.findings !== '') lines.push(input.findings)
  const chunk = renderOrganiseChunk(input.chunk)
  if (chunk !== '') lines.push(chunk)
  return {
    version: ORGANISE_PROMPT_V2_VERSION,
    messages: [
      { role: 'system', content: ORGANISE_V2_RULES },
      { role: 'user', content: input.index },
      { role: 'user', content: lines.join('\n\n') }
    ],
    maxTokens: ORGANISE_V2_MAX_TOKENS
  }
}
