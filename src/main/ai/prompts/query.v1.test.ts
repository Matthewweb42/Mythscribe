import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { QUERY_MAX_CITATIONS, QUERY_QUOTE_MAX, QUERY_SCENE_CHAR_BUDGET } from '@shared/query'
import { SUMMARY_KEY_POINT_MAX, SUMMARY_KEY_POINTS_MAX, SUMMARY_MAX_CHARS } from '@shared/summary'
import { buildQueryPrompt, QUERY_RULES, type BuildQueryPromptInput } from './query.v1'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'
const OTHER = 'Tomas refused to cross while the river was up, and sent her back to the landing.'
const QUESTION = 'What does Tomas want from Mara?'

const one: BuildQueryPromptInput = {
  full: [{ title: 'Chapter 1 › The ferry landing', text: SCENE }],
  summaries: [],
  history: [],
  question: QUESTION
}

const many: BuildQueryPromptInput = {
  full: [
    { title: 'Chapter 1 › The ferry landing', text: SCENE },
    { title: 'Chapter 2 › The mill', text: OTHER }
  ],
  summaries: [
    {
      title: 'Chapter 2 › The north pasture',
      summary: 'Mara buries the ledger under the elm.',
      keyPoints: ['The ledger is a copy.', 'Tomas is owed money.']
    },
    {
      title: 'Chapter 3 › The thaw',
      summary: 'The river falls and the crossing opens.',
      keyPoints: []
    }
  ],
  history: [
    { role: 'user', content: 'Who is Tomas?' },
    { role: 'assistant', content: 'The man the mill owes. [1]' }
  ],
  question: QUESTION
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('query.v1 prompt (F-5.7)', () => {
  it("pins the e2e fake server's QUERY_SENTINEL to this version's opening (the e2e tsconfig cannot import from src/main)", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const QUERY_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares QUERY_SENTINEL')
    expect(QUERY_RULES.startsWith(match[1]!)).toBe(true)
  })

  it('opens with the sentinel the e2e fake server keys on and asks for cited JSON', () => {
    expect(
      QUERY_RULES.startsWith('You are the Story Intelligence feature inside a novel-writing app.')
    ).toBe(true)
    expect(QUERY_RULES).toContain(
      '{"found":true,"answer":"...","citations":[{"scene":1,"quote":"..."}]}'
    )
    expect(QUERY_RULES).toContain(`at most ${QUERY_QUOTE_MAX} characters`)
    expect(QUERY_RULES).toContain(`at most ${QUERY_MAX_CITATIONS} citations`)
    // Grounded answers only (CLAUDE.md, author-control rule 4).
    expect(QUERY_RULES).toContain('using only the scenes below')
    expect(QUERY_RULES).toContain('set "found" to false')
    expect(QUERY_RULES).toContain('summaries only are there to orient you and cannot be cited')
  })

  it('carries neither a voice block nor a story bible: an answer is not prose', () => {
    const text = promptText(buildQueryPrompt(many).messages)
    expect(text).not.toContain("Match the author's voice:")
    expect(text).not.toContain('Story bible')
    expect(text).not.toContain('Scene brief')
  })

  it('numbers the full scenes first and the summarised candidates on after them', () => {
    const built = buildQueryPrompt(many)
    expect(built.version).toBe('query.v1')
    expect(built.messages[0]?.content).toBe(
      `${QUERY_RULES}\n\n` +
        'Scenes (full text):\n' +
        `[1] Chapter 1 › The ferry landing\n"""\n${SCENE}\n"""\n\n` +
        `[2] Chapter 2 › The mill\n"""\n${OTHER}\n"""\n\n` +
        'Other scenes (summaries only):\n' +
        '[3] Chapter 2 › The north pasture\n' +
        'Mara buries the ledger under the elm.\n' +
        '- The ledger is a copy.\n' +
        '- Tomas is owed money.\n\n' +
        '[4] Chapter 3 › The thaw\n' +
        'The river falls and the crossing opens.'
    )
    expect('temperature' in built).toBe(false)
  })

  it('sends the history as real turns with the question last', () => {
    expect(buildQueryPrompt(many).messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user'
    ])
    expect(buildQueryPrompt(many).messages.at(-1)).toEqual({ role: 'user', content: QUESTION })
  })

  it('leaves the summaries block out entirely when nothing was retrieved for it', () => {
    const built = buildQueryPrompt(one)
    expect(built.messages).toHaveLength(2)
    expect(built.messages[0]?.content).toBe(
      `${QUERY_RULES}\n\nScenes (full text):\n[1] Chapter 1 › The ferry landing\n"""\n${SCENE}\n"""`
    )
  })

  it('asks for the feature output budget: a cited answer is only useful whole', () => {
    expect(buildQueryPrompt(one).maxTokens).toBe(outputBudget('query'))
  })

  it('pins the golden token estimates, and the fit keeps the maxed shape under the budget', () => {
    expect(estimateTokens(promptText(buildQueryPrompt(one).messages))).toBe(287)
    expect(estimateTokens(promptText(buildQueryPrompt(many).messages))).toBe(380)
    // The raw worst case is far over the budget on purpose: `fitQueryPrompt` is what keeps a
    // request inside it (the eval fixture's `maxed` case is the fitted shape).
    const maxed: BuildQueryPromptInput = {
      full: Array.from({ length: 3 }, (_, index) => ({
        title: `${'C'.repeat(40)} › ${'S'.repeat(40)} ${index}`,
        text: 'x'.repeat(QUERY_SCENE_CHAR_BUDGET)
      })),
      summaries: Array.from({ length: 10 }, (_, index) => ({
        title: `${'C'.repeat(40)} › ${'S'.repeat(40)} ${index}`,
        summary: 's'.repeat(SUMMARY_MAX_CHARS),
        keyPoints: Array.from({ length: SUMMARY_KEY_POINTS_MAX }, () =>
          'k'.repeat(SUMMARY_KEY_POINT_MAX)
        )
      })),
      history: [],
      question: QUESTION
    }
    expect(estimateTokens(promptText(buildQueryPrompt(maxed).messages))).toBeGreaterThan(
      inputBudget('query')
    )
  })
})
