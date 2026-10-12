import { NOT_CANON_ATTR } from '@shared/memory/pageMarks'
import {
  renderStoryNotes,
  type StoryNotesFacts,
  type StoryNotesRecord
} from '@shared/memory/storyNotes'
import { STORY_BIBLE_GHOST_TOKEN_BUDGET, STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import { LABEL_NAME_MAX } from '@shared/storyLabels'
import type { TiptapNodeT } from '@shared/tiptap'

/**
 * The Story notes facts the v2 prompt versions are measured and pinned with (F-16.14): the eval
 * cases (`fixtures.ts`) and the golden tests share them. Every record carries an Ideas page and
 * the fixture holds Not canon paragraphs (the switch-over's "Filed by AI earlier" block among
 * them), so a case can assert that neither ever reaches a prompt.
 */

/** Text on an Ideas page: never sent (answer 3). */
export const STORY_NOTES_IDEA_TEXT = 'IDEA-ONLY: Mara could be the drowned bell-ringer'
/** A Not canon paragraph on a Pinned page: never sent (F-16.6). */
export const STORY_NOTES_NOT_CANON_TEXT = 'NOT-CANON: Tomas sold the map to the Falsires'

const paragraph = (text: string, notCanon = false): TiptapNodeT => ({
  type: 'paragraph',
  ...(notCanon ? { attrs: { [NOT_CANON_ATTR]: true } } : {}),
  content: [{ type: 'text', text }]
})
const page = (...blocks: TiptapNodeT[]): TiptapNodeT => ({ type: 'doc', content: blocks })
const ideas = page(paragraph(STORY_NOTES_IDEA_TEXT))

const record = (
  id: string,
  name: string,
  aliases: string[],
  pinned: TiptapNodeT | null
): StoryNotesRecord => ({ id, name, aliases, pinned, ideas })

const MARA = record(
  'r-mara',
  'Mara Vell',
  ['Mara', 'the Captain'],
  page(
    paragraph('Eyes: grey'),
    paragraph('Lost her brother Daven to the river at twelve; will not cross water at night.')
  )
)
const TOMAS = record(
  'r-tomas',
  'Tomas Harrow',
  ['Tomas'],
  page(
    paragraph('Ferryman at the landing; owes the mill a debt he hides from Mara.'),
    paragraph('Filed by AI earlier: please check', true),
    paragraph(STORY_NOTES_NOT_CANON_TEXT, true)
  )
)
const ELM = record(
  'r-elm',
  'The Hollow Elm',
  ['the elm'],
  page(paragraph('A split elm on the north bank where the two met as children.'))
)

/** A scene with a POV, one record also here, two named, and a tone, a content and a theme label. */
export const FIXTURE_NOTES_FACTS: StoryNotesFacts = {
  pov: MARA,
  alsoHere: [TOMAS],
  named: [ELM, record('r-wren', 'Wren', [], null)],
  labels: [
    { name: 'tense', kind: 'tone' },
    { name: 'grief', kind: 'content' },
    { name: 'debts come due', kind: 'theme' },
    { name: 'needs research', kind: 'custom' }
  ]
}

const bulky = (index: number): StoryNotesRecord =>
  record(
    `r-bulk-${index}`,
    `Bulky Record ${index}`,
    ['Bulky', 'the Bulk'],
    page(
      ...Array.from({ length: 6 }, (_, i) =>
        paragraph(`Fact ${i} of record ${index}: ${'long detail '.repeat(12)}`)
      ),
      paragraph(STORY_NOTES_NOT_CANON_TEXT, true)
    )
  )

/** Every part of the block over its budget: many records here and named, labels at their cap. */
export const MAXED_NOTES_FACTS: StoryNotesFacts = {
  pov: bulky(0),
  alsoHere: [bulky(1), bulky(2)],
  named: Array.from({ length: 8 }, (_, i) => bulky(i + 3)),
  labels: (['tone', 'content', 'theme'] as const).flatMap((kind) =>
    Array.from({ length: 4 }, (_, i) => ({
      name: `${kind}${i}`.padEnd(LABEL_NAME_MAX, kind.charAt(0)),
      kind
    }))
  )
}

const rendered = (facts: StoryNotesFacts, budget: number, continuity = false): string => {
  const block = renderStoryNotes(facts, budget, { continuity })
  if (block === null) throw new Error('the fixture block must render')
  return block
}

export const FIXTURE_STORY_NOTES = rendered(FIXTURE_NOTES_FACTS, STORY_BIBLE_TOKEN_BUDGET)
export const FIXTURE_GHOST_STORY_NOTES = rendered(
  FIXTURE_NOTES_FACTS,
  STORY_BIBLE_GHOST_TOKEN_BUDGET
)
export const MAXED_STORY_NOTES = rendered(MAXED_NOTES_FACTS, STORY_BIBLE_TOKEN_BUDGET)
export const MAXED_GHOST_STORY_NOTES = rendered(MAXED_NOTES_FACTS, STORY_BIBLE_GHOST_TOKEN_BUDGET)
/** The continuity pass's form of the blocks (`editPass.v3`). */
export const FIXTURE_CONTINUITY_NOTES = rendered(
  FIXTURE_NOTES_FACTS,
  STORY_BIBLE_TOKEN_BUDGET,
  true
)
export const MAXED_CONTINUITY_NOTES = rendered(MAXED_NOTES_FACTS, STORY_BIBLE_TOKEN_BUDGET, true)
export const MAXED_GHOST_CONTINUITY_NOTES = rendered(
  MAXED_NOTES_FACTS,
  STORY_BIBLE_GHOST_TOKEN_BUDGET,
  true
)
