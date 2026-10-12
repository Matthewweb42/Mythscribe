import { estimateTokens } from '../ai'
import { STORY_BIBLE_VALUE_MAX } from '../storyBible'
import { labelSteerParts, type Label } from '../storyLabels'
import type { TiptapNodeT } from '../tiptap'
import { markedParagraphs } from './pageMarks'

/**
 * The Story notes block (F-16.14, P1 slice 5; story memory v2): what every prose prompt of a v2
 * project carries in the bible's slot, and exactly what the This scene panel shows under "What the
 * AI is told". The manuscript is canon (answer 1), so the heading tells the model to follow the
 * passage where the two disagree. Lines, in order: `Here:` (the POV first, marked, then *+ also
 * here*), `Named:` (the records the scene names for certain that are not here, most named first),
 * one line per record that has Pinned canon text (the Here records first), then the scene's tone,
 * content and theme labels (`labelSteerParts`; custom labels never). Never Ideas, never a Not
 * canon paragraph (the switch-over's "Filed by AI earlier" block included), never an absence: a
 * scene with no POV has no POV line, nobody named means no Named line. P2a adds live values and
 * the card's mood. `renderStoryNotes` is pure; `src/main/memory/storyNotes.ts` gathers the facts.
 */

/**
 * The opening line. The e2e and the golden tests recognise the block by it, so it must not change
 * within a prompt version.
 */
export const STORY_NOTES_HEADING =
  'Story notes (the manuscript wins: where the passage and these notes disagree, follow the passage):'

/**
 * The opening line of the block a continuity pass checks the passage against (`editPass.v3`):
 * there a disagreement is what the pass reports, so the heading names the notes as the reference
 * and leaves the verdict to the author (the task says the note may be the side to update).
 */
export const STORY_NOTES_CONTINUITY_HEADING =
  "Story notes (the author's notes the passage is checked against):"

/** Most other names a record's line lists in its brackets. */
export const STORY_NOTES_ALIASES_MAX = 5

/**
 * One record as the block reads it: its names and its two pages. Ideas is in the shape because a
 * record carries it; the block never reads it (answer 3: ideas are never treated as real).
 */
export interface StoryNotesRecord {
  id: string
  name: string
  /** Every other name, in the sheet's order. */
  aliases: readonly string[]
  pinned: TiptapNodeT | null
  ideas: TiptapNodeT | null
}

export interface StoryNotesFacts {
  /** The scene's POV record, or null. */
  pov: StoryNotesRecord | null
  /** *+ also here*, in the author's order. */
  alsoHere: readonly StoryNotesRecord[]
  /** The records the scene names for certain, most named first (then first named first). */
  named: readonly StoryNotesRecord[]
  /** The scene's labels, in label order. */
  labels: readonly Pick<Label, 'name' | 'kind'>[]
}

/** A value on one line and within `STORY_BIBLE_VALUE_MAX` characters, closed as a sentence. */
function noteSentence(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  const cut =
    flat.length <= STORY_BIBLE_VALUE_MAX
      ? flat
      : `${flat.slice(0, STORY_BIBLE_VALUE_MAX).trimEnd()}…`
  return /[.!?…]["”’)\]]*$/u.test(cut) ? cut : `${cut}.`
}

/** The record's Pinned canon paragraphs as sentences; a Not canon paragraph is never one. */
export function pinnedCanonLines(record: Pick<StoryNotesRecord, 'pinned'>): string[] {
  if (record.pinned === null) return []
  return markedParagraphs(record.pinned)
    .filter((paragraph) => !paragraph.notCanon && paragraph.text.trim() !== '')
    .map((paragraph) => noteSentence(paragraph.text))
}

/** "Mara Vell (Mara, the Captain)", the brackets only when it has other names. */
function nameWithAliases(record: StoryNotesRecord): string {
  const others = record.aliases.filter((alias) => alias.trim() !== '' && alias !== record.name)
  if (others.length === 0) return record.name
  const shown = others.slice(0, STORY_NOTES_ALIASES_MAX)
  const more = others.length - shown.length
  return `${record.name} (${shown.join(', ')}${more > 0 ? ', …' : ''})`
}

/** `prefix a, b, c`, or as many names as fit in `room` tokens with "… and N more"; null when none fit. */
function fitList(prefix: string, names: readonly string[], room: number): string | null {
  const whole = `${prefix} ${names.join(', ')}`
  if (estimateTokens(`${whole}\n`) <= room) return whole
  for (let keep = names.length - 1; keep >= 1; keep -= 1) {
    const cut = `${prefix} ${names.slice(0, keep).join(', ')} … and ${names.length - keep} more`
    if (estimateTokens(`${cut}\n`) <= room) return cut
  }
  return null
}

/** Records in order with each id once. */
function unique(records: readonly StoryNotesRecord[]): StoryNotesRecord[] {
  const seen = new Set<string>()
  return records.filter((record) => {
    if (seen.has(record.id)) return false
    seen.add(record.id)
    return true
  })
}

/** `prefix` and as much of `text` as fits in `room` tokens, cut at a word with "…"; null when none does. */
function cutToFit(prefix: string, text: string, room: number): string | null {
  const whole = `${prefix}${text}`
  if (estimateTokens(`${whole}\n`) <= room) return whole
  let low = 0
  let high = text.length
  let best: string | null = null
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const head = text.slice(0, mid)
    const at = head.lastIndexOf(' ')
    const cut = `${prefix}${(at > 0 ? head.slice(0, at) : head).trimEnd()}…`
    if (estimateTokens(`${cut}\n`) <= room) {
      if (mid > 0) best = cut
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

export interface StoryNotesOptions {
  /**
   * The continuity pass's block (`editPass.v3`): `STORY_NOTES_CONTINUITY_HEADING`, no label lines
   * (tone and content are not facts to check against), and null when no record has a Pinned line.
   */
  continuity?: boolean
}

/**
 * Renders the block within `maxTokens` estimated tokens (`STORY_BIBLE_TOKEN_BUDGET`, or
 * `STORY_BIBLE_GHOST_TOKEN_BUDGET` for ghost text), or null when it would say nothing (nobody here
 * or named, and no steering label). The heading, Here, Named and label lines are kept (a list that
 * would not fit is cut to "… and N more"). The record lines are trimmed by priority (CLAUDE.md,
 * token efficiency rule 8): each Here record's first Pinned paragraph is admitted first (the POV,
 * then *also here*; one that does not fit whole is cut at a word, and then no Named line is
 * admitted), then the rest of their paragraphs while they fit, then the Named records' lines in
 * what room is left, most named first, each with as many paragraphs as fit. The first Named record
 * that does not fit ends the Named lines, so a less named record never keeps a line a more named
 * one lost.
 */
export function renderStoryNotes(
  facts: StoryNotesFacts,
  maxTokens: number,
  options: StoryNotesOptions = {}
): string | null {
  const continuity = options.continuity === true
  const here = unique([...(facts.pov === null ? [] : [facts.pov]), ...facts.alsoHere])
  const hereIds = new Set(here.map((record) => record.id))
  const named = unique(facts.named).filter((record) => !hereIds.has(record.id))
  const steer = continuity ? [] : labelSteerParts(facts.labels)
  if (here.length === 0 && named.length === 0 && steer.length === 0) return null

  const heading = continuity ? STORY_NOTES_CONTINUITY_HEADING : STORY_NOTES_HEADING
  let used = estimateTokens(heading)
  const keep = (line: string | null): string | null => {
    if (line !== null) used += estimateTokens(`${line}\n`)
    return line
  }
  const hereNames = here.map((record, index) =>
    index === 0 && facts.pov !== null ? `${record.name} (POV)` : record.name
  )
  const hereLine = here.length === 0 ? null : keep(fitList('Here:', hereNames, maxTokens - used))
  const labelLines = steer.flatMap(({ heading: prefix, names }) => {
    const line = keep(fitList(prefix, names, maxTokens - used))
    return line === null ? [] : [line]
  })
  const namedLine =
    named.length === 0
      ? null
      : keep(
          fitList(
            'Named:',
            named.map((record) => record.name),
            maxTokens - used
          )
        )

  /** Each record's line as admitted so far, by id. */
  const lines = new Map<string, string>()
  const lineOf = (record: StoryNotesRecord, paragraphs: readonly string[]): string =>
    `${nameWithAliases(record)}: ${paragraphs.join(' ')}`
  const cost = (line: string): number => estimateTokens(`${line}\n`)
  const hereParagraphs = here.map((record) => ({ record, paragraphs: pinnedCanonLines(record) }))
  // The Here records' first paragraphs, cut to fit when they must.
  const whole = new Set<string>()
  /** A Here record's first paragraph was cut or left out: no Named line may take room then. */
  let squeezed = false
  for (const { record, paragraphs } of hereParagraphs) {
    const first = paragraphs[0]
    if (first === undefined) continue
    const full = lineOf(record, [first])
    const line =
      cost(full) <= maxTokens - used
        ? full
        : cutToFit(`${nameWithAliases(record)}: `, first, maxTokens - used)
    if (line === null) {
      squeezed = true
      continue
    }
    if (line === full) whole.add(record.id)
    else squeezed = true
    lines.set(record.id, line)
    used += cost(line)
  }
  // The rest of their paragraphs, in order, while they fit.
  for (const { record, paragraphs } of hereParagraphs) {
    const current = lines.get(record.id)
    if (!whole.has(record.id) || current === undefined) continue
    let count = 1
    let line = current
    while (count < paragraphs.length) {
      const longer = lineOf(record, paragraphs.slice(0, count + 1))
      if (cost(longer) - cost(line) > maxTokens - used) break
      used += cost(longer) - cost(line)
      line = longer
      count += 1
    }
    lines.set(record.id, line)
  }
  // The Named records' lines, most named first; the first that does not fit ends them.
  for (const record of squeezed ? [] : named) {
    const paragraphs = pinnedCanonLines(record)
    if (paragraphs.length === 0) continue
    let line: string | null = null
    for (let count = paragraphs.length; count >= 1; count -= 1) {
      const candidate = lineOf(record, paragraphs.slice(0, count))
      if (cost(candidate) <= maxTokens - used) {
        line = candidate
        break
      }
    }
    if (line === null) break
    lines.set(record.id, line)
    used += cost(line)
  }
  const recordLines = [...here, ...named].flatMap((record) => {
    const line = lines.get(record.id)
    return line === undefined ? [] : [line]
  })
  if (continuity && recordLines.length === 0) return null

  return [heading, hereLine, namedLine, ...recordLines, ...labelLines]
    .filter((line): line is string => line !== null)
    .join('\n')
}
