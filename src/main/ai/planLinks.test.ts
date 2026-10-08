import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { planLinkKey, type PlanRef } from '@shared/planLinks'
import { emptySceneMeta, parseStoredSceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { upsertSummary } from '../document/summaryStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getPlanLinkState, setAiSettings, setProjectStructure } from '../project/settingsStore'
import { createSeededProject } from '../project/testProject'
import { getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { defaultAiUsageState, dayOf } from './dailyCap'
import {
  confirmPlanLink,
  dismissPlanLink,
  getPlanLinks,
  runPlanLinks,
  unlinkPlan
} from './planLinks'
import { resetInflight } from './inflight'
import type { CompletionRequest, CompletionResult, Provider } from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 9, 8, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
/** Scene 0 and 1 are written and summarized; scene 2 is a planned stub. */
let scenes: string[]

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const summarize = (nodeId: string, summary: string): void =>
  upsertSummary(db, {
    nodeId,
    summary,
    keyPoints: [],
    characters: [],
    contentHash: 'h',
    promptVersion: 'summary.v3',
    model: 'gpt-5.4-mini',
    truncated: false,
    createdAt: NOW.toISOString()
  })

function answers(...links: unknown[]): void {
  complete.mockResolvedValueOnce({
    text: JSON.stringify({ links }),
    model: 'gpt-5.4-mini',
    usage: { inputTokens: 300, outputTokens: 30 }
  })
}

const metaOf = (id: string | undefined): ReturnType<typeof parseStoredSceneMeta> =>
  parseStoredSceneMeta(getNode(db, id ?? '')?.sceneMeta ?? null)

const stub = (): PlanRef => ({ kind: 'scene', nodeId: scenes[2]! })

beforeEach(() => {
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-planlinks-'))
  session = createSeededProject(projectFolderFor(tmp, 'Links'), 'Links', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db).map((row) => row.id)
  saveDocument(db, scenes[0]!, doc('Pell copies the ledger and hides it under the elm.'))
  saveDocument(db, scenes[1]!, doc('Mara digs under the elm at night and finds the copy.'))
  summarize(scenes[0]!, 'Pell hides the ledger copy.')
  summarize(scenes[1]!, 'Mara finds the ledger copy under the elm.')
  setSceneMeta(db, scenes[2]!, { ...emptySceneMeta(), synopsis: 'Mara finds the ledger.' })
  setAiSettings(db, { ...defaultAiSettings(), dial: 1, chatMode: 'ask' })
  complete = vi.fn<Complete>()
  ledger = []
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete,
    stream: async function* () {},
    testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
  }
  const cache = new Map<string, { text: string; usage: CompletionResult['usage'] }>()
  deps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
    cache: {
      get: (key) => cache.get(key),
      put: (entry) => void cache.set(entry.key, { text: entry.text, usage: entry.usage })
    },
    dailyCap: {
      get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(NOW) }),
      spend: () => {}
    },
    session: { spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('runPlanLinks (F-11.1d)', () => {
  it('asks the fast tier about the open plans and the summarized scenes, and stores suggestions at Ask', async () => {
    answers({ plan: 'P1', scene: 'S2', why: 'Mara finds the ledger there.' })
    const result = await runPlanLinks(db, deps)
    expect(result).toMatchObject({ suggested: 1, applied: 0, changedNodeIds: [], requested: true })
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'fast', json: true, maxTokens: 400 })
    const user = request.messages[1]?.content ?? ''
    expect(user).toContain('P1 Planned scene "Scene 1": Mara finds the ledger.')
    expect(user).toContain('S2 "Scene 1": Mara finds the ledger copy under the elm.')
    expect(ledger[0]).toMatchObject({ feature: 'planLinks', promptVersion: 'planLinks.v1' })
    expect(getPlanLinks(db).suggestions).toEqual([
      { plan: stub(), sceneId: scenes[1], reason: 'Mara finds the ledger there.' }
    ])
    // Nothing is linked until the author confirms.
    expect(metaOf(scenes[2]).fulfilledBy).toBeUndefined()
  })

  it('applies the links at once at Auto and remembers them as AI-made', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 1, chatMode: 'auto' })
    setProjectStructure(db, { template: 'saveTheCat' })
    // The seeded book's other empty scenes get text, so the first beat is P2.
    for (const id of scenes.slice(3)) saveDocument(db, id, doc('Written.'))
    answers(
      { plan: 'P1', scene: 'S2', why: 'Found.' },
      { plan: 'P2', scene: 'S1', why: 'The opening image.' }
    )
    const result = await runPlanLinks(db, deps)
    expect(result).toMatchObject({ suggested: 0, applied: 2 })
    expect(new Set(result.changedNodeIds)).toEqual(new Set([scenes[2], scenes[0]]))
    expect(metaOf(scenes[2]).fulfilledBy).toBe(scenes[1])
    expect(metaOf(scenes[0]).beats).toEqual({ saveTheCat: 'opening-image' })
    expect(getPlanLinks(db).aiApplied).toContain(planLinkKey({ plan: stub(), sceneId: scenes[1]! }))
  })

  it('drops labels it never sent, a plan named twice, and a scene linked to itself', async () => {
    answers(
      { plan: 'P9', scene: 'S1' },
      { plan: 'P1', scene: 'S7' },
      { plan: 'P1', scene: 'S1', why: 'First.' },
      { plan: 'P1', scene: 'S2', why: 'Second.' }
    )
    await runPlanLinks(db, deps)
    expect(getPlanLinks(db).suggestions.map((link) => link.sceneId)).toEqual([scenes[0]])
  })

  it('asks nothing without an open plan or a summarized written scene', async () => {
    setSceneMeta(db, scenes[2]!, { ...emptySceneMeta(), fulfilledBy: scenes[1] })
    // The other planned stubs of the seeded book are open plans too; give them text.
    for (const id of scenes.slice(3)) saveDocument(db, id, doc('Written.'))
    const result = await runPlanLinks(db, deps)
    expect(result).toMatchObject({ requested: false, suggested: 0 })
    expect(complete).not.toHaveBeenCalled()
  })

  it('refuses below Ask', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    await expect(runPlanLinks(db, deps)).rejects.toMatchObject({ code: 'DISABLED' })
  })
})

describe('confirm, dismiss, and unlink (F-11.1d)', () => {
  it('confirms a suggestion into the planned scene’s metadata', async () => {
    answers({ plan: 'P1', scene: 'S2', why: 'Found.' })
    await runPlanLinks(db, deps)
    const key = planLinkKey({ plan: stub(), sceneId: scenes[1]! })
    expect(confirmPlanLink(db, key)).toEqual({ changedNodeIds: [scenes[2]] })
    expect(metaOf(scenes[2]).fulfilledBy).toBe(scenes[1])
    expect(getPlanLinks(db).suggestions).toEqual([])
  })

  it('dismisses a suggestion for good: the same pair is never suggested again', async () => {
    answers({ plan: 'P1', scene: 'S2', why: 'Found.' })
    await runPlanLinks(db, deps)
    const key = planLinkKey({ plan: stub(), sceneId: scenes[1]! })
    dismissPlanLink(db, key)
    expect(getPlanLinkState(db).dismissed).toEqual([key])
    answers({ plan: 'P1', scene: 'S2', why: 'Found again.' })
    await runPlanLinks(db, deps)
    expect(getPlanLinks(db).suggestions).toEqual([])
  })

  it('unlinks a planned scene and a beat, and remembers both pairs as dismissed', () => {
    setSceneMeta(db, scenes[2]!, { ...emptySceneMeta(), fulfilledBy: scenes[1] })
    setSceneMeta(db, scenes[0]!, { ...emptySceneMeta(), beats: { saveTheCat: 'catalyst' } })
    expect(unlinkPlan(db, stub())).toEqual({ changedNodeIds: [scenes[2]] })
    expect(metaOf(scenes[2]).fulfilledBy).toBeUndefined()
    const beat: PlanRef = { kind: 'beat', template: 'saveTheCat', beatId: 'catalyst' }
    expect(unlinkPlan(db, beat)).toEqual({ changedNodeIds: [scenes[0]] })
    expect(metaOf(scenes[0]).beats).toEqual({})
    expect(getPlanLinkState(db).dismissed).toEqual([
      planLinkKey({ plan: stub(), sceneId: scenes[1]! }),
      planLinkKey({ plan: beat, sceneId: scenes[0]! })
    ])
  })
})
