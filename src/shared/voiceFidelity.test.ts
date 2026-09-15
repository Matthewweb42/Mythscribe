import { describe, expect, it } from 'vitest'
import { computeStylometrics, RULE_MIN_PARAGRAPHS, RULE_MIN_WORDS } from './stylometry'
import {
  checkBannedPhrases,
  checkGhostTextFidelity,
  FIDELITY_SENTENCE_FACTOR,
  FIDELITY_SENTENCE_FLOOR,
  scoreDocumentDrift
} from './voiceFidelity'

/** The F-14.1 fixture: third-person past narration with four dialogue tags, three of them said. */
const VOICE_PARAGRAPH =
  'Mara turned from the window and looked at the ridge, where the storm had settled for the ' +
  'night. "We should go," she said. "Not yet," Tomas replied. He knew she was tired, and he was ' +
  'tired too. They walked to the door and she pulled it open. "The river is rising," she said. ' +
  '"Then we wait," he said.'

/** Six copies in one paragraph: past, third, 75% said, over 200 words, one paragraph. */
const profile = computeStylometrics(Array(6).fill(VOICE_PARAGRAPH).join(' '))
/** Every tag is said, so the tag-verb gate (85%) passes. */
const saidHeavy = computeStylometrics(
  Array(6).fill(VOICE_PARAGRAPH.replace('Tomas replied', 'Tomas said')).join(' ')
)
/** Twelve paragraphs, no semicolons: the semicolon gate passes. */
const paragraphed = computeStylometrics(Array(12).fill(VOICE_PARAGRAPH).join('\n'))

const CLEAN =
  'She turned back to the ridge and he followed, and they said nothing until the door had ' +
  'closed behind them.'
const PRESENT = 'She turns and he is there, and it is late, and she is tired, and he has nothing.'
const FIRST = 'I turned and I knew we were lost, and my hands shook as I walked.'
const SNAPPED = '"Go," she snapped.'
const ADVERBS = 'She quietly, slowly, carefully closed the door.'
const SEMICOLON = 'She turned; he followed.'

const codes = (result: { violations: { code: string }[] }): string[] =>
  result.violations.map((v) => v.code)

describe('checkGhostTextFidelity (F-14.7)', () => {
  it('passes a clean past-tense third-person fragment', () => {
    expect(checkGhostTextFidelity(profile, CLEAN)).toEqual({ ok: true, violations: [] })
    expect(profile.tense).toBe('past')
    expect(profile.person).toBe('third')
    expect(profile.wordCount).toBeGreaterThanOrEqual(RULE_MIN_WORDS)
  })

  it('flags a switch to present tense', () => {
    const result = checkGhostTextFidelity(profile, PRESENT)
    expect(result.ok).toBe(false)
    expect(result.violations[0]).toEqual({ code: 'tense', message: 'switches to present tense' })
  })

  it('flags a switch to first person', () => {
    const result = checkGhostTextFidelity(profile, FIRST)
    expect(codes(result)).toEqual(['person'])
    expect(result.violations[0]?.message).toBe('switches to first person')
  })

  it('flags a non-said dialogue tag against a said-heavy profile, not against a 75% one', () => {
    const result = checkGhostTextFidelity(saidHeavy, SNAPPED)
    expect(codes(result)).toEqual(['dialogueTag'])
    expect(result.violations[0]?.message).toBe('uses a dialogue tag other than said')
    expect(checkGhostTextFidelity(profile, SNAPPED).ok).toBe(true)
    expect(checkGhostTextFidelity(saidHeavy, '"Go," she said.').ok).toBe(true)
  })

  it('flags three -ly adverbs in a short fragment against an adverb-light profile', () => {
    expect(profile.adverbRate).toBe(0)
    const result = checkGhostTextFidelity(profile, ADVERBS)
    expect(codes(result)).toEqual(['adverbRate'])
    expect(result.violations[0]?.message).toBe('piles on -ly adverbs')
    // One adverb is not a pile.
    expect(checkGhostTextFidelity(profile, 'She quietly closed the door.').ok).toBe(true)
  })

  it('flags one sentence far longer than anything in the manuscript', () => {
    const limit = Math.max(
      FIDELITY_SENTENCE_FLOOR,
      profile.sentenceLength.p90 * FIDELITY_SENTENCE_FACTOR
    )
    const words = Math.ceil(limit) + 1
    const long = `${Array(words).fill('word').join(' ')}.`
    const result = checkGhostTextFidelity(profile, long)
    expect(codes(result)).toEqual(['sentenceLength'])
    expect(result.violations[0]?.message).toBe('runs to a much longer sentence than the manuscript')
    const justUnder = `${Array(Math.floor(limit)).fill('word').join(' ')}.`
    expect(checkGhostTextFidelity(profile, justUnder).ok).toBe(true)
  })

  it('flags a semicolon only when the manuscript has enough paragraphs and never uses them', () => {
    expect(paragraphed.paragraphLength.count).toBeGreaterThanOrEqual(RULE_MIN_PARAGRAPHS)
    const result = checkGhostTextFidelity(paragraphed, SEMICOLON)
    expect(codes(result)).toEqual(['semicolon'])
    expect(result.violations[0]?.message).toBe('uses a semicolon, which the manuscript never does')
    // One paragraph of evidence is not enough to say "never".
    expect(checkGhostTextFidelity(profile, SEMICOLON).ok).toBe(true)
    // A manuscript that does use them does not mind one more.
    const uses = computeStylometrics(Array(12).fill(`${VOICE_PARAGRAPH};`).join('\n'))
    expect(checkGhostTextFidelity(uses, SEMICOLON).ok).toBe(true)
  })

  it('lists every violation, the first one first', () => {
    const result = checkGhostTextFidelity(
      profile,
      'I am lost and I know we are done, and it is late, and my hands are cold, and I am tired.'
    )
    expect(codes(result)).toEqual(['tense', 'person'])
  })

  it('never flags anything against a thin profile (the evidence gates)', () => {
    const empty = computeStylometrics('')
    const thin = computeStylometrics(
      'Mara turned from the window and looked at the ridge where the storm had settled for the night.'
    )
    expect(thin.wordCount).toBeLessThan(RULE_MIN_WORDS)
    for (const stats of [empty, thin]) {
      for (const fragment of [PRESENT, FIRST, SNAPPED, ADVERBS, SEMICOLON]) {
        expect(checkGhostTextFidelity(stats, fragment)).toEqual({ ok: true, violations: [] })
      }
    }
  })

  it('does not flag a fragment too short to resolve tense or person', () => {
    // Four markers: under the five the classifier needs, so nothing is claimed.
    expect(checkGhostTextFidelity(profile, 'I am here and I am tired.').ok).toBe(true)
  })
})

describe('scoreDocumentDrift (F-14.7)', () => {
  const PRESENT_PARAGRAPH =
    'Mara turns from the window and she looks at the ridge, where the storm is settling for ' +
    'the night. She is tired, and he is tired too, and it is late. They walk to the door and ' +
    'she pulls it open.'
  const FIRST_PARAGRAPH =
    'I turned from the window and looked at the ridge, where the storm had settled for the ' +
    'night. I knew I was tired, and my hands shook. We walked to the door and I pulled it open.'

  it('finds nothing wrong with the manuscript against itself', () => {
    expect(scoreDocumentDrift(profile, profile)).toEqual({ violations: [] })
  })

  it('flags a present-tense scene in a past-tense manuscript, and vice versa', () => {
    const present = computeStylometrics(Array(6).fill(PRESENT_PARAGRAPH).join(' '))
    expect(present.tense).toBe('present')
    expect(codes(scoreDocumentDrift(profile, present))).toContain('tense')
    expect(scoreDocumentDrift(profile, present).violations.find((v) => v.code === 'tense')).toEqual(
      {
        code: 'tense',
        message: 'Narrated in present tense; the manuscript is in past tense.'
      }
    )
    expect(codes(scoreDocumentDrift(present, profile))).toContain('tense')
  })

  it('flags a first-person scene in a third-person manuscript', () => {
    const first = computeStylometrics(Array(6).fill(FIRST_PARAGRAPH).join(' '))
    expect(first.person).toBe('first')
    const result = scoreDocumentDrift(profile, first)
    expect(result.violations).toContainEqual({
      code: 'person',
      message: 'Narrated in first person; the manuscript is in third person.'
    })
    expect(codes(result)).not.toContain('tense')
  })

  it('flags a median sentence length outside 0.67–1.5 of the manuscript, only with 200 words on both sides', () => {
    const sentence = `${Array(30).fill('word').join(' ')}.`
    const long = computeStylometrics(Array(8).fill(sentence).join(' '))
    expect(long.wordCount).toBeGreaterThanOrEqual(RULE_MIN_WORDS)
    const result = scoreDocumentDrift(profile, long)
    expect(codes(result)).toContain('sentenceLength')
    expect(result.violations.find((v) => v.code === 'sentenceLength')?.message).toBe(
      `Sentences run a median of 30 words; the manuscript's is ${Math.round(profile.sentenceLength.median)}.`
    )
    const short = computeStylometrics(Array(3).fill(sentence).join(' '))
    expect(short.wordCount).toBeLessThan(RULE_MIN_WORDS)
    expect(codes(scoreDocumentDrift(profile, short))).not.toContain('sentenceLength')
  })

  it('flags a dialogue share more than 25 points off, with 200 quoted characters on both sides', () => {
    const line =
      '"We should go now, before the river takes the bridge and the road with it," she said.'
    const talky = computeStylometrics(Array(6).fill(line).join(' '))
    expect(talky.dialogueChars).toBeGreaterThan(200)
    expect(profile.dialogueChars).toBeGreaterThan(200)
    expect(talky.dialogueRatio - profile.dialogueRatio).toBeGreaterThan(0.25)
    const result = scoreDocumentDrift(profile, talky)
    expect(result.violations).toContainEqual({
      code: 'dialogueRatio',
      message:
        `About ${Math.round(talky.dialogueRatio * 100)}% dialogue; ` +
        `the manuscript is about ${Math.round(profile.dialogueRatio * 100)}%.`
    })
    const quiet = computeStylometrics(Array(6).fill(line.replace(/"/g, '')).join(' '))
    expect(codes(scoreDocumentDrift(profile, quiet))).not.toContain('dialogueRatio')
  })

  it('flags an adverb rate at least twice the manuscript’s, above the floor of one per 100 words', () => {
    const purple = computeStylometrics(
      Array(6).fill(VOICE_PARAGRAPH.replace('turned', 'slowly, quietly turned')).join(' ')
    )
    expect(purple.adverbRate).toBeGreaterThanOrEqual(1)
    const result = scoreDocumentDrift(profile, purple)
    expect(result.violations).toContainEqual({
      code: 'adverbRate',
      message: `${purple.adverbRate} -ly adverbs per 100 words; the manuscript has 0.`
    })
    // Fewer adverbs than the manuscript is not drift.
    expect(codes(scoreDocumentDrift(purple, profile))).not.toContain('adverbRate')
  })

  it('flags a said ratio more than 0.4 off, with three tags on both sides', () => {
    const fancy = computeStylometrics(
      Array(6)
        .fill(VOICE_PARAGRAPH.replace(/she said|he said/g, 'she whispered'))
        .join(' ')
    )
    expect(fancy.tagVerbs.sampleSize).toBeGreaterThanOrEqual(3)
    expect(fancy.tagVerbs.saidRatio).toBe(0)
    const result = scoreDocumentDrift(profile, fancy)
    expect(result.violations).toContainEqual({
      code: 'dialogueTag',
      message: "Dialogue tags are said or asked 0% of the time; the manuscript's are 75%."
    })
    const noTags = computeStylometrics(Array(6).fill(FIRST_PARAGRAPH).join(' '))
    expect(codes(scoreDocumentDrift(profile, noTags))).not.toContain('dialogueTag')
  })

  it('flags semicolons per 1,000 words more than 3 off, with ten paragraphs on both sides', () => {
    const semi = computeStylometrics(Array(12).fill(`${VOICE_PARAGRAPH};`).join('\n'))
    const result = scoreDocumentDrift(paragraphed, semi)
    expect(result.violations).toContainEqual({
      code: 'semicolon',
      message: `${semi.punctuation.semicolonsPer1000} semicolons per 1,000 words; the manuscript has 0.`
    })
    // Same text in one paragraph: the gate does not pass.
    const onePara = computeStylometrics(Array(12).fill(`${VOICE_PARAGRAPH};`).join(' '))
    expect(codes(scoreDocumentDrift(paragraphed, onePara))).not.toContain('semicolon')
    expect(codes(scoreDocumentDrift(profile, semi))).not.toContain('semicolon')
  })

  it('says nothing about an empty document or an empty manuscript', () => {
    const empty = computeStylometrics('')
    expect(scoreDocumentDrift(profile, empty)).toEqual({ violations: [] })
    expect(scoreDocumentDrift(empty, profile)).toEqual({ violations: [] })
  })
})

describe('banned phrases in the fidelity check (F-14.2)', () => {
  it('flags a banned phrase first, ungated, with the phrase named', () => {
    const thin = computeStylometrics('Short.')
    const result = checkGhostTextFidelity(thin, `${PRESENT} It was a testament to her.`, [
      'a testament to'
    ])
    expect(result.ok).toBe(false)
    expect(result.violations[0]).toEqual({
      code: 'bannedPhrase',
      message: 'uses the phrase “a testament to”, which the author has banned'
    })
    expect(checkGhostTextFidelity(profile, CLEAN, ['a testament to']).ok).toBe(true)
    expect(checkGhostTextFidelity(profile, CLEAN).ok).toBe(true)
  })

  it('lists the banned phrases before the stylometric signals', () => {
    const codes = checkGhostTextFidelity(profile, `${PRESENT} Delve in.`, ['delve']).violations.map(
      (v) => v.code
    )
    expect(codes[0]).toBe('bannedPhrase')
    expect(codes).toContain('tense')
  })

  it('checkBannedPhrases returns one violation per phrase in order of appearance', () => {
    expect(
      checkBannedPhrases(['delve', 'tapestry'], 'A tapestry to delve into.').map((v) => v.message)
    ).toEqual([
      'uses the phrase “tapestry”, which the author has banned',
      'uses the phrase “delve”, which the author has banned'
    ])
  })
})
