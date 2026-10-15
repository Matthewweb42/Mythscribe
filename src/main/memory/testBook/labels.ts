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
    },
    {
      // P2b: a group learner (h13).
      id: 'regiment',
      name: 'the regiment',
      kind: 'group',
      aliases: [{ text: 'the regiment' }],
      addedFor: 'P2b'
    },
    {
      id: 'secret-debts',
      name: "the Captain's debts",
      kind: 'secret',
      aliases: [{ text: "the Captain's debts" }],
      originator: 'captain',
      defining: { scene: 'h14', p: 7, quote: 'The Captain owed Mr. Varrow money' },
      addedFor: 'P2b'
    },
    {
      // Its h07 mention is hypothetical, so it opens in h08 and resolves in h09.
      id: 'thread-ashby-return',
      name: "Ashby's return",
      kind: 'thread',
      aliases: [{ text: "Ashby's return" }],
      defining: { scene: 'h08', p: 6, quote: 'he said that he was coming back to Thornmere' },
      addedFor: 'P2b'
    },
    {
      id: 'thread-lottie-match',
      name: "Lottie's match",
      kind: 'thread',
      aliases: [{ text: "Lottie's match" }],
      defining: { scene: 'h04', p: 2, quote: 'Lottie is to marry Mr. Dunmore' },
      addedFor: 'P2b'
    },
    {
      // P4: a new character in h15 with a stated age off her birth year, her hair changing with
      // no word of it, and Pinned notes against the book.
      id: 'anne',
      name: 'Anne Fenwick',
      kind: 'character',
      aliases: [{ text: 'Anne Fenwick' }, { text: 'Miss Fenwick' }, { text: 'Anne' }],
      addedFor: 'P4'
    },
    {
      // P4: remembered (h15), rumoured dead (h15), alive in a flashback (h16).
      id: 'fenwick-father',
      name: 'Mr. Fenwick',
      kind: 'character',
      aliases: [{ text: 'Mr. Fenwick' }],
      addedFor: 'P4'
    },
    {
      // P4 (F-16.29): a thread opened and advanced in s02 and never touched again (Mr. Harrow
      // calls on Mr. Ashby himself): a loose end at the book's end.
      id: 'thread-tull-introduction',
      name: "Mrs. Tull's introduction",
      kind: 'thread',
      aliases: [{ text: "Mrs. Tull's introduction" }],
      defining: { scene: 's02', p: 3, quote: 'Mrs. Tull has promised to introduce him' },
      addedFor: 'P4'
    },
    {
      // P4 (F-16.30): a secret the narration tells the reader (h15) and nobody in the book learns:
      // Check the book lists it.
      id: 'secret-anne-pearls',
      name: "Anne's sold pearls",
      kind: 'secret',
      aliases: [{ text: "Anne's sold pearls" }],
      originator: 'anne',
      defining: {
        scene: 'h15',
        p: 18,
        quote: "Anne had sold her mother's pearls at Vellmouth to pay the painter"
      },
      addedFor: 'P4'
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
      expect: 'verified',
      reason:
        'One name, narration, no marker word; a trait has no cue word, so code cannot tell the slot is right and the verifier confirms it.'
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
      expect: 'verified',
      reason:
        "A kinship cue with one name, in narration, but its sentence goes on with markers ('though he seldom said so'), so the verifier confirms it. The truth that h02 lies against."
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
      expect: 'verified',
      reason:
        "A stated age with one name, in narration; a pluperfect in the sentence's next clause ('had long ago stopped') sends it to the verifier."
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
      expect: 'verified',
      reason:
        "The author-confirmed title 'the Captain', matched with exact case, counts as his name; a pluperfect later in the sentence ('had come by it') sends it to the verifier."
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
      expect: 'verified',
      reason:
        'One name, narration, no marker (and the changed fact: four sisters); a trait goes to the verifier (no cue word).'
    },
    {
      id: 'johanna-muff',
      scene: 'h07',
      p: 1,
      record: 'johanna',
      slot: 'clothing',
      value: 'her muff',
      quote: 'with her hands in her muff',
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason:
        "The sentence names Johanna: what she wears on the walk (added 2026-10-14: the live run stored it, and it is true; the hypothetical's negative is about 'If Mr. Ashby came back tomorrow', not this)."
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
      expect: 'verified',
      reason:
        "A stated age with one name, in narration, in a scene typed 1812; the sentence's next clause has markers ('had learnt', 'without'), so the verifier confirms it."
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
      expect: 'verified',
      reason:
        "Possessive name with the eye cue; a negation later in the sentence ('did not mind it') sends it to the verifier. Proved, and it disagrees with s03: the planted C1."
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
    },
    {
      id: 'captain-farmer',
      scene: 'h14',
      p: 3,
      record: 'captain',
      slot: 'role',
      value: 'a farmer',
      quote: 'He had left the army at last and was a farmer now',
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason:
        "A pronoun subject: the antecedent span names the Captain (h14 ¶0), so the verifier pins it; the Captain's role now."
    },
    {
      id: 'lottie-age-again',
      scene: 'h14',
      p: 11,
      record: 'lottie',
      slot: 'age',
      value: 'nineteen',
      quote: 'Lottie, who was nineteen',
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason:
        'A stated age in a relative clause, a year after h09 ("A year later"): the last stated age as of h14, with no hint since.'
    },
    {
      id: 'anne-location',
      scene: 'h15',
      p: 0,
      record: 'anne',
      slot: 'location',
      value: 'Greyhallow',
      quote: 'Anne Fenwick was at Greyhallow that summer',
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason:
        "Where Anne is in h15; her Pinned page's dated line puts her in Vellmouth then (C6, a transient slot)."
    },
    {
      id: 'anne-hair-dark',
      scene: 'h15',
      p: 2,
      record: 'anne',
      slot: 'hair',
      value: 'dark',
      quote: "Anne's hair was dark under the painter's lamp",
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason:
        'Her hair under the lamp: dark, against fair at dinner with no word of a change (the planted C2 body).'
    },
    {
      id: 'anne-eyes-grey',
      scene: 'h15',
      p: 2,
      record: 'anne',
      slot: 'eyes',
      value: 'grey',
      quote: "Anne's eyes were grey",
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason:
        'Eyes are fixed: grey here against the "Eyes: blue" line on her Pinned page (the planted C6).'
    },
    {
      id: 'anne-born',
      scene: 'h15',
      p: 3,
      record: 'anne',
      slot: 'born',
      value: 'in 1795',
      quote: 'Anne Fenwick was born in 1795',
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason:
        'Born in 1795, in a scene typed 1815, while she is stated to be eighteen (the planted C4 birth).'
    },
    {
      id: 'anne-age',
      scene: 'h15',
      p: 4,
      record: 'anne',
      slot: 'age',
      value: 'eighteen',
      quote: 'Anne Fenwick was eighteen',
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason: 'Eighteen in 1815 against a birth in 1795: two years off (C4 birth).'
    },
    {
      id: 'anne-cousin',
      scene: 'h15',
      p: 5,
      record: 'anne',
      slot: 'kinship',
      value: "Lise's cousin",
      quote: "Anne Fenwick was Lise's cousin",
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      object: 'liesel',
      reason: 'A kinship with a second record (Liesel): the Research page says the same, so no C6.'
    },
    {
      id: 'fenwick-eyes-remembered',
      scene: 'h15',
      p: 6,
      record: 'fenwick-father',
      slot: 'eyes',
      value: 'blue',
      quote: "Anne remembered Mr. Fenwick's blue eyes",
      voice: 'narration',
      mode: 'memory',
      expect: 'verified',
      reason:
        'A remembered eye colour against his Pinned "Eyes: brown": a candidate the judge must rule fine (a memory may be wrong).'
    },
    {
      id: 'fenwick-drowned',
      scene: 'h15',
      p: 7,
      record: 'fenwick-father',
      slot: 'alive',
      value: 'drowned',
      quote: 'Mr. Fenwick had drowned off Vellmouth the winter before',
      voice: 'rumour',
      mode: 'now',
      expect: 'verified',
      reason: 'Village talk: a rumoured death sets no state, so his h16 appearance raises no C2.'
    },
    {
      id: 'lottie-hair-long',
      scene: 'h15',
      p: 8,
      record: 'lottie',
      slot: 'hair',
      value: 'long',
      quote: "Lottie's hair was long that morning",
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason: 'Long in the morning, cut short by dinner with a change sentence: no C2.'
    },
    {
      id: 'lottie-age-seventeen',
      scene: 'h15',
      p: 9,
      record: 'lottie',
      slot: 'age',
      value: 'seventeen',
      quote: 'Lottie was seventeen that June',
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason: 'Seventeen after nineteen in h14: a stated age that falls (the planted C4 falls).'
    },
    {
      id: 'anne-birthplace-lottie',
      scene: 'h15',
      p: 10,
      record: 'anne',
      slot: 'detail:birthplace',
      value: 'Gullhaven',
      quote: 'Miss Fenwick was born at Gullhaven',
      voice: 'dialogue',
      speaker: 'lottie',
      mode: 'now',
      expect: 'verified',
      reason: "Lottie's word: speech only, so with Bel's it is never a C1 candidate."
    },
    {
      id: 'anne-birthplace-bel',
      scene: 'h15',
      p: 11,
      record: 'anne',
      slot: 'detail:birthplace',
      value: 'Elsdale',
      quote: 'Miss Fenwick was born in Elsdale',
      voice: 'dialogue',
      speaker: 'bel',
      mode: 'now',
      expect: 'verified',
      reason:
        "Bel's word against Lottie's: two dialogue values with no narration, never a C1 candidate."
    },
    {
      id: 'lottie-hair-short',
      scene: 'h15',
      p: 12,
      record: 'lottie',
      slot: 'hair',
      value: 'short',
      quote: 'By dinner Lottie had cut her hair short',
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      change: true,
      reason:
        'A change sentence ("had cut"): the claim carries the change flag, so long then short is no C2.'
    },
    {
      id: 'anne-hair-fair',
      scene: 'h15',
      p: 14,
      record: 'anne',
      slot: 'hair',
      value: 'fair',
      quote: "Anne's fair hair was pinned up for the evening",
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason:
        'Fair at dinner after dark under the lamp, with no word of a change (C2 body); the Captain in the sentence sends it to the verifier.'
    },
    {
      id: 'captain-father-merchant',
      scene: 'h15',
      p: 15,
      record: 'captain',
      slot: 'history',
      value: 'father was a merchant in Vellmouth',
      quote: "The Captain's father was a merchant in Vellmouth",
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason:
        "One account of the Captain's father; the next paragraph gives another (the planted C7)."
    },
    {
      id: 'captain-father-clergyman',
      scene: 'h15',
      p: 16,
      record: 'captain',
      slot: 'history',
      value: 'father was a clergyman in Vellmouth',
      quote: "The Captain's father was a clergyman in Vellmouth",
      voice: 'narration',
      mode: 'now',
      expect: 'verified',
      reason:
        'A second account of the same father, both narration: only Check the book pairs them (C7).'
    },
    {
      id: 'fenwick-alive-then',
      scene: 'h16',
      p: 2,
      record: 'fenwick-father',
      slot: 'alive',
      value: 'alive',
      quote: 'In those days Mr. Fenwick was alive',
      voice: 'narration',
      mode: 'now',
      expect: 'literal',
      reason:
        'Alive in the flashback (1811); his Pinned "Dies at Waterloo, 1815." is about the future, so no C6.'
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
    },
    {
      scene: 'h15',
      records: [
        'anne',
        'greyhallow',
        'liesel',
        'fenwick-father',
        'lottie',
        'gullhaven',
        'bel',
        'elsdale',
        'captain'
      ]
    },
    { scene: 'h16', records: ['liesel', 'thornmere', 'hobb', 'fenwick-father'] }
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
      quote: 'Lottie is to marry Mr. Dunmore',
      voice: 'dialogue',
      speaker: 'bel'
    },
    {
      secret: 'secret-engagement',
      learner: 'bel',
      how: 'tells',
      from: null,
      scene: 'h04',
      p: 2,
      quote: 'Lottie is to marry Mr. Dunmore',
      voice: 'dialogue',
      speaker: 'bel'
    },
    {
      secret: 'secret-engagement',
      learner: 'lottie',
      how: 'tells',
      from: null,
      scene: 'h05',
      p: 2,
      quote: 'Mr. Dunmore and I are engaged',
      voice: 'dialogue',
      speaker: 'lottie'
    },
    {
      secret: 'secret-engagement',
      learner: 'bel',
      how: 'told',
      from: 'lottie',
      scene: 'h05',
      p: 2,
      quote: 'Mr. Dunmore and I are engaged',
      voice: 'dialogue',
      speaker: 'lottie'
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
      quote: 'We are engaged, and have been since before Christmas',
      voice: 'dialogue',
      speaker: 'lottie'
    },
    {
      // A group learner, named in its sentence (P2b-D8).
      secret: 'secret-engagement',
      learner: 'regiment',
      how: 'told',
      from: null,
      scene: 'h13',
      p: 4,
      quote: 'By Sunday the whole regiment knew of the engagement'
    },
    {
      // Mrs. Pocock refers to it in her own words: it counts (P2b-D7).
      secret: 'secret-engagement',
      learner: 'pocock',
      how: 'refers',
      from: null,
      scene: 'h13',
      p: 5,
      quote: 'Engaged since before Christmas, and not a word to her own mother',
      voice: 'dialogue',
      speaker: 'pocock'
    },
    {
      secret: 'secret-engagement',
      learner: 'clara',
      how: 'knewBefore',
      from: null,
      scene: 'h13',
      p: 8,
      quote: 'She had known it before any of them'
    },
    {
      secret: 'secret-debts',
      learner: 'harrow-mrs',
      how: 'believesFalse',
      from: null,
      scene: 'h14',
      p: 2,
      quote: 'Mrs. Harrow had decided that he was a man of large fortune'
    },
    {
      secret: 'secret-debts',
      learner: 'liesel',
      how: 'deduced',
      from: null,
      scene: 'h14',
      p: 7,
      quote: 'she put it together'
    },
    {
      secret: 'secret-debts',
      learner: 'johanna',
      how: 'suspects',
      from: null,
      scene: 'h14',
      p: 8,
      quote: 'She had begun to suspect something of the kind herself'
    }
  ],
  threads: [
    {
      // "If Mr. Ashby came back tomorrow": supposed, so it opens nothing.
      thread: 'thread-ashby-return',
      how: 'opens',
      scene: 'h07',
      p: 6,
      quote: 'If Mr. Ashby came back tomorrow',
      voice: 'dialogue',
      mode: 'hypothetical'
    },
    {
      thread: 'thread-ashby-return',
      how: 'opens',
      scene: 'h08',
      p: 6,
      quote: 'he said that he was coming back to Thornmere'
    },
    {
      thread: 'thread-ashby-return',
      how: 'resolves',
      scene: 'h09',
      p: 4,
      quote: 'Johanna and Mr. Ashby had been married two years'
    },
    {
      // Remembered only: listed muted, it moves nothing.
      thread: 'thread-ashby-return',
      how: 'opens',
      scene: 'h13',
      p: 11,
      quote: 'he was coming back to Thornmere at last',
      mode: 'memory'
    },
    {
      thread: 'thread-lottie-match',
      how: 'opens',
      scene: 'h04',
      p: 2,
      quote: 'Lottie is to marry Mr. Dunmore',
      voice: 'dialogue'
    },
    {
      thread: 'thread-lottie-match',
      how: 'advances',
      scene: 'h08',
      p: 3,
      quote: 'We are engaged, and have been since before Christmas',
      voice: 'dialogue'
    },
    {
      thread: 'thread-lottie-match',
      how: 'resolves',
      scene: 'h09',
      p: 3,
      quote: 'Lottie was eighteen now, and married'
    },
    {
      // P4: advanced after h09 resolved it (the planted C5).
      thread: 'thread-lottie-match',
      how: 'advances',
      scene: 'h15',
      p: 13,
      quote: "the lawyers met again over Lottie's match"
    },
    {
      // P4: opened and advanced in one scene, never touched again (a loose end).
      thread: 'thread-tull-introduction',
      how: 'opens',
      scene: 's02',
      p: 3,
      quote: 'Mrs. Tull has promised to introduce him',
      voice: 'dialogue'
    },
    {
      thread: 'thread-tull-introduction',
      how: 'advances',
      scene: 's02',
      p: 11,
      quote: 'it will be impossible for her to introduce him',
      voice: 'dialogue'
    }
  ],
  years: [
    ...(
      ['s01', 's02', 's03', 's04', 's05', 'h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07'] as const
    ).map((scene) => ({ scene, year: 1811, source: 'typed' as const })),
    { scene: 'h08', year: 1812, source: 'typed' },
    {
      // A typed year wins over the hint, and starts the carry again.
      scene: 'h09',
      year: 1814,
      source: 'typed',
      elapsed: { p: 0, quote: 'Three winters later' }
    },
    { scene: 'h13', year: 1814, source: 'carried', from: 'h09' },
    {
      // "A year later" can cross a year: the carry ends, and no year is typed.
      scene: 'h14',
      year: null,
      source: 'unknown',
      hint: 'h14',
      elapsed: { p: 0, quote: 'A year later' }
    },
    // P4: a typed year after h14's unknown one.
    { scene: 'h15', year: 1815, source: 'typed' },
    {
      // P4: a verified flashback card; its typed year is its own and carries nothing.
      scene: 'h16',
      year: 1811,
      source: 'typed',
      flashback: true,
      flashbackQuote: { p: 0, quote: 'Years before, when Lise was a girl' }
    }
  ],
  ages: [
    {
      record: 'johanna',
      scene: 'h08',
      expect: { kind: 'stated', claim: 'johanna-age', since: [] }
    },
    {
      // The hints since are listed, never added up: never "about 25".
      record: 'johanna',
      scene: 'h14',
      expect: { kind: 'stated', claim: 'johanna-age', since: ['h09', 'h14'] }
    },
    {
      // h08's typed 1812 and h09's winters and 1814 are listed since her age in 1811.
      record: 'clara',
      scene: 'h09',
      expect: { kind: 'stated', claim: 'clara-age', since: ['h08', 'h09'] }
    },
    { record: 'lottie', scene: 'h09', expect: { kind: 'stated', claim: 'lottie-age', since: [] } },
    { record: 'lottie', scene: 'h13', expect: { kind: 'stated', claim: 'lottie-age', since: [] } },
    {
      record: 'lottie',
      scene: 'h14',
      expect: { kind: 'stated', claim: 'lottie-age-again', since: [] }
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
      variant: 'dead',
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
    },
    {
      rule: 'C2',
      variant: 'body',
      record: 'anne',
      a: { scene: 'h15', p: 2, quote: "Anne's hair was dark under the painter's lamp" },
      b: { scene: 'h15', p: 14, quote: "Anne's fair hair was pinned up for the evening" },
      reason:
        'Dark under the lamp, fair at dinner, both narration, with no change sentence between.'
    },
    {
      rule: 'C4',
      variant: 'birth',
      record: 'anne',
      a: { scene: 'h15', p: 3, quote: 'Anne Fenwick was born in 1795' },
      b: { scene: 'h15', p: 4, quote: 'Anne Fenwick was eighteen' },
      reason: 'Born in 1795 and eighteen in a scene typed 1815: two years off.'
    },
    {
      rule: 'C4',
      variant: 'falls',
      record: 'lottie',
      a: { scene: 'h14', p: 11, quote: 'Lottie, who was nineteen' },
      b: { scene: 'h15', p: 9, quote: 'Lottie was seventeen that June' },
      reason: 'Nineteen in h14, seventeen later in h15: a stated age falls, outside any flashback.'
    },
    {
      rule: 'C5',
      record: 'thread-lottie-match',
      a: { scene: 'h09', p: 3, quote: 'Lottie was eighteen now, and married' },
      b: { scene: 'h15', p: 13, quote: "the lawyers met again over Lottie's match" },
      reason: "Lottie's match resolved in h09 (married) and advances again in h15."
    },
    {
      rule: 'C6',
      record: 'anne',
      a: { scene: 'h15', p: 2, quote: "Anne's eyes were grey" },
      note: { record: 'anne', quote: 'Eyes: blue' },
      reason: 'Eyes are fixed: grey in the book, blue on her Pinned page.'
    },
    {
      rule: 'C6',
      record: 'anne',
      a: { scene: 'h15', p: 0, quote: 'Anne Fenwick was at Greyhallow that summer' },
      note: { record: 'anne', quote: "Location (from 19.1 'The portrait'): Vellmouth" },
      reason:
        "Location is transient: the note's line is dated to 19.1, where the book has her at Greyhallow."
    },
    {
      rule: 'C7',
      record: 'captain',
      a: { scene: 'h15', p: 15, quote: "The Captain's father was a merchant in Vellmouth" },
      b: { scene: 'h15', p: 16, quote: "The Captain's father was a clergyman in Vellmouth" },
      reason:
        'Two narration accounts of the same father (history): a Check the book candidate only.'
    },
    {
      rule: 'C2',
      variant: 'dead',
      record: 'hobb',
      a: { scene: 'h03', p: 3, quote: 'He died in the night, in his chair by the lodge fire' },
      b: { scene: 'h16', p: 1, quote: 'Hobb stood at the lodge gate in the rain' },
      hidden: true,
      reason:
        'Hobb at the gate after his death, but h16 is a verified flashback: made and hidden, listed by Check the book with Not a flashback?'
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
      candidate: true,
      reason:
        "Dunmore's clergyman father is his own speech: a candidate against s05's narration the judge must rule fine (a lie)."
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
    },
    {
      scene: 'h11',
      kind: 'finding',
      rule: 'C1',
      record: 'liesel',
      slot: 'eyes',
      reason: "The Idea scene's blue eyes are never read: no C1 against the book's."
    },
    {
      scene: 'h11',
      kind: 'finding',
      rule: 'C2',
      record: 'harrow-mr',
      reason: "The Idea scene's death is never read: no C2 for Mr. Harrow on the page after it."
    },
    {
      scene: 'h06',
      kind: 'knows',
      reason: 'A dream: nobody learns anything from it.'
    },
    {
      scene: 'h07',
      kind: 'knows',
      reason:
        'Town talk and a hypothetical ("If Mr. Ashby came back tomorrow"): no counted knows line.'
    },
    {
      scene: 'h14',
      kind: 'knows',
      record: 'harrow-mr',
      secret: 'secret-debts',
      reason:
        'Mr. Harrow is at the table and notices nothing: no knows line for him, and no line says he does not know.'
    },
    {
      scene: 'h14',
      kind: 'knows',
      secret: 'secret-debts',
      reason: 'The cards and the lost estate are town talk: no counted knows line comes from them.'
    },
    {
      scene: 'h14',
      kind: 'state',
      record: 'captain',
      slot: 'detail:wealth',
      reason:
        "Mrs. Harrow's mistaken belief that he has a large fortune sets nothing about the Captain."
    },
    {
      scene: 'h15',
      kind: 'finding',
      rule: 'C2',
      record: 'lottie',
      slot: 'hair',
      reason: 'Long in the morning, cut short by dinner with a change sentence: no C2 body.'
    },
    {
      scene: 'h15',
      kind: 'finding',
      rule: 'C1',
      record: 'anne',
      slot: 'detail:birthplace',
      reason: "Lottie's Gullhaven and Bel's Elsdale are both speech: never a C1 candidate."
    },
    {
      scene: 'h15',
      kind: 'finding',
      rule: 'C7',
      record: 'anne',
      slot: 'detail:birthplace',
      reason: 'Two speech values with no narration: no C7 candidate either.'
    },
    {
      scene: 'h15',
      kind: 'finding',
      rule: 'C2',
      record: 'fenwick-father',
      reason: 'A rumoured drowning sets no state: no C2 dead for his h16 appearance.'
    },
    {
      scene: 'h15',
      kind: 'finding',
      rule: 'C6',
      record: 'fenwick-father',
      slot: 'eyes',
      candidate: true,
      reason:
        'A remembered blue against his Pinned "Eyes: brown": a candidate the judge must rule fine.'
    },
    {
      scene: 'h16',
      kind: 'finding',
      rule: 'C6',
      record: 'fenwick-father',
      slot: 'alive',
      reason:
        'His Pinned "Dies at Waterloo, 1815." is about the future: no C6 against him alive in 1811.'
    },
    {
      scene: 'h15',
      kind: 'finding',
      rule: 'C6',
      record: 'anne',
      slot: 'kinship',
      reason: "The Research page's cousin agrees with the book: no C6."
    }
  ],
  // P3 (F-16.24–F-16.26): what the author wrote on two records' pages, so Ms Scribe has canon
  // notes and the author's ideas to recall.
  pages: [
    {
      record: 'the-bell',
      page: 'pinned',
      lines: ['The Bell is kept by the Widow Marsh, who lets rooms to officers.']
    },
    {
      record: 'captain',
      page: 'ideas',
      lines: ['Perhaps the Captain was married once before, in Ireland.']
    },
    {
      record: 'lottie',
      page: 'ideas',
      lines: ['Maybe Lottie and Mr. Dunmore sail for the Cape in the last chapter.']
    }
  ],
  // P3 (plan §6.1): the questions Ms Scribe is asked, read by the offline replays against the
  // oracle and scored in the live run. `asOf` is the open scene (Now); every one is asked in Ask
  // mode unless `plan`.
  questions: [
    {
      id: 'slot-varrow-eyes',
      question: "Mr. Varrow's eyes?",
      asOf: 'h05',
      kind: 'slot',
      expected: { instant: true, scene: 's03', quoteHas: 'a cold, clear grey' }
    },
    {
      id: 'slot-captain-scar',
      question: 'Does the Captain have a scar?',
      asOf: 'h14',
      kind: 'slot',
      expected: { instant: true, scene: 'h02', quoteHas: 'long white scar' }
    },
    // Plan ReaderNarrow.md (2026-10-14): roles and histories are no longer read into the memory,
    // so the Captain's work since the army is Ms Scribe's to find and quote (it was an instant
    // card from a stored role line until then).
    {
      id: 'open-captain-work',
      question: 'What did the Captain do after he left the army?',
      asOf: 'h14',
      kind: 'open',
      terms: ['army', 'farmer', 'left'],
      expected: { scene: 'h14', quoteHas: 'a farmer now' }
    },
    {
      id: 'slot-lottie-age',
      question: 'How old is Lottie?',
      asOf: 'h09',
      kind: 'slot',
      expected: { instant: true, scene: 'h09', quoteHas: 'eighteen now' }
    },
    {
      id: 'knows-clara',
      question: "Does Clara know about Lottie's engagement to Mr. Dunmore?",
      asOf: 'h05',
      kind: 'knows',
      expected: { instant: true, scene: 'h04', quoteHas: 'Lottie is to marry Mr. Dunmore' }
    },
    {
      // The late edit of 6.1 (Clara's age, below) leaves that scene unsettled, so the card's
      // scoped line can only claim every scene up to 5.1: labelled so, deliberately.
      id: 'who-knows-debts',
      question: "Who knows about the Captain's debts?",
      asOf: 'h14',
      kind: 'whoKnows',
      expected: { instant: true, scene: 'h14', quoteHas: 'she put it together', checkedUpTo: 's05' }
    },
    {
      id: 'who-knows-engagement',
      question: "Who knows about Lottie's engagement to Mr. Dunmore?",
      asOf: 'h14',
      kind: 'whoKnows',
      expected: {
        instant: true,
        scene: 'h04',
        quoteHas: 'Lottie is to marry Mr. Dunmore',
        checkedUpTo: 's05'
      }
    },
    {
      // Grey in 3.1 and brown in 14.1: a fixed slot contested (the planted C1), so no card, and
      // a right answer cites both sides rather than stating one as the fact.
      id: 'lookup-varrow-eyes',
      question: "What colour are Mr. Varrow's eyes?",
      asOf: 'h09',
      kind: 'lookupStale',
      expected: {
        lookup: true,
        scene: 'h09',
        quoteHas: 'brown eyes followed her',
        contested: { scene: 's03', quoteHas: 'a cold, clear grey' }
      }
    },
    {
      // Her age is stated in 13.1, and the years have moved on since: no card, never added up.
      id: 'lookup-johanna-age',
      question: 'How old is Johanna?',
      asOf: 'h14',
      kind: 'lookupStale',
      expected: { lookup: true, scene: 'h08', quoteHas: 'two-and-twenty' }
    },
    {
      // The author changed Clara's age after it was read: the paragraph as it reads now answers.
      id: 'lookup-clara-edited',
      question: 'How old is Clara?',
      asOf: 'h09',
      kind: 'lookupStale',
      edit: { scene: 'h01', p: 6, from: 'seven-and-twenty', to: 'eight-and-twenty' },
      expected: { lookup: true, scene: 'h01', quoteHas: 'eight-and-twenty' }
    },
    {
      id: 'open-lise-overheard',
      question: "How did Lise find out about Lottie's engagement?",
      asOf: 'h14',
      kind: 'open',
      terms: ['overheard', 'engaged', 'landing', 'door'],
      expected: { scene: 'h05', quoteHas: 'She had overheard every word' }
    },
    {
      id: 'open-dunmore-father',
      question: 'What did Mr. Dunmore say about his father?',
      asOf: 'h07',
      kind: 'open',
      terms: ['father', 'clergyman', 'family'],
      expected: { scene: 'h02', quoteHas: 'My father was a clergyman in Elsdale' }
    },
    {
      id: 'open-johanna-wrote',
      question: "Whom did Johanna write to after Lottie's letter?",
      asOf: 'h14',
      kind: 'open',
      terms: ['wrote', 'letter', 'write'],
      expected: { scene: 'h08', quoteHas: 'She wrote instead to Mr. Ashby' }
    },
    {
      // Canon the author keeps on the Bell's Pinned page, never in a scene.
      id: 'open-bell-pinned',
      question: 'Who keeps the Bell at Callow Cross?',
      asOf: 'h14',
      kind: 'open',
      terms: ['kept', 'keeps', 'landlady', 'inn'],
      record: 'the-bell',
      expected: { label: 'notes', quoteHas: 'kept by the Widow Marsh' }
    },
    {
      id: 'ordinal-lise-learns',
      question: "When does Lise first learn of Lottie's engagement?",
      asOf: 'h14',
      kind: 'ordinal',
      terms: ['overheard', 'engaged', 'engagement'],
      expected: { scene: 'h05', quoteHas: 'She had overheard every word' }
    },
    {
      // In book order: 9.1 (Bel tells Clara). Who was told first in the story (Bel, by Lottie,
      // before 9.1) is another question, so this one asks where the book first mentions it.
      id: 'ordinal-engagement-first',
      question: "When is Lottie's engagement first mentioned?",
      asOf: 'h14',
      kind: 'ordinal',
      terms: ['marry', 'engaged', 'engagement'],
      expected: {
        scene: 'h04',
        quoteHas: 'Lottie is to marry Mr. Dunmore',
        also: ['Mr. Dunmore and I are engaged']
      }
    },
    {
      id: 'ordinal-duel',
      question: "When is Mr. Varrow's duel first mentioned?",
      asOf: 'h14',
      kind: 'ordinal',
      terms: ['duel', 'fought'],
      expected: { scene: 'h07', quoteHas: 'fought a duel in Elsdale' }
    },
    {
      // Mr. Harrow notices nothing (h14): no line says he knows, and none may say he does not.
      id: 'absence-harrow-debts',
      question: "Does Mr. Harrow know about the Captain's debts?",
      asOf: 'h14',
      kind: 'absence',
      terms: ['debts', 'owed', 'money'],
      record: 'harrow-mr',
      expected: {}
    },
    {
      // Clara keeps the secret from her mother (h04): Lady Pell never learns it.
      id: 'absence-lady-pell',
      question: "Does Lady Pell know about Lottie's engagement to Mr. Dunmore?",
      asOf: 'h14',
      kind: 'absence',
      terms: ['engaged', 'engagement', 'marry'],
      record: 'pell-lady',
      expected: {}
    },
    {
      id: 'idea-captain-past',
      question: "What was my idea about the Captain's past?",
      asOf: 'h14',
      kind: 'idea',
      record: 'captain',
      expected: { label: 'idea', quoteHas: 'married once before' }
    },
    {
      id: 'idea-lottie',
      question: 'What ideas did I have for Lottie?',
      asOf: 'h14',
      kind: 'idea',
      record: 'lottie',
      expected: { label: 'idea', quoteHas: 'sail for the Cape' }
    },
    {
      id: 'notfound-horse',
      question: 'What was the name of the horse the Captain sold?',
      asOf: 'h14',
      kind: 'notFound',
      terms: ['horse', 'sold', 'named'],
      expected: { notFound: true }
    },
    {
      id: 'notfound-ashby-born',
      question: 'Where was Mr. Ashby born?',
      asOf: 'h14',
      kind: 'notFound',
      terms: ['born', 'birthplace', 'native'],
      expected: { notFound: true }
    },
    {
      // F-5.26: a vague request gets the quick picks.
      id: 'route-better',
      question: 'Make this scene better.',
      asOf: 'h14',
      kind: 'route',
      expected: { action: 'editPass', pass: 'ask', target: 'scene' }
    },
    {
      id: 'route-tighten',
      question: 'Tighten the prose in this scene.',
      asOf: 'h14',
      kind: 'route',
      expected: { action: 'editPass', pass: 'line', target: 'scene' }
    },
    {
      id: 'route-proofread-chapter',
      question: 'Proofread chapter 3.',
      asOf: 'h14',
      kind: 'route',
      expected: { action: 'editPass', pass: 'proofread', target: 'chapter', chapter: '3' }
    },
    {
      id: 'route-what-next',
      question: 'What could happen next?',
      asOf: 'h14',
      kind: 'route',
      expected: { action: 'whatNext' }
    },
    {
      // F-5.26 on the selection: the quick picks, on what is selected (none: the scene).
      id: 'route-polish-selection',
      question: 'Polish this.',
      asOf: 'h14',
      kind: 'route',
      selection:
        'The lane was deep in mud after the rain, but he walked the whole way and arrived with his boots in his hand.',
      expected: { action: 'editPass', pass: 'ask', target: 'selection' }
    },
    {
      // F-5.26's Pacing & structure chip, asked in words.
      id: 'route-pacing',
      question: 'The pacing drags in this scene.',
      asOf: 'h14',
      kind: 'route',
      expected: { action: 'editPass', pass: 'developmental', target: 'scene' }
    },
    {
      // F-5.26's Dialogue chip, asked in words.
      id: 'route-dialogue',
      question: 'Sharpen the dialogue in this scene.',
      asOf: 'h14',
      kind: 'route',
      expected: { action: 'editPass', pass: 'dialogue', target: 'scene' }
    },
    {
      // F-5.26's Editor's notes chip, asked in words.
      id: 'route-editors-notes',
      question: "Give me editor's notes on this scene.",
      asOf: 'h14',
      kind: 'route',
      expected: { action: 'critique' }
    },
    {
      id: 'pin-lottie-sea',
      question: "Add to Lottie's sheet that she hates the sea.",
      asOf: 'h14',
      kind: 'pin',
      record: 'lottie',
      expected: { place: 'pinned', pinText: 'hates the sea' }
    },
    {
      id: 'pin-captain-twin',
      question:
        "Brainstorm: maybe the Captain had a twin brother. Save it as an idea on the Captain's sheet.",
      asOf: 'h14',
      kind: 'pin',
      record: 'captain',
      expected: { place: 'ideas', pinText: 'twin brother' }
    },
    {
      // Canon or an idea? Ms Scribe cannot tell, so the chat asks.
      id: 'pin-lottie-scar',
      question: 'Save this for Lottie: a scar from the fire.',
      asOf: 'h14',
      kind: 'pin',
      record: 'lottie',
      expected: { place: 'ask', pinText: 'a scar from the fire' }
    },
    {
      // Plan mode writes nothing: no sheet line is offered.
      id: 'pin-plan',
      question: "Put on Lottie's sheet that she hates the sea.",
      asOf: 'h14',
      kind: 'pin',
      plan: true,
      record: 'lottie',
      expected: { pinText: 'hates the sea' }
    },
    // Traps (design §2.2, §2.3): only a source that is not the book answers these. The inactive
    // draft (h10) is never indexed or read, so no question can reach it.
    {
      // Only the cut scene (h12, 16.1) marries Clara to Mr. Pruett.
      id: 'trap-clara-married',
      question: 'Whom did Clara Pell marry?',
      asOf: 'h14',
      kind: 'trap',
      terms: ['married', 'marry', 'wedding', 'husband'],
      expected: { notFound: true, trap: 'Pruett' }
    },
    {
      // Only the Idea scene (h11, 15.1) makes the Captain Mr. Varrow's cousin.
      id: 'trap-captain-cousin',
      question: 'Is the Captain related to Mr. Varrow?',
      asOf: 'h14',
      kind: 'trap',
      terms: ['cousin', 'related', 'relation', 'kin'],
      expected: { notFound: true, trap: 'cousin' }
    },
    {
      // Only the Captain's Ideas page has a first marriage: named "your idea", never the book's.
      id: 'trap-captain-married',
      question: 'Has the Captain been married before?',
      asOf: 'h14',
      kind: 'trap',
      terms: ['married', 'wife', 'widower', 'Ireland'],
      record: 'captain',
      expected: { label: 'idea', quoteHas: 'married once before', trap: 'married once before' }
    }
  ],
  // P4 (F-16.27): who the cards put on the page beyond the knows lines' learners.
  presence: [
    { scene: 'h09', record: 'hobb', p: 1, quote: 'Hobb opened the lodge gate for them' },
    { scene: 'h16', record: 'hobb', p: 1, quote: 'Hobb stood at the lodge gate in the rain' },
    {
      scene: 'h16',
      record: 'fenwick-father',
      p: 2,
      quote: 'Mr. Fenwick was alive, and rode over from Vellmouth'
    },
    { scene: 'h15', record: 'anne', p: 0, quote: 'Anne Fenwick was at Greyhallow that summer' },
    { scene: 'h15', record: 'lottie', p: 8, quote: "Lottie's hair was long that morning" }
  ],
  // P4 (F-16.27): the author's notes the contradictions read, on P4 records only (so no P3
  // question's evidence moves) and one Research page.
  notes: [
    { record: 'anne', lines: ['Eyes: blue', "Location (from 19.1 'The portrait'): Vellmouth"] },
    { record: 'fenwick-father', lines: ['Eyes: brown', 'Dies at Waterloo, 1815.'] },
    {
      research: 'The Fenwicks',
      lines: [
        "Anne Fenwick is Lise's cousin on her mother's side.",
        'The Fenwicks keep a house at Vellmouth.'
      ]
    }
  ],
  // P4 (F-16.29): what the book leaves hanging as of its end (h16), worked out by hand: the thread
  // with two steps last touched a window (8 scenes) or more before h16, and each character named
  // in 3 or more scenes and last named that long before it, alive (Hobb is dead), in the order last
  // touched (Ashby's return is resolved, and Lottie's match moved in h15); and the planned card.
  looseEnds: [
    {
      kind: 'thread',
      id: 'thread-tull-introduction',
      last: 's02',
      reason: 'Opened and advanced in s02 and never touched again: a window or more before h16.'
    },
    {
      kind: 'character',
      id: 'pell-sir',
      last: 's05',
      reason: 'Named in s01, s03, s04 and s05, never after: a window (8 scenes) or more before h16.'
    },
    {
      kind: 'character',
      id: 'pell-lady',
      last: 'h04',
      reason: 'Named in s01, s03, s05 and h04, never after.'
    },
    {
      kind: 'character',
      id: 'celia',
      last: 'h05',
      reason: 'Named in s03, s04, s05, h01 and h05, never after.'
    },
    {
      kind: 'planned',
      id: 'h17',
      reason: 'A planned card with no words and no link, before the last drafted scenes.'
    }
  ],
  // P4 (F-16.30): readers learn of Anne's pearls in h15 and no one in the book does; every other
  // secret has a learner.
  secretsNobodyLearns: ['secret-anne-pearls'],
  // F-16.17 (plan ReaderPrecision.md step 1, 2026-10-14): every fact the third live planted-error
  // run (21:35) stored on a sentence no claim label covers, judged from the text alone and strictly
  // (the quote must state the fact of that named person; a trait is a lasting quality, never one
  // act or one evening's mood; a rumour or someone's opinion stored as narration is wrong). `call`
  // marks the judgment calls listed for the author in QUESTIONS.md.
  storedVerdicts: [
    {
      scene: 's02',
      p: 0,
      record: 'harrow-mr',
      slot: 'history',
      value: 'waited on Mr. Ashby',
      quote: 'Mr. Harrow was among the earliest of those who waited on Mr. Ashby.',
      right: true,
      reason: 'Named, narration, a past act of his.'
    },
    {
      scene: 's02',
      p: 0,
      record: 'harrow-mr',
      slot: 'kinship',
      value: 'second daughter',
      quote: 'his second daughter',
      right: false,
      reason: 'The daughter is the relative: "second daughter" is Liesel, not what Mr. Harrow is.'
    },
    {
      scene: 's03',
      p: 3,
      record: 'harrow-mrs',
      slot: 'traits',
      value: 'quite disconcerted',
      quote: 'Mrs. Harrow was quite disconcerted.',
      right: false,
      call: true,
      reason: 'A passing state at one letter, not a lasting quality.'
    },
    {
      scene: 's03',
      p: 3,
      record: 'thornmere',
      slot: 'location',
      value: 'Thornmere',
      quote: 'never settled at Thornmere as he ought to be',
      right: false,
      reason: 'A place as the subject of a location; the sentence is about Mr. Ashby.'
    },
    {
      scene: 's03',
      p: 3,
      record: 'ashby',
      slot: 'history',
      value: 'brought only six with him from Vellmouth, his five sisters and a cousin',
      quote:
        'instead of twelve, he had brought only six with him from Vellmouth, his five sisters and a cousin',
      right: false,
      call: true,
      reason:
        'A report the girls heard ("by hearing that"), not narration, and the next sentence says five came.'
    },
    {
      scene: 's03',
      p: 4,
      record: 'ashby',
      slot: 'traits',
      value: 'pleasant countenance, and easy, unaffected manners',
      quote: 'he had a pleasant countenance, and easy, unaffected manners',
      right: true,
      reason: '"he" is Mr. Ashby, named at the start of the sentence.'
    },
    {
      scene: 's03',
      p: 4,
      record: 'lowther-mr',
      slot: 'relation',
      value: 'brother-in-law',
      quote: 'His brother-in-law, Mr. Lowther',
      right: true,
      call: true,
      reason:
        "Mr. Lowther is named as Mr. Ashby's brother-in-law (the stored object is not in the report)."
    },
    {
      scene: 's03',
      p: 4,
      record: 'lowther-mr',
      slot: 'traits',
      value: 'merely looked the gentleman',
      quote: 'merely looked the gentleman',
      right: true,
      call: true,
      reason: 'Narration of how he is; the quote leaves his name out but the clause is his.'
    },
    {
      scene: 's03',
      p: 4,
      record: 'varrow',
      slot: 'detail:height',
      value: 'fine, tall person',
      quote: 'his fine, tall person',
      right: true,
      reason: 'Narration: his tall person.'
    },
    {
      scene: 's03',
      p: 4,
      record: 'varrow',
      slot: 'detail:wealth',
      value: 'ten thousand a year',
      quote:
        'the report, which was in general circulation within five minutes after his entrance, of his having ten thousand a year',
      voice: 'narration',
      right: false,
      call: true,
      reason: 'A report in circulation, stored as narration: it should be a rumour.'
    },
    {
      scene: 's03',
      p: 4,
      record: 'varrow',
      slot: 'detail:build',
      value: 'fine figure of a man',
      quote: 'a fine figure of a man',
      right: false,
      call: true,
      reason:
        'What the gentlemen pronounced, an opinion, stored as narration; the quote does not name him.'
    },
    {
      scene: 's03',
      p: 4,
      record: 'varrow',
      slot: 'traits',
      value: 'above his company',
      quote: 'above his company',
      right: true,
      call: true,
      reason: 'Narration says he was discovered to be above his company.'
    },
    {
      scene: 's03',
      p: 4,
      record: 'varrow',
      slot: 'detail:home',
      value: 'Elsdale',
      quote: 'not all his large estate in Elsdale',
      right: false,
      call: true,
      reason: 'An estate in Elsdale is what he owns; the text never says he lives there.'
    },
    {
      scene: 's03',
      p: 5,
      record: 'ashby',
      slot: 'traits',
      value: 'lively and unreserved',
      quote: 'he was lively and unreserved',
      right: true,
      reason: '"he" is Mr. Ashby, named at the start of the sentence.'
    },
    {
      scene: 's03',
      p: 5,
      record: 'ashby',
      slot: 'history',
      value: 'talked of giving one himself at Thornmere',
      quote: 'talked of giving one himself at Thornmere',
      right: true,
      reason: 'His act, in his sentence.'
    },
    {
      scene: 's03',
      p: 5,
      record: 'varrow',
      slot: 'history',
      value: 'speaking occasionally to one of his own party',
      quote: 'speaking occasionally to one of his own party',
      right: true,
      reason: 'His act, in his sentence.'
    },
    {
      scene: 's03',
      p: 5,
      record: 'harrow-mrs',
      slot: 'traits',
      value: 'most violent against him',
      quote: 'Amongst the most violent against him was Mrs. Harrow',
      right: false,
      call: true,
      reason: 'Her feeling towards Mr. Varrow: a relation, not a lasting quality of hers.'
    },
    {
      scene: 's03',
      p: 5,
      record: 'harrow-mrs',
      slot: 'traits',
      value: 'dislike of his general behaviour sharpened into particular resentment',
      quote: 'whose dislike of his general behaviour was sharpened into particular resentment',
      right: false,
      call: true,
      reason: 'Her feeling towards Mr. Varrow: a relation, not a lasting quality of hers.'
    },
    {
      scene: 's03',
      p: 14,
      record: 'harrow-mrs',
      slot: 'kinship',
      value: 'her eldest daughter',
      quote: 'her eldest daughter',
      right: false,
      reason: 'The daughter is the relative (Johanna), not what Mrs. Harrow is.'
    },
    {
      scene: 's03',
      p: 14,
      record: 'ashby',
      slot: 'history',
      value: 'Mr. Ashby had danced with her twice',
      quote: 'Mr. Ashby had danced with her twice',
      right: true,
      reason: 'Named, narration, his act.'
    },
    {
      scene: 's03',
      p: 14,
      record: 'liesel',
      slot: 'history',
      value: 'she had been distinguished by his sisters',
      quote: 'she had been distinguished by his sisters',
      right: false,
      reason: 'Wrong person: "she" is the eldest daughter, Johanna.'
    },
    {
      scene: 's03',
      p: 16,
      record: 'johanna',
      slot: 'traits',
      value: 'admired',
      quote: 'Johanna was so admired',
      right: false,
      call: true,
      reason: "One evening in her mother's words, not a lasting quality."
    },
    {
      scene: 's03',
      p: 16,
      record: 'ashby',
      slot: 'relation',
      value: 'thought her quite beautiful',
      quote: 'Mr. Ashby thought her quite beautiful',
      right: true,
      reason: 'Mrs. Harrow says it (stored as dialogue); "her" is Johanna.'
    },
    {
      scene: 's03',
      p: 16,
      record: 'clara',
      slot: 'history',
      value: 'asked Miss Pell',
      quote: 'he asked Miss Pell',
      right: false,
      reason: 'Wrong person: he (Mr. Ashby) asked; Miss Pell only was asked.'
    },
    {
      scene: 's03',
      p: 16,
      record: 'johanna',
      slot: 'history',
      value: 'asked her for the two next',
      quote: 'asked her for the two next',
      right: false,
      reason: 'Wrong person: Mr. Ashby asked her.'
    },
    {
      scene: 's03',
      p: 18,
      record: 'liesel',
      slot: 'relation',
      value: 'does not lose much by not suiting his fancy',
      quote: 'Lise does not lose much by not suiting his fancy',
      right: false,
      call: true,
      reason: "Mrs. Harrow's opinion, no relation of Liesel's."
    },
    {
      scene: 's04',
      p: 0,
      record: 'johanna',
      slot: 'traits',
      value: 'pleasing manners',
      quote: "Miss Harrow's pleasing manners",
      right: true,
      reason: 'Named, narration, a lasting quality.'
    },
    {
      scene: 's04',
      p: 1,
      record: 'ashby',
      slot: 'relation',
      value: 'did admire Johanna',
      quote: 'Mr. Ashby did admire Johanna',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 's04',
      p: 4,
      record: 'varrow',
      slot: 'traits',
      value: 'critical',
      quote:
        'he had detected with a critical eye more than one failure of perfect symmetry in her form',
      right: false,
      call: true,
      reason: 'How he looked at her once, not a lasting quality.'
    },
    {
      scene: 's04',
      p: 11,
      record: 'ashby',
      slot: 'role',
      value: 'join the group',
      quote: 'on seeing Mr. Ashby join the group',
      right: false,
      reason: 'An act, no role.'
    },
    {
      scene: 's05',
      p: 15,
      record: 'liesel',
      slot: 'relation',
      value: 'sisters',
      quote: 'she and her sisters',
      right: false,
      reason: 'No relation to anyone named: a junk relation line.'
    },
    {
      scene: 's05',
      p: 18,
      record: 'liesel',
      slot: 'relation',
      value: 'her sister and Mr. Ashby',
      quote: 'her sister and Mr. Ashby',
      right: false,
      reason: 'The people Sir Walter glances at, no relation of hers.'
    },
    {
      scene: 's05',
      p: 20,
      record: 'liesel',
      slot: 'relation',
      value: 'his guilt and his descent appear, by your account, to be the same',
      quote: 'His guilt and his descent appear, by your account, to be the same',
      right: false,
      reason: 'A remark, no relation.'
    },
    {
      scene: 's05',
      p: 21,
      record: 'varrow',
      slot: 'history',
      value:
        'Mr. Ashby does not know the whole of his history, and is quite ignorant of the circumstances which have principally offended Mr. Varrow',
      quote:
        'Mr. Ashby does not know the whole of his history, and is quite ignorant of the circumstances which have principally offended Mr. Varrow',
      right: false,
      reason:
        "Johanna's speech about Mr. Ashby's ignorance, stored as narration and as Mr. Varrow's history."
    },
    {
      scene: 's05',
      p: 22,
      record: 'pruett',
      slot: 'traits',
      value: 'exultation',
      quote:
        'told her with great exultation that he had just been so fortunate as to make an important discovery',
      right: false,
      call: true,
      reason: "One moment's feeling, not a lasting quality."
    },
    {
      scene: 's05',
      p: 24,
      record: 'johanna',
      slot: 'relation',
      value: 'to be married to Mr. Ashby',
      quote: 'Johanna would soon be married to Mr. Ashby',
      right: false,
      reason: "Mrs. Harrow's expectation, a hypothetical, stored as now."
    },
    {
      scene: 'h01',
      p: 0,
      record: 'liesel',
      slot: 'location',
      value: 'Wexley',
      quote:
        'Clara Pell called at Wexley on the Thursday, and found Lise alone in the morning room',
      right: true,
      call: true,
      reason: 'Clara found Lise in the morning room at Wexley.'
    },
    {
      scene: 'h01',
      p: 2,
      record: 'harrow-mrs',
      slot: 'location',
      value: 'Callow Cross',
      quote: 'Mrs. Harrow had taken Bel and Lottie to Callow Cross',
      right: true,
      reason: 'Named, narration, she went there.'
    },
    {
      scene: 'h01',
      p: 2,
      record: 'bel',
      slot: 'location',
      value: 'Callow Cross',
      quote: 'Mrs. Harrow had taken Bel and Lottie to Callow Cross',
      right: true,
      reason: 'Named, narration, taken there.'
    },
    {
      scene: 'h01',
      p: 2,
      record: 'lottie',
      slot: 'location',
      value: 'Callow Cross',
      quote: 'Mrs. Harrow had taken Bel and Lottie to Callow Cross',
      right: true,
      reason: 'Named, narration, taken there.'
    },
    {
      scene: 'h01',
      p: 7,
      record: 'harrow-mrs',
      slot: 'history',
      value: 'had once laughed at a ball until she cried',
      quote: 'how Mrs. Harrow had once laughed at a ball until she cried',
      right: true,
      call: true,
      reason:
        'Her past act, as Lise remembers it (stored as now; for history the remembering changes nothing).'
    },
    {
      scene: 'h03',
      p: 3,
      record: 'hobb',
      slot: 'age',
      value: 'forty years',
      quote: 'Old Hobb had kept the lodge gate at Thornmere for forty years',
      right: false,
      reason: 'How long he kept the gate, not his age.'
    },
    {
      scene: 'h03',
      p: 6,
      record: 'johanna',
      slot: 'history',
      value:
        'When they were children he had kept a sugar plum in his coat for whichever of them reached the gate first',
      quote:
        'When they were children he had kept a sugar plum in his coat for whichever of them reached the gate first',
      right: false,
      reason: 'Wrong person: "he" is Hobb.'
    },
    {
      scene: 'h03',
      p: 8,
      record: 'harrow-mr',
      slot: 'history',
      value: 'would ride over to Thornmere himself in the afternoon',
      quote: 'he would ride over to Thornmere himself in the afternoon',
      right: false,
      call: true,
      reason: 'A plan he states, no past event.'
    },
    {
      scene: 'h04',
      p: 2,
      record: 'lottie',
      slot: 'kinship',
      value: 'to marry Mr. Dunmore',
      quote: 'Lottie is to marry Mr. Dunmore',
      right: false,
      reason: 'Bel says it (stored as narration), and an engagement is no kinship yet.'
    },
    {
      scene: 'h05',
      p: 0,
      record: 'liesel',
      slot: 'location',
      value: 'the back stairs',
      quote: 'Lise came up the back stairs',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h05',
      p: 6,
      record: 'lottie',
      slot: 'age',
      value: 'not yet sixteen',
      quote: 'Lottie, who was not yet sixteen',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h05',
      p: 8,
      record: 'lottie',
      slot: 'traits',
      value: 'all smiles',
      quote: 'At dinner Lottie was all smiles',
      right: false,
      call: true,
      reason: "One dinner's mood, not a lasting quality."
    },
    {
      scene: 'h07',
      p: 9,
      record: 'captain',
      slot: 'location',
      value: 'the bridge',
      quote: 'On the way home they passed the Captain on the bridge.',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h09',
      p: 0,
      record: 'liesel',
      slot: 'history',
      value: 'Three winters later, Lise came back to Thornmere as a guest',
      quote: 'Three winters later, Lise came back to Thornmere as a guest',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h09',
      p: 0,
      record: 'liesel',
      slot: 'location',
      value: 'Thornmere',
      quote: 'Lise came back to Thornmere as a guest',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h09',
      p: 0,
      record: 'liesel',
      slot: 'role',
      value: 'guest',
      quote: 'as a guest',
      right: true,
      call: true,
      reason: 'Her position on this visit, in her sentence (the quote leaves her name out).'
    },
    {
      scene: 'h09',
      p: 1,
      record: 'hobb',
      slot: 'role',
      value: 'opened the lodge gate',
      quote: 'Hobb opened the lodge gate for them',
      right: false,
      call: true,
      reason: 'An act, no role.'
    },
    {
      scene: 'h09',
      p: 2,
      record: 'varrow',
      slot: 'location',
      value: 'the steps',
      quote: 'Mr. Varrow was waiting on the steps',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h09',
      p: 3,
      record: 'lottie',
      slot: 'kinship',
      value: 'married',
      quote: 'Lottie was eighteen now, and married',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h09',
      p: 4,
      record: 'johanna',
      slot: 'kinship',
      value: 'married',
      quote: 'Johanna and Mr. Ashby had been married two years',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h09',
      p: 4,
      record: 'johanna',
      slot: 'history',
      value: 'Johanna and Mr. Ashby had been married two years',
      quote: 'Johanna and Mr. Ashby had been married two years',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h09',
      p: 4,
      record: 'ashby',
      slot: 'kinship',
      value: 'married',
      quote: 'Johanna and Mr. Ashby had been married two years',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h09',
      p: 4,
      record: 'ashby',
      slot: 'history',
      value: 'had been married two years',
      quote: 'Johanna and Mr. Ashby had been married two years',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h09',
      p: 4,
      record: 'ashby',
      slot: 'detail:build',
      value: 'grown a little stouter',
      quote: 'Ashby had grown a little stouter',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h09',
      p: 5,
      record: 'ashby',
      slot: 'location',
      value: 'the hall',
      quote: 'handing her into the hall',
      right: false,
      call: true,
      reason: 'She is handed into the hall; the quote does not put him there.'
    },
    {
      scene: 'h13',
      p: 0,
      record: 'dunmore',
      slot: 'traits',
      value: 'a married man now and very pleased with himself',
      quote: 'Mr. Dunmore came with it, a married man now and very pleased with himself',
      right: true,
      call: true,
      reason: 'True of him, though "a married man" is kinship rather than a trait.'
    },
    {
      scene: 'h13',
      p: 3,
      record: 'lottie',
      slot: 'history',
      value: 'written to a friend at Gullhaven',
      quote: 'Lottie had written to a friend at Gullhaven',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h13',
      p: 6,
      record: 'lottie',
      slot: 'traits',
      value: 'very happy now on most days of the week',
      quote: 'Lottie was very happy now, which was true on most days of the week',
      right: true,
      call: true,
      reason: 'Lise says it and the narration confirms it for most days.'
    },
    {
      scene: 'h13',
      p: 10,
      record: 'liesel',
      slot: 'location',
      value: 'the doorway',
      quote: 'Lise waited in the doorway',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h13',
      p: 11,
      record: 'ashby',
      slot: 'history',
      value: 'had once taken rooms',
      quote: 'the house on the green where Mr. Ashby had once taken rooms',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h13',
      p: 11,
      record: 'johanna',
      slot: 'history',
      value:
        'had come down to breakfast pale from a sleepless night to say that he was coming back to Thornmere at last',
      quote:
        'Johanna had come down to breakfast pale from a sleepless night to say that he was coming back to Thornmere at last',
      right: true,
      reason: "Named, Lise's memory, stored as memory."
    },
    {
      scene: 'h14',
      p: 0,
      record: 'captain',
      slot: 'alive',
      value: 'alive',
      quote: 'the Captain came to dine at Wexley',
      right: true,
      reason: 'He comes to dine.'
    },
    {
      scene: 'h14',
      p: 0,
      record: 'captain',
      slot: 'history',
      value: 'came to dine at Wexley',
      quote: 'the Captain came to dine at Wexley',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h14',
      p: 0,
      record: 'captain',
      slot: 'location',
      value: 'Wexley',
      quote: 'the Captain came to dine at Wexley',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h14',
      p: 1,
      record: 'captain',
      slot: 'history',
      value: 'walked the whole way and arrived with his boots in his hand',
      quote: 'he walked the whole way and arrived with his boots in his hand',
      right: true,
      reason: '"he" is the Captain, the only man in reach.'
    },
    {
      scene: 'h14',
      p: 1,
      record: 'captain',
      slot: 'clothing',
      value: 'his boots in his hand',
      quote: 'he walked the whole way and arrived with his boots in his hand',
      right: false,
      call: true,
      reason: 'Boots carried in his hand are not worn: objects, not clothing.'
    },
    {
      scene: 'h14',
      p: 3,
      record: 'captain',
      slot: 'history',
      value: 'left the army at last and was a farmer now',
      quote: 'He had left the army at last and was a farmer now',
      right: true,
      reason: '"He" is the Captain.'
    },
    {
      scene: 'h14',
      p: 4,
      record: 'harrow-mr',
      slot: 'traits',
      value: 'noticed nothing at all',
      quote:
        'Mr. Harrow sat at the head of the table and talked to the Captain about the price of corn, and noticed nothing at all.',
      right: false,
      call: true,
      reason: 'What he did that evening, not a lasting quality.'
    },
    {
      scene: 'h14',
      p: 4,
      record: 'harrow-mr',
      slot: 'location',
      value: 'at the head of the table',
      quote: 'Mr. Harrow sat at the head of the table',
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h14',
      p: 5,
      record: 'varrow',
      slot: 'history',
      value: 'his name came up',
      quote: "when Mr. Varrow's name came up",
      right: false,
      reason: 'Nothing he did or was: his name mentioned by others.'
    },
    {
      scene: 'h14',
      p: 5,
      record: 'liesel',
      slot: 'traits',
      value: 'noticed a great deal',
      quote: 'Lise noticed a great deal.',
      right: false,
      call: true,
      reason: 'What she did that evening, not a lasting quality.'
    },
    {
      scene: 'h14',
      p: 5,
      record: 'captain',
      slot: 'objects',
      value: 'his glass',
      quote: 'he set his glass down',
      right: true,
      reason: '"he" is the Captain; a glass he holds.'
    },
    {
      scene: 'h14',
      p: 7,
      record: 'liesel',
      slot: 'traits',
      value: 'put it together',
      quote: 'she put it together',
      right: false,
      call: true,
      reason: 'One act, not a lasting quality.'
    },
    {
      scene: 'h14',
      p: 7,
      record: 'captain',
      slot: 'traits',
      value: 'owed Mr. Varrow money',
      quote: 'The Captain owed Mr. Varrow money',
      right: false,
      call: true,
      reason: 'A debt (a secret and a relation), not a quality of his.'
    },
    {
      scene: 'h14',
      p: 8,
      record: 'johanna',
      slot: 'traits',
      value: 'missed very little',
      quote: 'Johanna, who missed very little',
      right: true,
      reason: 'Named, narration, a lasting quality.'
    },
    {
      scene: 'h14',
      p: 11,
      record: 'lottie',
      slot: 'history',
      value: 'expecting her first child',
      quote: 'expecting her first child',
      right: true,
      reason: 'In her sentence ("Lottie, who was nineteen and expecting her first child").'
    },
    {
      scene: 'h14',
      p: 12,
      record: 'captain',
      slot: 'role',
      value: 'the Captain',
      quote: 'the Captain took his leave',
      right: false,
      reason: 'His name, not a role: he has left the army (h14 ¶3).'
    },
    {
      scene: 'h15',
      p: 0,
      record: 'anne',
      slot: 'detail:occupation',
      value: 'sitting for her portrait',
      quote: 'sitting for her portrait',
      right: false,
      reason: 'What she is doing that summer, not her occupation.'
    },
    {
      scene: 'h15',
      p: 6,
      record: 'fenwick-father',
      slot: 'history',
      value: 'laughed at her first portrait',
      quote: 'laughed at her first portrait',
      right: true,
      reason: 'His past act, as Anne remembers it.'
    },
    {
      scene: 'h15',
      p: 7,
      record: 'fenwick-father',
      slot: 'history',
      value: 'drowned off Vellmouth the winter before',
      quote: 'Mr. Fenwick had drowned off Vellmouth the winter before',
      right: false,
      reason: '"It was said in the village": a rumour, stored as narration.'
    },
    {
      scene: 'h15',
      p: 15,
      record: 'captain',
      slot: 'kinship',
      value: 'father',
      quote: "The Captain's father was a merchant in Vellmouth",
      right: false,
      reason: 'The father is the relative: "father" is not what the Captain is.'
    },
    {
      scene: 'h15',
      p: 15,
      record: 'captain',
      slot: 'objects',
      value: 'a warehouse full of tea',
      quote: 'had left him a warehouse full of tea',
      right: true,
      reason: 'Left to him: a thing he owns.'
    },
    {
      scene: 'h15',
      p: 18,
      record: 'anne',
      slot: 'history',
      value: "had sold her mother's pearls at Vellmouth to pay the painter",
      quote: "Anne had sold her mother's pearls at Vellmouth to pay the painter",
      right: true,
      reason: 'Named, narration.'
    },
    {
      scene: 'h16',
      p: 1,
      record: 'hobb',
      slot: 'traits',
      value: 'stood at the lodge gate in the rain and lifted his hat to the carriage',
      quote: 'stood at the lodge gate in the rain and lifted his hat to the carriage',
      right: false,
      reason: 'One act, not a lasting quality.'
    },
    // Plan ReaderNarrow.md step 3 (2026-10-14): every fact the fourth live run (two readings,
    // 2026-10-15T02:37 and 02:47 UTC) stored in a slot still read on a sentence no label or
    // verdict judged, judged the same strict way. Its facts in the slots no longer read are left
    // out of the bar and not judged here.
    {
      scene: 's01',
      p: 19,
      record: 'harrow-mrs',
      slot: 'kinship',
      value: 'mother of four grown-up daughters',
      quote: 'When a woman has four grown-up daughters',
      right: false,
      call: true,
      reason:
        'Her own words, but of "a woman" in general: the quote does not say it of her (true in the book, said elsewhere).'
    },
    {
      scene: 's01',
      p: 24,
      record: 'liesel',
      slot: 'kinship',
      value: 'daughter',
      quote: 'my little Lise',
      right: false,
      call: true,
      reason:
        'No relation word in the quote: "my little Lise" says she is dear to Mr. Harrow, not that she is his daughter.'
    },
    {
      scene: 'h01',
      p: 0,
      record: 'liesel',
      slot: 'location',
      value: 'the morning room',
      quote: 'found Lise alone in the morning room',
      right: true,
      reason: 'Named, narration: where she is.'
    },
    {
      scene: 'h13',
      p: 0,
      record: 'dunmore',
      slot: 'kinship',
      value: 'married man now',
      quote: 'a married man now',
      right: true,
      reason:
        'Mr. Dunmore, named in the sentence, narration: "married" is a kinship the slot holds.'
    },
    {
      scene: 'h15',
      p: 10,
      record: 'anne',
      slot: 'born',
      value: 'at Gullhaven',
      quote: 'Miss Fenwick was born at Gullhaven',
      right: false,
      reason: 'A birthplace in the born slot, which holds when (where is detail:birthplace).'
    },
    {
      scene: 'h15',
      p: 11,
      record: 'anne',
      slot: 'born',
      value: 'in Elsdale',
      quote: 'Miss Fenwick was born in Elsdale',
      right: false,
      reason: 'A birthplace in the born slot, which holds when (where is detail:birthplace).'
    },
    {
      scene: 's03',
      p: 4,
      record: 'ashby',
      slot: 'kinship',
      value: 'his sisters are fine women',
      quote: 'His sisters were fine women',
      right: false,
      reason: 'His relatives and a remark on them, not what he is to anyone.'
    },
    {
      scene: 's03',
      p: 4,
      record: 'lowther-mr',
      slot: 'kinship',
      value: 'brother-in-law of Mr. Ashby',
      quote: 'His brother-in-law, Mr. Lowther',
      right: true,
      reason:
        '"His" is Mr. Ashby, the subject of the sentences before: Mr. Lowther is his brother-in-law.'
    },
    {
      scene: 's03',
      p: 6,
      record: 'liesel',
      slot: 'location',
      value: 'near enough for her to overhear a conversation between him and Mr. Ashby',
      quote:
        'Mr. Varrow had been standing near enough for her to overhear a conversation between him and Mr. Ashby',
      right: false,
      reason: 'A clause, not a place, and it is Mr. Varrow who stands there.'
    },
    {
      scene: 's03',
      p: 4,
      record: 'varrow',
      slot: 'detail:wealth',
      value: 'having ten thousand a year',
      quote:
        'the report, which was in general circulation within five minutes after his entrance, of his having ten thousand a year',
      voice: 'rumour',
      right: true,
      reason: 'A report in circulation, stored as rumour.'
    },
    {
      scene: 'h09',
      p: 4,
      record: 'ashby',
      slot: 'kinship',
      value: 'husband of Johanna',
      quote: 'Johanna and Mr. Ashby had been married two years',
      right: true,
      reason: 'Named, narration: they had been married two years.'
    },
    {
      scene: 'h09',
      p: 4,
      record: 'johanna',
      slot: 'kinship',
      value: 'wife of Mr. Ashby',
      quote: 'Johanna and Mr. Ashby had been married two years',
      right: true,
      reason: 'Named, narration: they had been married two years.'
    },
    {
      scene: 'h14',
      p: 11,
      record: 'lottie',
      slot: 'alive',
      value: 'alive',
      quote: 'Lottie, who was nineteen and expecting her first child',
      right: true,
      call: true,
      reason:
        'Not said in a word, but she is plainly living (nineteen, expecting her first child); the same call as the Captain who "came to dine at Wexley".'
    },
    {
      scene: 'h15',
      p: 14,
      record: 'anne',
      slot: 'location',
      value: "down to dinner on the Captain's arm",
      quote: "she came down to dinner on the Captain's arm",
      right: false,
      call: true,
      reason: 'How she came down, not a place: "dinner" is no location.'
    },
    {
      scene: 'h16',
      p: 1,
      record: 'hobb',
      slot: 'location',
      value: 'at the lodge gate in the rain',
      quote: 'Hobb stood at the lodge gate in the rain',
      right: true,
      reason:
        'Named, narration, in a scene typed as a flashback: where he stood then (run 2’s one "wrong" literal fact, on a sentence no claim label covered).'
    },
    // F-16.17 (plan Suggestions.md, 2026-10-14): the fifth live run's facts on no judged sentence
    // (two readings, 2026-10-15T04:23 and 04:30 UTC), judged by the main session from the text
    // alone; the two judgment calls are flagged and listed in QUESTIONS.md.
    {
      scene: 's01',
      p: 33,
      record: 'harrow-mr',
      slot: 'age',
      value: 'three and twenty years',
      quote: 'the experience of three and twenty years',
      right: false,
      reason: 'How long he has been married, not his age.'
    },
    {
      scene: 's02',
      p: 21,
      record: 'harrow-mr',
      slot: 'location',
      value: 'left the room',
      quote: 'he left the room',
      right: false,
      reason: 'An act (leaving), not a place he is at or goes to.'
    },
    {
      scene: 's03',
      p: 3,
      record: 'ashby',
      slot: 'detail:companion',
      value: 'his two sisters, the husband of the eldest, and another young man',
      quote: 'Mr. Ashby, his two sisters, the husband of the eldest, and another young man',
      right: true,
      reason: 'Named, narration: the party he came with.'
    },
    {
      scene: 's03',
      p: 5,
      record: 'ashby',
      slot: 'location',
      value: 'the room',
      quote: 'Mr. Ashby had soon made himself acquainted with all the principal people in the room',
      right: true,
      call: true,
      reason: 'Named, narration: he is in the room (the assembly room), if a vague place.'
    },
    {
      scene: 'h04',
      p: 0,
      record: 'bel',
      slot: 'location',
      value: 'Pell House',
      quote: 'Bel Harrow came to Pell House',
      right: true,
      reason: 'Named, narration: where she comes.'
    },
    {
      scene: 'h09',
      p: 3,
      record: 'lottie',
      slot: 'alive',
      value: 'alive',
      quote: 'Lottie was eighteen now',
      right: true,
      reason: 'Named, narration: eighteen now, and married, so living (the same call as h14’s).'
    },
    {
      scene: 'h13',
      p: 0,
      record: 'dunmore',
      slot: 'alive',
      value: 'married',
      quote: 'a married man now',
      right: false,
      reason: 'Married is no value of alive.'
    },
    {
      scene: 's01',
      p: 33,
      record: 'harrow-mrs',
      slot: 'detail:occupation',
      value: 'The business of her life was to get her daughters married',
      quote: 'The business of her life was to get her daughters married',
      right: false,
      reason: 'Her aim in life, not an occupation; and a sentence, not a short value.'
    },
    {
      scene: 's03',
      p: 4,
      record: 'ashby',
      slot: 'detail:build',
      value: 'good-looking and gentlemanlike',
      quote: 'Mr. Ashby was good-looking and gentlemanlike',
      right: false,
      call: true,
      reason: 'True of him, but his looks and manner, not his build: the wrong slot.'
    },
    {
      scene: 's05',
      p: 1,
      record: 'dunmore',
      slot: 'detail:occupation',
      value: 'son of the late steward',
      quote: 'Mr. Dunmore was the son of the late steward at Greyhallow',
      right: false,
      reason: 'Kinship, not an occupation.'
    },
    {
      scene: 'h13',
      p: 0,
      record: 'dunmore',
      slot: 'detail:occupation',
      value: 'a married man now',
      quote: 'a married man now',
      right: false,
      reason: 'Being married is no occupation.'
    }
  ]
}
