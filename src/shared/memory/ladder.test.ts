import { describe, expect, it } from 'vitest'
import {
  absentValue,
  actsOnSubject,
  ageIsSpan,
  bornIsWhen,
  LOCATION_VALUE_MAX_WORDS,
  locationPhrase,
  ownedSlot,
  possessiveOwner,
  possessiveOwners,
  kinshipStated,
  diesInQuote,
  genderOfNames,
  pronounOfOtherGender,
  pronounRivals,
  relationValue,
  relativeValue,
  groupHeadIn,
  locationStated,
  possessedOnly,
  sameQuote,
  valueOfKind,
  nameInSentence,
  pointsAtOne,
  pronounPerson,
  quotePointsAtSubject,
  resolveSubject,
  unknownName,
  valueStated,
  wishWord,
  type LadderSentence
} from './ladder'
import type { LiteralName } from './literal'

const name = (recordId: string, start: number, end: number, ambiguous = false): LiteralName => ({
  recordId,
  kind: 'character',
  start,
  end,
  ambiguous
})

const sentence = (position: number, text: string, names: LiteralName[] = []): LadderSentence => ({
  position,
  text,
  names
})

const base = {
  recordId: 'mara',
  voice: 'narration' as const,
  speakerId: null,
  before: [],
  typedPov: null,
  isCharacter: () => true
}

describe('the ladder’s subject step (F-16.17)', () => {
  it('tells first person from third', () => {
    expect(pronounPerson('I was born in the north')).toBe('first')
    expect(pronounPerson('My father was a clergyman')).toBe('first')
    expect(pronounPerson('She walked to the quay')).toBe('third')
    expect(pronounPerson('the beautiful expression of her dark eyes')).toBe('third')
    expect(pronounPerson('A single man of large fortune')).toBeNull()
    // "Theirs" and "There" are not one another.
    expect(pronounPerson('There was a ship')).toBeNull()
  })

  it('finds a new name in its sentence as written, on word boundaries', () => {
    expect(nameInSentence('Hesk was a smuggler.', 'Hesk')).toEqual({ start: 0, end: 4 })
    expect(nameInSentence('Heskith was a smuggler.', 'Hesk')).toBeNull()
    expect(nameInSentence('They saw hesk.', 'Hesk')).toBeNull()
    expect(nameInSentence('Old  Hesk Varn left.', 'Hesk Varn')).toEqual({ start: 5, end: 14 })
  })

  it('pins a fact to the record its sentence names', () => {
    expect(
      resolveSubject({
        ...base,
        quote: [sentence(1, "Mara's eyes were grey.", [name('mara', 0, 4)])]
      })
    ).toEqual({ kind: 'named', text: 'Mara' })
  })

  it('makes a shared alias wait on its owners', () => {
    const text = "Harrow's temper was short."
    expect(
      resolveSubject({
        ...base,
        recordId: 'mr',
        quote: [sentence(1, text, [name('mrs', 0, 6, true), name('mr', 0, 6, true)])]
      })
    ).toEqual({ kind: 'shared', candidates: ['mr', 'mrs'], text: 'Harrow' })
  })

  it('sends a pronoun or a description to the checker with every character named in reach', () => {
    const before = [
      sentence(2, 'The two women sat by the window.'),
      sentence(1, 'Clara and Lise came in.', [name('clara', 0, 5), name('lise', 10, 14)])
    ]
    expect(
      resolveSubject({
        ...base,
        recordId: 'clara',
        before,
        quote: [sentence(3, 'She had green eyes.')]
      })
    ).toEqual({
      kind: 'antecedent',
      candidates: ['clara', 'lise'],
      naming: 1,
      namedAt: { clara: 1, lise: 1 },
      unnamed: null
    })
    // A description with no pronoun goes the same way.
    expect(
      resolveSubject({
        ...base,
        recordId: 'ashby',
        before: [
          sentence(1, 'His name is Ashby.', [name('ashby', 12, 17)]),
          sentence(0, 'Mara met him.', [name('mara', 0, 4)])
        ],
        quote: [sentence(2, 'A single man of large fortune.')]
      })
    ).toEqual({
      kind: 'antecedent',
      candidates: ['ashby', 'mara'],
      naming: 0,
      namedAt: { ashby: 1, mara: 0 },
      unnamed: null
    })
    // No one named within reach: refused.
    expect(resolveSubject({ ...base, quote: [sentence(0, 'She walked to the quay.')] })).toEqual({
      kind: 'none'
    })
  })

  it('offers the women named before a man named last, so a forced choice cannot happen', () => {
    // "Clara and Lise sat by the window. Tomas brought the tea. She had green eyes."
    expect(
      resolveSubject({
        ...base,
        recordId: 'clara',
        before: [
          sentence(1, 'Tomas brought the tea.', [name('tomas', 0, 5)]),
          sentence(0, 'Clara and Lise sat by the window.', [
            name('clara', 0, 5),
            name('lise', 10, 14)
          ])
        ],
        quote: [sentence(2, 'She had green eyes.')]
      })
    ).toEqual({
      kind: 'antecedent',
      candidates: ['tomas', 'clara', 'lise'],
      naming: 0,
      namedAt: { tomas: 1, clara: 0, lise: 0 },
      unnamed: null
    })
  })

  it('marks a proposed record nothing in reach names, for a role the text gives', () => {
    // "Mr. Harrow … his wife … She was a woman of mean understanding."
    expect(
      resolveSubject({
        ...base,
        recordId: 'mrs',
        before: [
          sentence(1, 'Her mind was less difficult to develop.'),
          sentence(0, 'Mr. Harrow could not make his wife understand him.', [name('mr', 0, 10)])
        ],
        quote: [sentence(2, 'She was a woman of mean understanding.')]
      })
    ).toEqual({
      kind: 'antecedent',
      candidates: ['mr', 'mrs'],
      naming: 0,
      namedAt: { mr: 0 },
      unnamed: 'mrs'
    })
  })

  it('refuses a sentence that names someone the scan does not know and points to nobody', () => {
    const before = [sentence(0, 'Rynna Falsire came in.', [name('rynna', 0, 13)])]
    expect(
      resolveSubject({
        ...base,
        recordId: 'rynna',
        before,
        quote: [sentence(1, 'Jem Falsire had green eyes.')]
      })
    ).toEqual({ kind: 'none' })
    expect(unknownName(sentence(1, 'Jem Falsire had green eyes.'))).toBe(true)
    expect(unknownName(sentence(1, 'They met Hesk at the quay.'))).toBe(true)
    // A capitalised word opening a sentence may be any word; a known name is no unknown one.
    expect(unknownName(sentence(1, 'Hope filled the room.'))).toBe(false)
    expect(unknownName(sentence(1, 'They met Mara.', [name('mara', 9, 13)]))).toBe(false)
    // A pronoun still points back: the unknown name is the checker's to weigh.
    expect(
      resolveSubject({
        ...base,
        recordId: 'rynna',
        before,
        quote: [sentence(1, 'She looked at Jem Falsire.')]
      })
    ).toMatchObject({ kind: 'antecedent', candidates: ['rynna'] })
  })

  it('pins first person to a speaker, or to the typed POV, and to no one else', () => {
    const line = [sentence(0, '"I was born in Elsmere," he said.')]
    expect(
      resolveSubject({
        ...base,
        recordId: 'tomas',
        voice: 'dialogue',
        speakerId: 'tomas',
        quote: line
      })
    ).toEqual({ kind: 'firstPerson', via: 'speaker', recordId: 'tomas' })
    expect(resolveSubject({ ...base, voice: 'dialogue', speakerId: 'tomas', quote: line })).toEqual(
      { kind: 'none' }
    )
    const told = [sentence(0, 'I was born in the north.')]
    expect(resolveSubject({ ...base, typedPov: 'mara', quote: told })).toEqual({
      kind: 'firstPerson',
      via: 'pov',
      recordId: 'mara'
    })
    expect(resolveSubject({ ...base, typedPov: 'tomas', quote: told })).toEqual({ kind: 'none' })
  })

  it('reads a source’s own words to the learner as the source’s first person (P2b, slice 3)', () => {
    // "“Bel, you must swear not to tell,” said Lottie. “Mr. Dunmore and I are engaged.”"
    const before = [
      sentence(0, '“Bel, you must swear not to tell,” said Lottie.', [
        name('bel', 1, 4),
        name('lottie', 41, 47)
      ])
    ]
    const quote = [sentence(1, '“Mr. Dunmore and I are engaged.”', [name('dunmore', 1, 12)])]
    const told = {
      ...base,
      recordId: 'bel',
      voice: 'dialogue' as const,
      speakerId: 'lottie',
      before,
      quote
    }
    // Bel told from Lottie: the learner is found in reach, the source left out.
    expect(resolveSubject({ ...told, sourceId: 'lottie' })).toEqual({
      kind: 'antecedent',
      candidates: ['bel', 'dunmore'],
      naming: 0,
      namedAt: { bel: 0 },
      unnamed: null
    })
    // Without a source (a holding line), or when the speaker is not the source, as before.
    expect(resolveSubject(told)).toEqual({ kind: 'none' })
    expect(resolveSubject({ ...told, sourceId: 'dunmore' })).toEqual({ kind: 'none' })
    // The speaker's own line stays theirs.
    expect(resolveSubject({ ...told, recordId: 'lottie', sourceId: 'lottie' })).toEqual({
      kind: 'firstPerson',
      via: 'speaker',
      recordId: 'lottie'
    })
    // Narration is never a source's words.
    expect(resolveSubject({ ...told, voice: 'narration', sourceId: 'lottie' })).toEqual({
      kind: 'none'
    })
  })
})

describe('a group named by its head noun (P2b-D8, amended in review)', () => {
  it('finds the last word of a group’s name in the sentence, any case, whole words', () => {
    expect(groupHeadIn(['the regiment'], ['By Sunday the whole regiment knew.'])).toBe('regiment')
    expect(groupHeadIn(['the Harbour Watch', 'the Watch'], ['The whole watch knew it.'])).toBe(
      'Watch'
    )
    expect(groupHeadIn(['the regiment'], ['The regimental band played.'])).toBeNull()
    expect(groupHeadIn(['the regiment'], ['They all knew.'])).toBeNull()
    // A head shorter than three letters never counts.
    expect(groupHeadIn(['the Ox'], ['the ox knew'])).toBeNull()
  })
})

describe('the code gates of the live run of 2026-10-14', () => {
  it('keeps a value only when its words stand in the quote', () => {
    expect(valueStated('location', 'the road', 'Johanna walked quickly')).toBe(false)
    expect(
      valueStated(
        'location',
        'at the table',
        'Mr. Harrow said nothing more until the cloth was drawn'
      )
    ).toBe(false)
    expect(
      valueStated('location', 'Greyhallow', 'Anne Fenwick was at Greyhallow that summer')
    ).toBe(true)
    // Articles and prepositions aside; a word sharing four letters or more is the same word.
    expect(
      valueStated('traits', 'proud, disagreeable', 'He was the proudest, most disagreeable man')
    ).toBe(true)
    expect(valueStated('clothing', 'her muff', 'with her hands in her muff')).toBe(true)
    expect(valueStated('eyes', 'grey', 'Varrow’s brown eyes followed her')).toBe(false)
    // An age in digits for words; alive and kinship are never the quote's words.
    expect(valueStated('age', '22', 'Johanna was two-and-twenty that spring')).toBe(true)
    expect(valueStated('age', '23', 'Johanna was two-and-twenty that spring')).toBe(false)
    expect(valueStated('alive', 'dead', 'He died in the night')).toBe(true)
    expect(valueStated('kinship', 'son of a clergyman', 'My father was a clergyman')).toBe(true)
  })

  it('points at one person: a he or she, a description, or a they for eyes', () => {
    expect(pointsAtOne('traits', 'She was a woman of mean understanding')).toBe(true)
    expect(pointsAtOne('detail:income', 'A single man of large fortune')).toBe(true)
    expect(pointsAtOne('eyes', 'They were the colour of wet slate')).toBe(true)
    expect(pointsAtOne('location', 'the sisters walked to Callow Cross')).toBe(false)
    expect(pointsAtOne('location', 'They walked to Callow Cross')).toBe(false)
    expect(pointsAtOne('detail:accent', 'How can you be so unfeeling')).toBe(false)
    expect(pointsAtOne('traits', 'talked of everything except Thornmere')).toBe(false)
  })

  it('wants the quote itself to name or point at the subject', () => {
    const fact = { slot: 'traits', names: ['Johanna'], firstPerson: false }
    expect(quotePointsAtSubject({ ...fact, quote: 'talked of everything except Thornmere' })).toBe(
      false
    )
    expect(quotePointsAtSubject({ ...fact, quote: 'Johanna laughed as easily as ever' })).toBe(true)
    // Any case: a name opening the sentence.
    expect(
      quotePointsAtSubject({
        ...fact,
        names: ['the Captain'],
        quote: "The Captain's father was a merchant"
      })
    ).toBe(true)
    expect(
      quotePointsAtSubject({ ...fact, quote: "though I am the youngest, I'm the tallest" })
    ).toBe(false)
    expect(
      quotePointsAtSubject({
        ...fact,
        firstPerson: true,
        quote: "though I am the youngest, I'm the tallest"
      })
    ).toBe(true)
  })

  it('finds a want, wish, hope or plan in a state read as now', () => {
    expect(wishWord('objects', 'now', 'Johanna wanted thread')).toBe('wanted')
    expect(wishWord('detail:occupation', 'now', 'I hope Mr. Ashby will like it, Lise.')).toBe(
      'hope'
    )
    expect(wishWord('objects', 'hypothetical', 'Johanna wanted thread')).toBeNull()
    expect(wishWord('traits', 'now', 'she always wished to travel')).toBeNull()
    // "long" is no longing.
    expect(wishWord('hair', 'now', "Lottie's hair was long that morning")).toBeNull()
  })
})

describe('the code gates of the second live run of 2026-10-14', () => {
  it('refuses an absence as a value, but not in a trait, a history, an age or alive', () => {
    expect(absentValue('location', 'not there')).toBe('not')
    expect(absentValue('location', 'nowhere')).toBe('nowhere')
    expect(absentValue('clothing', 'no hat')).toBe('no')
    expect(absentValue('objects', "wasn't carrying it")).not.toBeNull()
    expect(absentValue('location', 'in the morning room')).toBeNull()
    expect(absentValue('location', 'Nottingham')).toBeNull()
    expect(absentValue('traits', 'not to be comforted')).toBeNull()
    expect(absentValue('history', 'had never told a soul')).toBeNull()
    expect(absentValue('age', 'not yet sixteen')).toBeNull()
    expect(absentValue('alive', 'not alive')).toBeNull()
  })

  it('keeps an age that is an age and an object that is a thing', () => {
    for (const age of [
      'seven-and-twenty',
      'two-and-twenty',
      'eighteen',
      '22',
      'about forty',
      'not yet sixteen',
      'six months old',
      'nineteen years of age'
    ]) {
      expect(valueOfKind('age', age), age).toBe(true)
    }
    for (const notAge of ['four grown-up daughters', 'young', 'grown-up', 'her daughters']) {
      expect(valueOfKind('age', notAge), notAge).toBe(false)
    }
    expect(valueOfKind('objects', 'attentions')).toBe(false)
    expect(valueOfKind('objects', 'his regard')).toBe(false)
    expect(valueOfKind('objects', 'his hat in his hand')).toBe(true)
    expect(valueOfKind('objects', 'the mending')).toBe(true)
    expect(valueOfKind('traits', 'four grown-up daughters')).toBe(true)
  })

  it('takes a location only as where the quote puts its subject', () => {
    const at = (value: string, quote: string, names: string[], firstPerson = false): boolean =>
      locationStated({ value, quote, names, firstPerson })
    expect(
      at(
        'the road',
        'The road was hard with frost, and the hedges were full of fieldfares. Johanna walked quickly, with her hands in her muff',
        ['Johanna']
      )
    ).toBe(false)
    expect(at('Greyhallow', 'Anne Fenwick was at Greyhallow that summer', ['Anne Fenwick'])).toBe(
      true
    )
    expect(at('Thornmere', 'Lise came back to Thornmere', ['Lise'])).toBe(true)
    expect(at('Wexley', 'Clara Pell called at Wexley', ['Clara Pell'])).toBe(true)
    expect(at('the back stairs', 'Lise came up the back stairs', ['Lise'])).toBe(true)
    expect(at('on the bridge', 'they passed the Captain on the bridge', ['the Captain'])).toBe(true)
    expect(at('town', 'Mr. Ashby has gone to town', ['Mr. Ashby'])).toBe(true)
    expect(at('abroad', 'He was abroad', [])).toBe(true)
    expect(at('the quay', 'She walked to the quay', [])).toBe(true)
    expect(at('there', 'Lottie was there', ['Lottie'])).toBe(false)
    // A place in the sentence, but not where she is.
    expect(at('the hall', 'The hall was cold, and Mara shivered', ['Mara'])).toBe(false)
    expect(at('Bath', 'I was in Bath', [], true)).toBe(true)
  })

  it('takes no state from a sentence that tells the subject’s death', () => {
    const dies = (slot: string, sentence: string, names: string[] = []): boolean =>
      diesInQuote({ slot, sentences: [sentence], names, firstPerson: false })
    expect(dies('location', 'He died in the night, in his chair by the lodge fire')).toBe(true)
    expect(
      dies(
        'objects',
        'He died in the night, in his chair by the lodge fire, with his pipe still warm in his hand'
      )
    ).toBe(true)
    expect(dies('location', 'Mr. Fenwick had drowned off Vellmouth', ['Mr. Fenwick'])).toBe(true)
    expect(dies('clothing', 'She wore black, for her father had died')).toBe(false)
    expect(dies('location', 'He sat by the lodge fire')).toBe(false)
    expect(dies('alive', 'He died in the night')).toBe(false)
    expect(dies('history', 'He died in the night, in his chair')).toBe(false)
  })

  it('refuses a relative’s fact reached through the subject, outside kinship, relation and history', () => {
    const through = (slot: string, quote: string, names: string[], firstPerson = false): boolean =>
      possessedOnly({ slot, quote, names, firstPerson })
    expect(through('detail:occupation', 'My father was a clergyman in Elsdale', [], true)).toBe(
      true
    )
    expect(through('kinship', 'My father was a clergyman in Elsdale', [], true)).toBe(false)
    expect(
      through('history', "The Captain's father was a merchant in Vellmouth", ['the Captain'])
    ).toBe(false)
    expect(through('traits', "Lottie's mother was angry", ['Lottie'])).toBe(true)
    expect(through('eyes', 'his wife had grey eyes', [])).toBe(true)
    // A pointer at the subject outside the relative keeps it.
    expect(through('hair', "She remembered her mother's red hair", [])).toBe(false)
    expect(through('traits', 'Her sister Johanna was the gentlest', ['Johanna'])).toBe(false)
    expect(through('eyes', "Mr. Varrow's eyes were a cold, clear grey", ['Mr. Varrow'])).toBe(false)
    expect(through('clothing', 'with her hands in her muff', [])).toBe(false)
  })

  it('reads two quotes as one when one holds the other', () => {
    expect(
      sameQuote(
        'Amongst the most violent against him was Mrs. Harrow',
        'amongst the most  violent against him'
      )
    ).toBe(true)
    expect(sameQuote('Lottie was eighteen now', 'Lottie was nineteen')).toBe(false)
    expect(sameQuote('', 'x')).toBe(false)
  })
})

/** A sentence with the names found in it, located by their text. */
const named = (position: number, text: string, ...found: [string, string][]): LadderSentence =>
  sentence(
    position,
    text,
    found.map(([recordId, written]) => {
      const start = text.indexOf(written)
      return name(recordId, start, start + written.length)
    })
  )

describe('the code gates of the third live run of 2026-10-14 (plan ReaderPrecision.md)', () => {
  const GENDERS: Record<string, 'female' | 'male' | null> = {
    clara: 'female',
    lise: 'female',
    johanna: 'female',
    ashby: 'male',
    harrow: 'male',
    hobb: null,
    lottie: null
  }
  const rivals = (
    quote: string,
    sentences: LadderSentence[],
    before: LadderSentence[],
    slot = 'eyes'
  ): string[] =>
    pronounRivals({
      slot,
      quote,
      sentences,
      before,
      isCharacter: () => true,
      genderOf: (id) => GENDERS[id] ?? null
    })

  it('reads a gender only from a title a name opens with', () => {
    expect(genderOfNames(['Clara Pell', 'Miss Pell'])).toBe('female')
    expect(genderOfNames(['Mr. Harrow', 'Harrow'])).toBe('male')
    expect(genderOfNames(['Sir Walter Pell'])).toBe('male')
    expect(genderOfNames(['Lottie'])).toBeNull()
    expect(genderOfNames(['the Captain'])).toBeNull()
    expect(genderOfNames(['Mr. Grey', 'Miss Grey'])).toBeNull()
  })

  it('finds two women in reach of the green-eyes "She", and one man for "he wore a blue coat"', () => {
    const trap = 'She had green eyes, and in that light they looked almost gold'
    expect(
      rivals(
        trap,
        [sentence(2, `${trap}.`)],
        [
          sentence(1, 'The two women sat close to the window, where the light was best.'),
          named(
            0,
            'Clara Pell called at Wexley on the Thursday, and found Lise alone in the morning room.',
            ['clara', 'Clara Pell'],
            ['lise', 'Lise']
          )
        ]
      ).sort()
    ).toEqual(['clara', 'lise'])
    // "Mr. Harrow's visit" is a possessive: no antecedent of "he".
    expect(
      rivals(
        'that he wore a blue coat',
        [sentence(3, 'The ladies saw that he wore a blue coat.')],
        [
          named(
            0,
            "In a few days Mr. Ashby returned Mr. Harrow's visit.",
            ['ashby', 'Mr. Ashby'],
            ['harrow', 'Mr. Harrow']
          )
        ],
        'clothing'
      )
    ).toEqual(['ashby'])
    // A she skips a sentence that names only a man and looks further back.
    expect(
      rivals(
        'she had a lively disposition',
        [sentence(2, 'For she had a lively disposition.')],
        [
          named(1, 'Mr. Ashby walked off.', ['ashby', 'Mr. Ashby']),
          named(0, 'Lise laughed.', ['lise', 'Lise'])
        ],
        'traits'
      )
    ).toEqual(['lise'])
    // A name of no known gender may be meant by a he or a she; no pronoun, no rivals.
    expect(
      rivals(
        'he smiled',
        [named(0, 'Lottie came in and he smiled.', ['lottie', 'Lottie'])],
        [],
        'traits'
      )
    ).toEqual(['lottie'])
    expect(rivals('Mara had grey eyes', [sentence(0, 'Mara had grey eyes.')], [])).toEqual([])
  })

  it('refuses a he for a woman, never a description or a she', () => {
    const plum = 'When they were children he had kept a sugar plum in his coat'
    expect(pronounOfOtherGender({ quote: plum, names: [], gender: 'female' })).toBe(true)
    expect(pronounOfOtherGender({ quote: plum, names: [], gender: 'male' })).toBe(false)
    expect(pronounOfOtherGender({ quote: plum, names: [], gender: null })).toBe(false)
    expect(pronounOfOtherGender({ quote: 'his wife was ill', names: [], gender: 'female' })).toBe(
      false
    )
    expect(pronounOfOtherGender({ quote: 'he told her so', names: [], gender: 'female' })).toBe(
      false
    )
  })

  it('refuses the one acted on as the doer, never a co-subject or a clause of their own', () => {
    const acts = (slot: string, quote: string, names: string[], others: string[] = []): boolean =>
      actsOnSubject({ slot, quote, names, others })
    expect(acts('history', 'he asked Miss Pell', ['Miss Pell'])).toBe(true)
    expect(
      acts(
        'history',
        'Mr. Ashby does not know the whole of his history, and is quite ignorant of the circumstances which have principally offended Mr. Varrow',
        ['Mr. Varrow'],
        ['Mr. Ashby']
      )
    ).toBe(true)
    expect(
      acts(
        'history',
        'Mrs. Harrow had taken Bel and Lottie to Callow Cross',
        ['Bel'],
        ['Mrs. Harrow']
      )
    ).toBe(true)
    expect(
      acts(
        'history',
        'Johanna and Mr. Ashby had been married two years',
        ['Mr. Ashby'],
        ['Johanna']
      )
    ).toBe(false)
    expect(
      acts('history', 'the spring when Johanna had come down to breakfast', ['Johanna'], ['Lise'])
    ).toBe(false)
    expect(acts('history', 'Mr. Ashby had danced with her twice', ['Mr. Ashby'])).toBe(false)
    expect(acts('traits', "Miss Harrow's pleasing manners", ['Miss Harrow'])).toBe(false)
    expect(
      acts('relation', 'danced only once with Mrs. Lowther', ['Mrs. Lowther'], ['Mr. Varrow'])
    ).toBe(false)
    // Only history, role, relation and traits.
    expect(acts('location', 'he asked Miss Pell', ['Miss Pell'])).toBe(false)
  })

  it('refuses a span of time as an age, never an age said with "over" or "past"', () => {
    expect(
      ageIsSpan('forty years', 'Old Hobb had kept the lodge gate at Thornmere for forty years')
    ).toBe(true)
    expect(ageIsSpan('two years', 'married two years ago')).toBe(true)
    expect(ageIsSpan('three', 'after the last three years')).toBe(true)
    expect(ageIsSpan('eighteen', 'Lottie was eighteen now, and married')).toBe(false)
    expect(ageIsSpan('over forty', 'he was over forty')).toBe(false)
    expect(ageIsSpan('seven-and-twenty', 'Clara Pell was seven-and-twenty')).toBe(false)
  })

  it('refuses a kinship that is the relative, keeping what the subject is to someone', () => {
    const kin = (value: string, quote: string, names: string[] = []): boolean =>
      relativeValue({ slot: 'kinship', value, quote, names })
    expect(kin('second daughter', 'his second daughter')).toBe(true)
    expect(kin('her eldest daughter', 'her eldest daughter')).toBe(true)
    expect(kin('father', "The Captain's father was a merchant in Vellmouth", ['The Captain'])).toBe(
      true
    )
    expect(kin("Lise's cousin", "Anne Fenwick was Lise's cousin", ['Anne Fenwick'])).toBe(false)
    expect(kin('son of a clergyman in Elsdale', 'My father was a clergyman in Elsdale')).toBe(false)
    expect(kin('married', 'Lottie was eighteen now, and married', ['Lottie'])).toBe(false)
    expect(
      relativeValue({ slot: 'history', value: 'father', quote: 'his father', names: [] })
    ).toBe(false)
  })

  it('refuses a relation with nobody to relate to, a remark, or only people', () => {
    const rel = (value: string, objectId: string | null = 'o1'): boolean =>
      relationValue({ slot: 'relation', value, objectId })
    expect(rel('thought her quite beautiful', null)).toBe(true)
    expect(rel('sisters')).toBe(true)
    expect(rel('her sister and Mr. Ashby')).toBe(true)
    expect(rel('his guilt and his descent appear, by your account, to be the same')).toBe(true)
    expect(rel('thought her quite beautiful')).toBe(false)
    expect(rel('did admire Johanna')).toBe(false)
    expect(rel('brother-in-law')).toBe(false)
    expect(rel('friend')).toBe(false)
    expect(relationValue({ slot: 'kinship', value: 'sisters', objectId: null })).toBe(false)
  })
})

describe('the code gates of the fourth live run of 2026-10-14 (plan ReaderNarrow.md)', () => {
  it('finds whose a body or detail value is by the his or her before it', () => {
    const dark = 'the beautiful expression of her dark eyes'
    expect(possessiveOwner('eyes', 'dark', dark)).toBe('female')
    expect(possessiveOwner('eyes', 'grey', 'her eyes were grey')).toBe('female')
    expect(
      possessiveOwner(
        'detail:wealth',
        'having ten thousand a year',
        'of his having ten thousand a year'
      )
    ).toBe('male')
    expect(possessiveOwner('scars', 'long white scar', 'he rubbed his long white scar')).toBe(
      'male'
    )
    // A name's or a person's possessive is nearer: theirs, settled by the name.
    expect(possessiveOwner('hair', 'fair', "Anne's fair hair was pinned up")).toBeNull()
    expect(possessiveOwner('eyes', 'grey', "his wife's eyes were grey")).toBeNull()
    // None before the value, or too far back.
    expect(
      possessiveOwner('eyes', 'a cold, clear grey', "Mr. Varrow's eyes were a cold, clear grey")
    ).toBeNull()
    expect(possessiveOwner('eyes', 'grey', 'her eyes, which were always grey')).toBeNull()
    expect(
      possessiveOwner(
        'scars',
        'a long white scar across his jaw',
        'had a long white scar across his jaw'
      )
    ).toBeNull()
    // Only the body slots and the details.
    expect(possessiveOwner('location', 'dark room', 'her dark room')).toBeNull()
    expect(possessiveOwner('kinship', 'cousin', 'her cousin')).toBeNull()
    expect(['eyes', 'hair', 'scars', 'injuries', 'detail:build'].every(ownedSlot)).toBe(true)
    expect(['age', 'location', 'kinship', 'born', 'alive'].some(ownedSlot)).toBe(false)
  })

  it('settles the one pronoun given, whatever else the quote holds', () => {
    const genders: Record<string, 'female' | 'male' | null> = { varrow: 'male', lise: null }
    const owners = (pronoun: 'female' | 'male'): string[] =>
      pronounRivals({
        slot: 'eyes',
        quote: 'than he began to find it rendered intelligent by the expression of her dark eyes',
        sentences: [
          sentence(
            2,
            'But no sooner had he seen it than he began to find it rendered intelligent by the expression of her dark eyes.'
          )
        ],
        before: [
          named(
            1,
            'Mr. Varrow had at first scarcely allowed Liesel to be pretty.',
            ['varrow', 'Mr. Varrow'],
            ['lise', 'Liesel']
          )
        ],
        isCharacter: () => true,
        genderOf: (id) => genders[id] ?? null,
        pronoun
      })
    // "her": Liesel only; Mr. Varrow is a man.
    expect(owners('female')).toEqual(['lise'])
    // "his" (were it his): both could be (Liesel's gender is unknown here).
    expect(owners('male').sort()).toEqual(['lise', 'varrow'])
  })

  it('looks for a possessive’s owner in its own clause first, then before it', () => {
    const genders: Record<string, 'female' | 'male' | null> = {
      varrow: 'male',
      lowther: 'male',
      ada: 'female',
      tomas: null
    }
    const owners = (quote: string, sentences: LadderSentence[], before: LadderSentence[] = []) =>
      possessiveOwners({
        slot: 'eyes',
        quote,
        sentences,
        before,
        isCharacter: () => true,
        genderOf: (id) => genders[id] ?? null,
        pronoun: quote.includes('her') ? 'female' : 'male'
      })
    const income =
      'His brother-in-law, Mr. Lowther, merely looked the gentleman; but his friend Mr. Varrow drew every eye, and the report of his having ten thousand a year.'
    expect(
      owners('the report of his having ten thousand a year', [
        named(0, income, ['lowther', 'Mr. Lowther'], ['varrow', 'Mr. Varrow'])
      ])
    ).toEqual(['varrow'])
    // Ada is in reach before; Tomas, of no known gender, came in a sentence earlier: only Ada.
    expect(
      owners(
        'Ada turned her grey eyes away',
        [named(1, 'Ada turned her grey eyes away.', ['ada', 'Ada'])],
        [named(0, 'Tomas came in.', ['tomas', 'Tomas'])]
      )
    ).toEqual(['ada'])
    // Two in its clause: no owner settled.
    expect(
      owners('her eyes were grey', [
        named(0, 'Tomas told Ada her eyes were grey.', ['tomas', 'Tomas'], ['ada', 'Ada'])
      ]).sort()
    ).toEqual(['ada', 'tomas'])
    // None in its clause: the nearest sentence before that names one who fits.
    expect(
      owners(
        'the expression of her dark eyes',
        [sentence(1, 'He saw the expression of her dark eyes.')],
        [named(0, 'Mr. Varrow watched Ada.', ['varrow', 'Mr. Varrow'], ['ada', 'Ada'])]
      )
    ).toEqual(['ada'])
  })

  it('takes a location only as a place phrase, never a clause', () => {
    for (const place of [
      'the morning room',
      'Callow Cross',
      'at the head of the table',
      'the back stairs',
      'Thornmere'
    ]) {
      expect(locationPhrase(place), place).toBe(true)
    }
    for (const clause of [
      'near enough for her to overhear a conversation between him and Mr. Ashby',
      "down to dinner on the Captain's arm",
      'at the lodge gate in the rain',
      'the room where she had slept'
    ]) {
      expect(locationPhrase(clause), clause).toBe(false)
    }
    expect(LOCATION_VALUE_MAX_WORDS).toBe(5)
  })

  it('takes a birth only as a when; a place is a birthplace', () => {
    for (const when of [
      'in 1795',
      'in the spring',
      'in March',
      'the year the river froze',
      'young'
    ]) {
      expect(bornIsWhen(when), when).toBe(true)
      expect(valueOfKind('born', when), when).toBe(true)
    }
    for (const place of ['at Gullhaven', 'in Elsdale', 'Vellmouth']) {
      expect(bornIsWhen(place), place).toBe(false)
      expect(valueOfKind('born', place), place).toBe(false)
    }
    expect(valueOfKind('detail:birthplace', 'Elsdale')).toBe(true)
  })

  it('refuses a kinship whose people are all plural: the relatives, not what the subject is', () => {
    const kin = (value: string, quote: string): boolean =>
      relativeValue({ slot: 'kinship', value, quote, names: [] })
    expect(kin('his sisters are fine women', 'His sisters were fine women')).toBe(true)
    expect(kin('sisters', 'she and her sisters')).toBe(true)
    expect(
      kin('mother of four grown-up daughters', 'When a woman has four grown-up daughters')
    ).toBe(false)
    expect(kin('brother-in-law of Mr. Ashby', 'His brother-in-law, Mr. Lowther')).toBe(false)
    expect(kin('husband of Johanna', 'Johanna and Mr. Ashby had been married two years')).toBe(
      false
    )
    expect(kin('married', 'a married man now')).toBe(false)
  })

  it('takes a kinship only from a quote that states a relation', () => {
    for (const quote of [
      'Mr. Dunmore was the son of the late steward at Greyhallow',
      'My father was a clergyman in Elsdale',
      "Anne Fenwick was Lise's cousin",
      'His brother-in-law, Mr. Lowther',
      'Johanna and Mr. Ashby had been married two years',
      'Lottie is to marry Mr. Dunmore'
    ]) {
      expect(kinshipStated(quote), quote).toBe(true)
      expect(valueStated('kinship', 'whatever relation', quote), quote).toBe(true)
    }
    for (const quote of ['my little Lise', 'When a woman has four grown-up daughters']) {
      expect(kinshipStated(quote), quote).toBe(false)
      expect(valueStated('kinship', 'daughter', quote), quote).toBe(false)
    }
    // Alive stays free of the quote's words.
    expect(valueStated('alive', 'dead', 'He died in the night')).toBe(true)
  })
})
