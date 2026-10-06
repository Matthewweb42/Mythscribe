import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AI_ORIGIN_MARK } from '@shared/provenance'
import { computeStylometrics } from '@shared/stylometry'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  VOICE_AUTO_EXEMPLAR_MAX,
  VOICE_AUTO_PASSAGE_MAX,
  VOICE_AUTO_PASSAGE_MIN,
  VOICE_AUTO_REFRESH_WORDS
} from '@shared/voice'
import { saveDocument } from '../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getVoiceAutoState } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import {
  authorPassages,
  autoExemplarsDue,
  leadingSentences,
  refreshAutoExemplars,
  selectAutoExemplars,
  type AuthorPassage
} from './autoExemplars'
import { addExemplar, listExemplars, passageHash, removeExemplar } from './exemplarStore'
import { manuscriptDocuments } from './profile'
import { resetVoiceProfileCache } from './versionCache'

const para = (text: string, marks?: TiptapNodeT['marks']): TiptapNodeT => ({
  type: 'paragraph',
  content: [{ type: 'text', text, ...(marks ? { marks } : {}) }]
})
const doc = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'doc', content })

/** ~260 characters of past-tense narration. */
const NARRATION =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited for the ' +
  'boat that never came, counting the slow seconds between the gusts.'
/** ~250 characters of interiority. */
const INTERIOR =
  'She knew she was tired, and she thought about the river and what it wanted from her. She ' +
  'wondered whether he remembered the elm, and she felt the old fear return, and she hoped, ' +
  'without believing it, that she had misunderstood him.'
/** A heading: any block that is not a paragraph closes a run. */
const BREAK: TiptapNodeT = { type: 'heading', content: [{ type: 'text', text: 'Break' }] }
/** ~240 characters of action. */
const ACTION =
  'She grabbed the rope and pulled. The boat lurched, slammed into the post, and she jumped, ' +
  'landed hard, rolled, and ran for the trees while he shouted and fired twice into the dark ' +
  'behind her, and she ducked and kept running.'
const DIALOGUE_LINES = [
  '"You came alone," Tomas said.',
  '"You said to," she said.',
  '"The river is up. Nobody crosses tonight," he said.',
  '"Then we talk here," she said.',
  '"Your brother owes the mill, and the mill owes me," he said.',
  '"That is not the whole of it," Mara said.',
  '"He took the ledger," Tomas said. "I want it back."',
  '"He copied it. He took nothing," she said.'
]

describe('authorPassages (F-14.14)', () => {
  it('keeps a paragraph of the right length whole and joins short ones into one run', () => {
    const passages = authorPassages(
      'n1',
      'Mara',
      doc(para(NARRATION), BREAK, ...DIALOGUE_LINES.map((l) => para(l)))
    )
    expect(passages[0]).toEqual({ nodeId: 'n1', pov: 'Mara', text: NARRATION })
    const joined = passages.slice(1).map((p) => p.text)
    expect(joined.length).toBeGreaterThan(0)
    expect(joined[0]?.startsWith(DIALOGUE_LINES[0] ?? '')).toBe(true)
    expect(joined[0]).toContain('\n')
    for (const text of joined) {
      expect(text.length).toBeGreaterThanOrEqual(VOICE_AUTO_PASSAGE_MIN)
      expect(text.length).toBeLessThanOrEqual(VOICE_AUTO_PASSAGE_MAX)
    }
  })

  it('never takes a paragraph with AI-origin text, and lets it break the run', () => {
    const ai = para(NARRATION, [
      { type: AI_ORIGIN_MARK, attrs: { proposalId: 'p1', accepted: 10 } }
    ])
    const passages = authorPassages('n1', null, doc(ai, para(ACTION)))
    expect(passages.map((p) => p.text)).toEqual([ACTION])
  })

  it('takes imported paragraphs: they are the author’s', () => {
    const imported: TiptapNodeT = { ...para(NARRATION), attrs: { origin: 'imported' } }
    expect(authorPassages('n1', null, doc(imported)).map((p) => p.text)).toEqual([NARRATION])
  })

  it('cuts a long paragraph to its leading whole sentences and drops short leftovers', () => {
    const long = `${NARRATION} ${ACTION} ${NARRATION} ${ACTION}`
    const [passage] = authorPassages('n1', null, doc(para(long)))
    expect(passage?.text.length).toBeLessThanOrEqual(VOICE_AUTO_PASSAGE_MAX)
    expect(passage?.text.endsWith('.')).toBe(true)
    expect(authorPassages('n1', null, doc(para('Too short.')))).toEqual([])
  })

  it('closes a run at any block that is not a paragraph and steps over empty paragraphs', () => {
    const heading: TiptapNodeT = { type: 'heading', content: [{ type: 'text', text: 'Part' }] }
    const passages = authorPassages(
      'n1',
      null,
      doc(
        para('First line of the run, a short one.'),
        { type: 'paragraph' },
        heading,
        para(NARRATION)
      )
    )
    expect(passages.map((p) => p.text)).toEqual([NARRATION])
  })
})

describe('leadingSentences', () => {
  it('answers the whole sentences that fit, or nothing when the first does not', () => {
    expect(leadingSentences('One. Two two. Three three three.', 14)).toBe('One. Two two.')
    expect(leadingSentences('A very long first sentence.', 5)).toBe('')
  })
})

describe('selectAutoExemplars (F-14.14)', () => {
  const profile = computeStylometrics([NARRATION, ACTION, DIALOGUE_LINES.join('\n')].join('\n\n'))
  const passage = (nodeId: string, text: string, pov: string | null = null): AuthorPassage => ({
    nodeId,
    pov,
    text
  })
  const none = { dismissed: new Set<string>(), authorTexts: [] }

  it('cycles through the kinds so the set is balanced', () => {
    const picks = selectAutoExemplars(
      [
        passage('a', ACTION),
        passage('b', `${ACTION} Again.`),
        passage('c', INTERIOR),
        passage('d', DIALOGUE_LINES.join('\n'))
      ],
      profile,
      { ...none, max: 3 }
    )
    expect(new Set(picks.map((p) => p.kind)).size).toBe(3)
  })

  it('spreads across scenes before taking a second passage from one', () => {
    const picks = selectAutoExemplars(
      [
        passage('a', ACTION),
        passage('a', `${ACTION} Again.`),
        passage('b', `${ACTION} Once more.`)
      ],
      profile,
      { ...none, max: 2 }
    )
    expect(picks.map((p) => p.nodeId).sort()).toEqual(['a', 'b'])
  })

  it('skips removed passages and passages a hand-marked exemplar already holds', () => {
    const picks = selectAutoExemplars(
      [passage('a', NARRATION), passage('b', ACTION), passage('c', DIALOGUE_LINES.join('\n'))],
      profile,
      {
        max: 6,
        dismissed: new Set([passageHash(NARRATION)]),
        authorTexts: [`${ACTION} And the marked passage went on.`]
      }
    )
    expect(picks.map((p) => p.nodeId)).toEqual(['c'])
  })

  it('answers no more than asked, and nothing for no passages', () => {
    const many = Array.from({ length: 20 }, (_, i) => passage(`n${i}`, `${NARRATION} ${i}.`))
    expect(selectAutoExemplars(many, profile, { ...none, max: 4 })).toHaveLength(4)
    expect(selectAutoExemplars([], profile, { ...none, max: 4 })).toEqual([])
  })
})

describe('autoExemplarsDue', () => {
  it('is due before the first pick and after the threshold of change either way', () => {
    expect(autoExemplarsDue(null, 0)).toBe(true)
    expect(autoExemplarsDue(1_000, 1_000 + VOICE_AUTO_REFRESH_WORDS - 1)).toBe(false)
    expect(autoExemplarsDue(1_000, 1_000 + VOICE_AUTO_REFRESH_WORDS)).toBe(true)
    expect(autoExemplarsDue(5_000, 5_000 - VOICE_AUTO_REFRESH_WORDS)).toBe(true)
  })
})

describe('refreshAutoExemplars (F-14.14)', () => {
  let tmp: string
  let session: ProjectSession
  let db: TreeDb
  let scene: string
  const NOW = new Date('2099-01-01T09:00:00.000Z')

  beforeEach(() => {
    resetVoiceProfileCache()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-autovoice-'))
    session = createProject(projectFolderFor(tmp, 'Auto voice'), 'Auto voice', 'novel')
    db = session.connection.orm
    scene = manuscriptDocuments(db)[0]?.id ?? ''
    if (!scene) throw new Error('skeleton not seeded')
  })
  afterEach(() => {
    session.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('picks on the first run, then waits for the threshold, and never repicks a removed passage', () => {
    saveDocument(
      db,
      scene,
      doc(para(NARRATION), para(ACTION), ...DIALOGUE_LINES.map((l) => para(l)))
    )
    const first = refreshAutoExemplars(db, NOW)
    expect(first).toMatchObject({ ran: true, changed: true })
    const auto = listExemplars(db).filter((e) => e.source === 'auto')
    expect(auto.length).toBeGreaterThan(0)
    expect(auto.length).toBeLessThanOrEqual(VOICE_AUTO_EXEMPLAR_MAX)
    expect(auto.every((e) => e.nodeId === scene)).toBe(true)
    expect(getVoiceAutoState(db).basedOnWords).toBe(first.words)

    expect(refreshAutoExemplars(db, NOW)).toEqual({
      ran: false,
      changed: false,
      words: first.words
    })

    const removed = auto[0]
    if (!removed) throw new Error('no pick')
    removeExemplar(db, removed.id)
    refreshAutoExemplars(db, NOW, { force: true })
    expect(listExemplars(db).map((e) => e.text)).not.toContain(removed.text)
  })

  it('leaves hand-marked exemplars alone and does not pick their passage again', () => {
    saveDocument(db, scene, doc(para(NARRATION), BREAK, para(ACTION)))
    const own = addExemplar(db, scene, NARRATION)
    refreshAutoExemplars(db, NOW)
    const rows = listExemplars(db)
    expect(rows[0]).toEqual(own)
    expect(rows.filter((e) => e.source === 'auto').map((e) => e.text)).toEqual([ACTION])
  })
})
