import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  clearRecovery,
  discardRecovery,
  readRecovery,
  recoveryDir,
  stashRecovery
} from './recoveryJournal'

let tmp: string
let folder: string

const ID = '0b7e6f1c-3a2d-4e5f-9a8b-1c2d3e4f5a6b'

function doc(text: string): TiptapNodeT {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-recovery-'))
  folder = path.join(tmp, 'Book.mythscribe')
  fs.mkdirSync(folder)
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('recoveryJournal (F-8.3)', () => {
  it('answers empty before anything is stashed', () => {
    expect(readRecovery(folder)).toEqual([])
  })

  it('stashes, overwrites, and clears one entry per kind and id', () => {
    stashRecovery(folder, 'document', ID, doc('first'))
    stashRecovery(folder, 'document', ID, doc('second'))
    stashRecovery(folder, 'notes', ID, doc('a note'))
    expect(fs.readdirSync(recoveryDir(folder)).sort()).toEqual([
      `document-${ID}.json`,
      `notes-${ID}.json`
    ])
    expect(readRecovery(folder)).toEqual([
      { kind: 'document', id: ID, content: doc('second') },
      { kind: 'notes', id: ID, content: doc('a note') }
    ])
    clearRecovery(folder, 'document', ID)
    clearRecovery(folder, 'document', ID) // a missing entry is fine
    expect(readRecovery(folder)).toEqual([{ kind: 'notes', id: ID, content: doc('a note') }])
  })

  it('deletes malformed files, mismatched names, and leftover temp files', () => {
    stashRecovery(folder, 'document', ID, doc('kept'))
    const dir = recoveryDir(folder)
    fs.writeFileSync(path.join(dir, 'document-bad.json'), '{ not json')
    fs.writeFileSync(path.join(dir, 'notes-x.json'), JSON.stringify({ kind: 'notes', id: 'x' }))
    fs.writeFileSync(
      path.join(dir, 'notes-y.json'),
      JSON.stringify({ kind: 'notes', id: 'z', content: doc('elsewhere') })
    )
    fs.writeFileSync(path.join(dir, `document-${ID}.json.tmp`), '{"half')
    expect(readRecovery(folder)).toEqual([{ kind: 'document', id: ID, content: doc('kept') }])
    expect(fs.readdirSync(dir)).toEqual([`document-${ID}.json`])
  })

  it('refuses an id that could leave the folder', () => {
    expect(() => stashRecovery(folder, 'document', '../escape', doc('x'))).toThrow(
      expect.objectContaining({ code: 'VALIDATION' })
    )
    expect(() => clearRecovery(folder, 'notes', 'a/b')).toThrow(
      expect.objectContaining({ code: 'VALIDATION' })
    )
    expect(fs.existsSync(recoveryDir(folder))).toBe(false)
  })

  it('discards the whole journal', () => {
    stashRecovery(folder, 'document', ID, doc('gone'))
    discardRecovery(folder)
    expect(fs.existsSync(recoveryDir(folder))).toBe(false)
    discardRecovery(folder) // nothing left is fine
    expect(readRecovery(folder)).toEqual([])
  })
})
