import { describe, expect, it } from 'vitest'
import { passageParagraphs } from '../mentions'
import type { ClaimMode, ClaimVoice } from './claims'
import { hasLiteralPatterns, literalProof, sentenceNames, type LiteralName } from './literal'
import type { NameMention } from './nameScan'
import { splitSentences } from './sentences'
import type { Slot } from './slots'

interface NameSpec {
  text: string
  recordId: string
  kind?: LiteralName['kind']
  ambiguous?: boolean
}

/** Names found by searching the sentence for each name's text (the scan's job in the app). */
function namesIn(sentence: string, names: readonly NameSpec[]): LiteralName[] {
  return names.flatMap((name) => {
    const found: LiteralName[] = []
    let at = sentence.indexOf(name.text)
    while (at !== -1) {
      found.push({
        recordId: name.recordId,
        kind: name.kind ?? 'character',
        start: at,
        end: at + name.text.length,
        ambiguous: name.ambiguous ?? false
      })
      at = sentence.indexOf(name.text, at + name.text.length)
    }
    return found
  })
}

const MARA = { text: 'Mara', recordId: 'mara' }
const TOMAS = { text: 'Tomas', recordId: 'tomas' }
const QUAY = { text: 'the Quay', recordId: 'quay', kind: 'place' as const }

function prove(
  sentence: string,
  claim: { slot: Slot; value: string; quote?: string; voice?: ClaimVoice; mode?: ClaimMode },
  names: readonly NameSpec[] = [MARA, TOMAS, QUAY]
): ReturnType<typeof literalProof> {
  return literalProof(
    {
      recordId: 'mara',
      slot: claim.slot,
      value: claim.value,
      voice: claim.voice ?? 'narration',
      mode: claim.mode ?? 'now',
      quote: claim.quote ?? sentence.replace(/[.!?]$/, '')
    },
    sentence,
    namesIn(sentence, names)
  )
}

describe('literalProof: the patterns (F-16.17)', () => {
  it.each<[string, Slot, string, string]>([
    ["Mara's grey eyes followed him.", 'eyes', 'grey', 'grey'],
    ["Mara's eyes were a cold, clear grey.", 'eyes', 'grey', 'grey'],
    ['Mara had green eyes.', 'eyes', 'green', 'green'],
    ["Mara's hair was red as rust.", 'hair', 'red', 'red'],
    ['Mara had long black hair.', 'hair', 'long black', 'long black'],
    [
      'Mara had a scar across her chin.',
      'scars',
      'a scar across her chin',
      'a scar across her chin'
    ],
    ['Mara was born in Vellmouth.', 'born', 'Vellmouth', 'Vellmouth'],
    ['Mara was twenty-one years old.', 'age', 'twenty-one', 'twenty-one'],
    ['Mara was 34.', 'age', '34', '34'],
    ['Mara was seven-and-twenty that winter.', 'age', 'seven-and-twenty', 'seven-and-twenty'],
    ['Mara was dead.', 'alive', 'dead', 'dead'],
    ['Mara died in the night.', 'alive', 'dead', 'dead'],
    ['Mara wore a blue coat.', 'clothing', 'a blue coat', 'a blue coat'],
    ['Mara was wearing a blue coat.', 'clothing', 'blue coat', 'blue coat'],
    ['Mara carried a lantern.', 'objects', 'a lantern', 'a lantern'],
    ['Mara held the map.', 'objects', 'the map', 'the map'],
    ['Mara was at the Quay.', 'location', 'the Quay', 'the Quay'],
    ['Mara stood in the doorway.', 'location', 'in the doorway', 'in the doorway'],
    ['Mara was clever and quick.', 'traits', 'clever and quick', 'clever and quick'],
    [
      'Mara was the daughter of a miller.',
      'kinship',
      'daughter of a miller',
      'daughter of a miller'
    ]
  ])('proves "%s" as %s', (sentence, slot, value, shown) => {
    expect(prove(sentence, { slot, value })).toEqual({ ok: true, value: shown })
  })

  it('cuts the shown value to the words of the quote as written', () => {
    expect(prove("Mara's eyes were a Cold, clear GREY.", { slot: 'eyes', value: 'grey' })).toEqual({
      ok: true,
      value: 'GREY'
    })
    expect(prove('Mara was at the Quay.', { slot: 'location', value: 'the harbour' })).toEqual({
      ok: false,
      reason: 'value'
    })
  })

  it('reads a possessive, a title with a stop and "the" before a confirmed title', () => {
    const captain = { text: 'the Captain', recordId: 'mara' }
    expect(
      prove(
        'Everyone knew that the Captain had a long white scar across his jaw.',
        {
          slot: 'scars',
          value: 'a long white scar across his jaw',
          quote: 'the Captain had a long white scar across his jaw'
        },
        [captain]
      )
    ).toEqual({ ok: true, value: 'a long white scar across his jaw' })
    expect(
      prove("Mr. Vell's eyes were brown.", { slot: 'eyes', value: 'brown' }, [
        { text: 'Mr. Vell', recordId: 'mara' }
      ])
    ).toEqual({ ok: true, value: 'brown' })
  })

  it('has no pattern for slots code cannot read and proves no other voice or mode', () => {
    expect(hasLiteralPatterns('detail:income')).toBe(false)
    expect(prove('Mara was rich.', { slot: 'detail:income', value: 'rich' })).toEqual({
      ok: false,
      reason: 'slot'
    })
    expect(prove('Mara was dead.', { slot: 'alive', value: 'dead', mode: 'dream' })).toEqual({
      ok: false,
      reason: 'voiceMode'
    })
    expect(prove('Mara was dead.', { slot: 'alive', value: 'dead', voice: 'rumour' })).toEqual({
      ok: false,
      reason: 'voiceMode'
    })
  })

  it('keeps one slot from proving another', () => {
    expect(prove('Mara was at the Quay.', { slot: 'traits', value: 'at the Quay' })).toMatchObject({
      ok: false
    })
    expect(prove('Mara was twenty.', { slot: 'traits', value: 'twenty' })).toMatchObject({
      ok: false
    })
    expect(
      prove('Mara was the daughter of a miller.', { slot: 'traits', value: 'daughter of a miller' })
    ).toMatchObject({ ok: false })
    expect(prove('Mara died.', { slot: 'alive', value: 'alive' })).toEqual({
      ok: false,
      reason: 'value'
    })
  })
})

describe('literalProof: each blocker (F-16.17)', () => {
  it('needs exactly one character in the sentence, the subject, and no ambiguous name', () => {
    expect(
      prove('Mara and Tomas were at the Quay.', {
        slot: 'location',
        value: 'the Quay',
        quote: 'Tomas were at the Quay'
      })
    ).toEqual({ ok: false, reason: 'names' })
    expect(
      prove('Mara had green eyes.', { slot: 'eyes', value: 'green' }, [
        { ...MARA, ambiguous: true }
      ])
    ).toEqual({ ok: false, reason: 'names' })
    // A place is not a character: it may stand beside the subject.
    expect(prove('Mara was at the Quay.', { slot: 'location', value: 'the Quay' })).toMatchObject({
      ok: true
    })
    expect(prove('She had green eyes.', { slot: 'eyes', value: 'green' })).toEqual({
      ok: false,
      reason: 'subject'
    })
  })

  it('refuses a quote inside quotation marks', () => {
    expect(
      prove('"Mara had green eyes," he said.', {
        slot: 'eyes',
        value: 'green',
        quote: 'Mara had green eyes'
      })
    ).toEqual({ ok: false, reason: 'quoted' })
    expect(
      prove("He said, 'Mara had green eyes.'", {
        slot: 'eyes',
        value: 'green',
        quote: 'Mara had green eyes'
      })
    ).toEqual({ ok: false, reason: 'quoted' })
  })

  it.each<[string, string]>([
    ['negation', "Mara's eyes were not grey."],
    ['negation', "It wasn't true that Mara's eyes were grey."],
    ['modal', "Perhaps Mara's eyes were grey."],
    ['conditional', "If the light held, Mara's eyes were grey."],
    ['comparative', "Mara's eyes were grey, greyer than slate."],
    ['comparative', "Mara's eyes were as grey as slate."],
    ['simile', "Mara's eyes were like grey slate."],
    ['simile', "Mara's eyes were grey, as if washed."],
    ['pluperfect', "Mara's eyes were grey where the fever had faded them."],
    ['reported', "Tomel said Mara's eyes were grey."]
  ])('stops at a %s marker: "%s"', (kind, sentence) => {
    const quote = sentence.slice(sentence.indexOf('Mara')).replace(/[,.].*$/, '')
    const result = prove(sentence, { slot: 'eyes', value: 'grey', quote })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok && result.reason === 'marker') expect(result.marker).toBe(kind)
    else expect(result.ok ? 'proved' : result.reason).toBe('marker')
  })

  it('ignores the markers of a later clause unless they reach back over the sentence', () => {
    expect(
      prove('Mara was eighteen now, and nobody had asked her to dance.', {
        slot: 'age',
        value: 'eighteen',
        quote: 'Mara was eighteen now'
      })
    ).toEqual({ ok: true, value: 'eighteen' })
    expect(
      prove('Mara was dead, if the letter was true.', {
        slot: 'alive',
        value: 'dead',
        quote: 'Mara was dead'
      })
    ).toEqual({ ok: false, reason: 'marker', marker: 'conditional' })
    expect(
      prove('Mara was dead, or so they said.', {
        slot: 'alive',
        value: 'dead',
        quote: 'Mara was dead'
      })
    ).toMatchObject({ ok: false, reason: 'marker' })
  })

  it('does not read the pattern’s own "had" as a pluperfect, nor a name as a marker word', () => {
    expect(prove('Mara had golden hair.', { slot: 'hair', value: 'golden' })).toEqual({
      ok: true,
      value: 'golden'
    })
    expect(
      prove('May had red hair.', { slot: 'hair', value: 'red' }, [
        { text: 'May', recordId: 'mara' }
      ])
    ).toEqual({ ok: true, value: 'red' })
  })

  it('needs the quote once in the sentence', () => {
    expect(
      prove('Mara had green eyes.', { slot: 'eyes', value: 'green', quote: 'Mara had blue eyes' })
    ).toEqual({
      ok: false,
      reason: 'quote'
    })
  })
})

describe('sentenceNames', () => {
  it('moves the scan’s mentions to offsets in one sentence and leaves the others out', () => {
    const text = 'Tomas waited. Mara had green eyes.'
    const [paragraph] = passageParagraphs({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
    })
    if (paragraph === undefined) throw new Error('no paragraph')
    const mention = (recordId: string, word: string): NameMention => {
      const at = text.indexOf(word)
      return {
        recordId,
        para: 0,
        from: paragraph.from + at,
        to: paragraph.from + at + word.length,
        text: word,
        ambiguous: false,
        spanKey: `0:${at}`
      }
    }
    const [, second] = splitSentences(text)
    if (second === undefined) throw new Error('no sentence')
    const names = sentenceNames(
      paragraph,
      second,
      [mention('tomas', 'Tomas'), mention('mara', 'Mara'), mention('gone', 'green')],
      (id) => (id === 'gone' ? undefined : 'character')
    )
    expect(names).toEqual([
      { recordId: 'mara', kind: 'character', start: 0, end: 4, ambiguous: false }
    ])
    expect(second.text.slice(0, 4)).toBe('Mara')
  })
})
