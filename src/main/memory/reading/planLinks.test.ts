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
import { AiRateLimitError } from '../../ai/providers/types'
import { saveDocument } from '../../document/documentStore'
import { getSceneMeta, setSceneMeta } from '../../document/sceneMetaStore'
import { activeDraftId, duplicateDraft, switchDraft } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { getAiSettings, setAiSettings } from '../../project/settingsStore'
import { createNode, getNode, listNodes, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { getDismissedByKey, undoDismissed } from '../dismissedStore'
import { scanNamesFor } from '../nameIndexer'
import { createRecord } from '../recordStore'
import { upsertCard } from './cardStore'
import { keepPlanLink, linkPlansAfterReading, restoreUnlinked, unlinkPlanV2 } from './planLinks'
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

  it('makes nothing while Plan links is off, past the Cloud cap, or on a failed request', async () => {
    card(quay, 'Mara waits at the quay for the ferry.')
    card(harbour, 'Mara waits at the quay for the ferry.')
    const settings = getAiSettings(db)
    setAiSettings(db, { ...settings, features: { ...settings.features, planLinks: false } })
    expect(await link(quay, true)).toEqual({ changed: false, asked: false, costUsd: 0 })
    setAiSettings(db, settings)
    // Past the Cloud cap the pick is not asked (code still links what is clear).
    const capped = await linkPlansAfterReading(db, ai.deps, {
      settings,
      readingId,
      nodeId: quay,
      lineMoved: true,
      requestId: 'test-cap',
      askAi: false
    })
    expect(capped).toEqual({ changed: false, asked: false, costUsd: 0 })
    expect(planRequests()).toBe(0)
    ai = fakeAi(() => {
      throw new AiRateLimitError('Slow down.')
    })
    expect(await link(quay, true)).toEqual({ changed: false, asked: false, costUsd: 0 })
    expect(planLinkRows(db)).toEqual([])
  })

  it('counts the cost of a reply that does not read, and links nothing', async () => {
    ai = fakeAi(() => ({ text: 'not json' }))
    card(quay, 'Mara waits at the quay for the ferry.')
    card(harbour, 'Mara waits at the quay for the ferry.')
    const spent: number[] = []
    const result = await linkPlansAfterReading(db, ai.deps, {
      settings: getAiSettings(db),
      readingId,
      nodeId: quay,
      lineMoved: true,
      requestId: 'test-unread',
      onSpend: (usd) => void spent.push(usd)
    })
    expect(result.changed).toBe(false)
    expect(result.asked).toBe(true)
    expect(result.costUsd).toBeGreaterThan(0)
    expect(spent).toEqual([result.costUsd])
    expect(planLinkRows(db)).toEqual([])
  })

  it('matches code links again as cards arrive: a stronger scene read later takes the plan', async () => {
    // Rebuild order: the weaker scene is read first and, alone, is linked.
    card(quay, 'Mara walks to the quay.')
    expect(await link(quay, true)).toMatchObject({ changed: true, asked: false })
    expect(livePlanLinks(db)).toMatchObject([{ planId: plan, sceneId: quay, origin: 'code' }])
    const dusk = scene('Dusk', 'Mara waited at the quay for the ferry at dusk.')
    scanNamesFor(db, dusk, NOW)
    card(dusk, 'Mara waits at the quay for the ferry.')
    expect(await link(dusk, true)).toMatchObject({ changed: true, asked: false })
    expect(livePlanLinks(db)).toMatchObject([{ planId: plan, sceneId: dusk, origin: 'code' }])
    expect(planRequests()).toBe(0)
    // The same pass again changes nothing.
    expect(await link(quay, false)).toMatchObject({ changed: false })
  })

  it('takes a code link off when a later card makes the match too close, and asks the AI', async () => {
    ai = fakeAi(() => ({ text: JSON.stringify({ pick: 'none', why: 'Neither.' }) }))
    card(quay, 'Mara waits at the quay.')
    await link(quay, true)
    expect(livePlanLinks(db)).toMatchObject([{ sceneId: quay, origin: 'code' }])
    const dusk = scene('Dusk', 'Mara waited at the quay for the ferry.')
    scanNamesFor(db, dusk, NOW)
    card(dusk, 'Mara waits at the quay for the ferry.')
    // 1 against 0.75: too close for code. The code link goes; the AI says neither.
    expect(await link(dusk, true)).toMatchObject({ changed: true, asked: true })
    expect(planRequests()).toBe(1)
    expect(planLinkRows(db)).toEqual([])
  })

  it('checks an AI pick again when its scene’s card line moves', async () => {
    card(quay, 'Mara waits at the quay for the ferry.')
    card(harbour, 'Mara waits at the quay for the ferry.')
    await link(quay, true)
    expect(planLinkRows(db)).toMatchObject([{ sceneId: harbour, origin: 'ai' }])
    // Another scene's reading leaves the pick alone.
    expect(await link(quay, true)).toMatchObject({ changed: false })
    card(harbour, 'Tomas mends nets in the rain.')
    expect(await link(harbour, true)).toMatchObject({ changed: true })
    // The pick no longer holds; code links the clear match left.
    expect(livePlanLinks(db)).toMatchObject([{ planId: plan, sceneId: quay, origin: 'code' }])
  })

  it('never links a name-only match', async () => {
    const nets = scene('Nets', 'Mara mended a net by the fire.')
    scanNamesFor(db, nets, NOW)
    card(nets, 'Mara mends a net.')
    card(harbour, 'Tomas mends nets.')
    // Mara is the only thing the plan and the scene share: one term, not two.
    expect(await link(nets, true)).toMatchObject({ changed: false, asked: false })
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

  it('Unlink of an automatic link drops the row and dismisses the pair; Undo puts it back', async () => {
    card(quay, 'Mara waits at the quay for the ferry.')
    card(harbour, 'Tomas mends nets.')
    await link(quay, true)
    const before = planLinkRows(db)
    expect(unlinkPlanV2(db, { kind: 'scene', nodeId: plan }, NOW)).toEqual({ changedNodeIds: [] })
    expect(planLinkRows(db)).toEqual([])
    const row = getDismissedByKey(
      db,
      'unlink',
      dismissedKey({ kind: 'unlink', planId: plan, sceneId: quay })
    )
    if (row === null) throw new Error('not dismissed')
    undoDismissed(db, row.id)
    expect(restoreUnlinked(db, row)).toEqual({ changedNodeIds: [], linksChanged: true })
    expect(planLinkRows(db)).toEqual(before)
    // Undone once: a second restore finds nothing kept.
    expect(restoreUnlinked(db, row)).toEqual({ changedNodeIds: [], linksChanged: false })
  })

  it('Undo of an Unlink of the author’s own link writes it back into her metadata', async () => {
    setSceneMeta(db, plan, { ...getSceneMeta(db, plan).meta, fulfilledBy: harbour })
    unlinkPlanV2(db, { kind: 'scene', nodeId: plan }, NOW)
    const row = getDismissedByKey(
      db,
      'unlink',
      dismissedKey({ kind: 'unlink', planId: plan, sceneId: harbour })
    )
    if (row === null) throw new Error('not dismissed')
    undoDismissed(db, row.id)
    expect(restoreUnlinked(db, row)).toEqual({ changedNodeIds: [plan], linksChanged: false })
    expect(parseStoredSceneMeta(getNode(db, plan)?.sceneMeta ?? null).fulfilledBy).toBe(harbour)
  })

  it('after Unlink, a later reading does not hand the plan to the runner-up', async () => {
    card(quay, 'Mara walks to the quay.')
    const dusk = scene('Dusk', 'Mara waited at the quay for the ferry.')
    scanNamesFor(db, dusk, NOW)
    card(dusk, 'Mara waits at the quay for the ferry.')
    await link(dusk, true)
    expect(livePlanLinks(db)).toMatchObject([{ sceneId: dusk, origin: 'code' }])
    unlinkPlanV2(db, { kind: 'scene', nodeId: plan }, NOW)
    expect(await link(quay, true)).toMatchObject({ changed: false, asked: false })
    expect(await link(dusk, true)).toMatchObject({ changed: false, asked: false })
    expect(planLinkRows(db)).toEqual([])
  })

  it('a link stands only in its draft, and not once its scene is an Idea', async () => {
    card(quay, 'Mara waits at the quay for the ferry.')
    card(harbour, 'Tomas mends nets.')
    await link(quay, true)
    expect(livePlanLinks(db)).toHaveLength(1)
    // An Idea scene never happened: it fulfils nothing, and the story map keeps the plan.
    setSceneMeta(db, quay, { ...getSceneMeta(db, quay).meta, status: 'idea' })
    expect(livePlanLinks(db)).toEqual([])
    expect(storyMapItems(db, listNodes(db), 'v2').map((item) => item.id)).toContain(plan)
    setSceneMeta(db, quay, { ...getSceneMeta(db, quay).meta, status: 'none' })
    expect(livePlanLinks(db)).toHaveLength(1)
    // Another draft: the link made from this draft's cards is not live there.
    const drafts = duplicateDraft(db, activeDraftId(db), 'Second')
    const other = drafts.drafts.find((each) => each.name === 'Second')?.id ?? ''
    switchDraft(db, other)
    expect(livePlanLinks(db)).toEqual([])
    // It waits for its own draft rather than being dropped.
    await link(quay, false)
    switchDraft(db, drafts.activeId)
    expect(livePlanLinks(db)).toMatchObject([{ planId: plan, sceneId: quay }])
  })

  it('keeps a plan the author linked to a scene with no words on the v2 story map', () => {
    const empty = scene('Later', null)
    setSceneMeta(db, plan, { ...getSceneMeta(db, plan).meta, fulfilledBy: empty })
    expect(storyMapItems(db, listNodes(db), 'v2').map((item) => item.id)).toContain(plan)
    // v1 as it was: any link the author made writes the plan.
    expect(storyMapItems(db, listNodes(db), 'v1').map((item) => item.id)).not.toContain(plan)
    setSceneMeta(db, plan, { ...getSceneMeta(db, plan).meta, fulfilledBy: quay })
    expect(storyMapItems(db, listNodes(db), 'v2').map((item) => item.id)).not.toContain(plan)
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
