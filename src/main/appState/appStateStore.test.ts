import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MODELS, defaultAiModels } from '@shared/ai'
import { defaultFloating, defaultLayout } from '@shared/layout'
import { defaultAiUsageState } from '../ai/dailyCap'
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
    expect(new AppStateStore(file).get()).toEqual({
      version: 1,
      recents: [entry],
      layout: defaultLayout(),
      models: defaultAiModels(),
      aiUsage: defaultAiUsageState()
    })
  })

  it('parses a file written before F-7.2 (no layout) to the default layout', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 1, recents: [entry] }), 'utf8')
    const state = new AppStateStore(file).get()
    expect(state.layout).toEqual(defaultLayout())
    expect(state.recents).toEqual([entry])
  })

  it('parses a file written before F-7.3 (no sidebar tab) and F-4.4 (no tag bar) with their defaults', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const layout = { sidebar: { open: false, size: 0.3 }, notes: { open: true, size: 0.4 } }
    fs.writeFileSync(file, JSON.stringify({ version: 1, recents: [], layout }), 'utf8')
    expect(new AppStateStore(file).get().layout).toEqual({
      ...layout,
      sidebar: { ...layout.sidebar, tab: 'manuscript' },
      tagBar: { open: true, height: 180, split: 0.4 },
      assistant: { open: false, size: 0.3 },
      floating: defaultFloating()
    })
  })

  it('parses a file written before F-4.5 (tag bar without a split) with the default split', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const layout = {
      sidebar: { open: true, size: 0.25, tab: 'manuscript' },
      notes: { open: false, size: 0.25 },
      tagBar: { open: false, height: 240 }
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, recents: [], layout }), 'utf8')
    expect(new AppStateStore(file).get().layout).toEqual({
      ...layout,
      tagBar: { open: false, height: 240, split: 0.4 },
      assistant: { open: false, size: 0.3 },
      floating: defaultFloating()
    })
  })

  it('the missing-file and corrupt-file fallbacks carry the default layout too', () => {
    expect(EMPTY_APP_STATE.layout).toEqual(defaultLayout())
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{not json', 'utf8')
    expect(new AppStateStore(file).get().layout).toEqual(defaultLayout())
  })

  it('round-trips a changed layout and refuses one outside the panel limits', () => {
    const store = new AppStateStore(file)
    const layout = {
      sidebar: { open: false, size: 0.3, tab: 'manuscript' as const },
      notes: { open: true, size: 0.4 },
      tagBar: { open: false, height: 240, split: 0.55 },
      assistant: { open: true, size: 0.25 },
      floating: defaultFloating()
    }
    expect(store.update((s) => ({ ...s, layout })).layout).toEqual(layout)
    expect(new AppStateStore(file).get().layout).toEqual(layout)
    expect(() =>
      store.update((s) => ({
        ...s,
        layout: { ...layout, sidebar: { open: true, size: 0.5, tab: 'manuscript' as const } }
      }))
    ).toThrow()
    expect(new AppStateStore(file).get().layout).toEqual(layout)
  })

  it('parses a file written before F-5.11 (no models) to the default model mapping', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 1, recents: [entry] }), 'utf8')
    expect(new AppStateStore(file).get().models).toEqual(defaultAiModels())
    expect(EMPTY_APP_STATE.models).toEqual(defaultAiModels())
  })

  it('round-trips a changed model mapping, trimmed, and refuses an empty or over-long model', () => {
    const store = new AppStateStore(file)
    const models = {
      openai: { fast: 'gpt-5.4-nano', strong: 'gpt-5.4' },
      cloud: { fast: 'gpt-5.4-mini', strong: 'gpt-5.4' }
    }
    expect(
      store.update((s) => ({
        ...s,
        models: { ...models, openai: { ...models.openai, fast: ' gpt-5.4-nano ' } }
      })).models
    ).toEqual(models)
    expect(new AppStateStore(file).get().models).toEqual(models)
    expect(() =>
      store.update((s) => ({
        ...s,
        models: { ...models, openai: { fast: '', strong: 'gpt-5.4' } }
      }))
    ).toThrow()
    expect(() =>
      store.update((s) => ({
        ...s,
        models: { ...models, openai: { fast: 'x'.repeat(101), strong: 'gpt-5.4' } }
      }))
    ).toThrow()
    expect(new AppStateStore(file).get().models).toEqual(models)
  })

  it('parses a file written before F-5.14 (no aiUsage) to the default cap with no tally', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 1, recents: [entry] }), 'utf8')
    expect(new AppStateStore(file).get().aiUsage).toEqual(defaultAiUsageState())
    expect(EMPTY_APP_STATE.aiUsage).toEqual(defaultAiUsageState())
  })

  it('round-trips the daily cap and tally and refuses a cap outside 0–500', () => {
    const store = new AppStateStore(file)
    const aiUsage = {
      dailyCapUsd: 5,
      spentDate: '2026-09-12',
      spentTodayUsd: 0.25,
      requestsToday: 3,
      tokensToday: 900
    }
    expect(store.update((s) => ({ ...s, aiUsage })).aiUsage).toEqual(aiUsage)
    expect(new AppStateStore(file).get().aiUsage).toEqual(aiUsage)
    expect(() =>
      store.update((s) => ({ ...s, aiUsage: { ...aiUsage, dailyCapUsd: 501 } }))
    ).toThrow()
    expect(() =>
      store.update((s) => ({ ...s, aiUsage: { ...aiUsage, dailyCapUsd: -1 } }))
    ).toThrow()
    expect(new AppStateStore(file).get().aiUsage).toEqual(aiUsage)
  })

  it('fills the cloud map in for a file written before F-15.4, keeping the recents', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const models = { openai: { fast: 'gpt-5.4-nano', strong: 'gpt-5.4' } }
    fs.writeFileSync(file, JSON.stringify({ version: 1, recents: [entry], models }), 'utf8')
    const state = new AppStateStore(file).get()
    expect(state.models).toEqual({ ...models, cloud: DEFAULT_MODELS })
    expect(state.recents).toEqual([entry])
  })

  it('warns and falls back to the empty state when the stored model mapping is invalid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const models = { openai: { fast: '', strong: 'gpt-5.4' } }
    fs.writeFileSync(file, JSON.stringify({ version: 1, recents: [entry], models }), 'utf8')
    expect(new AppStateStore(file).get()).toEqual(EMPTY_APP_STATE)
    expect(warn).toHaveBeenCalledOnce()
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
