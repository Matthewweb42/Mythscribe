import { describe, expect, it } from 'vitest'
import { dismissedKey } from './dismissed'
import {
  countNameSpans,
  NAME_QUESTIONS_MAX,
  NameAnswer,
  nameQuestions,
  type NameQuestionDismissals
} from './nameQuestions'

const ROSTER = [
  { id: 'rynna', names: ['Rynna Falsire', 'Rynna'] },
  { id: 'tomas', names: ['Tomas Vell'] }
]
const NONE: NameQuestionDismissals = { names: [], aliasKeys: new Set() }

const docs = (...texts: string[]) =>
  texts.map((text, i) => ({ nodeId: `s${i + 1}`, counts: countNameSpans(text) }))

describe('nameQuestions (F-16.4)', () => {
  it('asks about a recurring new name the gate clears, and a nickname the gate ties to a record', () => {
    const questions = nameQuestions(
      docs(
        'They met Hesk at noon, and Ry laughed at Hesk.',
        'Later Hesk left, and Ry and Rynna followed.'
      ),
      ROSTER,
      NONE
    )
    expect(questions).toEqual([
      {
        kind: 'newName',
        name: 'Hesk',
        norm: 'hesk',
        count: 3,
        nodeIds: ['s1', 's2'],
        recordId: null,
        recordName: null
      },
      {
        kind: 'nickname',
        name: 'Ry',
        norm: 'ry',
        count: 2,
        nodeIds: ['s1', 's2'],
        recordId: 'rynna',
        recordName: 'Rynna Falsire'
      }
    ])
  })

  it('skips known names, titles, stoplist words, sentence openers and names said once', () => {
    expect(
      nameQuestions(
        docs(
          'Then Falsire met Captain Vell on Monday. Then Falsire met Captain Vell on Monday. Once Brand.'
        ),
        ROSTER,
        NONE
      )
    ).toEqual([])
  })

  it('keeps a dismissed name and a refused nickname silent', () => {
    const text = 'They met Hesk and Ry, and Hesk met Ry.'
    expect(
      nameQuestions(docs(text), ROSTER, {
        names: ['Hesk'],
        aliasKeys: new Set([dismissedKey({ kind: 'alias', recordId: 'rynna', alias: 'Ry' })])
      })
    ).toEqual([])
  })

  it('F-16.17: asks about a name seen once mid-sentence when the reader proposed it with a proved fact', () => {
    const once = 'The rain fell. Then old Hesk took the oars.'
    expect(nameQuestions(docs(once), ROSTER, NONE)).toEqual([])
    // Identity rule 6: a name seen only opening a sentence is never asked about ("Hope filled…").
    expect(
      nameQuestions(docs('The rain fell. Hesk took the oars.'), ROSTER, NONE, {
        proved: new Set(['hesk'])
      })
    ).toEqual([])
    expect(
      nameQuestions(docs(once), ROSTER, NONE, { proved: new Set(['hesk']) }).map((q) => [
        q.kind,
        q.name,
        q.count
      ])
    ).toEqual([['newName', 'Hesk', 1]])
    // Still never one the author dismissed.
    expect(
      nameQuestions(docs(once), ROSTER, { ...NONE, names: ['Hesk'] }, { proved: new Set(['hesk']) })
    ).toEqual([])
  })

  it('asks about an ordinary word only when it is capitalised mid-sentence often', () => {
    expect(nameQuestions(docs('the trial; at the Trial, the Trial.'), ROSTER, NONE)).toEqual([])
    expect(
      nameQuestions(docs('a trial; the Trial, the Trial, the Trial, the Trial.'), ROSTER, NONE).map(
        (question) => question.name
      )
    ).toEqual(['Trial'])
  })

  it('asks about a two-word name as one name, never as its words', () => {
    const questions = nameQuestions(
      docs('Hesk Varn came in. Later we saw Hesk Varn leave, and we watched Hesk Varn go.'),
      ROSTER,
      NONE
    )
    expect(questions.map((q) => [q.kind, q.name, q.count])).toEqual([['newName', 'Hesk Varn', 3]])
  })

  it('asks whether a record name used alone is that record, not about a stranger with its surname', () => {
    const roster = [{ id: 'r1', names: ['Rynna Falsire'] }]
    expect(
      nameQuestions(
        docs(
          'The rain fell. Later Rynna smiled at him. He said Rynna was tired. They saw Rynna again by the gate.'
        ),
        roster,
        NONE
      ).map((q) => [q.kind, q.name, q.recordId, q.count])
    ).toEqual([['nickname', 'Rynna', 'r1', 3]])
    expect(
      nameQuestions(docs('He met Falsire at noon and saw Falsire again.'), roster, NONE).map(
        (q) => [q.kind, q.name, q.recordId]
      )
    ).toEqual([['nickname', 'Falsire', 'r1']])
    // "Jem Falsire" is a new name (identity rule 1), never a question about "Falsire".
    expect(
      nameQuestions(docs('He met Jem Falsire, and Jem Falsire left.'), roster, NONE).map((q) => [
        q.kind,
        q.name
      ])
    ).toEqual([['newName', 'Jem Falsire']])
  })

  it('never offers a title with a name as a nickname (identity rule 2), and asks nothing the scan already finds', () => {
    expect(
      nameQuestions(docs('He bowed to Mr. Vell, and Mr. Vell bowed back.'), ROSTER, NONE)
    ).toEqual([])
    expect(
      nameQuestions(docs('He bowed to Mr. Pruett, and Mr. Pruett bowed back.'), ROSTER, NONE).map(
        (q) => [q.kind, q.name]
      )
    ).toEqual([['newName', 'Mr. Pruett']])
    const roster = [
      { id: 'w', names: ['the Wanderer'] },
      { id: 'h', names: ['Harrow'] }
    ]
    expect(
      nameQuestions(
        docs('He met the Wanderer and the Harrows; the Wanderer and the Harrows left.'),
        roster,
        NONE
      )
    ).toEqual([])
  })

  it('keeps a name dismissed as Not a name silent once a record near it exists', () => {
    const text = 'He met Hesk at noon. Then he saw Hesk again and Hesk left.'
    const dismissedHesk = {
      names: [dismissedKey({ kind: 'name', name: 'Hesk' })],
      aliasKeys: new Set<string>()
    }
    expect(nameQuestions(docs(text), [], dismissedHesk)).toEqual([])
    expect(nameQuestions(docs(text), [{ id: 'r2', names: ['Hesker'] }], dismissedHesk)).toEqual([])
    expect(
      nameQuestions(docs(text), [{ id: 'r2', names: ['Hesker'] }], NONE).map((q) => q.kind)
    ).toEqual(['nickname'])
  })

  it('caps the names an answer carries at the record name and alias limits', () => {
    const long = 'x'.repeat(201)
    expect(
      NameAnswer.safeParse({ kind: 'addAs', name: long, categoryId: 'character' }).success
    ).toBe(false)
    expect(NameAnswer.safeParse({ kind: 'notAName', name: long }).success).toBe(false)
    expect(NameAnswer.safeParse({ kind: 'yes', name: long, recordId: 'r' }).success).toBe(false)
    expect(NameAnswer.safeParse({ kind: 'no', name: 'Ry', recordId: 'r' }).success).toBe(true)
  })

  it('caps the list, most named first', () => {
    const names = Array.from({ length: 14 }, (_, i) => `Zed${String.fromCharCode(97 + i)}x`)
    const text = names
      .map((name, i) => Array.from({ length: i + 2 }, () => `met ${name}`).join(', '))
      .join('. ')
    const questions = nameQuestions(docs(text), [], NONE)
    expect(questions).toHaveLength(NAME_QUESTIONS_MAX)
    expect(questions[0]?.name).toBe(names[13])
  })
})
