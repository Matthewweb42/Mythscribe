import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReferencePin } from '@shared/references'
import { createEntity, deleteEntity } from '../entity/entityStore'
import { deleteNode, listNodes, type TreeDb } from '../tree/treeStore'
import { createProject, projectFolderFor, type ProjectSession } from './projectStore'
import {
  addReferenceImage,
  pruneReferencePins,
  referencesDir,
  removeReferenceImage
} from './referenceStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
let folder: string

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwTpsJAAICATNWh+JUAAAAAElFTkSuQmCC',
  'base64'
)

function source(name: string): string {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, PNG)
  return file
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-references-'))
  folder = projectFolderFor(tmp, 'Pins')
  session = createProject(folder, 'Pins', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('addReferenceImage / removeReferenceImage (F-9.6)', () => {
  it('copies an image into assets/references under a minted name and deletes it again', () => {
    const file = addReferenceImage(folder, source('Harbor Map.PNG'))
    expect(file).toMatch(/^Harbor-Map\.[0-9a-f]{8}\.png$/)
    expect(referencesDir(folder)).toBe(path.join(folder, 'assets', 'references'))
    expect(fs.readFileSync(path.join(referencesDir(folder), file))).toEqual(PNG)
    removeReferenceImage(folder, file)
    expect(fs.readdirSync(referencesDir(folder))).toEqual([])
    // Already gone: not an error.
    removeReferenceImage(folder, file)
  })

  it('refuses a file that is not an image, and a name that leaves the folder', () => {
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'x')
    expect(() => addReferenceImage(folder, path.join(tmp, 'notes.txt'))).toThrowError(
      /not an image/
    )
    expect(() => removeReferenceImage(folder, '../project.db')).toThrowError(
      /not a stored image name/
    )
  })
})

describe('pruneReferencePins (F-9.6)', () => {
  it('keeps the pins whose entity, node, or file exists, in order, and answers the same array', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara' }).entity
    const node = listNodes(db)[0]
    if (!node) throw new Error('a seeded node expected')
    const file = addReferenceImage(folder, source('map.png'))
    const pins: ReferencePin[] = [
      { type: 'image', file },
      { type: 'note', id: node.id },
      { type: 'entity', id: mara.id }
    ]
    expect(pruneReferencePins(db, folder, pins)).toBe(pins)
  })

  it('drops the pin of a deleted entity, a deleted node, and a missing file', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara' }).entity
    const brann = createEntity(db, { kind: 'character', name: 'Brann' }).entity
    const nodes = listNodes(db)
    const leaf = nodes.find((n) => n.parentId !== null)
    if (!leaf) throw new Error('a seeded leaf expected')
    const kept = addReferenceImage(folder, source('kept.png'))
    const gone = addReferenceImage(folder, source('gone.png'))
    const pins: ReferencePin[] = [
      { type: 'entity', id: mara.id },
      { type: 'image', file: gone },
      { type: 'note', id: leaf.id },
      { type: 'entity', id: brann.id },
      { type: 'image', file: kept },
      { type: 'note', id: 'never-existed' }
    ]
    deleteEntity(db, mara.id)
    deleteNode(db, leaf.id)
    fs.rmSync(path.join(referencesDir(folder), gone))
    expect(pruneReferencePins(db, folder, pins)).toEqual([
      { type: 'entity', id: brann.id },
      { type: 'image', file: kept }
    ])
  })
})
