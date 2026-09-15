import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import { addExemplar } from './exemplarStore'
import { POV_MIN_WORDS, buildVoiceProfile } from './profile'
import { bumpVoiceVersion, resetVoiceProfileCache } from './versionCache'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scenes: string[]
let frontDoc: string

const PAST_THIRD =
  'Mara turned from the window and looked at the ridge, where the storm had settled for the ' +
  'night. "We should go," she said. "Not yet," Tomas replied. He knew she was tired.'
const PRESENT_FIRST =
  'I walk to the window and I look at the ridge. My hands are cold and I am tired. ' +
  'It is late, and it rains. I do not want to see it, but I stay.'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: text.split('\n').map((line) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: line }]
  }))
})

/** A document with at least `words` words of `sentence`, repeated. */
function fill(id: string, sentence: string, words: number): void {
  const per = sentence.split(/\s+/).length
  saveDocument(db, id, doc(Array(Math.ceil(words / per)).fill(sentence).join(' ')))
}

beforeEach(() => {
  resetVoiceProfileCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-profile-'))
  session = createProject(projectFolderFor(tmp, 'Profile'), 'Profile', 'novel')
  db = session.connection.orm
  const rows = listNodes(db)
  scenes = rows.filter((r) => r.kind === 'document' && r.hierarchyLevel === 'scene').map((r) => r.id)
  const front = rows.find((r) => r.sectionType === 'front')
  if (!front || scenes.length < 2) throw new Error('skeleton not seeded')
  frontDoc = createNode(db, 'novel', {
    parentId: front.id,
    kind: 'document',
    hierarchyLevel: null,
    title: 'Dedication'
  }).id
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('buildVoiceProfile', () => {
  it('answers no rules, no exemplars, and zero confidence for a fresh project', () => {
    expect(buildVoiceProfile(db)).toMatchObject({
      rules: [],
      exemplars: [],
      confidence: 0,
      wordCount: 0
    })
  })

  it('reads the manuscript documents only, never the front or end matter', () => {
    fill(scenes[0]!, PAST_THIRD, 250)
    fill(frontDoc, PRESENT_FIRST, 3_000)
    const profile = buildVoiceProfile(db)
    expect(profile.wordCount).toBeGreaterThanOrEqual(250)
    expect(profile.wordCount).toBeLessThan(300)
    expect(profile.rules).toContain('Narration is in past tense.')
    expect(profile.rules).toContain('Narration is in third person.')
    expect(profile.stats.wordCount).toBe(profile.wordCount)
  })

  it('narrows to the POV group when it holds 2,000 words and falls back to the manuscript below that', () => {
    fill(scenes[0]!, PAST_THIRD, 2_500)
    fill(scenes[1]!, PRESENT_FIRST, POV_MIN_WORDS)
    setSceneMeta(db, scenes[1]!, { location: '', pov: 'Mara', timeline: '' })
    const all = buildVoiceProfile(db)
    expect(all.rules).toContain('Narration is in past tense.')
    const mara = buildVoiceProfile(db, { pov: ' mara ' })
    expect(mara.rules).toContain('Narration is in present tense.')
    expect(mara.rules).toContain('Narration is in first person.')
    expect(mara.wordCount).toBeLessThan(all.wordCount)
    expect(mara.confidence).toBeLessThan(all.confidence)
    // Below the minimum, the POV's own words are not enough evidence: the whole manuscript again.
    fill(scenes[1]!, PRESENT_FIRST, POV_MIN_WORDS - 100)
    bumpVoiceVersion()
    expect(buildVoiceProfile(db, { pov: 'Mara' }).rules).toContain('Narration is in past tense.')
    expect(buildVoiceProfile(db, { pov: 'Nobody' }).wordCount).toBe(buildVoiceProfile(db).wordCount)
  })

  it('lists every exemplar, POV-matching first when a POV is asked for, and adds the bonus at six', () => {
    setSceneMeta(db, scenes[0]!, { location: '', pov: 'Tomas', timeline: '' })
    setSceneMeta(db, scenes[1]!, { location: '', pov: 'Mara', timeline: '' })
    const tomas = addExemplar(db, scenes[0]!, `${PAST_THIRD} one`)
    const mara = addExemplar(db, scenes[1]!, `${PAST_THIRD} two`)
    expect(buildVoiceProfile(db).exemplars.map((e) => e.id)).toEqual([tomas.id, mara.id])
    expect(buildVoiceProfile(db, { pov: 'MARA' }).exemplars.map((e) => e.id)).toEqual([
      mara.id,
      tomas.id
    ])
    expect(buildVoiceProfile(db).confidence).toBe(0)
    for (let i = 0; i < 4; i++) addExemplar(db, scenes[0]!, `${PAST_THIRD} ${i}`)
    expect(buildVoiceProfile(db).exemplars).toHaveLength(6)
    expect(buildVoiceProfile(db).confidence).toBeCloseTo(0.1)
  })

  it('caches per POV until the version moves', () => {
    const first = buildVoiceProfile(db)
    expect(buildVoiceProfile(db)).toBe(first)
    expect(buildVoiceProfile(db, { pov: 'Mara' })).not.toBe(first)
    expect(buildVoiceProfile(db, { pov: 'mara' })).toBe(buildVoiceProfile(db, { pov: 'Mara ' }))
    fill(scenes[0]!, PAST_THIRD, 250)
    expect(buildVoiceProfile(db)).toBe(first) // no bump yet: the cache still answers
    bumpVoiceVersion()
    const second = buildVoiceProfile(db)
    expect(second).not.toBe(first)
    expect(second.wordCount).toBeGreaterThan(0)
  })

  it('skips an unreadable document instead of failing the whole profile', () => {
    fill(scenes[0]!, PAST_THIRD, 250)
    session.connection.sqlite
      .prepare('UPDATE node SET content = ? WHERE id = ?')
      .run('{not json', scenes[1]!)
    session.connection.sqlite
      .prepare('UPDATE node SET content = ? WHERE id = ?')
      .run('{"type":5}', scenes[2] ?? scenes[1]!)
    bumpVoiceVersion()
    expect(buildVoiceProfile(db).wordCount).toBeGreaterThanOrEqual(250)
  })
})
