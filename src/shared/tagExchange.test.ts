import { describe, expect, it } from 'vitest'
import {
  TAG_EXCHANGE_FORMAT_ID,
  TAG_EXCHANGE_VERSION,
  TagExchangeError,
  dropAliasesTo,
  mergeAliases,
  parseTagBank,
  resolveTagId,
  serializeTagBank,
  tagExportFileName,
  type TagExchangeRecord
} from './tagExchange'

const file = (tags: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ format: TAG_EXCHANGE_FORMAT_ID, version: TAG_EXCHANGE_VERSION, tags, ...extra })

function refusal(text: string): TagExchangeError {
  try {
    parseTagBank(text)
  } catch (err) {
    if (err instanceof TagExchangeError) return err
    throw err
  }
  throw new Error('expected a TagExchangeError')
}

describe('parseTagBank', () => {
  it('reads records, kebab-casing names and parents and filling the defaults', () => {
    expect(
      parseTagBank(
        file([
          { name: 'Dark Forest', category: 'setting', color: '#112233', parent: 'The Realm' },
          { name: 'Mara', category: 'character', color: '#445566', trackMentions: false }
        ])
      )
    ).toEqual([
      {
        name: 'dark-forest',
        category: 'setting',
        color: '#112233',
        parent: 'the-realm',
        trackMentions: true
      },
      { name: 'mara', category: 'character', color: '#445566', parent: null, trackMentions: false }
    ])
  })

  it('accepts a leading byte order mark', () => {
    expect(
      parseTagBank(`\uFEFF${file([{ name: 'rain', category: 'tone', color: '#000000' }])}`)
    ).toHaveLength(1)
  })

  it('keeps the first of two names that normalize alike', () => {
    expect(
      parseTagBank(
        file([
          { name: 'Rain', category: 'tone', color: '#000000' },
          { name: 'rain!', category: 'custom', color: '#ffffff' }
        ])
      )
    ).toEqual([
      { name: 'rain', category: 'tone', color: '#000000', parent: null, trackMentions: true }
    ])
  })

  it('drops a parent that is the tag itself or empties after normalization', () => {
    const records = parseTagBank(
      file([
        { name: 'Rain', category: 'tone', color: '#000000', parent: 'RAIN' },
        { name: 'Fog', category: 'tone', color: '#000000', parent: '—' }
      ])
    )
    expect(records.map((record) => record.parent)).toEqual([null, null])
  })

  it('refuses text that is not JSON, another format, another version, and no tags list', () => {
    expect(refusal('{').message).toBe('The file is not valid JSON')
    expect(refusal('[]').message).toBe('The file is not a MythScribe tag bank')
    expect(refusal(JSON.stringify({ format: 'mythscribe-entities' })).message).toBe(
      'The file is not a MythScribe tag bank'
    )
    expect(refusal(file([], { version: 2 })).message).toBe(
      'The tag bank file is from an unsupported version'
    )
    expect(
      refusal(JSON.stringify({ format: TAG_EXCHANGE_FORMAT_ID, version: 1, tags: {} })).message
    ).toBe('The tag bank file has no tags list')
  })

  it('names the row of a bad record', () => {
    const bad = refusal(
      file([
        { name: 'rain', category: 'tone', color: '#000000' },
        { name: 'fog', category: 'weather', color: '#000000' }
      ])
    )
    expect(bad.row).toBe(2)
    expect(bad.message).toBe('Tag 2 is not valid')
    const nameless = refusal(file([{ name: '???', category: 'tone', color: '#000000' }]))
    expect(nameless.row).toBe(1)
    expect(nameless.message).toMatch(/no letters or digits/)
    expect(refusal(file([{ name: 'x', category: 'tone', color: '#FFF' }])).row).toBe(1)
  })
})

describe('serializeTagBank', () => {
  it('round-trips through parseTagBank', () => {
    const records: TagExchangeRecord[] = [
      {
        name: 'realm',
        category: 'worldBuilding',
        color: '#123456',
        parent: null,
        trackMentions: true
      },
      {
        name: 'forest',
        category: 'setting',
        color: '#abcdef',
        parent: 'realm',
        trackMentions: false
      }
    ]
    const text = serializeTagBank(records)
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toMatchObject({ format: TAG_EXCHANGE_FORMAT_ID, version: 1 })
    expect(parseTagBank(text)).toEqual(records)
  })

  it('names the export after the project', () => {
    expect(tagExportFileName('My Book')).toBe('My Book tags.json')
  })
})

describe('resolveTagId', () => {
  const live =
    (...ids: string[]) =>
    (id: string) =>
      ids.includes(id)

  it('answers a live id as it is', () => {
    expect(resolveTagId('a', { a: 'b' }, live('a', 'b'))).toBe('a')
  })

  it('follows a chain of aliases to a live tag', () => {
    expect(resolveTagId('a', { a: 'b', b: 'c' }, live('c'))).toBe('c')
  })

  it('answers the id unchanged at a dead end or with no alias', () => {
    expect(resolveTagId('a', { a: 'b' }, live('c'))).toBe('a')
    expect(resolveTagId('x', {}, live('c'))).toBe('x')
  })

  it('stops on a cycle', () => {
    expect(resolveTagId('a', { a: 'b', b: 'a' }, live())).toBe('a')
  })
})

describe('mergeAliases / dropAliasesTo', () => {
  it('points the sources at the target and redirects aliases that led to a source', () => {
    expect(mergeAliases({ old: 'b' }, ['b', 'c'], 't')).toEqual({ old: 't', b: 't', c: 't' })
  })

  it('never leaves the target aliased, nor aliases it to itself', () => {
    expect(mergeAliases({ t: 'x' }, ['b', 't'], 't')).toEqual({ b: 't' })
  })

  it('drops only the aliases that lead to a deleted tag', () => {
    expect(dropAliasesTo({ a: 't', b: 'u' }, ['t'])).toEqual({ b: 'u' })
  })
})
