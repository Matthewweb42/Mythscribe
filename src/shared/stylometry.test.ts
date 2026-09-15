import { describe, expect, it } from 'vitest'
import {
  KIND_MIN_WORDS,
  RULE_MIN_DIALOGUE_CHARS,
  RULE_MIN_PARAGRAPHS,
  RULE_MIN_WORDS,
  RULE_MIN_WORDS_VERBS,
  classifyKind,
  computeStylometrics,
  dialogueRatio,
  renderVoiceRules,
  tokenize,
  Stylometrics
} from './stylometry'

/** `n` copies of a sentence, space-joined. */
const repeat = (sentence: string, n: number): string => Array(n).fill(sentence).join(' ')

const THIRD_PAST =
  'Mara turned from the window and looked at the ridge. ' +
  '"We should go," she said. ' +
  '"Not yet," Tomas replied. He knew she was tired. ' +
  '"The river is rising," she asked him quietly. ' +
  'They walked to the door, and she pulled it open. ' +
  '"Wait," he said.'

const FIRST_PRESENT =
  'I walk to the window and I look at the ridge. My hands are cold and I am tired. ' +
  'We wait for the river; it rises while we watch. It is late, and it rains. ' +
  'I know what comes next. I do not want to see it, but I stay.'

describe('tokenize', () => {
  it('lowercases, keeps inner apostrophes, and drops punctuation', () => {
    expect(tokenize('"Don\'t," she said—twice.')).toEqual(["don't", 'she', 'said', 'twice'])
  })
})

describe('dialogueRatio', () => {
  it('measures straight and curly quoted spans against the whole text', () => {
    expect(dialogueRatio('')).toEqual({ ratio: 0, chars: 0 })
    const text = '"Run," she said. “Now.”'
    const { ratio, chars } = dialogueRatio(text)
    expect(chars).toBe('"Run,"'.length + '“Now.”'.length)
    expect(ratio).toBeCloseTo(chars / text.length)
  })
})

describe('computeStylometrics', () => {
  it('answers zeros and unknowns for empty text', () => {
    const stats = computeStylometrics('')
    expect(stats).toMatchObject({
      wordCount: 0,
      sentenceLength: { median: 0, p90: 0 },
      paragraphLength: { medianWords: 0, count: 0 },
      dialogueRatio: 0,
      dialogueChars: 0,
      tense: 'unknown',
      person: 'unknown',
      adverbRate: 0,
      tagVerbs: { saidRatio: 0, sampleSize: 0 },
      topVerbs: []
    })
  })

  it('reads a third-person past passage with its dialogue tags', () => {
    const stats = computeStylometrics(THIRD_PAST)
    expect(stats.tense).toBe('past')
    expect(stats.person).toBe('third')
    // Three said/asked tags plus one "replied": said, replied, asked, said.
    expect(stats.tagVerbs).toEqual({ saidRatio: 0.75, sampleSize: 4 })
    expect(stats.dialogueChars).toBeGreaterThan(0)
    expect(stats.topVerbs).toContain('walk')
    expect(stats.topVerbs).toContain('say')
  })

  it('reads a first-person present passage', () => {
    const stats = computeStylometrics(FIRST_PRESENT)
    expect(stats.tense).toBe('present')
    expect(stats.person).toBe('first')
  })

  it('measures sentence and paragraph lengths, adverbs, and punctuation per thousand words', () => {
    const text =
      'One two three four.\nFive six seven eight nine ten; eleven, twelve—thirteen fourteen!\n' +
      'She moved quickly and quietly, only then.'
    const stats = computeStylometrics(text)
    expect(stats.wordCount).toBe(20)
    expect(stats.sentenceLength).toEqual({ median: 7, p90: 9 })
    expect(stats.paragraphLength).toEqual({ medianWords: 7, count: 3 })
    // "quickly" and "quietly"; "only" is on the stoplist.
    expect(stats.adverbRate).toBe(10)
    expect(stats.punctuation).toEqual({
      commasPer1000: 100,
      emDashesPer1000: 50,
      semicolonsPer1000: 50,
      exclamationsPer1000: 50,
      questionsPer1000: 0
    })
  })

  it('folds inflections and irregular forms onto the lexicon base and ignores auxiliaries', () => {
    const stats = computeStylometrics(
      'He ran and runs and running. She grabbed it, grabbing hard. They tried; he tries. ' +
        'It was, it is, it had been, they were going.'
    )
    expect(stats.topVerbs.slice(0, 3)).toEqual(['run', 'grab', 'try'])
    expect(stats.topVerbs).not.toContain('be')
    expect(stats.topVerbs).not.toContain('go')
  })

  it('validates against its own schema', () => {
    expect(Stylometrics.safeParse(computeStylometrics(THIRD_PAST)).success).toBe(true)
  })
})

describe('renderVoiceRules', () => {
  const base: Stylometrics = {
    wordCount: 0,
    sentenceLength: { median: 15, p90: 20 },
    paragraphLength: { medianWords: 60, count: 0 },
    dialogueRatio: 0,
    dialogueChars: 0,
    tense: 'unknown',
    person: 'unknown',
    adverbRate: 2,
    punctuation: {
      commasPer1000: 50,
      emDashesPer1000: 1,
      semicolonsPer1000: 1,
      exclamationsPer1000: 1,
      questionsPer1000: 1
    },
    tagVerbs: { saidRatio: 0, sampleSize: 0 },
    topVerbs: []
  }
  const rules = (over: Partial<Stylometrics>): string[] => renderVoiceRules({ ...base, ...over })

  it('says nothing for a passage with no evidence', () => {
    expect(rules({})).toEqual([])
    expect(renderVoiceRules(computeStylometrics('Too short to say.'))).toEqual([])
  })

  it('gates the sentence-length line on 200 words and phrases it by median', () => {
    expect(rules({ wordCount: RULE_MIN_WORDS - 1 })).toEqual([])
    expect(rules({ wordCount: RULE_MIN_WORDS })).toEqual(['Sentences run to a median of 15 words.'])
    expect(rules({ wordCount: 500, sentenceLength: { median: 9, p90: 14 } })).toEqual([
      'Short sentences, median 9 words.'
    ])
    expect(rules({ wordCount: 500, sentenceLength: { median: 24, p90: 45 } })).toEqual([
      'Long, flowing sentences, median 24 words. Some run much longer, up to 45 words.'
    ])
  })

  it('gates the dialogue line on 200 quoted characters', () => {
    expect(rules({ dialogueRatio: 0.3, dialogueChars: RULE_MIN_DIALOGUE_CHARS - 1 })).toEqual([])
    expect(rules({ dialogueRatio: 0.3, dialogueChars: RULE_MIN_DIALOGUE_CHARS })).toEqual([
      'About 30% of the prose is dialogue.'
    ])
  })

  it('names tense and person only when classified', () => {
    expect(rules({ tense: 'mixed', person: 'mixed' })).toEqual([])
    expect(rules({ tense: 'past', person: 'first' })).toEqual([
      'Narration is in past tense.',
      'Narration is in first person.'
    ])
    expect(rules({ tense: 'present', person: 'third' })).toEqual([
      'Narration is in present tense.',
      'Narration is in third person.'
    ])
  })

  it('gates the tag-verb line on three tags', () => {
    expect(rules({ tagVerbs: { saidRatio: 1, sampleSize: 2 } })).toEqual([])
    expect(rules({ tagVerbs: { saidRatio: 0.667, sampleSize: 3 } })).toEqual([
      "Dialogue tags are 'said' or 'asked' 67% of the time."
    ])
  })

  it('gates the paragraph line on ten paragraphs and a remarkable length', () => {
    expect(rules({ paragraphLength: { medianWords: 30, count: RULE_MIN_PARAGRAPHS - 1 } })).toEqual(
      []
    )
    expect(rules({ paragraphLength: { medianWords: 60, count: RULE_MIN_PARAGRAPHS } })).toEqual([])
    expect(rules({ paragraphLength: { medianWords: 30, count: RULE_MIN_PARAGRAPHS } })).toEqual([
      'Short paragraphs, typically 30 words.'
    ])
    expect(rules({ paragraphLength: { medianWords: 95, count: RULE_MIN_PARAGRAPHS } })).toEqual([
      'Long paragraphs, typically 95 words.'
    ])
  })

  it('gates the adverb line on 200 words and a remarkable rate', () => {
    const noSentence = (over: Partial<Stylometrics>): string[] =>
      rules(over).filter((line) => !line.includes('median'))
    expect(noSentence({ wordCount: 500, adverbRate: 2 })).toEqual([])
    expect(noSentence({ wordCount: 500, adverbRate: 1.4 })).toEqual([
      'Uses -ly adverbs sparingly (1.4 per 100 words).'
    ])
    expect(noSentence({ wordCount: 500, adverbRate: 4.1 })).toEqual([
      'Adverbs are frequent (4.1 per 100 words).'
    ])
  })

  it('emits at most one punctuation line, in priority order', () => {
    const punct = (over: Partial<Stylometrics['punctuation']>, count = 0): string[] =>
      rules({
        wordCount: 500,
        paragraphLength: { medianWords: 60, count },
        punctuation: { ...base.punctuation, ...over }
      }).filter((line) => !line.includes('median'))
    expect(punct({})).toEqual([])
    expect(punct({ semicolonsPer1000: 3.1, emDashesPer1000: 9 })).toEqual([
      'Uses semicolons often.'
    ])
    expect(punct({ semicolonsPer1000: 0.2 })).toEqual([])
    expect(punct({ semicolonsPer1000: 0.2 }, RULE_MIN_PARAGRAPHS)).toEqual([
      'Almost never uses semicolons.'
    ])
    expect(punct({ emDashesPer1000: 5.1 })).toEqual(['Reaches for em dashes often.'])
    expect(punct({ exclamationsPer1000: 8.1 })).toEqual(['Uses exclamation marks freely.'])
  })

  it('gates the verbs line on 300 words and five verbs, naming the first five', () => {
    const verbs = ['run', 'look', 'turn', 'walk', 'hold', 'see']
    expect(rules({ wordCount: RULE_MIN_WORDS_VERBS - 1, topVerbs: verbs })).toEqual([
      'Sentences run to a median of 15 words.'
    ])
    expect(rules({ wordCount: RULE_MIN_WORDS_VERBS, topVerbs: verbs.slice(0, 4) })).toEqual([
      'Sentences run to a median of 15 words.'
    ])
    expect(rules({ wordCount: RULE_MIN_WORDS_VERBS, topVerbs: verbs })).toEqual([
      'Sentences run to a median of 15 words.',
      'Frequently used verbs: run, look, turn, walk, hold.'
    ])
  })

  it('keeps at most eight lines, in priority order', () => {
    const all = rules({
      wordCount: 500,
      sentenceLength: { median: 9, p90: 12 },
      dialogueRatio: 0.4,
      dialogueChars: 800,
      tense: 'past',
      person: 'third',
      tagVerbs: { saidRatio: 0.9, sampleSize: 20 },
      paragraphLength: { medianWords: 30, count: 20 },
      adverbRate: 1,
      punctuation: { ...base.punctuation, semicolonsPer1000: 4 },
      topVerbs: ['run', 'look', 'turn', 'walk', 'hold']
    })
    expect(all).toEqual([
      'Short sentences, median 9 words.',
      'About 40% of the prose is dialogue.',
      'Narration is in past tense.',
      'Narration is in third person.',
      "Dialogue tags are 'said' or 'asked' 90% of the time.",
      'Short paragraphs, typically 30 words.',
      'Uses -ly adverbs sparingly (1 per 100 words).',
      'Uses semicolons often.'
    ])
  })
})

describe('classifyKind', () => {
  const words = (n: number): string => repeat('word', n)

  it('is mixed under 40 words whatever the text says', () => {
    expect(classifyKind(repeat('"Yes," she said.', 10))).toBe('mixed')
    expect(classifyKind(words(KIND_MIN_WORDS - 1))).toBe('mixed')
  })

  it('is dialogue from 40% quoted text', () => {
    const dialogue = repeat('"We should leave before the river takes the bridge," she said.', 6)
    expect(classifyKind(dialogue)).toBe('dialogue')
  })

  it('is action when the physical cues win by a margin, interiority when the reflective ones do', () => {
    const action = `${words(30)} She ran and grabbed the rope, turned, ducked, and jumped; he pulled, pushed, and drew the blade. She reached, spun, and sprinted.`
    expect(classifyKind(action)).toBe('action')
    const interiority = `${words(30)} She thought about it and knew what she felt. She wondered, realized, remembered, and believed. She hoped he understood; she decided, noticed, and sensed the end.`
    expect(classifyKind(interiority)).toBe('interiority')
  })

  it('is mixed when the cues balance or are absent', () => {
    expect(classifyKind(`${words(40)} She ran and thought. He grabbed and knew.`)).toBe('mixed')
    expect(classifyKind(words(60))).toBe('mixed')
  })
})
