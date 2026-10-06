import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { AI_ORIGIN_MARK } from '@shared/provenance'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  VOICE_NOTE_MAX_CHARS,
  VOICE_NOTES_MAX,
  VOICE_NOTES_MIN_WORDS,
  VOICE_NOTES_REFRESH_WORDS
} from '@shared/voice'
import { saveDocument } from '../document/documentStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getVoiceNotes, setAiSettings, setVoiceNotes } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { buildVoiceProfile, manuscriptDocuments } from '../voice/profile'
import { currentVoiceVersion, resetVoiceProfileCache } from '../voice/versionCache'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { resetInflight } from './inflight'
import {
  AiProviderError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'
import {
  clearVoiceNotes,
  parseVoiceNotesAnswer,
  refreshVoiceNotes,
  sampleVoicePassages,
  voiceNotesDue
} from './voiceNotes'

const NOW = new Date(2026, 9, 6, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

const OWN =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited. The ' +
  'wind came off the water and pushed the lantern flame flat.'
const AI_TEXT =
  'Suddenly, a tapestry of emotions washed over her as the moonlight danced upon the restless ' +
  'river, and she realized that everything had changed forever in that single moment.'

const NOTES = ['Opens on a concrete object.', 'Uses said and nothing else.']

const para = (text: string, marks?: TiptapNodeT['marks']): TiptapNodeT => ({
  type: 'paragraph',
  content: [{ type: 'text', text, ...(marks ? { marks } : {}) }]
})

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let scene: string

function answer(notes: unknown[]): void {
  complete.mockResolvedValueOnce({
    text: JSON.stringify({ notes }),
    model: 'gpt-5.4-mini',
    usage: { inputTokens: 900, outputTokens: 60 }
  })
}

const sentUser = (call = 0): string => complete.mock.calls[call]?.[0].messages[1]?.content ?? ''

beforeEach(() => {
  resetVoiceProfileCache()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-voicenotes-'))
  session = createProject(projectFolderFor(tmp, 'Voice notes'), 'Voice notes', 'novel')
  db = session.connection.orm
  scene = manuscriptDocuments(db)[0]?.id ?? ''
  if (!scene) throw new Error('skeleton not seeded')
  saveDocument(db, scene, {
    type: 'doc',
    content: [
      para(OWN),
      para(AI_TEXT, [{ type: AI_ORIGIN_MARK, attrs: { proposalId: 'p1', accepted: 10 } }])
    ]
  })
  setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
  complete = vi.fn<Complete>()
  ledger = []
  const provider: Provider = {
    id: 'openai',
    resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
    complete,
    stream: async function* () {},
    testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
  }
  const cache = new Map<string, { text: string; usage: CompletionResult['usage'] }>()
  deps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
    cache: {
      get: (key) => cache.get(key),
      put: (entry) => void cache.set(entry.key, { text: entry.text, usage: entry.usage })
    },
    dailyCap: {
      get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(NOW) }),
      spend: () => {}
    },
    session: { spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('refreshVoiceNotes (F-14.14)', () => {
  it('sends only the author’s own prose to the fast tier as JSON, stores the notes, and records the cost', async () => {
    answer(NOTES)
    const before = currentVoiceVersion()
    const run = await refreshVoiceNotes(db, deps)
    const request = complete.mock.calls[0]![0]
    expect(request).toMatchObject({ tier: 'fast', json: true, maxTokens: 400 })
    expect(sentUser()).toContain(OWN)
    expect(sentUser()).not.toContain('tapestry')
    expect(sentUser()).not.toContain('Earlier notes')
    expect(run).toMatchObject({ cached: false, costUsd: priceFor('gpt-5.4-mini', 900, 60).costUsd })
    expect(getVoiceNotes(db)).toEqual({
      notes: NOTES,
      basedOnWords: manuscriptDocuments(db)[0]?.wordCount,
      model: 'gpt-5.4-mini',
      updated: NOW.toISOString()
    })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ feature: 'voiceNotes', promptVersion: 'voiceNotes.v1' })
    // The profile carries the notes from the next build on.
    expect(currentVoiceVersion()).toBeGreaterThan(before)
    expect(buildVoiceProfile(db).notes).toEqual(NOTES)
  })

  it('sends the previous notes so the model keeps what still holds', async () => {
    setVoiceNotes(db, { notes: ['Old note.'], basedOnWords: 0, model: 'm', updated: 'x' })
    answer(NOTES)
    await refreshVoiceNotes(db, deps)
    expect(sentUser()).toContain('Earlier notes:\n- Old note.')
  })

  it('is refused below Ask and with its toggle off, before anything is read or sent', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 0 })
    await expect(refreshVoiceNotes(db, deps)).rejects.toMatchObject({ code: 'DISABLED' })
    setAiSettings(db, {
      ...defaultAiSettings(),
      dial: 1,
      features: { ...defaultAiSettings().features, voiceNotes: false }
    })
    await expect(refreshVoiceNotes(db, deps)).rejects.toMatchObject({ code: 'DISABLED' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('is VALIDATION with no prose of the author’s to read', async () => {
    saveDocument(db, scene, { type: 'doc', content: [para('Too short.')] })
    await expect(refreshVoiceNotes(db, deps)).rejects.toBeInstanceOf(AppError)
    expect(complete).not.toHaveBeenCalled()
  })

  it('stores nothing when the answer is not the expected JSON', async () => {
    complete.mockResolvedValueOnce({
      text: 'Here are some notes.',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 900, outputTokens: 10 }
    })
    await expect(refreshVoiceNotes(db, deps)).rejects.toBeInstanceOf(AiProviderError)
    expect(getVoiceNotes(db)).toBeNull()
  })
})

describe('clearVoiceNotes (F-14.14)', () => {
  it('empties the notes, keeps the word count, and answers null when nothing was ever learned', () => {
    expect(clearVoiceNotes(db, NOW)).toBeNull()
    setVoiceNotes(db, { notes: NOTES, basedOnWords: 0, model: 'm', updated: 'x' })
    const before = currentVoiceVersion()
    expect(clearVoiceNotes(db, NOW)).toEqual({
      notes: [],
      basedOnWords: manuscriptDocuments(db)[0]?.wordCount,
      model: null,
      updated: NOW.toISOString()
    })
    expect(currentVoiceVersion()).toBeGreaterThan(before)
  })
})

describe('voiceNotesDue', () => {
  it('waits for the minimum before the first run, then for the refresh threshold either way', () => {
    expect(voiceNotesDue(null, VOICE_NOTES_MIN_WORDS - 1)).toBe(false)
    expect(voiceNotesDue(null, VOICE_NOTES_MIN_WORDS)).toBe(true)
    expect(voiceNotesDue({ basedOnWords: 3_000 }, 3_000 + VOICE_NOTES_REFRESH_WORDS - 1)).toBe(
      false
    )
    expect(voiceNotesDue({ basedOnWords: 3_000 }, 3_000 + VOICE_NOTES_REFRESH_WORDS)).toBe(true)
    expect(voiceNotesDue({ basedOnWords: 9_000 }, 9_000 - VOICE_NOTES_REFRESH_WORDS)).toBe(true)
  })
})

describe('sampleVoicePassages', () => {
  const passages = Array.from(
    { length: 30 },
    (_, i) => `${String(i).padStart(2, '0')} ${'x'.repeat(97)}`
  )

  it('takes the newest passage and a spread back to the start within the budget, in reading order', () => {
    const sample = sampleVoicePassages(passages, 1_000)
    expect(sample.at(-1)).toBe(passages[29])
    expect(sample.join('\n\n').length).toBeLessThanOrEqual(1_000)
    expect(sample.length).toBeGreaterThan(5)
    const indices = sample.map((p) => Number(p.slice(0, 2)))
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
    expect(indices[0]).toBeLessThan(10)
  })

  it('answers everything that fits, and nothing for nothing', () => {
    expect(sampleVoicePassages(passages.slice(0, 3), 10_000)).toEqual(passages.slice(0, 3))
    expect(sampleVoicePassages([], 1_000)).toEqual([])
  })
})

describe('parseVoiceNotesAnswer', () => {
  it('keeps trimmed, unique strings, strips list markers, cuts at the cap, and stops at the maximum', () => {
    const long = `${'word '.repeat(60)}end`
    const notes = parseVoiceNotesAnswer(
      JSON.stringify({
        notes: [
          '- Uses said.',
          ' Uses said. ',
          42,
          '',
          '2. Short paragraphs.',
          long,
          ...Array(10)
            .fill('x')
            .map((x, i) => `${x}${i}`)
        ]
      })
    )
    expect(notes[0]).toBe('Uses said.')
    expect(notes[1]).toBe('Short paragraphs.')
    expect(notes[2]?.length).toBeLessThanOrEqual(VOICE_NOTE_MAX_CHARS)
    expect(notes[2]?.endsWith('word')).toBe(true)
    expect(notes).toHaveLength(VOICE_NOTES_MAX)
  })

  it('is a PROVIDER failure for anything but { notes: [...] }', () => {
    for (const text of ['not json', '{"items":[]}', '[]']) {
      expect(() => parseVoiceNotesAnswer(text)).toThrow(AiProviderError)
    }
  })
})
