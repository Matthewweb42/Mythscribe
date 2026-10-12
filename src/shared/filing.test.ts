import { describe, expect, it } from 'vitest'
import { categoryFromInput } from './categories'
import {
  applyFilingOps,
  decidedFiling,
  droppedLine,
  FILING_QUOTE_MAX_WORDS,
  filingAsNew,
  hasFilingConflict,
  isTitleAlias,
  planFiling,
  quoteParagraph,
  splitLabel,
  writtenLines,
  type FiledRecord,
  type FilingReview,
  type FilingRosterRecord,
  type PlanFilingInput
} from './filing'

const PARAGRAPHS: PlanFilingInput['paragraphs'] = [
  { index: 0, text: 'The Bestiary of the Fens', notCanon: false },
  { index: 1, text: 'Mara Vell has grey eyes and a scar on her left hand.', notCanon: false },
  { index: 2, text: 'Rumour says the Captain cannot swim at all.', notCanon: true },
  { index: 3, text: 'The fen-wight is a pale thing that hunts by lantern-light.', notCanon: false },
  {
    index: 4,
    text: 'Tomas Harrow keeps the ferry at Gullhaven, and his eyes are brown.',
    notCanon: false
  }
]

const roster: FilingRosterRecord[] = [
  {
    id: 'r-mara',
    name: 'Mara Vell',
    categoryId: 'character',
    names: [
      { text: 'Mara Vell', shared: false },
      { text: 'the Captain', shared: false }
    ],
    pinned: [
      { index: 0, text: 'Eyes: green' },
      { index: 1, text: 'Hand: TBD' }
    ],
    hasImage: false
  },
  {
    id: 'r-tomas',
    name: 'Tomas Harrow',
    categoryId: 'character',
    names: [
      { text: 'Tomas Harrow', shared: false },
      { text: 'Harrow', shared: true }
    ],
    pinned: [{ index: 0, text: 'Keeps the ferry at Gullhaven.' }],
    hasImage: true
  }
]

const input = (records: FiledRecord[], over: Partial<PlanFilingInput> = {}): PlanFilingInput => ({
  records,
  paragraphs: PARAGRAPHS,
  roster,
  dismissedNames: [],
  dismissedAliases: new Set(),
  images: [],
  imageHints: [],
  ...over
})

describe('planFiling (F-16.9)', () => {
  it('keeps a line whose quote is in a canon paragraph and drops the rest, counting them', () => {
    const plan = planFiling(
      input([
        {
          name: 'Mara Vell',
          categoryId: 'character',
          aliases: [],
          lines: [
            { text: 'Scar: on her left hand', q: 'a scar on her left hand' },
            { text: 'Cannot swim', q: 'the Captain cannot swim at all' }, // Not canon paragraph
            { text: 'Tall', q: 'Mara Vell is tall' }, // not in the document
            { text: 'Short quote', q: 'grey eyes' }, // two words
            {
              text: 'Long quote',
              q: Array(FILING_QUOTE_MAX_WORDS + 1)
                .fill('Mara')
                .join(' ')
            }
          ]
        }
      ])
    )
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]?.lines).toEqual([
      {
        id: 'l1',
        text: 'Scar: on her left hand',
        quote: 'a scar on her left hand',
        para: 1,
        kind: 'add',
        replaces: null,
        use: true
      }
    ])
    expect(plan.dropped.quote).toBe(4)
    expect(droppedLine(plan.dropped)).toBe('4 lines dropped: quote not in the document')
  })

  it('drops what Pinned says, updates a placeholder, and marks a disagreeing label a conflict', () => {
    const plan = planFiling(
      input([
        {
          name: 'Mara Vell',
          categoryId: 'character',
          aliases: [],
          lines: [
            { text: 'Eyes: grey', q: 'Mara Vell has grey eyes' },
            { text: 'Hand: scarred on the left', q: 'a scar on her left hand' },
            { text: 'Eyes: grey', q: 'has grey eyes and a scar' }
          ]
        },
        {
          name: 'Tomas Harrow',
          categoryId: 'character',
          aliases: [],
          lines: [{ text: 'Keeps the ferry at Gullhaven.', q: 'keeps the ferry at Gullhaven' }]
        }
      ])
    )
    const mara = plan.items.find((item) => item.recordId === 'r-mara')
    expect(
      mara?.lines.map((line) => [line.text, line.kind, line.use, line.replaces?.index])
    ).toEqual([
      ['Eyes: grey', 'conflict', false, 0],
      ['Hand: scarred on the left', 'update', true, 1]
    ])
    expect(hasFilingConflict(mara ?? plan.items[0]!)).toBe(true)
    expect(writtenLines(mara ?? plan.items[0]!).map((line) => line.text)).toEqual([
      'Hand: scarred on the left'
    ])
    // Tomas has nothing new: left out. The repeated line and the line Pinned says are counted.
    expect(plan.items.some((item) => item.recordId === 'r-tomas')).toBe(false)
    expect(plan.dropped.duplicate).toBe(2)
  })

  it('gives a near name its own undecided card for the record the twin gate matched', () => {
    const plan = planFiling(
      input([
        {
          name: 'Mara',
          categoryId: 'character',
          aliases: ['the Captain', 'Tomas Harrow', 'Cap'],
          lines: [{ text: 'Scar: left hand', q: 'a scar on her left hand' }]
        }
      ])
    )
    expect(plan.items).toHaveLength(1)
    const item = plan.items[0]
    expect(item).toMatchObject({
      recordId: 'r-mara',
      name: 'Mara Vell',
      sameAs: { given: 'Mara', rule: 'subset' },
      // "the Captain" is hers already; "Tomas Harrow" is another record's.
      aliases: ['Mara', 'Cap'],
      pinned: [
        { index: 0, text: 'Eyes: green' },
        { index: 1, text: 'Hand: TBD' }
      ],
      include: false
    })
    expect(plan.dropped.alias).toBe(1)
  })

  it('keeps a "same as?" filing apart from the lines filed under the record’s own name', () => {
    const plan = planFiling(
      input([
        {
          name: 'Mara Vell',
          categoryId: 'character',
          aliases: [],
          lines: [{ text: 'Scar: left hand', q: 'a scar on her left hand' }]
        },
        {
          name: 'Mara',
          categoryId: 'character',
          aliases: [],
          lines: [{ text: 'Eyes: grey', q: 'Mara Vell has grey eyes' }]
        },
        {
          name: 'mara',
          categoryId: 'character',
          aliases: [],
          lines: [{ text: 'Has a scar', q: 'grey eyes and a scar' }]
        }
      ])
    )
    expect(
      plan.items.map((item) => [
        item.name,
        item.sameAs?.given ?? null,
        item.include,
        item.lines.length
      ])
    ).toEqual([
      ['Mara Vell', null, true, 1],
      ['Mara Vell', 'Mara', false, 2]
    ])
    expect(plan.items[1]?.aliases).toEqual(['Mara'])
    // New record: the given name, its lines all added (it has no Pinned yet).
    const made = filingAsNew(plan.items[1]!)
    expect(made).toMatchObject({
      recordId: null,
      name: 'Mara',
      known: [],
      pinned: [],
      sameAs: null
    })
    expect(made.aliases).toEqual([])
    expect(made.lines.map((line) => [line.kind, line.use, line.replaces])).toEqual([
      ['add', true, null],
      ['add', true, null]
    ])
    expect(filingAsNew(plan.items[0]!)).toBe(plan.items[0])
  })

  it('never lets two items, or an item and another record, hold one nickname', () => {
    const shared: FilingRosterRecord[] = [
      ...roster,
      {
        id: 'r-joss',
        name: 'Joss Fen',
        categoryId: 'character',
        names: [
          { text: 'Joss Fen', shared: false },
          { text: 'the Skipper', shared: true }
        ],
        pinned: [],
        hasImage: false
      }
    ]
    const plan = planFiling(
      input(
        [
          {
            name: 'Old Jory',
            categoryId: 'character',
            aliases: ['the Skipper', 'the Ferryman'],
            lines: [{ text: 'Hunts by lantern', q: 'hunts by lantern-light' }]
          },
          {
            name: 'Hesk Orrin',
            categoryId: 'character',
            aliases: ['Old Jory', 'the Ferryman', 'Orrin'],
            lines: [{ text: 'Eyes: brown', q: 'his eyes are brown' }]
          },
          {
            name: 'Mara Vell',
            categoryId: 'character',
            aliases: ['Quill'],
            lines: []
          },
          {
            name: 'Quill',
            categoryId: 'character',
            aliases: [],
            lines: [{ text: 'A pale thing', q: 'is a pale thing' }]
          }
        ],
        { roster: shared }
      )
    )
    expect(plan.items.map((item) => [item.name, item.aliases])).toEqual([
      // "the Skipper" is Joss Fen's (shared there, but filing never files a shared name).
      ['Old Jory', ['the Ferryman']],
      // "Old Jory" is the other new record's name; "the Ferryman" its nickname.
      ['Hesk Orrin', ['Orrin']],
      ['Quill', []]
    ])
    // Mara keeps nothing: "Quill" is a new record's name, which wins over her nickname.
    expect(plan.items.some((item) => item.recordId === 'r-mara')).toBe(false)
    expect(plan.dropped.alias).toBe(4)
  })

  it('drops a title proposed as a nickname, and the lines filed under a name two records share', () => {
    const shared: FilingRosterRecord[] = [
      {
        ...roster[0]!,
        names: [
          { text: 'Mara Vell', shared: false },
          { text: 'the Skipper', shared: true }
        ]
      },
      {
        ...roster[1]!,
        names: [
          { text: 'Tomas Harrow', shared: false },
          { text: 'the Skipper', shared: true }
        ]
      }
    ]
    const plan = planFiling(
      input(
        [
          {
            name: 'Mara Vell',
            categoryId: 'character',
            aliases: ['Captain', 'Captain Vell', 'the burned captain', 'Mrs Harrow'],
            lines: [{ text: 'Scar: left hand', q: 'a scar on her left hand' }]
          },
          {
            name: 'the Skipper',
            categoryId: 'character',
            aliases: [],
            lines: [
              { text: 'Eyes: brown', q: 'his eyes are brown' },
              { text: 'Ferry', q: 'keeps the ferry at Gullhaven' }
            ]
          }
        ],
        { roster: shared }
      )
    )
    expect(plan.items.map((item) => [item.name, item.aliases])).toEqual([
      ['Mara Vell', ['the burned captain', 'Mrs Harrow']]
    ])
    expect(plan.dropped).toMatchObject({ alias: 2, shared: 2 })
    expect(droppedLine(plan.dropped)).toBe(
      '2 lines about a name two records share · 2 nicknames left out'
    )
    expect(isTitleAlias('the Captain', ['Mara Vell'])).toBe(true)
    expect(isTitleAlias('Capt. Vell', ['Mara Vell'])).toBe(true)
    expect(isTitleAlias('Captain Harrow', ['Mara Vell'])).toBe(false)
    expect(isTitleAlias('Vell', ['Mara Vell'])).toBe(false)
  })

  it('drops a dismissed name with its lines, and a nickname dismissed for that record', () => {
    const plan = planFiling(
      input(
        [
          {
            name: 'Fen Wight',
            categoryId: 'creature',
            aliases: [],
            lines: [{ text: 'Hunts by lantern-light', q: 'hunts by lantern-light' }]
          },
          {
            name: 'Mara Vell',
            categoryId: 'character',
            aliases: ['Marry'],
            lines: []
          }
        ],
        { dismissedNames: ['Fen Wight'], dismissedAliases: new Set(['r-mara|marry']) }
      )
    )
    expect(plan.items).toEqual([])
    expect(plan.dropped).toMatchObject({ dismissed: 1, alias: 1 })
  })

  it('makes one new record of a name filed in two chunks, new records first, with a hinted picture', () => {
    const plan = planFiling(
      input(
        [
          {
            name: 'Tomas Harrow',
            categoryId: 'character',
            aliases: [],
            lines: [{ text: 'Eyes: brown', q: 'his eyes are brown' }]
          },
          {
            name: 'The Fen-Wight',
            categoryId: 'creature',
            aliases: ['wight'],
            lines: [{ text: 'Colour: pale', q: 'is a pale thing' }]
          },
          {
            name: 'the fen-wight',
            categoryId: 'creature',
            aliases: [],
            lines: [{ text: 'Hunts by lantern-light', q: 'hunts by lantern-light' }]
          }
        ],
        {
          images: [
            { nodeId: 'img-1', name: 'wight.png' },
            { nodeId: 'img-2', name: 'tomas.png' }
          ],
          imageHints: [
            { file: 'wight.png', name: 'wight' },
            { file: 'tomas.png', name: 'Tomas Harrow' }
          ]
        }
      )
    )
    expect(plan.items.map((item) => [item.name, item.recordId, item.lines.length])).toEqual([
      ['The Fen-Wight', null, 2],
      ['Tomas Harrow', 'r-tomas', 1]
    ])
    expect(plan.items[0]?.image).toEqual({ nodeId: 'img-1', name: 'wight.png' })
    // Tomas has a picture already, so none is offered.
    expect(plan.items[1]?.image).toBeNull()
  })
})

describe('the filing helpers', () => {
  it('reads a short label, and finds the paragraph of a quote', () => {
    expect(splitLabel('Eyes: grey')).toEqual({ label: 'eyes', value: 'grey' })
    expect(splitLabel('She has grey eyes.')).toBeNull()
    expect(quoteParagraph('his eyes are brown', PARAGRAPHS)).toBe(4)
    expect(quoteParagraph('cannot swim at all', PARAGRAPHS)).toBeNull()
    expect(droppedLine({ quote: 0, duplicate: 0, dismissed: 0, alias: 0, shared: 0 })).toBeNull()
  })
})

const review = (): FilingReview => {
  const plan = planFiling(
    input([
      {
        name: 'The Fen-Wight',
        categoryId: 'c-creatures',
        aliases: [],
        lines: [{ text: 'Colour: pale', q: 'is a pale thing' }]
      },
      {
        name: 'Wight Mother',
        categoryId: 'c-creatures',
        aliases: [],
        lines: [{ text: 'Hunts by lantern-light', q: 'hunts by lantern-light' }]
      },
      {
        name: 'Mara Vell',
        categoryId: 'character',
        aliases: [],
        lines: [{ text: 'Scar: left hand', q: 'a scar on her left hand' }]
      }
    ])
  )
  return {
    docId: 'n-bestiary',
    docTitle: 'Bestiary',
    docHash: 'h',
    items: plan.items,
    taken: ['mara vell', 'the captain', 'tomas harrow', 'harrow'],
    categories: [
      {
        ...categoryFromInput(
          'c-creatures',
          { name: 'Creatures', noun: 'creature', fields: [] },
          'ai'
        ),
        proposed: true
      }
    ],
    dropped: plan.dropped,
    proposalIds: ['p-1'],
    chunks: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0,
    model: 'm',
    promptVersion: 'contextImport.v3'
  }
}

describe('decidedFiling and the review chat (F-16.9)', () => {
  it('includes only accepted cards and sends a declined category’s new records to World', () => {
    const decided = decidedFiling(
      review(),
      (id) => id !== 'f2' && id !== 'category:c-creatures',
      (id) => `category:${id}`
    )
    expect(decided.categories).toEqual([])
    expect(decided.items.map((item) => [item.name, item.categoryId, item.include])).toEqual([
      ['The Fen-Wight', 'world', true],
      ['Wight Mother', 'world', false],
      ['Mara Vell', 'character', true]
    ])
  })

  it('merges, renames, re-kinds, sets nicknames and includes; skips what filing has no place for', () => {
    const { review: changed, changes } = applyFilingOps(review(), [
      { op: 'merge', items: ['f1', 'f2'], name: 'Fen-Wight' },
      { op: 'kind', item: 'f1', kind: 'creatures' },
      { op: 'kind', item: 'f3', kind: 'setting' },
      { op: 'aliases', item: 'f3', aliases: ['the Captain', 'Cap', 'cap'] },
      { op: 'include', item: 'f3', include: false },
      { op: 'rename', item: 'f3', name: 'Mara' },
      { op: 'toNotes', item: 'f1' },
      { op: 'merge', items: ['f1', 'f9'] }
    ])
    expect(changed.items.map((item) => item.id)).toEqual(['f1', 'f3'])
    expect(changed.items[0]).toMatchObject({
      name: 'Fen-Wight',
      aliases: ['Wight Mother'],
      categoryId: 'c-creatures'
    })
    expect(changed.items[0]?.lines).toHaveLength(2)
    expect(changed.items[1]).toMatchObject({ aliases: ['Cap'], include: false, name: 'Mara Vell' })
    expect(changes.filter((change) => change.skipped).map((change) => change.text)).toEqual([
      'Category: Mara Vell is a record already; change its category on its sheet',
      'Rename: only a new record can be renamed here (f3)',
      'toNotes: not available when filing: text that fits no record stays in the document',
      'Merge: fewer than two of f1, f9 are in the review'
    ])
  })
})

describe('the review chat never makes a clash Apply would refuse (F-16.9)', () => {
  it('refuses a rename or a nickname another record or another item holds', () => {
    const { review: changed, changes } = applyFilingOps(review(), [
      { op: 'rename', item: 'f1', name: 'Tomas Harrow' },
      { op: 'rename', item: 'f2', name: 'the fen-wight' },
      { op: 'rename', item: 'f1', name: '!!' },
      { op: 'aliases', item: 'f2', aliases: ['the Captain', 'The Fen-Wight', 'Mother'] },
      { op: 'merge', items: ['f2', 'f1'], name: 'Mara Vell' }
    ])
    expect(changes.map((change) => [change.text, change.skipped])).toEqual([
      ['Rename: “Tomas Harrow” is another record’s name', true],
      ['Rename: “the fen-wight” is another record’s name', true],
      ['Rename: “!!” has no letters or digits', true],
      [
        'Wight Mother: new nicknames Mother (left out: the Captain, The Fen-Wight, another record’s or no room)',
        false
      ],
      ['Merge: kept the name Wight Mother; “Mara Vell” is another record’s name', true],
      ['Merged Wight Mother, The Fen-Wight into Wight Mother', false]
    ])
    expect(changed.items[0]).toMatchObject({
      name: 'Wight Mother',
      aliases: ['Mother', 'The Fen-Wight']
    })
  })

  it('re-checks lines merged into an existing record against its Pinned', () => {
    const plan = planFiling(
      input([
        {
          name: 'Mara Vell',
          categoryId: 'character',
          aliases: [],
          lines: [{ text: 'Scar: left hand', q: 'a scar on her left hand' }]
        },
        {
          name: 'Brand',
          categoryId: 'character',
          aliases: [],
          lines: [
            { text: 'Eyes: grey', q: 'Mara Vell has grey eyes' },
            { text: 'Eyes: green', q: 'grey eyes and a scar' },
            { text: 'Keeps the ferry', q: 'keeps the ferry at Gullhaven' }
          ]
        }
      ])
    )
    const base = review()
    const { review: changed } = applyFilingOps({ ...base, items: plan.items }, [
      { op: 'merge', items: ['f2', 'f1'] }
    ])
    expect(changed.items).toHaveLength(1)
    expect(
      changed.items[0]?.lines.map((line) => [line.text, line.kind, line.use, line.replaces?.index])
    ).toEqual([
      ['Scar: left hand', 'add', true, undefined],
      // Pinned says "Eyes: green": a conflict, Pinned's kept unless the author picks this one.
      ['Eyes: grey', 'conflict', false, 0],
      // Pinned says "Eyes: green" already: left out.
      ['Keeps the ferry', 'add', true, undefined]
    ])
    expect(changed.items[0]).toMatchObject({ recordId: 'r-mara', aliases: ['Brand'] })
  })
})
