import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { addDocumentTag } from '../../tag/documentTagStore'
import { createTag } from '../../tag/tagStore'
import { listNodes, type TreeDb } from '../../tree/treeStore'
import { buildSceneSteer } from './sceneSteer'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string
let manuscriptRoot: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-steer-'))
  session = createProject(projectFolderFor(tmp, 'Steer'), 'Steer', 'novel')
  db = session.connection.orm
  const rows = listNodes(db)
  scene = rows.find((r) => r.hierarchyLevel === 'scene')?.id ?? ''
  manuscriptRoot = rows.find((r) => r.sectionType === 'manuscript' && r.parentId === null)?.id ?? ''
  if (!scene || !manuscriptRoot) throw new Error('skeleton not seeded')
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('buildSceneSteer (F-14.13)', () => {
  it('is null with no node, an unknown node, a section root, or a scene with no steer tag', () => {
    expect(buildSceneSteer(db, null)).toBeNull()
    expect(buildSceneSteer(db, 'missing')).toBeNull()
    expect(buildSceneSteer(db, manuscriptRoot)).toBeNull()
    expect(buildSceneSteer(db, scene)).toBeNull()
    const mara = createTag(db, { name: 'Mara', category: 'character', color: '#112233' })
    addDocumentTag(db, scene, mara.id)
    expect(buildSceneSteer(db, scene)).toBeNull()
  })

  it("renders the scene's tone, content, plot thread, and theme tags, leaving the rest of the bank out", () => {
    const link = (
      name: string,
      category: 'tone' | 'content' | 'plotThread' | 'custom' | 'character'
    ): void => {
      addDocumentTag(db, scene, createTag(db, { name, category, color: '#112233' }).id)
    }
    link('tense', 'tone')
    link('violence', 'content')
    link('oath', 'plotThread')
    link('grief', 'custom')
    link('Mara', 'character')
    createTag(db, { name: 'calm', category: 'tone', color: '#112233' })
    expect(buildSceneSteer(db, scene)).toBe(
      [
        SCENE_STEER_HEADING,
        'Tone: tense',
        'Content: violence',
        'Plot threads: oath',
        'Themes: grief',
        'Write in this tone, keep to what the content tags allow, and keep these threads and themes in view.'
      ].join('\n')
    )
  })
})
