import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aiCache } from '../db/schema'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import {
  AI_CACHE_MAX_ROWS,
  cacheSize,
  evictCache,
  getCached,
  putCached,
  type CacheEntry
} from './cacheStore'
import type { AiDb } from './usageStore'

let tmp: string
let session: ProjectSession
let db: AiDb

const entry = (over: Partial<CacheEntry> = {}): CacheEntry => ({
  key: 'k1',
  feature: 'tags',
  promptVersion: null,
  model: 'gpt-5.4-mini',
  text: '{"tags":["dark-forest"]}',
  usage: { inputTokens: 100, outputTokens: 20 },
  createdAt: '2026-09-12T10:00:00.000Z',
  ...over
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-cache-'))
  session = createProject(projectFolderFor(tmp, 'Cache'), 'Cache', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('cacheStore (F-5.14)', () => {
  it('misses an unknown key and hits a stored one with its text and usage', () => {
    expect(getCached(db, 'k1')).toBeUndefined()
    putCached(db, entry())
    expect(getCached(db, 'k1')).toEqual({
      text: '{"tags":["dark-forest"]}',
      usage: { inputTokens: 100, outputTokens: 20 }
    })
    expect(cacheSize(db)).toBe(1)
  })

  it('refreshes a row stored under the same key instead of failing', () => {
    putCached(db, entry())
    putCached(db, entry({ text: 'newer', createdAt: '2026-09-12T11:00:00.000Z' }))
    expect(getCached(db, 'k1')?.text).toBe('newer')
    expect(cacheSize(db)).toBe(1)
  })

  it('reads an unreadable usage column as a miss', () => {
    db.insert(aiCache)
      .values({
        contextHash: 'bad',
        feature: 'tags',
        model: 'm',
        response: 'x',
        usage: 'not json',
        createdAt: '2026-01-01'
      })
      .run()
    expect(getCached(db, 'bad')).toBeUndefined()
  })

  it('evicts the oldest rows once the bound is passed, keeping the newest 500', () => {
    const stamp = (i: number): string =>
      `2026-09-12T${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor((i % 3600) / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`
    for (let i = 0; i < AI_CACHE_MAX_ROWS; i++) {
      putCached(db, entry({ key: `k${i}`, createdAt: stamp(i) }))
    }
    expect(cacheSize(db)).toBe(AI_CACHE_MAX_ROWS)
    expect(getCached(db, 'k0')).toBeDefined()
    putCached(db, entry({ key: 'k500', createdAt: stamp(500) }))
    expect(cacheSize(db)).toBe(AI_CACHE_MAX_ROWS)
    expect(getCached(db, 'k0')).toBeUndefined()
    expect(getCached(db, 'k1')).toBeDefined()
    expect(getCached(db, 'k500')).toBeDefined()
  })

  it('evictCache reports how many rows went and does nothing under the bound', () => {
    putCached(db, entry({ key: 'a', createdAt: '2026-09-12T10:00:00.000Z' }))
    putCached(db, entry({ key: 'b', createdAt: '2026-09-12T10:00:01.000Z' }))
    putCached(db, entry({ key: 'c', createdAt: '2026-09-12T10:00:02.000Z' }))
    expect(evictCache(db)).toBe(0)
    expect(evictCache(db, 2)).toBe(1)
    expect(getCached(db, 'a')).toBeUndefined()
    expect(getCached(db, 'c')).toBeDefined()
  })
})
