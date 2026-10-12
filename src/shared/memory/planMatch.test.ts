import { describe, expect, it } from 'vitest'
import {
  PLAN_MATCH_MIN,
  PLAN_MATCH_RATIO,
  matchPlan,
  planScore,
  planWords,
  qualifies,
  type PlanSide,
  type SceneSide
} from './planMatch'

/** A plan; `records` maps each record id to the name the plan writes for it. */
const plan = (title: string, synopsis = '', records: Record<string, string> = {}): PlanSide => ({
  id: 'p1',
  title,
  synopsis,
  records: Object.keys(records),
  names: Object.values(records)
})
const scene = (
  id: string,
  line: string,
  extra: Partial<Omit<SceneSide, 'id' | 'line'>> = {}
): SceneSide => ({ id, title: '', line, gist: '', records: [], ...extra })

describe('planWords (F-16.21)', () => {
  it('keeps the search terms with plain plurals folded', () => {
    expect([...planWords('Mara walks to the docks; the stories end.')]).toEqual([
      'mara',
      'walk',
      'dock',
      'story',
      'end'
    ])
  })
})

describe('planScore', () => {
  it('is the share of the plan’s terms the scene holds, a named record one term', () => {
    const quay = plan('Mara at the quay', '', { 'r-mara': 'Mara' })
    const held = planScore(quay, scene('s1', 'Mara walks to the quay.', { records: ['r-mara'] }))
    // The terms are quay and the Mara record: the name is not counted again as a word.
    expect(held).toEqual({ sceneId: 's1', score: 1, shared: 2, words: 1 })
    const half = planScore(quay, scene('s2', 'Tomas waits at the quay.'))
    expect(half).toEqual({ sceneId: 's2', score: 0.5, shared: 1, words: 1 })
  })

  it('counts a name that resolved to no record as a word', () => {
    const score = planScore(plan('Mara at the quay'), scene('s1', 'Mara walks to the quay.'))
    expect(score).toEqual({ sceneId: 's1', score: 1, shared: 2, words: 2 })
  })

  it('reads the scene’s title and gist too', () => {
    const score = planScore(
      plan('The lighthouse fire', 'Tomas lights the lamp.'),
      scene('s1', 'A long night.', { title: 'Lighthouse', gist: 'Tomas keeps the lamp lit.' })
    )
    // Shared: lighthouse (the title), tomas and lamp (the gist).
    expect(score.shared).toBe(3)
  })
})

describe('matchPlan', () => {
  const quay = plan('Mara at the quay', 'She waits for the ferry at dusk.', { 'r-mara': 'Mara' })

  it('links an unambiguous best scene', () => {
    const match = matchPlan(quay, [
      scene('s1', 'Tomas mends a net.'),
      scene('s2', 'Mara waits at the quay for the ferry.', { records: ['r-mara'] })
    ])
    expect(match).toMatchObject({ kind: 'link', sceneId: 's2' })
  })

  it('calls two close scenes ambiguous, best first and ties in reading order', () => {
    const match = matchPlan(quay, [
      scene('s1', 'Mara walks to the quay.', { records: ['r-mara'] }),
      scene('s2', 'Mara walks to the quay.', { records: ['r-mara'] })
    ])
    expect(match.kind).toBe('ambiguous')
    if (match.kind !== 'ambiguous') return
    expect(match.top.map((each) => each.sceneId)).toEqual(['s1', 's2'])
  })

  it('needs the floor, two shared terms and the ratio', () => {
    // One shared word is a coincidence.
    expect(matchPlan(quay, [scene('s1', 'The ferry is late.')])).toEqual({ kind: 'none' })
    // Under the floor.
    const weak = matchPlan(plan('Mara walks the north road at dawn alone'), [
      scene('s1', 'Mara and the road.')
    ])
    expect(weak).toEqual({ kind: 'none' })
    expect(PLAN_MATCH_MIN).toBe(0.35)
    expect(PLAN_MATCH_RATIO).toBe(1.5)
  })

  it('never matches a plan of fewer than two terms, nor an empty board', () => {
    expect(matchPlan(plan('Two'), [scene('s1', 'Two of them.')])).toEqual({ kind: 'none' })
    // A plan that is only a name is one term.
    expect(
      matchPlan(plan('Mara', '', { 'r-mara': 'Mara' }), [
        scene('s1', 'Mara waits.', { records: ['r-mara'] })
      ])
    ).toEqual({ kind: 'none' })
    expect(matchPlan(quay, [])).toEqual({ kind: 'none' })
  })

  it('never links on a shared name alone', () => {
    const mara = { 'r-mara': 'Mara' }
    const scenes = [
      scene('s1', 'Mara waits at the quay for the ferry.', { records: ['r-mara', 'r-orrin'] }),
      scene('s2', 'Orrin sells fish at the market.', { records: ['r-orrin'] })
    ]
    expect(matchPlan(plan('Mara learns about the map', '', mara), scenes)).toEqual({
      kind: 'none'
    })
    expect(
      matchPlan(plan('Mara at the quay', '', mara), [
        scene('s1', 'Mara mends a net.', { records: ['r-mara'] }),
        scene('s2', 'Tomas sleeps.')
      ])
    ).toEqual({ kind: 'none' })
    expect(
      matchPlan(plan('Mara’s lament', '', mara), [
        scene('s1', 'Mara walks to the quay.', { records: ['r-mara'] })
      ])
    ).toEqual({ kind: 'none' })
    // Two shared records and no shared word: still not the plan.
    const both = plan('Mara and Tomas at the quay', '', { 'r-mara': 'Mara', 'r-tomas': 'Tomas' })
    const score = planScore(both, scene('s1', 'They argue.', { records: ['r-mara', 'r-tomas'] }))
    expect(score).toMatchObject({ shared: 2, words: 0 })
    expect(qualifies(score)).toBe(false)
  })

  it('ranks a blocked scene but never links it, nor hands the plan to the runner-up', () => {
    const scenes = [
      scene('s1', 'Mara walks to the quay.', { records: ['r-mara'] }),
      scene('dusk', 'Mara waits at the quay for the ferry at dusk.', { records: ['r-mara'] })
    ]
    expect(matchPlan(quay, scenes)).toMatchObject({ kind: 'link', sceneId: 'dusk' })
    // The best one unlinked: the weaker s1 is not linked in its place.
    expect(matchPlan(quay, scenes, new Set(['dusk']))).toEqual({ kind: 'none' })
    // One of an ambiguous best two unlinked: nothing is linked, and the AI is not asked.
    const close = [
      scene('s1', 'Mara walks to the quay.', { records: ['r-mara'] }),
      scene('s2', 'Mara walks to the quay.', { records: ['r-mara'] })
    ]
    expect(matchPlan(quay, close, new Set(['s2']))).toEqual({ kind: 'none' })
    // A far weaker blocked scene does not stop a clear best.
    expect(
      matchPlan(quay, [scenes[1]!, scene('s3', 'Tomas mends a net at the quay.')], new Set(['s3']))
    ).toMatchObject({ kind: 'link', sceneId: 'dusk' })
  })
})
