import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VOICE_EXEMPLAR_MAX, VOICE_EXEMPLAR_TEXT_MIN } from '@shared/voice'
import { setSceneMeta } from '../document/sceneMetaStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { deleteNode, listNodes, type TreeDb } from '../tree/treeStore'
import { addExemplar, listExemplars, removeExemplar } from './exemplarStore'
import { currentVoiceVersion } from './versionCache'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'

let tmp: string
let session: ProjectSession
let db: TreeDb

const PASSAGE =
  'Mara turned from the window and looked at the ridge, where the storm had settled for the ' +
  'night. She knew she was tired, and she thought about the river and what it wanted from her.'

function expectCode(fn: () => unknown, code: AppError['code']): AppError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe(code)
    return err as AppError
  }
  throw new Error(`expected ${code}`)
}

function nodeOfKind(kind: 'document' | 'folder' | 'section', index = 0): string {
  const row = listNodes(db).filter((r) =>
    kind === 'section' ? r.sectionType !== null : r.kind === kind && r.sectionType === null
  )[index]
  if (!row) throw new Error(`no seeded ${kind}`)
  return row.id
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-voice-'))
  session = createProject(projectFolderFor(tmp, 'Voice'), 'Voice', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('addExemplar', () => {
  it('stores the trimmed text with the document POV, the kind, and a timestamp, and bumps the version', () => {
    const scene = nodeOfKind('document')
    setSceneMeta(db, scene, { location: '', pov: ' Mara ', timeline: '', brief: EMPTY_SCENE_BRIEF })
    const before = currentVoiceVersion()
    const added = addExemplar(db, scene, `  ${PASSAGE}\n`)
    expect(added).toMatchObject({ nodeId: scene, text: PASSAGE, pov: 'Mara', kind: 'mixed' })
    expect(added.id).toMatch(/[0-9a-f-]{36}/)
    expect(Date.parse(added.created)).not.toBeNaN()
    expect(currentVoiceVersion()).toBe(before + 1)
    expect(listExemplars(db)).toEqual([added])
  })

  it('stores a null POV when the metadata has none', () => {
    expect(addExemplar(db, nodeOfKind('document'), PASSAGE).pov).toBeNull()
  })

  it('refuses an unknown node, a section root, a folder, and text outside the bounds', () => {
    expectCode(() => addExemplar(db, 'missing', PASSAGE), 'NOT_FOUND')
    expectCode(() => addExemplar(db, nodeOfKind('section'), PASSAGE), 'VALIDATION')
    expectCode(() => addExemplar(db, nodeOfKind('folder'), PASSAGE), 'VALIDATION')
    expectCode(
      () => addExemplar(db, nodeOfKind('document'), 'x'.repeat(VOICE_EXEMPLAR_TEXT_MIN - 1)),
      'VALIDATION'
    )
    expect(listExemplars(db)).toEqual([])
  })

  it('refuses a thirteenth exemplar with VALIDATION and the exact message', () => {
    const scene = nodeOfKind('document')
    for (let i = 0; i < VOICE_EXEMPLAR_MAX; i++) addExemplar(db, scene, `${PASSAGE} ${i}`)
    const err = expectCode(() => addExemplar(db, scene, PASSAGE), 'VALIDATION')
    expect(err.message).toBe(
      'A voice profile holds at most 12 exemplars. Remove one to add another.'
    )
    expect(listExemplars(db)).toHaveLength(VOICE_EXEMPLAR_MAX)
  })
})

describe('listExemplars', () => {
  it('is empty for a new project and lists oldest first', () => {
    expect(listExemplars(db)).toEqual([])
    const scene = nodeOfKind('document')
    const a = addExemplar(db, scene, `${PASSAGE} a`)
    const b = addExemplar(db, scene, `${PASSAGE} b`)
    expect(listExemplars(db).map((e) => e.text)).toEqual([a.text, b.text])
  })

  it('keeps the passage after its document is deleted, with the node reference cleared', () => {
    const scene = nodeOfKind('document')
    const added = addExemplar(db, scene, PASSAGE)
    deleteNode(db, scene)
    expect(listExemplars(db)).toEqual([{ ...added, nodeId: null }])
  })
})

describe('removeExemplar', () => {
  it('drops the row and bumps the version; an unknown id is NOT_FOUND', () => {
    const added = addExemplar(db, nodeOfKind('document'), PASSAGE)
    const before = currentVoiceVersion()
    removeExemplar(db, added.id)
    expect(currentVoiceVersion()).toBe(before + 1)
    expect(listExemplars(db)).toEqual([])
    expectCode(() => removeExemplar(db, added.id), 'NOT_FOUND')
    expect(currentVoiceVersion()).toBe(before + 1)
  })
})
