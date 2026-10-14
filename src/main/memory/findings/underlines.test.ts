import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UnderlineMode } from '@shared/aiSettings'
import { gateSentences, nextReadSet } from '@shared/memory/gate'
import { SceneMemory } from '@shared/memory/views'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { createNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { nameScanShared } from '../nameIndexer'
import { createRecord, deleteRecord } from '../recordStore'
import { seedClaims, sceneTexts } from '../reading/claimFixture'
import { deleteClaims } from '../reading/claimStore'
import { wrongValue } from '../reading/notRight'
import { writeSceneRead } from '../reading/sceneReadStore'
import { sceneMemory } from '../reading/views'
import { findingNotProblem, findingRight } from './findingActions'
import { findingsOf, setVerdicts } from './findingStore'
import { runFindingsJob } from './findingsJob'
import {
  contradictionStats,
  getUnderlineLog,
  MEMORY_UNDERLINES_KEY,
  setUnderlineAsked,
  underlineNotice
} from './underlineLog'
import { sceneUnderlines, underlinesShown } from './underlines'
import { writeRow } from '../reading/readerRows'

/**
 * Contradiction underlines, main side (F-16.28; plan P4 §5.1, P4-D15, P4-D16): a scene's marks
 * from its open findings (at most 3, rule order then newest, never in a paragraph with an unread
 * change, none while the check is off or the panel-only mode is chosen), `shown_at` once, and the
 * precision log by how each underlined finding closed, with its one question.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let chapter: string
let one: string
let two: string
let mara: string

const NOW = new Date(Date.UTC(2026, 9, 14, 12, 0, 0))
const ON: { on: boolean; mode: UnderlineMode } = { on: true, mode: 'text' }

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

function record(name: string): string {
  const made = createRecord(db, { name, categoryId: 'character', force: true }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

/** The scene read whole as it is saved now (its sentences in the active draft's read set). */
function markRead(nodeId: string): void {
  const current = gateSentences(sceneTexts(db, nodeId), {
    caretPara: null,
    names: nameScanShared(db).index
  })
  writeSceneRead(
    db,
    {
      nodeId,
      draftId: activeDraftId(db),
      entries: nextReadSet(null, current, 'all'),
      full: true,
      readingId: null
    },
    NOW
  )
}

/** Every unjudged finding judged a contradiction in both orders. */
function judgeAll(): void {
  runFindingsJob(db, NOW, { cachedVerdicts: true })
  for (const finding of findingsOf(db, activeDraftId(db), ['unjudged'])) {
    setVerdicts(db, finding.id, { ab: 'c', ba: 'c', why: 'values differ', costUsd: 0, now: NOW })
  }
}

const open = (): ReturnType<typeof findingsOf> => findingsOf(db, activeDraftId(db), ['open'])

/** The scene's memory as `memory:scene` answers it, the underlines as the handler builds them. */
function scene(nodeId: string, options = ON): SceneMemory {
  return SceneMemory.parse(
    sceneMemory(db, nodeId, (unread) => sceneUnderlines(db, nodeId, unread, options))
  )
}

/** Mara's eyes grey in scene one (¶1), brown in scene two (¶1); both read and judged. */
function greyAndBrown(): void {
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
  markRead(one)
  markRead(two)
  judgeAll()
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-underlines-'))
  session = createProject(projectFolderFor(tmp, 'Underlines'), 'Underlines', 'novel', {
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
  saveDocument(db, one, doc('Mara walked in.', "Mara's eyes were grey."))
  saveDocument(db, two, doc('Hobb stood at the gate.', "Mara's eyes were brown."))
  mara = record('Mara')
})

afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('a scene’s underlines (P4-D15)', () => {
  it('marks each scene’s own quote of an open finding, with the finding to show beside it', () => {
    greyAndBrown()
    const [finding] = open()
    if (finding === undefined) throw new Error('no finding')
    expect(scene(one).underlines).toEqual([
      expect.objectContaining({ findingId: finding.id, side: 'a', para: 1, quote: "Mara's eyes were grey" })
    ])
    const [brown] = scene(two).underlines
    expect(brown).toMatchObject({ findingId: finding.id, side: 'b', para: 1 })
    expect(brown?.finding.a).toMatchObject({ value: 'grey', quote: "Mara's eyes were grey" })
    expect(brown?.finding.actions.right).toEqual({ a: true, b: true })
  })

  it('draws none while the check is off or contradictions show in the panel only, nor for a finding not open', () => {
    greyAndBrown()
    expect(scene(two, { on: false, mode: 'text' }).underlines).toEqual([])
    expect(scene(two, { on: true, mode: 'panel' }).underlines).toEqual([])
    const [finding] = open()
    if (finding === undefined) throw new Error('no finding')
    setVerdicts(db, finding.id, { ab: 'c', ba: 'u', why: null, costUsd: 0, now: NOW })
    expect(scene(two).underlines).toEqual([])
  })

  it('leaves out a paragraph with a finished sentence not read yet', () => {
    greyAndBrown()
    // A sentence added to the brown paragraph, saved but not read: its quote is not underlined,
    // and its scene still counts the unread sentence.
    saveDocument(
      db,
      two,
      doc('Hobb stood at the gate.', "Mara's eyes were brown. She looked away.")
    )
    const memory = scene(two)
    expect(memory.unread).toBe(1)
    expect(memory.underlines).toEqual([])
    // The other scene's quote is still underlined.
    expect(scene(one).underlines).toHaveLength(1)
    // Read again: drawn again.
    markRead(two)
    expect(scene(two).underlines).toHaveLength(1)
  })

  it('draws at most three marks, by rule order', () => {
    const others = ['Orrin', 'Bel', 'Tomas'].map((name) => record(name))
    saveDocument(
      db,
      one,
      doc(
        'Mara walked in.',
        "Mara's eyes were grey.",
        "Orrin's eyes were grey.",
        "Bel's eyes were grey.",
        "Tomas's eyes were grey."
      )
    )
    saveDocument(
      db,
      two,
      doc(
        "Mara's eyes were brown.",
        "Orrin's eyes were brown.",
        "Bel's eyes were brown.",
        "Tomas's eyes were brown."
      )
    )
    const names = ['Mara', 'Orrin', 'Bel', 'Tomas']
    const ids = [mara, ...others]
    names.forEach((name, i) => {
      const recordId = ids[i] ?? ''
      seedClaims(
        db,
        one,
        [{ recordId, slot: 'eyes', value: 'grey', quote: `${name}'s eyes were grey`, para: i + 1 }],
        NOW
      )
      seedClaims(
        db,
        two,
        [{ recordId, slot: 'eyes', value: 'brown', quote: `${name}'s eyes were brown`, para: i }],
        NOW
      )
    })
    markRead(one)
    markRead(two)
    judgeAll()
    expect(open()).toHaveLength(4)
    expect(scene(one).underlines).toHaveLength(3)
    expect(scene(two).underlines).toHaveLength(3)
  })
})

describe('shown, once', () => {
  it('sets shown_at the first time the editor draws a finding', () => {
    greyAndBrown()
    const [finding] = open()
    if (finding === undefined) throw new Error('no finding')
    expect(finding.shownAt).toBeNull()
    underlinesShown(db, [finding.id, finding.id], NOW)
    expect(open()[0]?.shownAt).toBe(NOW.toISOString())
    underlinesShown(db, [finding.id], new Date(Date.UTC(2026, 9, 15)))
    expect(open()[0]?.shownAt).toBe(NOW.toISOString())
  })
})

describe('the precision log (P4-D16)', () => {
  const shownFinding = (): string => {
    greyAndBrown()
    const [finding] = open()
    if (finding === undefined) throw new Error('no finding')
    underlinesShown(db, [finding.id], NOW)
    return finding.id
  }

  it('logs Not a problem against, only for a finding that was underlined', () => {
    greyAndBrown()
    const [unshown] = open()
    if (unshown === undefined) throw new Error('no finding')
    findingNotProblem(db, unshown.id, NOW)
    expect(getUnderlineLog(db).outcomes).toEqual([])
    // A fresh pair, underlined this time.
    saveDocument(db, two, doc('Hobb stood at the gate.', "Mara's eyes were green."))
    seedClaims(
      db,
      two,
      [{ recordId: mara, slot: 'eyes', value: 'green', quote: "Mara's eyes were green", para: 1 }],
      NOW
    )
    markRead(two)
    judgeAll()
    const shown = open().find((each) => each.id !== unshown.id)
    if (shown === undefined) throw new Error('no finding')
    underlinesShown(db, [shown.id], NOW)
    findingNotProblem(db, shown.id, NOW)
    expect(getUnderlineLog(db).outcomes).toEqual(['notProblem'])
  })

  it('logs This one’s right for', () => {
    const id = shownFinding()
    findingRight(db, id, 'b', NOW)
    expect(getUnderlineLog(db).outcomes).toEqual(['right'])
  })

  it('logs a fix in the text for, once a reading changed a side', () => {
    const id = shownFinding()
    const brown = findingsOf(db, activeDraftId(db)).find((each) => each.id === id)?.b
    if (brown?.kind !== 'claim') throw new Error('no claim side')
    // The author made the eyes grey; the reading dropped "brown" and stored "grey".
    saveDocument(db, two, doc('Hobb stood at the gate.', "Mara's eyes were grey."))
    deleteClaims(db, [brown.claimId])
    seedClaims(
      db,
      two,
      [{ recordId: mara, slot: 'eyes', value: 'grey', quote: "Mara's eyes were grey", para: 1 }],
      NOW
    )
    const result = runFindingsJob(db, NOW, { cachedVerdicts: true })
    expect(result.closed.map((each) => each.reason)).toEqual(['gone'])
    expect(getUnderlineLog(db).outcomes).toEqual(['right'])
  })

  it('adds nothing for Not right on a line, a deleted record, or a finding never underlined', () => {
    let id = shownFinding()
    const brown = findingsOf(db, activeDraftId(db)).find((each) => each.id === id)?.b
    if (brown?.kind !== 'claim') throw new Error('no claim side')
    // Not right › Wrong value on the brown line itself: a reader slip, not a fix in the text.
    wrongValue(db, brown.claimId, NOW)
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    expect(open()).toEqual([])
    expect(getUnderlineLog(db).outcomes).toEqual([])
    // A deleted record takes its findings with it.
    saveDocument(db, two, doc('Hobb stood at the gate.', "Mara's eyes were green."))
    seedClaims(
      db,
      two,
      [{ recordId: mara, slot: 'eyes', value: 'green', quote: "Mara's eyes were green", para: 1 }],
      NOW
    )
    markRead(two)
    judgeAll()
    id = open()[0]?.id ?? ''
    underlinesShown(db, [id], NOW)
    deleteRecord(db, mara)
    runFindingsJob(db, NOW, { cachedVerdicts: true })
    expect(getUnderlineLog(db).outcomes).toEqual([])
  })

  it('asks once, under 70 % right over the last 20, while contradictions are underlined', () => {
    const settings = { features: { judge: true }, reading: { underlines: 'text' as const } }
    expect(underlineNotice(db, settings)).toBeNull()
    writeRow(db, MEMORY_UNDERLINES_KEY, {
      outcomes: [...Array<string>(12).fill('right'), ...Array<string>(8).fill('notProblem')],
      asked: false
    })
    expect(underlineNotice(db, settings)).toEqual({
      id: 'underlinePrecision',
      kind: 'underlinePrecision',
      counted: 20,
      notProblems: 8
    })
    expect(underlineNotice(db, { ...settings, reading: { underlines: 'panel' } })).toBeNull()
    expect(underlineNotice(db, { ...settings, features: { judge: false } })).toBeNull()
    expect(contradictionStats(db).underlines).toEqual({ counted: 20, right: 12 })
    setUnderlineAsked(db)
    expect(underlineNotice(db, settings)).toBeNull()
    expect(getUnderlineLog(db).asked).toBe(true)
  })

  it('counts the pairs judged both ways and how many the two orders agreed on', () => {
    greyAndBrown()
    expect(contradictionStats(db)).toMatchObject({ pairs: 1, agreed: 1 })
    const [finding] = open()
    if (finding === undefined) throw new Error('no finding')
    setVerdicts(db, finding.id, { ab: 'c', ba: 'ok', why: null, costUsd: 0, now: NOW })
    expect(contradictionStats(db)).toMatchObject({ pairs: 1, agreed: 0 })
  })
})
