import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { INLINE_TAG_NODE_TYPE } from '@shared/inlineTags'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { duplicateDraft, ensureDrafts } from '../../draft/draftStore'
import type { ProjectSession } from '../../project/projectStore'
import { getStoryMemory } from '../../project/settingsStore'
import { createSeededProject } from '../../project/testProject'
import { takeSnapshot } from '../../snapshot/snapshotStore'
import { createTag } from '../../tag/tagStore'
import { createNode, getNode } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { perfSceneText } from '../reading/perfFixture'
import { convertSwitchover, prepareSwitchover } from './convert'
import { inlineTagReplacements } from './plan'

/**
 * The conversion's cost on a novel-size v1 book (F-16.31, plan `Switchover.md` §9 risks): one
 * synchronous transaction on main, its own check included, so the window never hangs long. 200
 * scenes of about 1,300 words, an inline tag in every scene, a second draft and a whole-project
 * snapshot: under 5 seconds.
 */

const SCENES = 200
const BUDGET_MS = 5_000

let tmp: string
let session: ProjectSession

const text = (value: string): TiptapNodeT => ({ type: 'text', text: value })
const token = (id: string, name: string): TiptapNodeT => ({
  type: INLINE_TAG_NODE_TYPE,
  attrs: { id, name }
})

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-switchover-perf-'))
  session = createSeededProject(path.join(tmp, 'Long Book.mythscribe'), 'Long Book', 'novel')
  const db = session.connection.orm
  const mara = createTag(db, { name: 'mara', category: 'character' })
  const harbour = createTag(db, { name: 'harbour', category: 'setting' })
  const first = manuscriptDocuments(db)[0]?.id ?? ''
  const chapter = getNode(db, first)?.parentId ?? ''
  const ids = [first]
  for (let n = 2; n <= SCENES; n += 1) {
    ids.push(
      createNode(db, 'novel', {
        parentId: chapter,
        kind: 'document',
        hierarchyLevel: 'scene',
        title: `Scene ${n}`
      }).id
    )
  }
  ids.forEach((nodeId, i) => {
    const paragraphs = perfSceneText(i + 1).map((line): TiptapNodeT => ({
      type: 'paragraph',
      content: [text(line)]
    }))
    paragraphs.unshift({
      type: 'paragraph',
      content: [
        token(mara.id, 'mara'),
        text(' came down to the '),
        token(harbour.id, 'harbour'),
        text(' again.')
      ]
    })
    saveDocument(db, nodeId, { type: 'doc', content: paragraphs })
  })
  const state = ensureDrafts(db)
  duplicateDraft(db, state.activeId, 'Second draft')
  takeSnapshot(db, { scope: 'project', name: 'Before', note: '', milestone: false })
})

afterAll(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the switch-over on a 200-scene book (F-16.31)', () => {
  it(`converts and checks itself in under ${BUDGET_MS / 1000} s`, async () => {
    const db = session.connection.orm
    const replacements = inlineTagReplacements(db).map((row) => ({
      key: row.key,
      text: row.replacement
    }))
    const started = performance.now()
    const prepared = await prepareSwitchover(db, session.folder)
    const counts = convertSwitchover(
      db,
      'novel',
      prepared,
      { replacements, merges: [] },
      new Date(),
      {
        record: { trial: false, backup: null, datedCopy: null }
      }
    )
    const elapsed = performance.now() - started
    expect(getStoryMemory(db).version).toBe('v2')
    // Every scene's two tokens, in the active draft and the second one.
    expect(counts.tokens).toBe(SCENES * 2 * 2)
    expect(elapsed).toBeLessThan(BUDGET_MS)
  })
})
