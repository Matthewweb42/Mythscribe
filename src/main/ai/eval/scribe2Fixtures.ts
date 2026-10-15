import { SCRIBE_WHOLE_BOOK_TOKENS, scribeAccess } from '@shared/scribe2'
import type { AssistantMode } from '@shared/aiSettings'
import { buildScribeContext, type ScribePage, type ScribeScene } from '../../scribe2/context'
import { fitScribePrompt } from '../../scribe2/run'
import { scribeRules } from '../prompts/scribe.v1'
import type { AgentTranscriptStep } from '../prompts/agent.v1'
import type { EvalCase } from './fixtures'
import { estimateTokens } from '@shared/ai'

/**
 * `scribe.v1` cases (notes redesign phase 1, story memory v1): Ms Scribe's first step with the
 * notes and the whole fixture book in view (a lookup or an answer), a note edit in Write, a
 * Brainstorm answer, and the most one step can carry under the whole-book line.
 */

const PASSAGE = [
  'The ferry landing smelled of tar. Mara waited with the ledger under her coat.',
  'Tomas came down the bank at dusk, hat in hand, and asked for the ledger back.',
  'She told him her brother had only copied it, and watched his face for the lie.'
].join('\n\n')

function scenes(count: number, words: number): ScribeScene[] {
  const body = (n: number): string =>
    `${PASSAGE}\n\n${'Rain on the river. '.repeat(Math.max(0, Math.floor((words - 45) / 4)))}`.trim() +
    (n === 2 ? '\n\nRook watched from the mill.' : '')
  return Array.from({ length: count }, (_, i) => ({
    ref: `n${i + 3}`,
    nodeId: `sc-${i + 1}`,
    title: `Chapter ${Math.floor(i / 3) + 1} › Scene ${i + 1}`,
    synopsis: i === 0 ? 'Mara confronts Tomas over the mill ledger.' : '',
    notes: i === 0 ? 'Ends with the reveal about the elm.' : '',
    summary: i === 1 ? 'Tomas follows Mara to the mill.' : '',
    text: body(i + 1)
  }))
}

const PAGES: ScribePage[] = [
  {
    ref: 'p1',
    id: 'pg-mara',
    kind: 'note',
    title: 'Mara',
    folder: 'Characters',
    text: 'Eyes: grey. Fears the sea since her father drowned. Wants the mill back.'
  },
  {
    ref: 'p2',
    id: 'pg-outline',
    kind: 'note',
    title: 'Outline',
    folder: '',
    text: 'Act 1: the ledger. Act 2: the flood. Act 3: the elm and the confession.'
  },
  {
    ref: 'p3',
    id: 'e-tomas',
    kind: 'sheet',
    title: 'Tomas',
    folder: '',
    text: 'Kind: Characters\nRole: miller\nSecret: burned the first ledger'
  }
]

function scribeCase(
  name: string,
  note: string,
  mode: AssistantMode,
  message: string,
  book: ScribeScene[],
  expected: 'tool' | 'answer',
  steps: AgentTranscriptStep[] = []
): EvalCase {
  const access = scribeAccess(mode, message)
  const context = buildScribeContext({
    rulesTokens: estimateTokens(scribeRules(mode, access)),
    pages: PAGES,
    scenes: book,
    currentId: book[0]?.nodeId ?? null,
    selection: '',
    question: message,
    wholeBook: false,
    searchHits: [],
    names: ['Mara', 'Tomas', 'Outline']
  })
  const built = fitScribePrompt({
    mode,
    access,
    context,
    history: [],
    message,
    steps,
    final: false
  })
  return {
    version: built.version,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'agent', expected }
  }
}

/** Scenes of about 1,000 words whose whole request sits just under the whole-book line. */
function nearLine(): ScribeScene[] {
  const perScene = 1_000
  const count = Math.floor((SCRIBE_WHOLE_BOOK_TOKENS * 0.97) / (perScene * 1.35))
  return scenes(count, perScene)
}

export function scribe2EvalCases(): EvalCase[] {
  return [
    scribeCase(
      'question',
      'Write, the whole six-scene fixture book and three pages in view: where Mara last saw Rook',
      'write',
      'When did Mara last see Rook, and why was he there?',
      scenes(6, 400),
      'answer'
    ),
    scribeCase(
      'noteEdit',
      'Write: "put that in Mara’s page" after one open_note, so the next step is edit_note',
      'write',
      'Put that Mara saw Rook at the mill in her page.',
      scenes(6, 400),
      'tool',
      [
        {
          call: '{"tool":"open_note","args":{"id":"p1"}}',
          result:
            'Result of open_note:\np1 Mara:\nEyes: grey. Fears the sea since her father drowned. Wants the mill back.'
        }
      ]
    ),
    scribeCase(
      'brainstorm',
      'Brainstorm: two next beats from the outline and the flow so far, no write tools',
      'brainstorm',
      'I’m stuck, what should go next?',
      scenes(6, 400),
      'answer'
    ),
    scribeCase(
      'maxed',
      'Write, a book just under the 60,000-token whole-book line: the most one first step carries',
      'write',
      'Is what Tomas says here in line with his character?',
      nearLine(),
      'answer'
    )
  ]
}
