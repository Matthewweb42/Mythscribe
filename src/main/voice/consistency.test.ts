import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RULE_MIN_WORDS } from '@shared/stylometry'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import { buildConsistencyReport } from './consistency'
import { manuscriptDocuments } from './profile'
import { bumpVoiceVersion, resetVoiceProfileCache } from './versionCache'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string
let chapter: string

/** Third-person past narration with dialogue tags (the F-14.1 fixture). */
const VOICE_PARAGRAPH =
  'Mara turned from the window and looked at the ridge, where the storm had settled for the ' +
  'night. "We should go," she said. "Not yet," Tomas replied. He knew she was tired, and he was ' +
  'tired too. They walked to the door and she pulled it open. "The river is rising," she said. ' +
  '"Then we wait," he said.'
/** The same scene in present tense, with sentences as short as the manuscript's so only the tense differs. */
const PRESENT_PARAGRAPH =
  'Mara turns from the window. She looks at the ridge, where the storm is settling for the ' +
  'night. She is tired. He is tired too, and it is late. They walk to the door. She pulls it open.'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

/** Saves a document and moves the profile version, as the `document:save` handler does. */
function write(id: string, text: string): void {
  saveDocument(db, id, doc(text))
  bumpVoiceVersion()
}

function addScene(title: string): string {
  return createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title
  }).id
}

beforeEach(() => {
  resetVoiceProfileCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-consistency-'))
  session = createProject(projectFolderFor(tmp, 'Voice'), 'Voice', 'novel')
  db = session.connection.orm
  const row = listNodes(db).find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
  if (row?.parentId == null) throw new Error('skeleton not seeded')
  scene = row.id
  chapter = row.parentId
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('buildConsistencyReport (F-14.7)', () => {
  it('reports every manuscript document as short for an empty manuscript, in tree order', () => {
    const report = buildConsistencyReport(db)
    expect(report.profileWordCount).toBe(0)
    expect(report.documents.map((d) => d.id)).toEqual(manuscriptDocuments(db).map((r) => r.id))
    expect(report.documents.length).toBeGreaterThan(0)
    for (const entry of report.documents) {
      expect(entry).toMatchObject({ wordCount: 0, status: 'short', violations: [] })
    }
  })

  it('scores a drifting scene, an ok scene, and skips a short one', () => {
    write(scene, Array(12).fill(VOICE_PARAGRAPH).join(' '))
    const drift = addScene('Drift')
    write(drift, Array(6).fill(PRESENT_PARAGRAPH).join(' '))
    const short = addScene('Short')
    write(short, 'Mara turns from the window.')

    const report = buildConsistencyReport(db)
    const byId = new Map(report.documents.map((d) => [d.id, d]))
    expect(byId.get(scene)).toMatchObject({ title: 'Scene 1', status: 'ok', violations: [] })
    expect(byId.get(scene)?.wordCount).toBeGreaterThanOrEqual(RULE_MIN_WORDS)
    expect(byId.get(drift)).toMatchObject({ title: 'Drift', status: 'drift' })
    expect(byId.get(drift)?.violations).toContain(
      'Narrated in present tense; the manuscript is in past tense.'
    )
    expect(byId.get(short)).toMatchObject({ title: 'Short', status: 'short', violations: [] })
    expect(byId.get(short)?.wordCount).toBe(5)
    expect(report.profileWordCount).toBe(report.documents.reduce((sum, d) => sum + d.wordCount, 0))
    // Tree order: the seeded scene first, then the two added after it.
    const ids = report.documents.map((d) => d.id)
    expect(ids.indexOf(scene)).toBeLessThan(ids.indexOf(drift))
    expect(ids.indexOf(drift)).toBeLessThan(ids.indexOf(short))
  })

  it('follows a save: the same scene stops drifting once its tense matches', () => {
    write(scene, Array(12).fill(VOICE_PARAGRAPH).join(' '))
    const drift = addScene('Drift')
    write(drift, Array(6).fill(PRESENT_PARAGRAPH).join(' '))
    expect(buildConsistencyReport(db).documents.find((d) => d.id === drift)?.status).toBe('drift')
    write(drift, Array(6).fill(VOICE_PARAGRAPH).join(' '))
    expect(buildConsistencyReport(db).documents.find((d) => d.id === drift)?.status).toBe('ok')
  })
})
