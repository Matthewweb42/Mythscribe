import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { candidatesC7, type Candidate } from '@shared/memory/candidates'
import { emptyCardFields } from '@shared/memory/claims'
import { dismissedKey } from '@shared/memory/dismissed'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { ensureResearchRoot } from '../../project/seed'
import { createResearchNote, setResearchNotCanon } from '../../research/researchStore'
import { createNode, deleteNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { dismiss, dismissedKeys } from '../dismissedStore'
import { indexNodePassages, indexStaleRecords } from '../passageIndexer'
import { createRecord, renameAlias, requireRecord, sameAs, savePage } from '../recordStore'
import { upsertCard } from '../reading/cardStore'
import { anchoredClaim, cardAnchorOf, seedClaims } from '../reading/claimFixture'
import { deleteClaims, reviveClaim, setClaimsState } from '../reading/claimStore'
import { readingOrder } from '../reading/readingFrame'
import { candidateInputs } from './candidateInputs'
import {
  findingRows,
  findingsOf,
  invariantFindings,
  upsertFindings,
  type PairReader
} from './findingStore'
import { findingCounts, runFindingsJob } from './findingsJob'
import { recomputeFindings } from './recompute'
import { cachedVerdict, cacheVerdict, verdictKey } from './verdictCache'

/**
 * The findings data and the local recompute over a stored book (F-16.27; plan P4 §1.4, §1.7): the
 * rules' inputs read from the stores (canon notes only, readable scenes only), findings written by
 * key, opened from cached verdicts at no cost, closed with a reason when their rule no longer
 * produces them, held (never closed) while a side is re-checked, re-keyed by *Same as…*, and the
 * invariants clean after every step.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let chapter: string
let mara: string
let tomas: string
let one: string
let two: string

const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))

const doc = (...paragraphs: (string | { text: string; notCanon: true })[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((each) =>
    typeof each === 'string'
      ? { type: 'paragraph', content: [{ type: 'text', text: each }] }
      : {
          type: 'paragraph',
          attrs: { notCanon: true },
          content: [{ type: 'text', text: each.text }]
        }
  )
})

function record(name: string, categoryId = 'character'): string {
  const made = createRecord(db, { name, categoryId, force: true }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

function scene(title: string, ...paragraphs: string[]): string {
  const id = createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title
  }).id
  saveDocument(db, id, doc(...paragraphs))
  return id
}

/** Everything the invariants hold about findings, over the active draft. */
function findingViolations(): ReturnType<typeof checkMemoryInvariants> {
  const reading = readingOrder(db)
  return checkMemoryInvariants({
    claims: [],
    sceneHashes: new Map(),
    aliases: [],
    citations: [],
    findings: invariantFindings(db, activeDraftId(db), (nodeId) => reading.order.has(nodeId)),
    dismissedFindings: dismissedKeys(db, 'notProblem')
  })
}

/** Both orders called a contradiction for every candidate (what slice 2's cache would hold). */
/**
 * A reader whose cache remembers both orders of any pair as a contradiction; a pair's stamp is its
 * sides, so it is rendered again only when they move.
 */
const bothC: PairReader = {
  read: (candidate, stored) => {
    const inputs = `${candidate.key}|${JSON.stringify(candidate.a)}|${JSON.stringify(candidate.b)}`
    return stored?.inputs === inputs
      ? stored
      : { inputs, keys: { ab: `ab|${inputs}`, ba: `ba|${inputs}` } }
  },
  cached: () => ({ ab: 'c', ba: 'c', why: 'values differ' })
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-findings-'))
  session = createProject(projectFolderFor(tmp, 'Findings'), 'Findings', 'novel', {
    storyMemoryOverride: 'v2'
  })
  db = session.connection.orm
  const first = manuscriptDocuments(db)[0]?.id ?? ''
  chapter = getNode(db, first)?.parentId ?? ''
  mara = record('Mara')
  tomas = record('Tomas')
  one = first
  saveDocument(db, one, doc('Mara climbed the ridge.', "Mara's eyes were grey."))
  two = scene('Two', 'The rain came.', "Mara's eyes were brown.")
  seedClaims(
    db,
    one,
    [{ recordId: mara, slot: 'eyes', value: 'grey', quote: "Mara's eyes were grey", para: 1 }],
    NOW
  )
  seedClaims(
    db,
    two,
    [{ recordId: mara, slot: 'eyes', value: 'brown', quote: "Mara's eyes were brown", para: 1 }],
    NOW
  )
})

afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the rules’ inputs (F-16.27)', () => {
  it('reads canon notes only: Pinned and canon Research, never Ideas or Not canon', () => {
    savePage(db, mara, 'pinned', doc('Eyes: green', { text: 'Eyes: violet', notCanon: true }), NOW)
    savePage(db, mara, 'ideas', doc('Eyes: amber'), NOW)
    indexStaleRecords(db, NOW)
    ensureResearchRoot(db, NOW)
    const page = createResearchNote(db, 'novel', { title: 'Notes' }, NOW)
    saveDocument(db, page.id, doc('Mara has hazel eyes.'))
    indexNodePassages(db, page.id, NOW)
    const shut = createResearchNote(db, 'novel', { title: 'Drafts' }, NOW)
    saveDocument(db, shut.id, doc('Mara has black eyes.'))
    setResearchNotCanon(db, shut.id, true, NOW)
    indexNodePassages(db, shut.id, NOW)
    const notes = candidateInputs(db, activeDraftId(db)).notes.map((note) => note.text)
    expect(notes).toEqual(['Eyes: green', 'Mara has hazel eyes.'])
  })

  it('reads no note of a deleted Research page, so its conflict closes', () => {
    ensureResearchRoot(db, NOW)
    const page = createResearchNote(db, 'novel', { title: 'Notes' }, NOW)
    saveDocument(db, page.id, doc('Mara has hazel eyes.'))
    indexNodePassages(db, page.id, NOW)
    recomputeFindings(db, NOW)
    const draft = activeDraftId(db)
    const c6 = (): number => findingRows(db, draft).filter((row) => row.rule === 'C6').length
    expect(c6()).toBeGreaterThan(0)
    // Its index rows stay until the next open's prune; the rules skip them at once.
    deleteNode(db, page.id)
    expect(candidateInputs(db, draft).notes).toEqual([])
    recomputeFindings(db, NOW)
    expect(c6()).toBe(0)
  })

  it('reads the notes in page order, whichever page was indexed last', () => {
    ensureResearchRoot(db, NOW)
    const first = createResearchNote(db, 'novel', { title: 'First' }, NOW)
    const second = createResearchNote(db, 'novel', { title: 'Second' }, NOW)
    saveDocument(db, first.id, doc('Mara has hazel eyes.'))
    saveDocument(db, second.id, doc('Mara has green eyes.'))
    indexNodePassages(db, first.id, NOW)
    indexNodePassages(db, second.id, NOW)
    const order = (): string[] => candidateInputs(db, activeDraftId(db)).notes.map((n) => n.text)
    const before = order()
    // Re-indexing the first page re-inserts its rows after the second's.
    saveDocument(db, first.id, doc('Mara has hazel eyes.', 'She sails at dawn.'))
    indexNodePassages(db, first.id, NOW)
    expect(order()).toEqual([...before.slice(0, 1), 'She sails at dawn.', ...before.slice(1)])
  })

  it('reads claims of readable scenes only', () => {
    setSceneMeta(db, two, { ...parseStoredSceneMeta(null), status: 'idea' })
    const claims = candidateInputs(db, activeDraftId(db)).claims
    expect(claims.map((each) => each.value)).toEqual(['grey'])
  })

  it('holds a scene’s card against its text only when a rule asks', () => {
    upsertCard(
      db,
      {
        nodeId: two,
        draftId: activeDraftId(db),
        readingId: null,
        line: 'A scene.',
        gist: 'A scene.',
        fields: {
          ...emptyCardFields(),
          flashback: { value: 'yes', quote: 'The rain came', p: 0, verified: true }
        },
        present: [{ recordId: mara, quote: "Mara's eyes were brown", p: 1, verified: true }],
        mood: null,
        theme: null,
        anchor: cardAnchorOf(db, two),
        seen: cardAnchorOf(db, two)
      },
      NOW
    )
    const inputs = candidateInputs(db, activeDraftId(db))
    expect([...(inputs.onPage.get(two) ?? [])]).toEqual([mara])
    expect(inputs.scene(two)).toEqual({
      present: new Set([mara]),
      flashback: true,
      quotedYear: null
    })
    // Edited since: nothing stands.
    saveDocument(db, two, doc('The storm came.', "Mara's eyes were brown."))
    expect(candidateInputs(db, activeDraftId(db)).scene(two)).toEqual({
      present: new Set([mara]),
      flashback: false,
      quotedYear: null
    })
  })
})

describe('the recompute (F-16.27, design §2.4 "Lifecycle")', () => {
  it('writes an unjudged finding, then opens it from cached verdicts at no cost', () => {
    const first = recomputeFindings(db, NOW)
    expect(first).toMatchObject({ opened: [], unjudged: 1, changed: true })
    const [row] = findingsOf(db, activeDraftId(db))
    expect(row).toMatchObject({ rule: 'C1', state: 'unjudged', recordId: mara, slot: 'eyes' })
    // Nothing moved: nothing is written.
    expect(recomputeFindings(db, NOW).changed).toBe(false)
    const second = recomputeFindings(db, NOW, { pairs: bothC })
    expect(second.opened).toHaveLength(1)
    expect(findingsOf(db, activeDraftId(db))[0]).toMatchObject({
      state: 'open',
      verdictAb: 'c',
      verdictBa: 'c',
      costUsd: 0
    })
    expect(findingViolations()).toEqual([])
  })

  it('closes a finding its rule no longer produces, with the reason', () => {
    recomputeFindings(db, NOW, { pairs: bothC })
    const brown = findingsOf(db, activeDraftId(db))[0]?.b
    if (brown?.kind !== 'claim') throw new Error('no claim side')
    deleteClaims(db, [brown.claimId])
    const result = recomputeFindings(db, NOW)
    expect(result.closed.map((each) => each.reason)).toEqual(['gone'])
    expect(findingRows(db, activeDraftId(db))).toEqual([])
    expect(findingViolations()).toEqual([])
  })

  it('closes a finding the author said is not a problem, and it never comes back', () => {
    recomputeFindings(db, NOW, { pairs: bothC })
    const [row] = findingsOf(db, activeDraftId(db))
    if (row === undefined) throw new Error('no finding')
    dismiss(
      db,
      { kind: 'notProblem', key: row.npKey, recordId: mara, label: 'Mara: eyes', quote: null },
      NOW
    )
    // The background set already drops it; the stored row is closed as dismissed.
    expect(recomputeFindings(db, NOW).closed.map((each) => each.reason)).toEqual(['dismissed'])
    expect(recomputeFindings(db, NOW).changed).toBe(false)
    expect(findingViolations()).toEqual([])
  })

  it('holds a finding while a side is re-checked, never closing it, and keeps its verdicts when the very sentences come back', () => {
    recomputeFindings(db, NOW, { pairs: bothC })
    const brown = findingsOf(db, activeDraftId(db))[0]?.b
    if (brown?.kind !== 'claim') throw new Error('no claim side')
    setClaimsState(db, [brown.claimId], 'stale')
    recomputeFindings(db, NOW)
    expect(findingsOf(db, activeDraftId(db))[0]).toMatchObject({ state: 'held', verdictAb: 'c' })
    expect(findingViolations()).toEqual([])
    // Restored (an edit undone): the same words, so the verdicts still fit.
    setClaimsState(db, [brown.claimId], 'live')
    const back = recomputeFindings(db, NOW)
    expect(back.opened).toHaveLength(1)
    expect(findingsOf(db, activeDraftId(db))[0]?.state).toBe('open')
  })

  it('judges a revived side again: its new words were never judged', () => {
    recomputeFindings(db, NOW, { pairs: bothC })
    const brown = findingsOf(db, activeDraftId(db))[0]?.b
    if (brown?.kind !== 'claim') throw new Error('no claim side')
    setClaimsState(db, [brown.claimId], 'stale')
    saveDocument(db, two, doc('The rain came.', "Mara's eyes were a deep brown."))
    reviveClaim(
      db,
      brown.claimId,
      {
        quote: "Mara's eyes were a deep brown",
        para: 1,
        anchor: anchoredClaim(db, two, {
          recordId: mara,
          slot: 'eyes',
          value: 'brown',
          quote: "Mara's eyes were a deep brown",
          para: 1
        }).anchor,
        proof: 'literal',
        readingId: null
      },
      NOW
    )
    const draft = activeDraftId(db)
    const before = findingsOf(db, draft)[0]?.key
    recomputeFindings(db, NOW)
    expect(findingsOf(db, draft)[0]).toMatchObject({
      key: before,
      state: 'unjudged',
      verdictAb: null,
      verdictBa: null
    })
    expect(findingViolations()).toEqual([])
    // The cache, keyed on the pair as rendered, decides at no cost when it knows the new words.
    expect(recomputeFindings(db, NOW, { pairs: bothC }).opened).toHaveLength(1)
  })

  it('judges a side read again in another mode afresh (same scene, same value, same key)', () => {
    recomputeFindings(db, NOW, { pairs: bothC })
    const draft = activeDraftId(db)
    const [row] = findingsOf(db, draft)
    if (row?.b.kind !== 'claim') throw new Error('no claim side')
    deleteClaims(db, [row.b.claimId])
    seedClaims(
      db,
      two,
      [
        {
          recordId: mara,
          slot: 'eyes',
          value: 'brown',
          quote: "Mara's eyes were brown",
          para: 1,
          mode: 'memory'
        }
      ],
      NOW
    )
    recomputeFindings(db, NOW)
    expect(findingsOf(db, draft)[0]).toMatchObject({
      id: row.id,
      key: row.key,
      state: 'unjudged',
      verdictAb: null
    })
    expect(findingViolations()).toEqual([])
  })

  it('closes a held row its rule no longer produces once no side is stale', () => {
    recomputeFindings(db, NOW, { pairs: bothC })
    const draft = activeDraftId(db)
    const [row] = findingsOf(db, draft)
    if (row?.b.kind !== 'claim') throw new Error('no claim side')
    setClaimsState(db, [row.b.claimId], 'stale')
    recomputeFindings(db, NOW)
    // An earlier brown now anchors Mara's eyes: the old pair is no longer produced.
    saveDocument(db, one, doc("Mara's eyes were brown.", "Mara's eyes were grey."))
    seedClaims(
      db,
      one,
      [{ recordId: mara, slot: 'eyes', value: 'brown', quote: "Mara's eyes were brown", para: 0 }],
      NOW
    )
    recomputeFindings(db, NOW)
    // Its stale side still waits for the re-read.
    expect(findingRows(db, draft).find((each) => each.key === row.key)?.state).toBe('held')
    setClaimsState(db, [row.b.claimId], 'live')
    const after = recomputeFindings(db, NOW)
    expect(after.closed.map((each) => [each.finding.key, each.reason])).toEqual([[row.key, 'gone']])
    expect(findingRows(db, draft).some((each) => each.state === 'held')).toBe(false)
    expect(findingViolations()).toEqual([])
  })

  it('keeps the key through a rename (names are not in it)', () => {
    recomputeFindings(db, NOW, { pairs: bothC })
    const before = findingsOf(db, activeDraftId(db))[0]?.key
    const main = requireRecord(db, mara).aliases.find((alias) => alias.isMain)
    if (main === undefined) throw new Error('no name')
    renameAlias(db, mara, main.id, 'Marra', NOW)
    expect(recomputeFindings(db, NOW).changed).toBe(false)
    expect(findingsOf(db, activeDraftId(db))[0]?.key).toBe(before)
  })

  it('leaves a C7 finding (Check the book’s) until a side goes', () => {
    seedClaims(
      db,
      one,
      [
        {
          recordId: tomas,
          slot: 'history',
          value: 'his father kept a tavern in Vellmouth',
          quote: 'Mara climbed the ridge',
          para: 0
        }
      ],
      NOW
    )
    seedClaims(
      db,
      two,
      [
        {
          recordId: tomas,
          slot: 'history',
          value: 'his father kept a forge in Vellmouth',
          quote: 'The rain came',
          para: 0
        }
      ],
      NOW
    )
    const check = candidatesC7(candidateInputs(db, activeDraftId(db)))
    expect(check).toHaveLength(1)
    upsertFindings(db, activeDraftId(db), check, NOW)
    recomputeFindings(db, NOW)
    expect(
      findingsOf(db, activeDraftId(db))
        .map((each) => each.rule)
        .sort()
    ).toEqual(['C1', 'C7'])
    const side = check[0]?.a
    if (side?.kind !== 'claim') throw new Error('no claim side')
    deleteClaims(db, [side.claimId])
    expect(recomputeFindings(db, NOW).closed.map((each) => each.finding.rule)).toEqual(['C7'])
  })

  it('holds a C7 finding while a side is stale, and reopens it when it is restored', () => {
    seedClaims(
      db,
      one,
      [
        {
          recordId: tomas,
          slot: 'history',
          value: 'his father kept a tavern in Vellmouth',
          quote: 'Mara climbed the ridge',
          para: 0
        }
      ],
      NOW
    )
    seedClaims(
      db,
      two,
      [
        {
          recordId: tomas,
          slot: 'history',
          value: 'his father kept a forge in Vellmouth',
          quote: 'The rain came',
          para: 0
        }
      ],
      NOW
    )
    const draft = activeDraftId(db)
    const check = candidatesC7(candidateInputs(db, draft))
    upsertFindings(db, draft, check, NOW, bothC)
    const c7 = (): string | undefined =>
      findingRows(db, draft).find((each) => each.rule === 'C7')?.state
    expect(c7()).toBe('open')
    const side = check[0]?.a
    if (side?.kind !== 'claim') throw new Error('no claim side')
    setClaimsState(db, [side.claimId], 'stale')
    recomputeFindings(db, NOW)
    expect(c7()).toBe('held')
    expect(findingViolations()).toEqual([])
    setClaimsState(db, [side.claimId], 'live')
    recomputeFindings(db, NOW)
    expect(c7()).toBe('open')
    expect(findingViolations()).toEqual([])
  })

  it('moves Not a problem rows to the kept record on Same as…', () => {
    recomputeFindings(db, NOW)
    const [row] = findingsOf(db, activeDraftId(db))
    if (row === undefined) throw new Error('no finding')
    dismiss(
      db,
      { kind: 'notProblem', key: row.npKey, recordId: mara, label: 'Mara: eyes', quote: null },
      NOW
    )
    const loose = dismissedKey({
      kind: 'notProblem',
      loose: { kind: 'character', id: mara, lastNodeId: one }
    })
    dismiss(db, { kind: 'notProblem', key: loose, recordId: mara, label: 'Mara', quote: null }, NOW)
    sameAs(db, tomas, mara, NOW)
    const keys = [...dismissedKeys(db, 'notProblem')].sort()
    expect(keys).toEqual(
      [row.npKey.replace(`|${mara}|`, `|${tomas}|`), `loose|character|${tomas}|${one}`].sort()
    )
    // The merged record's findings went with it; the kept one's are found again.
    expect(findingRows(db, activeDraftId(db))).toEqual([])
    recomputeFindings(db, NOW)
    expect(findingRows(db, activeDraftId(db))).toEqual([])
  })
})

describe('the findings job', () => {
  it('answers the counts only when something moved', () => {
    const first = runFindingsJob(db, NOW)
    expect(first.counts).toEqual({ open: 0, unclear: 0, waiting: 1 })
    expect(runFindingsJob(db, NOW).counts).toBeNull()
    runFindingsJob(db, NOW, { pairs: bothC })
    expect(findingCounts(db)).toEqual({ open: 1, unclear: 0, waiting: 0 })
  })

  it('answers no counts while the Contradiction check is off (as memory:findings answers then)', () => {
    expect(runFindingsJob(db, NOW, { pairs: bothC, shown: false }).counts).toEqual({
      open: 0,
      unclear: 0,
      waiting: 0
    })
    expect(findingCounts(db, false)).toEqual({ open: 0, unclear: 0, waiting: 0 })
    expect(findingCounts(db)).toEqual({ open: 1, unclear: 0, waiting: 0 })
  })

  it('a row whose only change is its stamp moves nothing a view shows', () => {
    runFindingsJob(db, NOW, { pairs: bothC })
    const draft = activeDraftId(db)
    const before = findingsOf(db, draft)[0]
    // The same keys under a new stamp (an edit elsewhere in the scene): written, not "changed".
    const restamping: PairReader = {
      read: (_candidate, stored) => ({ inputs: 'moved', keys: stored?.keys ?? null }),
      cached: () => null
    }
    const result = runFindingsJob(db, NOW, { pairs: restamping })
    expect(result).toMatchObject({ changed: false, counts: null })
    expect(findingsOf(db, draft)[0]).toMatchObject({
      state: before?.state,
      verdictAb: 'c',
      rendered: { inputs: 'moved' }
    })
  })
})

describe('the verdict cache', () => {
  it('keys a pair-order by version, tier, order and the item as sent', () => {
    const base = { promptVersion: 'judge.v1', tier: 'fast', order: 'ab' as const, item: 'A | B' }
    expect(verdictKey(base)).toBe(verdictKey({ ...base }))
    expect(verdictKey({ ...base, order: 'ba' })).not.toBe(verdictKey(base))
    expect(verdictKey({ ...base, tier: 'strong' })).not.toBe(verdictKey(base))
    expect(verdictKey({ ...base, item: 'A | C' })).not.toBe(verdictKey(base))
  })

  it('remembers a verdict, marks it used, and prunes the least recently used', () => {
    const row = (key: string) => ({
      key,
      verdict: 'c' as const,
      why: 'grey against brown',
      tier: 'fast',
      promptVersion: 'judge.v1',
      model: 'm',
      costUsd: 0.0001
    })
    cacheVerdict(db, row('k1'), new Date(NOW.getTime() + 1), 2)
    cacheVerdict(db, row('k2'), new Date(NOW.getTime() + 2), 2)
    expect(cachedVerdict(db, 'k1', new Date(NOW.getTime() + 3))).toMatchObject({ verdict: 'c' })
    cacheVerdict(db, row('k3'), new Date(NOW.getTime() + 4), 2)
    expect(cachedVerdict(db, 'k2', NOW)).toBeNull()
    expect(cachedVerdict(db, 'k1', NOW)).not.toBeNull()
    expect(cachedVerdict(db, 'k3', NOW)).not.toBeNull()
  })
})

describe('upsert by key', () => {
  it('writes each key once and keeps a row’s verdicts only while the judged pair is unchanged', () => {
    const inputs = candidateInputs(db, activeDraftId(db))
    const draft = activeDraftId(db)
    recomputeFindings(db, NOW, { inputs, pairs: bothC })
    const [row] = findingsOf(db, draft)
    if (row === undefined) throw new Error('no finding')
    const again: Candidate = {
      rule: row.rule,
      variant: row.variant,
      recordId: row.recordId,
      slot: row.slot,
      a: row.a,
      b: row.b,
      extra: null,
      held: false,
      hidden: false,
      npKey: row.npKey,
      key: row.key
    }
    expect(upsertFindings(db, draft, [again], NOW).written).toBe(0)
    expect(findingsOf(db, draft)[0]).toMatchObject({ id: row.id, state: 'open', verdictAb: 'c' })
    // A re-read claim has a new id, the same value and scene: the same finding, judged again.
    const moved: Candidate = {
      ...again,
      b: row.b.kind === 'claim' ? { ...row.b, claimId: 'renewed' } : row.b
    }
    upsertFindings(db, draft, [moved], NOW)
    const [after] = findingsOf(db, draft)
    expect(after).toMatchObject({ id: row.id, state: 'unjudged', verdictAb: null, confirm: null })
    expect(after?.b).toMatchObject({ claimId: 'renewed' })
    // A scene's card now says flashback: what the judge reads moved too.
    upsertFindings(db, draft, [moved], NOW, bothC)
    expect(findingsOf(db, draft)[0]?.state).toBe('open')
    upsertFindings(db, draft, [{ ...moved, hidden: true }], NOW)
    expect(findingsOf(db, draft)[0]).toMatchObject({ state: 'hidden', verdictAb: null })
  })
})
