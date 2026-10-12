import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlanRef } from '@shared/planLinks'
import type { TiptapNodeT } from '@shared/tiptap'
import { getPlanLinks } from '../ai/planLinks'
import { summarySource, staleSummaryNodeIds } from '../ai/summarize'
import type { NodeRow } from '../db/schema'
import { compileManuscript, compileSource } from '../document/compileStore'
import { saveDocument } from '../document/documentStore'
import { wordCountReport } from '../document/wordCountReport'
import { listDrafts } from '../draft/draftStore'
import { goalsStatus, manuscriptWordCount } from '../goals/goalsStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setPlanLinkState } from '../project/settingsStore'
import { ensureResearchRoot } from '../project/seed'
import { createSeededProject } from '../project/testProject'
import { replaceNodePassages, prunePassages, searchPassages } from '../search/passageIndex'
import { commitReplace, previewReplace } from '../search/replaceStore'
import { clearSearchCache, searchProject } from '../search/searchStore'
import { takeSnapshot } from '../snapshot/snapshotStore'
import { statsDashboard } from '../stats/dashboardStore'
import { createNode, getNode, listNodes, type TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, manuscriptDocuments, projectDocuments } from '../voice/profile'
import { resetVoiceProfileCache } from '../voice/versionCache'
import { createResearchNote } from './researchStore'

/**
 * F-16.8 (plan P1 §2.1, decision P1-D9): the Research section is never part of the book. Each
 * exclusion is asserted here against a project holding one manuscript scene and one Research
 * page that share nothing but a word: compile, statistics and the word-count report, goals,
 * drafts, snapshots, plan links, the voice profile, summaries and the v1 passage index leave the
 * page out; word search (as a source document) and Replace in project take it in.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: NodeRow
let page: NodeRow

const RESEARCH_WORD = 'Quillback'
const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})
const RESEARCH_TEXT = `${RESEARCH_WORD} rockfish live forty fathoms down off the northern reefs and the tides there run hard`

beforeEach(() => {
  // The voice profile is cached per process; another file's project must not answer here.
  resetVoiceProfileCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-research-out-'))
  session = createSeededProject(projectFolderFor(tmp, 'Out'), 'Out', 'novel')
  db = session.connection.orm
  const [first] = manuscriptDocuments(db)
  if (first === undefined) throw new Error('no scene')
  scene = first
  saveDocument(db, scene.id, doc('Mara waited on the ridge until the storm passed over.'))
  ensureResearchRoot(db)
  page = createResearchNote(db, 'novel', { title: 'Fish of the reef' })
  saveDocument(db, page.id, doc(RESEARCH_TEXT))
  clearSearchCache()
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const researchWords = (): number => getNode(db, page.id)?.wordCount ?? 0

describe('the Research section is left out of the book (F-16.8)', () => {
  it('is not compiled, previewed or listed for compile', () => {
    const source = compileSource(db)
    const ids = [...source.front, ...source.manuscript, ...source.end].map((entry) => entry.id)
    expect(ids).not.toContain(page.id)
    expect(ids).toContain(scene.id)
    expect(compileManuscript(db).entries.map((entry) => entry.id)).not.toContain(page.id)
  })

  it('counts in no statistics, word-count report or goal', () => {
    expect(researchWords()).toBeGreaterThan(10)
    const sceneWords = getNode(db, scene.id)?.wordCount ?? 0
    expect(goalsStatus(db).manuscriptWords).toBe(sceneWords)
    expect(manuscriptWordCount(db, page.id)).toBeNull()
    const stats = statsDashboard(db)
    expect(JSON.stringify(stats)).not.toContain(page.id)
    // Every total is the manuscript's: the page's words are in none of them.
    expect(stats.scenes.count).toBe(manuscriptDocuments(db).length)
    expect(stats.scenes.longest?.id).toBe(scene.id)
    expect(stats.pov.reduce((sum, row) => sum + row.words, 0)).toBe(sceneWords)
    expect(wordCountReport(db, null).manuscript.words).toBe(sceneWords)
  })

  it('takes no part in drafts', () => {
    const [draft] = listDrafts(db).drafts
    expect(draft?.wordCount).toBe(getNode(db, scene.id)?.wordCount)
    expect(manuscriptDocuments(db).map((row) => row.id)).not.toContain(page.id)
  })

  it('is left out of project snapshots, and a page cannot be snapshotted on its own', () => {
    expect(projectDocuments(db).map((row) => row.id)).not.toContain(page.id)
    const list = takeSnapshot(db, { scope: 'project', name: 'All', note: '', milestone: false })
    expect(list[0]?.wordCount).toBe(getNode(db, scene.id)?.wordCount)
    expect(() =>
      takeSnapshot(db, {
        scope: 'document',
        nodeId: page.id,
        name: 'Page',
        note: '',
        milestone: false
      })
    ).toThrow('Research documents are not part of snapshots')
  })

  it('is never a plan or a written scene for plan links', () => {
    const [, planned] = manuscriptDocuments(db)
    if (planned === undefined) throw new Error('no planned scene')
    expect(planned.wordCount).toBe(0)
    const emptyNote = createResearchNote(db, 'novel', { title: 'Empty' })
    const plan = (nodeId: string): PlanRef => ({ kind: 'scene', nodeId })
    setPlanLinkState(db, {
      suggestions: [
        // The written page is not a written scene, and the empty note is not an open plan.
        { plan: plan(planned.id), sceneId: page.id, reason: 'page as the scene' },
        { plan: plan(emptyNote.id), sceneId: scene.id, reason: 'note as the plan' },
        { plan: plan(planned.id), sceneId: scene.id, reason: 'the book' }
      ],
      dismissed: [],
      aiApplied: []
    })
    expect(getPlanLinks(db).suggestions.map((link) => link.reason)).toEqual(['the book'])
  })

  it('never teaches the voice profile, is never summarised, and is never in the v1 passage index', () => {
    expect(buildVoiceProfile(db).wordCount).toBe(getNode(db, scene.id)?.wordCount)
    expect(summarySource(db, page.id)).toBeNull()
    expect(staleSummaryNodeIds(db)).not.toContain(page.id)
    // A row written for it (as an older build might) is never answered and is pruned on open.
    db.transaction((tx) =>
      replaceNodePassages(tx, page.id, [{ index: 0, from: 0, to: 1, text: RESEARCH_TEXT }])
    )
    expect(searchPassages(db, RESEARCH_WORD)).toEqual([])
    expect(prunePassages(db)).toBe(1)
  })
})

describe('the Research section is searched and replaced in (F-16.8, P1-D9)', () => {
  it('is found by word search as a source document, never as a document of the book', () => {
    const all = searchProject(db, {
      query: RESEARCH_WORD,
      types: ['document', 'notes', 'research'],
      tagId: null
    })
    expect(all.results.map((result) => [result.type, result.id, result.location])).toEqual([
      ['research', page.id, '']
    ])
    expect(
      searchProject(db, { query: RESEARCH_WORD, types: ['document'], tagId: null }).results
    ).toEqual([])
    // A page in a folder names the folder.
    const folder = createNode(db, 'novel', {
      parentId: page.parentId ?? '',
      kind: 'folder',
      hierarchyLevel: null,
      title: 'Reefs'
    })
    const nested = createResearchNote(db, 'novel', { parentId: folder.id, title: 'Deep' })
    saveDocument(db, nested.id, doc(`${RESEARCH_WORD} again.`))
    const found = searchProject(db, { query: RESEARCH_WORD, types: ['research'], tagId: null })
    expect(found.results.map((result) => result.location)).toEqual(['', 'Reefs'])
  })

  it('is changed by Replace in project', () => {
    const request = {
      query: RESEARCH_WORD,
      replacement: 'Bluefin',
      matchCase: true,
      wholeWord: true,
      scopeId: null
    }
    expect(previewReplace(db, request).items.map((item) => item.id)).toEqual([page.id])
    commitReplace(db, request, [page.id])
    const stored = listNodes(db).find((row) => row.id === page.id)?.content ?? ''
    expect(stored).toContain('Bluefin rockfish')
  })
})
