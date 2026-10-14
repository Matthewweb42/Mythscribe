import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { PLANNED_COST_NOTES, SHIPPED_PLAN_ROWS } from '@shared/aiCostNotes'
import type { SwitchoverPlan } from '@shared/memory/switchover'
import { getStoryMemory } from '../../project/settingsStore'
import { buildFixtureV1, type FixtureV1 } from './fixtureV1'
import {
  estimateRebuild,
  inlineTagReplacements,
  planSwitchover,
  REBUILD_FAST_CHECKS,
  REBUILD_PAGE_TOKENS,
  REBUILD_STRONG_CHECKS,
  plannedRow
} from './plan'

let tmp: string
let fixture: FixtureV1
let plan: SwitchoverPlan

const CONTEXT = {
  source: 'ownKey' as const,
  fastModel: 'deepseek/deepseek-v4-flash',
  strongModel: 'deepseek/deepseek-v4-pro',
  pricing: null
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-plan-'))
  fixture = await buildFixtureV1(path.join(tmp, 'Harbour Book.mythscribe'))
  plan = planSwitchover(fixture.session.connection.orm, CONTEXT)
  return () => {
    fixture.session.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

const names = (items: readonly { name: string }[]): string[] => items.map((item) => item.name)
const detailOf = (items: readonly { name: string; detail: string }[], name: string): string =>
  items.find((item) => item.name === name)?.detail ?? ''

describe('planSwitchover: the dry run (F-16.15, plan P1 §6.1 step 2)', () => {
  it('writes nothing', () => {
    const db = fixture.session.connection.orm
    const count = (table: string): number =>
      db.get<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM ${table}`))?.n ?? 0
    expect(
      ['record', 'alias', 'label', 'dismissed', 'scene_detail', 'research_doc'].map(count)
    ).toEqual([0, 0, 0, 0, 0, 0])
    expect(getStoryMemory(db).version).toBe('v1')
  })

  it('lists what is kept as it is', () => {
    expect(names(plan.kept)).toEqual([
      'The manuscript',
      'Scene notes',
      'Idea scenes',
      'Snapshots',
      'Other drafts'
    ])
    expect(detailOf(plan.kept, 'The manuscript')).toContain('5 inline tags become plain words')
  })

  it('lists, by name, the records, labels, Research, details and dismissals it converts', () => {
    expect(names(plan.converted)).toEqual([
      'Mara Vell',
      'Oren Hale',
      'Silver Coin',
      'Old Mill',
      'Missing ring',
      'Harrow',
      'Harrow',
      'Bell Tower',
      'Tomas',
      'Tomaz',
      'Vell',
      'Harbour',
      'Tide Guild',
      'The Burned Mill',
      'Ilse',
      'melancholy',
      'violence',
      'grief',
      'Project notes',
      'Timeline',
      'Harbour notes.docx',
      'Tide tables.pdf',
      'Portrait.png',
      'Scene details',
      'Dismissals'
    ])
    expect(detailOf(plan.converted, 'Mara Vell')).toBe(
      'Record (character): from its sheet and tag; also Mara; 6 Pinned lines; 1 line filed by AI, Not canon.'
    )
    expect(detailOf(plan.converted, 'Oren Hale')).toBe(
      'Record (character): from its sheet and tag; 1 Ideas line.'
    )
    expect(detailOf(plan.converted, 'Tomas')).toBe('Record (character): from its tag; also Tom.')
    expect(detailOf(plan.converted, 'Ilse')).toBe(
      'Record (character): the POV of a scene, with no sheet or tag.'
    )
    expect(detailOf(plan.converted, 'grief')).toBe('Custom label on 1 document.')
    expect(detailOf(plan.converted, 'Project notes')).toBe(
      'Research note, Not canon (it was Plan or Idea).'
    )
    expect(detailOf(plan.converted, 'Scene details')).toBe(
      // Oren only: with the default words, scene 1 names Tomas, so he is not "also here".
      // Scene 4 returns to the flood after the trial: v1's reading order shows it as a flashback.
      '4 scenes: 3 POVs and 2 places as records, 3 story years, 1 “also here”, 1 flashback.'
    )
    expect(detailOf(plan.converted, 'Dismissals')).toBe(
      '4 dismissals that still apply, into Dismissed.'
    )
  })

  it('lists what the AI made, which is dropped', () => {
    expect(plan.dropped).toEqual([
      { name: 'Sheets the AI made', detail: 'Whisper' },
      { name: 'Tags the AI made', detail: '#whisper, #whispering-reeds' },
      { name: 'Tags the AI put on scenes', detail: '2 links' },
      { name: 'Facts the AI read', detail: 'Mara Vell 1' },
      { name: 'Observed facts', detail: '1 fact; they stay in the old tables until P9.' },
      { name: 'The Changes log', detail: '4 rows; they stay in the old tables until P9.' },
      { name: 'Sheet sync state', detail: '1 sheet; they stay in the old tables until P9.' },
      {
        name: 'Sheet write-ups',
        detail: '1 page paragraph the AI wrote up from fields that convert anyway.'
      }
    ])
  })

  it('offers the twin-gate merges unticked, never a pair a kept spelling keeps apart', () => {
    expect(
      plan.merges.map((pair) => `${pair.keepName} ← ${pair.mergeName} (${pair.rule})`)
    ).toEqual(['Mara Vell ← Vell (subset)', 'Harrow ← Harrow (alias)'])
    // Each side carries its category, so two records of one name can be told apart.
    expect(plan.merges.map((pair) => `${pair.keepCategory}/${pair.mergeCategory}`)).toEqual([
      'character/character',
      'character/place'
    ])
    expect(
      plan.merges.some((pair) => pair.mergeName === 'Tomaz' || pair.keepName === 'Tomaz')
    ).toBe(false)
  })

  it('names the sheet text the AI wrote, and the notes on what cannot convert', () => {
    expect(plan.filedByAi).toEqual([
      { name: 'Mara Vell', lines: ['Personality: Stubborn'] },
      { name: 'Old Mill', lines: ['The wheel turns at night.'] },
      { name: 'Bell Tower', lines: ['Atmosphere: Cold and loud'] }
    ])
    expect(plan.notes).toEqual([
      'Ilse: a POV no sheet or tag names; a Character record is made for it.',
      'Tag nesting is dropped: #grief under #melancholy.',
      'Custom tags become custom labels, which only filter: in v1 they steered prose as themes. Change a label’s kind to Theme to keep that.',
      '“harrow” is a name of Harrow (character) and Harrow (place); it is marked shared on each.',
      '“tomas”: dismissed as a name, but it is a record now.',
      '“falseer”: a kept spelling, but not two records to keep apart.',
      'The Changes log keeps only its newest 5,000 rows, so sheet text the AI wrote before that counts as yours.'
    ])
    expect(plan.inlineTags).toBe(3)
  })

  it('prices the rebuild from the planned reader and verify rows over the book’s scenes', () => {
    // Scenes 1–3 have text; scene 4 is an Idea scene and is never read.
    expect(plan.rebuild.scenes).toBe(3)
    expect(plan.rebuild.minutes).toBe(1)
    expect(plan.rebuild.priced).toBe(true)
    expect(plan.rebuild.costUsd).toBeGreaterThan(0)
    // F-16.17, F-16.22: the reader and verify rows shipped (v2 since P2b); the rebuild prices
    // from their sizes.
    const shipped = (id: string) => SHIPPED_PLAN_ROWS.find((note) => note.id === id)
    expect(PLANNED_COST_NOTES.some((note) => note.id.startsWith('reader.'))).toBe(false)
    const reader = shipped('reader.v2:first')
    const verify = shipped('verify.v2')
    if (reader === undefined || verify === undefined) throw new Error('shipped rows are missing')
    expect(plannedRow('reader.v2:first')).toBe(reader)
    expect(() => plannedRow('nothing.v1')).toThrow('No planned cost row nothing.v1')
    const one = estimateRebuild([1_000], { ...CONTEXT, source: 'local' })
    expect(one.costUsd).toBe(0)
    expect(one.requests).toBe(2 + REBUILD_FAST_CHECKS + REBUILD_STRONG_CHECKS)
    const two = estimateRebuild([REBUILD_PAGE_TOKENS + 1], { ...CONTEXT, source: 'local' })
    expect(two.tokensOut - one.tokensOut).toBe(reader.typicalOutTokens + verify.typicalOutTokens)
    expect(estimateRebuild([], CONTEXT)).toMatchObject({
      scenes: 0,
      requests: 0,
      costUsd: 0,
      minutes: 0
    })
  })
})

describe('inlineTagReplacements: the consent rows (step 3)', () => {
  it('lists every inline tag with its count, a sample and its replacement', () => {
    expect(
      inlineTagReplacements(fixture.session.connection.orm).map(({ key: _key, ...row }) => row)
    ).toEqual([
      // A tag that becomes a record is replaced by the record's name, so the name scan finds it.
      {
        tag: '#tomas',
        count: 2,
        sample: 'Mara walked to the harbour with #tomas at dusk.',
        replacement: 'Tomas'
      },
      {
        tag: '#the-burned-mill',
        count: 2,
        sample: 'The #the-burned-mill smoked.',
        replacement: 'The Burned Mill'
      },
      // A sheet's tag is replaced by the sheet's name.
      { tag: '#mara-vell', count: 1, sample: 'Ask #mara-vell later.', replacement: 'Mara Vell' }
    ])
  })
})
