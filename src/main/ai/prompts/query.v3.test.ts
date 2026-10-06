import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import { buildQueryPrompt, QUERY_RULES, type BuildQueryPromptInput } from './query.v1'
import { buildQueryPromptV3, QUERY_BIBLE_HEADING_V3, QUERY_RULES_V3 } from './query.v3'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'
const OTHER = 'Tomas refused to cross while the river was up, and sent her back to the landing.'
const QUESTION = 'What colour are Mara’s eyes?'
const BIBLE =
  'Mara (character): Age: 31; Appearance: Grey eyes, a burn scar on her left hand. Seen in the ' +
  'manuscript: Goals / motivations: cross the river (Chapter 1 › The ferry landing).\n' +
  'Tomas (character): Seen in the manuscript: Relationships: the mill owes him (Chapter 2 › The mill).'

const many: BuildQueryPromptInput = {
  full: [
    { title: 'Chapter 1 › The ferry landing', text: SCENE },
    { title: 'Chapter 2 › The mill', text: OTHER }
  ],
  summaries: [
    {
      title: 'Chapter 2 › The north pasture',
      summary: 'Mara buries the ledger under the elm.',
      keyPoints: ['The ledger is a copy.']
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

describe('query.v3 prompt', () => {
  it("opens with version 1's first sentence, so the e2e fake server's QUERY_SENTINEL still matches", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const QUERY_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares QUERY_SENTINEL')
    for (const bible of [null, BIBLE]) {
      const system = buildQueryPromptV3({ ...many, bible }).messages[0]?.content ?? ''
      expect(system.startsWith(match[1]!)).toBe(true)
      expect(system.startsWith(QUERY_RULES_V3)).toBe(true)
    }
  })

  it('makes the sheets a source named in "sheets", and keeps observed facts and summaries out', () => {
    expect(QUERY_RULES_V3).toContain('"sheets":["Name"]')
    expect(QUERY_RULES_V3).toContain("The author's sheets are true for this story")
    expect(QUERY_RULES_V3).toContain('seen in the manuscript, and the scenes listed as summaries')
    expect(QUERY_RULES_V3).toContain('Where a sheet and a scene disagree, say so.')
  })

  it("is version 1's scenes, history, and question under the v3 rules when there is no bible", () => {
    const built = buildQueryPromptV3({ ...many, bible: null })
    const v1 = buildQueryPrompt(many).messages
    expect(built.version).toBe('query.v3')
    expect(built.messages[0]?.content).toBe(
      QUERY_RULES_V3 + (v1[0]?.content ?? '').slice(QUERY_RULES.length)
    )
    expect(built.messages.slice(1)).toEqual(v1.slice(1))
    expect(built.maxTokens).toBe(outputBudget('query'))
    expect('temperature' in built).toBe(false)
  })

  it('places the story bible between the rules and the scenes', () => {
    const built = buildQueryPromptV3({ ...many, bible: BIBLE })
    expect(built.messages[0]?.content).toContain(
      `${QUERY_RULES_V3}\n\n${QUERY_BIBLE_HEADING_V3}\n${BIBLE}\n\nScenes (full text):\n[1] ` +
        'Chapter 1 › The ferry landing'
    )
    expect(built.messages.at(-1)).toEqual({ role: 'user', content: QUESTION })
    expect(built.messages).toMatchSnapshot()
  })

  it('pins the golden token estimates', () => {
    expect(estimateTokens(promptText(buildQueryPromptV3({ ...many, bible: null }).messages))).toBe(
      432
    )
    expect(estimateTokens(promptText(buildQueryPromptV3({ ...many, bible: BIBLE }).messages))).toBe(
      509
    )
  })
})
