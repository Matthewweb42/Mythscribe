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
      promptVersion: 'reader.v1',
      verifyVersion: 'verify.v1',
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
      { p: 2, r: 'Tomas', s: 'knows', v: 'the secret', q: 'Tomas wore a blue coat' },
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
    saveDocument(db, one, doc(...SCENE, 'Hesk was a smuggler from the marsh.'))
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
    saveDocument(db, one, doc(...SCENE, 'Hesk was a smuggler from the marsh.', 'Ry was a boatman.'))
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
      doc(...SCENE, 'Hesk was a smuggler from the marsh, once.', 'Ry was a boatman.')
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
    saveDocument(db, one, doc(...SCENE, 'Hesk was a smuggler from the marsh.'))
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
