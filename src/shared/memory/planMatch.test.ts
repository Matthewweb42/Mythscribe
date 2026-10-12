import { describe, expect, it } from 'vitest'
import {
  PLAN_MATCH_MIN,
  PLAN_MATCH_RATIO,
  matchPlan,
  planScore,
  planWords,
  type PlanSide,
  type SceneSide
} from './planMatch'

const plan = (title: string, synopsis = '', records: string[] = []): PlanSide => ({
  id: 'p1',
  title,
  synopsis,
  records
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
  it('is the share of the plan’s terms the scene holds, records counted as terms', () => {
    const quay = plan('Mara at the quay', '', ['r-mara'])
    const held = planScore(quay, scene('s1', 'Mara walks to the quay.', { records: ['r-mara'] }))
    expect(held).toEqual({ sceneId: 's1', score: 1, shared: 3 })
    const half = planScore(quay, scene('s2', 'Tomas waits at the quay.'))
    expect(half.shared).toBe(1)
    expect(half.score).toBeCloseTo(1 / 3)
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
  const quay = plan('Mara at the quay', 'She waits for the ferry at dusk.', ['r-mara'])

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
    expect(matchPlan(quay, [])).toEqual({ kind: 'none' })
  })
})
