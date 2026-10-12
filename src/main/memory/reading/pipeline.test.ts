import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sceneSentences } from '@shared/memory/anchor'
import { dismissedKey } from '@shared/memory/dismissed'
import { gateText } from '@shared/memory/gate'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
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
import { nameScanShared, scanNamesFor } from '../nameIndexer'
import { answerNameQuestion, listNameQuestions, resetNameQuestionCache } from '../questions'
import { createRecord } from '../recordStore'
import { setSceneDetails } from '../sceneDetailStore'
import { runAnchors } from './anchors'
import { getCard } from './cardStore'
import { sceneTexts } from './claimFixture'
import { invariantClaims, sceneClaims } from './claimStore'
import { runReading, type ReadingItemEvent, type ReadingOutcome } from './pipeline'
import { lastReading } from './readingStore'
import {
  fakeAi,
  requestKind,
  rosterIds,
  sentChecks,
  sentParagraphs,
  type FakeAi,
  type FakeAnswer
} from './readingFixture'
import { getSceneRead } from './sceneReadStore'
import { settleOwnedNames } from './waiting'

let tmp: string
let session: ProjectSession
let db: TreeDb
let one: string
let mara: string
let tomas: string
let lise: string

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

const SCENE = [
  'The ridge was cold.',
  "Mara's eyes were grey. She walked to the quay.",
  'Tomas wore a blue coat.'
]

beforeEach(() => {
  resetInflight()
  resetNameQuestionCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-pipeline-'))
  session = createProject(projectFolderFor(tmp, 'Pipeline'), 'Pipeline', 'novel')
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  saveDocument(db, one, doc(...SCENE))
  mara = record('Mara Vell', ['Mara'])
  tomas = record('Tomas')
  lise = record('Lise')
  record('the Quay', [], 'setting')
  scanNamesFor(db, one, NOW)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

interface PlannedClaim {
  p: number
  r: string
  s: string
  v: string
  q: string
  voice?: string
  sp?: string | null
  mode?: string
}

/** A reader answer from planned claims; `r` is a record's name, mapped to the request's roster id. */
function readerReply(
  request: CompletionRequest,
  claims: readonly PlannedClaim[],
  extra: Record<string, unknown> = {}
): string {
  const ids = rosterIds(request)
  const sent = sentParagraphs(request)
  const c = claims
    .filter((claim) => sent.has(claim.p))
    .map((claim) => ({
      p: claim.p,
      r: ids.get(claim.r) ?? claim.r,
      s: claim.s,
      v: claim.v,
      q: claim.q,
      voice: claim.voice ?? 'narration',
      sp: claim.sp === undefined || claim.sp === null ? null : (ids.get(claim.sp) ?? claim.sp),
      mode: claim.mode ?? 'now',
      o: null,
      chg: false
    }))
  return JSON.stringify({ c, n: [], same: [], drop: [], ...extra })
}

/** A checker that supports every item, picking the first candidate (or `pick`'s answer). */
function verifyReply(
  request: CompletionRequest,
  pick: (check: ReturnType<typeof sentChecks>[number]) => Record<string, unknown> | null = () =>
    null
): string {
  return JSON.stringify({
    v: sentChecks(request).map((check) => ({
      i: check.i,
      ok: true,
      r: check.who[0] ?? null,
      voice: 'narration',
      mode: 'now',
      ...(pick(check) ?? {})
    }))
  })
}

const PLAN: PlannedClaim[] = [
  { p: 1, r: 'Mara Vell', s: 'eyes', v: 'grey', q: "Mara's eyes were grey" },
  { p: 1, r: 'Mara Vell', s: 'location', v: 'the quay', q: 'She walked to the quay' },
  { p: 2, r: 'Tomas', s: 'clothing', v: 'a blue coat', q: 'Tomas wore a blue coat' }
]

const CARD = {
  line: 'Mara walks to the quay.',
  gist: 'Mara walks to the quay on a cold morning.',
  where: ['the quay', 1, 'She walked to the quay'],
  when: null,
  year: null,
  elapsed: null,
  pov: null,
  flash: null,
  present: [],
  mood: 'cold',
  theme: 'waiting'
}

/** A fake that reads `PLAN` (or `plan`) and supports every check. */
function standard(plan: readonly PlannedClaim[] = PLAN): FakeAi {
  return fakeAi((request): FakeAnswer => {
    if (requestKind(request) === 'verify') return { text: verifyReply(request) }
    const card = request.messages.at(-1)?.content.endsWith('Card: yes') === true
    return { text: readerReply(request, plan, card ? { card: CARD } : {}) }
  })
}

const read = (ai: FakeAi, extra: { caretPara?: number | null } = {}): Promise<ReadingOutcome> =>
  runReading(
    db,
    { ai: ai.deps },
    { nodeId: one, caretPara: extra.caretPara ?? null, requestId: 'r-1' }
  )

const claimsNow = (): ReturnType<typeof sceneClaims> => sceneClaims(db, one, activeDraftId(db))

/** The request at `i`; throws when there is none. */
function nth(requests: readonly CompletionRequest[], i: number): CompletionRequest {
  const found = requests[i]
  if (found === undefined) throw new Error(`no request ${i}`)
  return found
}

function invariants(): ReturnType<typeof checkMemoryInvariants> {
  return checkMemoryInvariants({
    claims: invariantClaims(db),
    sceneHashes: new Map([
      [one, new Set(sceneSentences(sceneTexts(db, one)).map((sentence) => sentence.hash))]
    ]),
    aliases: [],
    citations: []
  })
}

describe('runReading (F-16.17)', () => {
  it('reads a scene first whole: the literal eyes, the pronoun location through the checker, the card', async () => {
    const ai = standard()
    const outcome = await read(ai)
    expect(outcome).toMatchObject({ read: true, purpose: 'first', pages: 1, cut: false })
    const kinds = ai.requests.map(requestKind)
    expect(kinds).toEqual(['reader', 'verify'])
    // Reasoning off and the lowest effort on every story-memory request (P2a-D15).
    for (const request of ai.requests) {
      expect(request).toMatchObject({ reasoning: 'off', lowestEffort: true, json: true })
    }
    const claims = claimsNow()
    expect(claims.map((c) => [c.recordId, c.slot, c.value, c.proof, c.state])).toEqual([
      [mara, 'eyes', 'grey', 'literal', 'live'],
      [mara, 'location', 'the quay', 'verified', 'live'],
      [tomas, 'clothing', 'a blue coat', 'literal', 'live']
    ])
    // The pronoun went to the checker with Mara as its one candidate and its sentence ±1.
    const checks = sentChecks(nth(ai.requests, 1))
    expect(checks.map((check) => [check.label, check.fact])).toEqual([
      ['Fact', 'location: the quay (narration, now)']
    ])
    expect(checks[0]?.text).toBe(SCENE.slice(1).join(' '))
    expect(checks[0]?.who).toHaveLength(1)
    const card = getCard(db, one, activeDraftId(db))
    expect(card).toMatchObject({ line: 'Mara walks to the quay.', mood: 'cold', theme: 'waiting' })
    expect(card?.fields.where).toEqual({
      value: 'the quay',
      quote: 'She walked to the quay',
      p: 1,
      verified: false
    })
    const reading = lastReading(db, one, activeDraftId(db))
    expect(reading).toMatchObject({
      purpose: 'first',
      pages: 1,
      promptVersion: 'reader.v2',
      verifyVersion: 'verify.v2',
      model: 'gpt-5.4-mini',
      tokensIn: 2_000,
      tokensOut: 200,
      finishReason: null,
      yields: {
        items: 3,
        quotesFound: 3,
        literal: 2,
        verifySent: 1,
        verified: 1,
        rejected: 0,
        cut: 0
      }
    })
    expect(reading?.costUsd).toBeGreaterThan(0)
    expect(claims.every((claim) => claim.readingId === reading?.id)).toBe(true)
    expect(getSceneRead(db, one, activeDraftId(db))?.partials).toBe(0)
    expect(ai.ledger.map((entry) => entry.feature)).toEqual(['reader', 'verify'])
    expect(invariants()).toEqual([])
    if (outcome.read) expect(outcome.recordIds.sort()).toEqual([mara, tomas].sort())
  })

  it('sends nothing when nothing finished changed, or only cosmetically', async () => {
    const ai = standard()
    await read(ai)
    const sent = ai.requests.length
    expect(await read(ai)).toEqual({ read: false, reason: 'upToDate' })
    saveDocument(db, one, doc(SCENE[0] ?? '', SCENE[1] ?? '', 'Tomas  wore a blue coat .'))
    expect(await read(ai)).toEqual({ read: false, reason: 'cosmetic' })
    // The caret's paragraph without closing punctuation is not finished (the idle trigger).
    saveDocument(db, one, doc(...SCENE, 'Then Tomas turned'))
    expect(await read(ai, { caretPara: 3 })).toEqual({ read: false, reason: 'upToDate' })
    expect(ai.requests).toHaveLength(sent)
  })

  it('reads a window when a paragraph changed: the changed one ±2, the card not due', async () => {
    const long = [
      ...SCENE,
      'The gulls cried over the water.',
      'A boat came in.',
      'Nobody spoke.',
      'He waved.'
    ]
    saveDocument(db, one, doc(...long))
    scanNamesFor(db, one, NOW)
    const ai = standard()
    await read(ai)
    ai.requests.length = 0
    saveDocument(db, one, doc(...long.slice(0, 6), 'He waved at the boat.'))
    scanNamesFor(db, one, NOW)
    const outcome = await read(ai)
    expect(outcome).toMatchObject({ read: true, purpose: 'window' })
    const reader = ai.requests.find((request) => requestKind(request) === 'reader')
    if (reader === undefined) throw new Error('no reader request')
    // ¶6 changed: ¶4–6, which name nobody, extended back to ¶2 (Tomas).
    expect([...sentParagraphs(reader).keys()]).toEqual([2, 3, 4, 5, 6])
    expect(reader.messages.at(-1)?.content.endsWith('Card: no')).toBe(true)
    // The fact anchored in ¶2 is listed with its short id; Tomas has no fixed or lasting value.
    const tail = reader.messages.at(-1)?.content ?? ''
    expect(tail).toMatch(/c\d+ r\d+ clothing “a blue coat” ¶2/)
    expect(tail).not.toContain('Known about the records named here:')
    expect(reader.maxTokens).toBeLessThan(720)
    expect(getSceneRead(db, one, activeDraftId(db))?.partials).toBe(1)

    // ¶3 changed: ¶1–5, where Mara is named, so what is known about her goes along.
    ai.requests.length = 0
    saveDocument(
      db,
      one,
      doc(
        ...long.slice(0, 3),
        'The gulls cried over the grey water.',
        ...long.slice(4, 6),
        'He waved at the boat.'
      )
    )
    scanNamesFor(db, one, NOW)
    await read(ai)
    const next = ai.requests.find((request) => requestKind(request) === 'reader')
    if (next === undefined) throw new Error('no reader request')
    expect([...sentParagraphs(next).keys()]).toEqual([1, 2, 3, 4, 5])
    expect(next.messages.at(-1)?.content).toMatch(
      /Known about the records named here:\nr\d+ eyes “grey”/
    )
    expect(getSceneRead(db, one, activeDraftId(db))?.partials).toBe(2)
  })

  it('reads a long scene in pages and keeps the first page’s card', async () => {
    const filler = 'The tide ran out across the mudflats and the gulls followed it. '.repeat(20)
    const long = [...SCENE, ...Array.from({ length: 8 }, () => filler.trim())]
    saveDocument(db, one, doc(...long))
    const ai = standard()
    const outcome = await read(ai)
    expect(outcome).toMatchObject({ read: true, purpose: 'first' })
    const readers = ai.requests.filter((request) => requestKind(request) === 'reader')
    expect(readers.length).toBeGreaterThan(1)
    for (const request of readers) {
      expect(request.messages.at(-1)?.content).toMatch(/page \d of \d \(the whole scene\)/)
      expect(request.maxTokens).toBe(720)
    }
    expect(getCard(db, one, activeDraftId(db))?.line).toBe('Mara walks to the quay.')
    expect(claimsNow()).toHaveLength(3)
  })

  it('salvages a reply cut off at its cap and reads the paragraphs after the last quote once more', async () => {
    let calls = 0
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      calls += 1
      if (calls === 1) {
        const whole = readerReply(request, PLAN)
        // Cut inside the third claim (¶2).
        return { text: whole.slice(0, whole.indexOf('Tomas wore') + 4), finishReason: 'length' }
      }
      return { text: readerReply(request, PLAN) }
    })
    const outcome = await read(ai)
    const readers = ai.requests.filter((request) => requestKind(request) === 'reader')
    expect(readers).toHaveLength(2)
    expect([...sentParagraphs(nth(readers, 1)).keys()]).toEqual([2])
    expect(outcome).toMatchObject({ read: true, cut: true })
    expect(claimsNow().map((claim) => claim.slot)).toEqual(['eyes', 'location', 'clothing'])
    expect(lastReading(db, one, activeDraftId(db))).toMatchObject({
      finishReason: 'length',
      yields: { cut: 1 }
    })
  })

  it('leaves the paragraphs a second cut-off reply did not reach unread', async () => {
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      const whole = readerReply(request, PLAN)
      const sent = [...sentParagraphs(request).keys()]
      if (sent[0] === 0) {
        return { text: whole.slice(0, whole.indexOf('She walked') + 4), finishReason: 'length' }
      }
      return { text: '{"c":[', finishReason: 'length' }
    })
    await read(ai)
    expect(claimsNow().map((claim) => claim.slot)).toEqual(['eyes'])
    // ¶1 and ¶2 stay unread, so the next reading reads them again.
    const again = standard()
    const outcome = await read(again)
    expect(outcome).toMatchObject({ read: true })
    const reader = again.requests.find((request) => requestKind(request) === 'reader')
    expect([...sentParagraphs(nth(reader === undefined ? [] : [reader], 0)).keys()]).toContain(2)
  })

  it('counts every rejection by reason and stores none of them', async () => {
    const events: ReadingItemEvent[] = []
    const plan: PlannedClaim[] = [
      { p: 1, r: 'Mara Vell', s: 'eyes', v: 'grey', q: "Mara's eyes were green" },
      { p: 2, r: 'Mara Vell', s: 'location', v: 'the quay', q: 'She walked to the quay' },
      { p: 1, r: 'Mara Vell', s: 'eyes', v: 'grey', q: "Mara's eyes were grey" },
      { p: 1, r: 'Mara Vell', s: 'eyes', v: 'grey', q: 'grey' },
      { p: 2, r: 'Tomas', s: 'mood', v: 'the secret', q: 'Tomas wore a blue coat' },
      { p: 1, r: 'Nobody', s: 'eyes', v: 'grey', q: "Mara's eyes were grey" },
      { p: 0, r: 'Mara Vell', s: 'traits', v: 'cold', q: 'The ridge was cold' },
      { p: 2, r: 'Tomas', s: 'traits', v: 'dashing', q: 'Tomas wore a blue coat' }
    ]
    // Mara's eyes twice in ¶1: a quote that is not once in the window.
    saveDocument(
      db,
      one,
      doc(SCENE[0] ?? '', `${SCENE[1] ?? ''} Mara's eyes were grey.`, SCENE[2] ?? '')
    )
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') {
        return { text: verifyReply(request, () => ({ ok: false })) }
      }
      return { text: readerReply(request, plan) }
    })
    await runReading(
      db,
      { ai: ai.deps },
      {
        nodeId: one,
        caretPara: null,
        requestId: 'r-2',
        observe: (event) => events.push(event)
      }
    )
    expect(claimsNow()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields).toMatchObject({
      items: 8,
      quotesFound: 2,
      rejected: 8,
      rejections: {
        notFound: 1,
        otherParagraph: 1,
        repeated: 1,
        tooShort: 1,
        slot: 1,
        record: 1,
        subject: 1,
        unsupported: 1
      }
    })
    expect(events.map((event) => event.outcome).sort()).toEqual(
      [
        'notFound',
        'otherParagraph',
        'record',
        'repeated',
        'slot',
        'subject',
        'tooShort',
        'unsupported'
      ].sort()
    )
  })

  it('refuses a check that names no subject, voice or mode, or another record', async () => {
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') {
        return { text: verifyReply(request, () => ({ voice: null })) }
      }
      return {
        text: readerReply(request, [
          { p: 2, r: 'Tomas', s: 'traits', v: 'dashing', q: 'Tomas wore a blue coat' }
        ])
      }
    })
    await read(ai)
    expect(claimsNow()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ unconfirmed: 1 })
  })

  it('takes the checker’s voice and mode over the reader’s', async () => {
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') {
        return { text: verifyReply(request, () => ({ voice: 'rumour', mode: 'memory' })) }
      }
      return {
        text: readerReply(request, [
          { p: 2, r: 'Tomas', s: 'traits', v: 'blue coat', q: 'Tomas wore a blue coat' }
        ])
      }
    })
    await read(ai)
    expect(claimsNow().map((claim) => [claim.voice, claim.mode, claim.proof])).toEqual([
      ['rumour', 'memory', 'verified']
    ])
  })

  it('leaves a pronoun more than one woman fits waiting, attached to nobody', async () => {
    saveDocument(
      db,
      one,
      doc(
        'Mara and Lise sat by the window.',
        'She had green eyes, and in that light they looked gold.'
      )
    )
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') {
        return { text: verifyReply(request, () => ({ r: null })) }
      }
      return {
        text: readerReply(request, [
          { p: 1, r: 'Mara Vell', s: 'eyes', v: 'green', q: 'She had green eyes' }
        ])
      }
    })
    await read(ai)
    const checks = sentChecks(nth(ai.requests, 1))
    expect(checks[0]?.who).toHaveLength(2)
    const [claim] = claimsNow()
    expect(claim).toMatchObject({ recordId: null, state: 'waiting', proof: 'verified' })
    expect(claim?.pending).toEqual({ kind: 'subject', candidates: [mara, lise] })
    expect(invariants()).toEqual([])
  })

  it('pins first person to the speaker of a line of dialogue, and to the typed POV only when the text’s POV agrees', async () => {
    saveDocument(
      db,
      one,
      doc('"I was born in Elsmere," said Tomas.', 'I was born in the north, I told myself.')
    )
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
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') {
        return {
          text: verifyReply(request, (check) =>
            check.label === 'Fact' && check.fact.includes('dialogue') ? { voice: 'dialogue' } : null
          )
        }
      }
      return {
        text: readerReply(request, [
          {
            p: 0,
            r: 'Tomas',
            s: 'born',
            v: 'in Elsmere',
            q: 'I was born in Elsmere',
            voice: 'dialogue',
            sp: 'Tomas'
          },
          { p: 1, r: 'Mara Vell', s: 'born', v: 'in the north', q: 'I was born in the north' }
        ])
      }
    })
    await read(ai)
    // Tomas's own line is his; the POV's first person waits on the text's POV, which no card verified.
    expect(claimsNow().map((claim) => [claim.recordId, claim.voice, claim.speakerId])).toEqual([
      [tomas, 'dialogue', tomas]
    ])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ subject: 1 })
  })

  it('keeps a new name’s proved facts waiting, asks about the name once, and attaches them on Yes', async () => {
    saveDocument(db, one, doc(...SCENE, 'By then Hesk was a smuggler from the marsh.'))
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return {
        text: JSON.stringify({
          c: [],
          n: [
            {
              n: 'Hesk',
              p: 3,
              q: 'Hesk was a smuggler',
              c: [
                {
                  p: 3,
                  s: 'role',
                  v: 'a smuggler',
                  q: 'Hesk was a smuggler from the marsh',
                  voice: 'narration',
                  mode: 'now'
                }
              ]
            }
          ]
        })
      }
    })
    const outcome = await read(ai)
    if (!outcome.read) throw new Error('not read')
    expect(outcome.names).toEqual(['hesk'])
    const [waiting] = claimsNow()
    expect(waiting).toMatchObject({
      recordId: null,
      state: 'waiting',
      pending: { kind: 'name', norm: 'hesk', text: 'Hesk' },
      subjectText: 'Hesk'
    })
    // Seen once, with a proved fact: asked about.
    expect(listNameQuestions(db).map((q) => [q.kind, q.name])).toContainEqual(['newName', 'Hesk'])
    const { result, settled } = answerNameQuestion(
      db,
      { kind: 'addAs', name: 'Hesk', categoryId: 'character' },
      NOW
    )
    if (result.kind !== 'record') throw new Error('no record')
    expect(settled?.attached).toEqual([waiting?.id])
    expect(claimsNow()[0]).toMatchObject({
      recordId: result.record.id,
      state: 'live',
      pending: null
    })
    expect(invariants()).toEqual([])
  })

  it('attaches a waiting fact whose sentence changed stale, and deletes them all on No', async () => {
    saveDocument(
      db,
      one,
      doc(...SCENE, 'By then Hesk was a smuggler from the marsh.', 'By then Ry was a boatman.')
    )
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return {
        text: JSON.stringify({
          n: [
            {
              n: 'Hesk',
              p: 3,
              q: 'Hesk was a smuggler',
              c: [{ p: 3, s: 'role', v: 'a smuggler', q: 'Hesk was a smuggler from the marsh' }]
            },
            {
              n: 'Ry',
              p: 4,
              q: 'Ry was a boatman',
              c: [{ p: 4, s: 'role', v: 'a boatman', q: 'Ry was a boatman' }]
            }
          ]
        })
      }
    })
    await read(ai)
    expect(claimsNow().map((claim) => claim.state)).toEqual(['waiting', 'waiting'])
    saveDocument(
      db,
      one,
      doc(
        ...SCENE,
        'By then Hesk was a smuggler from the marsh, once.',
        'By then Ry was a boatman.'
      )
    )
    const yes = answerNameQuestion(
      db,
      { kind: 'addAs', name: 'Hesk', categoryId: 'character' },
      NOW
    )
    expect(yes.settled?.restaled).toHaveLength(1)
    const no = answerNameQuestion(db, { kind: 'notAName', name: 'Ry' }, NOW)
    expect(no.settled?.deleted).toHaveLength(1)
    expect(claimsNow().map((claim) => [claim.state, claim.pending])).toEqual([['stale', null]])
  })

  it('drops a new name the author dismissed, and one the manuscript does not write there', async () => {
    dismiss(
      db,
      {
        kind: 'name',
        key: dismissedKey({ kind: 'name', name: 'Hesk' }),
        label: 'Hesk: not a name',
        quote: 'Hesk'
      },
      NOW
    )
    saveDocument(db, one, doc(...SCENE, 'By then Hesk was a smuggler from the marsh.'))
    const ai = fakeAi((request) => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return {
        text: JSON.stringify({
          n: [
            {
              n: 'Hesk',
              p: 3,
              q: 'Hesk was a smuggler',
              c: [{ p: 3, s: 'role', v: 'a smuggler', q: 'Hesk was a smuggler from the marsh' }]
            },
            {
              n: 'Varn',
              p: 3,
              q: 'Hesk was a smuggler',
              c: [{ p: 3, s: 'role', v: 'a smuggler', q: 'Hesk was a smuggler from the marsh' }]
            }
          ]
        })
      }
    })
    await read(ai)
    expect(claimsNow()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ name: 2 })
  })

  it('drops a fact the author said is not right, by its value and its sentences', async () => {
    const shared = nameScanShared(db)
    dismiss(
      db,
      {
        kind: 'notRight',
        key: dismissedKey({
          kind: 'notRight',
          recordId: tomas,
          slot: 'clothing',
          value: 'a blue coat',
          stating: [gateText('Tomas wore a blue coat.', shared.index)]
        }),
        label: 'Tomas: a blue coat',
        quote: 'Tomas wore a blue coat'
      },
      NOW
    )
    await read(standard())
    expect(claimsNow().map((claim) => claim.slot)).toEqual(['eyes', 'location'])
  })

  it('answers an identical request from the local cache', async () => {
    const ai = standard()
    await read(ai)
    const sent = ai.requests.length
    // Forget the reading's results; the same messages go out again and hit the cache.
    session.connection.sqlite.exec('DELETE FROM claim; DELETE FROM card; DELETE FROM scene_read;')
    await read(ai)
    expect(ai.requests).toHaveLength(sent)
    expect(ai.ledger.filter((entry) => entry.cached)).toHaveLength(2)
    expect(claimsNow()).toHaveLength(3)
  })

  it('pauses on a local model that answers empty at its cap, storing nothing', async () => {
    const ai = fakeAi(() => ({ text: '', finishReason: 'length' }), { providerId: 'local' })
    expect(await read(ai)).toMatchObject({
      read: false,
      reason: 'localCutoff',
      model: 'gpt-5.4-mini'
    })
    expect(claimsNow()).toEqual([])
    expect(getSceneRead(db, one, activeDraftId(db))).toBeNull()
    expect(lastReading(db, one, activeDraftId(db))).toBeNull()
  })

  it('never reads an Idea scene or a node outside the manuscript', async () => {
    const chapter = getNode(db, one)?.parentId ?? ''
    const idea = createNode(db, 'novel', {
      parentId: chapter,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Idea'
    }).id
    saveDocument(db, idea, doc('Mara had blue eyes.'))
    setSceneMeta(db, idea, { ...parseStoredSceneMeta(null), status: 'idea' })
    const ai = standard()
    expect(
      await runReading(db, { ai: ai.deps }, { nodeId: idea, caretPara: null, requestId: 'r-3' })
    ).toEqual({ read: false, reason: 'notReadable' })
    expect(
      await runReading(db, { ai: ai.deps }, { nodeId: 'nope', caretPara: null, requestId: 'r-4' })
    ).toEqual({ read: false, reason: 'notReadable' })
    expect(ai.requests).toEqual([])
  })
})

describe('runReading: what changes under it, and what it cannot read (F-16.17, review 2026-10-12)', () => {
  it('stales what an edit saved while the checker was out leaves unproved, instead of storing it live', async () => {
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        // The author changes grey to brown mid-reading; the anchors job runs on that save.
        saveDocument(
          db,
          one,
          doc(SCENE[0] ?? '', "Mara's eyes were brown. She walked to the quay.", SCENE[2] ?? '')
        )
        runAnchors(db, one, NOW)
        return { text: verifyReply(request) }
      }
      return { text: readerReply(request, PLAN) }
    })
    await read(ai)
    expect(claimsNow().map((claim) => [claim.slot, claim.value, claim.state])).toEqual([
      ['eyes', 'grey', 'stale'],
      ['location', 'the quay', 'stale'],
      ['clothing', 'a blue coat', 'live']
    ])
    expect(invariants()).toEqual([])
  })

  it('parks what it wrote when the scene became an Idea while the requests were out', async () => {
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        setSceneMeta(db, one, { ...parseStoredSceneMeta(null), status: 'idea' })
        return { text: verifyReply(request) }
      }
      return { text: readerReply(request, PLAN) }
    })
    await read(ai)
    expect(claimsNow().map((claim) => claim.state)).toEqual(['stale', 'stale', 'stale'])
  })

  it('reads nothing from a reply that does not parse: the scene stays unread and is read again', async () => {
    const refusal = fakeAi(() => ({ text: 'Sorry, I cannot help with that.' }))
    const outcome = await read(refusal)
    expect(outcome).toMatchObject({ read: true, yields: { rejections: { unparsed: 1 } } })
    // Not cached: the same request is asked again, not answered with the same refusal.
    await read(refusal)
    expect(refusal.requests).toHaveLength(2)
    // The reading and its cost are kept; nothing counts as read.
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ unparsed: 1 })
    expect(getSceneRead(db, one, activeDraftId(db))).toBeNull()
    expect(claimsNow()).toEqual([])
    const good = standard()
    expect(await read(good)).toMatchObject({ read: true, purpose: 'first' })
    expect(good.requests.map(requestKind)).toContain('reader')
  })

  it('keeps the stale claims of a window whose reply does not parse, and reads the window again', async () => {
    await read(standard())
    saveDocument(
      db,
      one,
      doc(SCENE[0] ?? '', "Mara's eyes were brown. She walked to the quay.", SCENE[2] ?? '')
    )
    runAnchors(db, one, NOW)
    expect(claimsNow().filter((claim) => claim.state === 'stale')).toHaveLength(2)
    await read(fakeAi(() => ({ text: '' })))
    expect(claimsNow().filter((claim) => claim.state === 'stale')).toHaveLength(2)
    const again = standard()
    expect(await read(again)).toMatchObject({ read: true, purpose: 'window' })
    expect(again.requests.map(requestKind)).toContain('reader')
  })

  it('leaves the paragraphs of a retry that does not parse unread', async () => {
    let calls = 0
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      calls += 1
      if (calls === 1) {
        const whole = readerReply(request, PLAN)
        return { text: whole.slice(0, whole.indexOf('She walked') + 4), finishReason: 'length' }
      }
      return { text: 'I could not read that.' }
    })
    await read(ai)
    expect(claimsNow().map((claim) => claim.slot)).toEqual(['eyes'])
    // ¶2, the retry's, stays unread: not a whole read, and read again next time.
    const reading = lastReading(db, one, activeDraftId(db))
    expect(reading?.paras).toEqual([[0, 1]])
    expect(getSceneRead(db, one, activeDraftId(db))?.partials).toBe(1)
  })

  it('reads a cut-off reply’s piece again whole when it listed facts out of paragraph order', async () => {
    let calls = 0
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      calls += 1
      const reordered = [PLAN[2], PLAN[0], PLAN[1]].flatMap((claim) =>
        claim === undefined ? [] : [claim]
      )
      if (calls === 1) {
        const whole = readerReply(request, reordered)
        // Cut inside the third item: ¶2, then ¶1, salvaged.
        return { text: whole.slice(0, whole.indexOf('She walked') + 4), finishReason: 'length' }
      }
      return { text: readerReply(request, PLAN) }
    })
    await read(ai)
    const readers = ai.requests.filter((request) => requestKind(request) === 'reader')
    expect(readers).toHaveLength(2)
    expect([...sentParagraphs(nth(readers, 1)).keys()]).toEqual([0, 1, 2])
    expect(claimsNow().map((claim) => claim.slot)).toEqual(['eyes', 'location', 'clothing'])
  })

  it('locates a card field and who is on the page from page 2 in page 2’s own text', async () => {
    const filler = 'The tide ran out across the mudflats and the gulls followed it. '.repeat(20)
    const long = [
      ...SCENE,
      ...Array.from({ length: 8 }, () => filler.trim()),
      'Tomas waited at the harbour wall until dark.'
    ]
    saveDocument(db, one, doc(...long))
    scanNamesFor(db, one, NOW)
    const last = long.length - 1
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      const ids = rosterIds(request)
      const second = sentParagraphs(request).has(last)
      const card = second
        ? {
            ...CARD,
            where: ['the harbour wall', last, 'Tomas waited at the harbour wall'],
            present: [[ids.get('Tomas') ?? '', last, 'Tomas waited at the harbour wall']]
          }
        : { ...CARD, where: null }
      return { text: readerReply(request, PLAN, { card }) }
    })
    await read(ai)
    const readers = ai.requests.filter((request) => requestKind(request) === 'reader')
    expect(readers.length).toBeGreaterThan(1)
    const card = getCard(db, one, activeDraftId(db))
    expect(card?.line).toBe('Mara walks to the quay.')
    expect(card?.fields.where).toMatchObject({ value: 'the harbour wall', p: last })
    expect(card?.present).toEqual([
      { recordId: tomas, quote: 'Tomas waited at the harbour wall', p: last, verified: true }
    ])
    // The on-page check went in the batch of the page that gave it.
    const checks = ai.requests
      .filter((request) => requestKind(request) === 'verify')
      .flatMap((request) => sentChecks(request))
    expect(checks.find((check) => check.label === 'On the page')?.text).toContain('harbour wall')
  })
})

describe('runReading: the checker’s verdicts (F-16.17, review 2026-10-12)', () => {
  const TRAITS: PlannedClaim[] = [
    { p: 1, r: 'Mara Vell', s: 'location', v: 'the quay', q: 'She walked to the quay' },
    { p: 1, r: 'Mara Vell', s: 'traits', v: 'grey-eyed', q: "Mara's eyes were grey" },
    { p: 2, r: 'Tomas', s: 'traits', v: 'blue-coated', q: 'Tomas wore a blue coat' }
  ]

  it('asks again for the verdicts a cut-off reply left out', async () => {
    let calls = 0
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) !== 'verify') return { text: readerReply(request, TRAITS) }
      calls += 1
      if (calls === 1) {
        const whole = verifyReply(request)
        return { text: whole.slice(0, whole.indexOf('},{"i":2') + 1), finishReason: 'length' }
      }
      return { text: verifyReply(request) }
    })
    await read(ai)
    const checks = ai.requests.filter((request) => requestKind(request) === 'verify')
    expect(checks).toHaveLength(2)
    expect(sentChecks(nth(checks, 1))).toHaveLength(2)
    expect(claimsNow().map((claim) => [claim.slot, claim.state])).toEqual([
      ['traits', 'live'],
      ['location', 'live'],
      ['traits', 'live']
    ])
    expect(lastReading(db, one, activeDraftId(db))).toMatchObject({
      finishReason: 'length',
      yields: { cut: 1, verifySent: 3, verified: 3, rejected: 0 }
    })
  })

  it('never counts a fact the checker did not answer against it, and reads its paragraph again', async () => {
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) !== 'verify') return { text: readerReply(request, TRAITS) }
      const whole = verifyReply(request)
      // Every reply stops after its first verdict.
      return { text: whole.slice(0, whole.indexOf('},{"i":2') + 1), finishReason: 'length' }
    })
    await read(ai)
    const reading = lastReading(db, one, activeDraftId(db))
    expect(reading?.yields).toMatchObject({
      verifySent: 2,
      verified: 2,
      rejections: { unanswered: 1 },
      cut: 2
    })
    // ¶2 (Tomas) was not read through: it is read again.
    expect(reading?.paras).toEqual([[0, 1]])
    const again = standard()
    await read(again)
    const reader = again.requests.find((request) => requestKind(request) === 'reader')
    expect([...sentParagraphs(nth(reader === undefined ? [] : [reader], 0)).keys()]).toContain(2)
  })

  it('refuses a fact only the checker’s refusal of that very fact, not a neighbour on its quote', async () => {
    const dashing: PlannedClaim = {
      p: 2,
      r: 'Tomas',
      s: 'traits',
      v: 'dashing',
      q: 'Tomas wore a blue coat'
    }
    await read(standard([dashing]))
    expect(claimsNow().map((claim) => [claim.value, claim.state])).toEqual([['dashing', 'live']])
    // An edit two paragraphs up (its anchor holds): the window read proposes another value on the
    // same quote and says to drop c1.
    saveDocument(db, one, doc(SCENE[0] ?? '', "Mara's eyes were green. She walked to the quay.", SCENE[2] ?? ''))
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        return { text: verifyReply(request, () => ({ ok: false })) }
      }
      const tail = request.messages.at(-1)?.content ?? ''
      const short = /(c\d+) r\d+ traits “dashing”/.exec(tail)?.[1]
      return {
        text: readerReply(request, [{ ...dashing, v: 'shabby' }], {
          drop: short === undefined ? [] : [short]
        })
      }
    })
    await runReading(db, { ai: ai.deps }, { nodeId: one, caretPara: null, requestId: 'r-5' })
    expect(
      claimsNow()
        .filter((claim) => claim.slot === 'traits')
        .map((claim) => [claim.value, claim.state])
    ).toEqual([['dashing', 'live']])
  })

  it('pins first person to a speaker only in what the checker confirms is their line', async () => {
    saveDocument(db, one, doc('Tomas sat down.', '“I was born in Elsmere,” he said.'))
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request): FakeAnswer => {
      // The checker reads the line as narration: first person then points to nobody.
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return {
        text: readerReply(request, [
          {
            p: 1,
            r: 'Tomas',
            s: 'born',
            v: 'in Elsmere',
            q: 'I was born in Elsmere',
            voice: 'dialogue',
            sp: 'Tomas'
          }
        ])
      }
    })
    await read(ai)
    expect(claimsNow()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ subject: 1 })
  })

  it('refuses a pronoun whose one candidate the checker says does not fit', async () => {
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        return { text: verifyReply(request, () => ({ r: null })) }
      }
      return { text: readerReply(request, [PLAN[1] ?? PLAN[0] ?? ({} as PlannedClaim)]) }
    })
    await read(ai)
    expect(claimsNow()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ unconfirmed: 1 })
  })
})

describe('runReading: who a pronoun may mean (F-16.17, review 2026-10-12)', () => {
  it('offers every woman named before a man named last, so the checker can say both fit', async () => {
    const clara = record('Clara Pell', ['Clara'])
    saveDocument(
      db,
      one,
      doc('Clara and Lise sat by the window. Tomas brought the tea. She had green eyes.')
    )
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        // An honest checker: two women fit "She".
        return {
          text: verifyReply(request, (check) =>
            check.names.includes('Clara Pell') && check.names.includes('Lise') ? { r: null } : null
          )
        }
      }
      return {
        text: readerReply(request, [
          { p: 0, r: 'Clara Pell', s: 'eyes', v: 'green', q: 'She had green eyes' }
        ])
      }
    })
    await read(ai)
    const [check] = sentChecks(nth(ai.requests, 1))
    expect([...(check?.names ?? [])].sort()).toEqual(['Clara Pell', 'Lise', 'Tomas'])
    expect(check?.unnamed).toEqual([])
    const [claim] = claimsNow()
    expect(claim).toMatchObject({ recordId: null, state: 'waiting' })
    expect(claim?.pending).toEqual({ kind: 'subject', candidates: [tomas, clara, lise] })
  })

  it('refuses a fact whose sentence names someone the roster does not know (the twin rule)', async () => {
    const rynna = record('Rynna Falsire', ['Rynna'])
    saveDocument(db, one, doc('Rynna Falsire came in. Jem Falsire had green eyes.'))
    scanNamesFor(db, one, NOW)
    const ai = standard([
      { p: 0, r: 'Rynna Falsire', s: 'eyes', v: 'green', q: 'Jem Falsire had green eyes' }
    ])
    await read(ai)
    expect(ai.requests.map(requestKind)).toEqual(['reader'])
    expect(claimsNow().filter((claim) => claim.recordId === rynna)).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ subject: 1 })
  })

  it('offers a record the text points to only by a role, marked as not named there', async () => {
    saveDocument(
      db,
      one,
      doc('Tomas could never make his wife understand him. She had a quick temper.')
    )
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        // "his wife": the checker picks the marked record.
        return {
          text: verifyReply(request, (check) =>
            check.unnamed.length === 1 ? { r: check.unnamed[0] } : null
          )
        }
      }
      return {
        text: readerReply(request, [
          { p: 0, r: 'Lise', s: 'traits', v: 'a quick temper', q: 'She had a quick temper' }
        ])
      }
    })
    await read(ai)
    const [check] = sentChecks(nth(ai.requests, 1))
    expect(check?.names).toEqual(['Tomas', 'Lise'])
    expect(check?.unnamed).toHaveLength(1)
    expect(claimsNow().map((claim) => [claim.recordId, claim.slot, claim.state])).toEqual([
      [lise, 'traits', 'live']
    ])
    expect(invariants()).toEqual([])
  })
})

describe('runReading: new names (F-16.17, review 2026-10-12)', () => {
  /** A new name's item: the name, where it stands, and one role fact on the same quote. */
  const nameItem = (n: string, p: number, q: string, fact: string): Record<string, unknown> => ({
    n,
    p,
    q,
    c: [{ p, s: 'role', v: fact, q }]
  })
  const named = (n: string, p: number, q: string, fact: string): string =>
    JSON.stringify({ n: [nameItem(n, p, q, fact)] })

  it('drops a name seen only opening a sentence, and a titled look-alike no question asks about', async () => {
    saveDocument(
      db,
      one,
      doc('Hesk was a smuggler from the marsh.', 'At dusk Captain Vell was a smuggler too.')
    )
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return {
        text: JSON.stringify({
          n: [
            nameItem('Hesk', 0, 'Hesk was a smuggler from the marsh', 'a smuggler'),
            nameItem('Captain Vell', 1, 'Captain Vell was a smuggler too', 'a smuggler')
          ]
        })
      }
    })
    await read(ai)
    expect(claimsNow()).toEqual([])
    expect(lastReading(db, one, activeDraftId(db))?.yields.rejections).toEqual({ name: 2 })
  })

  it('makes a name two records share wait on them, for the scan to settle', async () => {
    const owners = ['Mr. Harrow', 'Mrs. Harrow'].map((name) => {
      const made = createRecord(
        db,
        { name, categoryId: 'character', aliases: [{ text: 'Harrow', shared: true }], force: true },
        NOW
      )
      if (!('record' in made)) throw new Error('blocked')
      return made.record.id
    })
    saveDocument(db, one, doc('At noon Harrow was a magistrate again.'))
    scanNamesFor(db, one, NOW)
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') return { text: verifyReply(request) }
      return { text: named('Harrow', 0, 'Harrow was a magistrate again', 'a magistrate') }
    })
    await read(ai)
    const [claim] = claimsNow()
    expect(claim).toMatchObject({ recordId: null, state: 'waiting', subjectText: 'Harrow' })
    expect(claim?.pending).toEqual({ kind: 'subject', candidates: [...owners].sort() })
  })

  it('settles facts waiting on a name once a record answers to it, however it was made', async () => {
    saveDocument(db, one, doc(...SCENE, 'By then Hesk was a smuggler from the marsh.'))
    scanNamesFor(db, one, NOW)
    await read(
      fakeAi((request): FakeAnswer => {
        if (requestKind(request) === 'verify') return { text: verifyReply(request) }
        return { text: named('Hesk', 3, 'Hesk was a smuggler from the marsh', 'a smuggler') }
      })
    )
    expect(claimsNow()).toMatchObject([{ state: 'waiting', pending: { kind: 'name' } }])
    // Made in the Story bible, not through the question: the name is on the roster now.
    const hesk = record('Hesk')
    expect(listNameQuestions(db).map((question) => question.name)).not.toContain('Hesk')
    const settled = settleOwnedNames(db, NOW)
    expect(settled.attached).toHaveLength(1)
    expect(claimsNow()).toMatchObject([{ recordId: hesk, state: 'live', pending: null }])
  })

  it('attaches a waiting fact stale when its scene is no longer readable', async () => {
    saveDocument(db, one, doc(...SCENE, 'By then Hesk was a smuggler from the marsh.'))
    scanNamesFor(db, one, NOW)
    await read(
      fakeAi((request): FakeAnswer => {
        if (requestKind(request) === 'verify') return { text: verifyReply(request) }
        return { text: named('Hesk', 3, 'Hesk was a smuggler from the marsh', 'a smuggler') }
      })
    )
    setSceneMeta(db, one, { ...parseStoredSceneMeta(null), status: 'idea' })
    const { settled } = answerNameQuestion(
      db,
      { kind: 'addAs', name: 'Hesk', categoryId: 'character' },
      NOW
    )
    expect(settled?.restaled).toHaveLength(1)
    expect(claimsNow().map((claim) => claim.state)).toEqual(['stale'])
  })
})

describe('runReading: slice 3 purposes and spot checks (F-16.16, F-16.17)', () => {
  it('rides a picked literal claim on the check batch as a fast spot check, counted only', async () => {
    const ai = fakeAi((request): FakeAnswer => {
      if (requestKind(request) === 'verify') {
        // The checker disagrees with code about the eyes: counted, the claim stays.
        return {
          text: verifyReply(request, (check) => (check.fact.startsWith('eyes') ? { ok: false } : null))
        }
      }
      return { text: readerReply(request, PLAN) }
    })
    await runReading(
      db,
      { ai: ai.deps },
      { nodeId: one, caretPara: null, requestId: 'r-spot', spotEvery: 1 }
    )
    const eyes = claimsNow().find((claim) => claim.slot === 'eyes')
    expect(eyes).toMatchObject({ proof: 'literal', state: 'live', spot: 'disagree', spotTier: 'fast' })
    const checked = ai.requests
      .filter((request) => requestKind(request) === 'verify')
      .flatMap((request) => sentChecks(request).map((check) => check.fact))
    expect(checked.some((fact) => fact.startsWith('eyes'))).toBe(true)
    // Its yields are the reader's: a spot check is neither sent nor verified.
    expect(lastReading(db, one, activeDraftId(db))?.yields.literal).toBeGreaterThan(0)
  })

  it('replaces on a rebuild what it does not prove again, and reads a back-fill’s paragraphs whatever the gate says', async () => {
    await read(standard())
    expect(claimsNow().map((claim) => claim.slot).sort()).toEqual(['clothing', 'eyes', 'location'])
    // A rebuild that finds only the eyes: the rest goes (P2a-D25).
    const rebuilt = await runReading(
      db,
      { ai: standard(PLAN.slice(0, 1)).deps },
      { nodeId: one, caretPara: null, requestId: 'r-rebuild', purpose: 'rebuild' }
    )
    expect(rebuilt).toMatchObject({ read: true, purpose: 'rebuild' })
    expect(claimsNow().map((claim) => claim.slot)).toEqual(['eyes'])
    // Up to date for the gate, yet a back-fill reads ¶2 ±2.
    const backfill = standard()
    const outcome = await runReading(
      db,
      { ai: backfill.deps },
      { nodeId: one, caretPara: null, requestId: 'r-backfill', purpose: 'backfill', paras: [2] }
    )
    expect(outcome).toMatchObject({ read: true, purpose: 'backfill' })
    const sent = backfill.requests.find((request) => requestKind(request) === 'reader')
    expect([...sentParagraphs(nth(sent === undefined ? [] : [sent], 0)).keys()]).toEqual([0, 1, 2])
    expect(claimsNow().map((claim) => claim.slot).sort()).toEqual(['clothing', 'eyes', 'location'])
  })
})
