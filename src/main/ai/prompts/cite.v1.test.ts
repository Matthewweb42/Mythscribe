import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import {
  CITE_PROMPT_VERSION,
  CITE_RULES,
  CITE_SENTENCES_MAX,
  CITE_SENTINEL,
  buildCitePrompt,
  citeMaxTokens,
  parseCiteReply,
  type CitePromptScope,
  type CitePromptSentence
} from './cite.v1'

const sentences: CitePromptSentence[] = [
  {
    text: 'Lise first suspects the Captain in 9.3.',
    quotes: [
      {
        evidence: 'E2',
        tag: 'happened, 9.3 ¶4',
        quote: 'she did not trust his smile',
        context:
          'The Captain bowed. Lise watched him, and she did not trust his smile. Bel laughed at something he said.'
      }
    ]
  },
  {
    text: 'Bel never noticed.',
    quotes: [
      {
        evidence: 'E0',
        tag: 'happened, the open scene 14.2',
        quote: 'Bel laughed at something he said',
        context: 'Lise watched him. Bel laughed at something he said. The music began.'
      },
      {
        evidence: 'E5',
        tag: 'your notes, Bel’s Pinned ¶1',
        quote: 'Bel trusts too easily',
        context: 'Bel trusts too easily.'
      }
    ]
  }
]

const scope: CitePromptScope = {
  searched: 'every scene up to 14.2 for suspect, distrust, captain',
  claim: 'Lise first suspects the Captain in 9.3.',
  cited: '9.3',
  latest: false,
  hits: [
    { ref: '7.4 ¶2', text: 'Lise thought the Captain a little too smooth, and said so to no one.' },
    { ref: '8.1 ¶6', text: 'The Captain called at noon.' }
  ]
}

const QUESTION = 'When does Lise first suspect the Captain?'

describe('cite.v1 prompt (F-16.25)', () => {
  it('matches the golden messages: rules (cached), then the question, the sentences and the scope', () => {
    const built = buildCitePrompt({ question: QUESTION, sentences, scope })
    expect(built.version).toBe(CITE_PROMPT_VERSION)
    expect(built.messages).toMatchSnapshot()
    expect(built.messages).toHaveLength(2)
    expect(built.messages[0]).toEqual({ role: 'system', content: CITE_RULES })
    expect(CITE_RULES.startsWith(CITE_SENTINEL)).toBe(true)
    const user = built.messages[1]?.content ?? ''
    expect(user.indexOf('Question:')).toBe(0)
    expect(user.indexOf('1. Lise first')).toBeLessThan(user.indexOf('2. Bel never'))
    expect(user.indexOf('2. Bel never')).toBeLessThan(user.indexOf('Scope: searched'))
    expect(user).toContain('Passages the search found before 9.3:\n- 7.4 ¶2:')
    expect(built.sent).toBe(2)
    expect(built.scope).toBe(true)
    // 20 + 10 a sentence + 20 for the scope item.
    expect(built.maxTokens).toBe(60)
  })

  it('keeps its rules at 250 tokens or under, the same for every check', () => {
    expect(estimateTokens(CITE_RULES)).toBeLessThanOrEqual(250)
    const other = buildCitePrompt({ question: 'Who sold the map?', sentences, scope: null })
    expect(other.messages[0]?.content).toBe(CITE_RULES)
  })

  it('sends the scope item only when given (an ordinal or absence answer)', () => {
    const built = buildCitePrompt({ question: 'Who sold the map?', sentences, scope: null })
    expect(built.messages[1]?.content).not.toContain('Scope:')
    expect(built.scope).toBe(false)
    expect(built.maxTokens).toBe(40)
    const latest = buildCitePrompt({
      question: 'When does Lise last see the Captain?',
      sentences,
      scope: { ...scope, latest: true }
    })
    expect(latest.messages[1]?.content).toContain('Passages the search found after 9.3:')
    const absence = buildCitePrompt({
      question: 'Does Tomas ever learn of the map?',
      sentences,
      scope: { ...scope, cited: null, hits: [] }
    })
    expect(absence.messages[1]?.content).toContain('Passages the search found:\n(none)')
  })

  it('caps the output at min(200, 20 + 10 a sentence + 20 for the scope)', () => {
    expect(citeMaxTokens(1, false)).toBe(30)
    expect(citeMaxTokens(8, true)).toBe(120)
    expect(citeMaxTokens(40, true)).toBe(outputBudget('cite'))
  })

  it('maxed: eight long sentences of eight quotes, a long question and five hits stay under the cap, the first sentence always sent', () => {
    const long = 'word '.repeat(400)
    const many: CitePromptSentence[] = Array.from({ length: 12 }, (_, i) => ({
      text: `Sentence ${i + 1} ${long}`,
      quotes: Array.from({ length: 8 }, (__, j) => ({
        evidence: `E${j + 1}`,
        tag: `happened, ${j + 1}.1 ¶${j}`,
        quote: 'twenty five words '.repeat(9),
        context: long
      }))
    }))
    const built = buildCitePrompt({
      question: long,
      sentences: many,
      scope: {
        ...scope,
        claim: long,
        hits: Array.from({ length: 9 }, () => ({ ref: '1.1 ¶0', text: long }))
      }
    })
    const total = estimateTokens(built.messages.map((message) => message.content).join('\n'))
    expect(total).toBeLessThanOrEqual(inputBudget('cite'))
    expect(built.sent).toBeGreaterThanOrEqual(1)
    expect(built.sent).toBeLessThanOrEqual(CITE_SENTENCES_MAX)
    expect(built.messages[1]?.content).toContain('1. Sentence 1')
    expect(built.messages[1]?.content.match(/^- 1\.1 ¶0:/gmu)?.length ?? 0).toBeLessThanOrEqual(5)
    // A short check sends every sentence (up to 8).
    const [lead] = sentences
    if (lead === undefined) throw new Error('no sentence')
    const short = buildCitePrompt({
      question: QUESTION,
      sentences: Array.from({ length: 10 }, () => lead),
      scope: null
    })
    expect(short.sent).toBe(CITE_SENTENCES_MAX)
  })
})

describe('parseCiteReply', () => {
  it('reads verdicts by number and the scope', () => {
    const reply = parseCiteReply(
      '{"v":[{"i":1,"ok":"yes"},{"i":2,"ok":"partly"},{"i":3,"ok":"no"},{"i":1,"ok":"no"}],"scope":"earlier"}'
    )
    expect([...reply.verdicts]).toEqual([
      [1, 'yes'],
      [2, 'partly'],
      [3, 'no']
    ])
    expect(reply.scope).toBe('earlier')
  })

  it('skips verdicts that do not parse, reads a fenced reply, and salvages a cut-off one', () => {
    const fenced = parseCiteReply('```json\n{"v":[{"i":1,"ok":"maybe"},{"i":2,"ok":"no"}]}\n```')
    expect([...fenced.verdicts]).toEqual([[2, 'no']])
    expect(fenced.scope).toBeNull()
    const cut = parseCiteReply('{"v":[{"i":1,"ok":"yes"},{"i":2,"ok":"n')
    expect([...cut.verdicts]).toEqual([[1, 'yes']])
    expect(cut.scope).toBeNull()
    expect(parseCiteReply('not json').verdicts.size).toBe(0)
  })
})
