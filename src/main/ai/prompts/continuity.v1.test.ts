import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, outputBudget } from '@shared/ai'
import type { ContinuityRef } from '@shared/continuity'
import {
  buildContinuityPrompt,
  CONTINUITY_PROMPT_VERSION,
  CONTINUITY_RULES,
  continuityRefLine
} from './continuity.v1'

const SCENE =
  'The ferry landing was empty when Mara reached it. Mara was twenty-nine that winter, and the ' +
  'bell had lost its clapper years ago.'

const sheet: ContinuityRef = {
  kind: 'sheet',
  entityId: 'e1',
  entityName: 'Mara',
  entityKind: 'character',
  attribute: 'age',
  label: 'Age',
  value: '34',
  nodeId: null,
  quote: null
}
const fact: ContinuityRef = {
  kind: 'fact',
  entityId: 'e2',
  entityName: 'The ferry',
  entityKind: 'setting',
  attribute: 'features',
  label: 'Features',
  value: 'A bell that still rings',
  nodeId: 'n2',
  quote: 'The bell rang twice across the water.'
}
const timeline: ContinuityRef = {
  kind: 'timeline',
  entityId: null,
  entityName: null,
  entityKind: null,
  attribute: null,
  label: 'Timeline',
  value: 'Day 3, dusk',
  nodeId: 'n1',
  quote: null
}

describe('continuity.v1 prompt (F-13.4)', () => {
  it('pins the rules: the sentinel opening, the caps, both citations, and the JSON shape', () => {
    expect(CONTINUITY_PROMPT_VERSION).toBe('continuity.v1')
    expect(CONTINUITY_RULES).toBe(
      'You are the continuity feature inside a novel-writing app. Compare the scene text below ' +
        "with the numbered references from the author's story bible; a reference marked sheet is " +
        "the author's own word and outranks the rest. List at most 6 " +
        'contradictions: a passage of the scene that states what a reference rules out (a name, an ' +
        'age, a physical detail, a relationship, a rule of the world, what a character knows, how a ' +
        'character speaks, when the scene happens). Not a contradiction: anything the references do ' +
        'not mention, a detail that adds to a reference without conflicting, and a lie or a mistake ' +
        'a character makes in dialogue; when in doubt, leave it out. Each finding gives the number ' +
        'of the one reference it contradicts, a quote copied from the scene word for word and at ' +
        'most 240 characters, one or two sentences on why both cannot be true, ' +
        'and a fix that replaces the quoted passage and nothing else so it agrees with the ' +
        "reference, in the author's voice, same point of view and tense, or null when a few words " +
        'cannot fix it. A finding whose quote is not in the scene or whose number is not a ' +
        'reference is thrown away. Reply with JSON only: ' +
        '{"findings":[{"ref":1,"quote":"...","why":"...","fix":"..."|null}]}; with no ' +
        'contradiction, {"findings":[]}.'
    )
  })

  it("pins the e2e fake server's CONTINUITY_SENTINEL to this version's opening (the e2e tsconfig cannot import from src/main)", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const CONTINUITY_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares CONTINUITY_SENTINEL')
    expect(match[1]).toBe('You are the continuity feature inside a novel-writing app.')
    expect(CONTINUITY_RULES.startsWith(match[1]!)).toBe(true)
  })

  it('prints one line per reference: who, where it is stated, the field, the value, and a fact’s passage', () => {
    expect(continuityRefLine(sheet, 1)).toBe('[1] Mara (character), sheet, Age: 34')
    expect(continuityRefLine(fact, 2)).toBe(
      '[2] The ferry (setting), another scene, Features: A bell that still rings; passage: ' +
        '"The bell rang twice across the water."'
    )
    expect(continuityRefLine({ ...fact, quote: null }, 2)).toBe(
      '[2] The ferry (setting), another scene, Features: A bell that still rings'
    )
    expect(continuityRefLine(timeline, 3)).toBe('[3] Previous scene, Timeline: Day 3, dusk')
  })

  it('puts the voice block after the rules and the brief before the numbered references', () => {
    const built = buildContinuityPrompt({
      sceneText: SCENE,
      references: [sheet, fact, timeline],
      timeline: 'Day 2, morning',
      voice: "Match the author's voice: short sentences.",
      brief: 'Goal: Mara reaches the ferry.'
    })
    expect(built.version).toBe('continuity.v1')
    expect(built.messages).toEqual([
      { role: 'system', content: `${CONTINUITY_RULES} Match the author's voice: short sentences.` },
      {
        role: 'user',
        content:
          `Scene brief (the author's intent):\n"""\nGoal: Mara reaches the ferry.\n"""\n\n` +
          'References:\n' +
          '[1] Mara (character), sheet, Age: 34\n' +
          '[2] The ferry (setting), another scene, Features: A bell that still rings; passage: ' +
          '"The bell rang twice across the water."\n' +
          '[3] Previous scene, Timeline: Day 3, dusk\n\n' +
          "This scene's timeline: Day 2, morning\n\n" +
          `Scene text:\n"""\n${SCENE}\n"""\n\n` +
          'List the contradictions.'
      }
    ])
    expect('temperature' in built).toBe(false)
  })

  it('leaves the timeline, the brief, and the voice block out when there are none', () => {
    const built = buildContinuityPrompt({
      sceneText: SCENE,
      references: [sheet],
      timeline: null,
      voice: null,
      brief: null
    })
    expect(built.messages[0]?.content).toBe(CONTINUITY_RULES)
    const user = built.messages[1]?.content ?? ''
    expect(user).toBe(
      `References:\n[1] Mara (character), sheet, Age: 34\n\nScene text:\n"""\n${SCENE}\n"""\n\n` +
        'List the contradictions.'
    )
  })

  it('asks for the feature output budget and costs what the golden estimates say', () => {
    const built = buildContinuityPrompt({
      sceneText: SCENE,
      references: [sheet],
      timeline: null,
      voice: null,
      brief: null
    })
    expect(built.maxTokens).toBe(outputBudget('continuity'))
    // The golden estimates: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(CONTINUITY_RULES)).toBe(314)
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBe(371)
  })
})
