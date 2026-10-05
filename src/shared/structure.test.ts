import { describe, expect, it } from 'vitest'
import {
  ProjectStructure,
  STRUCTURE_BEAT_ID_MAX,
  STRUCTURE_TEMPLATES,
  STRUCTURE_TEMPLATE_IDS,
  defaultProjectStructure,
  groupByBeat,
  isTemplateBeat,
  templateBeats
} from './structure'

describe('STRUCTURE_TEMPLATES', () => {
  it('has the beat counts each template is known by', () => {
    expect(templateBeats('threeAct')).toHaveLength(8)
    expect(templateBeats('saveTheCat')).toHaveLength(15)
    expect(templateBeats('herosJourney')).toHaveLength(12)
    expect(STRUCTURE_TEMPLATES.saveTheCat.acts.map((act) => act.name)).toEqual([
      'Act 1',
      'Act 2',
      'Act 3'
    ])
    expect(STRUCTURE_TEMPLATES.herosJourney.acts.map((act) => act.name)).toEqual([
      'Departure',
      'Initiation',
      'Return'
    ])
  })

  it.each(STRUCTURE_TEMPLATE_IDS)(
    '%s has unique kebab-case ids within the cap, a name, and a one-line hint per beat',
    (id) => {
      const beats = templateBeats(id)
      expect(new Set(beats.map((b) => b.id)).size).toBe(beats.length)
      for (const b of beats) {
        expect(b.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
        expect(b.id.length).toBeLessThanOrEqual(STRUCTURE_BEAT_ID_MAX)
        expect(b.name.trim()).not.toBe('')
        expect(b.hint).toMatch(/^\S.*\.$/)
        expect(b.hint).not.toContain('\n')
      }
      for (const act of STRUCTURE_TEMPLATES[id].acts) expect(act.beats.length).toBeGreaterThan(0)
    }
  )
})

describe('isTemplateBeat', () => {
  it('knows the beats of a template and no others', () => {
    expect(isTemplateBeat('saveTheCat', 'catalyst')).toBe(true)
    expect(isTemplateBeat('threeAct', 'catalyst')).toBe(false)
    expect(isTemplateBeat('threeAct', 'midpoint')).toBe(true)
    expect(isTemplateBeat('herosJourney', '')).toBe(false)
  })
})

describe('ProjectStructure', () => {
  it('defaults to no template and refuses an unknown one', () => {
    expect(defaultProjectStructure()).toEqual({ template: null })
    expect(ProjectStructure.parse({ template: 'herosJourney' })).toEqual({
      template: 'herosJourney'
    })
    expect(ProjectStructure.safeParse({ template: 'fiveAct' }).success).toBe(false)
    expect(ProjectStructure.safeParse({}).success).toBe(false)
  })
})

describe('groupByBeat', () => {
  it('lays nodes on their beats in reading order, counts filled beats, and ignores unknown or missing beats', () => {
    const board = groupByBeat('threeAct', [
      { id: 'sc-1', beat: 'setup' },
      { id: 'sc-2', beat: undefined },
      { id: 'sc-3', beat: 'midpoint' },
      { id: 'sc-4', beat: 'setup' },
      { id: 'sc-5', beat: 'catalyst' }
    ])
    expect(board.total).toBe(8)
    expect(board.filled).toBe(2)
    expect(board.acts.map((act) => act.name)).toEqual(['Act 1', 'Act 2', 'Act 3'])
    const act1 = board.acts[0]
    expect(act1?.beats.map((g) => [g.beat.id, g.nodeIds])).toEqual([
      ['setup', ['sc-1', 'sc-4']],
      ['inciting-incident', []],
      ['plot-point-1', []]
    ])
    expect(board.acts[1]?.beats.find((g) => g.beat.id === 'midpoint')?.nodeIds).toEqual(['sc-3'])
    const placed = board.acts.flatMap((act) => act.beats.flatMap((g) => g.nodeIds))
    expect(placed).not.toContain('sc-5')
    expect(placed).not.toContain('sc-2')
  })

  it('reports every beat empty for no rows', () => {
    const board = groupByBeat('saveTheCat', [])
    expect(board).toMatchObject({ filled: 0, total: 15 })
    expect(board.acts.every((act) => act.beats.every((g) => g.nodeIds.length === 0))).toBe(true)
  })
})
