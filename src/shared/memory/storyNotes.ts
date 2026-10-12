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

/**
 * Renders the block within `maxTokens` estimated tokens (`STORY_BIBLE_TOKEN_BUDGET`, or
 * `STORY_BIBLE_GHOST_TOKEN_BUDGET` for ghost text), or null when it would say nothing (nobody here
 * or named, and no steering label). The heading, Here, Named and label lines are kept (a list that
 * would not fit is cut to "… and N more"); the record lines are admitted in priority order (the
 * POV, the rest of Here, then Named, most named first), each with as many of its Pinned paragraphs
 * as fit, so a short budget trims the least named records' lines first and the Here records' text
 * last (CLAUDE.md, token efficiency rule 8).
 */
export function renderStoryNotes(facts: StoryNotesFacts, maxTokens: number): string | null {
  const here = unique([...(facts.pov === null ? [] : [facts.pov]), ...facts.alsoHere])
  const hereIds = new Set(here.map((record) => record.id))
  const named = unique(facts.named).filter((record) => !hereIds.has(record.id))
  const steer = labelSteerParts(facts.labels)
  if (here.length === 0 && named.length === 0 && steer.length === 0) return null

  let used = estimateTokens(STORY_NOTES_HEADING)
  const keep = (line: string | null): string | null => {
    if (line !== null) used += estimateTokens(`${line}\n`)
    return line
  }
  const hereNames = here.map((record, index) =>
    index === 0 && facts.pov !== null ? `${record.name} (POV)` : record.name
  )
  const hereLine = here.length === 0 ? null : keep(fitList('Here:', hereNames, maxTokens - used))
  const labelLines = steer.flatMap(({ heading, names }) => {
    const line = keep(fitList(heading, names, maxTokens - used))
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

  const recordLines: string[] = []
  for (const record of [...here, ...named]) {
    const paragraphs = pinnedCanonLines(record)
    if (paragraphs.length === 0) continue
    const label = nameWithAliases(record)
    for (let count = paragraphs.length; count >= 1; count -= 1) {
      const line = `${label}: ${paragraphs.slice(0, count).join(' ')}`
      if (estimateTokens(`${line}\n`) > maxTokens - used) continue
      recordLines.push(line)
      used += estimateTokens(`${line}\n`)
      break
    }
  }

  return [STORY_NOTES_HEADING, hereLine, namedLine, ...recordLines, ...labelLines]
    .filter((line): line is string => line !== null)
    .join('\n')
}
