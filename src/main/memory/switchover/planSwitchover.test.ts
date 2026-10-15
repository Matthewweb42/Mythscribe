import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { PLANNED_COST_NOTES, READING_V3_ROWS, SHIPPED_PLAN_ROWS } from '@shared/aiCostNotes'
import type { SwitchoverPlan } from '@shared/memory/switchover'
import { sweepCalls } from '../findings/findingsService'
import { rebuildEstimate } from '../reading/backlog'
import { createEntity, updateEntity } from '../../entity/entityStore'
import { createProject } from '../../project/projectStore'
import { getStoryMemory } from '../../project/settingsStore'
import { updateTag } from '../../tag/tagStore'
import { convertSwitchover, prepareSwitchover } from './convert'
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
      '4 scenes: 3 POVs and 2 places as records, 3 story years, 1 “also here”.'
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
    ).toEqual(['Mara Vell ← Vell (subset)'])
    // Each side carries its category, so two records of one name can be told apart; the two
    // Harrows, a character and a place, are never offered (SW-D15).
    expect(plan.merges.map((pair) => `${pair.keepCategory}/${pair.mergeCategory}`)).toEqual([
      'character/character'
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
      // Scene 4 returns to the flood after the trial: v1's reading order showed it as set earlier,
      // a computed flag, so its Flashback switch follows the book and the note names it.
      "v1’s Timeline showed 4.1 'Scene 1' as set earlier than a scene before it. The Flashback switch is left to follow the book: turn it on in a scene’s details where it is a flashback, so its story year does not carry into the scenes after it.",
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
    // F-16.17, F-16.22: the reader and verify rows shipped (v2 since P2b, v3 since the live run
    // of 2026-10-14, v4 since its second run, reader.v5 and verify.v4 since its third, reader.v6
    // since plan ReaderNarrow.md, kept for concrete-only suggestions by plan Suggestions.md on
    // 2026-10-15); the rebuild prices from the v6 sizes, a page checked in one
    // fast batch (the strong batch of the open-ended slots is retired with them).
    const shipped = (id: string) => READING_V3_ROWS.find((note) => note.id === id)
    expect(PLANNED_COST_NOTES.some((note) => note.id.startsWith('reader.'))).toBe(false)
    expect(SHIPPED_PLAN_ROWS.some((note) => note.id === 'reader.v2:first')).toBe(true)
    const reader = shipped('reader.v6:first')
    const verify = shipped('verify.v4')
    if (reader === undefined || verify === undefined) throw new Error('shipped rows are missing')
    expect(plannedRow('reader.v6:first')).toBe(reader)
    expect(verify.tier).toBe('fast')
    expect(REBUILD_PAGE_TOKENS).toBe(400)
    expect(() => plannedRow('nothing.v1')).toThrow('No planned cost row nothing.v1')
    const one = estimateRebuild([REBUILD_PAGE_TOKENS], { ...CONTEXT, source: 'local' })
    expect(one.costUsd).toBe(0)
    expect(one.requests).toBe(2 + REBUILD_FAST_CHECKS + REBUILD_STRONG_CHECKS)
    const two = estimateRebuild([REBUILD_PAGE_TOKENS + 1], { ...CONTEXT, source: 'local' })
    expect(two.tokensOut - one.tokensOut).toBe(reader.typicalOutTokens + verify.typicalOutTokens)
    // Cents per book (plans ReaderPrecision.md, ReaderNarrow.md): 90 scenes of 800 prose tokens on the defaults.
    const book = estimateRebuild(
      Array.from({ length: 90 }, () => 800),
      CONTEXT
    )
    expect(book.costUsd).toBeLessThan(0.5)
    expect(estimateRebuild([], CONTEXT)).toMatchObject({
      scenes: 0,
      requests: 0,
      costUsd: 0,
      minutes: 0
    })
  })
})

describe('the merge list leaves out a family and a pair of two kinds (F-16.31, SW-D15)', () => {
  it('offers only the twins: no shared nickname, no character with a place, no two people of one surname', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-plan-merges-'))
    const session = createProject(path.join(dir, 'Merges.mythscribe'), 'Merges', 'novel', {
      storyMemoryOverride: 'v1'
    })
    try {
      const db = session.connection.orm
      const sheet = (
        name: string,
        kind: 'character' | 'setting' = 'character',
        aliases: string[] = [],
        tag = true
      ): void => {
        const made = createEntity(
          db,
          { kind, name, template: 'blank' },
          'author',
          tag ? {} : { tag: false }
        ).entity
        if (aliases.length === 0) return
        if (made.tagId === null) updateEntity(db, made.id, { aliases })
        else updateTag(db, made.tagId, { aliases })
      }
      // A family: titles of their own, given names of their own, one surname.
      sheet('Mr. Lowther')
      sheet('Mrs. Lowther')
      sheet('Johanna Harrow', 'character', ['Miss Harrow'])
      sheet('Mr. Harrow')
      // A nickname two people share (marked shared on each): never the reason for a merge.
      sheet('Wren', 'character', ['Bird'])
      sheet('Lark', 'character', ['Bird'], false)
      // A character and a place the prefix rule would pair.
      sheet('Bel Harrow')
      sheet('The Bell', 'setting')
      // The twins: a surname alone beside the full name, a misspelling, one name spelled twice.
      sheet('Callum Varrow', 'character', ['Mr. Varrow'])
      sheet('Varrow')
      sheet('Liesel Fenwick')
      sheet('Liesl')
      sheet('Mrs. Tull')
      sheet('Mrs Tull', 'character', [], false)
      const merges = planSwitchover(db, CONTEXT).merges.map(
        (pair) => `${pair.keepName} ← ${pair.mergeName} (${pair.rule})`
      )
      expect(merges).toEqual([
        'Callum Varrow ← Varrow (subset)',
        'Liesl ← Liesel Fenwick (edit)',
        'Mrs. Tull ← Mrs Tull (alias)'
      ])
    } finally {
      session.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
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

describe('the dry run prices the rebuild it asks for (F-16.31, decision SW-D10)', () => {
  it('equals *Rebuild memory*’s estimate on the converted book, with and without the sweep', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-plan-price-'))
    const own = await buildFixtureV1(path.join(dir, 'Harbour Book.mythscribe'))
    try {
      const db = own.session.connection.orm
      const withSweep = planSwitchover(db, CONTEXT, sweepCalls).rebuild
      const without = planSwitchover(db, CONTEXT).rebuild
      expect(withSweep.requests - without.requests).toBe(sweepCalls(without.scenes))
      expect(withSweep.costUsd).toBeGreaterThan(without.costUsd)
      const replacements = inlineTagReplacements(db).map((row) => ({
        key: row.key,
        text: row.replacement
      }))
      const prepared = await prepareSwitchover(db, own.session.folder)
      convertSwitchover(db, 'novel', prepared, { replacements, merges: [] }, new Date(), {
        record: { trial: false, source: null, backup: null, datedCopy: null }
      })
      expect(getStoryMemory(db).version).toBe('v2')
      expect(rebuildEstimate(db, CONTEXT, sweepCalls)).toEqual(withSweep)
      expect(rebuildEstimate(db, CONTEXT)).toEqual(without)
    } finally {
      own.session.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
