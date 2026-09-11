import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStateStore, EMPTY_APP_STATE } from './appStateStore'

let tmp: string
let file: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-appstate-'))
  file = path.join(tmp, 'nested', 'app-state.json')
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const entry = { path: '/p/A.mythscribe', name: 'A', format: 'novel' as const, lastOpened: 't1' }

describe('AppStateStore', () => {
  it('returns the empty state when the file is missing and does not touch disk', () => {
    const store = new AppStateStore(file)
    expect(store.get()).toEqual(EMPTY_APP_STATE)
    expect(fs.existsSync(path.dirname(file))).toBe(false)
  })

  it('round-trips through disk, creating the parent directory and leaving no temp file', () => {
    const store = new AppStateStore(file)
    const next = store.update((s) => ({ ...s, recents: [entry] }))
    expect(next.recents).toEqual([entry])
    expect(store.get()).toEqual(next)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['app-state.json'])
    expect(new AppStateStore(file).get()).toEqual({ version: 1, recents: [entry] })
  })

  it('warns once and returns the empty state for corrupt JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json', 'utf8')
    const store = new AppStateStore(file)
    expect(store.get()).toEqual(EMPTY_APP_STATE)
    expect(store.get()).toEqual(EMPTY_APP_STATE)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('warns and returns the empty state for JSON that does not match the schema', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 2, recents: 'nope' }), 'utf8')
    expect(new AppStateStore(file).get()).toEqual(EMPTY_APP_STATE)
    expect(warn).toHaveBeenCalledOnce()
  })
})
