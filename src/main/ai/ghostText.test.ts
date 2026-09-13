import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GHOST_AFTER_CHARS, GHOST_BEFORE_CHARS, outputBudget, priceFor } from '@shared/ai'
import { defaultAiSettings } from '@shared/aiSettings'
import { builtinParams, defaultWritingPresets } from '@shared/presets'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveNotes } from '../document/notesStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { AppError } from '../ipc/errors'
import { setAiSettings, setWritingPresets } from '../project/settingsStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { generateGhostText, postProcessGhostText } from './ghostText'
import {
  AiProviderError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'

const NOW = new Date(2026, 8, 13, 10, 0, 0)
type Complete = (request: CompletionRequest) => Promise<CompletionResult>

let tmp: string
let session: ProjectSession
let db: TreeDb
let complete: ReturnType<typeof vi.fn<Complete>>
let deps: AiRequestDeps
let ledger: UsageEntry[]
let provider: Provider | null
let scene: string

const BEFORE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'
const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

function answer(text: string): void {
  complete.mockResolvedValue({
    text,
    model: 'gpt-5.4-mini',
    usage: { inputTokens: 120, outputTokens: 12 }
  })
}

const ask = (before = BEFORE, after = ''): ReturnType<typeof generateGhostText> =>
  generateGhostText(db, deps, { nodeId: scene, before, after })

async function failure(
  input: Parameters<typeof ask> = []
): Promise<{ code: string; message: string }> {
  try {
    await ask(...input)
  } catch (err) {
    if (err instanceof AiProviderError || err instanceof AppError) {
      return { code: err.code, message: err.message }
    }
    throw err
  }
  throw new Error('expected a failure')
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-ghost-'))
  session = createProject(projectFolderFor(tmp, 'Ghost'), 'Ghost', 'novel')
  db = session.connection.orm
  scene = listNodes(db).find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')?.id ?? ''
  if (!scene) throw new Error('skeleton not seeded')
  setAiSettings(db, { ...defaultAiSettings(), dial: 2 })
  complete = vi.fn<Complete>()
  answer('Somewhere ahead the river was rising.')
  ledger = []
  provider = {
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
    dailyCap: { get: () => ({ ...defaultAiUsageState(), spentDate: dayOf(NOW) }), spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('generateGhostText (F-5.3)', () => {
  it('sends the caret window as ghostText.v1 on the fast tier with the preset temperature and cap, and logs one row', async () => {
    const result = await ask(BEFORE, 'The ferry would not wait.')
    expect(result).toEqual({
      text: ' Somewhere ahead the river was rising. ',
      usage: { inputTokens: 120, outputTokens: 12 },
      costUsd: priceFor('gpt-5.4-mini', 120, 12).costUsd,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'ghostText.v1'
    })
    expect(complete).toHaveBeenCalledTimes(1)
    const request = complete.mock.calls[0]![0]
    const general = builtinParams('general')
    expect(request).toMatchObject({
      tier: 'fast',
      maxTokens: general.maxSuggestionTokens,
      temperature: general.temperature
    })
    expect(request.json).toBeUndefined()
    expect(request.messages[0]?.role).toBe('system')
    expect(request.messages[0]?.content).toContain(general.styleInstruction)
    expect(request.messages[1]?.content).toBe(
      `Passage so far:\n"""\n${BEFORE}\n"""\n\n` +
        'Text immediately after the cursor (do not repeat it):\n"""\nThe ferry would not wait.\n"""\n\n' +
        'Continue exactly at the cursor.'
    )
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      feature: 'ghostText',
      tier: 'fast',
      promptVersion: 'ghostText.v1',
      cached: false
    })
    expect(ledger[0]!.contextHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('folds the scene notes and metadata into the user turn, and nothing else of the document', async () => {
    saveNotes(db, scene, doc('Ends on the cliff.'))
    setSceneMeta(db, scene, { location: 'Ferry landing', pov: 'Mara', timeline: '' })
    await ask()
    expect(complete.mock.calls[0]![0].messages[1]?.content).toBe(
      'Scene: location Ferry landing, POV Mara, timeline —.\nNotes: Ends on the cliff.\n\n' +
        `Passage so far:\n"""\n${BEFORE}\n"""\n\nContinue exactly at the cursor.`
    )
  })

  it('uses the active preset and misses the cache when the preset, notes, or metadata change', async () => {
    await ask()
    await ask()
    expect(complete).toHaveBeenCalledTimes(1) // identical context: the cache answered
    expect(ledger[1]?.cached).toBe(true)
    setWritingPresets(db, { ...defaultWritingPresets(), active: 'action' })
    await ask()
    expect(complete).toHaveBeenCalledTimes(2)
    const action = builtinParams('action')
    expect(complete.mock.calls[1]![0]).toMatchObject({
      temperature: action.temperature,
      maxTokens: action.maxSuggestionTokens
    })
    expect(complete.mock.calls[1]![0].messages[0]?.content).toContain(action.styleInstruction)
    saveNotes(db, scene, doc('New note.'))
    await ask()
    expect(complete).toHaveBeenCalledTimes(3)
    setSceneMeta(db, scene, { location: 'Cliff', pov: '', timeline: '' })
    await ask()
    expect(complete).toHaveBeenCalledTimes(4)
  })

  it('never asks for more than the ghost-text output budget', async () => {
    setWritingPresets(db, {
      active: 'custom',
      custom: { ...builtinParams('general'), maxSuggestionTokens: 60 }
    })
    await ask()
    expect(complete.mock.calls[0]![0].maxTokens).toBe(outputBudget('ghostText'))
    expect(complete.mock.calls[0]![0].maxTokens).toBeLessThanOrEqual(60)
  })

  it('refuses with DISABLED below Suggest or with the feature toggled off, before reading anything', async () => {
    setAiSettings(db, { ...defaultAiSettings(), dial: 1 })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Ghost text needs the AI dial at Suggest or higher (it is at Ask).'
    })
    const on = defaultAiSettings()
    setAiSettings(db, { ...on, dial: 2, features: { ...on.features, ghostText: false } })
    expect(await failure()).toEqual({
      code: 'DISABLED',
      message: 'Ghost text is turned off for this project.'
    })
    expect(complete).not.toHaveBeenCalled()
    expect(ledger).toHaveLength(0)
  })

  it('refuses a caret window over the shared bounds with VALIDATION, and an unknown id with NOT_FOUND', async () => {
    expect((await failure(['x'.repeat(GHOST_BEFORE_CHARS + 1)])).code).toBe('VALIDATION')
    expect((await failure([BEFORE, 'y'.repeat(GHOST_AFTER_CHARS + 1)])).code).toBe('VALIDATION')
    await expect(
      generateGhostText(db, deps, { nodeId: 'nope', before: BEFORE, after: '' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('answers an empty text for a blank or all-whitespace answer', async () => {
    answer('   \n ')
    expect((await ask()).text).toBe('')
  })
})

describe('postProcessGhostText', () => {
  const before = 'The storm broke at dusk over the dark forest.'

  it('trims and strips one pair of straight, single, or curly quotes around the whole answer', () => {
    expect(postProcessGhostText('  "Rain followed."  ', before, '')).toBe(' Rain followed.')
    expect(postProcessGhostText("'Rain followed.'", before, '')).toBe(' Rain followed.')
    expect(postProcessGhostText('“Rain followed.”', before, '')).toBe(' Rain followed.')
    expect(postProcessGhostText('‘Rain followed.’', before, '')).toBe(' Rain followed.')
  })

  it('keeps quotes that are genuine dialogue', () => {
    expect(postProcessGhostText('"Run," she said. "Now."', before, '')).toBe(
      ' "Run," she said. "Now."'
    )
    expect(postProcessGhostText('"Run," she said.', before, '')).toBe(' "Run," she said.')
  })

  it('cuts to the first two sentences and drops an incomplete trailing fragment', () => {
    expect(
      postProcessGhostText('Rain followed. Then silence. Then the wind returned.', before, '')
    ).toBe(' Rain followed. Then silence.')
    expect(postProcessGhostText('Rain followed! Then silence, and the', before, '')).toBe(
      ' Rain followed!'
    )
    expect(postProcessGhostText('"Now," she said. "Run!" And they', before, '')).toBe(
      ' "Now," she said. "Run!"'
    )
  })

  it('keeps an answer with no sentence end at all (the model was cut by the cap)', () => {
    expect(postProcessGhostText('Rain followed and then the', before, '')).toBe(
      ' Rain followed and then the'
    )
  })

  it('drops a leading repeat of the passage tail, case-insensitively', () => {
    expect(postProcessGhostText('over the dark forest. Rain followed.', before, '')).toBe(
      ' Rain followed.'
    )
    expect(postProcessGhostText('At dusk over the DARK forest. Rain followed.', before, '')).toBe(
      ' Rain followed.'
    )
    // A short tail is too likely to match by accident, so nothing is dropped.
    expect(postProcessGhostText('The end.', 'The end', '')).toBe(' The end.')
  })

  it('answers empty for nothing left', () => {
    expect(postProcessGhostText('', before, '')).toBe('')
    expect(postProcessGhostText('""', before, '')).toBe('')
    expect(postProcessGhostText('over the dark forest.', before, '')).toBe('')
  })

  it('fixes the join at the caret: a space after punctuation or before a capital, none mid-word or after a space', () => {
    expect(postProcessGhostText('Rain followed.', 'It ended.', '')).toBe(' Rain followed.')
    expect(postProcessGhostText('Rain followed.', 'It ended. ', '')).toBe('Rain followed.')
    expect(postProcessGhostText('rm broke at dusk.', 'The sto', '')).toBe('rm broke at dusk.')
    expect(postProcessGhostText('Mara counted.', 'in the dark', '')).toBe(' Mara counted.')
    expect(postProcessGhostText('Rain followed.', '', '')).toBe('Rain followed.')
    expect(postProcessGhostText('Rain followed.', 'It ended.', 'Then silence.')).toBe(
      ' Rain followed. '
    )
    expect(postProcessGhostText('Rain followed.', 'It ended.', ' Then silence.')).toBe(
      ' Rain followed.'
    )
  })
})
