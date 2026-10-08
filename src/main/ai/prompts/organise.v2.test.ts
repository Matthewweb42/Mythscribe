import { describe, expect, it } from 'vitest'
import {
  ORGANISE_CHUNK_CHARS,
  ORGANISE_INDEX_CHARS,
  ORGANISE_SCOPES,
  ORGANISE_V2_MAX_CHUNKS,
  ORGANISE_V2_MAX_TOKENS
} from '@shared/organise'
import { ORGANISE_RULES } from './organise.v1'
import {
  buildOrganisePromptV2,
  describeOrganiseChunk,
  findingsFor,
  halveOrganiseChunk,
  organiseChunksV2,
  organiseIndexV2,
  ORGANISE_V2_RULES,
  renderOrganiseChunk,
  type OrganiseChunk,
  type OrganiseListingV2
} from './organise.v2'

const listing: OrganiseListingV2 = {
  categories: [{ id: 'c-ships', name: 'Ships' }],
  tags: [
    {
      ref: 't1',
      name: 'rynna-falsire',
      category: 'character',
      parent: null,
      aliases: ['Rynna'],
      docs: 4,
      mentions: 9,
      sheet: 's1'
    },
    {
      ref: 't2',
      name: 'high-crown',
      category: 'custom',
      parent: 't1',
      aliases: [],
      docs: 0,
      mentions: 0,
      sheet: null
    }
  ],
  sheets: [
    {
      ref: 's1',
      kind: 'character',
      name: 'Rynna Falsire',
      aliases: ['Rynna'],
      fields: [{ label: 'Age', value: '19' }],
      empty: ['Appearance'],
      page: '',
      facts: ['appearance: grey eyes']
    }
  ],
  notes: [{ ref: 'n3', title: 'Chapter 1 › The mill', notes: 'Rynna has grey eyes.' }],
  outline: [
    { ref: 'n2', depth: 0, title: 'Chapter 1', level: 'chapter', words: null },
    { ref: 'n3', depth: 1, title: 'The mill', level: 'scene', words: 1200 }
  ],
  findings: [
    { kind: 'unusedTag', refs: ['t2'] },
    { kind: 'duplicate', refs: ['s1', 's9'] }
  ]
}

const sheetsOf = (n: number, chars: number): OrganiseListingV2['sheets'] =>
  Array.from({ length: n }, (_, i) => ({
    ref: `s${i + 1}`,
    kind: 'character',
    name: `Sheet ${String(i + 1).padStart(3, '0')}`,
    aliases: [],
    // A field value is clipped to 300 characters in the line.
    fields: [{ label: 'Background', value: 'x'.repeat(chars) }],
    empty: [],
    page: '',
    facts: []
  }))

describe('organise.v2 prompt (F-9.10, 2026-10-08)', () => {
  it('matches the golden messages', () => {
    const { chunks } = organiseChunksV2(listing, [...ORGANISE_SCOPES])
    const chunk = chunks[0] ?? []
    const built = buildOrganisePromptV2({
      index: organiseIndexV2(listing).text,
      chunk,
      part: 1,
      parts: chunks.length,
      scopes: [...ORGANISE_SCOPES],
      instruction: 'Merge duplicate tags.',
      findings: findingsFor(listing.findings, chunk)
    })
    expect(built.version).toBe('organise.v2')
    expect(built.maxTokens).toBe(ORGANISE_V2_MAX_TOKENS)
    expect(built.messages).toMatchSnapshot()
  })

  it("opens with version 1's sentence (the e2e's fake recognises it) and asks for short reasons", () => {
    const opening = ORGANISE_RULES.slice(0, ORGANISE_RULES.indexOf('.') + 1)
    expect(ORGANISE_V2_RULES.startsWith(opening)).toBe(true)
    expect(ORGANISE_V2_RULES).toContain('"why" of at most 8 words')
  })

  it('lists the tags in detail in the chunks and only by name in the index', () => {
    const index = organiseIndexV2(listing)
    expect(index.text).toContain('t2 #high-crown · custom\n')
    expect(index.text).not.toContain('0 docs')
    expect(index.leftOff).toEqual({ tags: 0, sheets: 0 })
    const { chunks, leftOff } = organiseChunksV2(listing, ['tags'])
    expect(renderOrganiseChunk(chunks[0] ?? [])).toBe(
      'Tags in detail:\nt1 #rynna-falsire · character · also: Rynna · 4 docs, 9 mentions · sheet s1\nt2 #high-crown · custom · under t1 · 0 docs, 0 mentions'
    )
    expect(leftOff).toEqual([])
    expect(organiseChunksV2({ ...listing, tags: [] }, ['tags']).chunks).toEqual([[]])
  })

  it('counts what the index had no room for', () => {
    const many = { ...listing, sheets: sheetsOf(400, 10) }
    const index = organiseIndexV2(many)
    expect(index.text.length).toBeLessThan(ORGANISE_INDEX_CHARS + 200)
    expect(index.leftOff.sheets).toBeGreaterThan(0)
    expect(index.text).toContain(`(${index.leftOff.sheets} more sheets not shown)`)
  })

  it('splits a long listing within the chunk cap and returns what is past the chunk count', () => {
    const big = { ...listing, sheets: sheetsOf(900, 300) }
    const { chunks, leftOff } = organiseChunksV2(big, ['sheets'])
    expect(chunks).toHaveLength(ORGANISE_V2_MAX_CHUNKS)
    for (const chunk of chunks) {
      expect(renderOrganiseChunk(chunk).length).toBeLessThanOrEqual(ORGANISE_CHUNK_CHARS)
      expect(renderOrganiseChunk(chunk).startsWith('Sheets in detail:\n')).toBe(true)
    }
    const listed = chunks.flat().reduce((n, section) => n + section.entries.length, 0)
    const left = leftOff.reduce((n, section) => n + section.entries.length, 0)
    expect(listed + left).toBe(900)
    expect(left).toBeGreaterThan(0)
    expect(describeOrganiseChunk(leftOff)).toBe(
      `sheets “Sheet ${String(listed + 1).padStart(3, '0')}” to “Sheet 900” (${left})`
    )
  })

  it('halves a chunk at an entry boundary, across sections, and not a single entry', () => {
    const { chunks } = organiseChunksV2(listing, [...ORGANISE_SCOPES])
    const chunk = chunks[0] ?? []
    // 2 tags, 1 sheet, 1 note, 2 outline rows: 6 entries, 3 a half.
    const halves = halveOrganiseChunk(chunk)
    expect(halves?.map((half) => half.map((s) => [s.kind, s.entries.map((e) => e.ref)]))).toEqual([
      [
        ['tags', ['t1', 't2']],
        ['sheets', ['s1']]
      ],
      [
        ['notes', ['n3']],
        ['outline', ['n2', 'n3']]
      ]
    ])
    const single: OrganiseChunk = [
      { kind: 'sheets', entries: [{ ref: 's1', name: 'A', line: 'x' }] }
    ]
    expect(halveOrganiseChunk(single)).toBeNull()
    expect(describeOrganiseChunk(halves?.[1] ?? [])).toBe(
      'notes of “Chapter 1 › The mill”; outline rows “Chapter 1” to “The mill” (2)'
    )
  })

  it('sends each finding with the chunk that lists its first ref', () => {
    const { chunks } = organiseChunksV2(listing, [...ORGANISE_SCOPES])
    const [tagsHalf, rest] = halveOrganiseChunk(chunks[0] ?? []) ?? [[], []]
    expect(findingsFor(listing.findings, tagsHalf)).toBe(
      'Found locally (check them): Likely duplicates: s1 + s9. Unused tags: t2.'
    )
    expect(findingsFor(listing.findings, rest)).toBe('')
    const notesOnly = organiseChunksV2(listing, ['notes']).chunks[0] ?? []
    expect(findingsFor(listing.findings, notesOnly)).toBe('')
  })

  it('tells a later part to change only what it lists, with no retry turn', () => {
    const built = buildOrganisePromptV2({
      index: 'INDEX',
      chunk: [{ kind: 'notes', entries: [{ ref: 'n3', name: 'The mill', line: 'n3 LINE' }] }],
      part: 2,
      parts: 3,
      scopes: ['notes'],
      instruction: '',
      findings: ''
    })
    expect(built.messages.map((m) => m.content)).toEqual([
      ORGANISE_V2_RULES,
      'INDEX',
      'Organise: notes.\n\nNo instruction: do what clearly helps.\n\nPart 2 of 3: change only what this part lists; the index names the rest.\n\nNotes:\nn3 LINE'
    ])
  })
})
