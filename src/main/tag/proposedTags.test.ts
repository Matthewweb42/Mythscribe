import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import {
  createProject,
  openProject,
  projectFolderFor,
  type ProjectSession
} from '../project/projectStore'
import { getDismissedNames } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { dismissName, listProposedTags, resetProposedTagCache } from './proposedTags'
import { createTag } from './tagStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
let documents: string[]

const scene = (index = 0): string => {
  const id = documents[index]
  if (id === undefined) throw new Error(`no manuscript document at ${index}`)
  return id
}

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({
    type: 'paragraph',
    content: [{ type: 'text', text }]
  }))
})

const write = (id: string, ...paragraphs: string[]): void => {
  saveDocument(db, id, doc(...paragraphs))
}

/** Three mid-sentence uses of a name in one paragraph, which is what a proposal takes. */
const thrice = (name: string): string => `The road bent. Then ${name} saw ${name} and ${name}.`

beforeEach(() => {
  resetProposedTagCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-proposed-'))
  session = createProject(projectFolderFor(tmp, 'Proposed'), 'Proposed', 'novel')
  db = session.connection.orm
  documents = manuscriptDocuments(db).map((row) => row.id)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  resetProposedTagCache()
})

describe('listProposedTags (F-4.12b)', () => {
  it('proposes a name the manuscript keeps using, with its count and its documents', () => {
    write(scene(0), 'The guard called out. Then Tash rode past Tash’s gate.')
    write(scene(1), 'Nobody else was there.')
    write(scene(2), 'She waited a long while. Then Tash came back.')

    expect(listProposedTags(db)).toEqual([
      { name: 'tash', display: 'Tash', count: 3, nodeIds: [scene(0), scene(2)] }
    ])
  })

  it('proposes nothing from a manuscript nobody has written in yet', () => {
    expect(listProposedTags(db)).toEqual([])
  })

  it('drops a proposal the author accepted, because the name is a tag now', () => {
    write(scene(0), thrice('Tash'))
    expect(listProposedTags(db).map((proposal) => proposal.name)).toEqual(['tash'])

    createTag(db, { name: 'Tash', category: 'character' })
    expect(listProposedTags(db)).toEqual([])
  })

  it('follows an edit of one document, whatever the other documents hold', () => {
    write(scene(0), thrice('Tash'))
    write(scene(1), thrice('Bren'))
    expect(listProposedTags(db).map((proposal) => proposal.name)).toEqual(['bren', 'tash'])

    write(scene(1), 'The road was empty.')
    expect(listProposedTags(db).map((proposal) => proposal.name)).toEqual(['tash'])
  })

  it('leaves out a word the manuscript also writes in lower case', () => {
    write(scene(0), thrice('Rose'), 'She carried a rose.')
    expect(listProposedTags(db)).toEqual([])
  })
})

describe('dismissName (F-4.12b)', () => {
  it('drops the name from the list and keeps it out for the project', () => {
    write(scene(0), thrice('Bren'))
    expect(listProposedTags(db).map((proposal) => proposal.name)).toEqual(['bren'])

    expect(dismissName(db, 'Bren')).toEqual([])
    // The dismissal is stored kebab-cased, the way a tag name would be, and survives a reopen.
    expect(getDismissedNames(db).names).toEqual(['bren'])
    session.close()
    session = openProject(projectFolderFor(tmp, 'Proposed'))
    db = session.connection.orm
    expect(getDismissedNames(db).names).toEqual(['bren'])
    expect(listProposedTags(db)).toEqual([])
  })

  it('dismisses each name once, and never an empty one', () => {
    write(scene(0), thrice('Bren'), thrice('Tash'))
    dismissName(db, 'Bren')
    dismissName(db, 'bren')
    dismissName(db, '…')
    expect(getDismissedNames(db).names).toEqual(['bren'])
    expect(listProposedTags(db).map((proposal) => proposal.name)).toEqual(['tash'])
  })
})
