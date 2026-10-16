import type { NotebookItem } from '@shared/notebook'
import { notesListing, sortParts } from '../../notebook/notesSort'
import { buildNotesSortPrompt } from '../prompts/notesSort.v1'
import type { EvalCase } from './fixtures'

/**
 * `notesSort.v1` cases (notes structure part B, 2026-10-16): a worldbuilding document dropped into
 * a Notes that already has Characters and Places folders, sorted into pages there and in a new
 * folder; a document dropped into empty Notes; and the second part of a long document. Each is
 * scored live by the feature's own parser: every page's lines copied from the part, the expected
 * pages made.
 */

const item = (
  id: string,
  kind: NotebookItem['kind'],
  title: string,
  parentId: string | null
): NotebookItem => ({
  id,
  parentId,
  kind,
  title,
  position: 0,
  modified: '2026-10-16T00:00:00.000Z'
})

const NOTES: NotebookItem[] = [
  item('f-chars', 'folder', 'Characters', null),
  item('f-places', 'folder', 'Places', null),
  item('p-mara', 'page', 'Mara', 'f-chars'),
  item('p-quay', 'page', 'The quay', 'f-places'),
  item('p-style', 'page', 'Style guide', null)
]

const WORLD = [
  '# The Fenlands',
  'A drowned country of reed and peat, where the roads move with the tide.',
  '## Mara',
  'Ferry keeper at the north landing. Grey eyes. Fears the sea since her father drowned.',
  '## Rook',
  'A smuggler who never gives his real name. Burned the first ledger the winter the river froze.',
  '## Saltmarket',
  'The only town on dry ground. Its bell rings twice for a flood and once for a death.',
  '## Shadow walking',
  'A fen-witch can step through any shadow longer than she is tall. Each walk costs her a memory, and she never knows which.'
].join('\n\n')

const COUNCIL = [
  'Notes from the planning call.',
  'The Tide Council rules the Fenlands from Saltmarket: five seats, one empty since the flood.',
  'Councillor Vey holds the ferry licences and wants Mara’s landing closed.',
  'Idea: the empty seat belonged to Rook’s mother.'
].join('\n\n')

const LONG_TAIL = Array.from(
  { length: 80 },
  (_, i) =>
    `Entry ${i + 1}. The reed-cutters of the eastern fen keep a tally stick for every tide they ` +
    'work, notched once for a calm night and twice for a storm, and burn the sticks at midsummer.'
)
  .concat([
    '## Bell lore',
    'Saltmarket’s bell was cast from the hull nails of the first ferry. Nobody may ring it a third time.'
  ])
  .join('\n\n')

function sortCase(
  name: string,
  note: string,
  notes: readonly NotebookItem[],
  title: string,
  text: string,
  partIndex: number,
  expected: string[]
): EvalCase {
  const parts = sortParts(text)
  const part = parts[partIndex] ?? ''
  const built = buildNotesSortPrompt({
    listing: notesListing(notes),
    title,
    part: { index: partIndex, count: parts.length },
    text: part
  })
  return {
    version: built.version,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'notesSort', part, expected }
  }
}

export function notesSortEvalCases(): EvalCase[] {
  return [
    sortCase(
      'worldDoc',
      'A worldbuilding doc into Notes with Characters and Places: Mara appended to, Rook and Saltmarket placed, Shadow walking in a new folder',
      NOTES,
      'Fenlands worldbuilding',
      WORLD,
      0,
      ['Mara', 'Rook', 'Saltmarket', 'Shadow walking']
    ),
    sortCase(
      'emptyNotes',
      'Planning notes into empty Notes: the Tide Council and Councillor Vey, the idea line left or placed',
      [],
      'Planning call',
      COUNCIL,
      0,
      ['Tide Council']
    ),
    sortCase(
      'secondPart',
      'The last part of a long doc: the bell lore under its heading',
      NOTES,
      'Fen almanac',
      LONG_TAIL,
      Math.max(0, sortParts(LONG_TAIL).length - 1),
      ['Bell lore']
    )
  ]
}
