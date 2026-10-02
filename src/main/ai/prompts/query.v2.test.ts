import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import { buildQueryPrompt, QUERY_RULES, type BuildQueryPromptInput } from './query.v1'
import { buildQueryPromptV2, QUERY_BIBLE_HEADING } from './query.v2'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'
const OTHER = 'Tomas refused to cross while the river was up, and sent her back to the landing.'
const QUESTION = 'What does Tomas want from Mara?'
const BIBLE =
  'Mara (character): Age: 31. Seen in the manuscript: Goals / motivations: cross the river ' +
  '(Chapter 1 › The ferry landing).\n' +
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

describe('query.v2 prompt (F-5.16)', () => {
  it("opens with version 1's rules unchanged, so the e2e fake server's QUERY_SENTINEL still matches", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const QUERY_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares QUERY_SENTINEL')
    for (const bible of [null, BIBLE]) {
      const system = buildQueryPromptV2({ ...many, bible }).messages[0]?.content ?? ''
      expect(system.startsWith(match[1]!)).toBe(true)
      expect(system.startsWith(QUERY_RULES)).toBe(true)
    }
  })

  it("is version 1's messages exactly when there is no story bible", () => {
    const built = buildQueryPromptV2({ ...many, bible: null })
    expect(built.version).toBe('query.v2')
    expect(built.messages).toEqual(buildQueryPrompt(many).messages)
    expect(built.maxTokens).toBe(outputBudget('query'))
    expect('temperature' in built).toBe(false)
  })

  it('places the story bible between the rules and the scenes, and changes nothing else', () => {
    const built = buildQueryPromptV2({ ...many, bible: BIBLE })
    const v1 = buildQueryPrompt(many).messages
    expect(built.messages[0]?.content).toBe(
      `${QUERY_RULES}\n\n${QUERY_BIBLE_HEADING}\n${BIBLE}` +
        (v1[0]?.content ?? '').slice(QUERY_RULES.length)
    )
    expect(built.messages[0]?.content).toContain(
      `${BIBLE}\n\nScenes (full text):\n[1] Chapter 1 › The ferry landing`
    )
    expect(built.messages.slice(1)).toEqual(v1.slice(1))
    expect(built.messages.at(-1)).toEqual({ role: 'user', content: QUESTION })
    expect(built.messages).toMatchSnapshot()
  })

  it("says in the heading that the bible orients and is never a citation, and that the sheets are the author's", () => {
    expect(QUERY_BIBLE_HEADING.startsWith("Story bible (the author's own sheets")).toBe(true)
    expect(QUERY_BIBLE_HEADING).toContain('never as a citation')
    expect(QUERY_BIBLE_HEADING).toContain('where a sheet and a scene disagree, say so')
  })

  it('pins the golden token estimates', () => {
    expect(estimateTokens(promptText(buildQueryPromptV2({ ...many, bible: null }).messages))).toBe(
      estimateTokens(promptText(buildQueryPrompt(many).messages))
    )
    expect(estimateTokens(promptText(buildQueryPromptV2({ ...many, bible: BIBLE }).messages))).toBe(
      464
    )
  })
})
