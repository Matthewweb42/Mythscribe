import { describe, expect, it } from 'vitest'
import { ENTITY_BODY_MAX, ENTITY_FIELD_MAX, ENTITY_NAME_MAX } from './entities'
import {
  CSV_BOM,
  ENTITY_CSV_COLUMNS,
  EntityExchangeError,
  actionsFor,
  countImportActions,
  csvEscape,
  entityExchangeFormatOf,
  entityExportFileName,
  mergePatch,
  parseCsv,
  parseEntitiesCsv,
  parseEntitiesJson,
  planEntityImport,
  serializeEntitiesCsv,
  serializeEntitiesJson,
  toExchangeRecord,
  type EntityExchangeRecord,
  type EntityLike
} from './entityExchange'

const mara: EntityLike = {
  id: 'e-mara',
  kind: 'character',
  name: 'Mara Vell',
  template: 'structured',
  fields: { age: '31', appearance: 'Tall, with a scar.' },
  body: null
}

const forest: EntityLike = {
  id: 'e-forest',
  kind: 'setting',
  name: 'Dark Forest',
  template: 'blank',
  fields: { description: 'Pines, all the way down.' },
  body: 'Nobody goes in after dark.'
}

const record = (over: Partial<EntityExchangeRecord> = {}): EntityExchangeRecord => ({
  kind: 'character',
  name: 'Ilse',
  template: 'structured',
  fields: { age: '30' },
  body: null,
  ...over
})

describe('toExchangeRecord', () => {
  it('carries the kind, the name, the template, the filled fields, and the page', () => {
    expect(toExchangeRecord(forest)).toEqual({
      kind: 'setting',
      name: 'Dark Forest',
      template: 'blank',
      fields: { description: 'Pines, all the way down.' },
      body: 'Nobody goes in after dark.'
    })
  })

  it('leaves out an empty value and a field of another kind', () => {
    const odd: EntityLike = { ...mara, fields: { age: '', goals: 'Finish it.', description: 'x' } }
    expect(toExchangeRecord(odd).fields).toEqual({ goals: 'Finish it.' })
  })
})

describe('JSON', () => {
  it('round-trips every kind through one file', () => {
    const records = [toExchangeRecord(mara), toExchangeRecord(forest)]
    const text = serializeEntitiesJson(records)
    expect(text.endsWith('\n')).toBe(true)
    expect(parseEntitiesJson(text)).toEqual(records)
  })

  it('refuses a file that is not ours, a later version, and a bad list', () => {
    expect(() => parseEntitiesJson('{')).toThrow('That file is not valid JSON.')
    expect(() => parseEntitiesJson('[]')).toThrow('That file is not a MythScribe entity file.')
    expect(() => parseEntitiesJson('{"format":"other","version":1,"entities":[]}')).toThrow(
      'That file is not a MythScribe entity file.'
    )
    expect(() =>
      parseEntitiesJson('{"format":"mythscribe-entities","version":2,"entities":[]}')
    ).toThrow('That file is version 2; this version of MythScribe reads version 1.')
    expect(() => parseEntitiesJson('{"format":"mythscribe-entities","version":1}')).toThrow(
      'That file has no "entities" list.'
    )
  })

  it('names the entity a bad value is in', () => {
    const file = (entity: string): string =>
      `{"format":"mythscribe-entities","version":1,"entities":[{"kind":"character","name":"Ok"},${entity}]}`
    const thrown = (text: string): EntityExchangeError => {
      try {
        parseEntitiesJson(text)
      } catch (err) {
        if (err instanceof EntityExchangeError) return err
        throw err
      }
      throw new Error('expected a refusal')
    }
    expect(thrown(file('{"kind":"creature","name":"Wyrm"}')).message).toBe(
      'Entity 2: "creature" is not a kind of entity'
    )
    expect(thrown(file('{"name":"Nameless"}')).row).toBe(2)
    expect(thrown(file('{"kind":"character","name":"  "}')).message).toBe(
      'Entity 2: the name is empty'
    )
    expect(thrown(file('{"kind":"character","name":"A","template":"outline"}')).message).toBe(
      'Entity 2: "outline" is not a template'
    )
    expect(thrown(file('{"kind":"character","name":"A","fields":{"age":7}}')).message).toBe(
      'Entity 2: "age" is not text'
    )
    expect(thrown(file('"nope"')).message).toBe('Entity 2: not an entity')
  })

  it('refuses a value over a stored limit rather than cutting it', () => {
    const long = (n: number): string => 'x'.repeat(n)
    const one = (entity: Record<string, unknown>): string =>
      JSON.stringify({ format: 'mythscribe-entities', version: 1, entities: [entity] })
    expect(() =>
      parseEntitiesJson(one({ kind: 'character', name: long(ENTITY_NAME_MAX + 1) }))
    ).toThrow(`Entity 1: the name is longer than ${ENTITY_NAME_MAX} characters`)
    expect(() =>
      parseEntitiesJson(
        one({ kind: 'character', name: 'A', fields: { age: long(ENTITY_FIELD_MAX + 1) } })
      )
    ).toThrow(`Entity 1: "age" is longer than ${ENTITY_FIELD_MAX} characters`)
    expect(() =>
      parseEntitiesJson(one({ kind: 'character', name: 'A', body: long(ENTITY_BODY_MAX + 1) }))
    ).toThrow(`Entity 1: the page is longer than ${ENTITY_BODY_MAX} characters`)
  })

  it('reads a hand-written file: defaults the template, drops empty values, ignores the rest', () => {
    const text = JSON.stringify({
      format: 'mythscribe-entities',
      version: 1,
      entities: [
        {
          kind: 'character',
          name: '  Ilse  ',
          fields: { age: '30', goals: '', atmosphere: 'Damp', favourite: 'tea' },
          body: '',
          id: 'ignored'
        }
      ]
    })
    expect(parseEntitiesJson(text)).toEqual([
      { kind: 'character', name: 'Ilse', template: 'structured', fields: { age: '30' }, body: null }
    ])
  })
})

describe('CSV', () => {
  it('writes the BOM, every column in order, and CRLF rows', () => {
    const text = serializeEntitiesCsv([toExchangeRecord(mara)])
    expect(text.startsWith(CSV_BOM)).toBe(true)
    const [header, row] = text.slice(CSV_BOM.length).split('\r\n')
    expect(header).toBe(ENTITY_CSV_COLUMNS.join(','))
    expect(row?.startsWith('character,Mara Vell,structured,31,')).toBe(true)
    expect(text.endsWith('\r\n')).toBe(true)
  })

  it('round-trips commas, quotes, newlines, and unicode', () => {
    const awkward = record({
      name: 'Zoë, the "Quiet"',
      fields: { appearance: 'Line one\r\nLine two, with a comma' },
      body: 'He said "no".'
    })
    const text = serializeEntitiesCsv([awkward, toExchangeRecord(forest)])
    expect(parseEntitiesCsv(text, 'character')).toEqual([awkward, toExchangeRecord(forest)])
  })

  it('escapes only the cells that need it', () => {
    expect(csvEscape('plain')).toBe('plain')
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('a"b')).toBe('"a""b"')
    expect(csvEscape('a\nb')).toBe('"a\nb"')
  })

  it('parses rows with a trailing newline, an empty last cell, and LF endings', () => {
    expect(parseCsv('a,b\r\nc,\r\n')).toEqual([
      ['a', 'b'],
      ['c', '']
    ])
    expect(parseCsv('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
    expect(parseCsv('')).toEqual([])
  })

  it('ignores a column of another kind and a heading it does not know', () => {
    const text =
      'kind,name,age,atmosphere,notes,colour\r\nsetting,Harbour,400,Salt air,Busy,blue\r\n'
    expect(parseEntitiesCsv(text, 'character')).toEqual([
      {
        kind: 'setting',
        name: 'Harbour',
        template: 'structured',
        fields: { atmosphere: 'Salt air', notes: 'Busy' },
        body: null
      }
    ])
  })

  it('takes the kind the import was started from when the file does not say', () => {
    const text = 'name,age\r\nIlse,30\r\n\r\n'
    expect(parseEntitiesCsv(text, 'character')).toEqual([record()])
    expect(parseEntitiesCsv('name\r\nTide Law\r\n', 'world')).toEqual([
      { kind: 'world', name: 'Tide Law', template: 'structured', fields: {}, body: null }
    ])
  })

  it('refuses a file with no rows, no name column, or a bad row', () => {
    expect(() => parseEntitiesCsv('', 'character')).toThrow('That file has no rows.')
    expect(() => parseEntitiesCsv('kind,age\r\ncharacter,30\r\n', 'character')).toThrow(
      'That file has no "name" column.'
    )
    expect(() => parseEntitiesCsv('kind,name\r\ncreature,Wyrm\r\n', 'character')).toThrow(
      'Row 1: "creature" is not a kind of entity'
    )
    expect(() => parseEntitiesCsv('name\r\nOk\r\n  \r\n,\r\n', 'character')).not.toThrow()
  })

  it('strips a BOM the reader is handed and keeps the first heading readable', () => {
    expect(parseEntitiesCsv(`${CSV_BOM}kind,name\r\ncharacter,Ilse\r\n`, 'setting')).toEqual([
      { kind: 'character', name: 'Ilse', template: 'structured', fields: {}, body: null }
    ])
  })
})

describe('planEntityImport', () => {
  it('matches by kind and name key, defaults add or merge, and drops in-file duplicates', () => {
    const incoming = [
      record({ name: '  mara   vell ' }),
      record({ name: 'Ilse' }),
      record({ name: 'MARA VELL' }),
      record({ kind: 'setting', name: 'Mara Vell' })
    ]
    const plan = planEntityImport([mara, forest], incoming)
    expect(plan.duplicates).toBe(1)
    expect(
      plan.items.map((item) => [item.id, item.record.name, item.existingId, item.action])
    ).toEqual([
      // The name key matches whatever the spacing and the case; a parsed row is trimmed, and a
      // setting of the same name is another entity entirely.
      ['r1', '  mara   vell ', 'e-mara', 'merge'],
      ['r2', 'Ilse', null, 'add'],
      ['r4', 'Mara Vell', null, 'add']
    ])
  })

  it('offers only the actions a row can take', () => {
    expect(actionsFor({ existingId: null })).toEqual(['add', 'skip'])
    expect(actionsFor({ existingId: 'e-mara' })).toEqual(['merge', 'replace', 'skip'])
  })

  it('counts the chosen actions and leaves skips out', () => {
    const plan = planEntityImport([mara], [record({ name: 'Mara Vell' }), record()])
    const items = [
      { ...plan.items[0]!, action: 'replace' as const },
      { ...plan.items[1]!, action: 'skip' as const }
    ]
    expect(countImportActions(items)).toEqual({ added: 0, merged: 0, replaced: 1 })
  })
})

describe('mergePatch', () => {
  const incoming = record({
    name: 'Mara Vell',
    template: 'blank',
    fields: { age: '99', background: 'Born at sea.', goals: '' },
    body: 'A page from the file.'
  })

  it('merge fills only what is empty and never touches the template', () => {
    expect(mergePatch(mara, incoming, 'merge')).toEqual({
      fields: { background: 'Born at sea.' },
      body: 'A page from the file.'
    })
  })

  it('replace overwrites the values the file has and takes its template', () => {
    expect(mergePatch(mara, incoming, 'replace')).toEqual({
      fields: { age: '99', background: 'Born at sea.' },
      template: 'blank',
      body: 'A page from the file.'
    })
  })

  it('an empty incoming value never erases what is stored', () => {
    const empty = record({ name: 'Mara Vell', template: 'structured', fields: {}, body: null })
    expect(mergePatch(mara, empty, 'replace')).toEqual({})
    expect(mergePatch(mara, empty, 'merge')).toEqual({})
  })

  it('a blank stored page counts as empty, and a page is left alone under merge', () => {
    const blankBody: EntityLike = { ...mara, body: '   ' }
    expect(mergePatch(blankBody, incoming, 'merge').body).toBe('A page from the file.')
    const written: EntityLike = { ...mara, body: 'The author’s own page.' }
    expect(mergePatch(written, incoming, 'merge').body).toBeUndefined()
    expect(mergePatch(written, incoming, 'replace').body).toBe('A page from the file.')
  })

  it('a row that says exactly what is stored is an empty patch', () => {
    expect(mergePatch(mara, toExchangeRecord(mara), 'replace')).toEqual({})
  })
})

describe('file names', () => {
  it('names an export after the project and the kind', () => {
    expect(entityExportFileName('Smoke Novel', 'character', 'json')).toBe(
      'Smoke Novel-characters.json'
    )
    expect(entityExportFileName('Smoke Novel', 'world', 'csv')).toBe('Smoke Novel-world.csv')
  })

  it('reads the format from the extension, and nothing else', () => {
    expect(entityExchangeFormatOf('library.JSON')).toBe('json')
    expect(entityExchangeFormatOf('rows.csv')).toBe('csv')
    expect(entityExchangeFormatOf('book.docx')).toBeNull()
    expect(entityExchangeFormatOf('noextension')).toBeNull()
  })
})
