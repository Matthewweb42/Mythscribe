import { describe, expect, it } from 'vitest'
import { BUILTIN_CATEGORIES } from '@shared/categories'
import {
  ORGANISE_CHUNK_CHARS,
  ORGANISE_MAX_CHUNKS,
  ORGANISE_MAX_TOKENS,
  ORGANISE_RETRY_MAX_TOKENS,
  ORGANISE_SCOPES
} from '@shared/organise'
import {
  buildOrganisePrompt,
  organiseChunks,
  organiseIndex,
  ORGANISE_RETRY_TURN,
  ORGANISE_RULES,
  sheetDetailLine,
  tagLine,
  type OrganiseListing
} from './organise.v1'

const listing: OrganiseListing = {
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
  findings: 'Found locally (check them): Unused tags: t2.'
}

describe('organise.v1 prompt (F-9.10)', () => {
  it('matches the golden messages', () => {
    const chunks = organiseChunks(listing, [...ORGANISE_SCOPES])
    const built = buildOrganisePrompt({
      index: organiseIndex(listing),
      chunk: chunks[0] ?? '',
      part: 1,
      parts: chunks.length,
      scopes: [...ORGANISE_SCOPES],
      instruction: 'Merge duplicate tags.',
      findings: listing.findings
    })
    expect(built.version).toBe('organise.v1')
    expect(built.maxTokens).toBe(ORGANISE_MAX_TOKENS)
    expect(built.messages).toMatchSnapshot()
  })

  it('lists every library category and never asks for prose', () => {
    for (const category of BUILTIN_CATEGORIES) {
      expect(ORGANISE_RULES).toContain(`${category.id} (${category.hint})`)
    }
    expect(ORGANISE_RULES).toContain('never write story prose')
  })

  it('writes a tag and a sheet as one line each', () => {
    expect(tagLine(listing.tags[1]!)).toBe(
      't2 #high-crown · custom · under t1 · 0 docs, 0 mentions'
    )
    expect(sheetDetailLine(listing.sheets[0]!)).toBe(
      's1 Rynna Falsire · Age=19 · empty: Appearance · observed: appearance: grey eyes'
    )
  })

  it('chunks only the scopes asked for, and always answers one chunk', () => {
    expect(organiseChunks(listing, ['tags'])).toEqual([''])
    const notesOnly = organiseChunks(listing, ['notes'])
    expect(notesOnly).toEqual(['Notes:\nn3 Chapter 1 › The mill · notes: Rynna has grey eyes.'])
  })

  it('splits a long listing within the chunk cap and the chunk count, naming what was left off', () => {
    const big: OrganiseListing = {
      ...listing,
      notes: Array.from({ length: 400 }, (_, i) => ({
        ref: `n${i}`,
        title: `Scene ${i}`,
        notes: 'x'.repeat(700)
      }))
    }
    const chunks = organiseChunks(big, ['notes'])
    expect(chunks).toHaveLength(ORGANISE_MAX_CHUNKS)
    for (const chunk of chunks.slice(0, -1))
      expect(chunk.length).toBeLessThanOrEqual(ORGANISE_CHUNK_CHARS)
    expect(chunks[1]?.startsWith('Notes:\n')).toBe(true)
    expect(chunks.at(-1)).toMatch(/more lines not shown\)$/)
  })

  it('tells a later part the tags were done, and asks the retry at the larger cap', () => {
    const built = buildOrganisePrompt({
      index: 'INDEX',
      chunk: 'CHUNK',
      part: 2,
      parts: 3,
      scopes: ['sheets'],
      instruction: '',
      findings: 'FINDINGS',
      retry: true
    })
    expect(built.messages.map((m) => m.content)).toEqual([
      ORGANISE_RULES,
      'INDEX',
      'Organise: story bible.\n\nNo instruction: do what clearly helps.\n\nPart 2 of 3; the tags were done in part 1, change only what this part lists.\n\nCHUNK',
      ORGANISE_RETRY_TURN
    ])
    expect(built.maxTokens).toBe(ORGANISE_RETRY_MAX_TOKENS)
  })
})
