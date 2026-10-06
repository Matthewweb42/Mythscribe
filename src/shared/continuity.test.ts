import { describe, expect, it } from 'vitest'
import { AI_FEATURE_IDS, inputBudget, outputBudget } from './ai'
import { AI_DATA_SHARING, defaultAiSettings, isFeatureAllowed } from './aiSettings'
import {
  CONTINUITY_FIX_MAX,
  CONTINUITY_QUOTE_MAX,
  CONTINUITY_WHY_MAX,
  ContinuityFinding,
  continuityDedupeKey,
  type ContinuityRef
} from './continuity'

const sheet: ContinuityRef = {
  kind: 'sheet',
  entityId: 'mara',
  entityName: 'Mara',
  entityKind: 'character',
  attribute: 'age',
  label: 'Age',
  value: '34',
  nodeId: null,
  quote: null
}

const finding: ContinuityFinding = {
  id: 'f1',
  nodeId: 'scene',
  ref: sheet,
  quote: 'Mara was twenty-nine that winter.',
  why: 'The sheet gives her age as 34.',
  fix: 'Mara was thirty-four that winter.',
  flagged: false,
  violation: null,
  status: 'open',
  origin: 'request',
  proposalId: 'p1',
  createdAt: '2026-10-02T10:00:00.000Z'
}

describe('continuityDedupeKey (F-13.4)', () => {
  it('folds case and spacing in the value, so a re-worded sheet line of the same value is the same dismissal', () => {
    const key = continuityDedupeKey('scene', { ...sheet, value: 'Grey  Eyes' })
    expect(continuityDedupeKey('scene', { ...sheet, value: ' grey eyes ' })).toBe(key)
  })

  it('tells apart the scene, the kind, the entity, the attribute, and the value', () => {
    const key = continuityDedupeKey('scene', sheet)
    expect(continuityDedupeKey('other', sheet)).not.toBe(key)
    expect(continuityDedupeKey('scene', { ...sheet, kind: 'fact' })).not.toBe(key)
    expect(continuityDedupeKey('scene', { ...sheet, entityId: 'tomas' })).not.toBe(key)
    expect(continuityDedupeKey('scene', { ...sheet, attribute: 'gender' })).not.toBe(key)
    expect(continuityDedupeKey('scene', { ...sheet, value: '35' })).not.toBe(key)
  })

  it('keys a timeline reference without an entity or an attribute', () => {
    const timeline: ContinuityRef = {
      kind: 'timeline',
      entityId: null,
      entityName: null,
      entityKind: null,
      attribute: null,
      label: 'Timeline',
      value: 'Day 3, dusk',
      nodeId: 'previous',
      quote: null
    }
    expect(continuityDedupeKey('scene', timeline)).toBe(
      ['scene', 'timeline', '', '', 'day 3, dusk'].join('\u001f')
    )
  })
})

describe('ContinuityFinding (F-13.4)', () => {
  it('accepts a finding with both citations, and one without a fix', () => {
    expect(ContinuityFinding.safeParse(finding).success).toBe(true)
    expect(ContinuityFinding.safeParse({ ...finding, fix: null, proposalId: null }).success).toBe(
      true
    )
  })

  it('refuses a blank quote or reason and strings past their caps', () => {
    for (const bad of [
      { quote: '' },
      { why: '' },
      { fix: '' },
      { quote: 'q'.repeat(CONTINUITY_QUOTE_MAX + 1) },
      { why: 'w'.repeat(CONTINUITY_WHY_MAX + 1) },
      { fix: 'f'.repeat(CONTINUITY_FIX_MAX + 1) },
      { status: 'closed' },
      { origin: 'chat' }
    ]) {
      expect(ContinuityFinding.safeParse({ ...finding, ...bad }).success).toBe(false)
    }
  })
})

describe('the continuity feature registry lines (F-13.4)', () => {
  it('is a feature of its own with its budgets, gated at Ask, on by default once the dial allows it', () => {
    expect(AI_FEATURE_IDS).toContain('continuity')
    expect(outputBudget('continuity')).toBe(800)
    expect(inputBudget('continuity')).toBe(6_000)
    expect(AI_DATA_SHARING.continuity.label).toBe('Consistency check')
    expect(AI_DATA_SHARING.continuity.minDial).toBe(1)
    expect(isFeatureAllowed(defaultAiSettings(), 'continuity')).toBe(false)
    expect(isFeatureAllowed({ ...defaultAiSettings(), dial: 1 }, 'continuity')).toBe(true)
  })

  it('tells the author what is sent, the voice profile and the brief included', () => {
    const sends = AI_DATA_SHARING.continuity.sends
    expect(sends).toContain('The sheets of the story-bible entries named in a scene')
    expect(sends).toContain('in other scenes with the passages')
    expect(sends).toContain("the previous scene's timeline and this scene's")
    expect(sends).toContain("the scene's brief")
    expect(sends).toContain('only the paragraphs that state something different')
    expect(sends).toContain(
      'the voice profile (stylometric rules, learned style notes, and up to 3 exemplar passages)'
    )
  })
})
