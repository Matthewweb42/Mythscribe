import { describe, expect, it } from 'vitest'
import { MEMORY_SOURCES, meaningOf } from './memory/sources'
import {
  citableLabel,
  EVIDENCE_LABELS,
  EVIDENCE_LABEL_WORDS,
  EvidenceKey,
  evidenceTag,
  labelOf,
  Navigation,
  NAVIGATION_EVIDENCE_MAX,
  SCRIBE_REASONING,
  SCRIBE_TURNS,
  scribeMaxTokens,
  sameEvidence
} from './scribe'

describe('turn kinds (P3-D11)', () => {
  it('turns reasoning off for answers and lookups, low for edits, with the cap raised to match', () => {
    expect(SCRIBE_TURNS.filter((turn) => SCRIBE_REASONING[turn] === 'off')).toEqual([
      'answer',
      'lookup',
      'idea',
      'todo'
    ])
    expect(SCRIBE_TURNS.filter((turn) => SCRIBE_REASONING[turn] === 'low')).toEqual([
      'edit',
      'draft',
      'whatIf'
    ])
    expect(SCRIBE_TURNS.map((turn) => [turn, scribeMaxTokens(turn)])).toEqual([
      ['answer', 700],
      ['lookup', 300],
      ['idea', 700],
      ['todo', 700],
      ['edit', 2_500],
      ['draft', 2_500],
      ['whatIf', 2_000]
    ])
    expect(scribeMaxTokens('answer', 'low')).toBe(1_700)
    expect(scribeMaxTokens('edit', 'off')).toBe(1_500)
    // Never past the agent's 3,000-token cap.
    for (const turn of SCRIBE_TURNS) expect(scribeMaxTokens(turn, 'low')).toBeLessThanOrEqual(3_000)
  })
})

describe('evidence labels (design §2.2, §2.6)', () => {
  it('labels every source by its meaning: the manuscript by place, Pinned filed or not, cards a map', () => {
    const at = (order: number): { order: number; openOrder: number } => ({ order, openOrder: 5 })
    expect(labelOf('scene', meaningOf('scene', at(3)))).toBe('happened')
    expect(labelOf('scene', meaningOf('scene', at(5)))).toBe('happened')
    expect(labelOf('scene', meaningOf('scene', at(6)))).toBe('later')
    expect(labelOf('pinned', 'canon')).toBe('notes')
    expect(labelOf('pinned', 'canon', { filed: true })).toBe('filed')
    expect(labelOf('note', 'canon')).toBe('notes')
    expect(labelOf('research', 'canon')).toBe('research')
    expect(labelOf('sceneNote', 'plan')).toBe('planned')
    expect(labelOf('synopsis', 'plan')).toBe('planned')
    expect(labelOf('idea', 'never')).toBe('idea')
    expect(labelOf('ideaScene', 'never')).toBe('ideaScene')
    expect(labelOf('excludedScene', 'never')).toBe('cutScene')
    expect(labelOf('notCanon', 'never')).toBe('notCanon')
    expect(labelOf('card', 'map')).toBe('map')
    for (const source of MEMORY_SOURCES) {
      expect(EVIDENCE_LABELS).toContain(labelOf(source, meaningOf(source, at(1))))
    }
  })

  it('words each label and cites everything but a map (P3-D9)', () => {
    expect(EVIDENCE_LABELS.filter((label) => !citableLabel(label))).toEqual(['map'])
    expect(evidenceTag('happened', '9.3 ¶4')).toBe('happened, 9.3 ¶4')
    expect(evidenceTag('filed', 'Mara’s Pinned ¶3', 'Harbour notes')).toBe(
      'filed from Harbour notes, Mara’s Pinned ¶3'
    )
    expect(evidenceTag('map', '7.4')).toBe('map, not citable, 7.4')
    expect(evidenceTag('idea', '')).toBe('your idea')
    expect(EVIDENCE_LABEL_WORDS.computed).toBe('computed from your book')
  })
})

describe('evidence keys and the navigation (P3-D1)', () => {
  it('parses every key kind and refuses an oversized navigation', () => {
    const keys = [
      { kind: 'scene', nodeId: 'n1', from: 0, to: 3 },
      { kind: 'passage', source: 'pinned', ownerId: 'mara', para: 1 },
      { kind: 'claim', claimId: 'c1' },
      { kind: 'card', nodeId: 'n1' },
      { kind: 'knows', secretId: 's1' },
      { kind: 'timeline', recordId: null },
      { kind: 'ideas', recordId: 'mara' },
      { kind: 'outline' },
      { kind: 'todos' }
    ]
    for (const key of keys) expect(EvidenceKey.parse(key)).toEqual(key)
    expect(
      EvidenceKey.safeParse({ kind: 'passage', source: 'chat', ownerId: 'x', para: 0 }).success
    ).toBe(false)
    expect(sameEvidence(EvidenceKey.parse(keys[2]), { kind: 'claim', claimId: 'c1' })).toBe(true)
    const navigation = { turn: 'answer', evidence: keys, scope: null, terms: ['map'], hits: [] }
    expect(Navigation.parse(navigation).evidence).toHaveLength(keys.length)
    expect(
      Navigation.safeParse({
        ...navigation,
        evidence: Array.from({ length: NAVIGATION_EVIDENCE_MAX + 1 }, () => keys[2])
      }).success
    ).toBe(false)
  })
})
