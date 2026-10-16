import { SCRIBE_WHOLE_BOOK_TOKENS, scribeAccess, type ScribeAccess } from '@shared/scribe2'
import type { AssistantMode } from '@shared/aiSettings'
import { buildScribeContext, type ScribePage, type ScribeScene } from '../../scribe2/context'
import { fitScribePrompt } from '../../scribe2/run'
import { buildScribePrompt, scribeRules, type BuildScribePromptInput } from '../prompts/scribe.v1'
import { buildScribePromptV2, scribeRulesV2 } from '../prompts/scribe.v2'
import { buildScribePromptV3, scribeModeLineV3, SCRIBE_V3_RULES } from '../prompts/scribe.v3'
import type { AgentLoopPrompt } from '../agent'
import type { AgentTranscriptStep } from '../prompts/agent.v1'
import type { EvalCase } from './fixtures'
import { estimateTokens } from '@shared/ai'

/**
 * `scribe.v1`, `scribe.v2` and `scribe.v3` cases (notes redesign, story memory v1), the same four
 * for each: Ms Scribe's first step with the notes and the whole fixture book in view (a lookup or
 * an answer), a note edit in Write, a Brainstorm answer, and the most one step can carry under the
 * whole-book line. v2 asks for sources with quotes and refs written as chapters. v3 (2026-10-15)
 * says the mode in the moment and adds two: "make this scene better" after reading the scene, in
 * Vibe (her next step proposes a prose change unasked) and in Write (she answers, no proposal).
 */

type ScribeVersion = 'scribe.v1' | 'scribe.v2' | 'scribe.v3'

/** Each version's rules as one message in `mode` carries them, for the whole-book estimate. */
const RULES: Record<ScribeVersion, (mode: AssistantMode, access: ScribeAccess) => string> = {
  'scribe.v1': scribeRules,
  'scribe.v2': scribeRulesV2,
  'scribe.v3': (mode, access) => `${SCRIBE_V3_RULES}\n${scribeModeLineV3(mode, access)}`
}

const BUILD: Record<ScribeVersion, (input: BuildScribePromptInput) => AgentLoopPrompt> = {
  'scribe.v1': buildScribePrompt,
  'scribe.v2': buildScribePromptV2,
  'scribe.v3': buildScribePromptV3
}

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
  version: ScribeVersion,
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
    rulesTokens: estimateTokens(RULES[version](mode, access)),
    pages: PAGES,
    scenes: book,
    currentId: book[0]?.nodeId ?? null,
    selection: '',
    question: message,
    wholeBook: false,
    searchHits: [],
    names: ['Mara', 'Tomas', 'Outline']
  })
  const built = fitScribePrompt(
    { mode, access, context, history: [], message, steps, final: false },
    BUILD[version]
  )
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

function versionCases(version: ScribeVersion): EvalCase[] {
  return [
    scribeCase(
      version,
      'question',
      'Write, the whole six-scene fixture book and three pages in view: where Mara last saw Rook',
      'write',
      'When did Mara last see Rook, and why was he there?',
      scenes(6, 400),
      'answer'
    ),
    scribeCase(
      version,
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
      version,
      'brainstorm',
      'Brainstorm: two next beats from the outline and the flow so far, no write tools',
      'brainstorm',
      'I’m stuck, what should go next?',
      scenes(6, 400),
      'answer'
    ),
    scribeCase(
      version,
      'maxed',
      'Write, a book just under the 60,000-token whole-book line: the most one first step carries',
      'write',
      'Is what Tomas says here in line with his character?',
      nearLine(),
      'answer'
    )
  ]
}

/** v3's two mode cases: the same ask after reading the open scene, in Vibe and in Write. */
function modeCases(): EvalCase[] {
  const book = scenes(6, 400)
  const first = book[0]
  if (first === undefined) return []
  const opened: AgentTranscriptStep[] = [
    {
      call: `{"tool":"open_scene","args":{"id":"${first.ref}"}}`,
      result: `Result of open_scene:\n${first.ref} ${first.title}, characters 0–${first.text.length} of ${first.text.length}:\n${first.text}`
    }
  ]
  const message = 'What can I do to make this scene better?'
  return [
    scribeCase(
      'scribe.v3',
      'vibeProposes',
      'Vibe: "make this scene better" after reading it, so the next step is propose_prose_edit, unasked (at most three)',
      'vibe',
      message,
      book,
      'tool',
      opened
    ),
    scribeCase(
      'scribe.v3',
      'writeAnswers',
      'Write: the same ask after reading the scene, answered with options in text and no unasked propose_prose_edit',
      'write',
      message,
      book,
      'answer',
      opened
    )
  ]
}

export function scribe2EvalCases(): EvalCase[] {
  return [
    ...versionCases('scribe.v1'),
    ...versionCases('scribe.v2'),
    ...versionCases('scribe.v3'),
    ...modeCases()
  ]
}
