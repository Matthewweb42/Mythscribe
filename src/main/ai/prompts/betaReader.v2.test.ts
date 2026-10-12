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
import { CARD_GIST_MAX_WORDS } from '@shared/memory/claims'
import { BETA_READER_HONESTY, BETA_READER_RULES } from './betaReader.v1'
import {
  BETA_READER_MAP_HEADING,
  BETA_READER_RULES_V2,
  buildBetaReaderPromptV2,
  type BuildBetaReaderPromptV2Input
} from './betaReader.v2'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'

const read: BuildBetaReaderPromptV2Input = {
  scenes: [
    {
      title: 'Chapter 1 › Opening',
      gist: 'Mara finds the ledger her brother copied and hides it under the floor.'
    },
    { title: 'Chapter 1 › The mill', gist: 'Tomas refuses to cross the river while it is up.' }
  ],
  current: { title: 'Chapter 2 › The ferry landing', text: SCENE },
  honesty: 'direct'
}

describe('betaReader.v2 prompt (F-16.20, decision P2a-D14)', () => {
  it('opens as version 1 does (the smoke e2e keys on it) and asks for current-scene quotes only', () => {
    const v1Opening = 'You are the beta-reader feature inside a novel-writing app.'
    expect(BETA_READER_RULES.startsWith(v1Opening)).toBe(true)
    expect(BETA_READER_RULES_V2.startsWith(v1Opening)).toBe(true)
    expect(BETA_READER_RULES_V2).toContain(`at most ${BETA_READER_MAX_ITEMS} items`)
    expect(BETA_READER_RULES_V2).toContain(BETA_READER_CATEGORIES.join(', '))
    expect(BETA_READER_RULES_V2).toContain(`at most ${BETA_READER_QUOTE_MAX} characters`)
    expect(BETA_READER_RULES_V2).toContain('never quote the map')
    expect(BETA_READER_RULES_V2).toContain('"ref"')
  })

  it('pins the map heading the e2e checks a v2 request by', () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/memory.spec.ts'), 'utf8')
    const match = /const BETA_READER_MAP_HEADING =\s*'([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/memory.spec.ts no longer declares BETA_READER_MAP_HEADING')
    expect(BETA_READER_MAP_HEADING.startsWith(match[1]!)).toBe(true)
  })

  it('sends the earlier scenes as a numbered map and the scene last, in full', () => {
    const built = buildBetaReaderPromptV2(read)
    expect(built.version).toBe('betaReader.v2')
    expect(built.messages[0]?.content).toBe(`${BETA_READER_RULES_V2} ${BETA_READER_HONESTY.direct}`)
    expect(built.messages[1]?.content).toBe(
      `${BETA_READER_MAP_HEADING}\n` +
        '[1] Chapter 1 › Opening: Mara finds the ledger her brother copied and hides it under the floor.\n' +
        '[2] Chapter 1 › The mill: Tomas refuses to cross the river while it is up.\n\n' +
        'This scene, Chapter 2 › The ferry landing (full text, the only text you may quote):\n' +
        `"""\n${SCENE}\n"""\n\nReport as the reader.`
    )
    for (const honesty of HONESTY_LEVELS) {
      expect(buildBetaReaderPromptV2({ ...read, honesty }).messages[0]?.content).toBe(
        `${BETA_READER_RULES_V2} ${BETA_READER_HONESTY[honesty]}`
      )
    }
    expect(built.maxTokens).toBe(outputBudget('betaReader'))
    expect(
      buildBetaReaderPromptV2({ ...read, scenes: [] }).messages[1]?.content.startsWith(
        'No earlier scenes.'
      )
    ).toBe(true)
  })

  it('stays under the input budget with the scene and 20 gists at their caps', () => {
    const maxed = buildBetaReaderPromptV2({
      scenes: Array.from({ length: 20 }, (_, index) => ({
        title: `${'C'.repeat(40)} › ${'S'.repeat(40)} ${index}`,
        gist: Array.from({ length: CARD_GIST_MAX_WORDS }, () => 'wordy').join(' ')
      })),
      current: { title: 'T'.repeat(90), text: 'x'.repeat(BETA_READER_SCENE_CHAR_BUDGET) },
      honesty: 'brutal'
    })
    expect(estimateTokens(maxed.messages.map((m) => m.content).join('\n'))).toBeLessThanOrEqual(
      inputBudget('betaReader')
    )
  })
})
