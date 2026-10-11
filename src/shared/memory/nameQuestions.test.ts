import { describe, expect, it } from 'vitest'
import { countCapitalisedWords } from '../proposedTags'
import { dismissedKey } from './dismissed'
import { NAME_QUESTIONS_MAX, nameQuestions, type NameQuestionDismissals } from './nameQuestions'

const ROSTER = [
  { id: 'rynna', names: ['Rynna Falsire', 'Rynna'] },
  { id: 'tomas', names: ['Tomas Vell'] }
]
const NONE: NameQuestionDismissals = { names: [], aliasKeys: new Set() }

const docs = (...texts: string[]) =>
  texts.map((text, i) => ({ nodeId: `s${i + 1}`, counts: countCapitalisedWords(text) }))

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

  it('skips known name words, titles, stoplist words, sentence openers and names said once', () => {
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

  it('asks about an ordinary word only when it is capitalised mid-sentence often', () => {
    expect(nameQuestions(docs('the trial; at the Trial, the Trial.'), ROSTER, NONE)).toEqual([])
    expect(
      nameQuestions(docs('a trial; the Trial, the Trial, the Trial, the Trial.'), ROSTER, NONE).map(
        (question) => question.name
      )
    ).toEqual(['Trial'])
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
