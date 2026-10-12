import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import { emptyCardFields, emptyYields } from '@shared/memory/claims'
import { dismissedKey } from '@shared/memory/dismissed'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { storyMapItems } from '../../ai/context/storyTime'
import { PLAN_LINKS_V2_SENTINEL } from '../../ai/prompts/planLinks.v2'
import { saveDocument } from '../../document/documentStore'
import { getSceneMeta, setSceneMeta } from '../../document/sceneMetaStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { getAiSettings, setAiSettings } from '../../project/settingsStore'
import { createNode, getNode, listNodes, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { getDismissedByKey } from '../dismissedStore'
import { scanNamesFor } from '../nameIndexer'
import { createRecord } from '../recordStore'
import { upsertCard } from './cardStore'
import { keepPlanLink, linkPlansAfterReading, unlinkPlanV2 } from './planLinks'
import { livePlanLinks, planLinkRows, planLinkViewV2 } from './planLinkStore'
import { insertReading } from './readingStore'
import { fakeAi, type FakeAi } from './readingFixture'

/**
 * Plan links applied automatically (F-16.21, decision 2): code links an unambiguous match,
 * `planLinks.v2` picks between an ambiguous best two at most once per reading and only when the
 * reading moved one of their card lines, Keep makes a link the author's, Unlink sends the pair to
 * Dismissed, and a link that no longer stands goes.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let plan: string
let quay: string
let harbour: string
let readingId: string
let ai: FakeAi

const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function scene(title: string, text: string | null): string {
  const chapter = getNode(db, manuscriptDocuments(db)[0]?.id ?? '')?.parentId ?? ''
  const id = createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title
  }).id
  if (text !== null) saveDocument(db, id, doc(text))
  return id
}

function card(nodeId: string, line: string, gist = ''): void {
  upsertCard(
    db,
    {
      nodeId,
      draftId: activeDraftId(db),
      readingId: null,
      line,
      gist,
      fields: emptyCardFields(),
      present: [],
      mood: null,
      theme: null,
      anchor: [],
      seen: []
    },
    NOW
  )
}

/** Plan links after a reading of `nodeId`, with or without a moved card line. */
const link = (nodeId: string, lineMoved: boolean): ReturnType<typeof linkPlansAfterReading> =>
  linkPlansAfterReading(db, ai.deps, {
    settings: getAiSettings(db),
    readingId,
    nodeId,
    lineMoved,
    requestId: `test-${nodeId}`
  })

const planRequests = (): number =>
  ai.requests.filter((request) =>
    (request.messages[0]?.content ?? '').startsWith(PLAN_LINKS_V2_SENTINEL)
  ).length

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-plan-links-v2-'))
  session = createProject(projectFolderFor(tmp, 'Plans'), 'Plans', 'novel')
  db = session.connection.orm
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  const made = createRecord(db, { name: 'Mara', categoryId: 'character', force: true }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  plan = scene('Mara at the quay', null)
  setSceneMeta(db, plan, {
    ...getSceneMeta(db, plan).meta,
    synopsis: 'She waits at the quay for the ferry.'
  })
  quay = scene('The quay', 'Mara walked down to the quay and waited.')
  harbour = scene('Harbour', 'Tomas mended nets in the harbour.')
  for (const id of [quay, harbour]) scanNamesFor(db, id, NOW)
  readingId = insertReading(
    db,
    {
      nodeId: quay,
      draftId: activeDraftId(db),
      purpose: 'window',
      pages: 1,
      paras: [[0, 0]],
      promptVersion: 'reader.v1',
      verifyVersion: 'verify.v1',
      model: 'flash',
      tokensIn: 1,
      tokensOut: 1,
      reasoningTokens: 0,
      costUsd: 0,
      cloud: false,
      finishReason: null,
      yields: emptyYields()
    },
    NOW
  )
  ai = fakeAi(() => ({ text: JSON.stringify({ pick: 'S2', why: 'The ferry is there.' }) }))
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('plan links applied automatically (F-16.21)', () => {
  it('links an unambiguous match in code, with no request, and the story map leaves the plan out', async () => {
    card(quay, 'Mara waits at the quay for the ferry.')
    card(harbour, 'Tomas mends nets.')
    expect(await link(quay, true)).toEqual({ changed: true, asked: false, costUsd: 0 })
    expect(planRequests()).toBe(0)
    expect(livePlanLinks(db)).toEqual([{ planId: plan, sceneId: quay, origin: 'code', reason: '' }])
    expect(planLinkViewV2(db)).toEqual({
      suggestions: [],
      aiApplied: [],
      aiLinks: livePlanLinks(db)
    })
    // The author's metadata is untouched: the link is derived data.
    expect(parseStoredSceneMeta(getNode(db, plan)?.sceneMeta ?? null).fulfilledBy).toBeUndefined()
    const v2 = storyMapItems(db, listNodes(db), 'v2').map((item) => item.id)
    expect(v2).not.toContain(plan)
    expect(storyMapItems(db, listNodes(db), 'v1').map((item) => item.id)).toContain(plan)
    // The v2 story map reads card lines.
    expect(storyMapItems(db, listNodes(db), 'v2').find((item) => item.id === quay)?.summary).toBe(
      'Mara waits at the quay for the ferry.'
    )
  })

  it('asks planLinks.v2 about an ambiguous best two only when the reading moved one of their lines, once', async () => {
    card(quay, 'Mara waits at the quay for the ferry.')
    card(harbour, 'Mara waits at the quay for the ferry.')
    expect(await link(quay, false)).toMatchObject({ changed: false, asked: false })
    expect(planRequests()).toBe(0)
    const second = scene('Mara waits for the ferry', null)
    setSceneMeta(db, second, {
      ...getSceneMeta(db, second).meta,
      synopsis: 'At the quay she waits.'
    })
    const result = await link(quay, true)
    expect(result).toMatchObject({ changed: true, asked: true })
    // Two ambiguous plans, one reading: one request.
    expect(planRequests()).toBe(1)
    const request = ai.requests.at(-1)
    expect(request?.json).toBe(true)
    expect(request?.maxTokens).toBe(100)
    expect(planLinkRows(db)).toMatchObject([
      { planId: plan, sceneId: harbour, origin: 'ai', reason: 'The ferry is there.', readingId }
    ])
    expect(ai.ledger.map((row) => row.promptVersion)).toEqual(['planLinks.v2'])
  })

  it('answers an unchanged question from the local cache (neither scene picked)', async () => {
    ai = fakeAi(() => ({ text: JSON.stringify({ pick: 'none', why: 'Neither carries it out.' }) }))
    card(quay, 'Mara waits at the quay for the ferry.')
    card(harbour, 'Mara waits at the quay for the ferry.')
    expect(await link(quay, true)).toMatchObject({ changed: false, asked: true })
    expect(await link(harbour, true)).toMatchObject({ changed: false, asked: true })
    // The second reading asked the same question: the cache answered, the provider was not called.
    expect(planRequests()).toBe(1)
    expect(planLinkRows(db)).toEqual([])
  })

  it('makes nothing while Plan links is off, and nothing on a failed request', async () => {
    card(quay, 'Mara waits at the quay for the ferry.')
    card(harbour, 'Mara waits at the quay for the ferry.')
    const settings = getAiSettings(db)
    setAiSettings(db, { ...settings, features: { ...settings.features, planLinks: false } })
    expect(await link(quay, true)).toEqual({ changed: false, asked: false, costUsd: 0 })
    setAiSettings(db, settings)
    ai = fakeAi(() => ({ text: 'not json' }))
    expect(await link(quay, true)).toMatchObject({ changed: false, asked: false })
    expect(planLinkRows(db)).toEqual([])
  })

  it('Keep makes the link the author’s; Unlink sends the pair to Dismissed and it is never made again', async () => {
    card(quay, 'Mara waits at the quay for the ferry.')
    card(harbour, 'Tomas mends nets.')
    await link(quay, true)
    expect(keepPlanLink(db, plan)).toEqual({ changedNodeIds: [plan] })
    expect(parseStoredSceneMeta(getNode(db, plan)?.sceneMeta ?? null).fulfilledBy).toBe(quay)
    expect(planLinkRows(db)).toEqual([])
    expect(() => keepPlanLink(db, plan)).toThrow(/no automatic link/)
    // The author's own link: Unlink takes it off and dismisses the pair.
    expect(unlinkPlanV2(db, { kind: 'scene', nodeId: plan }, NOW)).toEqual({
      changedNodeIds: [plan]
    })
    expect(parseStoredSceneMeta(getNode(db, plan)?.sceneMeta ?? null).fulfilledBy).toBeUndefined()
    const key = dismissedKey({ kind: 'unlink', planId: plan, sceneId: quay })
    expect(getDismissedByKey(db, 'unlink', key)?.label).toBe(
      'Plan link: Mara at the quay fulfilled by The quay'
    )
    await link(quay, true)
    expect(planLinkRows(db)).toEqual([])
  })

  it('Unlink of an automatic link drops the row and dismisses the pair', async () => {
    card(quay, 'Mara waits at the quay for the ferry.')
    card(harbour, 'Tomas mends nets.')
    await link(quay, true)
    expect(unlinkPlanV2(db, { kind: 'scene', nodeId: plan }, NOW)).toEqual({ changedNodeIds: [] })
    expect(planLinkRows(db)).toEqual([])
    expect(
      getDismissedByKey(db, 'unlink', dismissedKey({ kind: 'unlink', planId: plan, sceneId: quay }))
    ).not.toBeNull()
  })

  it('drops a link that no longer stands once the plan has words', async () => {
    card(quay, 'Mara waits at the quay for the ferry.')
    card(harbour, 'Tomas mends nets.')
    await link(quay, true)
    saveDocument(db, plan, doc('Now it is written.'))
    expect(livePlanLinks(db)).toEqual([])
    expect(planLinkRows(db)).toHaveLength(1)
    await link(quay, false)
    expect(planLinkRows(db)).toEqual([])
  })
})
