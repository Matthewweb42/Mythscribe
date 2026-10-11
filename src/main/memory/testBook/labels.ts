import type { TestBookLabels } from './labels.schema'

/**
 * What a correct reading of `TEST_BOOK` yields (F-16.3). Quotes are written with straight quotes;
 * the book uses curly ones in the original scenes, and `locateQuote` reads both the same. Every
 * quote here is checked by `testBook.test.ts` to sit exactly once in its scene, in its paragraph.
 *
 * `expect` says how a correct pipeline ends for each claim (design §2.3): `literal` (proved in
 * code), `verified` (proved by `verify.v1`), or `reject` (never stored: it waits, is a negation,
 * or names no one for certain).
 */
export const TEST_BOOK_LABELS: TestBookLabels = {
  records: [
    {
      id: 'harrow-mr',
      name: 'Mr. Harrow',
      kind: 'character',
      aliases: [{ text: 'Mr. Harrow' }, { text: 'Harrow', shared: true }]
    },
    {
      id: 'harrow-mrs',
      name: 'Mrs. Harrow',
      kind: 'character',
      aliases: [{ text: 'Mrs. Harrow' }, { text: 'Harrow', shared: true }]
    },
    {
      id: 'johanna',
      name: 'Johanna Harrow',
      kind: 'character',
      aliases: [
        { text: 'Johanna' },
        { text: 'Johanna Harrow' },
        { text: 'Miss Harrow' },
        { text: 'Jo' }
      ]
    },
    {
      id: 'liesel',
      name: 'Liesel Harrow',
      kind: 'character',
      aliases: [
        { text: 'Liesel' },
        { text: 'Lise' },
        { text: 'Liesel Harrow' },
        { text: 'Miss Liesel' }
      ]
    },
    {
      id: 'bel',
      name: 'Bel Harrow',
      kind: 'character',
      aliases: [{ text: 'Bel' }, { text: 'Bel Harrow' }, { text: 'Isabel' }]
    },
    { id: 'lottie', name: 'Lottie Harrow', kind: 'character', aliases: [{ text: 'Lottie' }] },
    {
      id: 'ashby',
      name: 'Ned Ashby',
      kind: 'character',
      aliases: [{ text: 'Mr. Ashby' }, { text: 'Ashby' }, { text: 'Ned' }]
    },
    {
      id: 'celia',
      name: 'Celia Ashby',
      kind: 'character',
      aliases: [{ text: 'Celia Ashby' }, { text: 'Miss Ashby' }, { text: 'Celia' }]
    },
    {
      id: 'lowther-mr',
      name: 'Mr. Lowther',
      kind: 'character',
      aliases: [{ text: 'Mr. Lowther' }]
    },
    {
      id: 'lowther-mrs',
      name: 'Mrs. Lowther',
      kind: 'character',
      aliases: [{ text: 'Mrs. Lowther' }]
    },
    {
      id: 'varrow',
      name: 'Callum Varrow',
      kind: 'character',
      aliases: [{ text: 'Mr. Varrow' }, { text: 'Varrow' }, { text: 'Callum Varrow' }]
    },
    {
      id: 'pell-sir',
      name: 'Sir Walter Pell',
      kind: 'character',
      aliases: [{ text: 'Sir Walter Pell' }, { text: 'Sir Walter' }]
    },
    { id: 'pell-lady', name: 'Lady Pell', kind: 'character', aliases: [{ text: 'Lady Pell' }] },
    {
      id: 'clara',
      name: 'Clara Pell',
      kind: 'character',
      aliases: [{ text: 'Clara Pell' }, { text: 'Clara' }, { text: 'Miss Pell' }]
    },
    { id: 'tull', name: 'Mrs. Tull', kind: 'character', aliases: [{ text: 'Mrs. Tull' }] },
    { id: 'pocock', name: 'Mrs. Pocock', kind: 'character', aliases: [{ text: 'Mrs. Pocock' }] },
    {
      id: 'dunmore',
      name: 'Mr. Dunmore',
      kind: 'character',
      aliases: [{ text: 'Mr. Dunmore' }, { text: 'Dunmore' }]
    },
    { id: 'pruett', name: 'Mr. Pruett', kind: 'character', aliases: [{ text: 'Mr. Pruett' }] },
    {
      id: 'strand',
      name: 'Lady Agatha Strand',
      kind: 'character',
      aliases: [{ text: 'Lady Agatha Strand' }, { text: 'Lady Agatha' }]
    },
    { id: 'rook', name: 'Mr. Rook', kind: 'character', aliases: [{ text: 'Mr. Rook' }] },
    { id: 'garth', name: 'Mr. Garth', kind: 'character', aliases: [{ text: 'Mr. Garth' }] },
    { id: 'hale', name: 'Colonel Hale', kind: 'character', aliases: [{ text: 'Colonel Hale' }] },
    { id: 'hobb', name: 'Hobb', kind: 'character', aliases: [{ text: 'Hobb' }] },
    {
      // Known only by a title the author confirmed (§2.2 identity rule 2): matched with exact case.
      id: 'captain',
      name: 'the Captain',
      kind: 'character',
      aliases: [{ text: 'the Captain' }]
    },
    {
      id: 'thornmere',
      name: 'Thornmere',
      kind: 'place',
      aliases: [{ text: 'Thornmere' }, { text: 'Thornmere Hall' }]
    },
    { id: 'wexley', name: 'Wexley', kind: 'place', aliases: [{ text: 'Wexley' }] },
    {
      id: 'callow-cross',
      name: 'Callow Cross',
      kind: 'place',
      aliases: [{ text: 'Callow Cross' }]
    },
    { id: 'pell-house', name: 'Pell House', kind: 'place', aliases: [{ text: 'Pell House' }] },
    { id: 'greyhallow', name: 'Greyhallow', kind: 'place', aliases: [{ text: 'Greyhallow' }] },
    { id: 'elsdale', name: 'Elsdale', kind: 'place', aliases: [{ text: 'Elsdale' }] },
    { id: 'the-bell', name: 'The Bell', kind: 'place', aliases: [{ text: 'The Bell' }] },
    { id: 'gullhaven', name: 'Gullhaven', kind: 'place', aliases: [{ text: 'Gullhaven' }] },
    {
      id: 'secret-engagement',
      name: "Lottie's engagement to Mr. Dunmore",
      kind: 'secret',
      aliases: [{ text: "Lottie's engagement" }],
      originator: 'lottie',
      defining: { scene: 'h05', p: 2, quote: 'Mr. Dunmore and I are engaged' }
    }
  ],
  dismissed: ['Michaelmas'],
  claims: [
    {
      id: 'ashby-income',
      scene: 's01',
      p: 13,
      record: 'ashby',
      slot: 'detail:income',
      value: 'seven thousand a year',
      quote: 'A single man of large fortune; seven thousand a year.',
      voice: 'dialogue',
      speaker: 'harrow-mrs',
      mode: 'now',
      expect: 'verified',
      reason:
        "Mrs. Harrow repeats Mrs. Tull's report: stored as her speech, never as narration (changed fact: the novel says four or five thousand)."
    },
    {
      id: 'harrow-traits',
      scene: 's01',
      p: 33,
      record: 'harrow-mr',
      slot: 'traits',
      value: 'quick parts, sarcastic humour, reserve, and caprice',
      quote:
        'Mr. Harrow was so odd a mixture of quick parts, sarcastic humour, reserve, and caprice',
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason: "A trait list inside a comparison ('so odd a mixture … that'), left to the verifier."
    },
    {
      id: 'mrs-harrow-temper',
      scene: 's01',
      p: 33,
      record: 'harrow-mrs',
      slot: 'traits',
      value: 'mean understanding, little information, and uncertain temper',
      quote: 'She was a woman of mean understanding, little information, and uncertain temper',
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason:
        "Pronoun subject: the antecedent span names only Mr. Harrow, and 'his wife' resolves 'She' to Mrs. Harrow."
    },
    {
      id: 'lottie-tallest',
      scene: 's02',
      p: 23,
      record: 'lottie',
      slot: 'traits',
      value: 'the tallest',
      quote: "though I am the youngest, I'm the tallest",
      voice: 'dialogue',
      speaker: 'lottie',
      mode: 'now',
      expect: 'verified',
      reason: "Lottie says it of herself: shown as 'Lottie says…'."
    },
    {
      id: 'ashby-coat',
      scene: 's03',
      p: 2,
      record: 'ashby',
      slot: 'clothing',
      value: 'a blue coat',
      quote: 'that he wore a blue coat and rode a black horse',
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason:
        "Pronoun 'he' resolved to Mr. Ashby by the paragraph's first sentence; clothing is transient ('last stated in s03')."
    },
    {
      id: 'ashby-looks',
      scene: 's03',
      p: 4,
      record: 'ashby',
      slot: 'traits',
      value: 'good-looking and gentlemanlike',
      quote: 'Mr. Ashby was good-looking and gentlemanlike',
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason: 'One name, narration, a plain trait pattern, and no marker word.'
    },
    {
      id: 'varrow-eyes-grey',
      scene: 's03',
      p: 4,
      record: 'varrow',
      slot: 'eyes',
      value: 'grey',
      quote: "Mr. Varrow's eyes were a cold, clear grey",
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason:
        'Possessive name with the eye cue, in narration (changed fact: the novel never gives his eyes). The first half of the planted C1.'
    },
    {
      id: 'varrow-income',
      scene: 's03',
      p: 4,
      record: 'varrow',
      slot: 'detail:income',
      value: 'ten thousand a year',
      quote:
        'the report, which was in general circulation within five minutes after his entrance, of his having ten thousand a year',
      voice: 'rumour',
      mode: 'now',
      expect: 'verified',
      reason: 'A report in general circulation: stored as rumour, never as fact.'
    },
    {
      id: 'varrow-proud',
      scene: 's03',
      p: 5,
      record: 'varrow',
      slot: 'traits',
      value: 'proud, disagreeable',
      quote: 'He was the proudest, most disagreeable man in the world',
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason:
        "Pronoun: the antecedent names Mr. Varrow, Mrs. Lowther and Miss Ashby, and only he fits 'He'."
    },
    {
      id: 'liesel-disposition',
      scene: 's03',
      p: 13,
      record: 'liesel',
      slot: 'traits',
      value: 'lively, playful disposition',
      quote: 'she had a lively, playful disposition, which delighted in anything ridiculous',
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason:
        "Pronoun: the paragraph names Mr. Ashby, Mr. Varrow and Liesel; only Liesel fits 'she'."
    },
    {
      id: 'liesel-eyes-dark',
      scene: 's04',
      p: 4,
      record: 'liesel',
      slot: 'eyes',
      value: 'dark',
      quote: 'the beautiful expression of her dark eyes',
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason:
        "Pronoun 'her' in a sentence about Mr. Varrow's view, resolved to Liesel by the sentence before."
    },
    {
      id: 'dunmore-steward',
      scene: 's05',
      p: 1,
      record: 'dunmore',
      slot: 'kinship',
      value: 'son of the late steward at Greyhallow',
      quote: 'Mr. Dunmore was the son of the late steward at Greyhallow',
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason: 'A kinship cue with one name, in narration. The truth that h02 lies against.'
    },
    {
      id: 'green-eyes-trap',
      scene: 'h01',
      p: 1,
      record: 'clara',
      slot: 'eyes',
      value: 'green',
      quote: 'She had green eyes, and in that light they looked almost gold',
      voice: 'narration',
      mode: 'now',
      expect: 'reject',
      reason:
        'Pronoun trap: two women are in the room (Clara Pell and Lise). The claim waits and is dropped at the next full read; it attaches to neither.'
    },
    {
      id: 'clara-age',
      scene: 'h01',
      p: 6,
      record: 'clara',
      slot: 'age',
      value: 'seven-and-twenty',
      quote: 'Clara Pell was seven-and-twenty',
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason: 'A stated age with one name, in narration.'
    },
    {
      id: 'mother-red-hair',
      scene: 'h01',
      p: 7,
      record: 'harrow-mrs',
      slot: 'hair',
      value: 'red',
      quote: "She remembered her mother's red hair",
      voice: 'narration',
      mode: 'memory',
      expect: 'verified',
      reason: "A memory ('remembered'): stored as remembered; it never sets her hair now."
    },
    {
      id: 'captain-scar',
      scene: 'h02',
      p: 2,
      record: 'captain',
      slot: 'scars',
      value: 'a long white scar across his jaw',
      quote: 'the Captain had a long white scar across his jaw',
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason:
        "The author-confirmed title 'the Captain', matched with exact case, counts as his name."
    },
    {
      id: 'captain-not-blue',
      scene: 'h02',
      p: 3,
      record: 'captain',
      slot: 'eyes',
      value: 'blue',
      quote: "The Captain's eyes were not blue",
      voice: 'narration',
      mode: 'now',
      expect: 'reject',
      reason: "Negation ('not'): never a literal proof, and the value is not blue."
    },
    {
      id: 'captain-slate',
      scene: 'h02',
      p: 3,
      record: 'captain',
      slot: 'eyes',
      value: 'the colour of wet slate',
      quote: 'They were the colour of wet slate',
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason: "Pronoun 'They' is the Captain's eyes in the sentence before."
    },
    {
      id: 'dunmore-clergyman',
      scene: 'h02',
      p: 5,
      record: 'dunmore',
      slot: 'kinship',
      value: 'son of a clergyman in Elsdale',
      quote: 'My father was a clergyman in Elsdale',
      voice: 'dialogue',
      speaker: 'dunmore',
      mode: 'now',
      expect: 'verified',
      reason:
        "Dunmore's own account, a lie: stored as 'Dunmore says…'. It disagrees with s05's narration but raises no C1, because it is speech."
    },
    {
      id: 'harrow-temper',
      scene: 'h03',
      p: 1,
      record: 'harrow-mr',
      slot: 'traits',
      value: 'short temper',
      quote: "Harrow's temper was short that morning",
      voice: 'narration',
      mode: 'now',
      expect: 'reject',
      reason:
        "The bare surname 'Harrow' is shared by Mr. and Mrs. Harrow, and both are in the room: the claim waits, and no question is asked."
    },
    {
      id: 'hobb-dies',
      scene: 'h03',
      p: 3,
      record: 'hobb',
      slot: 'alive',
      value: 'dead',
      quote: 'He died in the night, in his chair by the lodge fire',
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason: 'Pronoun: the sentence before names only Hobb. The first half of the planted C2.'
    },
    {
      id: 'johanna-dream',
      scene: 'h06',
      p: 1,
      record: 'johanna',
      slot: 'alive',
      value: 'dead',
      quote: 'In the dream, Johanna was dead',
      voice: 'narration',
      mode: 'dream',
      expect: 'verified',
      reason: 'A dream: stored as dreamed; it never sets state and never raises C2.'
    },
    {
      id: 'johanna-gentlest',
      scene: 'h07',
      p: 2,
      record: 'johanna',
      slot: 'traits',
      value: 'the gentlest of the four sisters',
      quote: 'Johanna Harrow was the gentlest of the four sisters',
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason: 'One name, narration, no marker (and the changed fact: four sisters).'
    },
    {
      id: 'varrow-duel',
      scene: 'h07',
      p: 5,
      record: 'varrow',
      slot: 'history',
      value: 'fought a duel in Elsdale',
      quote: 'It was said in the town that Mr. Varrow had once fought a duel in Elsdale',
      voice: 'rumour',
      mode: 'now',
      expect: 'verified',
      reason: 'Town talk: stored as rumour, never as a fact.'
    },
    {
      id: 'johanna-age',
      scene: 'h08',
      p: 1,
      record: 'johanna',
      slot: 'age',
      value: 'two-and-twenty',
      quote: 'Johanna was two-and-twenty that spring',
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason: 'A stated age with one name, in narration, in a scene typed 1812.'
    },
    {
      id: 'varrow-eyes-brown',
      scene: 'h09',
      p: 2,
      record: 'varrow',
      slot: 'eyes',
      value: 'brown',
      quote: "Varrow's brown eyes followed her",
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason: 'Possessive name with the eye cue. Proved, and it disagrees with s03: the planted C1.'
    },
    {
      id: 'lottie-age',
      scene: 'h09',
      p: 3,
      record: 'lottie',
      slot: 'age',
      value: 'eighteen',
      quote: 'Lottie was eighteen now',
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason:
        'A stated age after the time skip (typed 1814); consistent with "not yet sixteen" in 1811, so no C4.'
    }
  ],
  mentions: [
    {
      scene: 's01',
      records: [
        'harrow-mr',
        'thornmere',
        'tull',
        'ashby',
        'garth',
        'pell-sir',
        'pell-lady',
        'liesel',
        'johanna',
        'lottie'
      ]
    },
    {
      scene: 's02',
      records: ['harrow-mr', 'harrow-mrs', 'ashby', 'liesel', 'tull', 'bel', 'lottie']
    },
    {
      scene: 's03',
      records: [
        'harrow-mrs',
        'harrow-mr',
        'ashby',
        'pell-lady',
        'pell-sir',
        'thornmere',
        'lowther-mr',
        'varrow',
        'lowther-mrs',
        'celia',
        'liesel',
        'johanna',
        'bel',
        'lottie',
        'wexley',
        'clara',
        'elsdale'
      ]
    },
    {
      scene: 's04',
      records: [
        'wexley',
        'thornmere',
        'johanna',
        'lowther-mrs',
        'celia',
        'liesel',
        'ashby',
        'clara',
        'varrow',
        'pell-sir',
        'callow-cross',
        'hale'
      ]
    },
    {
      scene: 's05',
      records: [
        'liesel',
        'thornmere',
        'dunmore',
        'greyhallow',
        'rook',
        'lottie',
        'varrow',
        'clara',
        'celia',
        'johanna',
        'ashby',
        'pruett',
        'strand',
        'harrow-mrs',
        'pell-lady',
        'pell-sir',
        'callow-cross',
        'wexley'
      ]
    },
    {
      scene: 'h01',
      records: [
        'clara',
        'wexley',
        'liesel',
        'harrow-mrs',
        'bel',
        'lottie',
        'callow-cross',
        'ashby',
        'celia',
        'johanna',
        'varrow'
      ]
    },
    {
      scene: 'h02',
      records: [
        'the-bell',
        'callow-cross',
        'liesel',
        'pocock',
        'gullhaven',
        'captain',
        'dunmore',
        'elsdale',
        'thornmere'
      ]
    },
    {
      scene: 'h03',
      records: ['harrow-mr', 'harrow-mrs', 'thornmere', 'hobb', 'johanna', 'lottie']
    },
    { scene: 'h04', records: ['bel', 'pell-house', 'lottie', 'dunmore', 'clara', 'pell-lady'] },
    { scene: 'h05', records: ['liesel', 'lottie', 'bel', 'dunmore', 'varrow', 'celia'] },
    { scene: 'h06', records: ['liesel', 'wexley', 'johanna', 'varrow', 'lottie'] },
    {
      scene: 'h07',
      records: [
        'callow-cross',
        'johanna',
        'liesel',
        'thornmere',
        'varrow',
        'dunmore',
        'pocock',
        'elsdale',
        'ashby',
        'captain'
      ]
    },
    {
      scene: 'h08',
      records: [
        'lottie',
        'pocock',
        'gullhaven',
        'johanna',
        'dunmore',
        'bel',
        'liesel',
        'ashby',
        'thornmere'
      ]
    },
    {
      scene: 'h09',
      records: [
        'liesel',
        'thornmere',
        'hobb',
        'varrow',
        'lottie',
        'wexley',
        'johanna',
        'ashby',
        'clara'
      ]
    }
  ],
  twinCases: [
    {
      name: 'Lise',
      outcome: 'blocked',
      blockedBy: 'liesel',
      rule: 'alias',
      reason: 'Already an alias of Liesel Harrow.'
    },
    {
      name: 'Liesl',
      outcome: 'blocked',
      blockedBy: 'liesel',
      rule: 'edit',
      reason: "One edit from 'Liesel' (6 letters: one edit allowed)."
    },
    {
      name: 'Varow',
      outcome: 'blocked',
      blockedBy: 'varrow',
      rule: 'edit',
      reason: "One edit from 'Varrow' (6 letters)."
    },
    {
      name: 'Johannah',
      outcome: 'blocked',
      blockedBy: 'johanna',
      rule: 'edit',
      reason: "One edit from 'Johanna' (7 letters)."
    },
    {
      name: 'Dunmoore',
      outcome: 'blocked',
      blockedBy: 'dunmore',
      rule: 'edit',
      reason: "One edit from 'Dunmore' (7 letters) once the title is removed."
    },
    {
      name: 'Callum',
      outcome: 'blocked',
      blockedBy: 'varrow',
      rule: 'wordSubset',
      reason: "A word subset of 'Callum Varrow'."
    },
    {
      name: 'Ash',
      outcome: 'blocked',
      blockedBy: 'ashby',
      rule: 'prefix',
      reason: "A prefix of 'Ashby', a name of 4+ letters."
    },
    {
      name: 'Mrs Harrow',
      outcome: 'blocked',
      blockedBy: 'harrow-mrs',
      rule: 'alias',
      reason: "Titles fold inside the gate: 'Mrs Harrow' matches the alias 'Mrs. Harrow'."
    },
    {
      name: 'Michaelmas',
      outcome: 'blocked',
      rule: 'dismissed',
      reason: 'On the Dismissed list: blocked silently, nothing is asked.'
    },
    {
      name: 'Thornbury',
      outcome: 'new',
      reason: "Shares 'Thorn' with 'Thornmere' but is 3 edits from it (9 letters: two allowed)."
    },
    {
      name: 'Captain Brand',
      outcome: 'new',
      reason: "With the title folded it is 'Brand', which matches no name or alias."
    },
    {
      name: 'Pellham',
      outcome: 'new',
      reason:
        "'Pell' is a prefix of it, not the other way round, and it is 3 edits from 'Pell': a new name."
    }
  ],
  knows: [
    {
      secret: 'secret-engagement',
      learner: 'clara',
      how: 'told',
      from: 'bel',
      scene: 'h04',
      p: 2,
      quote: 'Lottie is to marry Mr. Dunmore'
    },
    {
      secret: 'secret-engagement',
      learner: 'bel',
      how: 'tells',
      from: null,
      scene: 'h04',
      p: 2,
      quote: 'Lottie is to marry Mr. Dunmore'
    },
    {
      secret: 'secret-engagement',
      learner: 'lottie',
      how: 'tells',
      from: null,
      scene: 'h05',
      p: 2,
      quote: 'Mr. Dunmore and I are engaged'
    },
    {
      secret: 'secret-engagement',
      learner: 'bel',
      how: 'told',
      from: 'lottie',
      scene: 'h05',
      p: 2,
      quote: 'Mr. Dunmore and I are engaged'
    },
    {
      secret: 'secret-engagement',
      learner: 'liesel',
      how: 'overheard',
      from: 'lottie',
      scene: 'h05',
      p: 5,
      quote: 'She had overheard every word'
    },
    {
      secret: 'secret-engagement',
      learner: 'johanna',
      how: 'read',
      from: 'lottie',
      scene: 'h08',
      p: 3,
      quote: 'We are engaged, and have been since before Christmas'
    }
  ],
  contradictions: [
    {
      rule: 'C1',
      record: 'varrow',
      a: { scene: 's03', p: 4, quote: "Mr. Varrow's eyes were a cold, clear grey" },
      b: { scene: 'h09', p: 2, quote: "Varrow's brown eyes followed her" },
      reason: 'Eyes are a fixed slot; grey and brown, neither containing the other, both narration.'
    },
    {
      rule: 'C2',
      record: 'hobb',
      a: { scene: 'h03', p: 3, quote: 'He died in the night, in his chair by the lodge fire' },
      b: { scene: 'h09', p: 1, quote: 'Hobb opened the lodge gate for them' },
      reason:
        'Hobb dies in h03 and is Here, opening the gate, in h09, outside any memory or flashback.'
    },
    {
      rule: 'C3',
      record: 'bel',
      a: { scene: 'h04', p: 2, quote: 'Lottie is to marry Mr. Dunmore' },
      b: { scene: 'h05', p: 2, quote: 'Mr. Dunmore and I are engaged' },
      reason:
        'Bel tells Clara the secret in h04, but only learns it from Lottie in h05, which is not a memory.'
    }
  ],
  negatives: [
    {
      scene: 'h06',
      kind: 'state',
      record: 'johanna',
      slot: 'alive',
      reason: 'The dream sets no state: Johanna is never shown as dead.'
    },
    {
      scene: 'h06',
      kind: 'finding',
      rule: 'C2',
      record: 'johanna',
      reason: 'No C2 for Johanna appearing alive after the dream.'
    },
    {
      scene: 'h02',
      kind: 'finding',
      rule: 'C1',
      record: 'dunmore',
      reason: "Dunmore's clergyman father is his own speech: no C1 against s05's narration."
    },
    {
      scene: 'h02',
      kind: 'claim',
      record: 'captain',
      slot: 'eyes',
      reason: "'were not blue' is a negation: no claim that the Captain's eyes are blue."
    },
    {
      scene: 'h02',
      kind: 'record',
      reason: "No new record from the title alone: 'the Captain' is the author's confirmed alias."
    },
    {
      scene: 'h01',
      kind: 'claim',
      record: 'clara',
      slot: 'eyes',
      reason: 'The pronoun trap attaches green eyes to neither woman.'
    },
    {
      scene: 'h01',
      kind: 'state',
      record: 'harrow-mrs',
      slot: 'hair',
      reason: 'A remembered red hair never sets her hair now.'
    },
    {
      scene: 'h03',
      kind: 'claim',
      record: 'harrow-mr',
      slot: 'traits',
      reason: 'The shared surname waits: no temper claim for either Harrow.'
    },
    {
      scene: 'h07',
      kind: 'state',
      record: 'johanna',
      reason: "'If Mr. Ashby came back tomorrow' is hypothetical: no trait or state from it."
    },
    {
      scene: 'h07',
      kind: 'state',
      record: 'varrow',
      slot: 'history',
      reason: 'The duel is town talk: shown as rumour, never as fact or in the prose block.'
    },
    {
      scene: 'h10',
      kind: 'claim',
      reason: 'An inactive draft is never read: no blue eyes, no dead Johanna, no C1 or C2 from it.'
    },
    {
      scene: 'h11',
      kind: 'claim',
      reason: 'An Idea scene is never read: no claim, no record, no finding from it.'
    },
    {
      scene: 'h12',
      kind: 'claim',
      reason:
        "A scene left out of compile is never read: Ashby's engagement and Clara's marriage never happened."
    }
  ]
}
