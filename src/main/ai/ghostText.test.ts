import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  estimateTokens,
  GHOST_AFTER_CHARS,
  GHOST_BEFORE_CHARS,
  outputBudget,
  priceFor
} from '@shared/ai'
import { STORY_BIBLE_GHOST_TOKEN_BUDGET, STORY_BIBLE_HEADING } from '@shared/storyBible'
import { defaultAiSettings } from '@shared/aiSettings'
import { builtinParams, defaultWritingPresets } from '@shared/presets'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { saveNotes } from '../document/notesStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { AppError } from '../ipc/errors'
import { setAiSettings, setAuthorRules, setWritingPresets } from '../project/settingsStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { addDocumentTag } from '../tag/documentTagStore'
import { createTag } from '../tag/tagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { addExemplar } from '../voice/exemplarStore'
import { bumpVoiceVersion, resetVoiceProfileCache } from '../voice/versionCache'
import { defaultAiUsageState, dayOf } from './dailyCap'
import { generateGhostText, postProcessGhostText } from './ghostText'
import { cancelInflight, inflightCount, resetInflight } from './inflight'
import {
  AiCancelledError,
  AiProviderError,
  AiRateLimitError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import type { AiRequestDeps } from './request'
import type { UsageEntry } from './usageStore'
import { EMPTY_SCENE_BRIEF, emptySceneMeta } from '@shared/sceneMeta'

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

/** One paragraph of third-person past narration with four dialogue tags; six of them trip the tense, person, and tag rules. */
const VOICE_PARAGRAPH =
  'Mara turned from the window and looked at the ridge, where the storm had settled for the ' +
  'night. "We should go," she said. "Not yet," Tomas replied. He knew she was tired, and he was ' +
  'tired too. They walked to the door and she pulled it open. "The river is rising," she said. ' +
  '"Then we wait," he said.'

/** Settles like the adapter once its `signal` aborts: rejects with CANCELLED. */
const untilCancelled = (request: CompletionRequest): Promise<never> =>
  new Promise((_, reject) => {
    request.signal?.addEventListener(
      'abort',
      () => reject(new AiCancelledError('The request was stopped.')),
      { once: true }
    )
  })

beforeEach(() => {
  resetVoiceProfileCache()
  resetInflight()
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
    session: { spend: () => {} },
    now: () => NOW,
    price: priceFor
  }
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('generateGhostText (F-5.3)', () => {
  it('sends the caret window as ghostText.v3 on the fast tier with the preset temperature and cap, and logs one row', async () => {
    const result = await ask(BEFORE, 'The ferry would not wait.')
    expect(result).toEqual({
      text: ' Somewhere ahead the river was rising. ',
      usage: { inputTokens: 120, outputTokens: 12 },
      costUsd: priceFor('gpt-5.4-mini', 120, 12).costUsd,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'ghostText.v3',
      flagged: false,
      violation: null
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
      promptVersion: 'ghostText.v3',
      cached: false
    })
    expect(ledger[0]!.contextHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('folds the scene notes and metadata into the user turn, and nothing else of the document', async () => {
    saveNotes(db, scene, doc('Ends on the cliff.'))
    setSceneMeta(db, scene, {
      location: 'Ferry landing',
      pov: 'Mara',
      timeline: '',
      brief: EMPTY_SCENE_BRIEF
    })
    await ask()
    expect(complete.mock.calls[0]![0].messages[1]?.content).toBe(
      'Scene: location Ferry landing, POV Mara, timeline —.\nNotes: Ends on the cliff.\n\n' +
        `Passage so far:\n"""\n${BEFORE}\n"""\n\nContinue exactly at the cursor.`
    )
  })

  it('folds the scene brief (F-14.3) in after the metadata line and before the notes, and misses the cache when it changes', async () => {
    saveNotes(db, scene, doc('Ends on the cliff.'))
    setSceneMeta(db, scene, {
      ...emptySceneMeta(),
      location: 'Ferry landing',
      brief: { ...EMPTY_SCENE_BRIEF, goal: 'Mara wants to cross tonight.' }
    })
    await ask()
    expect(complete.mock.calls[0]![0].messages[1]?.content).toBe(
      'Scene: location Ferry landing, POV —, timeline —.\n' +
        'Scene brief:\n- Goal: Mara wants to cross tonight.\n' +
        'Notes: Ends on the cliff.\n\n' +
        `Passage so far:\n"""\n${BEFORE}\n"""\n\nContinue exactly at the cursor.`
    )
    await ask()
    expect(complete).toHaveBeenCalledTimes(1)
    setSceneMeta(db, scene, {
      ...emptySceneMeta(),
      location: 'Ferry landing',
      brief: { ...EMPTY_SCENE_BRIEF, goal: 'Mara wants to wait for morning.' }
    })
    await ask()
    expect(complete).toHaveBeenCalledTimes(2)
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
    setSceneMeta(db, scene, { location: 'Cliff', pov: '', timeline: '', brief: EMPTY_SCENE_BRIEF })
    await ask()
    expect(complete).toHaveBeenCalledTimes(4)
  })

  it('folds the story bible into the system turn after the preset, at the ghost budget, and misses the cache when the bank or the tags change (F-14.9)', async () => {
    await ask()
    const fresh = complete.mock.calls[0]![0].messages[0]?.content ?? ''
    // A fresh project's scene has no bank, but its neighbours in the seeded skeleton (the
    // `scene` picked here is whichever chapter's `listNodes` lists first).
    expect(fresh).toMatch(
      new RegExp(
        `\\n\\n${STORY_BIBLE_HEADING.replace(/[()]/g, '\\$&')}\\nThis scene: "Scene 1", in "Chapter \\d", in "Part \\d", scene 1 of 1\\.\\n(Previous|Next) scene: "Scene 1"`
      )
    )
    expect(fresh.indexOf(STORY_BIBLE_HEADING)).toBeGreaterThan(
      fresh.indexOf(builtinParams('general').styleInstruction)
    )
    const mara = createTag(db, { name: 'Mara', category: 'character', color: '#112233' })
    await ask()
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[1]![0].messages[0]?.content).toContain('\nCharacters: mara\n')
    addDocumentTag(db, scene, mara.id)
    await ask()
    expect(complete).toHaveBeenCalledTimes(3)
    expect(complete.mock.calls[2]![0].messages[0]?.content).toContain('; tagged mara.')
    for (let i = 0; i < 80; i++) {
      createTag(db, { name: `person-${i}`, category: 'character', color: '#112233' })
    }
    await ask()
    const system = complete.mock.calls[3]![0].messages[0]?.content ?? ''
    const bible = system.slice(system.indexOf(STORY_BIBLE_HEADING))
    expect(estimateTokens(bible)).toBeLessThanOrEqual(STORY_BIBLE_GHOST_TOKEN_BUDGET)
    expect(bible).toMatch(/Characters: .* … and \d+ more\n/)
  })

  it('folds the voice profile into the system turn after the rules and misses the cache when the profile version moves (F-14.1)', async () => {
    saveDocument(db, scene, doc(Array(6).fill(VOICE_PARAGRAPH).join(' ')))
    const first = addExemplar(db, scene, VOICE_PARAGRAPH)
    await ask()
    const system = complete.mock.calls[0]![0].messages[0]?.content ?? ''
    const voiceAt = system.indexOf("Match the author's voice:")
    expect(voiceAt).toBeGreaterThan(0)
    expect(system).toContain('- Narration is in past tense.')
    expect(system).toContain('- Narration is in third person.')
    expect(system).toContain("- Dialogue tags are 'said' or 'asked' 75% of the time.")
    expect(system).toContain(`Example in this voice:\n"""\n${first.text}\n"""`)
    // The stable prefix order: rules, then the voice, then the preset's instruction.
    expect(voiceAt).toBeGreaterThan(system.indexOf('ghost-text continuation feature'))
    expect(voiceAt).toBeLessThan(system.indexOf(builtinParams('general').styleInstruction))
    const hashBefore = ledger[0]!.contextHash
    await ask()
    expect(complete).toHaveBeenCalledTimes(1) // same version: the cache answered
    bumpVoiceVersion()
    await ask()
    expect(complete).toHaveBeenCalledTimes(2)
    expect(ledger[2]!.contextHash).not.toBe(hashBefore)
  })

  it('leaves the voice slot empty for a project with no rules and no exemplars', async () => {
    await ask()
    expect(complete.mock.calls[0]![0].messages[0]?.content).not.toContain(
      "Match the author's voice"
    )
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

  it('hands the requestId to the request path so the provider gets its signal, and none without one (F-5.10)', async () => {
    await generateGhostText(db, deps, {
      nodeId: scene,
      before: BEFORE,
      after: '',
      requestId: 'g-1'
    })
    expect(complete.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal)
    expect(inflightCount()).toBe(0)
    await ask(BEFORE, 'x')
    expect('signal' in complete.mock.calls[1]![0]).toBe(false)
  })

  it('a cancel mid-flight rejects with CANCELLED and logs nothing', async () => {
    complete.mockImplementationOnce(untilCancelled)
    const pending = generateGhostText(db, deps, {
      nodeId: scene,
      before: BEFORE,
      after: '',
      requestId: 'g-1'
    })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(cancelInflight('g-1')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ledger).toEqual([])
    expect(inflightCount()).toBe(0)
  })

  it('answers an empty text for a blank or all-whitespace answer', async () => {
    answer('   \n ')
    expect((await ask()).text).toBe('')
  })
})

describe('generateGhostText fidelity check (F-14.7)', () => {
  /** Third person, past, no pronoun switch: passes every fragment check. */
  const CLEAN =
    'She turned back to the ridge and he followed, and they said nothing until the door had closed.'
  /** Five present markers and five first-person pronouns: trips tense first, then person. */
  const OFF_VOICE =
    'I am lost and I know we are done, and it is late, and my hands are cold, and I am tired.'
  const REGEN_CLAUSE =
    "Your last attempt switches to present tense. Write a different continuation that keeps the manuscript's voice."

  /** A manuscript strong enough for the tense and person rules. */
  const strongProfile = (): void => {
    saveDocument(db, scene, doc(Array(6).fill(VOICE_PARAGRAPH).join(' ')))
  }
  const answers = (...texts: string[]): void => {
    for (const text of texts) {
      complete.mockResolvedValueOnce({
        text,
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 120, outputTokens: 12 }
      })
    }
  }

  it('shows a clean answer after one call, unflagged', async () => {
    strongProfile()
    answers(CLEAN)
    const result = await ask()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ text: ` ${CLEAN}`, flagged: false, violation: null })
    expect(ledger).toHaveLength(1)
  })

  it('regenerates an off-voice answer once with the violation named, and shows the clean second answer with both calls summed', async () => {
    strongProfile()
    answers(OFF_VOICE, CLEAN)
    const result = await ask()
    expect(complete).toHaveBeenCalledTimes(2)
    const second = complete.mock.calls[1]![0]
    expect(second.messages[0]?.content.endsWith(REGEN_CLAUSE)).toBe(true)
    expect(second.messages[0]?.content).toContain("Match the author's voice:")
    expect(second.messages[1]).toEqual(complete.mock.calls[0]![0].messages[1])
    expect(second).toMatchObject({
      tier: 'fast',
      maxTokens: builtinParams('general').maxSuggestionTokens
    })
    expect(ledger.map((row) => row.promptVersion)).toEqual(['ghostText.v3', 'ghostTextRegen.v3'])
    expect(ledger[0]!.contextHash).not.toBe(ledger[1]!.contextHash)
    expect(result).toEqual({
      text: ` ${CLEAN}`,
      usage: { inputTokens: 240, outputTokens: 24 },
      costUsd: priceFor('gpt-5.4-mini', 120, 12).costUsd * 2,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'ghostTextRegen.v3',
      flagged: false,
      violation: null
    })
  })

  it('shows the second answer flagged with its violation when it is off-voice too', async () => {
    strongProfile()
    answers(OFF_VOICE, `"${OFF_VOICE}"  `)
    const result = await ask()
    expect(complete).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      text: ` ${OFF_VOICE}`,
      flagged: true,
      violation: 'switches to present tense',
      promptVersion: 'ghostTextRegen.v3',
      usage: { inputTokens: 240, outputTokens: 24 }
    })
  })

  it('falls back to the first answer, flagged, when the regenerate fails, and never throws', async () => {
    strongProfile()
    answers(OFF_VOICE)
    complete.mockRejectedValueOnce(new AiRateLimitError('Slow down.'))
    const result = await ask()
    expect(complete).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      text: ` ${OFF_VOICE}`,
      usage: { inputTokens: 120, outputTokens: 12 },
      costUsd: priceFor('gpt-5.4-mini', 120, 12).costUsd,
      cached: false,
      model: 'gpt-5.4-mini',
      promptVersion: 'ghostText.v3',
      flagged: true,
      violation: 'switches to present tense'
    })
    expect(ledger).toHaveLength(1) // a failed call is not logged
  })

  it('registers the regenerate under id:regen, and a cancel during it propagates as CANCELLED instead of falling back (F-5.10)', async () => {
    strongProfile()
    answers(OFF_VOICE)
    complete.mockImplementationOnce(untilCancelled)
    const pending = generateGhostText(db, deps, {
      nodeId: scene,
      before: BEFORE,
      after: '',
      requestId: 'g-1'
    })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2))
    expect(complete.mock.calls[1]![0].signal).toBeInstanceOf(AbortSignal)
    expect(cancelInflight('g-1')).toBe(false) // the first call is released
    expect(cancelInflight('g-1:regen')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ledger).toHaveLength(1) // the first call was logged; the cancelled one was not
    expect(inflightCount()).toBe(0)
  })

  it('keeps the first answer, flagged, when the regenerate comes back empty', async () => {
    strongProfile()
    answers(OFF_VOICE, '""')
    const result = await ask()
    expect(result).toMatchObject({
      text: ` ${OFF_VOICE}`,
      flagged: true,
      promptVersion: 'ghostText.v3'
    })
    expect(result.usage).toEqual({ inputTokens: 240, outputTokens: 24 })
  })

  it('never regenerates on a stylometric signal for a project with no rules and no exemplars', async () => {
    answers(OFF_VOICE)
    const result = await ask()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ text: ` ${OFF_VOICE}`, flagged: false, violation: null })
  })
})

describe('generateGhostText author rules (F-14.2)', () => {
  /** Clean against the stylometrics, but it uses a seeded AI-ism. */
  const BANNED = 'She turned back to the ridge and did not delve into it again.'
  const CLEAN = 'She turned back to the ridge and he followed, and the door closed behind them.'
  const BANNED_MESSAGE = 'uses the phrase \u201Cdelve\u201D, which the author has banned'
  const answers = (...texts: string[]): void => {
    for (const text of texts) {
      complete.mockResolvedValueOnce({
        text,
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 120, outputTokens: 12 }
      })
    }
  }

  it("sends the author's rules in the system turn, seeded phrases and all, on a fresh project", async () => {
    setAuthorRules(db, { rules: 'British spelling.', bannedPhrases: ['delve', 'tapestry'] })
    bumpVoiceVersion()
    await ask()
    const system = complete.mock.calls[0]![0].messages[0]?.content ?? ''
    expect(system).toContain("The author's rules (hard constraints):\nBritish spelling.")
    expect(system).toContain('Never use these phrases: delve; tapestry.')
    expect(system).not.toContain("Match the author's voice:") // no manuscript, no exemplars yet
  })

  it('regenerates a banned phrase with the phrase named and shows a clean second answer unflagged', async () => {
    answers(BANNED, CLEAN)
    const result = await ask()
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[1]![0].messages[0]?.content).toContain(
      `Your last attempt ${BANNED_MESSAGE}.`
    )
    expect(result).toMatchObject({
      text: ` ${CLEAN}`,
      flagged: false,
      violation: null,
      promptVersion: 'ghostTextRegen.v3'
    })
  })

  it('flags a second answer that still uses the phrase', async () => {
    answers(BANNED, BANNED)
    const result = await ask()
    expect(complete).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      text: ` ${BANNED}`,
      flagged: true,
      violation: BANNED_MESSAGE
    })
  })

  it('leaves a phrase the author removed alone, and misses the cache after the list changes', async () => {
    answers(BANNED)
    expect((await ask()).flagged).toBe(false) // regenerated into the default (clean) answer
    expect(complete).toHaveBeenCalledTimes(2)
    complete.mockClear()
    setAuthorRules(db, { rules: '', bannedPhrases: ['tapestry'] })
    bumpVoiceVersion()
    answers(BANNED)
    const result = await ask()
    expect(complete).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ text: ` ${BANNED}`, flagged: false, violation: null })
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
