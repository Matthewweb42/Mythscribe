import { describe, expect, it } from 'vitest'
import {
  buildAskIndex,
  holdsSlotCue,
  instantShape,
  INSTANT_MAX_WORDS,
  namesInQuestion,
  questionCues,
  SLOT_QUESTION_CUES,
  slotCues,
  type AskIndex,
  type AskRecord
} from './askParse'
import { buildNameIndex } from './nameScan'
import { normName } from './names'
import type { CaseRule, RecordKind } from './records'
import { ALL_SLOTS, DETAIL_LABEL_NAMES, slotGroup } from './slots'

interface Entry {
  id: string
  kind?: RecordKind
  names: readonly (string | { text: string; shared?: boolean; caseRule?: CaseRule })[]
}

/** An index over `entries` as Step 0 builds it from the name scan's index and the roster. */
function indexOf(entries: readonly Entry[]): AskIndex {
  const records: AskRecord[] = entries.map((entry) => ({
    id: entry.id,
    kind: entry.kind ?? 'character',
    name: typeof entry.names[0] === 'string' ? entry.names[0] : (entry.names[0]?.text ?? ''),
    aliases: entry.names.map((name) => {
      const text = typeof name === 'string' ? name : name.text
      return { text, norm: normName(text) }
    })
  }))
  const named = entries.filter((entry) => !['secret', 'thread'].includes(entry.kind ?? ''))
  const names = buildNameIndex(
    named.map((entry) => ({ id: entry.id, kind: entry.kind ?? 'character' })),
    named.flatMap((entry) =>
      entry.names.map((name, i) => {
        const alias = typeof name === 'string' ? { text: name } : name
        return {
          id: `${entry.id}:${i}`,
          recordId: entry.id,
          text: alias.text,
          norm: normName(alias.text),
          caseRule: alias.caseRule ?? (/\p{Lu}/u.test(alias.text) ? 'auto' : 'any'),
          shared: alias.shared ?? false
        }
      })
    )
  )
  return buildAskIndex(names, records)
}

const BOOK = indexOf([
  { id: 'mara', names: ['Mara Vell', 'Mara', { text: 'Vell', shared: true }] },
  { id: 'tomas', names: ['Tomas Vell', 'Tomas', { text: 'Vell', shared: true }] },
  { id: 'orrin', names: ['Orrin', 'the old sailor'] },
  { id: 'will', names: [{ text: 'Will', caseRule: 'exact' }] },
  { id: 'bell', kind: 'thing', names: ['the Bell'] },
  { id: 'map', kind: 'secret', names: ['the sold map'] },
  { id: 'heir', kind: 'thread', names: ['the missing heir'] },
  { id: 'return', kind: 'secret', names: ["Orrin's return"] }
])

const named = (text: string): string[] =>
  namesInQuestion(text, BOOK).records.map((each) => each.recordId)

describe('namesInQuestion (F-16.24)', () => {
  it('finds records in any case, possessive, by nickname, the longest name first', () => {
    expect(named('how old is mara')).toEqual(['mara'])
    expect(named("Mara's eyes?")).toEqual(['mara'])
    expect(named('Where is MARA VELL now?')).toEqual(['mara'])
    expect(named('Did the old sailor see it?')).toEqual(['orrin'])
    expect(named('Does Mara Vell know Tomas?')).toEqual(['mara', 'tomas'])
    expect(namesInQuestion('Mara and Mara', BOOK).records).toHaveLength(1)
    expect(namesInQuestion("Where's Mara?", BOOK).records[0]).toMatchObject({
      text: 'Mara',
      start: 8,
      end: 12
    })
  })

  it('matches an exact-case name only in its case (the first word may differ in its first letter)', () => {
    expect(named('Where is Will?')).toEqual(['will'])
    expect(named('Will Mara come back?')).toEqual(['will', 'mara'])
    expect(named('where will mara go?')).toEqual(['mara'])
    expect(named('where WILL mara go?')).toEqual(['mara'])
  })

  it('leaves a shared surname ambiguous, never one record', () => {
    const asked = namesInQuestion('What colour are Vell’s eyes?', BOOK)
    expect(asked.records).toEqual([])
    expect(asked.ambiguous).toEqual([{ recordIds: ['mara', 'tomas'], text: 'Vell’s' }])
  })

  it('finds secrets and threads by name, or by half their label’s words with a content word', () => {
    expect(namesInQuestion('Does Orrin know about the sold map?', BOOK).topics).toEqual([
      { recordId: 'map', kind: 'secret', by: 'name', whole: true }
    ])
    // Half the label's words name it, but not whole: no instant card rests on it.
    expect(namesInQuestion('Who knows about the map sale?', BOOK).topics).toEqual([
      { recordId: 'map', kind: 'secret', by: 'terms', whole: false }
    ])
    expect(namesInQuestion('Who knows the map was sold?', BOOK).topics).toEqual([
      { recordId: 'map', kind: 'secret', by: 'terms', whole: true }
    ])
    expect(namesInQuestion('Is the heir still missing?', BOOK).topics).toEqual([
      { recordId: 'heir', kind: 'thread', by: 'terms', whole: true }
    ])
    // A record's name alone is no content word: "Where is Orrin?" is not about his return.
    expect(namesInQuestion('Where is Orrin?', BOOK).topics).toEqual([])
    expect(namesInQuestion('Who knows of Orrin’s return?', BOOK).topics).toEqual([
      { recordId: 'return', kind: 'secret', by: 'name', whole: true }
    ])
    expect(namesInQuestion('Who knows Orrin returned home?', BOOK).topics).toEqual([])
    expect(namesInQuestion('Who knows of the return of Orrin?', BOOK)).toMatchObject({
      records: [{ recordId: 'orrin' }],
      topics: [{ recordId: 'return', kind: 'secret', by: 'terms', whole: true }]
    })
    // Secrets and threads are never records.
    expect(named('the sold map')).toEqual([])
  })
})

describe('SLOT_QUESTION_CUES (P3-D2)', () => {
  it('reads every row of the table, and only fixed, lasting and transient slots', () => {
    const asked: [string, string][] = [
      ["Mara's eyes?", 'eyes'],
      ['What eye colour has Mara?', 'eyes'],
      ['Mara’s hair?', 'hair'],
      ['How old is Mara?', 'age'],
      ['Mara’s age?', 'age'],
      ['Is Mara forty years old?', 'age'],
      ['When was Mara born?', 'born'],
      ['Mara’s birthday?', 'born'],
      ['Mara’s birth year?', 'born'],
      ['Where is Mara?', 'location'],
      ["Where's Mara?", 'location'],
      ['Where was Mara?', 'location'],
      ['Mara last seen?', 'location'],
      ['Is Mara alive?', 'alive'],
      ['Is Mara dead?', 'alive'],
      ['Is Mara still living?', 'alive'],
      ['Mara’s role?', 'role'],
      ['Mara’s job?', 'role'],
      ['Mara’s position?', 'role'],
      ['Mara’s scars?', 'scars'],
      ['Is Mara hurt?', 'injuries'],
      ['Is Mara injured?', 'injuries'],
      ['Mara’s wound?', 'injuries'],
      ['What is Mara wearing?', 'clothing'],
      ['How is Mara dressed?', 'clothing'],
      ['What is Mara carrying?', 'objects'],
      ['What is Mara holding?', 'objects']
    ]
    for (const [text, slot] of asked) expect(slotCues(text), text).toEqual([slot])
    for (const label of DETAIL_LABEL_NAMES) {
      expect(slotCues(`Mara's ${label}?`), label).toEqual([`detail:${label}`])
    }
    for (const row of SLOT_QUESTION_CUES) {
      expect(ALL_SLOTS).toContain(row.slot)
      expect(['fixed', 'lasting', 'transient']).toContain(slotGroup(row.slot))
    }
    expect(SLOT_QUESTION_CUES.some((row) => row.slot === 'kinship')).toBe(false)
    expect(holdsSlotCue('Her grey eyes found him.', 'eyes')).toBe(true)
    expect(holdsSlotCue('She looked away.', 'eyes')).toBe(false)
    // Prose bears on a slot by its own words too (read-first, P3-D4; a Pinned line).
    expect(holdsSlotCue('Mara died on the cold stones.', 'alive')).toBe(true)
    expect(holdsSlotCue('Mara rode north to Vell.', 'location')).toBe(true)
    expect(holdsSlotCue('Home: Vell', 'location')).toBe(true)
    expect(holdsSlotCue('She wore the grey cloak.', 'clothing')).toBe(true)
    expect(holdsSlotCue('The blue-eyed girl laughed.', 'eyes')).toBe(true)
    expect(holdsSlotCue('Mara laughed at the joke.', 'alive')).toBe(false)
  })
})

describe('questionCues', () => {
  const cues = (text: string): ReturnType<typeof questionCues> =>
    questionCues(text, namesInQuestion(text, BOOK))

  it('reads ordinal, knows, idea, sheet-write, change and whole-book cues', () => {
    expect(questionCues('When does Lise first suspect the Captain?')).toMatchObject({
      scopeAll: true,
      knows: false
    })
    expect(questionCues('Does Mara never cry?').scopeAll).toBe(true)
    expect(questionCues('How many times does Orrin lie?').scopeAll).toBe(true)
    expect(questionCues('Does Orrin know about the map?')).toMatchObject({
      knows: true,
      learns: false
    })
    expect(questionCues('When does Tomas find out?')).toMatchObject({ knows: true, learns: true })
    expect(questionCues('Has Mara heard?').learns).toBe(true)
    expect(questionCues('What was my idea about the Captain?').idea).toBe(true)
    expect(questionCues('what did I want for chapter 3').idea).toBe(true)
    expect(cues('Add to Mara’s sheet that she hates the sea.')).toMatchObject({
      sheetWrite: true,
      change: true
    })
    expect(cues('Save this for Mara: a scar from the fire.').sheetWrite).toBe(true)
    expect(cues('pin that on the Bell').sheetWrite).toBe(true)
    expect(cues('Brainstorm: Lottie had a twin; save it').sheetWrite).toBe(true)
    expect(cues('Could you put this on Mara’s Pinned?').sheetWrite).toBe(true)
    expect(cues('Add a line where Mara laughs.')).toMatchObject({
      sheetWrite: false,
      change: true
    })
    expect(questionCues('Rewrite the opening.').change).toBe(true)
    expect(questionCues('Great, now polish the paragraph about her eyes.').change).toBe(true)
    expect(questionCues('Can you tighten this scene?').change).toBe(true)
    expect(questionCues('Who dies by the end?').wholeBook).toBe(true)
    expect(questionCues('Does Mara ever cry in the book?').wholeBook).toBe(true)
    expect(questionCues('Where is Mara?')).toEqual({
      scopeAll: false,
      knows: false,
      learns: false,
      idea: false,
      sheetWrite: false,
      change: false,
      wholeBook: false
    })
  })

  it('takes "first name", "last name" and "last seen" as about now, not over the book', () => {
    expect(questionCues('What is Mara’s first name?').scopeAll).toBe(false)
    expect(questionCues('What is Mara’s last name?').scopeAll).toBe(false)
    expect(questionCues('Where was Mara last seen?').scopeAll).toBe(false)
    expect(questionCues('Where was Mara first seen?').scopeAll).toBe(true)
    expect(questionCues('When did Mara last see Tomas?').scopeAll).toBe(true)
  })

  it('counts an edit only when the request opens with its verb, a sheet only when one is named', () => {
    // Read questions with an edit verb in them ask about the story, not for an edit.
    expect(questionCues('Who cut the rope?').change).toBe(false)
    expect(questionCues('Where did Mara write the letter?').change).toBe(false)
    // Manuscript edits that name a chapter, a scene or a record for whom: never a sheet line.
    for (const text of [
      'Add a line of dialogue for Tomas',
      'Add a scene to Chapter 3',
      'Put a storm in Chapter 2',
      'Add a scene in Chapter 3 where Mara meets Tomas'
    ]) {
      expect(cues(text), text).toMatchObject({ sheetWrite: false, change: true })
    }
    // "pin" as a noun, and a sheet word in a question.
    expect(cues('Where is the pin Mara lost?').sheetWrite).toBe(false)
    expect(cues('Is the pin on Mara’s sheet?').sheetWrite).toBe(false)
    // Without the names, a record is never a target.
    expect(questionCues('Save this for Mara: a scar from the fire.').sheetWrite).toBe(false)
  })
})

describe('instantShape (P3-D2)', () => {
  const shape = (text: string): ReturnType<typeof instantShape> =>
    instantShape(text, namesInQuestion(text, BOOK), BOOK.topics)

  it('takes one record and one slot cue, one knower and one secret, or one secret with who', () => {
    expect(shape("Mara's eyes?")).toEqual({ kind: 'slot', recordId: 'mara', slot: 'eyes' })
    expect(shape('how old is mara')).toEqual({ kind: 'slot', recordId: 'mara', slot: 'age' })
    expect(shape("Where's Tomas?")).toEqual({
      kind: 'slot',
      recordId: 'tomas',
      slot: 'location'
    })
    expect(shape('Does Orrin know about the sold map?')).toEqual({
      kind: 'knows',
      knowerId: 'orrin',
      secretId: 'map'
    })
    expect(shape('Who knows the map was sold?')).toEqual({ kind: 'whoKnows', secretId: 'map' })
    // The secret's own name is not a second record.
    expect(shape('Who knows of Orrin’s return?')).toEqual({ kind: 'whoKnows', secretId: 'return' })
    expect(shape('Who knows of the return of Orrin?')).toEqual({
      kind: 'whoKnows',
      secretId: 'return'
    })
  })

  it('binds the cue to the record: next to it, through "is", "still", "now" or "of"', () => {
    const asked: [string, string][] = [
      ['What colour are Mara’s eyes?', 'eyes'],
      ['Mara’s eye colour?', 'eyes'],
      ['What eye colour has Mara?', 'eyes'],
      ['How old is Mara now?', 'age'],
      ['What is the age of Mara?', 'age'],
      ['When was Mara born?', 'born'],
      ['Where is Mara Vell now?', 'location'],
      ['Where was Mara last seen?', 'location'],
      ['Is Mara still alive?', 'alive'],
      ['What job does Mara have?', 'role'],
      ['Does Mara have scars?', 'scars'],
      ['What is Mara wearing?', 'clothing'],
      ['Can you tell me Mara’s height?', 'detail:height']
    ]
    for (const [text, slot] of asked) {
      expect(shape(text), text).toEqual({ kind: 'slot', recordId: 'mara', slot })
    }
  })

  it('answers null for why, a change, an accumulating slot, a long question, two records or a shared name', () => {
    expect(shape('Why are Mara’s eyes grey?')).toBeNull()
    expect(shape('Make Mara’s eyes green')).toBeNull()
    expect(shape('Should Mara’s hair be red?')).toBeNull()
    expect(shape('What if Mara’s eyes were brown?')).toBeNull()
    expect(shape('Pin Mara’s eyes')).toBeNull()
    expect(shape('Mara’s traits?')).toBeNull()
    expect(shape('Who is Mara’s brother?')).toBeNull()
    const long = 'Tell me please what colour exactly are the eyes of Mara in this one?'
    expect(long.split(' ').length).toBeGreaterThan(INSTANT_MAX_WORDS)
    expect(shape(long)).toBeNull()
    expect(shape('Mara’s and Tomas’s eyes?')).toBeNull()
    expect(shape('Vell’s eyes?')).toBeNull()
    expect(shape('Mara’s eyes and hair?')).toBeNull()
    expect(shape('Does Orrin know?')).toBeNull()
    expect(shape('Does Orrin know Tomas sold the map?')).toBeNull()
    expect(shape('Who knows?')).toBeNull()
    expect(shape('')).toBeNull()
  })

  it('answers null for an edit request, so F-5.26’s passes keep it', () => {
    for (const text of [
      'Fix Mara’s eye colour',
      'Rewrite the bit about Mara’s hair',
      'Remove Mara’s scar',
      'Delete the line about Mara’s hair',
      'Polish the paragraph about Mara’s eyes',
      'Set Mara’s age to 40',
      'Cut the line about Mara’s hair',
      'Tighten the bit where Mara is hurt',
      'Can you update Mara’s role?',
      'Who cut Mara’s hair?'
    ]) {
      expect(shape(text), text).toBeNull()
    }
  })

  it('answers null for first, last, ever, never, another time, a scene or a negation (P3-D8)', () => {
    for (const text of [
      'Where was Mara first seen?',
      'What was Mara’s first job?',
      'What was Mara’s last role?',
      'Was Mara ever hurt?',
      'Was Mara ever injured before the war?',
      'What was Mara first wearing?',
      'Where was Mara in 1.1?',
      'How old was Mara in chapter 1?',
      'How old was Mara in Chapter Two?',
      'Where was Mara when the bell rang?',
      'Where was Mara then?',
      'Was Mara alive at the start?',
      'When did Mara lose her job?',
      'Did Orrin know about the sold map before 1.2?',
      'When does Orrin know about the sold map?',
      'Who never heard about the sold map?',
      'Does Orrin not know about the sold map?',
      'Who doesn’t know about the sold map?',
      'Who knows nothing of the sold map?',
      'Is Mara not alive?'
    ]) {
      expect(shape(text), text).toBeNull()
    }
  })

  it('answers null when the cue asks about another thing of the record, or the secret is half named', () => {
    for (const text of [
      'What colour are Mara’s mother’s eyes?',
      'Where is Mara’s sword?',
      'How old is Orrin’s daughter?',
      'How old is the daughter of Orrin?',
      'Where is the ship Mara sails?',
      'Does Orrin’s sister know about the sold map?',
      'Does Orrin know where the map is?',
      'Who knows the map is hidden?',
      'Who knows about the map sale?'
    ]) {
      expect(shape(text), text).toBeNull()
    }
  })
})
