import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { REWRITE_CONTEXT_CHARS, REWRITE_TEXT_MAX } from '@shared/rewrite'
import { STORY_BIBLE_HEADING, STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import { buildRewritePrompt as buildV1 } from './rewrite.v1'
import { buildRewritePrompt, REWRITE_RULES, type BuildRewritePromptInput } from './rewrite.v2'

const PASSAGE =
  'The storm broke at dusk over the dark forest. Mara counted the lightning gaps, each one ' +
  'shorter than the last.'
const RULES =
  'You are the rewrite feature inside a novel-writing app. Rewrite the passage the author ' +
  "selected so it reads as the author's own voice, as described below. Keep its meaning, its " +
  'events, the names and facts it states, its point of view, its tense, and roughly its ' +
  'length. Remove generic or machine-sounding phrasing. Reply with the rewritten passage ' +
  'only, with the same paragraph breaks: no preamble, no notes, and no quotation marks around ' +
  'the answer.'
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'

const bare: BuildRewritePromptInput = {
  text: PASSAGE,
  before: '',
  after: '',
  meta: null,
  voice: null,
  bible: null
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('rewrite.v2 prompt (F-14.10, F-14.9)', () => {
  it('opens the rules with the sentence the fake server keys on, and never edits it within the version', () => {
    expect(REWRITE_RULES).toBe(RULES)
    expect(
      REWRITE_RULES.startsWith('You are the rewrite feature inside a novel-writing app.')
    ).toBe(true)
  })

  it("pins the e2e fake server's REWRITE_SENTINEL to this version's opening (the e2e tsconfig cannot import from src/main)", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const REWRITE_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares REWRITE_SENTINEL')
    expect(REWRITE_RULES.startsWith(match[1]!)).toBe(true)
  })

  it('a bare passage: the rules alone system-side, the passage and the instruction in the user turn, no temperature', () => {
    const built = buildRewritePrompt(bare)
    expect(built.version).toBe('rewrite.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: RULES },
      {
        role: 'user',
        content: `Passage to rewrite:\n"""\n${PASSAGE}\n"""\n\nRewrite the passage.`
      }
    ])
    expect('temperature' in built).toBe(false)
  })

  it('puts the voice block, the story bible, and the scene line in the system turn, in that order, and the context each side of the passage in the user turn', () => {
    const built = buildRewritePrompt({
      ...bare,
      before: 'She set the lantern down on the post.',
      after: 'She did not wait to see his face.',
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '' },
      voice: "Match the author's voice:\n- Narration is in past tense.",
      bible: BIBLE
    })
    expect(built.messages[0]?.content).toBe(
      `${RULES} Match the author's voice:\n- Narration is in past tense.\n\n` +
        `${BIBLE}\n\n` +
        'Scene: location Ferry landing, POV Mara, timeline —.'
    )
    expect(built.messages[1]?.content).toBe(
      'Text before:\n"""\nShe set the lantern down on the post.\n"""\n\n' +
        'Text after:\n"""\nShe did not wait to see his face.\n"""\n\n' +
        `Passage to rewrite:\n"""\n${PASSAGE}\n"""\n\n` +
        'Rewrite the passage.'
    )
  })

  it('F-14.9: a null bible leaves the v1 messages exactly', () => {
    const input = {
      ...bare,
      before: 'She set the lantern down on the post.',
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '' },
      voice: "Match the author's voice:\n- Narration is in past tense."
    }
    expect(buildRewritePrompt(input).messages).toEqual(buildV1(input).messages)
  })

  it('omits an empty context window rather than sending an empty block', () => {
    const before = buildRewritePrompt({ ...bare, before: 'Earlier.' })
    expect(before.messages[1]?.content).toBe(
      `Text before:\n"""\nEarlier.\n"""\n\nPassage to rewrite:\n"""\n${PASSAGE}\n"""\n\n` +
        'Rewrite the passage.'
    )
    const after = buildRewritePrompt({ ...bare, after: 'Later.' })
    expect(after.messages[1]?.content).toBe(
      `Text after:\n"""\nLater.\n"""\n\nPassage to rewrite:\n"""\n${PASSAGE}\n"""\n\n` +
        'Rewrite the passage.'
    )
  })

  it('asks for the passage at 1.5× plus slack, clamped to the feature output budget', () => {
    expect(buildRewritePrompt(bare).maxTokens).toBe(Math.ceil(estimateTokens(PASSAGE) * 1.5) + 40)
    expect(buildRewritePrompt({ ...bare, text: 'x'.repeat(REWRITE_TEXT_MAX) }).maxTokens).toBe(
      Math.min(Math.ceil((REWRITE_TEXT_MAX / 4) * 1.5) + 40, outputBudget('rewrite'))
    )
    expect(
      buildRewritePrompt({ ...bare, text: 'x'.repeat(REWRITE_TEXT_MAX) }).maxTokens
    ).toBeLessThanOrEqual(outputBudget('rewrite'))
  })

  it('stays under the rewrite input budget with every cap at its limit, the bible included', () => {
    const maxed: BuildRewritePromptInput = {
      text: 't'.repeat(REWRITE_TEXT_MAX),
      before: 'b'.repeat(REWRITE_CONTEXT_CHARS),
      after: 'a'.repeat(REWRITE_CONTEXT_CHARS),
      meta: { location: 'L'.repeat(200), pov: 'P'.repeat(200), timeline: 'T'.repeat(500) },
      voice: 'v'.repeat(2_400),
      bible: 'g'.repeat(STORY_BIBLE_TOKEN_BUDGET * 4)
    }
    const estimate = estimateTokens(promptText(buildRewritePrompt(maxed).messages))
    expect(estimate).toBeLessThan(inputBudget('rewrite'))
    // The golden estimates: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(2_522)
    expect(estimateTokens(promptText(buildRewritePrompt({ ...maxed, bible: null }).messages))).toBe(
      2_121
    )
    expect(estimateTokens(promptText(buildRewritePrompt(bare).messages))).toBe(153)
  })
})
