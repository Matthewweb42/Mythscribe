import { describe, expect, it } from 'vitest'
import {
  SceneSummary,
  SceneSummaryState,
  StoredSceneSummary,
  SUMMARY_CHARACTER_MAX,
  SUMMARY_CHARACTERS_MAX,
  SUMMARY_DEBOUNCE_MS,
  SUMMARY_KEY_POINT_MAX,
  SUMMARY_KEY_POINTS_MAX,
  SUMMARY_MAX_CHARS,
  SUMMARY_SCENE_CHAR_BUDGET,
  SUMMARY_TEXT_MIN,
  SummaryStatus,
  UNAVAILABLE_SUMMARY
} from './summary'

const summary: SceneSummary = {
  summary: 'Mara meets Tomas at the ferry landing and tells him where her brother is buried.',
  keyPoints: ['Tomas demands the copied ledger', 'Mara names the north pasture'],
  characters: ['Mara', 'Tomas']
}

const stored: StoredSceneSummary = {
  ...summary,
  nodeId: 'scene-1',
  contentHash: 'abc123',
  promptVersion: 'summary.v1',
  model: 'gpt-fast',
  truncated: false,
  createdAt: '2026-09-15T00:00:00.000Z'
}

describe('the summary limits (F-5.6)', () => {
  it('keeps the gate below the scene budget and the summary at about 100 tokens', () => {
    expect(SUMMARY_TEXT_MIN).toBeLessThan(SUMMARY_SCENE_CHAR_BUDGET)
    expect(SUMMARY_MAX_CHARS).toBe(600)
    expect(SUMMARY_KEY_POINTS_MAX).toBe(4)
    expect(SUMMARY_CHARACTERS_MAX).toBe(8)
  })

  it('debounces in whole seconds, long enough to outlast a typing burst', () => {
    expect(SUMMARY_DEBOUNCE_MS).toBe(3_000)
  })
})

describe('SceneSummary (F-5.6)', () => {
  it('accepts the shape the prompt asks for, including empty lists', () => {
    expect(SceneSummary.parse(summary)).toEqual(summary)
    expect(SceneSummary.parse({ ...summary, keyPoints: [], characters: [] }).keyPoints).toEqual([])
  })

  it('refuses an empty summary: a row with nothing to say is not stored', () => {
    expect(SceneSummary.safeParse({ ...summary, summary: '' }).success).toBe(false)
  })

  it('caps the summary, each key point, and each character name', () => {
    expect(
      SceneSummary.safeParse({ ...summary, summary: 's'.repeat(SUMMARY_MAX_CHARS) }).success
    ).toBe(true)
    expect(
      SceneSummary.safeParse({ ...summary, summary: 's'.repeat(SUMMARY_MAX_CHARS + 1) }).success
    ).toBe(false)
    expect(
      SceneSummary.safeParse({ ...summary, keyPoints: ['k'.repeat(SUMMARY_KEY_POINT_MAX + 1)] })
        .success
    ).toBe(false)
    expect(
      SceneSummary.safeParse({ ...summary, characters: ['c'.repeat(SUMMARY_CHARACTER_MAX + 1)] })
        .success
    ).toBe(false)
  })

  it('caps how many key points and characters a row may carry', () => {
    const points = Array.from({ length: SUMMARY_KEY_POINTS_MAX + 1 }, (_, i) => `point ${i}`)
    expect(SceneSummary.safeParse({ ...summary, keyPoints: points }).success).toBe(false)
    const names = Array.from({ length: SUMMARY_CHARACTERS_MAX + 1 }, (_, i) => `name ${i}`)
    expect(SceneSummary.safeParse({ ...summary, characters: names }).success).toBe(false)
  })
})

describe('StoredSceneSummary and SceneSummaryState (F-5.6)', () => {
  it('carries what the row was made from, so staleness is a hash comparison', () => {
    expect(StoredSceneSummary.parse(stored)).toEqual(stored)
    // A row without the hash it was made from could never be told apart from the scene's text.
    expect(StoredSceneSummary.safeParse({ ...summary, nodeId: 'scene-1' }).success).toBe(false)
  })

  it('parses a state with a row and one without', () => {
    const state: SceneSummaryState = {
      available: true,
      summary: stored,
      stale: true,
      status: 'pending',
      error: null
    }
    expect(SceneSummaryState.parse(state)).toEqual(state)
    expect(
      SceneSummaryState.parse({
        available: true,
        summary: null,
        stale: false,
        status: 'failed',
        error: { message: 'No API key is saved.', nextStep: 'Add a key in Settings.' }
      }).summary
    ).toBeNull()
  })

  it('knows three statuses and nothing else', () => {
    expect(SummaryStatus.options).toEqual(['idle', 'pending', 'failed'])
    expect(SummaryStatus.safeParse('running').success).toBe(false)
  })

  it('says nothing is available for a node that cannot have a summary', () => {
    expect(SceneSummaryState.parse(UNAVAILABLE_SUMMARY)).toEqual(UNAVAILABLE_SUMMARY)
    expect(UNAVAILABLE_SUMMARY.available).toBe(false)
    expect(UNAVAILABLE_SUMMARY.stale).toBe(false)
  })
})
