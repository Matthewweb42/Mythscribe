import { describe, expect, it } from 'vitest'
import { sheetAsOf, trueNow, type AsOfClaim, type ReadingOrder } from './asOf'
import { valueKey } from './claims'

const SCENES = ['s1', 's2', 's3', 's4', 's5']
const READING: ReadingOrder = {
  order: new Map(SCENES.map((id, i) => [id, i])),
  refs: new Map(SCENES.map((id, i) => [id, `1.${i + 1}`]))
}

let next = 0
const claim = (
  over: Partial<AsOfClaim> & { nodeId: string; slot: AsOfClaim['slot']; value: string }
): AsOfClaim => {
  next += 1
  return {
    id: `c${String(next).padStart(3, '0')}`,
    recordId: 'mara',
    valueKey: valueKey(over.value),
    voice: 'narration',
    mode: 'now',
    speakerId: null,
    objectId: null,
    para: 0,
    state: 'live',
    ...over
  }
}

const BOOK: AsOfClaim[] = [
  claim({ nodeId: 's1', slot: 'hair', value: 'red' }),
  claim({ nodeId: 's2', slot: 'hair', value: 'red' }),
  claim({ nodeId: 's3', slot: 'hair', value: 'brown' }),
  claim({ nodeId: 's4', slot: 'hair', value: 'brown' }),
  claim({ nodeId: 's1', slot: 'location', value: 'the quay' }),
  claim({ nodeId: 's3', slot: 'location', value: 'the inn' }),
  claim({ nodeId: 's5', slot: 'location', value: 'the ridge' }),
  claim({ nodeId: 's2', slot: 'alive', value: 'dead', mode: 'dream' }),
  claim({ nodeId: 's2', slot: 'traits', value: 'tall', voice: 'dialogue', speakerId: 'tomas' }),
  claim({ nodeId: 's1', slot: 'eyes', value: 'grey' }),
  claim({ nodeId: 's4', slot: 'eyes', value: 'grey-blue' }),
  claim({ nodeId: 's2', slot: 'traits', value: 'clever' }),
  claim({ nodeId: 's3', slot: 'traits', value: 'clever' }),
  claim({ nodeId: 's3', slot: 'traits', value: 'stubborn' })
]

describe('trueNow (F-16.18)', () => {
  it('gives lasting values since their run began and transient ones where last stated', () => {
    const lines = trueNow(BOOK, READING, 's4')
    expect(lines.map((line) => [line.slot, line.value, line.kind, line.ref])).toEqual([
      ['hair', 'brown', 'since', '1.3'],
      ['location', 'the inn', 'lastStated', '1.3']
    ])
  })

  it('ignores later scenes', () => {
    const lines = trueNow(BOOK, READING, 's2')
    expect(lines.map((line) => [line.slot, line.value, line.ref])).toEqual([
      ['hair', 'red', '1.1'],
      ['location', 'the quay', '1.1']
    ])
  })

  it('never lets dialogue or a dream set state', () => {
    const lines = trueNow(BOOK, READING, 's5')
    expect(lines.some((line) => line.slot === 'alive')).toBe(false)
    expect(lines.some((line) => line.slot === 'traits')).toBe(false)
  })

  it('shows a stale latest value flagged, never a waiting one, and nothing for an unknown scene', () => {
    const stale = claim({ nodeId: 's5', slot: 'hair', value: 'grey', state: 'stale' })
    const waiting = claim({ nodeId: 's5', slot: 'alive', value: 'dead', state: 'waiting' })
    const lines = trueNow([...BOOK, stale, waiting], READING, 's5')
    expect(lines.find((line) => line.slot === 'hair')).toMatchObject({
      value: 'grey',
      stale: true,
      ref: '1.5'
    })
    expect(lines.some((line) => line.slot === 'alive')).toBe(false)
    expect(trueNow(BOOK, READING, 'elsewhere')).toEqual([])
  })
})

describe('sheetAsOf (F-16.18)', () => {
  it('groups the lines and counts what comes later', () => {
    const sheet = sheetAsOf(BOOK, READING, 's3')
    expect(
      sheet.fixed.map((line) => [line.slot, line.value.value, line.also.map((v) => v.value)])
    ).toEqual([['eyes', 'grey', []]])
    expect(sheet.lasting.map((line) => [line.slot, line.value.value, line.since])).toEqual([
      ['hair', 'brown', '1.3']
    ])
    expect(sheet.transient.map((line) => [line.slot, line.value.value, line.since])).toEqual([
      ['location', 'the inn', '1.3']
    ])
    expect(sheet.accumulating.map((line) => [line.value.value, line.value.ref])).toEqual([
      ['clever', '1.2'],
      ['stubborn', '1.3']
    ])
    expect(sheet.others.map((line) => [line.slot, line.voice, line.mode, line.speakerId])).toEqual([
      ['alive', 'narration', 'dream', null],
      ['traits', 'dialogue', 'now', 'tomas']
    ])
    // s4 (hair, eyes) and s5 (location) come later.
    expect(sheet.later).toBe(3)
  })

  it('shows differing fixed values side by side at the end of the book', () => {
    const sheet = sheetAsOf(BOOK, READING, null)
    expect(sheet.fixed).toHaveLength(1)
    expect(sheet.fixed[0]?.value.value).toBe('grey-blue')
    expect(sheet.fixed[0]?.also.map((value) => [value.value, value.ref])).toEqual([['grey', '1.1']])
    expect(sheet.later).toBe(0)
  })
})
