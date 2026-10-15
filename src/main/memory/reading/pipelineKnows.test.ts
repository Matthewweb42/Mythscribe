import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget } from '@shared/ai'
import { sceneSentences } from '@shared/memory/anchor'
import { TOPIC_ROSTER_MAX_TOKENS } from '@shared/memory/topics'
import type { Claim } from '@shared/memory/claims'
import { dismissedKey } from '@shared/memory/dismissed'
import { gateText } from '@shared/memory/gate'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetInflight } from '../../ai/inflight'
import type { CompletionRequest } from '../../ai/providers/types'
import { saveDocument } from '../../document/documentStore'
import { setSceneMeta } from '../../document/sceneMetaStore'
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
import { gateScene, runReading, type ReadingOutcome } from './pipeline'
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
import { acceptSuggestions } from './suggestions'
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
      promptVersion: 'reader.v6',
      verifyVersion: 'verify.v4'
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
    // Plan Suggestions.md: only the knows lines the author accepted are told to the reader.
    acceptSuggestions(
      db,
      claimsOf().map((claim) => claim.id)
    )
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
        alsoHere: [tomas],
        flashback: null
      },
      NOW
    )
    const ai = fake({ ...SCENE_ONE_PLAN, present: [] })
    await read(ai)
    expect(checksOf(ai).some((check) => check.kind === 'present')).toBe(false)
    expect(knowsOf().map((line) => line[0])).toEqual([tomas, orrin])
  })

  it('keeps a told line in its source’s own words for the learner in reach (P2b slice 3)', async () => {
    // "I" is Tomas, the source: Orrin, named the sentence before, is the learner.
    saveDocument(db, one, doc('Tomas found Orrin by the nets.', '“I sold the map,” said Tomas.'))
    scanNamesFor(db, one, NOW)
    const topics: NewTopic[] = [
      { n: 'the sold map', kind: 'secret', id: 'x1', p: 1, q: 'I sold the map' }
    ]
    const told: Line = {
      p: 1,
      r: 'Orrin',
      s: 'knows',
      o: 'x1',
      how: 'told',
      fr: 'Tomas',
      q: 'I sold the map',
      voice: 'dialogue',
      sp: 'Tomas'
    }
    const ai = fake({ topics, lines: [told], present: ['Orrin'] })
    await read(ai)
    const map = topicNamed('the sold map')
    expect(knowsOf()).toEqual([[orrin, map, 'told', tomas]])
    // The checker chose among those in reach, never the source.
    const check = checksOf(ai).find((each) => each.kind === 'knows')
    expect(check?.names).toEqual(['Orrin'])
    expect(invariants()).toEqual([])
  })

  it('refuses a learner whose sentence is someone else’s first person with no source', async () => {
    saveDocument(db, one, doc('Tomas found Orrin by the nets.', '“I sold the map,” said Tomas.'))
    scanNamesFor(db, one, NOW)
    const ai = fake({
      topics: [{ n: 'the sold map', kind: 'secret', id: 'x1', p: 1, q: 'I sold the map' }],
      lines: [
        {
          p: 1,
          r: 'Orrin',
          s: 'knows',
          o: 'x1',
          how: 'saw',
          q: 'I sold the map',
          voice: 'dialogue',
          sp: 'Tomas'
        }
      ],
      present: ['Orrin']
    })
    await read(ai)
    expect(knowsOf()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toMatchObject({
      subject: 1
    })
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
        alsoHere: [],
        flashback: null
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

  it('re-checks the scene’s reveals on a rebuild: one stated again stays, and an edit then prunes it', async () => {
    await read(fake(SCENE_ONE_PLAN))
    const map = topicNamed('the sold map')
    const rebuild = fake({
      topics: [{ kind: 'secret', id: 's1', p: 0, q: 'Tomas sold the map' }],
      lines: []
    })
    const outcome = await runReading(
      db,
      { ai: rebuild.deps },
      { nodeId: one, caretPara: null, requestId: 'r-rebuild', purpose: 'rebuild' }
    )
    // The reader saw the live reveal as re-checking and stated it again; the checker passed it.
    expect(rebuild.requests[0]?.messages.at(-1)?.content).toContain(
      's1 revealed “Tomas sold the map” ¶0, re-checking'
    )
    expect(
      checksOf(rebuild)
        .filter((check) => check.kind === 'reveals')
        .map((check) => check.topic)
    ).toEqual(['s1 the sold map · secret'])
    // The knows lines go with a rebuild that does not state them; the reveal stands, re-proved.
    expect(knowsOf()).toEqual([])
    expect(recordTopicQuotes(db, map).map((quote) => [quote.state, quote.quote])).toEqual([
      ['live', 'Tomas sold the map']
    ])
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

  it('drops a reveal a rebuild does not prove again, and prunes the topic a bad model made', async () => {
    await read(fake(SCENE_ONE_PLAN))
    const map = topicNamed('the sold map')
    const heir = topicNamed('the missing heir')
    const outcome = await runReading(
      db,
      { ai: fake({ lines: [] }).deps },
      { nodeId: one, caretPara: null, requestId: 'r-rebuild', purpose: 'rebuild' }
    )
    expect(knowsOf()).toEqual([])
    expect(getRecord(db, map)).toBeNull()
    expect(getRecord(db, heir)).toBeNull()
    expect(outcome).toMatchObject({ read: true })
    if (outcome.read) expect(outcome.topicIds).toEqual([map, heir].sort())
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
    expect(sentChecks(knows[0]!)[0]?.topic).toBe('s1 the sold map: “Tomas sold the map”')
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
  it('reads a full page past a topics roster at its ceiling, within the input cap', async () => {
    // 200 secrets of the author's: far past the roster's 1,000 tokens.
    for (let i = 0; i < 200; i += 1) record(`secret ${i + 1} of the hall`, [], 'secret')
    const long = Array.from(
      { length: 12 },
      (_, i) =>
        `Tomas walked the length of the quay for the ${i + 1}th time. ` +
        'The rain fell on the slate roofs and the nets. '.repeat(16)
    )
    saveDocument(db, one, doc(...long))
    scanNamesFor(db, one, NOW)
    const ai = fake({ lines: [] })
    const outcome = await read(ai)
    expect(outcome).toMatchObject({ read: true })
    const readers = ai.requests.filter((request) => requestKind(request) === 'reader')
    expect(readers.length).toBeGreaterThan(0)
    for (const request of readers) {
      const all = request.messages.map((message) => message.content).join('\n')
      expect(estimateTokens(all)).toBeLessThanOrEqual(inputBudget('reader'))
      const system = request.messages[0]?.content ?? ''
      const topics = system.slice(system.indexOf('Secrets and threads (id label · kind):'))
      expect(estimateTokens(topics)).toBeLessThanOrEqual(TOPIC_ROSTER_MAX_TOKENS + 20)
    }
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toMatchObject({
      topicRosterLeftOut: 1
    })
  })

  it('never sends an Idea scene’s reveal, nor merges into a topic only an Idea scene backs', async () => {
    await read(fake(SCENE_ONE_PLAN))
    setSceneMeta(db, one, { location: '', pov: '', timeline: '', status: 'idea' })
    runAnchors(db, one, NOW)
    saveDocument(db, two, doc('The map had been sold by Tomas, and Mara knew it.'))
    scanNamesFor(db, two, NOW)
    const ai = fake({
      topics: [
        { n: 'the map sale', kind: 'secret', id: 'x1', p: 0, q: 'The map had been sold by Tomas' }
      ],
      lines: [{ p: 0, r: 'Mara Vell', s: 'knows', o: 'x1', how: 'saw', q: 'Mara knew it' }],
      present: ['Mara Vell']
    })
    await read(ai, two)
    for (const request of ai.requests) {
      expect(JSON.stringify(request.messages)).not.toContain('Tomas sold the map')
      expect(JSON.stringify(request.messages)).not.toContain('the sold map')
    }
    expect(checksOf(ai).some((check) => check.kind === 'same')).toBe(false)
    expect(
      listTopics(db, 'secret')
        .map((topic) => topic.label)
        .sort()
    ).toEqual(['the map sale', 'the sold map'])
    expect(knowsOf(two)).toEqual([[mara, topicNamed('the map sale'), 'saw', null]])
  })

  it('merges a secret a long scene reveals on page 1 and a later page proposes again under its own label', async () => {
    const filler = 'The rain fell on the slate roofs and the nets. '.repeat(130)
    saveDocument(
      db,
      one,
      doc(
        `Tomas sold the map on the quay. ${filler}`,
        `The map had been sold by Tomas, and Orrin overheard Tomas. ${filler}`
      )
    )
    scanNamesFor(db, one, NOW)
    const ai = fake({
      topics: [
        { n: 'the sold map', kind: 'secret', id: 'x1', p: 0, q: 'Tomas sold the map' },
        { n: 'the map sale', kind: 'secret', id: 'x1', p: 1, q: 'The map had been sold by Tomas' }
      ],
      lines: [
        {
          p: 1,
          r: 'Orrin',
          s: 'knows',
          o: 'x1',
          how: 'overheard',
          fr: 'Tomas',
          q: 'Orrin overheard Tomas'
        }
      ]
    })
    const outcome = await read(ai)
    expect(outcome).toMatchObject({ read: true })
    // Pages of 400 prose tokens (reader.v3): each long paragraph is cut at sentences.
    expect(outcome.read && outcome.pages).toBeGreaterThan(2)
    const same = checksOf(ai).filter((check) => check.kind === 'same')
    expect(same.map((check) => check.topic)).toEqual([
      'x1 the map sale: “The map had been sold by Tomas” (1.1) | new the sold map: “Tomas sold the map” (1.1)'
    ])
    expect(listTopics(db, 'secret').map((topic) => topic.label)).toEqual(['the sold map'])
    const map = topicNamed('the sold map')
    const quotes = recordTopicQuotes(db, map)
    expect(quotes.map((quote) => [quote.role, quote.label])).toEqual([
      ['defining', 'the sold map'],
      ['merged', 'the map sale']
    ])
    expect(claimsOf().find((claim) => claim.slot === 'knows')).toMatchObject({
      recordId: orrin,
      objectId: map,
      topicQuoteId: quotes[1]?.id
    })
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toMatchObject({
      topicsCreated: 1,
      topicsMerged: 1
    })
    expect(invariants()).toEqual([])
  })

  it('reads again a reply cut inside its new secrets and threads, and keeps them', async () => {
    let calls = 0
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      calls += 1
      const full = readerReply(request, SCENE_ONE_PLAN)
      if (calls > 1) return { text: full }
      // Cut just after the knows lines and the step, as "n" opens.
      return { text: `${full.slice(0, full.indexOf('"n":[') + 5)}`, finishReason: 'length' }
    })
    await read(ai)
    const readers = ai.requests.filter((request) => requestKind(request) === 'reader')
    expect(readers.length).toBeGreaterThanOrEqual(2)
    // The retry reads the whole page (in halves): the lost topics could stand anywhere in it.
    expect(readers[1]?.messages.at(-1)?.content).toContain('¶0 Tomas sold the map')
    const map = topicNamed('the sold map')
    expect(
      listTopics(db)
        .map((topic) => topic.label)
        .sort()
    ).toEqual(['the missing heir', 'the sold map'])
    expect(knowsOf()).toEqual([
      [tomas, map, 'knewBefore', null],
      [orrin, map, 'overheard', tomas]
    ])
    const rejections = lastReading(db, one, activeDraftId(db))?.yields.rejections ?? {}
    expect(rejections.record).toBeUndefined()
  })

  it('leaves a line whose topic two cut replies lost unread, never counted against the reader', async () => {
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      const full = readerReply(request, SCENE_ONE_PLAN)
      return { text: `${full.slice(0, full.indexOf('"n":[') + 5)}`, finishReason: 'length' }
    })
    await read(ai)
    expect(listTopics(db)).toEqual([])
    const rejections = lastReading(db, one, activeDraftId(db))?.yields.rejections ?? {}
    expect(rejections).toMatchObject({ unanswered: 3 })
    expect(rejections.record).toBeUndefined()
    // Nothing was read through: the next reading reads the scene again.
    expect(await read(fake(SCENE_ONE_PLAN))).toMatchObject({ read: true })
    expect(listTopics(db)).toHaveLength(2)
  })

  it('treats a same-as check with no verdict as unanswered: no second topic, read again', async () => {
    await read(fake(SCENE_ONE_PLAN))
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
    const ai = fakeAi((request) => {
      if (requestKind(request) !== 'verify') return { text: readerReply(request, plan) }
      const reply = JSON.parse(verifyReply(request)) as { v: { i: number }[] }
      const same = sentChecks(request).filter((check) => check.kind === 'same')
      const skip = new Set(same.map((check) => check.i))
      return { text: JSON.stringify({ v: reply.v.filter((verdict) => !skip.has(verdict.i)) }) }
    })
    await read(ai, two)
    expect(listTopics(db, 'secret').map((topic) => topic.label)).toEqual(['the sold map'])
    expect(knowsOf(two)).toEqual([])
    expect(lastReading(db, two, activeDraftId(db))?.yields.rejections).toMatchObject({
      unanswered: 2
    })
    expect(await read(fake(plan), two)).toMatchObject({ read: true })
  })

  it('makes a labelled new secret given a listed id a new one, its facts with it', async () => {
    await read(fake(SCENE_ONE_PLAN))
    const map = topicNamed('the sold map')
    saveDocument(db, two, doc('Orrin stole the key, and Mara saw him.'))
    scanNamesFor(db, two, NOW)
    const ai = fake(
      {
        topics: [{ n: 'the stolen key', kind: 'secret', id: 's1', p: 0, q: 'Orrin stole the key' }],
        lines: [{ p: 0, r: 'Mara Vell', s: 'knows', o: 's1', how: 'saw', q: 'Mara saw him' }],
        present: ['Mara Vell']
      },
      (check) => (check.kind === 'same' ? { ok: false } : null)
    )
    await read(ai, two)
    const key = topicNamed('the stolen key')
    expect(key).not.toBe('')
    expect(knowsOf(two)).toEqual([[mara, key, 'saw', null]])
    expect(knowsOf(two).some((line) => line[1] === map)).toBe(false)
  })

  it('makes no secret of a reveal the text only rumours, and keeps a thread set up as a plan', async () => {
    const ai = fake(SCENE_ONE_PLAN, (check) =>
      check.kind === 'reveals' ? { voice: 'rumour', mode: 'now' } : null
    )
    await read(ai)
    expect(listTopics(db).map((topic) => topic.label)).toEqual(['the missing heir'])
    expect(knowsOf()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toMatchObject({
      topicNotCounted: 1,
      topicsCreated: 1
    })
    // A thread opened by a vow (a plan: hypothetical) is still a thread.
    const vow = fake(SCENE_ONE_PLAN, (check) =>
      check.kind === 'reveals' ? { voice: 'narration', mode: 'hypothetical' } : null
    )
    saveDocument(db, two, doc('Mara swore to find the heir.'))
    scanNamesFor(db, two, NOW)
    await read(vow, two)
    expect(listTopics(db, 'secret')).toEqual([])
  })

  it('lets a group know where its sentence names it by its head noun', async () => {
    saveDocument(
      db,
      one,
      doc('Tomas sold the map on the quay.', 'By Sunday the whole regiment knew of the sale.')
    )
    scanNamesFor(db, one, NOW)
    await read(
      fake({
        topics: [{ n: 'the sold map', kind: 'secret', id: 'x1', p: 0, q: 'Tomas sold the map' }],
        lines: [
          {
            p: 1,
            r: 'the regiment',
            s: 'knows',
            o: 'x1',
            how: 'told',
            q: 'the whole regiment knew of the sale'
          }
        ]
      })
    )
    expect(knowsOf().map((line) => [line[0], line[2]])).toEqual([[regiment, 'told']])
    expect(claimsOf().find((claim) => claim.slot === 'knows')?.subjectText).toBe('regiment')
  })

  it('checks a learner the card proposes on the page too, so a failed POV check loses nothing', async () => {
    const ai = fake(
      {
        ...SCENE_ONE_PLAN,
        present: [],
        pov: { name: 'Orrin', p: 1, q: 'Orrin overheard Tomas from behind the nets' }
      },
      (check) => (check.kind === 'card' && check.label === 'Card POV' ? { ok: false } : null)
    )
    await read(ai)
    expect(checksOf(ai).some((check) => check.label === 'Card POV')).toBe(true)
    expect(
      checksOf(ai)
        .filter((check) => check.kind === 'present')
        .map((check) => check.names[0])
        .sort()
    ).toEqual(['Orrin', 'Tomas'])
    expect(knowsOf().map((line) => line[0])).toEqual([tomas, orrin])
    // The POV did not hold; Orrin's own on-page check kept his line.
    expect(
      (await import('./cardStore')).getCard(db, one, activeDraftId(db))?.fields.pov?.verified
    ).toBe(false)
  })

  it('reads again a knows line whose on-page check got no verdict; a refused one is not the checker’s', async () => {
    const plan = { ...SCENE_ONE_PLAN, present: [] }
    const ai = fakeAi((request) => {
      if (requestKind(request) !== 'verify') return { text: readerReply(request, plan) }
      const reply = JSON.parse(verifyReply(request)) as { v: { i: number }[] }
      const orrinHere = sentChecks(request).find(
        (check) => check.kind === 'present' && check.names[0] === 'Orrin'
      )
      return {
        text: JSON.stringify({ v: reply.v.filter((verdict) => verdict.i !== orrinHere?.i) })
      }
    })
    await read(ai)
    expect(knowsOf().map((line) => line[0])).toEqual([tomas])
    const yields = lastReading(db, one, activeDraftId(db))?.yields
    expect(yields?.rejections).toMatchObject({ unanswered: 1 })
    expect(yields?.rejections.notHere).toBeUndefined()
    // The checker passed every line it answered: none is held against it.
    expect(yields?.verifySent).toBe(yields?.verified)
    expect(getSceneRead(db, one, activeDraftId(db))?.settled).toBe(false)
    // A refused on-page check: notHere, still not the checker's failure.
    saveDocument(db, two, doc(...SCENE_ONE))
    scanNamesFor(db, two, NOW)
    await read(
      fake(plan, (check) =>
        check.kind === 'present' && check.names[0] === 'Orrin' ? { ok: false } : null
      ),
      two
    )
    const second = lastReading(db, two, activeDraftId(db))?.yields
    expect(second?.rejections).toMatchObject({ notHere: 1 })
    expect(second?.verifySent).toBe(second?.verified)
  })

  it('keeps a scene unsettled on the idle trigger while the caret paragraph holds an unread finished sentence', async () => {
    await read(fake(SCENE_ONE_PLAN))
    expect(getSceneRead(db, one, activeDraftId(db))?.settled).toBe(true)
    // A new paragraph at the caret: one finished sentence, then the one being typed.
    saveDocument(db, one, doc(...SCENE_ONE, 'Orrin said nothing at all. He'))
    runAnchors(db, one, NOW)
    expect(getSceneRead(db, one, activeDraftId(db))?.settled).toBe(false)
    // The idle gate leaves the caret paragraph out of what to read, never out of "settled".
    expect(gateScene(db, one, 3)?.decision).toMatchObject({ read: 'nothing' })
    expect(getSceneRead(db, one, activeDraftId(db))?.settled).toBe(false)
    expect(gateScene(db, one, null)?.decision).toMatchObject({ read: 'window', paras: [3] })
    // An idle reading of another paragraph does not settle it either.
    saveDocument(
      db,
      one,
      doc(
        'Tomas sold the map on the quay at dawn.',
        ...SCENE_ONE.slice(1),
        'Orrin said nothing at all. He'
      )
    )
    runAnchors(db, one, NOW)
    const idle = await runReading(
      db,
      { ai: fake({ lines: [] }).deps },
      { nodeId: one, caretPara: 3, requestId: 'r-idle' }
    )
    expect(idle).toMatchObject({ read: true })
    expect(getSceneRead(db, one, activeDraftId(db))?.settled).toBe(false)
    // Read with the caret gone: settled.
    await read(fake({ lines: [] }))
    expect(getSceneRead(db, one, activeDraftId(db))?.settled).toBe(true)
  })

  it('Not about on a knows line: only a knower, the source re-read, the Here rule kept', async () => {
    await read(fake(SCENE_ONE_PLAN))
    const orrinLine = claimsOf().find((claim) => claim.slot === 'knows' && claim.recordId === orrin)
    const place = record('the quay', [], 'setting')
    await expect(
      notAbout(
        db,
        { ai: fakeAi(() => ({ text: '{"v":[]}' })).deps },
        { claimId: orrinLine?.id ?? '', recordId: place, requestId: 'na-place' }
      )
    ).rejects.toThrow(/character or a group/)
    // Moved to Tomas (on the card): his own source cannot be him.
    const toTomas = fakeAi((request) => ({
      text: verifyReply(request, (check) => ({
        r: check.who[check.names.indexOf('Tomas')] ?? null,
        fr: check.who[check.names.indexOf('Tomas')] ?? null
      }))
    }))
    const moved = await notAbout(
      db,
      { ai: toTomas.deps },
      { claimId: orrinLine?.id ?? '', recordId: tomas, requestId: 'na-tomas' }
    )
    expect(moved.outcome).toBe('moved')
    expect(claimsOf().find((claim) => claim.id === orrinLine?.id)).toMatchObject({
      recordId: tomas,
      fromId: null
    })
    expect(sentChecks(toTomas.requests[0]!).map((check) => check.kind)).toEqual(['knows'])
    // Mara is not Here: an on-page check rides along; not shown there, the move is refused.
    const toMara = fakeAi((request) => ({
      text: verifyReply(request, (check) =>
        check.kind === 'present'
          ? { ok: false }
          : { r: check.who[check.names.indexOf('Mara Vell')] ?? null }
      )
    }))
    const refused = await notAbout(
      db,
      { ai: toMara.deps },
      { claimId: orrinLine?.id ?? '', recordId: mara, requestId: 'na-mara' }
    )
    expect(sentChecks(toMara.requests[0]!).map((check) => check.kind)).toEqual(['knows', 'present'])
    expect(refused.outcome).toBe('dismissed')
    expect(knowsOf().some((line) => line[0] === mara)).toBe(false)
  })
})
