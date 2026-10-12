import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  REBUILD_FAST_CHECKS,
  REBUILD_STRONG_CHECKS,
  SPOT_STRONG_DUE,
  spotPicked
} from '@shared/memory/spot'
import { resetInflight } from '../../ai/inflight'
import { saveDocument } from '../../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import type { TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { createRecord } from '../recordStore'
import { seedClaims } from './claimFixture'
import { getClaim } from './claimStore'
import { fakeAi, requestKind, sentChecks, type FakeAi } from './readingFixture'
import { getSpotState, setSpotState } from './readerRows'
import { markRebuilt, pickStrongDue, runSpotChecks, spotCheckDue } from './spotChecks'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string
let mara: string

const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))
const PARAGRAPHS = 80

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

beforeEach(() => {
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-spot-'))
  session = createProject(projectFolderFor(tmp, 'Spot'), 'Spot', 'novel')
  db = session.connection.orm
  scene = manuscriptDocuments(db)[0]?.id ?? ''
  saveDocument(
    db,
    scene,
    doc(...Array.from({ length: PARAGRAPHS }, (_, i) => `Mara counted ${i + 1} gulls on the quay.`))
  )
  const made = createRecord(
    db,
    { name: 'Mara Vell', categoryId: 'character', aliases: [{ text: 'Mara' }] },
    NOW
  )
  if (!('record' in made)) throw new Error('blocked')
  mara = made.record.id
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Seeds `count` claims from paragraph `from`, proved this way. */
function seed(from: number, count: number, proof: 'literal' | 'verified'): string[] {
  return seedClaims(
    db,
    scene,
    Array.from({ length: count }, (_, i) => ({
      recordId: mara,
      slot: 'traits' as const,
      value: `counts ${from + i + 1} gulls`,
      quote: `Mara counted ${from + i + 1} gulls on the quay`,
      para: from + i,
      proof
    })),
    NOW
  )
}

/** The checker: every item supported for its first candidate, but the facts `refuse` names. */
function checker(refuse: (fact: string) => boolean = () => false): FakeAi {
  return fakeAi((request) => {
    if (requestKind(request) !== 'verify') return { text: '{}' }
    return {
      text: JSON.stringify({
        v: sentChecks(request).map((check) => ({
          i: check.i,
          ok: !refuse(check.fact),
          r: check.who[0] ?? null,
          voice: 'narration',
          mode: 'now'
        }))
      })
    }
  })
}

describe('spot checks (F-16.17, P2a-D8)', () => {
  it('after a rebuild sends 50 literal claims fast, 10 a call, and 20 verified ones strong, one a call', async () => {
    const literal = seed(0, 55, 'literal')
    seed(55, 25, 'verified')
    markRebuilt(db, NOW)
    expect(spotCheckDue(getSpotState(db))).toBe(true)
    const ai = checker()
    const run = await runSpotChecks(db, { ai: ai.deps }, { requestId: 'spot-1' })
    expect(run.checked).toEqual({ fast: REBUILD_FAST_CHECKS, strong: REBUILD_STRONG_CHECKS })
    const fast = ai.requests.filter((request) => request.tier === 'fast')
    const strong = ai.requests.filter((request) => request.tier === 'strong')
    expect(fast).toHaveLength(REBUILD_FAST_CHECKS / 10)
    expect(fast.every((request) => sentChecks(request).length === 10)).toBe(true)
    expect(strong).toHaveLength(REBUILD_STRONG_CHECKS)
    expect(strong.every((request) => request.maxTokens === 40)).toBe(true)
    // Three sentences either side for the strong model (the sample is ordered by a hash of the
    // claim ids, so the first one may sit at the scene's start with fewer before it).
    expect(
      strong.some((request) => (sentChecks(request)[0]?.text.split('.').length ?? 0) > 5)
    ).toBe(true)
    const agreed = literal.map((id) => getClaim(db, id)).filter((claim) => claim?.spot === 'agree')
    expect(agreed).toHaveLength(REBUILD_FAST_CHECKS)
    expect(getSpotState(db).rebuildPass).toBe(false)
    expect(run.deleted).toEqual([])
  })

  it('deletes a claim the strong model refuses, and only counts a fast disagreement', async () => {
    const [literal] = seed(0, 1, 'literal')
    const [verified, kept] = seed(1, 2, 'verified')
    markRebuilt(db, NOW)
    const ai = checker((fact) => fact.includes('counts 1 gulls') || fact.includes('counts 2 gulls'))
    const run = await runSpotChecks(db, { ai: ai.deps }, { requestId: 'spot-2' })
    expect(getClaim(db, literal ?? '')).toMatchObject({ spot: 'disagree', spotTier: 'fast' })
    expect(getClaim(db, verified ?? '')).toBeNull()
    expect(getClaim(db, kept ?? '')).toMatchObject({ spot: 'agree', spotTier: 'strong' })
    expect(run.deleted).toEqual([verified])
    expect(run.recordIds).toEqual([mara])
  })

  it('after a rebuild picks 1 verified claim in 20 for the strong batch, sent once 5 wait', async () => {
    const ids = seed(0, 80, 'verified')
    // Stable picks by id: about 1 in 20 of these 400 made-up ids.
    const inserted = Array.from({ length: 400 }, (_, i) => ({
      id: `claim-${i}`,
      proof: i % 2 === 0 ? ('verified' as const) : ('literal' as const)
    }))
    const picked = inserted
      .filter((claim) => claim.proof === 'verified' && spotPicked(claim.id))
      .map((claim) => claim.id)
    expect(picked.length).toBeGreaterThan(0)
    // Before any rebuild, nothing is picked.
    expect(pickStrongDue(db, inserted)).toBe(false)
    expect(getSpotState(db).strongDue).toEqual([])
    setSpotState(db, { rebuiltAt: NOW.toISOString(), rebuildPass: false, strongDue: [] })
    pickStrongDue(db, inserted)
    const due = getSpotState(db).strongDue
    expect(due).toEqual(picked)
    setSpotState(db, { ...getSpotState(db), strongDue: due.slice(0, SPOT_STRONG_DUE - 1) })
    expect(spotCheckDue(getSpotState(db))).toBe(false)
    setSpotState(db, { ...getSpotState(db), strongDue: ids.slice(0, SPOT_STRONG_DUE) })
    expect(spotCheckDue(getSpotState(db))).toBe(true)
    const ai = checker()
    const run = await runSpotChecks(db, { ai: ai.deps }, { requestId: 'spot-3' })
    expect(run.checked).toEqual({ fast: 0, strong: SPOT_STRONG_DUE })
    expect(getSpotState(db).strongDue).toEqual([])
  })
})
