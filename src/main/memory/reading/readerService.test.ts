import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { MemoryNotice, MemoryStatus } from '@shared/memory/views'
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
import { createRecord } from '../recordStore'
import { sceneClaims } from './claimStore'
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
import { getRebuild, getSpotState, setSpotState } from './readerRows'
import { createReaderService, type ReaderService, type ReaderServiceDeps } from './readerService'
import { emptyYields } from '@shared/memory/claims'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string
let chapter: string
let settings: AiSettings
let cloud: MemoryCloudState
let changed: { nodeIds: string[]; recordIds: string[] }[]
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
  throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(services.map((each) => each.queueStatus()))} ${JSON.stringify(listJobs(db))}`)
}

/** Waits for the queue to finish everything it can run. */
async function drained(reader: ReaderService): Promise<void> {
  await until(() => {
    const status = reader.queueStatus()
    return status.running === null && (status.queued === 0 || status.paused !== null)
  }, 'the reader queue')
  await new Promise((resolve) => setTimeout(resolve, 5))
}

/** The fake reader's answer: Mara's eyes in every paragraph that states them; the checker passes all. */
function answerReading(request: CompletionRequest): { text: string } {
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

describe('the health gate (F-16.17, design §2.3)', () => {
  /** Ten readings by the fake's model, with few of their quotes found. */
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
    const answers = scenes.map((id) => reader.settle({ nodeId: id, reason: 'leave', caretPara: null }))
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
    const long = (n: number): string => `${'The boats went out at dawn and came back late. '.repeat(220)}${n}.`
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
    expect(await reader.readNow(scene, 'read-part')).toMatchObject({ ok: false, code: 'RATE_LIMIT' })
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
    expect(summary?.sheets).toEqual([
      expect.objectContaining({ name: 'Mara Vell', lines: 2 })
    ])
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
