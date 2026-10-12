import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sceneSentences } from '@shared/memory/anchor'
import type { Claim } from '@shared/memory/claims'
import { dismissedKey } from '@shared/memory/dismissed'
import { gateText } from '@shared/memory/gate'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetInflight } from '../../ai/inflight'
import type { CompletionRequest } from '../../ai/providers/types'
import { saveDocument } from '../../document/documentStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { dismiss } from '../dismissedStore'
import { invariantIndexed, nameScanShared, scanNamesFor } from '../nameIndexer'
import { resetNameQuestionCache } from '../questions'
import { createRecord, getRecord, invariantAliases, listRecords } from '../recordStore'
import { setSceneDetails } from '../sceneDetailStore'
import { runAnchors } from './anchors'
import { sceneTexts } from './claimFixture'
import { invariantClaims, invariantKnows, sceneClaims } from './claimStore'
import { runReading, type ReadingOutcome } from './pipeline'
import { lastReading } from './readingStore'
import {
  fakeAi,
  requestKind,
  rosterIds,
  sentChecks,
  topicIds,
  type FakeAi,
  type SentCheck
} from './readingFixture'
import { notAbout, wrongValue } from './notRight'
import { getSceneRead } from './sceneReadStore'
import { markRebuilt, runSpotChecks } from './spotChecks'
import { invariantTopics, listTopics, recordTopicQuotes, sceneTopicQuotes } from './topicStore'

/**
 * Who knows what and plot threads in the reading pipeline (F-16.22, F-16.23; plan P2b §2.4,
 * §2.6): knows lines with their how and source, the learner Here rule, group learners, secrets and
 * threads made silently from a verified reveal, merges judged the same, the page caps, Dismissed
 * reveals, restated reveals, thread steps, the read flags and pruning.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let one: string
let two: string
let mara: string
let orrin: string
let tomas: string
let regiment: string

const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function record(name: string, aliases: string[] = [], categoryId = 'character'): string {
  const made = createRecord(
    db,
    { name, categoryId, aliases: aliases.map((text) => ({ text })), force: true },
    NOW
  )
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

const SCENE_ONE = [
  'Tomas sold the map on the quay.',
  'Orrin overheard Tomas from behind the nets.',
  'Mara swore to find the heir.'
]

beforeEach(() => {
  resetInflight()
  resetNameQuestionCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-knows-'))
  session = createProject(projectFolderFor(tmp, 'Knows'), 'Knows', 'novel')
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  const chapter = getNode(db, one)?.parentId ?? ''
  two = createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Two'
  }).id
  saveDocument(db, one, doc(...SCENE_ONE))
  mara = record('Mara Vell', ['Mara'])
  orrin = record('Orrin')
  tomas = record('Tomas')
  regiment = record('the regiment', [], 'faction')
  scanNamesFor(db, one, NOW)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A planned line of the fake reader: names and labels, mapped to the request's ids. */
interface Line {
  p: number
  /** The learner's name (a knows line), or the thread's label or new id (a step). */
  r: string
  s: 'knows' | 'thread' | 'eyes'
  /** A knows line's secret: a listed label or a new id ("x1"). */
  o?: string
  how?: string
  /** A knows line's source, by name. */
  fr?: string
  v?: string
  q: string
  voice?: string
  sp?: string
  mode?: string
}

interface NewTopic {
  n?: string
  kind: 'secret' | 'thread'
  id: string
  p: number
  q: string
}

/** The fake reader's reply for a plan, its ids mapped through the request's rosters. */
function readerReply(
  request: CompletionRequest,
  plan: {
    lines: readonly Line[]
    topics?: readonly NewTopic[]
    present?: readonly string[]
    /** The card's POV: a name and its line's paragraph and quote. */
    pov?: { name: string; p: number; q: string }
  }
): string {
  const ids = rosterIds(request)
  const topics = topicIds(request)
  const idOf = (name: string): string => ids.get(name) ?? topics.get(name) ?? name
  const sent = new Set(
    [...(request.messages.at(-1)?.content ?? '').matchAll(/^¶(\d+) /gm)].map((m) => Number(m[1]))
  )
  const c = plan.lines
    .filter((line) => sent.has(line.p))
    .map((line) => ({
      p: line.p,
      r: idOf(line.r),
      s: line.s,
      ...(line.o === undefined ? {} : { o: idOf(line.o) }),
      ...(line.how === undefined ? {} : { how: line.how }),
      ...(line.fr === undefined ? {} : { fr: idOf(line.fr) }),
      ...(line.v === undefined ? {} : { v: line.v }),
      q: line.q,
      voice: line.voice ?? 'narration',
      sp: line.sp === undefined ? null : idOf(line.sp),
      mode: line.mode ?? 'now'
    }))
  const n = (plan.topics ?? [])
    .filter((topic) => sent.has(topic.p))
    .map((topic) => ({ ...topic, ...(topic.n === undefined ? {} : { n: topic.n }) }))
  const card = request.messages.at(-1)?.content.endsWith('Card: yes') === true
  const present = (plan.present ?? []).flatMap((name) => {
    const line = plan.lines.find((each) => each.r === name && sent.has(each.p))
    return line === undefined ? [] : [[idOf(name), line.p, line.q]]
  })
  return JSON.stringify({
    c,
    n,
    same: [],
    drop: [],
    ...(card
      ? {
          card: {
            line: 'Tomas sells the map.',
            gist: 'Tomas sells the map and Orrin hears it.',
            where: null,
            when: null,
            year: null,
            elapsed: null,
            pov: plan.pov === undefined ? null : [idOf(plan.pov.name), plan.pov.p, plan.pov.q],
            flash: null,
            present,
            mood: null,
            theme: null
          }
        }
      : {})
  })
}

/** How the fake checker reads a knows or step item's fact ("knows, overheard from r2 (…)"). */
const howOf = (check: SentCheck): string | null =>
  /^knows, (\w+)/.exec(check.fact)?.[1] ??
  /^(opens|advances|resolves):/.exec(check.fact)?.[1] ??
  null

/**
 * The fake checker: every item supported, about its first candidate, as narration now; a knows
 * item echoes its how and its first source; a step its step; `answer` may change any verdict.
 */
function verifyReply(
  request: CompletionRequest,
  answer: (check: SentCheck) => Record<string, unknown> | null = () => null
): string {
  return JSON.stringify({
    v: sentChecks(request).map((check) => ({
      i: check.i,
      ok: true,
      r: check.who[0] ?? null,
      voice: 'narration',
      mode: 'now',
      ...(check.kind === 'knows' || check.kind === 'step' ? { how: howOf(check) } : {}),
      ...(check.kind === 'knows' ? { fr: check.from[0] ?? null } : {}),
      ...(answer(check) ?? {})
    }))
  })
}

/** A fake that reads `plan` and checks as `answer` says. */
function fake(
  plan: Parameters<typeof readerReply>[1],
  answer?: (check: SentCheck) => Record<string, unknown> | null
): FakeAi {
  return fakeAi((request) =>
    requestKind(request) === 'verify'
      ? { text: verifyReply(request, answer) }
      : { text: readerReply(request, plan) }
  )
}

const read = (ai: FakeAi, nodeId = one): Promise<ReadingOutcome> =>
  runReading(db, { ai: ai.deps }, { nodeId, caretPara: null, requestId: `r-${nodeId}` })

const claimsOf = (nodeId = one): Claim[] => sceneClaims(db, nodeId, activeDraftId(db))
const knowsOf = (nodeId = one): [string | null, string | null, string | null, string | null][] =>
  claimsOf(nodeId)
    .filter((claim) => claim.slot === 'knows')
    .map((claim) => [claim.recordId, claim.objectId, claim.how, claim.fromId])

const checksOf = (ai: FakeAi): SentCheck[] =>
  ai.requests.filter((request) => requestKind(request) === 'verify').flatMap(sentChecks)

function invariants(): ReturnType<typeof checkMemoryInvariants> {
  const scenes = new Map(
    manuscriptDocuments(db).map((row) => [
      row.id,
      new Set(sceneSentences(sceneTexts(db, row.id)).map((sentence) => sentence.hash))
    ])
  )
  return checkMemoryInvariants({
    claims: invariantClaims(db),
    sceneHashes: scenes,
    aliases: invariantAliases(db),
    citations: [],
    knows: invariantKnows(db),
    topics: invariantTopics(db),
    indexed: invariantIndexed(db)
  })
}

/** Scene one's plan: Tomas sold the map (a new secret), Orrin overheard him, a thread opens. */
const SCENE_ONE_PLAN = {
  topics: [
    { n: 'the sold map', kind: 'secret', id: 'x1', p: 0, q: 'Tomas sold the map' },
    { n: 'the missing heir', kind: 'thread', id: 'x2', p: 2, q: 'Mara swore to find the heir' }
  ] satisfies NewTopic[],
  lines: [
    { p: 0, r: 'Tomas', s: 'knows', o: 'x1', how: 'knewBefore', q: 'Tomas sold the map' },
    {
      p: 1,
      r: 'Orrin',
      s: 'knows',
      o: 'x1',
      how: 'overheard',
      fr: 'Tomas',
      q: 'Orrin overheard Tomas from behind the nets'
    },
    {
      p: 2,
      r: 'x2',
      s: 'thread',
      how: 'opens',
      v: 'Mara swears to find the heir',
      q: 'Mara swore to find the heir'
    }
  ] satisfies Line[],
  present: ['Tomas', 'Orrin']
}

const topicNamed = (label: string): string =>
  listTopics(db).find((topic) => topic.label === label)?.recordId ?? ''

describe('runReading: who knows what and threads (F-16.22, F-16.23)', () => {
  it('stores knows lines with their how and source, and makes the secret and thread silently', async () => {
    const ai = fake(SCENE_ONE_PLAN)
    const outcome = await read(ai)
    const map = topicNamed('the sold map')
    const heir = topicNamed('the missing heir')
    // Made in one reading, at one instant: listed by id among themselves.
    expect(
      listTopics(db)
        .map((topic) => [topic.label, topic.kind, topic.origin])
        .sort()
    ).toEqual([
      ['the missing heir', 'thread', 'ai'],
      ['the sold map', 'secret', 'ai']
    ])
    expect(knowsOf()).toEqual([
      [tomas, map, 'knewBefore', null],
      [orrin, map, 'overheard', tomas]
    ])
    const step = claimsOf().find((claim) => claim.slot === 'thread')
    expect(step).toMatchObject({
      recordId: heir,
      how: 'opens',
      value: 'Mara swears to find the heir',
      proof: 'verified',
      topicQuoteId: null
    })
    // Each with its defining reveal, anchored like a claim.
    expect(
      recordTopicQuotes(db, map).map((quote) => [quote.role, quote.quote, quote.para])
    ).toEqual([['defining', 'Tomas sold the map', 0]])
    expect(recordTopicQuotes(db, heir)[0]?.role).toBe('defining')
    // The checker saw a knows item with its source candidates and a Reveals item per topic.
    const checks = checksOf(ai)
    const orrinCheck = checks.find((check) => check.kind === 'knows' && check.names[0] === 'Orrin')
    expect(orrinCheck?.topic).toBe('x1 the sold map: “Tomas sold the map”')
    expect(orrinCheck?.from.length).toBeGreaterThan(0)
    expect(checks.filter((check) => check.kind === 'reveals').map((check) => check.topic)).toEqual([
      'x1 the sold map · new secret',
      'x2 the missing heir · new thread'
    ])
    expect(checks.some((check) => check.kind === 'same')).toBe(false)
    // Not names: no mention, and the reading names them for record:changed.
    expect(nameScanShared(db).index.kinds.has(map)).toBe(false)
    expect(outcome).toMatchObject({ read: true, topicIds: [map, heir].sort() })
    if (outcome.read) expect(outcome.recordIds).toEqual(expect.arrayContaining([tomas, orrin, map]))
    expect(lastReading(db, one, activeDraftId(db))).toMatchObject({
      promptVersion: 'reader.v2',
      verifyVersion: 'verify.v2'
    })
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({
      topicsCreated: 2
    })
    // P2b-D9: a topic reader read it whole and nothing finished is left unread.
    expect(getSceneRead(db, one, activeDraftId(db))).toMatchObject({
      topicsRead: true,
      settled: true
    })
    expect(invariants()).toEqual([])
  })

  it('lists the topics after the record roster from then on, and never sends an absence', async () => {
    await read(fake(SCENE_ONE_PLAN))
    saveDocument(db, two, doc('The map had been sold by Tomas.'))
    scanNamesFor(db, two, NOW)
    const ai = fake({ lines: [] })
    await read(ai, two)
    const system = ai.requests[0]?.messages[0]?.content ?? ''
    const records = system.indexOf('Roster (id name')
    const topics = system.indexOf('Secrets and threads (id label · kind):')
    expect(topics).toBeGreaterThan(records)
    expect(system).toMatch(/^s1 the sold map · secret$/m)
    expect(system).toMatch(/^t1 the missing heir · thread$/m)
    // The window names the map: its topic line says who holds it, never who does not.
    const user = ai.requests[0]?.messages.at(-1)?.content ?? ''
    expect(user).toContain('Secrets and threads here:')
    expect(user).toMatch(
      /s1 the sold map: r\d+ knew before 1\.1; r\d+ overheard 1\.1 \(from r\d+\)/
    )
    for (const request of ai.requests) {
      expect(JSON.stringify(request.messages)).not.toMatch(/No scene shows|checked up to/)
    }
  })

  it('refuses a learner who is not Here, and keeps one an on-page check shows', async () => {
    // Nobody is on the card: Tomas's and Orrin's lines each need an on-page check.
    const plan = { ...SCENE_ONE_PLAN, present: [] }
    const refused = fake(plan, (check) =>
      check.kind === 'present' && check.names[0] === 'Orrin' ? { ok: false } : null
    )
    await read(refused)
    const onPage = checksOf(refused).filter((check) => check.kind === 'present')
    expect(onPage.map((check) => check.names[0]).sort()).toEqual(['Orrin', 'Tomas'])
    const map = topicNamed('the sold map')
    expect(knowsOf()).toEqual([[tomas, map, 'knewBefore', null]])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toMatchObject({
      notHere: 1
    })
    // Tomas, shown on the page by the check, joins the card's on-page list.
    expect(
      (await import('./cardStore'))
        .getCard(db, one, activeDraftId(db))
        ?.present.map((entry) => entry.recordId)
    ).toEqual([tomas])
    expect(invariants()).toEqual([])
  })

  it('takes the typed POV as Here, with no on-page check', async () => {
    setSceneDetails(
      db,
      one,
      {
        povRecordId: orrin,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: null,
        alsoHere: [tomas]
      },
      NOW
    )
    const ai = fake({ ...SCENE_ONE_PLAN, present: [] })
    await read(ai)
    expect(checksOf(ai).some((check) => check.kind === 'present')).toBe(false)
    expect(knowsOf().map((line) => line[0])).toEqual([tomas, orrin])
  })

  it('takes a first-person learner as the typed POV once the text’s POV agrees', async () => {
    saveDocument(db, one, doc('Tomas sold the map on the quay.', 'I watched him from the stair.'))
    scanNamesFor(db, one, NOW)
    setSceneDetails(
      db,
      one,
      {
        povRecordId: mara,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: null,
        alsoHere: []
      },
      NOW
    )
    const line: Line = {
      p: 1,
      r: 'Mara Vell',
      s: 'knows',
      o: 'x1',
      how: 'saw',
      q: 'I watched him from the stair'
    }
    const topics: NewTopic[] = [
      { n: 'the sold map', kind: 'secret', id: 'x1', p: 0, q: 'Tomas sold the map' }
    ]
    // No POV on the card: first person is nobody's.
    await read(fake({ topics, lines: [line] }))
    expect(knowsOf()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toMatchObject({
      subject: 1
    })
    // The text's POV, verified, agrees: the line is Mara's, and the POV is Here.
    saveDocument(
      db,
      one,
      doc('Tomas sold the map on the quay.', 'I watched him from the stair, and I knew.')
    )
    const ai = fake({
      topics: [],
      lines: [{ ...line, o: 'the sold map', q: 'I watched him from the stair' }],
      pov: { name: 'Mara Vell', p: 1, q: 'I watched him from the stair' }
    })
    await runReading(
      db,
      { ai: ai.deps },
      { nodeId: one, caretPara: null, requestId: 'r-pov', purpose: 'rebuild' }
    )
    expect(knowsOf().map((each) => [each[0], each[2]])).toEqual([[mara, 'saw']])
    expect(checksOf(ai).some((check) => check.kind === 'present')).toBe(false)
  })

  it('lets a group know only where its sentence names it', async () => {
    saveDocument(
      db,
      one,
      doc(
        'Tomas sold the map on the quay.',
        'By Sunday the regiment knew of the sale.',
        'They talked of nothing else.'
      )
    )
    scanNamesFor(db, one, NOW)
    const ai = fake({
      topics: [{ n: 'the sold map', kind: 'secret', id: 'x1', p: 0, q: 'Tomas sold the map' }],
      lines: [
        {
          p: 1,
          r: 'the regiment',
          s: 'knows',
          o: 'x1',
          how: 'told',
          q: 'the regiment knew of the sale'
        },
        {
          p: 2,
          r: 'the regiment',
          s: 'knows',
          o: 'x1',
          how: 'told',
          q: 'They talked of nothing else'
        }
      ]
    })
    await read(ai)
    expect(knowsOf().map((line) => [line[0], line[2]])).toEqual([[regiment, 'told']])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toMatchObject({ group: 1 })
    // A group needs no on-page check.
    expect(checksOf(ai).some((check) => check.kind === 'present')).toBe(false)
  })

  it('drops a new topic whose reveal the checker does not find, with its facts', async () => {
    const ai = fake(SCENE_ONE_PLAN, (check) =>
      check.kind === 'reveals' && check.topic.startsWith('x1') ? { ok: false } : null
    )
    await read(ai)
    expect(listTopics(db).map((topic) => topic.label)).toEqual(['the missing heir'])
    expect(knowsOf()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toMatchObject({
      topic: 3,
      topicsCreated: 1
    })
    expect(invariants()).toEqual([])
  })

  it('makes a secret readers know with no learner: the verified reveal backs it', async () => {
    const ai = fake({
      topics: [{ n: 'the sold map', kind: 'secret', id: 'x1', p: 0, q: 'Tomas sold the map' }],
      lines: []
    })
    await read(ai)
    expect(listTopics(db).map((topic) => topic.label)).toEqual(['the sold map'])
    expect(claimsOf()).toEqual([])
    expect(invariants()).toEqual([])
  })

  it('merges a new secret the checker judges the same as an open one, its facts tagged', async () => {
    await read(fake(SCENE_ONE_PLAN))
    const map = topicNamed('the sold map')
    saveDocument(db, two, doc('The map had been sold by Tomas, and Mara knew it.'))
    scanNamesFor(db, two, NOW)
    const plan = {
      topics: [
        { n: 'the map sale', kind: 'secret', id: 'x1', p: 0, q: 'The map had been sold by Tomas' }
      ] satisfies NewTopic[],
      lines: [
        { p: 0, r: 'Mara Vell', s: 'knows', o: 'x1', how: 'saw', q: 'Mara knew it' }
      ] satisfies Line[],
      present: ['Mara Vell']
    }
    const ai = fake(plan)
    const outcome = await read(ai, two)
    const same = checksOf(ai).filter((check) => check.kind === 'same')
    expect(same.map((check) => check.topic)).toEqual([
      'x1 the map sale: “The map had been sold by Tomas” (1.2) | s1 the sold map: “Tomas sold the map” (1.1)'
    ])
    // No new record: a merged reveal on the sold map, the knows line on it, tagged.
    expect(
      listTopics(db)
        .map((topic) => topic.label)
        .sort()
    ).toEqual(['the missing heir', 'the sold map'])
    const merged = recordTopicQuotes(db, map).find((quote) => quote.role === 'merged')
    expect(merged).toMatchObject({ label: 'the map sale', nodeId: two })
    expect(claimsOf(two).find((claim) => claim.slot === 'knows')).toMatchObject({
      recordId: mara,
      objectId: map,
      topicQuoteId: merged?.id
    })
    expect(outcome).toMatchObject({ topicIds: [map] })
    expect(lastReading(db, two, activeDraftId(db))?.yields.rejections).toMatchObject({
      topicsMerged: 1
    })
    expect(invariants()).toEqual([])
  })

  it('makes a second topic when the checker says they are not the same', async () => {
    await read(fake(SCENE_ONE_PLAN))
    saveDocument(db, two, doc('The map had been sold by Tomas.'))
    scanNamesFor(db, two, NOW)
    const ai = fake(
      {
        topics: [
          { n: 'the map sale', kind: 'secret', id: 'x1', p: 0, q: 'The map had been sold by Tomas' }
        ],
        lines: []
      },
      (check) => (check.kind === 'same' ? { ok: false } : null)
    )
    await read(ai, two)
    expect(
      listTopics(db, 'secret')
        .map((topic) => topic.label)
        .sort()
    ).toEqual(['the map sale', 'the sold map'])
  })

  it('never compares a new secret with a thread, nor one that shares nothing', async () => {
    await read(fake(SCENE_ONE_PLAN))
    saveDocument(db, two, doc('Orrin kept a ledger of debts.'))
    scanNamesFor(db, two, NOW)
    const ai = fake({
      topics: [
        {
          n: 'the hidden ledger',
          kind: 'secret',
          id: 'x1',
          p: 0,
          q: 'Orrin kept a ledger of debts'
        }
      ],
      lines: []
    })
    await read(ai, two)
    expect(checksOf(ai).some((check) => check.kind === 'same')).toBe(false)
  })

  it('caps new topics at 3 secrets and 2 threads a page, and folds two with one label', async () => {
    saveDocument(
      db,
      one,
      doc(
        'Tomas sold the map.',
        'Orrin stole the key.',
        'Mara burned the letter.',
        'Tomas hid the knife.',
        'Mara swore to find the heir.',
        'Orrin vowed to reach the coast.',
        'Tomas promised to return.'
      )
    )
    scanNamesFor(db, one, NOW)
    const topics: NewTopic[] = [
      { n: 'the sold map', kind: 'secret', id: 'x1', p: 0, q: 'Tomas sold the map' },
      { n: 'The sold map', kind: 'secret', id: 'x9', p: 0, q: 'Tomas sold the map' },
      { n: 'the stolen key', kind: 'secret', id: 'x2', p: 1, q: 'Orrin stole the key' },
      { n: 'the burned letter', kind: 'secret', id: 'x3', p: 2, q: 'Mara burned the letter' },
      { n: 'the hidden knife', kind: 'secret', id: 'x4', p: 3, q: 'Tomas hid the knife' },
      { n: 'the missing heir', kind: 'thread', id: 'x5', p: 4, q: 'Mara swore to find the heir' },
      { n: 'the coast', kind: 'thread', id: 'x6', p: 5, q: 'Orrin vowed to reach the coast' },
      { n: 'his return', kind: 'thread', id: 'x7', p: 6, q: 'Tomas promised to return' }
    ]
    await read(fake({ topics, lines: [] }))
    expect(
      listTopics(db, 'secret')
        .map((topic) => topic.label)
        .sort()
    ).toEqual(['the burned letter', 'the sold map', 'the stolen key'])
    expect(
      listTopics(db, 'thread')
        .map((topic) => topic.label)
        .sort()
    ).toEqual(['the coast', 'the missing heir'])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toMatchObject({
      topicCap: 2,
      topicsCreated: 5
    })
  })

  it('drops silently a new topic on a reveal the author said is no secret', async () => {
    const shared = nameScanShared(db)
    dismiss(
      db,
      {
        kind: 'notRight',
        key: dismissedKey({
          kind: 'notRight',
          topic: {
            kind: 'secret',
            stating: [gateText('Tomas sold the map on the quay.', shared.index)]
          }
        }),
        recordId: null,
        label: 'the sold map is no secret',
        quote: 'Tomas sold the map'
      },
      NOW
    )
    const ai = fake(SCENE_ONE_PLAN)
    await read(ai)
    expect(listTopics(db).map((topic) => topic.label)).toEqual(['the missing heir'])
    expect(knowsOf()).toEqual([])
    expect(checksOf(ai).some((check) => check.kind === 'knows')).toBe(false)
    const rejections = lastReading(db, one, activeDraftId(db))?.yields.rejections ?? {}
    expect(rejections.topic).toBeUndefined()
    expect(rejections.dismissed).toBeUndefined()
  })

  it('refuses a step on a secret’s id, and a knows line on a thread’s', async () => {
    await read(fake(SCENE_ONE_PLAN))
    saveDocument(db, two, doc('Tomas told Orrin of the map.'))
    scanNamesFor(db, two, NOW)
    const ai = fake({
      lines: [
        {
          p: 0,
          r: 'the sold map',
          s: 'thread',
          how: 'advances',
          v: 'told',
          q: 'Tomas told Orrin of the map'
        },
        {
          p: 0,
          r: 'Orrin',
          s: 'knows',
          o: 'the missing heir',
          how: 'told',
          q: 'Tomas told Orrin of the map'
        }
      ]
    })
    await read(ai, two)
    expect(claimsOf(two)).toEqual([])
    expect(lastReading(db, two, activeDraftId(db))?.yields.rejections).toEqual({ record: 2 })
  })

  it('opens a thread in one reading and resolves it in the next', async () => {
    await read(fake(SCENE_ONE_PLAN))
    const heir = topicNamed('the missing heir')
    saveDocument(db, two, doc('Mara found the heir in the boathouse.'))
    scanNamesFor(db, two, NOW)
    const ai = fake({
      lines: [
        {
          p: 0,
          r: 'the missing heir',
          s: 'thread',
          how: 'resolves',
          v: 'Mara finds the heir',
          q: 'Mara found the heir in the boathouse'
        }
      ]
    })
    await read(ai, two)
    const step = checksOf(ai).find((check) => check.kind === 'step')
    expect(step?.topic).toBe('t1 the missing heir: “Mara swore to find the heir”')
    expect(
      [...claimsOf(), ...claimsOf(two)]
        .filter((claim) => claim.slot === 'thread')
        .map((claim) => [claim.recordId, claim.how])
    ).toEqual([
      [heir, 'opens'],
      [heir, 'resolves']
    ])
  })

  it('revives a re-checking reveal the reader states again, and drops one it does not', async () => {
    await read(fake(SCENE_ONE_PLAN))
    const map = topicNamed('the sold map')
    // An edit to the reveal's sentence makes it re-checking.
    saveDocument(db, one, doc('Tomas sold the map on the old quay.', ...SCENE_ONE.slice(1)))
    runAnchors(db, one, NOW)
    expect(sceneTopicQuotes(db, one, activeDraftId(db))[0]?.state).toBe('stale')
    const restating = fake({
      topics: [{ kind: 'secret', id: 's1', p: 0, q: 'Tomas sold the map on the old quay' }],
      lines: SCENE_ONE_PLAN.lines.slice(0, 1).map((line) => ({ ...line, o: 'the sold map' })),
      present: ['Tomas']
    })
    const outcome = await read(restating)
    const reveals = checksOf(restating).filter((check) => check.kind === 'reveals')
    expect(reveals.map((check) => check.topic)).toEqual(['s1 the sold map · secret'])
    expect(restating.requests[0]?.messages.at(-1)?.content).toContain(
      's1 revealed “Tomas sold the map” ¶0, re-checking'
    )
    expect(recordTopicQuotes(db, map).map((quote) => [quote.state, quote.quote])).toEqual([
      ['live', 'Tomas sold the map on the old quay']
    ])
    expect(outcome).toMatchObject({ read: true })
    // Edited again and read without restating it: the reveal goes; Orrin's line keeps the topic.
    saveDocument(db, one, doc('Tomas sold the chart on the quay.', ...SCENE_ONE.slice(1)))
    runAnchors(db, one, NOW)
    await read(
      fake({
        lines: [{ ...SCENE_ONE_PLAN.lines[1], o: 'the sold map' } as Line],
        present: ['Orrin']
      })
    )
    expect(recordTopicQuotes(db, map)).toEqual([])
    expect(getRecord(db, map)).not.toBeNull()
    expect(knowsOf()).toEqual([[orrin, map, 'overheard', tomas]])
    expect(invariants()).toEqual([])
  })

  it('prunes an AI-made topic once a rebuild leaves nothing behind it', async () => {
    await read(fake(SCENE_ONE_PLAN))
    const map = topicNamed('the sold map')
    const outcome = await runReading(
      db,
      { ai: fake({ lines: [] }).deps },
      { nodeId: one, caretPara: null, requestId: 'r-rebuild', purpose: 'rebuild' }
    )
    // The knows lines go with a rebuild that does not state them; the reveal stands on its text.
    expect(knowsOf()).toEqual([])
    expect(getRecord(db, map)).not.toBeNull()
    expect(outcome.read).toBe(true)
    // Its sentence rewritten and read again with nothing about it: the topic goes.
    saveDocument(db, one, doc('Tomas walked on the quay.', ...SCENE_ONE.slice(1)))
    runAnchors(db, one, NOW)
    const last = await read(fake({ lines: [] }))
    expect(getRecord(db, map)).toBeNull()
    expect(last).toMatchObject({ read: true })
    if (last.read) expect(last.topicIds).toContain(map)
    expect(invariants()).toEqual([])
  })

  it('marks a scene settled when the gate finds nothing new, and a window read keeps topics_read', async () => {
    await read(fake(SCENE_ONE_PLAN))
    expect(await read(fake({ lines: [] }))).toMatchObject({ read: false, reason: 'upToDate' })
    expect(getSceneRead(db, one, activeDraftId(db))?.settled).toBe(true)
    saveDocument(db, one, doc(...SCENE_ONE, 'Orrin said nothing.'))
    const outcome = await read(fake({ lines: [] }))
    expect(outcome).toMatchObject({ read: true, purpose: 'window' })
    expect(getSceneRead(db, one, activeDraftId(db))).toMatchObject({
      topicsRead: true,
      settled: true
    })
  })

  it('counts the reading’s topic items for the health gate like any other', async () => {
    await read(fake(SCENE_ONE_PLAN))
    const yields = lastReading(db, one, activeDraftId(db))?.yields
    // Three lines and two topics proposed, all found; the checker passed all five.
    expect(yields).toMatchObject({ items: 5, quotesFound: 5, verifySent: 5, verified: 5 })
    expect(listRecords(db).filter((each) => each.kind === 'secret')).toHaveLength(1)
  })

  it('spot-checks a knows line as a knows item, and the strong model must agree on its how', async () => {
    await read(fake(SCENE_ONE_PLAN))
    markRebuilt(db, NOW)
    const ai = fakeAi((request) => ({
      text: verifyReply(request, (check) =>
        check.kind === 'knows' && check.names[0] === 'Orrin' ? { how: 'told' } : null
      )
    }))
    const run = await runSpotChecks(db, { ai: ai.deps }, { requestId: 'spot' })
    expect(run.checked.strong).toBe(3)
    const knows = ai.requests.filter((request) => sentChecks(request)[0]?.kind === 'knows')
    expect(knows).toHaveLength(2)
    expect(knows.every((request) => request.maxTokens === 48)).toBe(true)
    expect(sentChecks(knows[0]!)[0]?.topic).toBe(
      's1 the sold map: “Tomas sold the map”'
    )
    // Orrin's line: the strong model read the how otherwise, so it goes.
    expect(knowsOf().map((line) => line[0])).toEqual([tomas])
    expect(run.deleted).toHaveLength(1)
  })

  it('Not right on a knows line: Wrong value keys it by secret and how; Not about re-checks the learner', async () => {
    await read(fake(SCENE_ONE_PLAN))
    const map = topicNamed('the sold map')
    const orrinLine = claimsOf().find((claim) => claim.slot === 'knows' && claim.recordId === orrin)
    const tomasLine = claimsOf().find((claim) => claim.slot === 'knows' && claim.recordId === tomas)
    // Not about Mara: one knows item with Mara among the learners; the checker names her.
    const ai = fakeAi((request) => ({
      text: verifyReply(request, (check) => ({
        r: check.who[check.names.indexOf('Mara Vell')] ?? null
      }))
    }))
    const moved = await notAbout(
      db,
      { ai: ai.deps },
      { claimId: orrinLine?.id ?? '', recordId: mara, requestId: 'na' }
    )
    expect(moved.outcome).toBe('moved')
    const [check] = sentChecks(ai.requests[0]!)
    expect(check?.kind).toBe('knows')
    expect(check?.names).toContain('Mara Vell')
    expect(knowsOf().map((line) => [line[0], line[1], line[2]])).toContainEqual([
      mara,
      map,
      'overheard'
    ])
    // Wrong value: the line goes, its tombstone names the secret and the how.
    const dismissed = wrongValue(db, tomasLine?.id ?? '', NOW)
    expect(dismissed.dismissed?.label).toBe('Tomas: knows the sold map (knew before)')
    expect(knowsOf().map((line) => line[0])).toEqual([mara])
  })
})
