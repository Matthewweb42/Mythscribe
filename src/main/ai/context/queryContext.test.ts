import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { QUERY_FULL_SCENES, QUERY_SCENE_CHAR_BUDGET, QUERY_SUMMARY_SCENES } from '@shared/query'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import type { StoredSceneSummary } from '@shared/summary'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { upsertSummary } from '../../document/summaryStore'
import { createEntity } from '../../entity/entityStore'
import {
  listFactsForEntity,
  replaceSceneFacts,
  setFactHidden
} from '../../entity/observedFactStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { addDocumentTag } from '../../tag/documentTagStore'
import { createTag } from '../../tag/tagStore'
import type { TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import {
  namedEntities,
  queryTerms,
  rankCandidates,
  sceneTitles,
  scoreCandidate,
  QUERY_WEIGHTS,
  type CandidateFields
} from './queryContext'

let tmp: string
let session: ProjectSession
let db: TreeDb
/** The first four manuscript documents in reading order. */
let scenes: string[]

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const summaryRow = (nodeId: string, summary: string): StoredSceneSummary => ({
  nodeId,
  contentHash: `hash-${nodeId}`,
  summary,
  keyPoints: ['The ledger is a copy.'],
  characters: ['Mara'],
  promptVersion: 'summary.v1',
  model: 'gpt-fake',
  truncated: false,
  createdAt: '2026-09-15T00:00:00.000Z'
})

const fields = (over: Partial<CandidateFields> = {}): CandidateFields => ({
  title: '',
  tags: [],
  meta: '',
  summary: '',
  body: '',
  ...over
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-queryctx-'))
  session = createProject(projectFolderFor(tmp, 'Query'), 'Query', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db)
    .slice(0, 4)
    .map((row) => row.id)
  if (scenes.length !== 4) throw new Error('skeleton not seeded')
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('queryTerms (F-5.7)', () => {
  it('lower-cases, splits on anything that is not a letter or a digit, and deduplicates', () => {
    expect(queryTerms('Where does Mara hide the ledger — the LEDGER, I mean?')).toEqual([
      'mara',
      'hide',
      'ledger',
      'mean'
    ])
  })

  it('drops tokens under three characters and the stopwords, so a question can end up with none', () => {
    expect(queryTerms('Who did she go to in that scene?')).toEqual([])
    expect(queryTerms('What happens in chapter 12?')).toEqual(['happens'])
  })

  it('keeps accented words whole rather than splitting them', () => {
    expect(queryTerms('Where is the café by the étang?')).toEqual(['café', 'étang'])
  })
})

describe('scoreCandidate (F-5.7)', () => {
  it('weights a hit by where it landed, and counts each term once per field', () => {
    expect(scoreCandidate(['ferry'], [], fields({ title: 'The ferry landing' }))).toBe(
      QUERY_WEIGHTS.title
    )
    expect(scoreCandidate(['ferry'], [], fields({ tags: ['ferry-landing'] }))).toBe(
      QUERY_WEIGHTS.tag
    )
    expect(scoreCandidate(['ferry'], [], fields({ meta: 'The ferry landing' }))).toBe(
      QUERY_WEIGHTS.meta
    )
    expect(scoreCandidate(['ferry'], [], fields({ summary: 'Mara waits at the ferry.' }))).toBe(
      QUERY_WEIGHTS.summary
    )
  })

  it('adds a little for a term repeated in the body, up to ten occurrences', () => {
    const once = scoreCandidate(['ferry'], [], fields({ body: 'The ferry was late.' }))
    expect(once).toBeCloseTo(QUERY_WEIGHTS.body + 0.1)
    const many = scoreCandidate(['ferry'], [], fields({ body: 'ferry '.repeat(40) }))
    expect(many).toBeCloseTo(QUERY_WEIGHTS.body + 1)
  })

  it('matches a word prefix only, so a mention inside another word does not count', () => {
    expect(scoreCandidate(['mar'], [], fields({ body: 'Mara turned.' }))).toBeCloseTo(
      QUERY_WEIGHTS.body + 0.1
    )
    expect(scoreCandidate(['ara'], [], fields({ body: 'Mara turned.' }))).toBe(0)
  })

  it('adds the reference weight for a #name the author typed that the document carries', () => {
    expect(scoreCandidate([], ['mara'], fields({ tags: ['mara', 'ferry'] }))).toBe(
      QUERY_WEIGHTS.ref
    )
    expect(scoreCandidate([], ['tomas'], fields({ tags: ['mara'] }))).toBe(0)
  })

  it('scores nothing for a question with no usable term', () => {
    expect(scoreCandidate([], [], fields({ body: 'Anything at all.' }))).toBe(0)
  })
})

describe('rankCandidates (F-5.7)', () => {
  it('ranks the scenes a question names above the ones that only mention it, and skips empty ones', () => {
    saveDocument(
      db,
      scenes[0]!,
      doc('The ledger sat on the mill desk. She copied the ledger twice.')
    )
    saveDocument(db, scenes[1]!, doc('Mara crossed the yard. Nobody spoke of the ledger.'))
    // scenes[2] stays empty: an unwritten scene is not a candidate.
    const result = rankCandidates(db, { question: 'Where is the ledger kept?', nodeId: null })
    expect(result.ranked.map((candidate) => candidate.nodeId)).toEqual([scenes[0], scenes[1]])
    expect(result.ranked[0]!.score).toBeGreaterThan(result.ranked[1]!.score)
    expect(result.full.map((candidate) => candidate.title)).toEqual([
      'Chapter 1 › Scene 1',
      'Chapter 2 › Scene 1'
    ])
  })

  it('lets a #name reference that matches a document tag outrank a body mention', () => {
    saveDocument(db, scenes[0]!, doc('The ledger. The ledger. The ledger again.'))
    saveDocument(db, scenes[1]!, doc('Mara said nothing about it.'))
    const tag = createTag(db, { name: 'ledger', category: 'plotThread' })
    addDocumentTag(db, scenes[1]!, tag.id)
    const result = rankCandidates(db, { question: 'What about #ledger?', nodeId: null })
    expect(result.ranked[0]!.nodeId).toBe(scenes[1])
  })

  it('breaks a tie for the scene the author has open, and keeps reading order otherwise', () => {
    const text = 'Mara watched the river.'
    saveDocument(db, scenes[0]!, doc(text))
    saveDocument(db, scenes[1]!, doc(text))
    saveDocument(db, scenes[2]!, doc(text))
    const question = 'What does Mara watch?'
    expect(rankCandidates(db, { question, nodeId: null }).ranked.map((c) => c.nodeId)).toEqual(
      scenes.slice(0, 3)
    )
    expect(
      rankCandidates(db, { question, nodeId: scenes[2]! }).ranked.map((c) => c.nodeId)
    ).toEqual([scenes[2], scenes[0], scenes[1]])
  })

  it('falls back to the active scene and then reading order when nothing scores at all', () => {
    saveDocument(db, scenes[0]!, doc('The storm broke at dusk.'))
    saveDocument(db, scenes[1]!, doc('The storm broke at dusk.'))
    const result = rankCandidates(db, { question: 'Who did she go to?', nodeId: scenes[1]! })
    expect(result.ranked.map((candidate) => candidate.nodeId)).toEqual([scenes[1], scenes[0]])
    expect(result.ranked.every((candidate) => candidate.score === 0)).toBe(true)
  })

  it('answers nothing at all for a manuscript with no written scene', () => {
    expect(rankCandidates(db, { question: 'Anything?', nodeId: null })).toEqual({
      full: [],
      summaries: [],
      ranked: [],
      bible: []
    })
  })

  it('scores the stored summary and the scene metadata, not only the body', () => {
    saveDocument(db, scenes[0]!, doc('She said nothing on the way back.'))
    upsertSummary(db, summaryRow(scenes[0]!, 'Mara buries the ledger under the elm.'))
    saveDocument(db, scenes[1]!, doc('The yard was quiet.'))
    setSceneMeta(db, scenes[1]!, {
      location: 'The elm in the north pasture',
      pov: '',
      timeline: '',
      brief: EMPTY_SCENE_BRIEF
    })
    const ranked = rankCandidates(db, {
      question: 'Which scene happens at the elm?',
      nodeId: null
    }).ranked
    // The metadata hit (3) outweighs the summary hit (2); neither scene says "elm" in its body.
    expect(ranked.map((candidate) => candidate.nodeId)).toEqual([scenes[1], scenes[0]])
  })

  it('sends the top matches in full and the next candidates only if they have a stored summary', () => {
    const documents = manuscriptDocuments(db)
    expect(documents.length).toBeGreaterThan(QUERY_FULL_SCENES)
    documents.forEach((row, index) => {
      saveDocument(db, row.id, doc(`Mara counted ${index} lanterns on the ferry.`))
      if (index % 2 === 0) upsertSummary(db, summaryRow(row.id, `Mara counts lanterns ${index}.`))
    })
    const result = rankCandidates(db, { question: 'How many lanterns?', nodeId: null })
    expect(result.full).toHaveLength(QUERY_FULL_SCENES)
    expect(result.summaries.length).toBeLessThanOrEqual(QUERY_SUMMARY_SCENES)
    expect(result.summaries.every((candidate) => candidate.summary !== null)).toBe(true)
    // The summaries come from the ranks below the full ones, never from a scene sent in full.
    const full = new Set(result.full.map((candidate) => candidate.nodeId))
    expect(result.summaries.some((candidate) => full.has(candidate.nodeId))).toBe(false)
  })

  it('head-truncates a long scene to the character budget before it is sent', () => {
    saveDocument(db, scenes[0]!, doc(`The ferry ${'x'.repeat(QUERY_SCENE_CHAR_BUDGET)}`))
    const result = rankCandidates(db, { question: 'What about the ferry?', nodeId: null })
    expect(result.full[0]!.text).toHaveLength(QUERY_SCENE_CHAR_BUDGET + 1)
    expect(result.full[0]!.text.endsWith('…')).toBe(true)
    // The ranked list keeps the whole text; only the copy that is sent is cut.
    expect(result.ranked[0]!.text.length).toBeGreaterThan(QUERY_SCENE_CHAR_BUDGET)
  })
})

describe('sceneTitles (F-14.11, shared with F-5.7)', () => {
  it('names a scene by its chapter, and a top-level document by itself', () => {
    const title = sceneTitles(db)
    expect(title(scenes[0]!)).toBe('Chapter 1 › Scene 1')
    expect(title('nope')).toBe('')
  })
})

describe('the story bible in the retrieval (F-5.16)', () => {
  const AGE = 'She was nineteen that spring.'

  it('names the entities a question term starts a word of, or a #ref is the tag of', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara Vell' }).entity
    const mill = createEntity(db, { kind: 'setting', name: 'The Old Mill' }).entity
    createEntity(db, { kind: 'character', name: 'Tomas' })
    const all = [mara, mill]
    expect(namedEntities(all, ['vell'], []).map((entity) => entity.name)).toEqual(['Mara Vell'])
    expect(namedEntities(all, ['mil'], []).map((entity) => entity.name)).toEqual(['The Old Mill'])
    expect(namedEntities(all, ['ara'], [])).toEqual([])
    expect(namedEntities(all, [], ['the-old-mill']).map((entity) => entity.name)).toEqual([
      'The Old Mill'
    ])
  })

  it('boosts the scene a fact about a named entity was read from, so it goes out in full', () => {
    // Four scenes name Mara equally; the fact was read from the last, which would otherwise
    // rank fourth and ride along as nothing at all (it has no summary).
    for (const id of scenes) saveDocument(db, id, doc(`Mara waited. ${AGE}`))
    const mara = createEntity(db, { kind: 'character', name: 'Mara' }).entity
    expect(
      rankCandidates(db, { question: 'How old is Mara?', nodeId: null }).full.map((c) => c.nodeId)
    ).toEqual(scenes.slice(0, QUERY_FULL_SCENES))
    replaceSceneFacts(db, scenes[3]!, [
      { entityId: mara.id, attribute: 'age', value: 'nineteen', quote: AGE }
    ])
    const ranked = rankCandidates(db, { question: 'How old is Mara?', nodeId: null })
    expect(ranked.full[0]?.nodeId).toBe(scenes[3])
    expect(ranked.full[0]!.score - ranked.full[1]!.score).toBeCloseTo(QUERY_WEIGHTS.fact)
    // A question that does not name her gets neither the boost nor the bible.
    const other = rankCandidates(db, { question: 'Who waited?', nodeId: null })
    expect(other.full[0]?.nodeId).toBe(scenes[0])
    expect(other.bible).toEqual([])
  })

  it('answers the named entities as sheet and observed facts, each fact with its scene title', () => {
    saveDocument(db, scenes[0]!, doc(`Mara waited. ${AGE}`))
    const mara = createEntity(db, {
      kind: 'character',
      name: 'Mara',
      fields: { appearance: 'Tall, with a scar.' }
    }).entity
    replaceSceneFacts(db, scenes[0]!, [
      { entityId: mara.id, attribute: 'age', value: 'nineteen', quote: AGE },
      // The sheet already says what she looks like: the author's word is the only one sent.
      { entityId: mara.id, attribute: 'appearance', value: 'short', quote: 'Mara waited.' }
    ])
    const title = sceneTitles(db)(scenes[0]!)
    expect(rankCandidates(db, { question: 'How old is Mara?', nodeId: null }).bible).toEqual([
      {
        name: 'Mara',
        kind: 'character',
        sheet: [{ label: 'Appearance', value: 'Tall, with a scar.' }],
        observed: [{ label: 'Age', value: `nineteen (${title})` }]
      }
    ])
    // A hidden fact is the author's "wrong": it neither rides along nor boosts its scene.
    const age = listFactsForEntity(db, mara.id).find((fact) => fact.attribute === 'age')
    setFactHidden(db, age?.id ?? '', true)
    const hidden = rankCandidates(db, { question: 'How old is Mara?', nodeId: null })
    expect(hidden.bible[0]?.observed).toEqual([])
  })
})
