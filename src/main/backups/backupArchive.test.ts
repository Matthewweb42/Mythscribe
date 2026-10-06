import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { getDocumentContent, saveDocument } from '../document/documentStore'
import { AppError } from '../ipc/errors'
import {
  createProject,
  openProject,
  projectFolderFor,
  type ProjectSession
} from '../project/projectStore'
import { listNodes } from '../tree/treeStore'
import {
  createBackupArchive,
  extractBackup,
  listBackups,
  projectBackupDir,
  pruneBackups
} from './backupArchive'
import { readZip, zipBuffer } from './zip'

let tmp: string
let session: ProjectSession
const opened: ProjectSession[] = []

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

function firstDocumentId(s: ProjectSession): string {
  const row = listNodes(s.connection.orm).find((r) => r.kind === 'document')
  if (!row) throw new Error('no document')
  return row.id
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (err) {
    return err instanceof AppError ? err.code : 'not an AppError'
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-backup-'))
  session = createProject(projectFolderFor(tmp, 'Ridge'), 'Ridge', 'novel')
})
afterEach(() => {
  session.close()
  for (const s of opened.splice(0)) s.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('createBackupArchive / extractBackup (F-8.4)', () => {
  it('round-trips the project: the text, the assets, and nothing from this run', () => {
    const docId = firstDocumentId(session)
    saveDocument(session.connection.orm, docId, para('The ridge was empty.'))
    fs.mkdirSync(path.join(session.folder, 'assets', 'backgrounds'), { recursive: true })
    fs.writeFileSync(path.join(session.folder, 'assets', 'backgrounds', 'dusk.png'), 'png-bytes')
    fs.mkdirSync(path.join(session.folder, 'recovery'))
    fs.writeFileSync(path.join(session.folder, 'recovery', 'document-x.json'), '{}')
    fs.writeFileSync(path.join(session.folder, 'half-written.tmp'), 'x')

    const zip = path.join(tmp, 'backups', 'Ridge 2026-10-04 120000.zip')
    createBackupArchive(session, zip)
    const names = readZip(fs.readFileSync(zip)).map((e) => e.name)
    expect(names).toContain('project.db')
    expect(names).toContain('assets/backgrounds/dusk.png')
    expect(names.some((n) => n.startsWith('recovery'))).toBe(false)
    expect(names).not.toContain('.mythscribe-open')
    expect(names.some((n) => n.endsWith('-wal') || n.endsWith('-shm') || n.endsWith('.tmp'))).toBe(
      false
    )
    expect(fs.existsSync(`${zip}.tmp`)).toBe(false)

    const target = path.join(tmp, 'Ridge (restored).mythscribe')
    extractBackup(zip, target)
    const restored = openProject(target)
    opened.push(restored)
    expect(restored.info.id).toBe(session.info.id)
    expect(getDocumentContent(restored.connection.orm, docId).content).toEqual(
      para('The ridge was empty.')
    )
    expect(fs.readFileSync(path.join(target, 'assets', 'backgrounds', 'dusk.png'), 'utf8')).toBe(
      'png-bytes'
    )
  })

  it('leaves out a backup folder that sits inside the project', () => {
    const inside = path.join(session.folder, 'my-backups')
    fs.mkdirSync(inside)
    fs.writeFileSync(path.join(inside, 'Ridge 2026-10-04 110000.zip'), 'older')
    const zip = path.join(inside, 'Ridge 2026-10-04 120000.zip')
    createBackupArchive(session, zip, inside)
    expect(readZip(fs.readFileSync(zip)).some((e) => e.name.startsWith('my-backups'))).toBe(false)
  })

  it('refuses to restore over a folder that exists', () => {
    const zip = path.join(tmp, 'b.zip')
    createBackupArchive(session, zip)
    expect(codeOf(() => extractBackup(zip, session.folder))).toBe('ALREADY_EXISTS')
  })

  it('refuses a zip with a ../ entry and writes nothing outside the target', () => {
    const zip = path.join(tmp, 'evil.zip')
    fs.writeFileSync(
      zip,
      zipBuffer([
        { name: 'project.db', data: Buffer.from('SQLite format 3\0rest') },
        { name: '../escaped.txt', data: Buffer.from('gotcha') }
      ])
    )
    const target = path.join(tmp, 'Evil.mythscribe')
    expect(codeOf(() => extractBackup(zip, target))).toBe('VALIDATION')
    expect(fs.existsSync(path.join(tmp, 'escaped.txt'))).toBe(false)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('refuses absolute and backslashed names, a zip with no database, and a non-database', () => {
    const target = path.join(tmp, 'Bad.mythscribe')
    const cases: { name: string; data: Buffer }[][] = [
      [
        { name: 'project.db', data: Buffer.from('SQLite format 3\0') },
        { name: '/etc/x', data: Buffer.from('x') }
      ],
      [
        { name: 'project.db', data: Buffer.from('SQLite format 3\0') },
        { name: 'assets\\..\\..\\x', data: Buffer.from('x') }
      ],
      [
        { name: 'project.db', data: Buffer.from('SQLite format 3\0') },
        { name: 'C:/x', data: Buffer.from('x') }
      ],
      [{ name: 'assets/a.txt', data: Buffer.from('x') }],
      [{ name: 'project.db', data: Buffer.from('just text, not a database') }]
    ]
    for (const entries of cases) {
      const zip = path.join(tmp, 'bad.zip')
      fs.writeFileSync(zip, zipBuffer(entries))
      expect(codeOf(() => extractBackup(zip, target))).toBe('VALIDATION')
      expect(fs.existsSync(target)).toBe(false)
    }
    const notZip = path.join(tmp, 'notes.zip')
    fs.writeFileSync(notZip, 'not a zip')
    expect(codeOf(() => extractBackup(notZip, target))).toBe('VALIDATION')
  })
})

describe('listBackups / pruneBackups / projectBackupDir (F-8.4)', () => {
  it('lists only our files, newest first, and prunes past the newest N', () => {
    const dir = path.join(tmp, 'backups')
    fs.mkdirSync(dir)
    for (const name of [
      'Ridge 2026-10-01 090000.zip',
      'Ridge 2026-10-03 090000.zip',
      'Ridge 2026-10-02 090000.zip',
      'Ridge 2026-10-04 090000.zip',
      'shopping list.txt',
      'Ridge 2026-10-05 090000.zip.tmp'
    ]) {
      fs.writeFileSync(path.join(dir, name), name)
    }
    expect(listBackups(dir).map((b) => b.name)).toEqual([
      'Ridge 2026-10-04 090000.zip',
      'Ridge 2026-10-03 090000.zip',
      'Ridge 2026-10-02 090000.zip',
      'Ridge 2026-10-01 090000.zip'
    ])
    expect(listBackups(dir)[0]?.bytes).toBe('Ridge 2026-10-04 090000.zip'.length)
    expect(pruneBackups(dir, 2).map((b) => b.name)).toEqual([
      'Ridge 2026-10-02 090000.zip',
      'Ridge 2026-10-01 090000.zip'
    ])
    expect(fs.readdirSync(dir).sort()).toEqual([
      'Ridge 2026-10-03 090000.zip',
      'Ridge 2026-10-04 090000.zip',
      'Ridge 2026-10-05 090000.zip.tmp',
      'shopping list.txt'
    ])
    expect(listBackups(path.join(tmp, 'missing'))).toEqual([])
  })

  it('keeps a renamed project in the folder keyed by its id', () => {
    const root = path.join(tmp, 'backups')
    expect(projectBackupDir(root, 'Ridge', '0123456789')).toBe(path.join(root, 'Ridge (01234567)'))
    fs.mkdirSync(path.join(root, 'Old Name (01234567)'), { recursive: true })
    expect(projectBackupDir(root, 'Ridge', '0123456789')).toBe(
      path.join(root, 'Old Name (01234567)')
    )
  })
})
