import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import { bundledPricing } from '@shared/hostedPricing'
import type { MemoryNotice, MemoryStatus } from '@shared/memory/views'
import type { IndexQueueStatus } from '@shared/jobs'
import type { TiptapNodeT } from '@shared/tiptap'
import { defaultMemoryCloudState, type MemoryCloudState } from '../../ai/cloudTally'
import { cancelInflight, resetInflight } from '../../ai/inflight'
import { AiRateLimitError } from '../../ai/providers/types'
import type { CompletionRequest } from '../../ai/providers/types'
import { saveDocument } from '../../document/documentStore'
import { activeDraftId } from '../../draft/draftStore'
import { enqueueJob, listJobs } from '../../jobs/jobStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { createRecord, listRecords, setAliases } from '../recordStore'
import { getClaim, sceneClaims } from './claimStore'
import { cardAnchorOf, seedClaims } from './claimFixture'
import { lastReading, insertReading } from './readingStore'
import {
  fakeAi,
  requestKind,
  rosterIds,
  sentChecks,
  sentParagraphs,
  type FakeAi
} from './readingFixture'
import { gateScene } from './pipeline'
import { getRebuild, getSpotState, setSpotState, writeRow } from './readerRows'
import { createReaderService, type ReaderService, type ReaderServiceDeps } from './readerService'
import { getSwitchoverRecord, markRebuildStarted, setSwitchoverRecord } from '../switchover/record'
import { dayOf, defaultAiUsageState } from '../../ai/dailyCap'
import { emptyCardFields, emptyYields, type Claim } from '@shared/memory/claims'
import { emptySceneDetails } from '@shared/memory/sceneDetails'
import { listDismissed, undoDismissed } from '../dismissedStore'
import { setSceneDetails } from '../sceneDetailStore'
import { upsertCard } from './cardStore'
import { runAnchors } from './anchors'
import { cardNotRight, dismissClaimsNotRight, restoreNotRight } from './notRight'
import { sceneMemory } from './views'
import { livePlanLinks } from './planLinkStore'
import { reading as readingTable } from '../../db/schema'
import { JUDGE_SENTINEL } from '../../ai/prompts/judge.v1'
import { findingsOf } from '../findings/findingStore'
import { runFindingsJob } from '../findings/findingsJob'
import { JUDGE_DAY_PAIRS, MEMORY_JUDGE_DAY_KEY } from '../findings/findingsService'
import { getUnderlineLog, MEMORY_UNDERLINES_KEY } from '../findings/underlineLog'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string
let chapter: string
let settings: AiSettings
let cloud: MemoryCloudState
let changed: { nodeIds: string[]; recordIds: string[] }[]
let planLinkPushes: number[] = []
let statuses: MemoryStatus[]
let noticeLists: MemoryNotice[][]
let services: ReaderService[]

const NOW = new Date(2026, 9, 12, 12, 0, 0)

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function service(ai: FakeAi, over: Partial<ReaderServiceDeps> = {}): ReaderService {
  const made = createReaderService({
    db: () => db,
    memory: () => 'v2',
    settings: () => settings,
    requestDeps: () => ai.deps,
    provider: () => {
      const provider = ai.deps.providers.get()
      return provider === null
        ? null
        : {
            id: provider.id,
            fastModel: provider.resolveModel('fast'),
            strongModel: provider.resolveModel('strong')
          }
    },
    pricing: () => null,
    cloud: {
      get: () => cloud,
      update: (fn) => {
        cloud = fn(cloud)
        return cloud
      }
    },
    cancelRequest: (id) => void cancelInflight(id),
    now: () => NOW,
    changed: (payload) => void changed.push(payload),
    questions: () => undefined,
    planLinksChanged: () => void planLinkPushes.push(1),
    status: (status) => void statuses.push(status),
    notices: (notices) => void noticeLists.push(notices),
    jobs: () => undefined,
    minIntervalMs: 0,
    backlogDelayMs: 0,
    ...over
  })
  services.push(made)
  return made
}

/** Waits until `ready` holds (the queue works on timers). */
async function until(ready: () => boolean, what = 'the condition'): Promise<void> {
  for (let i = 0; i < 1_000; i += 1) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(
    `Timed out waiting for ${what}: ${JSON.stringify(services.map((each) => each.queueStatus()))} ${JSON.stringify(listJobs(db))}`
  )
}

/** Waits for the queue to finish everything it can run. */
async function drained(reader: ReaderService): Promise<void> {
  // The judge's runs are left out of the queue's counts (F-16.27): `judging` says when they are done.
  await until(() => {
    const status = reader.queueStatus()
    return (
      status.running === null &&
      (status.paused !== null || (status.queued === 0 && !reader.judging()))
    )
  }, 'the reader queue')
  await new Promise((resolve) => setTimeout(resolve, 5))
}

/**
 * The fake reader's answer: Mara's eyes in every paragraph that states them; the checker passes
 * all; the contradiction judge (F-16.27) calls every pair a contradiction, and so does the stronger
 * check of Check the book (F-16.30).
 */
function answerReading(request: CompletionRequest): { text: string } {
  if (request.messages[0]?.content.startsWith(JUDGE_SENTINEL) === true) {
    // The stronger check's one pair (Check the book): a contradiction too.
    if ((request.messages.at(-1)?.content ?? '').startsWith('Pair:\n')) {
      return { text: JSON.stringify({ r: 'c', w: 'grey eyes against brown' }) }
    }
    const items = [...(request.messages.at(-1)?.content ?? '').matchAll(/^(\d+)\. /gmu)]
    return {
      text: JSON.stringify({
        v: items.map((match) => ({ i: Number(match[1]), r: 'c', w: 'values differ' }))
      })
    }
  }
  if (requestKind(request) === 'verify') {
    return {
      text: JSON.stringify({
        v: sentChecks(request).map((check) => ({
          i: check.i,
          ok: true,
          r: check.who[0] ?? null,
          voice: 'narration',
          mode: 'now'
        }))
      })
    }
  }
  const mara = rosterIds(request).get('Mara Vell') ?? ''
  const claims = [...sentParagraphs(request)].flatMap(([p, text]) => {
    const eyes = /Mara's eyes were (\w+)/.exec(text)
    return eyes === null
      ? []
      : [
          {
            p,
            r: mara,
            s: 'eyes',
            v: eyes[1],
            q: `Mara's eyes were ${eyes[1] ?? ''}`,
            voice: 'narration',
            mode: 'now'
          }
        ]
  })
  return { text: JSON.stringify({ c: claims, n: [] }) }
}

/** The fake reader (`answerReading`), on an own key unless told otherwise. */
const reading = (options: { providerId?: 'cloud' | 'openai'; fail?: boolean } = {}): FakeAi =>
  fakeAi(
    (request: CompletionRequest) => {
      if (options.fail === true) throw new AiRateLimitError('OpenAI is rate-limiting this key.')
      return answerReading(request)
    },
    { providerId: options.providerId ?? 'openai', now: NOW }
  )

const readerRequests = (ai: FakeAi): CompletionRequest[] =>
  ai.requests.filter((request) => requestKind(request) === 'reader')

/** A new scene in the first chapter, with these paragraphs. */
function addScene(title: string, ...paragraphs: string[]): string {
  const id = createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title
  }).id
  saveDocument(db, id, doc(...paragraphs))
  return id
}

/** A record's id by its name. */
function rosterRecord(name: string): string {
  const found = listRecords(db).find((each) => each.name === name)
  if (found === undefined) throw new Error(`No record ${name}`)
  return found.id
}

beforeEach(() => {
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-reader-service-'))
  session = createProject(projectFolderFor(tmp, 'Service'), 'Service', 'novel')
  db = session.connection.orm
  scene = manuscriptDocuments(db)[0]?.id ?? ''
  chapter = getNode(db, scene)?.parentId ?? ''
  saveDocument(db, scene, doc("Mara's eyes were grey.", 'At dawn the boats went out.'))
  const made = createRecord(
    db,
    { name: 'Mara Vell', categoryId: 'character', aliases: [{ text: 'Mara' }] },
    NOW
  )
  if (!('record' in made)) throw new Error('blocked')
  settings = { ...defaultAiSettings(), dial: 1 }
  cloud = defaultMemoryCloudState()
  changed = []
  planLinkPushes = []
  statuses = []
  noticeLists = []
  services = []
})
afterEach(() => {
  for (const each of services) each.clear()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Read now (F-16.16, F-16.17)', () => {
  it('reads the scene through the queue, pushes memory:changed, and sends nothing when up to date', async () => {
    const ai = reading()
    const reader = service(ai)
    expect(await reader.readNow(scene, 'read-1')).toMatchObject({ ok: true, read: true })
    expect(changed.at(-1)?.nodeIds).toEqual([scene])
    const sent = ai.requests.length
    expect(await reader.readNow(scene, 'read-2')).toEqual({
      ok: true,
      read: false,
      reason: 'upToDate',
      readingId: null,
      costUsd: 0
    })
    expect(ai.requests).toHaveLength(sent)
    expect(reader.status().lastRead?.nodeId).toBe(scene)
  })

  it('F-16.22: pushes record:changed for a secret a reading made, without a roster change', async () => {
    saveDocument(db, scene, doc("Mara's eyes were grey.", 'Mara sold the map at dawn.'))
    const pushed: string[][] = []
    const ai = fakeAi(
      (request: CompletionRequest) => {
        if (requestKind(request) === 'verify') return answerReading(request)
        return {
          text: JSON.stringify({
            c: [],
            n: [{ n: 'the sold map', kind: 'secret', id: 'x1', p: 1, q: 'Mara sold the map' }]
          })
        }
      },
      { providerId: 'openai', now: NOW }
    )
    const reader = service(ai, { recordsChanged: (ids) => void pushed.push(ids) })
    expect(await reader.readNow(scene, 'read-topic')).toMatchObject({ ok: true, read: true })
    const secret = listRecords(db).find((each) => each.kind === 'secret')
    expect(secret?.name).toBe('the sold map')
    expect(pushed).toEqual([[secret?.id]])
    // memory:changed names it too (plan P2b §2.4 step 7), though no claim on it changed.
    expect(changed.at(-1)?.recordIds).toContain(secret?.id)
  })

  it('F-16.21: links an open plan after a reading that wrote a card, and says so', async () => {
    const plan = createNode(db, 'novel', {
      parentId: chapter,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Boats at dawn'
    }).id
    const ai = fakeAi(
      (request: CompletionRequest) => {
        const base = answerReading(request)
        if (requestKind(request) !== 'reader') return base
        const user = request.messages.at(-1)?.content ?? ''
        if (!user.endsWith('Card: yes')) return base
        const answer = JSON.parse(base.text) as Record<string, unknown>
        return {
          text: JSON.stringify({
            ...answer,
            card: {
              line: 'Mara watches the boats go out at dawn.',
              gist: 'At dawn Mara watches the boats go out.',
              present: []
            }
          })
        }
      },
      { now: NOW }
    )
    const reader = service(ai)
    expect(await reader.readNow(scene, 'read-plan')).toMatchObject({ ok: true, read: true })
    expect(planLinkPushes).toHaveLength(1)
    expect(livePlanLinks(db)).toEqual([
      { planId: plan, sceneId: scene, origin: 'code', reason: '' }
    ])
  })

  it('answers Use AI off, or the reading switch off, as a DISABLED failure without sending', async () => {
    const ai = reading()
    const reader = service(ai)
    settings = defaultAiSettings()
    expect(await reader.readNow(scene, 'read-3')).toMatchObject({ ok: false, code: 'DISABLED' })
    settings = {
      ...defaultAiSettings(),
      dial: 1,
      features: { ...defaultAiSettings().features, verify: false }
    }
    expect(await reader.readNow(scene, 'read-4')).toMatchObject({
      ok: false,
      code: 'DISABLED',
      message: 'Story memory check is turned off for this project.'
    })
    expect(ai.requests).toEqual([])
  })

  it('answers a provider failure as data, and a local cut-off as paused with one notice', async () => {
    expect(await service(reading({ fail: true })).readNow(scene, 'read-5')).toMatchObject({
      ok: false,
      code: 'RATE_LIMIT'
    })
    const cut = fakeAi(() => ({ text: '', finishReason: 'length' }), { providerId: 'local' })
    const reader = service(cut)
    expect(await reader.readNow(scene, 'read-6')).toMatchObject({
      ok: true,
      read: false,
      reason: 'paused'
    })
    expect(reader.notices().map((notice) => notice.kind)).toEqual(['localCutoff'])
    expect(reader.status().paused).toBe('localCutoff')
    // Background reading waits until the author lifts it.
    saveDocument(db, scene, doc("Mara's eyes were blue.", 'At dawn the boats went out.'))
    expect(reader.settle({ nodeId: scene, reason: 'leave', caretPara: null })).toEqual({
      queued: false,
      reason: 'paused'
    })
    expect(reader.answerNotice('localCutoff', 'keepReading')).toEqual([])
    expect(reader.status().paused).toBeNull()
  })
})

describe('leaving a scene and the idle pause (F-16.16)', () => {
  it('reads a scene settled by leaving it, through the gate, once', async () => {
    const ai = reading()
    const reader = service(ai)
    expect(reader.settle({ nodeId: scene, reason: 'leave', caretPara: null })).toEqual({
      queued: true,
      reason: null
    })
    await drained(reader)
    expect(readerRequests(ai)).toHaveLength(1)
    expect(sceneClaims(db, scene, activeDraftId(db)).map((claim) => claim.value)).toEqual(['grey'])
    expect(reader.settle({ nodeId: scene, reason: 'leave', caretPara: null })).toEqual({
      queued: false,
      reason: 'upToDate'
    })
    expect(readerRequests(ai)).toHaveLength(1)
  })

  it('skips the caret paragraph while it has no closing punctuation, on the idle pause only', async () => {
    const ai = reading()
    const reader = service(ai)
    await reader.readNow(scene, 'read-7')
    saveDocument(
      db,
      scene,
      doc("Mara's eyes were grey.", 'At dawn the boats went out.', "Mara's eyes were green and")
    )
    expect(reader.settle({ nodeId: scene, reason: 'idle', caretPara: 2 })).toEqual({
      queued: false,
      reason: 'upToDate'
    })
    // Leaving reads it: the caret is not in the scene then (P2a-D6).
    expect(reader.settle({ nodeId: scene, reason: 'leave', caretPara: 2 })).toEqual({
      queued: true,
      reason: null
    })
    await drained(reader)
    expect(readerRequests(ai)).toHaveLength(2)
    expect(lastReading(db, scene, activeDraftId(db))?.purpose).toBe('window')
  })

  it('reads a scene once more when it is left again while its reading runs', async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const ai = fakeAi(
      async (request: CompletionRequest) => {
        if (requestKind(request) === 'reader' && first) {
          first = false
          await held
        }
        return answerReading(request)
      },
      { now: NOW }
    )
    const reader = service(ai)
    expect(reader.settle({ nodeId: scene, reason: 'leave', caretPara: null }).queued).toBe(true)
    await until(() => readerRequests(ai).length === 1, 'the first reading to be sent')
    saveDocument(db, scene, doc("Mara's eyes were blue.", 'At dawn the boats went out.'))
    expect(reader.settle({ nodeId: scene, reason: 'leave', caretPara: null })).toEqual({
      queued: true,
      reason: null
    })
    release()
    await until(() => readerRequests(ai).length === 2, 'the second reading')
    await drained(reader)
    expect(gateScene(db, scene, null)?.decision.read).toBe('nothing')
    expect(
      sceneClaims(db, scene, activeDraftId(db))
        .filter((claim) => claim.state === 'live')
        .map((claim) => claim.value)
    ).toEqual(['blue'])
  })

  it('queues nothing with Use AI off: the status says reading is off', async () => {
    const ai = reading()
    const reader = service(ai)
    settings = defaultAiSettings()
    expect(reader.settle({ nodeId: scene, reason: 'leave', caretPara: null })).toEqual({
      queued: false,
      reason: 'off'
    })
    expect(reader.status().paused).toBe('off')
    expect(listJobs(db)).toEqual([])
    expect(ai.requests).toEqual([])
  })
})

describe('the backlog of writes outside the editor (F-16.16, P2a §3.3)', () => {
  it('reads up to 5 changed scenes without asking', async () => {
    const ai = reading()
    const reader = service(ai)
    await reader.readNow(scene, 'read-8')
    for (let i = 1; i <= 5; i += 1) addScene(`Scene ${i + 1}`, `Mara's eyes were green ${i}.`)
    reader.bulkWritten()
    await until(() => readerRequests(ai).length === 6, 'five more readings')
    await drained(reader)
    expect(reader.notices()).toEqual([])
  })

  it('asks before reading 6, with the price; Read them reads them all as asked', async () => {
    const ai = reading()
    const reader = service(ai)
    await reader.readNow(scene, 'read-9')
    for (let i = 1; i <= 6; i += 1) addScene(`Scene ${i + 1}`, `Mara's eyes were green ${i}.`)
    reader.bulkWritten()
    await until(() => reader.notices().length > 0, 'the backlog notice')
    const [notice] = reader.notices()
    expect(notice).toMatchObject({ id: 'backlog', kind: 'backlog', scenes: 6 })
    expect(notice?.kind === 'backlog' && notice.priceUsd > 0).toBe(true)
    expect(readerRequests(ai)).toHaveLength(1)
    expect(noticeLists.at(-1)).toEqual(reader.notices())
    expect(reader.answerNotice('backlog', 'read')).toEqual([])
    await until(() => readerRequests(ai).length === 7, 'the six asked readings')
    await drained(reader)
  })

  it('prices a draft never read like Rebuild memory, and Read rebuilds it', async () => {
    const ai = reading()
    for (let i = 1; i <= 6; i += 1) addScene(`Scene ${i + 1}`, `Mara's eyes were green ${i}.`)
    const reader = service(ai)
    reader.opened()
    await until(() => reader.notices().length > 0, 'the draft-unread notice')
    const [notice] = reader.notices()
    expect(notice).toMatchObject({ kind: 'draftUnread', scenes: 7 })
    expect(notice?.kind === 'draftUnread' && notice.priceUsd).toBeCloseTo(
      reader.rebuildEstimate().costUsd
    )
    expect(ai.requests).toEqual([])
    reader.answerNotice('draftUnread', 'read')
    await until(() => typeof getRebuild(db)?.finishedAt === 'string', 'the rebuild')
    await drained(reader)
    expect(getRebuild(db)).toMatchObject({ total: 7, done: 7 })
    expect(lastReading(db, scene, activeDraftId(db))?.purpose).toBe('rebuild')
  })
})

describe('the lazy back-fill (F-16.17, P2a §3.4)', () => {
  function hesk(): string {
    const made = createRecord(db, { name: 'Hesk', categoryId: 'character', aliases: [] }, NOW)
    if (!('record' in made)) throw new Error('blocked')
    return made.record.id
  }

  it('reads up to 3 pages naming a late record without asking, once', async () => {
    saveDocument(db, scene, doc("Mara's eyes were grey.", 'Hesk rowed out past the buoy.'))
    const ai = reading()
    const reader = service(ai)
    await reader.readNow(scene, 'read-10')
    const id = hesk()
    reader.namesAdded(id, ['Hesk'])
    await until(() => readerRequests(ai).length === 2, 'the back-fill reading')
    await drained(reader)
    expect(lastReading(db, scene, activeDraftId(db))?.purpose).toBe('backfill')
    reader.namesAdded(id, ['Hesk'])
    await drained(reader)
    expect(readerRequests(ai)).toHaveLength(2)
  })

  it('counts a record’s names together: over 3 pages waits for its notice while another runs; Read reads them', async () => {
    const scenes = [
      addScene('Scene 2', 'Hesk rowed out.'),
      addScene('Scene 3', 'Hesk rowed back.'),
      addScene('Scene 4', 'Rowan waved from the quay.'),
      addScene('Scene 5', 'Rowan waved again.'),
      addScene('Scene 6', 'Oska swam to the buoy.')
    ]
    const ai = reading()
    const reader = service(ai)
    for (const each of scenes) await reader.readNow(each, `read-${each}`)
    const before = readerRequests(ai).length
    const made = createRecord(
      db,
      { name: 'Hesk', categoryId: 'character', aliases: [{ text: 'Rowan' }] },
      NOW
    )
    if (!('record' in made)) throw new Error('blocked')
    const hesk = made.record.id
    // Two names of 2 pages each: 4 pages together, so it asks (one by one each is under 3).
    reader.namesAdded(hesk, ['Hesk', 'Rowan'])
    expect(reader.notices()).toEqual([
      expect.objectContaining({ kind: 'backfill', recordId: hesk, pages: 4 })
    ])
    const oska = createRecord(db, { name: 'Oska', categoryId: 'character', aliases: [] }, NOW)
    if (!('record' in oska)) throw new Error('blocked')
    reader.namesAdded(oska.record.id, ['Oska'])
    await until(() => readerRequests(ai).length === before + 1, 'Oska’s back-fill')
    await drained(reader)
    expect(readerRequests(ai)).toHaveLength(before + 1)
    expect(reader.notices()).toEqual([
      expect.objectContaining({ kind: 'backfill', recordId: hesk, pages: 4 })
    ])
    // Read: asked, each scene once, and the notice goes.
    expect(reader.answerNotice(`backfill:${hesk}`, 'read')).toEqual([])
    await until(() => readerRequests(ai).length === before + 5, 'Hesk’s back-fill')
    await drained(reader)
    expect(readerRequests(ai)).toHaveLength(before + 5)
    expect(reader.notices()).toEqual([])
  })

  it('runs a back-fill noted while another back-fill job runs', async () => {
    const scenes = [addScene('Scene 2', 'Hesk rowed out.'), addScene('Scene 3', 'Oska swam out.')]
    let hold = false
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const ai = fakeAi(
      async (request: CompletionRequest) => {
        if (hold && requestKind(request) === 'reader') {
          hold = false
          await held
        }
        return answerReading(request)
      },
      { now: NOW }
    )
    const reader = service(ai)
    for (const each of [scene, ...scenes]) await reader.readNow(each, `read-${each}`)
    const before = readerRequests(ai).length
    hold = true
    reader.namesAdded(hesk(), ['Hesk'])
    await until(() => readerRequests(ai).length === before + 1, 'Hesk’s back-fill to be sent')
    const oska = createRecord(db, { name: 'Oska', categoryId: 'character', aliases: [] }, NOW)
    if (!('record' in oska)) throw new Error('blocked')
    reader.namesAdded(oska.record.id, ['Oska'])
    release()
    await until(() => readerRequests(ai).length === before + 2, 'Oska’s back-fill')
    await drained(reader)
    expect(readerRequests(ai)).toHaveLength(before + 2)
  })

  it('asks with the price over 3 pages; Not now declines it for good', async () => {
    const scenes = [scene]
    for (let i = 1; i <= 3; i += 1) scenes.push(addScene(`Scene ${i + 1}`, 'Hesk rowed out.'))
    saveDocument(db, scene, doc("Mara's eyes were grey.", 'Hesk rowed out past the buoy.'))
    const ai = reading()
    const reader = service(ai)
    for (const each of scenes) await reader.readNow(each, `read-${each}`)
    const before = readerRequests(ai).length
    const id = hesk()
    reader.namesAdded(id, ['Hesk'])
    const notice = reader.notices().find((each) => each.kind === 'backfill')
    expect(notice).toMatchObject({ kind: 'backfill', recordId: id, name: 'Hesk', pages: 4 })
    expect(reader.answerNotice(`backfill:${id}`, 'later')).toEqual([])
    reader.namesAdded(id, ['Hesk'])
    await drained(reader)
    expect(readerRequests(ai)).toHaveLength(before)
    expect(reader.notices()).toEqual([])
  })
})

/** Ten readings by the fake's model, with few of their quotes found: the health gate pauses it. */
function badReadings(): void {
  for (let i = 0; i < 10; i += 1) {
    insertReading(
      db,
      {
        nodeId: scene,
        draftId: activeDraftId(db),
        purpose: 'window',
        pages: 1,
        paras: [],
        promptVersion: 'reader.v1',
        verifyVersion: null,
        model: 'gpt-5.4-mini',
        tokensIn: 0,
        tokensOut: 0,
        reasoningTokens: 0,
        costUsd: 0,
        cloud: false,
        finishReason: null,
        yields: { ...emptyYields(), items: 3, quotesFound: 1 }
      },
      new Date(NOW.getTime() - 60_000 + i)
    )
  }
}

describe('the health gate (F-16.17, design §2.3)', () => {
  it('lets no probe past the Cloud cap', async () => {
    badReadings()
    cloud = { ...defaultMemoryCloudState(), month: '2026-10', backgroundUsd: 1 }
    const ai = reading({ providerId: 'cloud' })
    const reader = service(ai)
    expect(reader.status().paused).toBe('cloudCap')
    const scenes = Array.from({ length: 10 }, (_, i) =>
      addScene(`Scene ${i + 2}`, `Mara's eyes were green ${i}.`)
    )
    for (const id of scenes) {
      expect(reader.settle({ nodeId: id, reason: 'leave', caretPara: null })).toEqual({
        queued: false,
        reason: 'paused'
      })
    }
    await drained(reader)
    expect(ai.requests).toEqual([])
  })

  it('holds the bulk work the author asks for while the model is paused; Switch asks for Flash', async () => {
    badReadings()
    const flashed: string[] = []
    const ai = reading()
    const reader = service(ai, { useFlash: (provider) => void flashed.push(provider) })
    expect(reader.rebuild()).toMatchObject({
      ok: false,
      code: 'DISABLED',
      message: 'Story memory paused: this model’s readings aren’t reliable enough.'
    })
    expect(listJobs(db)).toEqual([])
    for (let i = 1; i <= 6; i += 1) addScene(`Scene ${i + 1}`, `Mara's eyes were green ${i}.`)
    await reader.readNow(scene, 'read-held')
    reader.bulkWritten()
    await until(() => reader.notices().some((notice) => notice.kind === 'backlog'), 'the backlog')
    // Read waits: the notice stays beside the health notice that says why.
    expect(reader.answerNotice('backlog', 'read').map((notice) => notice.kind)).toEqual([
      'backlog',
      'health'
    ])
    expect(listJobs(db, 'read')).toEqual([])
    reader.answerNotice('health:gpt-5.4-mini', 'switchModel')
    expect(flashed).toEqual(['openai'])
  })

  it('closes a rebuild whose scene jobs the health gate holds back, with no spot checks', async () => {
    addScene('Scene 2', "Mara's eyes were green.")
    const ai = reading()
    const reader = service(ai)
    expect(reader.rebuild()).toMatchObject({ ok: true, queued: 2 })
    // The model's readings fall below the bars before the first scene job runs.
    badReadings()
    await until(() => typeof getRebuild(db)?.finishedAt === 'string', 'the rebuild to close')
    await drained(reader)
    expect(getRebuild(db)).toMatchObject({ total: 2, done: 0 })
    expect(ai.requests).toEqual([])
    expect(getSpotState(db).rebuildPass).toBe(false)
    expect(reader.queueStatus()).toMatchObject({ paused: null, queued: 0 })
    expect(listJobs(db)).toEqual([])
  })

  it('pauses background reading, probes one due scene in 10, and Keep reading anyway lifts it', async () => {
    badReadings()
    const ai = reading()
    const reader = service(ai)
    expect(reader.notices()).toEqual([
      expect.objectContaining({ kind: 'health', model: 'gpt-5.4-mini', switchable: false })
    ])
    expect(reader.status().paused).toBe('health')
    const scenes = Array.from({ length: 10 }, (_, i) =>
      addScene(`Scene ${i + 2}`, `Mara's eyes were green ${i}.`)
    )
    const answers = scenes.map((id) =>
      reader.settle({ nodeId: id, reason: 'leave', caretPara: null })
    )
    expect(answers.slice(0, 9).every((answer) => answer.reason === 'paused')).toBe(true)
    expect(answers[9]).toEqual({ queued: true, reason: null })
    await until(() => readerRequests(ai).length === 1, 'the probe')
    await drained(reader)
    expect(lastReading(db, scenes[9] ?? '', activeDraftId(db))?.purpose).toBe('probe')
    // Read now is asked: never held back.
    expect(await reader.readNow(scenes[0] ?? '', 'read-11')).toMatchObject({ read: true })
    reader.answerNotice('health:gpt-5.4-mini', 'keepReading')
    expect(reader.status().paused).toBeNull()
    expect(reader.settle({ nodeId: scenes[1] ?? '', reason: 'leave', caretPara: null })).toEqual({
      queued: true,
      reason: null
    })
    await drained(reader)
    expect(reader.health().models[0]).toMatchObject({ model: 'gpt-5.4-mini', keepReading: true })
  })
})

describe('the Cloud monthly cap (F-16.19, P2a §3.6)', () => {
  it('stops background reading at the cap with one notice; asked work is never held back', async () => {
    cloud = { ...defaultMemoryCloudState(), month: '2026-10', backgroundUsd: 1 }
    const ai = reading({ providerId: 'cloud' })
    const reader = service(ai)
    expect(reader.status()).toMatchObject({ paused: 'cloudCap', cloud: { spentUsd: 1, capUsd: 1 } })
    expect(reader.notices()).toEqual([
      expect.objectContaining({ id: 'cloudCap:2026-10', kind: 'cloudCap', capUsd: 1 })
    ])
    expect(reader.settle({ nodeId: scene, reason: 'leave', caretPara: null })).toEqual({
      queued: false,
      reason: 'paused'
    })
    expect(ai.requests).toEqual([])
    // Read now spends on the author's say-so, as asked.
    expect(await reader.readNow(scene, 'read-12')).toMatchObject({ read: true })
    expect(cloud.askedUsd).toBeGreaterThan(0)
    expect(cloud.backgroundUsd).toBe(1)
    // Allow another $1 this month: background reading goes on, counted as background.
    reader.answerNotice('cloudCap:2026-10', 'allowMore')
    expect(reader.notices()).toEqual([])
    saveDocument(db, scene, doc("Mara's eyes were blue.", 'At dawn the boats went out.'))
    expect(reader.settle({ nodeId: scene, reason: 'leave', caretPara: null })).toMatchObject({
      queued: true
    })
    await drained(reader)
    expect(cloud.backgroundUsd).toBeGreaterThan(1)
    expect(reader.cloudCap()).toMatchObject({ capUsd: 1, extraUsd: 1, limitUsd: 2, reached: false })
  })

  it('runs asked work queued behind background work the cap holds back, and never pauses the queue', async () => {
    const second = addScene('Scene 2', "Mara's eyes were green.")
    cloud = { ...defaultMemoryCloudState(), month: '2026-10', backgroundUsd: 1 }
    // A leave's reading left from before the cap was reached, first in line.
    enqueueJob(db, 'read', second, new Date(NOW.getTime() - 60_000))
    const ai = reading({ providerId: 'cloud' })
    const reader = service(ai)
    reader.opened()
    expect(reader.rebuild()).toMatchObject({ ok: true, queued: 2 })
    await until(() => typeof getRebuild(db)?.finishedAt === 'string', 'the rebuild')
    await drained(reader)
    expect(getRebuild(db)).toMatchObject({ total: 2, done: 2 })
    expect(reader.queueStatus().paused).toBeNull()
    // The rebuild's spot checks ran too, as asked.
    expect(getSpotState(db).rebuildPass).toBe(false)
    expect(listJobs(db)).toEqual([])
    expect(cloud.backgroundUsd).toBe(1)
    expect(cloud.askedUsd).toBeGreaterThan(0)
  })

  it('reads a confirmed backlog past the cap', async () => {
    const ai = reading({ providerId: 'cloud' })
    const reader = service(ai)
    await reader.readNow(scene, 'read-cap')
    cloud = { ...cloud, backgroundUsd: 1 }
    for (let i = 1; i <= 6; i += 1) addScene(`Scene ${i + 1}`, `Mara's eyes were green ${i}.`)
    reader.bulkWritten()
    await until(() => reader.notices().some((notice) => notice.kind === 'backlog'), 'the backlog')
    reader.answerNotice('backlog', 'read')
    await until(() => readerRequests(ai).length === 7, 'the six asked readings')
    await drained(reader)
    expect(reader.queueStatus().paused).toBeNull()
    expect(cloud.backgroundUsd).toBe(1)
  })

  it('lifts the cap at a new month and reads what was left meanwhile', async () => {
    let clock = new Date(2026, 9, 31, 12)
    cloud = { ...defaultMemoryCloudState(), month: '2026-10', backgroundUsd: 1 }
    const ai = reading({ providerId: 'cloud' })
    const reader = service(ai, { now: () => clock })
    expect(reader.settle({ nodeId: scene, reason: 'leave', caretPara: null })).toEqual({
      queued: false,
      reason: 'paused'
    })
    clock = new Date(2026, 10, 1, 9)
    const other = addScene('Scene 2', "Mara's eyes were green.")
    expect(reader.settle({ nodeId: other, reason: 'leave', caretPara: null })).toEqual({
      queued: true,
      reason: null
    })
    // The scene left during the pause comes back through the backlog check.
    await until(() => readerRequests(ai).length === 2, 'both scenes read')
    await drained(reader)
    expect(reader.status().paused).toBeNull()
    expect(gateScene(db, scene, null)?.decision.read).toBe('nothing')
  })

  it('counts what a reading spent even when it fails part-way', async () => {
    const long = (n: number): string =>
      `${'The boats went out at dawn and came back late. '.repeat(220)}${n}.`
    saveDocument(db, scene, doc(long(1), long(2), long(3)))
    let readers = 0
    const ai = fakeAi(
      (request: CompletionRequest) => {
        if (requestKind(request) === 'reader') {
          readers += 1
          if (readers === 2) throw new AiRateLimitError('Cloud is busy.')
        }
        return answerReading(request)
      },
      { providerId: 'cloud', now: NOW }
    )
    const reader = service(ai)
    expect(await reader.readNow(scene, 'read-part')).toMatchObject({
      ok: false,
      code: 'RATE_LIMIT'
    })
    expect(readers).toBe(2)
    expect(cloud.askedUsd).toBeGreaterThan(0)
  })

  it('has no cap on an own key', async () => {
    cloud = { ...defaultMemoryCloudState(), month: '2026-10', backgroundUsd: 5 }
    const ai = reading()
    const reader = service(ai)
    expect(reader.status().cloud).toBeNull()
    expect(reader.settle({ nodeId: scene, reason: 'leave', caretPara: null }).queued).toBe(true)
    await drained(reader)
    expect(cloud.backgroundUsd).toBe(5)
  })
})

describe('Rebuild memory (F-16.19, P2a §3.6)', () => {
  it('prices first, replaces scene by scene, runs the spot checks, and resumes after a reopen', async () => {
    const second = addScene('Scene 2', "Mara's eyes were green.")
    const ai = reading()
    const first = service(ai)
    const estimate = first.rebuildEstimate()
    expect(estimate).toMatchObject({ scenes: 2 })
    expect(ai.requests).toEqual([])
    // Closed before anything ran: the rows stay, the next session resumes them.
    settings = defaultAiSettings()
    expect(first.rebuild()).toMatchObject({ ok: false, code: 'DISABLED' })
    settings = { ...defaultAiSettings(), dial: 1 }
    const started = first.rebuild()
    expect(started).toMatchObject({ ok: true, queued: 2 })
    first.clear()
    const rows = listJobs(db, 'rebuild')
    expect(rows.length).toBeGreaterThan(0)
    const second2 = service(ai)
    second2.opened()
    await until(() => typeof getRebuild(db)?.finishedAt === 'string', 'the rebuild to finish')
    await drained(second2)
    expect(getRebuild(db)).toMatchObject({ total: 2, done: 2 })
    expect(lastReading(db, second, activeDraftId(db))?.purpose).toBe('rebuild')
    // The spot checks ran: the claims proved in code went back to the fast checker.
    expect(getSpotState(db).rebuildPass).toBe(false)
    expect(typeof getSpotState(db).rebuiltAt).toBe('string')
    expect(
      sceneClaims(db, second, activeDraftId(db)).every((claim) => claim.spot === 'agree')
    ).toBe(true)
    const summary = second2.rebuildSummary()
    expect(summary?.sheets).toEqual([expect.objectContaining({ name: 'Mara Vell', lines: 2 })])
    // Not right for the sheet's new lines: both go, and stay gone.
    const recordId = summary?.sheets[0]?.recordId ?? ''
    expect(second2.rebuildAction({ action: 'notRightAll', recordId })).toEqual({ changed: 2 })
    expect(sceneClaims(db, second, activeDraftId(db))).toEqual([])
  })

  it('ends where it stood when the queue is stopped, with no spot checks', async () => {
    addScene('Scene 2', "Mara's eyes were green.")
    const ai = reading()
    const reader = service(ai)
    expect(reader.rebuild()).toMatchObject({ ok: true, queued: 2 })
    reader.cancelAll()
    await drained(reader)
    expect(listJobs(db)).toEqual([])
    expect(getRebuild(db)?.finishedAt).toEqual(expect.any(String))
    expect(ai.requests).toEqual([])
  })
})

describe('the rebuild after the switch-over (F-16.31 part A, SW-D8, plan Switchover §2)', () => {
  const SWITCHED_AT = '2026-10-12T09:00:00.000Z'

  /** The record the conversion leaves: switched, waiting for its first *Rebuild memory*. */
  function switched(): void {
    setSwitchoverRecord(db, {
      switchedAt: SWITCHED_AT,
      trial: false,
      source: null,
      backup: '/backups/Service before story memory 2026-10-12 090000.zip',
      datedCopy: '/My Drive/Service (before story memory 2026-10-12 0900).mythscribe',
      rebuild: 'waiting',
      rebuildStartedAt: null
    })
  }

  /** The book has `n` readable scenes, none read: the first one and `n - 1` more. */
  function book(n: number): string[] {
    return [
      scene,
      ...Array.from({ length: n - 1 }, (_, i) =>
        addScene(`Scene ${i + 2}`, `Mara's eyes were green ${i}.`)
      )
    ]
  }

  const switchoverNotices = (reader: ReaderService): MemoryNotice[] =>
    reader.notices().filter((notice) => notice.kind === 'switchoverRebuild')

  /** The backlog check after an open (its timer is 0 here) has run: one more turn of the loop. */
  const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

  it.each([3, 12])(
    'holds the backlog of %i unread scenes: one priced notice, nothing queued, no backlog notice',
    async (n) => {
      book(n)
      switched()
      const ai = reading()
      const reader = service(ai)
      reader.opened()
      await until(() => switchoverNotices(reader).length > 0, 'the switch-over notice')
      await settled()
      const estimate = reader.rebuildEstimate()
      expect(reader.notices()).toEqual([
        {
          id: 'switchoverRebuild',
          kind: 'switchoverRebuild',
          switchedAt: SWITCHED_AT,
          scenes: n,
          priceUsd: estimate.costUsd,
          priced: estimate.priced
        }
      ])
      expect(estimate.scenes).toBe(n)
      expect(noticeLists.at(-1)).toEqual(reader.notices())
      expect(listJobs(db, ['read', 'rebuild'])).toEqual([])
      expect(ai.requests).toEqual([])
      // A later write outside the editor holds as well.
      reader.bulkWritten()
      await settled()
      expect(listJobs(db, 'read')).toEqual([])
      expect(reader.notices().map((notice) => notice.kind)).toEqual(['switchoverRebuild'])
    }
  )

  it.each([3, 12])(
    'without the record, reads or asks about %i unread scenes as before',
    async (n) => {
      book(n)
      const ai = reading()
      const reader = service(ai)
      reader.opened()
      if (n <= 5) {
        await until(() => readerRequests(ai).length === n, 'the backlog readings')
        await drained(reader)
        expect(reader.notices()).toEqual([])
      } else {
        await until(() => reader.notices().length > 0, 'the draft-unread notice')
        expect(reader.notices()).toEqual([
          expect.objectContaining({ kind: 'draftUnread', scenes: n })
        ])
        expect(ai.requests).toEqual([])
      }
      expect(switchoverNotices(reader)).toEqual([])
    }
  )

  it('still reads the scene the author writes in and leaves; one she only looked at waits', async () => {
    const [first, second, third] = book(3)
    switched()
    const ai = reading()
    const reader = service(ai)
    reader.opened()
    await until(() => switchoverNotices(reader).length > 0, 'the switch-over notice')
    // Opened to check the converted text and left, or paused in, unedited: nothing is read.
    for (const reason of ['leave', 'idle'] as const) {
      expect(reader.settle({ nodeId: first ?? '', reason, caretPara: null })).toEqual({
        queued: false,
        reason: 'paused'
      })
    }
    expect(listJobs(db, 'read')).toEqual([])
    // Saved from the editor, then left: read as any scene left is.
    reader.editorSaved([second ?? ''])
    expect(reader.settle({ nodeId: second ?? '', reason: 'leave', caretPara: null })).toEqual({
      queued: true,
      reason: null
    })
    await until(() => readerRequests(ai).length === 1, 'the left scene read')
    await drained(reader)
    // Its first reading (no rebuild started).
    expect(lastReading(db, second ?? '', activeDraftId(db))?.purpose).toBe('first')
    for (const id of [first, third]) {
      expect(gateScene(db, id ?? '', null)?.decision.read).not.toBe('nothing')
    }
    expect(readerRequests(ai)).toHaveLength(1)
    expect(switchoverNotices(reader)).toHaveLength(1)
    // A project change forgets what was saved: the next open starts the count again.
    reader.clear()
    reader.opened()
    expect(reader.settle({ nodeId: third ?? '', reason: 'leave', caretPara: null }).queued).toBe(
      false
    )
    reader.editorSaved([third ?? ''])
    expect(reader.settle({ nodeId: third ?? '', reason: 'leave', caretPara: null }).queued).toBe(
      true
    )
  })

  it('reads a scene left unedited as before without a record, and once the wait is over', async () => {
    const [first, second] = book(2)
    const ai = reading()
    const reader = service(ai)
    // No record (a project made v2 another way): leaving reads, saved or not.
    expect(reader.settle({ nodeId: first ?? '', reason: 'leave', caretPara: null }).queued).toBe(
      true
    )
    // The wait over (a rebuild started): the same.
    switched()
    markRebuildStarted(db, NOW)
    expect(reader.settle({ nodeId: second ?? '', reason: 'leave', caretPara: null }).queued).toBe(
      true
    )
    await until(() => readerRequests(ai).length === 2, 'both scenes read')
    await drained(reader)
  })

  it('ends the wait when a rebuild starts; a refused rebuild leaves it waiting', async () => {
    book(3)
    switched()
    const ai = reading()
    // No provider: refused, nothing read, still waiting.
    const none = service(ai, { provider: () => null })
    expect(none.rebuild()).toMatchObject({ ok: false, code: 'NO_KEY' })
    none.clear()
    // Use AI off: refused too.
    settings = defaultAiSettings()
    const off = service(ai)
    expect(off.rebuild()).toMatchObject({ ok: false, code: 'DISABLED' })
    off.clear()
    expect(getSwitchoverRecord(db)).toMatchObject({ rebuild: 'waiting', rebuildStartedAt: null })
    expect(listJobs(db)).toEqual([])
    settings = { ...defaultAiSettings(), dial: 1 }
    const reader = service(ai)
    reader.opened()
    await until(() => switchoverNotices(reader).length > 0, 'the switch-over notice')
    expect(reader.rebuild()).toMatchObject({ ok: true, queued: 3 })
    expect(getSwitchoverRecord(db)).toMatchObject({
      rebuild: 'started',
      rebuildStartedAt: NOW.toISOString()
    })
    expect(switchoverNotices(reader)).toEqual([])
    expect(noticeLists.at(-1)?.some((notice) => notice.kind === 'switchoverRebuild')).toBe(false)
    await until(() => typeof getRebuild(db)?.finishedAt === 'string', 'the rebuild')
    await drained(reader)
    expect(getRebuild(db)).toMatchObject({ total: 3, done: 3 })
    // The wait is over: the backlog behaves as before (nothing left to read, no notice).
    reader.bulkWritten()
    await settled()
    expect(switchoverNotices(reader)).toEqual([])
  })

  it('a rebuild the health gate refuses leaves the record waiting, with nothing queued', async () => {
    book(3)
    switched()
    badReadings()
    const ai = reading()
    const reader = service(ai)
    expect(reader.rebuild()).toMatchObject({
      ok: false,
      code: 'DISABLED',
      message: 'Story memory paused: this model’s readings aren’t reliable enough.'
    })
    expect(getSwitchoverRecord(db)).toMatchObject({ rebuild: 'waiting', rebuildStartedAt: null })
    expect(listJobs(db)).toEqual([])
    expect(getRebuild(db)).toBeNull()
    // Keep reading anyway lifts the gate: the next rebuild starts and ends the wait.
    reader.answerNotice('health:gpt-5.4-mini', 'keepReading')
    expect(reader.rebuild()).toMatchObject({ ok: true, queued: 3 })
    expect(getSwitchoverRecord(db)?.rebuild).toBe('started')
    reader.cancelAll()
    await drained(reader)
  })

  it('on Cloud, never starts a rebuild without its price (SW-D9), whichever button asks', async () => {
    book(2)
    switched()
    settings = { ...defaultAiSettings(), dial: 1, source: 'cloud' }
    const ai = reading({ providerId: 'cloud' })
    // The fake's models are on neither Cloud price table: MythScribe Cloud does not offer them.
    const unpriced = service(ai)
    expect(unpriced.rebuildEstimate()).toMatchObject({ source: 'cloud', priced: false })
    expect(unpriced.rebuild()).toEqual({
      ok: false,
      code: 'MODEL_UNAVAILABLE',
      message:
        'MythScribe Cloud has no price for a model story memory uses (gpt-5.4-mini, gpt-5.4), so Rebuild memory does not start: on Cloud it starts only with its price.',
      nextStep: 'Pick another model in Settings › AI, or reset the models to their defaults.'
    })
    expect(getSwitchoverRecord(db)).toMatchObject({ rebuild: 'waiting', rebuildStartedAt: null })
    expect(getRebuild(db)).toBeNull()
    expect(listJobs(db)).toEqual([])
    unpriced.clear()
    // Once Cloud prices those models, the rebuild starts and ends the wait.
    const bundled = bundledPricing()
    const model = bundled.models[0]
    if (model === undefined) throw new Error('The bundled table lists no model.')
    const table = {
      ...bundled,
      models: [...bundled.models, { ...model, id: 'gpt-5.4-mini' }, { ...model, id: 'gpt-5.4' }]
    }
    const reader = service(ai, { pricing: () => table })
    expect(reader.rebuildEstimate()).toMatchObject({ source: 'cloud', priced: true })
    expect(reader.rebuild()).toMatchObject({ ok: true, queued: 2 })
    expect(getSwitchoverRecord(db)?.rebuild).toBe('started')
    reader.cancelAll()
    await drained(reader)
  })

  it('does not start a rebuild once today’s AI spending cap is reached, and says so', async () => {
    book(2)
    switched()
    const ai = reading()
    ai.deps.dailyCap = {
      get: () => ({
        ...defaultAiUsageState(),
        dailyCapUsd: 1,
        spentTodayUsd: 1,
        spentDate: dayOf(NOW)
      }),
      spend: () => undefined
    }
    const reader = service(ai)
    expect(reader.rebuild()).toEqual({
      ok: false,
      code: 'BUDGET',
      message: 'Today’s AI spending cap is reached, so Rebuild memory does not start.',
      nextStep: 'Raise the daily cap in Settings or wait until tomorrow.'
    })
    expect(getSwitchoverRecord(db)).toMatchObject({ rebuild: 'waiting', rebuildStartedAt: null })
    expect(getRebuild(db)).toBeNull()
    expect(listJobs(db)).toEqual([])
    // Yesterday's tally does not count: on a new day the rebuild starts.
    ai.deps.dailyCap = {
      get: () => ({
        ...defaultAiUsageState(),
        dailyCapUsd: 1,
        spentTodayUsd: 1,
        spentDate: '2026-10-11'
      }),
      spend: () => undefined
    }
    expect(reader.rebuild()).toMatchObject({ ok: true, queued: 2 })
    reader.cancelAll()
    await drained(reader)
  })

  it('shows the notice once a provider is set up (a key, a license) and drops it when it goes', async () => {
    book(2)
    switched()
    const ai = reading()
    const fake = ai.deps.providers.get()
    if (fake === null) throw new Error('the fake has a provider')
    let present = false
    const reader = service(ai, {
      provider: () =>
        present
          ? {
              id: fake.id,
              fastModel: fake.resolveModel('fast'),
              strongModel: fake.resolveModel('strong')
            }
          : null
    })
    reader.opened()
    await settled()
    expect(reader.notices()).toEqual([])
    // A key saved, or a license bought after the trial: the handlers call settingsChanged.
    present = true
    reader.settingsChanged()
    expect(switchoverNotices(reader)).toEqual([
      expect.objectContaining({ kind: 'switchoverRebuild', scenes: 2 })
    ])
    expect(noticeLists.at(-1)?.map((notice) => notice.kind)).toEqual(['switchoverRebuild'])
    // The key cleared, or the trial ended: gone at once, and pushed so.
    present = false
    reader.settingsChanged()
    expect(reader.notices()).toEqual([])
    expect(noticeLists.at(-1)).toEqual([])
    expect(reader.rebuild()).toMatchObject({ ok: false, code: 'NO_KEY' })
    expect(getSwitchoverRecord(db)?.rebuild).toBe('waiting')
    expect(ai.requests).toEqual([])
  })

  it('Later hides the notice until the project opens again; Use AI off or the reading switch off shows none', async () => {
    book(2)
    switched()
    settings = defaultAiSettings()
    const ai = reading()
    const reader = service(ai)
    reader.opened()
    await settled()
    expect(reader.notices()).toEqual([])
    // Use AI turned on: the notice, at once.
    settings = { ...defaultAiSettings(), dial: 1 }
    reader.settingsChanged()
    expect(switchoverNotices(reader)).toEqual([
      expect.objectContaining({ kind: 'switchoverRebuild', scenes: 2 })
    ])
    // The reading switch off hides it; on again shows it.
    settings = { ...settings, features: { ...settings.features, reader: false } }
    reader.settingsChanged()
    expect(reader.notices()).toEqual([])
    settings = { ...defaultAiSettings(), dial: 1 }
    reader.settingsChanged()
    expect(switchoverNotices(reader)).toHaveLength(1)
    // Later: gone until the next open, the hold still on.
    expect(reader.answerNotice('switchoverRebuild', 'later')).toEqual([])
    reader.bulkWritten()
    reader.settingsChanged()
    await settled()
    expect(reader.notices()).toEqual([])
    expect(listJobs(db, 'read')).toEqual([])
    // Closing it does the same; the next open (a project change clears the service) brings it back.
    reader.clear()
    reader.opened()
    await until(() => switchoverNotices(reader).length > 0, 'the notice again')
    reader.answerNotice('switchoverRebuild', 'dismiss')
    expect(reader.notices()).toEqual([])
    reader.clear()
    reader.opened()
    await until(() => switchoverNotices(reader).length > 0, 'the notice once more')
    expect(ai.requests).toEqual([])
    expect(getSwitchoverRecord(db)?.rebuild).toBe('waiting')
  })

  it('on Cloud, rebuilds as asked spend past the monthly background cap', async () => {
    book(2)
    switched()
    cloud = { ...defaultMemoryCloudState(), month: '2026-10', backgroundUsd: 1 }
    const ai = reading({ providerId: 'cloud' })
    const reader = service(ai)
    reader.opened()
    await until(() => switchoverNotices(reader).length > 0, 'the switch-over notice')
    expect(reader.status().paused).toBe('cloudCap')
    expect(reader.rebuild()).toMatchObject({ ok: true, queued: 2 })
    await until(() => typeof getRebuild(db)?.finishedAt === 'string', 'the rebuild')
    await drained(reader)
    expect(getRebuild(db)).toMatchObject({ total: 2, done: 2 })
    expect(cloud.askedUsd).toBeGreaterThan(0)
    expect(cloud.backgroundUsd).toBe(1)
    expect(getSwitchoverRecord(db)?.rebuild).toBe('started')
  })

  it('pauses at the daily cap with the rebuild’s progress open, and Resume finishes it', async () => {
    book(3)
    switched()
    const ai = reading()
    // Today's AI cap is reached once the first scene is read, until the author raises it.
    let raised = false
    ai.deps.dailyCap = {
      get: () => ({
        ...defaultAiUsageState(),
        dailyCapUsd: !raised && (getRebuild(db)?.done ?? 0) >= 1 ? 0 : 500,
        spentDate: dayOf(NOW)
      }),
      spend: () => undefined
    }
    const reader = service(ai)
    expect(reader.rebuild()).toMatchObject({ ok: true, queued: 3 })
    await until(() => reader.queueStatus().paused !== null, 'the daily-cap pause')
    await drained(reader)
    expect(reader.queueStatus().paused?.code).toBe('BUDGET')
    expect(reader.status().paused).toBe('dailyCap')
    expect(getRebuild(db)).toMatchObject({ total: 3, done: 1, finishedAt: null })
    expect(reader.status().rebuild).toMatchObject({ total: 3, done: 1, finishedAt: null })
    expect(listJobs(db, 'rebuild').filter((job) => job.status === 'queued')).toHaveLength(2)
    raised = true
    reader.resume()
    await until(() => typeof getRebuild(db)?.finishedAt === 'string', 'the rebuild to finish')
    await drained(reader)
    expect(getRebuild(db)).toMatchObject({ total: 3, done: 3 })
    expect(reader.status().paused).toBeNull()
  })

  it('carries a rebuild paused at the daily cap on when the project opens again', async () => {
    book(3)
    switched()
    const ai = reading()
    // Today's cap is reached after the first scene; the next open is on a new day (spent 0).
    let nextDay = false
    ai.deps.dailyCap = {
      get: () => ({
        ...defaultAiUsageState(),
        dailyCapUsd: !nextDay && (getRebuild(db)?.done ?? 0) >= 1 ? 0 : 500,
        spentDate: dayOf(NOW)
      }),
      spend: () => undefined
    }
    const reader = service(ai)
    expect(reader.rebuild()).toMatchObject({ ok: true, queued: 3 })
    await until(() => reader.queueStatus().paused !== null, 'the daily-cap pause')
    await drained(reader)
    expect(getRebuild(db)).toMatchObject({ total: 3, done: 1, finishedAt: null })
    // While the app stays open, nothing resumes it but the author (Resume, a settings change,
    // Rebuild memory again). The pause lives with the open project: the next open carries on.
    nextDay = true
    reader.clear()
    reader.opened()
    await until(() => typeof getRebuild(db)?.finishedAt === 'string', 'the rebuild to finish')
    await drained(reader)
    expect(getRebuild(db)).toMatchObject({ total: 3, done: 3 })
    expect(getSwitchoverRecord(db)?.rebuild).toBe('started')
  })
})

describe('spot checks after a reading (F-16.17, P2a-D8)', () => {
  it('runs the strong batch once 5 claims wait for it', async () => {
    setSpotState(db, { ...getSpotState(db), strongDue: ['c1', 'c2', 'c3', 'c4', 'c5'] })
    const ai = reading()
    const reader = service(ai)
    expect(reader.settle({ nodeId: scene, reason: 'leave', caretPara: null }).queued).toBe(true)
    await until(() => getSpotState(db).strongDue.length === 0, 'the strong batch')
    await drained(reader)
    expect(listJobs(db)).toEqual([])
  })
})

describe('Not right (F-16.18)', () => {
  const readScene = async (ai: FakeAi): Promise<ReaderService> => {
    const reader = service(ai)
    expect(await reader.readNow(scene, 'read-1')).toMatchObject({ ok: true, read: true })
    return reader
  }
  const eyes = (): Claim | undefined =>
    sceneClaims(db, scene, activeDraftId(db)).find((claim) => claim.slot === 'eyes')

  it('Wrong value dismisses the line, and Undo brings it back as it was', async () => {
    const reader = await readScene(reading())
    const before = eyes()
    expect(before).toMatchObject({ value: 'grey', state: 'live' })
    changed = []
    const result = await reader.notRight(before?.id ?? '', { kind: 'wrongValue' }, 'nr-1')
    expect(result).toMatchObject({ ok: true, outcome: 'dismissed' })
    const row = result.ok ? result.dismissed : null
    expect(row).toMatchObject({ kind: 'notRight', nodeId: scene, label: 'Mara Vell: Eyes grey' })
    expect(eyes()).toBeUndefined()
    expect(changed).toEqual([{ nodeIds: [scene], recordIds: [before?.recordId] }])
    // Undo: the tombstone goes, then the line comes back as it was.
    undoDismissed(db, row?.id ?? '')
    expect(restoreNotRight(db, row?.id ?? '')).toEqual({
      nodeIds: [scene],
      recordIds: [before?.recordId]
    })
    expect(eyes()).toEqual(before)
    // Restored once: a second undo has nothing left to bring back.
    expect(restoreNotRight(db, row?.id ?? '')).toEqual({ nodeIds: [], recordIds: [] })
  })

  it('Not about moves a line the checker supports for the picked record', async () => {
    const made = createRecord(db, { name: 'Ella Harrow', categoryId: 'character' }, NOW)
    if (!('record' in made)) throw new Error('blocked')
    const ella = made.record.id
    let rechecking = false
    const ai = fakeAi(
      (request) => {
        if (requestKind(request) !== 'verify') return answerReading(request)
        // The re-check: the checker picks the record the text points to by a role (Ella, not
        // named here); a reading's own checks pass as asked.
        const checks = sentChecks(request)
        return {
          text: JSON.stringify({
            v: checks.map((check) => ({
              i: check.i,
              ok: true,
              r: (rechecking ? check.unnamed[0] : check.who[0]) ?? null,
              voice: 'narration',
              mode: 'now'
            }))
          })
        }
      },
      { providerId: 'openai', now: NOW }
    )
    const reader = await readScene(ai)
    const mara = eyes()?.recordId
    const sent = ai.requests.length
    rechecking = true
    const result = await reader.notRight(
      eyes()?.id ?? '',
      { kind: 'notAbout', recordId: ella },
      'nr-2'
    )
    expect(result).toMatchObject({ ok: true, outcome: 'moved' })
    expect(ai.requests).toHaveLength(sent + 1)
    expect(requestKind(ai.requests.at(-1)!)).toBe('verify')
    // The checker saw both: Mara, named in the quote, and Ella, marked not named here.
    const [check] = sentChecks(ai.requests.at(-1)!)
    expect(check?.names).toEqual(['Mara Vell', 'Ella Harrow'])
    expect(check?.unnamed).toHaveLength(1)
    expect(eyes()).toMatchObject({ recordId: ella, proof: 'verified', value: 'grey' })
    // Mara keeps a tombstone for it, so a later reading does not hand the line back to her.
    expect(result.ok ? result.dismissed : null).toMatchObject({ kind: 'notRight', recordId: mara })
    // A later reading of the scene (a rebuild too) stores the line for Ella again, not for Mara.
    saveDocument(db, scene, doc("Mara's eyes were grey.", 'At dawn the boats went out at last.'))
    rechecking = false
    const full = await reader.readNow(scene, 'read-again')
    expect(full).toMatchObject({ ok: true })
    const lines = sceneClaims(db, scene, activeDraftId(db)).filter((each) => each.slot === 'eyes')
    expect(lines.map((each) => each.recordId)).toEqual([ella])
  })

  it('Not about checks a pronoun against everyone named near it, never a third record by default', async () => {
    const tomas = createRecord(
      db,
      { name: 'Tomas Harrow', categoryId: 'character', aliases: [{ text: 'Tomas' }] },
      NOW
    )
    const ella = createRecord(db, { name: 'Ella Marsh', categoryId: 'character' }, NOW)
    if (!('record' in tomas) || !('record' in ella)) throw new Error('blocked')
    saveDocument(db, scene, doc('Mara met Tomas at the quay. Her eyes were grey.'))
    const mara = rosterRecord('Mara Vell')
    const [id] = seedClaims(
      db,
      scene,
      [
        {
          recordId: mara,
          slot: 'eyes',
          value: 'grey',
          quote: 'Her eyes were grey',
          para: 0,
          proof: 'verified'
        }
      ],
      NOW
    )
    // A naive checker that answers the first record it is shown.
    const ai = fakeAi(
      (request) => ({
        text: JSON.stringify({
          v: sentChecks(request).map((check) => ({
            i: check.i,
            ok: true,
            r: check.who[0] ?? null,
            voice: 'narration',
            mode: 'now'
          }))
        })
      }),
      { providerId: 'openai', now: NOW }
    )
    const reader = service(ai)
    const result = await reader.notRight(
      id ?? '',
      { kind: 'notAbout', recordId: ella.record.id },
      'nr-p'
    )
    const [check] = sentChecks(ai.requests.at(-1)!)
    expect(check?.names).toEqual(['Mara Vell', 'Tomas Harrow', 'Ella Marsh'])
    expect(check?.unnamed).toHaveLength(1)
    expect(check?.text).toBe('Mara met Tomas at the quay. Her eyes were grey.')
    // The checker named Mara: the move is refused, and the line goes to Dismissed as a wrong value.
    expect(result).toMatchObject({ ok: true, outcome: 'dismissed' })
    expect(getClaim(db, id ?? '')).toBeNull()
  })

  it('Not about changes nothing when the checker gives no verdict', async () => {
    const made = createRecord(db, { name: 'Ella Harrow', categoryId: 'character' }, NOW)
    if (!('record' in made)) throw new Error('blocked')
    let rechecking = false
    const ai = fakeAi(
      (request) => {
        if (requestKind(request) !== 'verify' || !rechecking) return answerReading(request)
        return { text: JSON.stringify({ v: [] }) }
      },
      { providerId: 'openai', now: NOW }
    )
    const reader = await readScene(ai)
    const before = eyes()
    rechecking = true
    const result = await reader.notRight(
      before?.id ?? '',
      { kind: 'notAbout', recordId: made.record.id },
      'nr-none'
    )
    expect(result).toEqual({ ok: true, outcome: 'unchecked', dismissed: null })
    expect(eyes()).toEqual(before)
    expect(listDismissed(db).count).toBe(0)
  })

  it('keeps a stale line undoable: Wrong value writes a row, Not about sends nothing', async () => {
    const made = createRecord(db, { name: 'Ella Harrow', categoryId: 'character' }, NOW)
    if (!('record' in made)) throw new Error('blocked')
    const ai = reading()
    const reader = await readScene(ai)
    const before = eyes()
    // The sentence is edited since it was read: its quote is no longer in the scene.
    saveDocument(db, scene, doc("Mara's eyes were a stormy blue.", 'At dawn the boats went out.'))
    runAnchors(db, scene, NOW)
    expect(eyes()).toMatchObject({ state: 'stale' })
    const sent = ai.requests.length
    const about = await reader.notRight(
      before?.id ?? '',
      { kind: 'notAbout', recordId: made.record.id },
      'nr-stale'
    )
    expect(about).toEqual({ ok: true, outcome: 'unchecked', dismissed: null })
    expect(ai.requests).toHaveLength(sent)
    const wrong = await reader.notRight(before?.id ?? '', { kind: 'wrongValue' }, 'nr-stale-2')
    expect(wrong).toMatchObject({ ok: true, outcome: 'dismissed' })
    const row = wrong.ok ? wrong.dismissed : null
    expect(row).toMatchObject({ kind: 'notRight', label: 'Mara Vell: Eyes grey' })
    expect(eyes()).toBeUndefined()
    undoDismissed(db, row?.id ?? '')
    restoreNotRight(db, row?.id ?? '')
    expect(eyes()).toMatchObject({ id: before?.id, value: 'grey', state: 'stale' })
  })

  it('brings back every line a bulk Not right took, even with their reading gone', async () => {
    const reader = await readScene(reading())
    const two = addScene('Two', "Mara's eyes were green.")
    expect(await reader.readNow(two, 'read-2')).toMatchObject({ ok: true, read: true })
    const mara = eyes()?.recordId ?? ''
    const all = [
      ...sceneClaims(db, scene, activeDraftId(db)),
      ...sceneClaims(db, two, activeDraftId(db))
    ]
    // The rebuild summary's bulk Not right for Mara's sheet (`applyRebuildAction` runs this).
    const lines = all.filter((each) => each.recordId === mara)
    expect(lines).toHaveLength(2)
    db.transaction((tx) => dismissClaimsNotRight(tx, lines, NOW))
    expect(sceneClaims(db, scene, activeDraftId(db))).toEqual([])
    db.delete(readingTable).run()
    const rows = listDismissed(db).items.filter((row) => row.kind === 'notRight')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      undoDismissed(db, row.id)
      restoreNotRight(db, row.id)
    }
    const back = [
      ...sceneClaims(db, scene, activeDraftId(db)),
      ...sceneClaims(db, two, activeDraftId(db))
    ]
    expect(back.map((each) => each.id).sort()).toEqual(all.map((each) => each.id).sort())
    expect(back.every((each) => each.readingId === null)).toBe(true)
  })

  it('Not about dismisses a line the checker does not support for the picked record', async () => {
    const made = createRecord(db, { name: 'Ella Harrow', categoryId: 'character' }, NOW)
    if (!('record' in made)) throw new Error('blocked')
    let rechecking = false
    const ai = fakeAi(
      (request) => {
        if (requestKind(request) !== 'verify' || !rechecking) return answerReading(request)
        return { text: JSON.stringify({ v: [{ i: 1, ok: false, r: null }] }) }
      },
      { providerId: 'openai', now: NOW }
    )
    const reader = await readScene(ai)
    rechecking = true
    const result = await reader.notRight(
      eyes()?.id ?? '',
      { kind: 'notAbout', recordId: made.record.id },
      'nr-3'
    )
    expect(result).toMatchObject({ ok: true, outcome: 'dismissed' })
    expect(eyes()).toBeUndefined()
  })

  it('answers the AI failure when reading is off, and a gone line as gone', async () => {
    const reader = await readScene(reading())
    expect(await reader.notRight('no-such-claim', { kind: 'wrongValue' }, 'nr-4')).toEqual({
      ok: true,
      outcome: 'gone',
      dismissed: null
    })
    settings = { ...settings, dial: 0 }
    const made = createRecord(db, { name: 'Ella Harrow', categoryId: 'character' }, NOW)
    if (!('record' in made)) throw new Error('blocked')
    const result = await reader.notRight(
      eyes()?.id ?? '',
      { kind: 'notAbout', recordId: made.record.id },
      'nr-5'
    )
    expect(result).toMatchObject({ ok: false, code: 'DISABLED' })
    expect(eyes()).toMatchObject({ value: 'grey' })
  })
})

describe('typed details against the text (decision 4, F-16.18)', () => {
  /** A card read from the scene as saved, its place quoted from paragraph 2. */
  const card = (
    where: string,
    quote: string,
    over: Partial<Parameters<typeof upsertCard>[1]['fields']> = {}
  ): Parameters<typeof upsertCard>[1] => {
    saveDocument(db, scene, doc("Mara's eyes were grey.", `${quote}.`))
    return {
      nodeId: scene,
      draftId: activeDraftId(db),
      readingId: null,
      line: 'Mara waits.',
      gist: 'Mara waits.',
      fields: {
        ...emptyCardFields(),
        where: { value: where, quote, p: 1, verified: true },
        ...over
      },
      present: [],
      mood: null,
      theme: null,
      anchor: cardAnchorOf(db, scene),
      seen: []
    }
  }

  it('asks once where the text disagrees, and Keep mine never asks again', () => {
    upsertCard(db, card('the quay', 'At dawn the boats went out from the quay'), NOW)
    setSceneDetails(
      db,
      scene,
      { ...emptySceneDetails(), place: { recordId: null, text: 'the harbour' } },
      NOW
    )
    const reader = service(reading())
    const conflict = reader.notices().find((notice) => notice.kind === 'detailConflict')
    expect(conflict).toEqual({
      id: `detail:${scene}:place`,
      kind: 'detailConflict',
      nodeId: scene,
      ref: '1.1',
      field: 'place',
      typed: 'the harbour',
      text: 'the quay',
      textRecordId: null,
      quote: 'At dawn the boats went out from the quay'
    })
    const after = reader.answerNotice(conflict?.id ?? '', 'keepMine')
    expect(after.some((notice) => notice.kind === 'detailConflict')).toBe(false)
    expect(listDismissed(db).items[0]).toMatchObject({
      kind: 'notProblem',
      nodeId: scene,
      label: '1.1: kept your place “the harbour” over the text’s “the quay”'
    })
    // A new value in the text is asked about again.
    upsertCard(db, card('the steps', 'At dawn the boats went out from the steps'), NOW)
    expect(reader.notices().find((notice) => notice.kind === 'detailConflict')).toMatchObject({
      text: 'the steps'
    })
  })

  it('names the place record the text names, and pushes the notices when details change', () => {
    const quay = createRecord(db, { name: 'North Quay', categoryId: 'setting' }, NOW)
    if (!('record' in quay)) throw new Error('blocked')
    upsertCard(db, card('the north quay', 'the boats went out from the north quay'), NOW)
    const reader = service(reading())
    noticeLists = []
    setSceneDetails(
      db,
      scene,
      { ...emptySceneDetails(), place: { recordId: null, text: 'the harbour' } },
      NOW
    )
    reader.detailsChanged()
    expect(noticeLists.at(-1)?.find((notice) => notice.kind === 'detailConflict')).toMatchObject({
      textRecordId: quay.record.id
    })
  })

  it('asks nothing once the quote’s sentence is edited, and nothing about a value said to be not right', () => {
    upsertCard(db, card('the quay', 'At dawn the boats went out from the quay'), NOW)
    setSceneDetails(
      db,
      scene,
      { ...emptySceneDetails(), place: { recordId: null, text: 'the harbour' } },
      NOW
    )
    const reader = service(reading())
    expect(reader.notices().some((notice) => notice.kind === 'detailConflict')).toBe(true)
    // She fixes the prose instead: the card's place no longer stands, so nothing is asked, and
    // the scene's memory shows the typed place with the card's dimmed as stale.
    saveDocument(
      db,
      scene,
      doc("Mara's eyes were grey.", 'At dawn the boats went out from the harbour.')
    )
    expect(reader.notices().some((notice) => notice.kind === 'detailConflict')).toBe(false)
    const memory = sceneMemory(db, scene)
    expect(memory.typed.place).toMatchObject({ outcome: 'typedOnly', typed: 'the harbour' })
    expect(memory.card?.stale).toEqual(['where'])
    // Back as it was: asked again; Not right on the card's place: never asked, and gone from the card.
    saveDocument(
      db,
      scene,
      doc("Mara's eyes were grey.", 'At dawn the boats went out from the quay.')
    )
    expect(reader.notices().some((notice) => notice.kind === 'detailConflict')).toBe(true)
    const row = cardNotRight(db, { nodeId: scene, field: 'where', value: 'the quay' }, NOW)
    expect(row).toMatchObject({ kind: 'notRight', label: '1.1: place “the quay”, from the card' })
    expect(reader.notices().some((notice) => notice.kind === 'detailConflict')).toBe(false)
    expect(sceneMemory(db, scene).card?.fields.where).toBeNull()
    undoDismissed(db, row.id)
    expect(sceneMemory(db, scene).card?.fields.where).toMatchObject({ value: 'the quay' })
  })

  it('keys Keep mine on a POV by its record, so a rename never asks again', () => {
    const tomas = createRecord(db, { name: 'Tomas Harrow', categoryId: 'character' }, NOW)
    if (!('record' in tomas)) throw new Error('blocked')
    const mara = rosterRecord('Mara Vell')
    upsertCard(
      db,
      card('the quay', 'At dawn the boats went out from the quay', {
        where: null,
        pov: { value: mara, quote: "Mara's eyes were grey", p: 0, verified: true }
      }),
      NOW
    )
    setSceneDetails(db, scene, { ...emptySceneDetails(), povRecordId: tomas.record.id }, NOW)
    const reader = service(reading())
    const conflict = reader.notices().find((notice) => notice.kind === 'detailConflict')
    expect(conflict).toMatchObject({ field: 'pov', text: 'Mara Vell', textRecordId: mara })
    reader.answerNotice(conflict?.id ?? '', 'keepMine')
    setAliases(db, mara, { name: { text: 'Mara Quill' }, aliases: [{ text: 'Mara' }] }, NOW)
    expect(reader.notices().some((notice) => notice.kind === 'detailConflict')).toBe(false)
  })

  it('carries the last rebuild in the status', () => {
    const reader = service(reading())
    expect(reader.status().rebuild).toBeNull()
    reader.rebuild()
    expect(reader.status().rebuild).toMatchObject({ total: 1, done: 0, finishedAt: null })
  })
})

describe('the contradiction judge on the reader’s queue (F-16.27, P4 slice 2)', () => {
  const judgeRequests = (ai: FakeAi): CompletionRequest[] =>
    ai.requests.filter((request) => request.messages[0]?.content.startsWith(JUDGE_SENTINEL))

  /** Scene 1 says grey; a second scene says brown; both read. */
  async function twoReadings(reader: ReaderService): Promise<string> {
    const second = addScene('Second', "Mara's eyes were brown.")
    for (const nodeId of [scene, second]) {
      expect(await reader.readNow(nodeId, `read-${nodeId}`)).toMatchObject({ ok: true, read: true })
    }
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    return second
  }

  it('dispatches the judge job: both orders in two calls, background spend, the scene just read first', async () => {
    const counts: unknown[] = []
    const ai = reading({ providerId: 'cloud' })
    const reader = service(ai, { findingsChanged: (each) => void counts.push(each) })
    await twoReadings(reader)
    reader.queueJudge()
    expect(reader.judging()).toBe(true)
    await drained(reader)
    expect(judgeRequests(ai)).toHaveLength(2)
    expect(findingsOf(db, activeDraftId(db)).map((each) => each.state)).toEqual(['open'])
    expect(counts.at(-1)).toEqual({ open: 1, unclear: 0, waiting: 0 })
    expect(reader.judging()).toBe(false)
    // Background spend on Cloud: the month's tally counts the judge as background.
    expect(cloud.backgroundUsd).toBeGreaterThan(0)
    // Nothing left to judge: queueing again does nothing.
    reader.queueJudge()
    expect(reader.judging()).toBe(false)
  })

  it('queues nothing with the Contradiction check off, and a held judge job never stops reading', async () => {
    settings = { ...settings, features: { ...settings.features, judge: false } }
    const ai = reading()
    const reader = service(ai)
    const second = await twoReadings(reader)
    reader.queueJudge()
    expect(reader.judging()).toBe(false)
    // A judge job left from before (the switch was on then) goes quietly; reading behind it runs.
    saveDocument(db, second, doc("Mara's eyes were green."))
    enqueueJob(db, 'judge', scene, new Date(NOW.getTime() - 60_000))
    reader.opened()
    expect(await reader.readNow(second, 'read-again')).toMatchObject({ ok: true, read: true })
    await drained(reader)
    expect(judgeRequests(ai)).toHaveLength(0)
    expect(reader.queueStatus().paused).toBeNull()
    expect(listJobs(db, 'judge')).toEqual([])
    // Switched on again: judging resumes.
    settings = { ...settings, features: { ...settings.features, judge: true } }
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    reader.settingsChanged()
    await drained(reader)
    expect(judgeRequests(ai)).toHaveLength(2)
  })

  it('never counts a judge run as a scene being read (the indicator counts scenes only)', async () => {
    const statuses: IndexQueueStatus[] = []
    const ai = reading()
    const reader = service(ai, { jobs: (status) => void statuses.push(status) })
    await twoReadings(reader)
    await drained(reader)
    statuses.length = 0
    reader.queueJudge()
    expect(reader.judging()).toBe(true)
    expect(reader.queueStatus()).toMatchObject({ queued: 0, running: null, failed: 0 })
    await drained(reader)
    expect(judgeRequests(ai)).toHaveLength(2)
    // Every status pushed while the judge ran read as an idle queue.
    expect(statuses.length).toBeGreaterThan(0)
    expect(statuses.every((status) => status.queued === 0 && status.running === null)).toBe(true)
    expect(statuses.every((status) => status.done === 0 && status.failed === 0)).toBe(true)
  })

  it('pushes the counts when the settings change, none while the Contradiction check is off', async () => {
    const counts: unknown[] = []
    const ai = reading()
    const reader = service(ai, { findingsChanged: (each) => void counts.push(each) })
    await twoReadings(reader)
    reader.queueJudge()
    await drained(reader)
    settings = { ...settings, features: { ...settings.features, judge: false } }
    reader.settingsChanged()
    expect(counts.at(-1)).toEqual({ open: 0, unclear: 0, waiting: 0 })
    settings = { ...settings, features: { ...settings.features, judge: true } }
    reader.settingsChanged()
    expect(counts.at(-1)).toEqual({ open: 1, unclear: 0, waiting: 0 })
  })

  it('never judges in the background while a rebuild runs', async () => {
    const ai = reading()
    const reader = service(ai)
    await twoReadings(reader)
    const before = ai.requests.length
    reader.rebuild()
    reader.queueJudge()
    expect(reader.judging()).toBe(false)
    await drained(reader)
    expect(getRebuild(db)?.finishedAt).not.toBeNull()
    // Background judging waited for the rebuild, and resumed once it closed: every judge request
    // came after the rebuild's last reading.
    const sent = ai.requests.slice(before)
    const lastRead = sent.map((request) => requestKind(request)).lastIndexOf('reader')
    const firstJudge = sent.findIndex((request) =>
      request.messages[0]?.content.startsWith(JUDGE_SENTINEL)
    )
    expect(lastRead).toBeGreaterThanOrEqual(0)
    expect(firstJudge).toBeGreaterThan(lastRead)
    expect(judgeRequests(ai)).toHaveLength(2)
  })
})

describe('Check the book and the rebuild sweep on the reader’s queue (F-16.27, F-16.30, P4 slice 3)', () => {
  const judgeRequests = (ai: FakeAi): CompletionRequest[] =>
    ai.requests.filter((request) => request.messages[0]?.content.startsWith(JUDGE_SENTINEL))

  it('prices the rebuild’s sweep with the switch on, sweeps once as asked, and asks for a review', async () => {
    addScene('Second', "Mara's eyes were brown.")
    const ai = reading({ providerId: 'cloud' })
    const reader = service(ai)
    const withSweep = reader.rebuildEstimate()
    settings = { ...settings, features: { ...settings.features, judge: false } }
    const without = reader.rebuildEstimate()
    expect(withSweep.requests - without.requests).toBe(2)
    expect(withSweep.costUsd).toBeGreaterThan(without.costUsd)
    settings = { ...settings, features: { ...settings.features, judge: true } }
    // Background spend is capped: the sweep is asked spend and runs past it.
    cloud = { ...cloud, capUsd: 0, backgroundUsd: 0 }
    expect(reader.rebuild()).toMatchObject({ ok: true, queued: 2 })
    await until(() => typeof getRebuild(db)?.finishedAt === 'string', 'the rebuild to finish')
    await drained(reader)
    expect(judgeRequests(ai)).toHaveLength(2)
    expect(cloud.askedUsd).toBeGreaterThan(0)
    expect(findingsOf(db, activeDraftId(db)).map((each) => each.state)).toEqual(['open'])
    // The review: the summary lists the contradiction, the notice counts it.
    const summary = reader.rebuildSummary()
    expect(summary?.findings).toEqual([
      expect.objectContaining({ rule: 'C1', name: 'Mara Vell', state: 'open' })
    ])
    const startedAt = getRebuild(db)?.startedAt ?? ''
    expect(reader.notices()).toContainEqual(
      expect.objectContaining({
        id: `rebuildDone:${startedAt}`,
        kind: 'rebuildDone',
        lines: 2,
        sheets: 1,
        findings: 1
      })
    )
    // Not a problem for them all: one Dismissed row, the finding closed.
    expect(reader.rebuildAction({ action: 'notProblems' })).toEqual({ changed: 1 })
    expect(findingsOf(db, activeDraftId(db), ['open'])).toEqual([])
    expect(listDismissed(db).items.map((row) => row.kind)).toEqual(['notProblem'])
    // Done: never shown again for this rebuild.
    reader.answerNotice(`rebuildDone:${startedAt}`, 'dismiss')
    expect(reader.notices().some((notice) => notice.kind === 'rebuildDone')).toBe(false)
  })

  it('lists and dismisses only what the rebuild’s sweep opened, never a later finding', async () => {
    addScene('Second', "Mara's eyes were brown.")
    const ai = reading()
    const reader = service(ai)
    expect(reader.rebuild()).toMatchObject({ ok: true, queued: 2 })
    await until(() => typeof getRebuild(db)?.finishedAt === 'string', 'the rebuild to finish')
    await drained(reader)
    const startedAt = getRebuild(db)?.startedAt ?? ''
    expect(reader.rebuildSummary()?.findings).toHaveLength(1)
    // Later writing opens another possible contradiction while the review is still due.
    const third = addScene('Third', "Mara's eyes were green.")
    await reader.readNow(third, 'read-third')
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    reader.queueJudge()
    await drained(reader)
    const open = findingsOf(db, activeDraftId(db), ['open'])
    expect(open.length).toBeGreaterThan(1)
    expect(reader.rebuildSummary()?.findings).toHaveLength(1)
    expect(reader.notices()).toContainEqual(
      expect.objectContaining({ id: `rebuildDone:${startedAt}`, findings: 1 })
    )
    // Not a problem for them all: the rebuild's one; the later one stays open.
    expect(reader.rebuildAction({ action: 'notProblems' })).toEqual({ changed: 1 })
    expect(findingsOf(db, activeDraftId(db), ['open'])).toHaveLength(open.length - 1)
    expect(reader.rebuildSummary()?.findings).toEqual([])
  })

  it('says how many pairs wait for Check the book once the day’s background limit is reached', async () => {
    const ai = reading()
    const reader = service(ai)
    const second = addScene('Second', "Mara's eyes were brown.")
    for (const nodeId of [scene, second]) await reader.readNow(nodeId, `read-${nodeId}`)
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    expect(reader.notices().some((notice) => notice.kind === 'findingsWaiting')).toBe(false)
    writeRow(db, MEMORY_JUDGE_DAY_KEY, { day: '2026-10-12', pairs: JUDGE_DAY_PAIRS })
    const waiting = reader.notices().find((notice) => notice.kind === 'findingsWaiting')
    expect(waiting).toMatchObject({ pairs: 1, id: 'findingsWaiting:2026-10-12' })
    expect(waiting?.kind === 'findingsWaiting' ? waiting.priceUsd : 0).toBeGreaterThan(0)
    reader.answerNotice('findingsWaiting:2026-10-12', 'dismiss')
    expect(reader.notices().some((notice) => notice.kind === 'findingsWaiting')).toBe(false)
  })

  it('asks once whether to show contradictions in the panel only, and counts precision (F-16.28)', () => {
    const reader = service(reading())
    writeRow(db, MEMORY_UNDERLINES_KEY, {
      outcomes: [...Array<string>(12).fill('right'), ...Array<string>(8).fill('notProblem')],
      asked: false
    })
    expect(reader.notices()).toContainEqual({
      id: 'underlinePrecision',
      kind: 'underlinePrecision',
      counted: 20,
      notProblems: 8
    })
    expect(reader.health().contradictions).toEqual({
      pairs: 0,
      agreed: 0,
      underlines: { counted: 20, right: 12 }
    })
    // Already in the panel only: not asked.
    settings = { ...settings, reading: { ...settings.reading, underlines: 'panel' } }
    expect(reader.notices().some((notice) => notice.kind === 'underlinePrecision')).toBe(false)
    settings = { ...settings, reading: { ...settings.reading, underlines: 'text' } }
    // Answered (either way): never asked again.
    reader.answerNotice('underlinePrecision', 'keepUnderlines')
    expect(reader.notices().some((notice) => notice.kind === 'underlinePrecision')).toBe(false)
    expect(getUnderlineLog(db).asked).toBe(true)
  })

  it('runs Check the book as one asked job, with its price, progress and report', async () => {
    const ai = reading()
    const reader = service(ai)
    const second = addScene('Second', "Mara's eyes were brown.")
    for (const nodeId of [scene, second]) await reader.readNow(nodeId, `read-${nodeId}`)
    settings = { ...settings, features: { ...settings.features, judge: false } }
    expect(reader.checkBook(second)).toMatchObject({ ok: false, code: 'DISABLED' })
    settings = { ...settings, features: { ...settings.features, judge: true } }
    expect(reader.checkEstimate()).toMatchObject({ free: false, pairs: 1, fastCalls: 2 })
    expect(reader.checkBook(second)).toMatchObject({ ok: true, estimate: { pairs: 1 } })
    await drained(reader)
    // Both orders, then the stronger check (the fake judges call it a contradiction too).
    expect(judgeRequests(ai)).toHaveLength(3)
    expect(reader.checkReport()?.found).toEqual([
      expect.objectContaining({ rule: 'C1', confirmed: true })
    ])
    expect(reader.status().check).toMatchObject({ judged: 1, confirmed: 1 })
    expect(reader.status().check?.finishedAt).not.toBeNull()
    // Unchanged: free, and a second check sends nothing.
    expect(reader.checkEstimate().free).toBe(true)
    expect(reader.checkBook(second)).toMatchObject({ ok: true })
    await drained(reader)
    expect(judgeRequests(ai)).toHaveLength(3)
  })
})
