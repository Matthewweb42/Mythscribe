import { describe, expect, it } from 'vitest'
import { parseReaderAnswer, parseVerifyAnswer, salvageJsonItems } from './readerAnswer'

/** What a parsed claim adds to the reply's own item (P2b: knows and steps carry these). */
const P2B = { how: null, fr: null }

const claim = {
  p: 1,
  r: 'r1',
  s: 'eyes',
  v: 'grey',
  q: "Mara's eyes were grey",
  voice: 'narration',
  sp: null,
  mode: 'now',
  o: null,
  chg: false
}

describe('parseReaderAnswer (F-16.17)', () => {
  it('reads claims, new names, same and drop, and the card', () => {
    const answer = parseReaderAnswer(
      JSON.stringify({
        c: [claim],
        n: [{ n: 'Hesk', p: 2, q: 'Hesk took the oars', c: [{ ...claim, r: 'r9', s: 'role' }] }],
        same: ['c1'],
        drop: ['c2'],
        card: {
          line: 'Mara waits on the quay.',
          gist: 'Mara waits.',
          where: ['the quay', 1, 'She walked to the quay'],
          when: null,
          year: [1811, 0, 'It was 1811'],
          elapsed: null,
          pov: ['r1', 1, "Mara's eyes were grey"],
          flash: [false],
          present: [['r1', 1, "Mara's eyes were grey"], ['r2']],
          mood: 'tense',
          theme: ''
        }
      })
    )
    expect(answer?.claims).toEqual([{ ...claim, ...P2B }])
    // A new name's facts are about the name: the reader's "r" is dropped.
    expect(answer?.names).toEqual([
      { n: 'Hesk', p: 2, q: 'Hesk took the oars', c: [{ ...claim, ...P2B, r: null, s: 'role' }] }
    ])
    expect(answer?.topics).toEqual([])
    expect(answer?.same).toEqual(['c1'])
    expect(answer?.drop).toEqual(['c2'])
    expect(answer?.card).toMatchObject({
      line: 'Mara waits on the quay.',
      where: { value: 'the quay', p: 1, q: 'She walked to the quay' },
      year: { value: '1811', p: 0, q: 'It was 1811' },
      pov: { value: 'r1', p: 1 },
      flash: null,
      present: [{ value: 'r1', p: 1, q: "Mara's eyes were grey" }],
      mood: 'tense',
      theme: null
    })
    // The present entry with no paragraph and quote did not parse.
    expect(answer?.dropped).toBe(1)
    expect(answer?.salvaged).toBe(false)
  })

  it('drops an item that does not parse and counts it; a missing voice or mode reads as narration, now', () => {
    const answer = parseReaderAnswer(
      JSON.stringify({
        c: [
          { ...claim, voice: undefined, mode: undefined },
          { ...claim, voice: 'shouted' },
          { ...claim, q: '' },
          'nonsense'
        ]
      })
    )
    expect(answer?.claims).toEqual([{ ...claim, ...P2B }])
    expect(answer?.dropped).toBe(3)
    expect(answer?.card).toBeNull()
  })

  it('reads a fenced reply, and answers null for one with nothing to read', () => {
    expect(parseReaderAnswer('```json\n{"c":[]}\n```')?.claims).toEqual([])
    expect(parseReaderAnswer('I could not read that.')).toBeNull()
  })

  it('salvages a reply cut off at its cap up to the last complete item', () => {
    const full = JSON.stringify({
      c: [claim, { ...claim, p: 2, q: 'She walked to the quay', s: 'location', v: 'the quay' }],
      n: [{ n: 'Hesk', p: 3, q: 'Hesk took the oars', c: [] }],
      same: []
    })
    const cut = full.slice(0, full.indexOf('"location"') + 5)
    const answer = parseReaderAnswer(cut)
    expect(answer?.salvaged).toBe(true)
    expect(answer?.claims).toEqual([{ ...claim, ...P2B }])
    expect(answer?.names).toEqual([])
    // Names before claims, and the claims array nested in a name is never read as the root one.
    const named = JSON.stringify({
      n: [{ n: 'Hesk', p: 3, q: 'Hesk took the oars', c: [{ ...claim, r: null }] }],
      c: [claim, claim]
    })
    const answer2 = parseReaderAnswer(named.slice(0, -20))
    expect(answer2?.names.map((name) => name.c.length)).toEqual([1])
    expect(answer2?.claims).toEqual([{ ...claim, ...P2B }])
  })

  it('salvageJsonItems skips a broken element and stops at a cut one', () => {
    const text = '{"c":[{"a":1},{"a":},{"b":"x}y"},{"c":'
    expect(salvageJsonItems(text, 'c')).toEqual([{ a: 1 }, { b: 'x}y' }])
    expect(salvageJsonItems(text, 'n')).toEqual([])
    expect(salvageJsonItems('{"same":["c1","c2"],"c":[', 'same')).toEqual(['c1', 'c2'])
  })
})

describe('parseVerifyAnswer (F-16.17)', () => {
  it('reads the verdicts by item, the first one for a repeated number', () => {
    const verdicts = parseVerifyAnswer(
      JSON.stringify({
        v: [
          { i: 1, ok: true, r: 'r1', voice: 'narration', mode: 'now' },
          { i: 2, ok: false },
          { i: 1, ok: false },
          { i: 3, ok: true, voice: 'sung', mode: 'now' },
          { i: 0, ok: true }
        ]
      })
    )
    expect([...verdicts.keys()]).toEqual([1, 2, 3])
    expect(verdicts.get(1)).toEqual({
      i: 1,
      ok: true,
      r: 'r1',
      voice: 'narration',
      mode: 'now',
      ...P2B
    })
    expect(verdicts.get(2)).toEqual({ i: 2, ok: false, r: null, voice: null, mode: null, ...P2B })
    // An unknown voice is no confirmation.
    expect(verdicts.get(3)?.voice).toBeNull()
  })

  it('salvages a cut-off reply and answers nothing for prose', () => {
    expect([...parseVerifyAnswer('{"v":[{"i":1,"ok":true},{"i":2,"ok":tr').keys()]).toEqual([1])
    expect(parseVerifyAnswer('Supported.').size).toBe(0)
  })
})

describe('parseReaderAnswer: knows lines, thread steps and topics (F-16.22, F-16.23)', () => {
  const knows = {
    p: 1,
    r: 'r3',
    s: 'knows',
    o: 's1',
    how: 'overheard',
    fr: 'r2',
    q: 'Orrin overheard Tomas',
    voice: 'narration',
    mode: 'now'
  }
  const step = {
    p: 2,
    r: 'x2',
    s: 'thread',
    how: 'opens',
    v: 'Mara swears to find the heir',
    q: 'Mara swore to find the heir',
    voice: 'narration',
    mode: 'now'
  }

  it('reads a knows line (its value its how), a step, and the secrets and threads in "n"', () => {
    const answer = parseReaderAnswer(
      JSON.stringify({
        c: [knows, step],
        n: [
          { n: 'the sold map', kind: 'secret', id: 'x1', p: 0, q: 'Tomas sold the map' },
          {
            n: 'the missing heir',
            kind: 'Thread',
            id: 'x2',
            p: 2,
            q: 'Mara swore to find the heir'
          },
          { id: 's3', kind: 'secret', p: 0, q: 'Tomas sold the map' },
          { n: 'Hesk', p: 2, q: 'Hesk took the oars', c: [] }
        ]
      })
    )
    expect(answer?.claims).toEqual([
      { ...knows, v: 'overheard', sp: null, chg: false },
      { ...step, sp: null, o: null, chg: false, fr: null }
    ])
    expect(answer?.topics).toEqual([
      { id: 'x1', kind: 'secret', label: 'the sold map', p: 0, q: 'Tomas sold the map' },
      {
        id: 'x2',
        kind: 'thread',
        label: 'the missing heir',
        p: 2,
        q: 'Mara swore to find the heir'
      },
      // A listed one's reveal stated again: no label.
      { id: 's3', kind: 'secret', label: null, p: 0, q: 'Tomas sold the map' }
    ])
    expect(answer?.names.map((name) => name.n)).toEqual(['Hesk'])
    expect(answer?.dropped).toBe(0)
  })

  it('counts a topic with no id or quote, and a fact with no value that is not a knows line', () => {
    const answer = parseReaderAnswer(
      JSON.stringify({
        c: [
          { ...step, v: '' },
          { ...knows, how: null, v: null }
        ],
        n: [{ n: 'the sold map', kind: 'secret', p: 0, q: 'Tomas sold the map' }]
      })
    )
    // A step keeps its value; a knows line with neither a value nor a how has none.
    expect(answer?.claims.map((claim) => claim.s)).toEqual([])
    expect(answer?.topics).toEqual([])
    expect(answer?.dropped).toBe(3)
  })

  it('salvages knows lines and topics from a reply cut off at its cap', () => {
    const whole = JSON.stringify({
      c: [knows, step],
      n: [{ n: 'the sold map', kind: 'secret', id: 'x1', p: 0, q: 'Tomas sold the map' }]
    })
    const cut = whole.slice(0, whole.indexOf('"kind":"secret"') - 10)
    const answer = parseReaderAnswer(cut)
    expect(answer?.salvaged).toBe(true)
    expect(answer?.claims.map((claim) => [claim.s, claim.how])).toEqual([
      ['knows', 'overheard'],
      ['thread', 'opens']
    ])
    expect(answer?.topics).toEqual([])
  })
})

describe('parseVerifyAnswer: how and from (F-16.22)', () => {
  it('reads how and fr as written, leniently; a bad one is no answer on it', () => {
    const verdicts = parseVerifyAnswer(
      JSON.stringify({
        v: [
          { i: 1, ok: true, r: 'r3', how: 'overheard', fr: 'r2', voice: 'narration', mode: 'now' },
          { i: 2, ok: true, how: ' Resolves ', voice: 'narration', mode: 'now' },
          { i: 3, ok: true, r: 'r3', how: 7, fr: 4, voice: 'narration', mode: 'now' },
          { i: 4, ok: true }
        ]
      })
    )
    expect(verdicts.get(1)).toMatchObject({ how: 'overheard', fr: 'r2' })
    expect(verdicts.get(2)).toMatchObject({ how: 'Resolves', fr: null, r: null })
    expect(verdicts.get(3)).toMatchObject({ how: null, fr: null, r: 'r3' })
    expect(verdicts.get(4)).toMatchObject({ ok: true, how: null, fr: null })
  })
})
