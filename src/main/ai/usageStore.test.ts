import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import {
  insertUsage,
  ledgerSummary,
  listUsage,
  recentUsage,
  type AiDb,
  type UsageEntry
} from './usageStore'

let tmp: string
let session: ProjectSession
let db: AiDb

const entry = (over: Partial<UsageEntry> = {}): UsageEntry => ({
  at: '2026-09-12T10:00:00.000Z',
  feature: 'tags',
  tier: 'fast',
  model: 'gpt-5.4-mini',
  provider: 'openai',
  promptTokens: 100,
  completionTokens: 20,
  cachedTokens: null,
  costUsd: 0.001,
  cached: false,
  promptVersion: null,
  contextHash: 'ctx',
  ...over
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-usage-'))
  session = createProject(projectFolderFor(tmp, 'Usage'), 'Usage', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('usageStore (F-5.14)', () => {
  it('starts empty', () => {
    expect(listUsage(db)).toEqual([])
    expect(ledgerSummary(db)).toEqual({
      total: { requests: 0, tokens: 0, costUsd: 0 },
      byFeature: []
    })
  })

  it('inserts a row with a minted id and reads it back', () => {
    const row = insertUsage(db, entry({ promptVersion: 'tags.v1', cachedTokens: 40 }))
    expect(typeof row.id).toBe('string')
    expect(listUsage(db)).toEqual([row])
    expect(row).toMatchObject({ cached: false, cachedTokens: 40, promptVersion: 'tags.v1' })
  })

  it('sums requests, tokens, and cost per feature and in total', () => {
    insertUsage(db, entry())
    insertUsage(db, entry({ at: '2026-09-12T11:00:00.000Z', costUsd: 0.002, promptTokens: 50 }))
    insertUsage(
      db,
      entry({ feature: 'ghostText', promptTokens: 10, completionTokens: 5, costUsd: 0.0001 })
    )
    insertUsage(
      db,
      entry({
        feature: 'ghostText',
        cached: true,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0
      })
    )
    const summary = ledgerSummary(db)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['ghostText', 'tags'])
    expect(summary.byFeature[0]).toMatchObject({ feature: 'ghostText', requests: 2, tokens: 15 })
    expect(summary.byFeature[0]?.costUsd).toBeCloseTo(0.0001, 8)
    expect(summary.byFeature[1]).toMatchObject({ feature: 'tags', requests: 2, tokens: 190 })
    expect(summary.byFeature[1]?.costUsd).toBeCloseTo(0.003, 8)
    expect(summary.total).toMatchObject({ requests: 4, tokens: 205 })
    expect(summary.total.costUsd).toBeCloseTo(0.0031, 8)
  })

  it('lists the most recent requests newest first, honouring the limit (F-5.9)', () => {
    expect(recentUsage(db, 10)).toEqual([])
    insertUsage(db, entry({ at: '2026-09-12T10:00:00.000Z', feature: 'tags' }))
    insertUsage(db, entry({ at: '2026-09-12T12:00:00.000Z', feature: 'chat' }))
    insertUsage(db, entry({ at: '2026-09-12T11:00:00.000Z', feature: 'ghostText' }))
    // Same instant as the newest: the later insertion wins the tie.
    const newest = insertUsage(db, entry({ at: '2026-09-12T12:00:00.000Z', feature: 'summary' }))

    expect(recentUsage(db, 10).map((r) => r.feature)).toEqual([
      'summary',
      'chat',
      'ghostText',
      'tags'
    ])
    expect(recentUsage(db, 2).map((r) => r.feature)).toEqual(['summary', 'chat'])
    expect(recentUsage(db, 1)).toEqual([
      {
        id: newest.id,
        at: '2026-09-12T12:00:00.000Z',
        feature: 'summary',
        model: 'gpt-5.4-mini',
        promptTokens: 100,
        completionTokens: 20,
        costUsd: 0.001,
        cached: false
      }
    ])
  })
})
