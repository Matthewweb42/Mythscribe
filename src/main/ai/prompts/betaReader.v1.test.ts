import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import {
  BETA_READER_CATEGORIES,
  BETA_READER_MAX_ITEMS,
  BETA_READER_QUOTE_MAX,
  BETA_READER_SCENE_CHAR_BUDGET
} from '@shared/betaReader'
import { HONESTY_LEVELS } from '@shared/critique'
import { SUMMARY_KEY_POINT_MAX, SUMMARY_KEY_POINTS_MAX, SUMMARY_MAX_CHARS } from '@shared/summary'
import {
  BETA_READER_HONESTY,
  BETA_READER_RULES,
  buildBetaReaderPrompt,
  type BuildBetaReaderPromptInput
} from './betaReader.v1'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'
const DIRECT =
  'Be specific and direct: say plainly what you did not follow, no softening and no flattery.'

const bare: BuildBetaReaderPromptInput = {
  scenes: [],
  current: { title: 'Chapter 1 › Scene 1', text: SCENE },
  honesty: 'direct'
}

const read: BuildBetaReaderPromptInput = {
  ...bare,
  scenes: [
    {
      title: 'Chapter 1 › Opening',
      summary: 'Mara finds the ledger her brother copied and hides it under the floor.',
      keyPoints: ['The ledger is copied.', 'Tomas is owed money.']
    },
    {
      title: 'Chapter 1 › The mill',
      summary: 'Tomas refuses to cross the river while it is up.',
      keyPoints: []
    }
  ],
  current: { title: 'Chapter 2 › The ferry landing', text: SCENE }
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('betaReader.v1 prompt (F-14.11)', () => {
  it("pins the e2e fake server's BETA_READER_SENTINEL to this version's opening (the e2e tsconfig cannot import from src/main)", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const BETA_READER_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares BETA_READER_SENTINEL')
    expect(BETA_READER_RULES.startsWith(match[1]!)).toBe(true)
  })

  it('opens with the sentinel the e2e fake server keys on and asks for cited JSON items', () => {
    expect(
      BETA_READER_RULES.startsWith('You are the beta-reader feature inside a novel-writing app.')
    ).toBe(true)
    expect(BETA_READER_RULES).toContain(`at most ${BETA_READER_MAX_ITEMS} items`)
    expect(BETA_READER_RULES).toContain(BETA_READER_CATEGORIES.join(', '))
    expect(BETA_READER_RULES).toContain(`at most ${BETA_READER_QUOTE_MAX} characters`)
    expect(BETA_READER_RULES).toContain('Reply with JSON only:')
    // A reader reports; the editor's notes (F-14.8) own the fixes.
    expect(BETA_READER_RULES).toContain('no fixes')
  })

  it('carries neither a voice block nor a story bible: the reader knows only what the page said', () => {
    const text = promptText(buildBetaReaderPrompt(read).messages)
    expect(text).not.toContain("Match the author's voice:")
    expect(text).not.toContain('Story bible')
    expect(text).not.toContain('Scene brief')
  })

  it('puts the rules and the honesty line in the system turn, one line per level', () => {
    const built = buildBetaReaderPrompt(bare)
    expect(built.version).toBe('betaReader.v1')
    expect(built.messages[0]?.content).toBe(`${BETA_READER_RULES} ${DIRECT}`)
    for (const honesty of HONESTY_LEVELS) {
      const system = buildBetaReaderPrompt({ ...bare, honesty }).messages[0]?.content ?? ''
      expect(system).toBe(`${BETA_READER_RULES} ${BETA_READER_HONESTY[honesty]}`)
    }
  })

  it('numbers the scenes read so far and sends the current one last, in full', () => {
    const built = buildBetaReaderPrompt(read)
    expect(built.messages[1]?.content).toBe(
      'Scenes read so far, in order (summaries):\n' +
        '[1] Chapter 1 › Opening\n' +
        'Mara finds the ledger her brother copied and hides it under the floor.\n' +
        '- The ledger is copied.\n' +
        '- Tomas is owed money.\n\n' +
        '[2] Chapter 1 › The mill\n' +
        'Tomas refuses to cross the river while it is up.\n\n' +
        `[3] Chapter 2 › The ferry landing (this scene, full text):\n"""\n${SCENE}\n"""\n\n` +
        'Report as the reader.'
    )
    expect('temperature' in built).toBe(false)
  })

  it('says so plainly when the scene is the first one the reader meets', () => {
    expect(buildBetaReaderPrompt(bare).messages[1]?.content).toBe(
      'No earlier scenes.\n\n' +
        `[1] Chapter 1 › Scene 1 (this scene, full text):\n"""\n${SCENE}\n"""\n\n` +
        'Report as the reader.'
    )
  })

  it('asks for the feature output budget: the report is only useful whole', () => {
    expect(buildBetaReaderPrompt(bare).maxTokens).toBe(outputBudget('betaReader'))
  })

  it('stays under the beta-reader input budget with the scene and 20 summaries at every cap', () => {
    const maxed: BuildBetaReaderPromptInput = {
      scenes: Array.from({ length: 20 }, (_, index) => ({
        title: `${'C'.repeat(40)} › ${'S'.repeat(40)} ${index}`,
        summary: 's'.repeat(SUMMARY_MAX_CHARS),
        keyPoints: Array.from({ length: SUMMARY_KEY_POINTS_MAX }, () =>
          'k'.repeat(SUMMARY_KEY_POINT_MAX)
        )
      })),
      current: { title: 'T'.repeat(90), text: 'x'.repeat(BETA_READER_SCENE_CHAR_BUDGET) },
      honesty: 'brutal'
    }
    const estimate = estimateTokens(promptText(buildBetaReaderPrompt(maxed).messages))
    expect(estimate).toBeLessThan(inputBudget('betaReader'))
    // The golden estimates: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(11_599)
    expect(estimateTokens(promptText(buildBetaReaderPrompt(bare).messages))).toBe(294)
    expect(estimateTokens(promptText(buildBetaReaderPrompt(read).messages))).toBe(356)
  })
})
