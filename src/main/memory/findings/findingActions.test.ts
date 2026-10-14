import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyCardFields, type ClaimMode, type ClaimVoice } from '@shared/memory/claims'
import { AI_FILED_ATTR, pageTextBlocks } from '@shared/memory/pageMarks'
import { NOTE_PATCH_MAX } from '@shared/memory/views'
import type { TiptapNodeT } from '@shared/tiptap'
import { getDocumentContent, saveDocument } from '../../document/documentStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { ensureResearchRoot } from '../../project/seed'
import { createResearchNote } from '../../research/researchStore'
import { createNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { undoDismissed } from '../dismissedStore'
import { indexNodePassages, indexStaleRecords } from '../passageIndexer'
import { createRecord, requireRecord, savePage } from '../recordStore'
import { upsertCard } from '../reading/cardStore'
import { cardAnchorOf, seedClaims } from '../reading/claimFixture'
import { getClaim } from '../reading/claimStore'
import {
  applyNotePatch,
  findingNotProblem,
  findingRight,
  looseEndNotProblem,
  looseEndsView,
  notePatch,
  type NoteWriters
} from './findingActions'
import { findingsOf, setVerdicts } from './findingStore'
import { findingsView } from './findingViews'
import { runFindingsJob } from './findingsJob'
import { judgeContext, pairItem } from './judge'
import { cacheVerdict } from './verdictCache'

/**
 * The answers on a finding (F-16.27, F-16.29; plan P4 §3.2, P4-D17, P4-D18): *Not a problem* is a
 * Dismissed row whose Undo brings the finding back from its remembered verdicts at no cost; *This
 * one's right* marks the other side not right through its own path (never the manuscript, never a
 * note conflict); *Update my note* is a code-made proposal, offered only when the book's side is
 * narration in `now` mode, saved through the page's own write and refused once the line moved.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let chapter: string
let one: string
let two: string
let orrin: string

const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0))

const doc = (...paragraphs: (string | TiptapNodeT)[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((each) =>
    typeof each === 'string' ? { type: 'paragraph', content: [{ type: 'text', text: each }] } : each
  )
})

function record(name: string): string {
  const made = createRecord(db, { name, categoryId: 'character', force: true }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

/** Every finding judged a contradiction in both orders (as the judge would, remembered too). */
function judgeAll(checkRules = false): void {
  runFindingsJob(db, NOW, { cachedVerdicts: true, checkRules })
  const draft = activeDraftId(db)
  const ctx = judgeContext(db, draft)
  for (const finding of findingsOf(db, draft, ['unjudged'])) {
    const pair = pairItem(ctx, finding)
    if (pair !== null) {
      for (const order of ['ab', 'ba'] as const) {
        cacheVerdict(
          db,
          {
            key: pair.keys[order],
            verdict: 'c',
            why: 'values differ',
            tier: 'fast',
            promptVersion: 'judge.v1',
            model: 'fake',
            costUsd: 0.0001
          },
          NOW
        )
      }
    }
    setVerdicts(db, finding.id, { ab: 'c', ba: 'c', why: 'values differ', costUsd: 0, now: NOW })
  }
}

const open = (): ReturnType<typeof findingsOf> => findingsOf(db, activeDraftId(db), ['open'])

const writers: NoteWriters = {
  read: (owner) =>
    owner.kind === 'record'
      ? requireRecord(db, owner.id).pinned
      : getDocumentContent(db, owner.id).content,
  pinned: (recordId, page) => void savePage(db, recordId, 'pinned', page, NOW),
  research: (nodeId, page) => void saveDocument(db, nodeId, page)
}

/**
 * `who`'s eyes grey in a scene of their own, as `voice` and `mode` say (Orrin's in scene one); the
 * Pinned page says green. Answers the open C6 finding's id.
 */
function noteConflict(
  voice: ClaimVoice = 'narration',
  mode: ClaimMode = 'now',
  who: { id: string; name: string } = { id: orrin, name: 'Orrin' }
): string {
  let nodeId = one
  if (who.id !== orrin) {
    nodeId = createNode(db, 'novel', {
      parentId: chapter,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: who.name
    }).id
    saveDocument(db, nodeId, doc(`${who.name}'s eyes were grey.`))
  }
  seedClaims(
    db,
    nodeId,
    [
      {
        recordId: who.id,
        slot: 'eyes',
        value: 'grey',
        quote: `${who.name}'s eyes were grey`,
        para: 0,
        voice,
        mode,
        ...(voice === 'dialogue' ? { speakerId: who.id } : {})
      }
    ],
    NOW
  )
  savePage(db, who.id, 'pinned', doc('Eyes: green'), NOW)
  indexStaleRecords(db, NOW)
  judgeAll()
  const found = open().find((each) => each.rule === 'C6' && each.recordId === who.id)
  if (found === undefined) throw new Error('no note conflict')
  return found.id
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-finding-actions-'))
  session = createProject(projectFolderFor(tmp, 'Answers'), 'Answers', 'novel', {
    storyMemoryOverride: 'v2'
  })
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  chapter = getNode(db, one)?.parentId ?? ''
  two = createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Two'
  }).id
  saveDocument(db, one, doc("Orrin's eyes were grey.", "Mara's eyes were grey."))
  saveDocument(db, two, doc('Hobb stood at the gate.', "Mara's eyes were brown."))
  orrin = record('Orrin')
})

afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Not a problem (P4-D14)', () => {
  it('writes one Dismissed row and closes the finding; Undo brings it back at no cost', () => {
    const mara = record('Mara')
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
    judgeAll()
    const [finding] = open()
    if (finding === undefined) throw new Error('no finding')
    const row = findingNotProblem(db, finding.id, NOW)
    expect(row).toMatchObject({
      kind: 'notProblem',
      key: finding.npKey,
      recordId: mara,
      label: expect.stringMatching(
        /^Mara: eyes grey \(.+\) and brown \(.+\): not a problem$/u
      ) as string,
      quote: "“Mara's eyes were grey” · “Mara's eyes were brown”"
    })
    expect(open()).toEqual([])
    // The recompute leaves it closed while the row stands.
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    expect(open()).toEqual([])
    // Undo: the next recompute brings it back from the remembered verdicts, nothing sent.
    undoDismissed(db, row.id)
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    expect(open()).toHaveLength(1)
    expect(open()[0]).toMatchObject({ verdictAb: 'c', verdictBa: 'c', costUsd: 0 })
    // A finding that is gone is NOT_FOUND.
    expect(() => findingNotProblem(db, finding.id, NOW)).toThrow(/NOT_FOUND|no longer there/u)
  })

  it('brings a C7 finding (Check the book’s) back on Undo too, with its verdicts, at no cost', () => {
    const tomas = record('Tomas')
    saveDocument(db, one, doc('His father kept a tavern in Vellmouth.'))
    saveDocument(db, two, doc('His father kept a forge in Vellmouth.'))
    for (const [nodeId, trade] of [
      [one, 'tavern'],
      [two, 'forge']
    ] as const) {
      seedClaims(
        db,
        nodeId,
        [
          {
            recordId: tomas,
            slot: 'history',
            value: `his father kept a ${trade} in Vellmouth`,
            quote: `His father kept a ${trade} in Vellmouth`,
            para: 0
          }
        ],
        NOW
      )
    }
    judgeAll(true)
    const c7 = open().find((each) => each.rule === 'C7')
    if (c7 === undefined) throw new Error('no C7 finding')
    const row = findingNotProblem(db, c7.id, NOW)
    expect(open().filter((each) => each.rule === 'C7')).toEqual([])
    undoDismissed(db, row.id)
    // The background recompute alone never finds C7 again ...
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    expect(open().filter((each) => each.rule === 'C7')).toEqual([])
    // ... the undone key does, from the remembered verdicts.
    runFindingsJob(db, NOW, { cachedVerdicts: true, restore: new Set([row.key]) })
    expect(open().filter((each) => each.rule === 'C7')).toEqual([
      expect.objectContaining({ verdictAb: 'c', verdictBa: 'c', costUsd: 0 })
    ])
  })
})

describe('This one’s right (P4-D17)', () => {
  it('marks the other line Wrong value, never the manuscript, and closes the finding', () => {
    const mara = record('Mara')
    const [grey] = seedClaims(
      db,
      one,
      [{ recordId: mara, slot: 'eyes', value: 'grey', quote: "Mara's eyes were grey", para: 1 }],
      NOW
    )
    const [brown] = seedClaims(
      db,
      two,
      [{ recordId: mara, slot: 'eyes', value: 'brown', quote: "Mara's eyes were brown", para: 1 }],
      NOW
    )
    judgeAll()
    const [finding] = open()
    if (finding === undefined) throw new Error('no finding')
    const before = JSON.stringify(getDocumentContent(db, two).content)
    // Grey (side a) is right: brown (side b) goes to Dismissed as a wrong value.
    const result = findingRight(db, finding.id, 'a', NOW)
    expect(result.dismissed).toMatchObject({ kind: 'notRight', recordId: mara })
    expect(result.other).toEqual({ nodeId: two, ref: expect.any(String) as string })
    expect(getClaim(db, brown ?? '')).toBeNull()
    expect(getClaim(db, grey ?? '')).not.toBeNull()
    expect(open()).toEqual([])
    expect(JSON.stringify(getDocumentContent(db, two).content)).toBe(before)
  })

  it('marks a presence not right through the card, and refuses a note conflict', () => {
    const hobb = record('Hobb')
    saveDocument(db, one, doc("Orrin's eyes were grey.", 'Hobb was dead.'))
    seedClaims(
      db,
      one,
      [{ recordId: hobb, slot: 'alive', value: 'dead', quote: 'Hobb was dead', para: 1 }],
      NOW
    )
    upsertCard(
      db,
      {
        nodeId: two,
        draftId: activeDraftId(db),
        readingId: null,
        line: 'At the gate.',
        gist: 'At the gate.',
        fields: emptyCardFields(),
        present: [{ recordId: hobb, quote: 'Hobb stood at the gate', p: 0, verified: true }],
        mood: null,
        theme: null,
        anchor: cardAnchorOf(db, two),
        seen: cardAnchorOf(db, two)
      },
      NOW
    )
    judgeAll()
    const dead = open().find((each) => each.rule === 'C2')
    if (dead === undefined) throw new Error('no C2 finding')
    const result = findingRight(db, dead.id, 'a', NOW)
    expect(result.dismissed).toMatchObject({
      kind: 'notRight',
      nodeId: two,
      key: `${hobb}|card|${two}|present`
    })
    expect(open().filter((each) => each.rule === 'C2')).toEqual([])

    const note = noteConflict()
    expect(() => findingRight(db, note, 'a', NOW)).toThrow(/canon side of a note conflict/u)
    expect(() => findingRight(db, note, 'b', NOW)).toThrow(/canon side of a note conflict/u)
  })
})

describe('Update my note (P4-D18)', () => {
  it('proposes the note line with the book’s value, and saves the author’s edit on Pinned', () => {
    const id = noteConflict()
    const patch = notePatch(db, id)
    expect(patch).toMatchObject({
      owner: { kind: 'record', id: orrin, name: 'Orrin' },
      page: 'pinned',
      index: 0,
      before: 'Eyes: green',
      after: 'Eyes: grey',
      sentence: 'Eyes: green',
      value: 'grey'
    })
    const applied = applyNotePatch(
      db,
      { findingId: id, index: 0, before: 'Eyes: green', text: 'Eyes: grey, like his mother’s' },
      writers,
      NOW
    )
    expect(applied).toEqual({ owner: { kind: 'record', id: orrin }, closed: true })
    const pinned = requireRecord(db, orrin).pinned
    expect(pinned === null ? [] : pageTextBlocks(pinned).map((block) => block.text)).toEqual([
      'Eyes: grey, like his mother’s'
    ])
    // The note agrees now: the recompute makes no new pair.
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    expect(findingsOf(db, activeDraftId(db)).filter((each) => each.rule === 'C6')).toEqual([])
  })

  it('clears the paragraph’s AI marks, and refuses once the line moved', () => {
    seedClaims(
      db,
      one,
      [{ recordId: orrin, slot: 'eyes', value: 'grey', quote: "Orrin's eyes were grey", para: 0 }],
      NOW
    )
    savePage(
      db,
      orrin,
      'pinned',
      doc({
        type: 'paragraph',
        attrs: { [AI_FILED_ATTR]: { doc: 'up', para: 0, quote: 'green' } },
        content: [{ type: 'text', text: "Orrin's green eyes." }]
      }),
      NOW
    )
    indexStaleRecords(db, NOW)
    judgeAll()
    const id = open().find((each) => each.rule === 'C6')?.id ?? ''
    const patch = notePatch(db, id)
    expect(patch?.after).toBe("Orrin's grey eyes.")
    // The page changed since the proposal: refused.
    expect(() =>
      applyNotePatch(
        db,
        { findingId: id, index: 0, before: 'Eyes: blue', text: "Orrin's grey eyes." },
        writers,
        NOW
      )
    ).toThrow(/That line changed since/u)
    applyNotePatch(
      db,
      { findingId: id, index: 0, before: patch?.before ?? '', text: patch?.after ?? '' },
      writers,
      NOW
    )
    const block = pageTextBlocks(requireRecord(db, orrin).pinned ?? doc())[0]?.block
    expect(block?.attrs?.[AI_FILED_ATTR] ?? null).toBeNull()
  })

  it('patches a Research page through its own save', () => {
    seedClaims(
      db,
      one,
      [{ recordId: orrin, slot: 'eyes', value: 'grey', quote: "Orrin's eyes were grey", para: 0 }],
      NOW
    )
    ensureResearchRoot(db, NOW)
    const page = createResearchNote(db, 'novel', { title: 'Harbour notes' }, NOW)
    saveDocument(db, page.id, doc('The harbour is cold.', 'Orrin has green eyes. He sails.'))
    indexNodePassages(db, page.id, NOW)
    judgeAll()
    const id = open().find((each) => each.rule === 'C6')?.id ?? ''
    const patch = notePatch(db, id)
    expect(patch).toMatchObject({
      owner: { kind: 'research', id: page.id, name: 'Harbour notes' },
      page: null,
      index: 1,
      after: 'Orrin has grey eyes. He sails.'
    })
    const applied = applyNotePatch(
      db,
      { findingId: id, index: 1, before: patch?.before ?? '', text: patch?.after ?? '' },
      writers,
      NOW
    )
    expect(applied.closed).toBe(true)
    const stored = getDocumentContent(db, page.id).content
    expect(stored === null ? [] : pageTextBlocks(stored).map((block) => block.text)).toEqual([
      'The harbour is cold.',
      'Orrin has grey eyes. He sails.'
    ])
  })

  it('changes only the value: the paragraph’s line breaks and marks stay as the author wrote them', () => {
    seedClaims(
      db,
      one,
      [{ recordId: orrin, slot: 'eyes', value: 'grey', quote: "Orrin's eyes were grey", para: 0 }],
      NOW
    )
    const italic = [{ type: 'italic' }]
    savePage(
      db,
      orrin,
      'pinned',
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Eyes: ' },
          { type: 'text', text: 'green', marks: italic },
          { type: 'hardBreak' },
          { type: 'text', text: 'Hair: dark', marks: [{ type: 'bold' }] }
        ]
      }),
      NOW
    )
    indexStaleRecords(db, NOW)
    judgeAll()
    const id = open().find((each) => each.rule === 'C6')?.id ?? ''
    const patch = notePatch(db, id)
    expect(patch).toMatchObject({
      before: 'Eyes: green\nHair: dark',
      after: 'Eyes: grey\nHair: dark'
    })
    // Not the proposal's paragraph: refused before anything is written.
    expect(() =>
      applyNotePatch(
        db,
        { findingId: id, index: 1, before: patch?.before ?? '', text: patch?.after ?? '' },
        writers,
        NOW
      )
    ).toThrow(/That line changed since/u)
    applyNotePatch(
      db,
      { findingId: id, index: 0, before: patch?.before ?? '', text: patch?.after ?? '' },
      writers,
      NOW
    )
    const block = pageTextBlocks(requireRecord(db, orrin).pinned ?? doc())[0]?.block
    expect(block?.content).toEqual([
      { type: 'text', text: 'Eyes: ' },
      { type: 'text', text: 'grey', marks: italic },
      { type: 'hardBreak' },
      { type: 'text', text: 'Hair: dark', marks: [{ type: 'bold' }] }
    ])
  })

  it('is not offered for a paragraph longer than its save takes, and the view agrees', () => {
    seedClaims(
      db,
      one,
      [{ recordId: orrin, slot: 'eyes', value: 'grey', quote: "Orrin's eyes were grey", para: 0 }],
      NOW
    )
    ensureResearchRoot(db, NOW)
    const page = createResearchNote(db, 'novel', { title: 'Long source' }, NOW)
    const filler = 'The tide came in over the flats. '.repeat(Math.ceil(NOTE_PATCH_MAX / 33))
    saveDocument(db, page.id, doc(`Orrin has green eyes. ${filler}`))
    indexNodePassages(db, page.id, NOW)
    judgeAll()
    const finding = open().find((each) => each.rule === 'C6')
    if (finding === undefined) throw new Error('no note conflict')
    expect(notePatch(db, finding.id)).toBeNull()
    const view = findingsView(db, one, { on: true, judging: false }).open.find(
      (each) => each.id === finding.id
    )
    expect(view?.actions.updateNote).toBe(false)
    expect(() =>
      applyNotePatch(db, { findingId: finding.id, index: 0, before: 'x', text: 'y' }, writers, NOW)
    ).toThrow(/not offered/u)
  })

  it('is not offered when the book’s side is speech, rumour, a memory, a thought or a dream', () => {
    const cases: [ClaimVoice, ClaimMode][] = [
      ['dialogue', 'now'],
      ['rumour', 'now'],
      ['narration', 'memory'],
      ['thought', 'now'],
      ['narration', 'dream']
    ]
    for (const [i, [voice, mode]] of cases.entries()) {
      const name = `Witness${i + 1}`
      const id = noteConflict(voice, mode, { id: record(name), name })
      expect(notePatch(db, id), `${voice} ${mode}`).toBeNull()
    }
    // Narration now: offered.
    expect(notePatch(db, noteConflict())).not.toBeNull()
  })
})

describe('memory:findings for the chat’s scoped answer (P4-D23)', () => {
  it('says whether the check is on and what of the asked scene is not read yet', () => {
    expect(findingsView(db, two, { on: false, judging: false })).toMatchObject({
      on: false,
      open: [],
      scene: null
    })
    const view = findingsView(db, two, { on: true, judging: false })
    expect(view).toMatchObject({ on: true, scene: { read: false, unread: 2 } })
    expect(findingsView(db, null, { on: true, judging: false }).scene).toBeNull()
  })
})

describe('loose ends (F-16.29)', () => {
  it('lists a planned card before the furthest drafted scene, and Not a problem keeps it out', () => {
    const planned = createNode(db, 'novel', {
      parentId: chapter,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'The reckoning',
      afterId: one
    }).id
    const view = looseEndsView(db)
    expect(view.items).toEqual([
      expect.objectContaining({
        kind: 'planned',
        id: planned,
        name: 'The reckoning',
        ask: "Which drafted scene covers the plan 'The reckoning'?"
      })
    ])
    const row = looseEndNotProblem(db, { kind: 'planned', id: planned, lastNodeId: null }, NOW)
    expect(row).toMatchObject({
      kind: 'notProblem',
      label: 'Loose end: planned scene “The reckoning”: not a problem'
    })
    expect(looseEndsView(db).items).toEqual([])
    undoDismissed(db, row.id)
    expect(looseEndsView(db).items).toHaveLength(1)
  })

  it('answers NOT_FOUND for a planned card or a last scene deleted since the list was read', () => {
    expect(() =>
      looseEndNotProblem(db, { kind: 'planned', id: 'gone-node', lastNodeId: null }, NOW)
    ).toThrow(/no longer there/u)
    expect(() =>
      looseEndNotProblem(db, { kind: 'thread', id: orrin, lastNodeId: 'gone-node' }, NOW)
    ).toThrow(/no longer there/u)
  })
})
