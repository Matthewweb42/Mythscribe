import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OPEN_LOCK_FILE, OPEN_LOCK_STALE_MS, OpenLock, type OpenLockDeps } from './openLock'
import { createProject, openProject, projectFolderFor } from './projectStore'

let tmp: string
const NOW = new Date('2026-10-06T12:00:00.000Z')

function deps(over: Partial<OpenLockDeps> = {}): OpenLockDeps {
  return { host: 'desk', pid: 100, now: () => NOW, isAlive: () => true, ...over }
}

function writeMarker(folder: string, host: string, pid: number, heartbeat: Date): void {
  fs.writeFileSync(
    path.join(folder, OPEN_LOCK_FILE),
    JSON.stringify({ host, pid, token: `${host}:${pid}`, heartbeat: heartbeat.toISOString() })
  )
}

const marker = (folder: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(folder, OPEN_LOCK_FILE), 'utf8'))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-lock-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('OpenLock', () => {
  it('writes a marker naming this machine and removes it on release', () => {
    const lock = OpenLock.acquire(tmp, deps())
    expect(marker(tmp)).toMatchObject({ host: 'desk', pid: 100, heartbeat: NOW.toISOString() })
    lock.release()
    expect(fs.existsSync(path.join(tmp, OPEN_LOCK_FILE))).toBe(false)
  })

  it('refuses a project another machine has open, naming it', () => {
    writeMarker(tmp, 'laptop', 7, new Date(NOW.getTime() - 60_000))
    expect(() => OpenLock.acquire(tmp, deps())).toThrowError(/open on laptop/)
    expect(marker(tmp)).toMatchObject({ host: 'laptop' })
  })

  it('takes over a marker whose heartbeat is stale, or one that is not readable', () => {
    writeMarker(tmp, 'laptop', 7, new Date(NOW.getTime() - OPEN_LOCK_STALE_MS - 1))
    OpenLock.acquire(tmp, deps()).release()
    fs.writeFileSync(path.join(tmp, OPEN_LOCK_FILE), 'not json')
    OpenLock.acquire(tmp, deps()).release()
  })

  it('on this machine, refuses only while the other process is running', () => {
    writeMarker(tmp, 'desk', 55, NOW)
    expect(() => OpenLock.acquire(tmp, deps())).toThrowError(/another MythScribe window/)
    OpenLock.acquire(tmp, deps({ isAlive: () => false })).release()
  })

  it('leaves a marker another holder wrote after it alone on release', () => {
    const lock = OpenLock.acquire(tmp, deps())
    writeMarker(tmp, 'laptop', 7, NOW)
    lock.release()
    expect(marker(tmp)).toMatchObject({ host: 'laptop' })
  })
})

describe('project open marker', () => {
  it('is held while a project is open, and a project open elsewhere does not open', () => {
    const folder = projectFolderFor(tmp, 'Locked')
    const session = createProject(folder, 'Locked', 'novel')
    expect(marker(folder)).toMatchObject({ host: os.hostname(), pid: process.pid })
    session.close()
    expect(fs.existsSync(path.join(folder, OPEN_LOCK_FILE))).toBe(false)

    writeMarker(folder, `${os.hostname()}-elsewhere`, 1, new Date())
    expect(() => openProject(folder)).toThrowError(/open on .*-elsewhere/)
  })
})
