import { defaultFocusSettings } from '@shared/focus'
import { defaultProjectSession } from '@shared/session'
import { growLegacyStarter } from '../project/testProject'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, sign } from 'node:crypto'
import { ipcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TreeNode,
  type Channel,
  type Input,
  type IpcResult,
  type Output,
  type Tag
} from '@shared/ipc/contract'
import { z } from 'zod'
import { AI_NEXT_STEP, DEFAULT_MODELS, LOCAL_DEFAULT_MODELS, USAGE_RECENT_LIMIT } from '@shared/ai'
import { defaultAiSettings, type AiDial } from '@shared/aiSettings'
import type { DiagnosticsBody } from '@shared/cloudApi'
import { RENDERER_ERROR_MESSAGE_MAX } from '@shared/diagnostics'
import { defaultExportFormatting } from '@shared/bookExport'
import {
  AUTHOR_RULES_TEXT_MAX,
  DEFAULT_BANNED_PHRASES,
  defaultAuthorRules
} from '@shared/authorRules'
import { defaultConversations, type Conversations } from '@shared/chat'
import { entityImageUrl } from '@shared/entities'
import { builtinParams, defaultWritingPresets } from '@shared/presets'
import { defaultEditorSettings } from '@shared/editorSettings'
import { defaultDock } from '@shared/dock'
import { defaultFloating, defaultLayout } from '@shared/layout'
import { EMPTY_SCENE_BRIEF, EMPTY_SCENE_META } from '@shared/sceneMeta'
import { SUMMARY_BACKFILL_DELAY_MS } from '@shared/summary'
import { writeV0Project } from '../project/legacyFixture'
import { DEFAULT_CATEGORY_COLOR } from '@shared/tags'
import { TAG_TEMPLATES } from '@shared/tagTemplates'
import type { CheckoutResult, CloudSession, CreditsResult, LicenseResult } from '@shared/cloudApi'
import { USAGE_PERIOD_DAYS } from '@shared/cloudUsage'
import {
  encodeLicensePayload,
  formatLicenseToken,
  LICENSE_GRACE_MS,
  LicensePublicKeyJwk,
  type LicenseClaims
} from '@shared/license'
import type { ViewSettings } from '@shared/zoom'
import { builtInTheme, CUSTOM_THEMES_MAX } from '@shared/themes'
import { AccountService } from '../account/accountService'
import type { CloudAuthClient } from '../account/cloudAuthClient'
import { registerInflight, resetInflight } from '../ai/inflight'
import { AiKeyStore } from '../ai/keyStore'
import { fakeSafeStorage } from '../ai/keyStoreFixture'
import {
  AiCancelledError,
  AiNetworkError,
  AiProviderError,
  InvalidKeyError,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type StreamChunk
} from '../ai/providers/types'
import { AiProviderRegistry } from '../ai/registry'
import { loadAgentProject } from '../ai/agentTools'
import { getProposal } from '../ai/proposalStore'
import { insertUsage } from '../ai/usageStore'
import { upsertSummary } from '../document/summaryStore'
import { replaceSceneFacts } from '../entity/observedFactStore'
import { manuscriptDocuments } from '../voice/profile'
import { passageHash, replaceAutoExemplars } from '../voice/exemplarStore'
import { bumpVoiceVersion } from '../voice/versionCache'
import { getVoiceAutoState, setVoiceNotes } from '../project/settingsStore'
import { aiProposal } from '../db/schema'
import { AppStateStore } from '../appState/appStateStore'
import { BackupService } from '../backups/backupService'
import { DiagnosticsService } from '../diagnostics/diagnosticsService'
import { UpdateService } from '../updates/updateService'
import type { ProjectDialogs } from '../dialogs'
import { ProjectManager } from '../project/manager'
import { projectFolderFor } from '../project/projectStore'
import { registerHandlers, type ClosableWindow } from './handlers'

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0' },
  ipcMain: { handle: vi.fn() }
}))

type Invoke = <C extends Channel>(channel: C, input: Input<C>) => Promise<Output<C>>

let tmp: string
let manager: ProjectManager
let invoke: Invoke
let handlerFor: (channel: Channel) => (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>
let fakeWin: ClosableWindow
/** The fake window's fullscreen flag (F-6.1); `setFullScreen` writes it unless a test pins it. */
let fullScreen: boolean
let onCloseCancelled: ReturnType<typeof vi.fn<() => void>>
/** The window `menu:edit` should use (F-7.1); null means none has the focus. */
let focusedWindow: ClosableWindow | null
let openExternal: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
/** F-8.4: what `shell.openPath` answers (empty = opened); tests set it per case. */
let openPath: ReturnType<typeof vi.fn<(folder: string) => Promise<string>>>
/** What the fake backup dialogs answer (F-8.4); null cancels. */
let backupFile: string | null
let restoreParent: string | null
let convertLegacy: boolean
let legacyAsked: { source: string; backup: string } | null
let backupFolder: string | null
/** Every list the handlers synced the spellchecker to (F-3.11), in order. */
let spellSync: ReturnType<typeof vi.fn<(words: string[]) => Promise<void>>>
let safe: ReturnType<typeof fakeSafeStorage>
let keyFile: string
/** What the fake provider's `testConnection` does; the registry builds it for any saved key. */
let testConnection: ReturnType<typeof vi.fn<() => Promise<{ model: string }>>>
/** F-15.4: the Cloud adapter's, so a test can tell which source a request took. */
let cloudTestConnection: ReturnType<typeof vi.fn<() => Promise<{ model: string }>>>
/** What the fake provider's `complete` answers (F-4.7); tests replace it per case. */
let complete: ReturnType<typeof vi.fn<(request: CompletionRequest) => Promise<CompletionResult>>>
/**
 * What the fake provider's `stream` yields (F-5.4); an Error in the list is thrown from that
 * pull, a function is awaited with the request (F-5.10: to hold the stream until cancelled).
 * Tests set it per case.
 */
let streamChunks: (StreamChunk | Error | ((request: CompletionRequest) => Promise<StreamChunk>))[]

/** Settles like the adapter once its `signal` aborts: rejects with CANCELLED (F-5.10). */
const untilCancelled = (request: CompletionRequest): Promise<never> =>
  new Promise((_, reject) => {
    request.signal?.addEventListener(
      'abort',
      () => reject(new AiCancelledError('The request was stopped.')),
      { once: true }
    )
  })

/**
 * F-15.9: one throwaway Ed25519 keypair for this file. The account service verifies every license
 * token against `licensePublicKey`, so `signLicense` is the only signer it trusts here.
 */
const { privateKey: licenseKey, publicKey: licensePublic } = generateKeyPairSync('ed25519')
const LICENSE_PUBLIC_JWK = LicensePublicKeyJwk.parse(licensePublic.export({ format: 'jwk' }))

const signLicense = (claims: LicenseClaims): string => {
  const payload = encodeLicensePayload(claims)
  return formatLicenseToken(payload, new Uint8Array(sign(null, payload, licenseKey)))
}

/** What the fake export dialog answers (F-14.6); null cancels. Tests set it per case. */
let exportPath: string | null
/** What the fake image dialog answers (F-6.2); null cancels. Tests set it per case. */
let chosenImages: string[] | null
/** What the fake entity-image dialog answers (F-9.3); null cancels. Tests set it per case. */
let chosenEntityImage: string | null
/** The default name and directory the last export dialog was asked for. */
let exportAsked: { defaultName: string; directory: string | undefined } | null
/** What the fake import dialog answers (F-12.2); null cancels. */
let manuscriptPath: string | null
/** What the fake entity-library dialog answers (F-9.5); null cancels. */
let entityFilePath: string | null
let tagBankPath: string | null

const UNSUPPORTED_UPDATES =
  'This is a development build; updates are installed by the released app.'

/** F-15.7: the update service a development build gets — no updater, one plain reason. */
const unsupportedUpdates = (appState: AppStateStore): UpdateService =>
  new UpdateService({
    updater: null,
    unsupportedReason: UNSUPPORTED_UPDATES,
    appState,
    currentVersion: '0.0.0',
    onChange: () => {}
  })

const DIAGNOSTICS_ENVIRONMENT = {
  appVersion: '0.0.0',
  platform: 'linux',
  arch: 'arm64',
  electron: '44.0.0'
}

/**
 * F-15.8: the real service with no sender, which is what a test and a build without an endpoint
 * get: it records and answers, and nothing ever leaves. It is tested in
 * `diagnostics/diagnosticsService.test.ts`.
 */
/**
 * F-8.4: the real backup service with its defaults, writing under this test's temp folder (so a
 * project closed here is backed up like in the app). It is tested in `backups/backupService.test.ts`.
 */
const localBackups = (appState: AppStateStore): BackupService =>
  new BackupService({
    appState,
    projects: manager,
    defaultFolder: path.join(tmp, 'backups'),
    onChange: () => {}
  })

const localDiagnostics = (appState: AppStateStore): DiagnosticsService =>
  new DiagnosticsService({
    appState,
    environment: DIAGNOSTICS_ENVIRONMENT,
    appRoots: ['/app'],
    onChange: () => {}
  })

const dialogs: ProjectDialogs = {
  chooseProjectSavePath: async () => null,
  chooseProjectToOpen: async () => null,
  chooseExportPath: async (defaultName, _filters, directory) => {
    exportAsked = { defaultName, directory }
    return exportPath
  },
  chooseImages: async () => chosenImages,
  chooseEntityImage: async () => chosenEntityImage,
  chooseManuscriptFile: async () => manuscriptPath,
  chooseEntityLibraryFile: async () => entityFilePath,
  chooseTagBankFile: async () => tagBankPath,
  chooseBackupFolder: async () => backupFolder,
  chooseBackupFile: async () => backupFile,
  chooseRestoreParent: async () => restoreParent,
  confirmLegacyConversion: async (source, backup) => {
    legacyAsked = { source, backup }
    return convertLegacy
  }
}

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear()
  resetInflight()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-handlers-'))
  exportPath = null
  exportAsked = null
  chosenImages = null
  chosenEntityImage = null
  manuscriptPath = null
  entityFilePath = null
  tagBankPath = null
  manager = new ProjectManager()
  fullScreen = false
  fakeWin = {
    close: vi.fn(),
    isDestroyed: () => false,
    webContents: {
      send: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      cut: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      setZoomFactor: vi.fn(),
      replaceMisspelling: vi.fn()
    },
    setBackgroundColor: vi.fn(),
    setFullScreen: vi.fn((on: boolean) => {
      fullScreen = on
    }),
    isFullScreen: () => fullScreen
  }
  onCloseCancelled = vi.fn<() => void>()
  focusedWindow = null
  openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve())
  openPath = vi.fn<(folder: string) => Promise<string>>(() => Promise.resolve(''))
  backupFile = null
  restoreParent = null
  convertLegacy = true
  legacyAsked = null
  backupFolder = null
  spellSync = vi.fn<(words: string[]) => Promise<void>>(() => Promise.resolve())
  safe = fakeSafeStorage()
  keyFile = path.join(tmp, 'userData', 'ai-keys.json')
  const keyStore = new AiKeyStore(keyFile, safe, 'win32')
  testConnection = vi.fn<() => Promise<{ model: string }>>(() =>
    Promise.resolve({ model: 'gpt-fake' })
  )
  complete = vi.fn<(request: CompletionRequest) => Promise<CompletionResult>>(() =>
    Promise.resolve({
      text: '{"tags":["dark-forest","protagonist"]}',
      model: 'gpt-fake',
      usage: { inputTokens: 40, outputTokens: 10 }
    })
  )
  streamChunks = []
  const provider: Provider = {
    id: 'openai',
    resolveModel: () => 'gpt-fake',
    complete,
    stream: async function* (request) {
      for (const chunk of streamChunks) {
        if (chunk instanceof Error) throw chunk
        yield typeof chunk === 'function' ? await chunk(request) : chunk
      }
    },
    testConnection
  }
  // F-15.4: the Cloud adapter, so a project whose source is `cloud` reaches something.
  cloudTestConnection = vi.fn<() => Promise<{ model: string }>>(() =>
    Promise.resolve({ model: 'cloud-fake' })
  )
  const cloudProvider: Provider = {
    ...provider,
    id: 'cloud',
    resolveModel: () => 'cloud-fake',
    testConnection: cloudTestConnection
  }
  const appState = new AppStateStore(path.join(tmp, 'userData', 'app-state.json'))
  // F-15.2: the account channels only forward to the service, which has its own tests; here it
  // is real over a client that is never reached (no test signs in).
  const cloudClient: CloudAuthClient = {
    start: () => Promise.reject(new Error('no cloud in these tests')),
    poll: () => Promise.reject(new Error('no cloud in these tests')),
    me: () => Promise.reject(new Error('no cloud in these tests')),
    signOut: () => Promise.resolve(),
    credits: () => Promise.reject(new Error('no cloud in these tests')),
    checkout: () => Promise.reject(new Error('no cloud in these tests')),
    license: () => Promise.reject(new Error('no cloud in these tests'))
  }
  registerHandlers({
    manager,
    appState,
    keyStore,
    ai: new AiProviderRegistry(
      keyStore,
      () => appState.get().models,
      () => provider,
      () => cloudProvider,
      () => appState.get().localAi,
      () => provider
    ),
    account: new AccountService({
      client: cloudClient,
      keyStore,
      appState,
      licensePublicKey: LICENSE_PUBLIC_JWK,
      onChange: () => {},
      onSupporterChange: () => {}
    }),
    // F-15.7: a service with no updater, which is what a development build has; the service
    // itself is tested in `updates/updateService.test.ts`.
    updates: unsupportedUpdates(appState),
    diagnostics: localDiagnostics(appState),
    backups: localBackups(appState),
    dialogs,
    windows: () => [fakeWin],
    focusedWindow: () => focusedWindow,
    spellDictionary: { sync: spellSync },
    openExternal,
    openPath,
    onCloseCancelled
  })
  const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>>()
  for (const [channel, fn] of vi.mocked(ipcMain.handle).mock.calls) {
    handlers.set(channel, fn as (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>)
  }
  handlerFor = (channel) => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`No handler registered for ${channel}`)
    return fn
  }
  invoke = async (channel, input) => {
    const fn = handlers.get(channel)
    if (!fn) throw new Error(`No handler registered for ${channel}`)
    const result = await fn(undefined, input)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.data as Output<typeof channel>
  }
})
afterEach(() => {
  manager.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/**
 * The manuscript's document ids in reading order (depth-first from the manuscript root, siblings
 * by position): what the per-scene reports walk since F-14.3. `tree:list` itself is ordered by
 * parent id, which is not reading order across chapters.
 */
function manuscriptReadingOrder(rows: TreeNode[]): string[] {
  const root = rows.find((r) => r.parentId === null && r.sectionType === 'manuscript')
  const walk = (parentId: string): string[] =>
    rows
      .filter((r) => r.parentId === parentId)
      .sort((a, b) => a.position - b.position)
      .flatMap((r) => (r.kind === 'document' ? [r.id] : walk(r.id)))
  return root ? walk(root.id) : []
}

describe('window state handlers (F-7.9)', () => {
  const stored = (): AppStateStore =>
    new AppStateStore(path.join(tmp, 'userData', 'app-state.json'))

  it('remembers the open project, keeps it on a window close, and forgets it on Close project', async () => {
    const a = await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    expect(stored().get().window.lastProject).toBe(a?.path)
    const b = await invoke('project:create', { name: 'B', format: 'novel', directory: tmp })
    expect(stored().get().window.lastProject).toBe(b?.path)
    await invoke('window:close', undefined)
    expect(stored().get().window.lastProject).toBe(b?.path)
    await invoke('project:open', { path: a?.path ?? '' })
    await invoke('project:close', undefined)
    expect(stored().get().window.lastProject).toBeNull()
  })

  it('answers and persists the reopen choice, on by default', async () => {
    expect(await invoke('startup:get', undefined)).toEqual({ reopenLastProject: true })
    expect(await invoke('startup:setReopenLastProject', { on: false })).toEqual({
      reopenLastProject: false
    })
    expect(stored().get().window.reopenLastProject).toBe(false)
    expect(await invoke('startup:get', undefined)).toEqual({ reopenLastProject: false })
  })
})

describe('opening a v0 project (F-1.6)', () => {
  it('asks first, converts on yes, and opens the converted project at the same path', async () => {
    const file = path.join(tmp, 'Ferryman.mythscribe')
    writeV0Project(file)
    const original = fs.readFileSync(file)

    convertLegacy = false
    expect(await invoke('project:open', { path: file })).toBeNull()
    expect(legacyAsked?.source).toBe(file)
    expect(path.basename(legacyAsked?.backup ?? '')).toMatch(
      /^Ferryman \(v0 backup \d{4}-\d{2}-\d{2}\)\.mythscribe$/
    )
    expect(fs.readFileSync(file)).toEqual(original)
    expect(await invoke('project:current', undefined)).toBeNull()

    convertLegacy = true
    const info = await invoke('project:open', { path: file })
    expect(info).toMatchObject({ name: 'Ferryman', format: 'epic', path: file })
    expect(fs.readFileSync(legacyAsked?.backup ?? '')).toEqual(original)
    const rows = await invoke('tree:list', undefined)
    expect(rows.map((r) => r.title)).toContain('Landing')
    expect((await invoke('recents:list', undefined))[0]?.path).toBe(file)
  })
})

describe('recents handlers', () => {
  it('records created and opened projects newest first', async () => {
    const a = await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    const b = await invoke('project:create', { name: 'B', format: 'epic', directory: tmp })
    const list = await invoke('recents:list', undefined)
    expect(list).toEqual([
      { path: b?.path, name: 'B', format: 'epic', lastOpened: b?.lastOpened, exists: true },
      { path: a?.path, name: 'A', format: 'novel', lastOpened: a?.lastOpened, exists: true }
    ])
  })

  it('moves a reopened project to the front without duplicating it', async () => {
    const a = await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    await invoke('project:create', { name: 'B', format: 'novel', directory: tmp })
    const reopened = await invoke('project:open', { path: a?.path ?? '' })
    const list = await invoke('recents:list', undefined)
    expect(list.map((r) => r.name)).toEqual(['A', 'B'])
    expect(list[0]?.lastOpened).toBe(reopened?.lastOpened)
  })

  it('flags entries whose folder is no longer a project', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    await invoke('project:close', undefined)
    fs.rmSync(projectFolderFor(tmp, 'A'), { recursive: true, force: true })
    const list = await invoke('recents:list', undefined)
    expect(list.map((r) => r.exists)).toEqual([false])
  })

  it('removes an entry and returns the remaining list', async () => {
    const a = await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    await invoke('project:create', { name: 'B', format: 'novel', directory: tmp })
    const remaining = await invoke('recents:remove', { path: a?.path ?? '' })
    expect(remaining.map((r) => r.name)).toEqual(['B'])
    expect((await invoke('recents:list', undefined)).map((r) => r.name)).toEqual(['B'])
  })

  it('treats removing an unknown path as a no-op', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    const remaining = await invoke('recents:remove', { path: path.join(tmp, 'nowhere') })
    expect(remaining.map((r) => r.name)).toEqual(['A'])
  })

  it('persists recents across store instances', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    const fresh = new AppStateStore(path.join(tmp, 'userData', 'app-state.json'))
    expect(fresh.get().recents.map((r) => r.name)).toEqual(['A'])
  })
})

describe('tree:list', () => {
  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('tree:list', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('returns the seeded skeleton of the open project (F-1.3)', async () => {
    await invoke('project:create', { name: 'Seeded', format: 'webnovel', directory: tmp })
    const rows = z.array(TreeNode).parse(await invoke('tree:list', undefined))
    expect(rows).toHaveLength(6)
    expect(rows.filter((r) => r.sectionType !== null)).toHaveLength(3)
    expect(rows.map((r) => r.title)).toContain('Arc 1')
    expect(rows.filter((r) => r.kind === 'document')).toHaveLength(1)
  })
})

describe('tree:create / tree:rename / tree:duplicate / tree:delete', () => {
  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(
      invoke('tree:create', { parentId: 'x', kind: 'document', hierarchyLevel: null })
    ).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('creates a node that tree:list then shows at the expected position', async () => {
    await invoke('project:create', { name: 'Tree', format: 'webnovel', directory: tmp })
    growLegacyStarter(manager.require(), 'webnovel')
    const before = await invoke('tree:list', undefined)
    const manuscript = before.find((r) => r.sectionType === 'manuscript')
    const arc1 = before.find((r) => r.parentId === manuscript?.id && r.position === 0)
    const created = await invoke('tree:create', {
      parentId: manuscript?.id ?? '',
      kind: 'folder',
      hierarchyLevel: 'part',
      afterId: arc1?.id
    })
    expect(created).toMatchObject({ title: 'Untitled Arc', position: 1, parentId: manuscript?.id })
    const after = await invoke('tree:list', undefined)
    const parts = after.filter((r) => r.parentId === manuscript?.id)
    expect(parts.map((r) => [r.title, r.position])).toEqual([
      ['Arc 1', 0],
      ['Untitled Arc', 1],
      ['Arc 2', 2]
    ])
  })

  it('renames a node and the change shows in tree:list', async () => {
    await invoke('project:create', { name: 'Tree', format: 'novel', directory: tmp })
    const scene = (await invoke('tree:list', undefined)).find((r) => r.kind === 'document')
    const renamed = await invoke('tree:rename', { id: scene?.id ?? '', title: '  Opening  ' })
    expect(renamed).toMatchObject({ id: scene?.id, title: 'Opening' })
    const listed = (await invoke('tree:list', undefined)).find((r) => r.id === scene?.id)
    expect(listed?.title).toBe('Opening')
  })

  it('duplicates a node and its subtree; tree:list shows the copy after the original', async () => {
    await invoke('project:create', { name: 'Tree', format: 'webnovel', directory: tmp })
    growLegacyStarter(manager.require(), 'webnovel')
    const before = await invoke('tree:list', undefined)
    const chapter = before.find((r) => r.hierarchyLevel === 'chapter' && r.position === 0)
    const rows = await invoke('tree:duplicate', { id: chapter?.id ?? '' })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ title: 'Chapter 1 (Copy)', parentId: chapter?.parentId })
    expect(rows[1]).toMatchObject({ title: 'Scene 1', parentId: rows[0]?.id })
    const after = await invoke('tree:list', undefined)
    expect(after).toHaveLength(19)
    const siblings = after.filter((r) => r.parentId === chapter?.parentId)
    expect(siblings.map((r) => [r.title, r.position])).toEqual([
      ['Chapter 1', 0],
      ['Chapter 1 (Copy)', 1],
      ['Chapter 2', 2],
      ['Chapter 3', 3]
    ])
  })

  it('deletes a node with its subtree and closes the sibling gap', async () => {
    await invoke('project:create', { name: 'Tree', format: 'webnovel', directory: tmp })
    growLegacyStarter(manager.require(), 'webnovel')
    const before = await invoke('tree:list', undefined)
    const chapter = before.find((r) => r.hierarchyLevel === 'chapter' && r.position === 1)
    expect(await invoke('tree:delete', { id: chapter?.id ?? '' })).toBeNull()
    const after = await invoke('tree:list', undefined)
    expect(after).toHaveLength(15)
    expect(after.find((r) => r.id === chapter?.id)).toBeUndefined()
    expect(after.filter((r) => r.parentId === chapter?.id)).toHaveLength(0)
    const siblings = after.filter((r) => r.parentId === chapter?.parentId)
    expect(siblings.map((r) => [r.title, r.position])).toEqual([
      ['Chapter 1', 0],
      ['Chapter 3', 1]
    ])
  })

  it('rejects an unknown template id at the contract boundary and fills a known one (F-2.6)', async () => {
    await invoke('project:create', { name: 'Tree', format: 'novel', directory: tmp })
    const front = (await invoke('tree:list', undefined)).find((r) => r.sectionType === 'front')
    const raw = handlerFor('tree:create')
    const result = await raw(undefined, {
      parentId: front?.id,
      kind: 'document',
      hierarchyLevel: null,
      template: 'colophon'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    const created = await invoke('tree:create', {
      parentId: front?.id ?? '',
      kind: 'document',
      hierarchyLevel: null,
      template: 'title-page'
    })
    expect(created).toMatchObject({ title: 'Title Page', matterType: 'title-page', position: 0 })
    expect(created.wordCount).toBeGreaterThan(0)
    const doc = await invoke('document:get', { id: created.id })
    expect(doc.content?.type).toBe('doc')
    const listed = (await invoke('tree:list', undefined)).find((r) => r.id === created.id)
    expect(listed).toMatchObject({ matterType: 'title-page', wordCount: created.wordCount })
  })

  it('rejects an empty title at the contract boundary', async () => {
    await invoke('project:create', { name: 'Tree', format: 'novel', directory: tmp })
    const scene = (await invoke('tree:list', undefined)).find((r) => r.kind === 'document')
    await expect(invoke('tree:rename', { id: scene?.id ?? '', title: '   ' })).rejects.toThrowError(
      /^VALIDATION: /
    )
  })
})

describe('tree:move', () => {
  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('tree:move', { id: 'x', parentId: 'y' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('moves a chapter into another arc and tree:list shows both parents contiguous', async () => {
    await invoke('project:create', { name: 'Tree', format: 'webnovel', directory: tmp })
    growLegacyStarter(manager.require(), 'webnovel')
    const before = await invoke('tree:list', undefined)
    const manuscript = before.find((r) => r.sectionType === 'manuscript')
    const arc1 = before.find((r) => r.parentId === manuscript?.id && r.position === 0)
    const arc2 = before.find((r) => r.parentId === manuscript?.id && r.position === 1)
    const chapter3 = before.find((r) => r.parentId === arc1?.id && r.position === 2)
    const moved = await invoke('tree:move', {
      id: chapter3?.id ?? '',
      parentId: arc2?.id ?? '',
      afterId: null
    })
    expect(moved).toMatchObject({ id: chapter3?.id, parentId: arc2?.id, position: 0 })
    const after = await invoke('tree:list', undefined)
    expect(after).toHaveLength(17)
    // Each arc numbers its chapters 1–3, so assert by id rather than title.
    const ids = (parentId: string | undefined): [string | undefined, number][] =>
      after.filter((r) => r.parentId === parentId).map((r) => [r.id, r.position])
    const arc1Before = before.filter((r) => r.parentId === arc1?.id).map((r) => r.id)
    const arc2Before = before.filter((r) => r.parentId === arc2?.id).map((r) => r.id)
    expect(ids(arc1?.id)).toEqual([
      [arc1Before[0], 0],
      [arc1Before[1], 1]
    ])
    expect(ids(arc2?.id)).toEqual([
      [chapter3?.id, 0],
      [arc2Before[0], 1],
      [arc2Before[1], 2],
      [arc2Before[2], 3]
    ])
    expect(after.filter((r) => r.parentId === chapter3?.id)).toHaveLength(1)
  })

  it('reorders within the same parent when afterId is a later sibling', async () => {
    await invoke('project:create', { name: 'Tree', format: 'webnovel', directory: tmp })
    growLegacyStarter(manager.require(), 'webnovel')
    const before = await invoke('tree:list', undefined)
    const arc1 = before.find((r) => r.hierarchyLevel === 'part' && r.position === 0)
    const chapters = before.filter((r) => r.parentId === arc1?.id)
    const [c1, c2] = chapters
    await invoke('tree:move', { id: c1?.id ?? '', parentId: arc1?.id ?? '', afterId: c2?.id })
    const after = await invoke('tree:list', undefined)
    expect(after.filter((r) => r.parentId === arc1?.id).map((r) => [r.title, r.position])).toEqual([
      ['Chapter 2', 0],
      ['Chapter 1', 1],
      ['Chapter 3', 2]
    ])
  })

  it('rejects a cross-section move with VALIDATION', async () => {
    await invoke('project:create', { name: 'Tree', format: 'novel', directory: tmp })
    const before = await invoke('tree:list', undefined)
    const front = before.find((r) => r.sectionType === 'front')
    const doc = await invoke('tree:create', {
      parentId: front?.id ?? '',
      kind: 'document',
      hierarchyLevel: null
    })
    const chapter = before.find((r) => r.hierarchyLevel === 'chapter')
    await expect(
      invoke('tree:move', { id: doc.id, parentId: chapter?.id ?? '' })
    ).rejects.toThrowError(/^VALIDATION: Moves are restricted to within a section/)
  })
})

describe('document:get', () => {
  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('document:get', { id: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('returns null content for a seeded scene and refuses folders (F-3.1)', async () => {
    await invoke('project:create', { name: 'Doc', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    const chapter = rows.find((r) => r.hierarchyLevel === 'chapter')
    expect(await invoke('document:get', { id: scene?.id ?? '' })).toEqual({
      id: scene?.id,
      content: null
    })
    await expect(invoke('document:get', { id: chapter?.id ?? '' })).rejects.toThrowError(
      /^VALIDATION: /
    )
    await expect(invoke('document:get', { id: 'missing' })).rejects.toThrowError(/^NOT_FOUND: /)
  })
})

describe('document:save', () => {
  const para = (text: string): Input<'document:save'>['content'] => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('document:save', { id: 'x', content: para('x') })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('saves a seeded scene so document:get and tree:list reflect it (F-3.2)', async () => {
    await invoke('project:create', { name: 'Doc', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    const saved = await invoke('document:save', {
      id: scene?.id ?? '',
      content: para('The storm broke at dusk.')
    })
    expect(saved.wordCount).toBe(5)
    expect(typeof saved.modified).toBe('string')
    expect(await invoke('document:get', { id: scene?.id ?? '' })).toEqual({
      id: scene?.id,
      content: para('The storm broke at dusk.')
    })
    const listed = (await invoke('tree:list', undefined)).find((r) => r.id === scene?.id)
    expect(listed).toMatchObject({ wordCount: 5, modified: saved.modified })
  })

  it('refuses folders with VALIDATION and unknown ids with NOT_FOUND', async () => {
    await invoke('project:create', { name: 'Doc', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const chapter = rows.find((r) => r.hierarchyLevel === 'chapter')
    await expect(
      invoke('document:save', { id: chapter?.id ?? '', content: para('x') })
    ).rejects.toThrowError(/^VALIDATION: /)
    await expect(
      invoke('document:save', { id: 'missing', content: para('x') })
    ).rejects.toThrowError(/^NOT_FOUND: /)
  })

  it('rejects content that is not a Tiptap document at the contract boundary', async () => {
    await invoke('project:create', { name: 'Doc', format: 'novel', directory: tmp })
    const scene = (await invoke('tree:list', undefined)).find((r) => r.kind === 'document')
    const raw = handlerFor('document:save')
    const result = await raw(undefined, { id: scene?.id, content: { content: [] } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
  })
})

describe('recovery:* (F-8.3)', () => {
  const para = (text: string): Input<'document:save'>['content'] => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('recovery:list', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('lists only entries that differ from what is stored, then restores them', async () => {
    await invoke('project:create', { name: 'Crash', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    const chapter = rows.find((r) => r.hierarchyLevel === 'chapter')
    const sceneId = scene?.id ?? ''
    const chapterId = chapter?.id ?? ''
    await invoke('document:save', { id: sceneId, content: para('Saved already.') })
    await invoke('recovery:stash', {
      kind: 'document',
      id: sceneId,
      content: para('Lost words here.')
    })
    await invoke('recovery:stash', {
      kind: 'notes',
      id: chapterId,
      content: para('A chapter note.')
    })
    // Equal to the stored notes (none stored → the empty document): dropped.
    await invoke('recovery:stash', {
      kind: 'notes',
      id: sceneId,
      content: { type: 'doc', content: [{ type: 'paragraph' }] }
    })
    // A chapter has no document content: dropped.
    await invoke('recovery:stash', { kind: 'document', id: chapterId, content: para('x') })
    await invoke('recovery:stash', { kind: 'document', id: 'gone-node', content: para('x') })

    const listed = await invoke('recovery:list', undefined)
    expect(listed).toEqual([
      { kind: 'document', id: sceneId, title: scene?.title },
      { kind: 'notes', id: chapterId, title: chapter?.title }
    ])

    const restored = await invoke('recovery:restore', undefined)
    expect(restored).toEqual([
      { kind: 'document', id: sceneId, wordCount: 3 },
      { kind: 'notes', id: chapterId, wordCount: null }
    ])
    expect((await invoke('document:get', { id: sceneId })).content).toEqual(
      para('Lost words here.')
    )
    expect((await invoke('notes:get', { id: chapterId })).notes).toEqual(para('A chapter note.'))
    expect(await invoke('recovery:list', undefined)).toEqual([])
    const goals = await invoke('goals:get', undefined)
    expect(goals.today.words).toBe(3) // 2 saved, then +1 recovered
  })

  it('clears one entry and discards the whole journal', async () => {
    await invoke('project:create', { name: 'Crash', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const sceneId = rows.find((r) => r.kind === 'document')?.id ?? ''
    await invoke('recovery:stash', { kind: 'document', id: sceneId, content: para('One.') })
    await invoke('recovery:clear', { kind: 'document', id: sceneId })
    expect(await invoke('recovery:list', undefined)).toEqual([])
    await invoke('recovery:stash', { kind: 'document', id: sceneId, content: para('Two.') })
    await invoke('recovery:discard', undefined)
    expect(fs.existsSync(path.join(projectFolderFor(tmp, 'Crash'), 'recovery'))).toBe(false)
    await expect(
      invoke('recovery:stash', { kind: 'document', id: '../x', content: para('x') })
    ).rejects.toThrowError(/^VALIDATION: /)
  })
})

describe('stats:wordCount (F-10.4)', () => {
  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('stats:wordCount', { nodeId: null })).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('counts the chapter around a scene and the manuscript from the stored documents', async () => {
    await invoke('project:create', { name: 'Counts', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = manuscriptReadingOrder(rows)[0] ?? ''
    const chapter = rows.find((r) => r.id === rows.find((n) => n.id === scene)?.parentId)
    await invoke('document:save', {
      id: scene,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The storm broke.' }] }]
      }
    })
    const stats = { words: 3, characters: 16, charactersNoSpaces: 14 }
    expect(await invoke('stats:wordCount', { nodeId: scene })).toEqual({
      chapter: { id: chapter?.id, title: chapter?.title, stats },
      manuscript: stats
    })
  })
})

describe('stats:dashboard (F-10.5)', () => {
  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('stats:dashboard', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it("shows today's saved words, the scene's POV, and its character", async () => {
    await invoke('project:create', { name: 'Stats', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = manuscriptReadingOrder(rows)[0] ?? ''
    await invoke('document:save', {
      id: scene,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mara ran.' }] }]
      }
    })
    await invoke('sceneMeta:set', { id: scene, meta: { ...EMPTY_SCENE_META, pov: 'Mara' } })
    const mara = await invoke('tag:create', { name: 'mara', category: 'character' })
    await invoke('documentTag:add', { nodeId: scene, tagId: mara.id })
    const stats = await invoke('stats:dashboard', undefined)
    expect(stats.days).toEqual([expect.objectContaining({ day: stats.today, words: 2 })])
    expect(stats.pov).toContainEqual({ pov: 'Mara', scenes: 1, words: 2 })
    // Mentions depend on the background scan; the link alone puts the scene in.
    expect(stats.characters).toHaveLength(1)
    expect(stats.characters[0]).toMatchObject({
      tagId: mara.id,
      name: 'mara',
      scenes: 1,
      povScenes: 1
    })
  })
})

describe('goals:get / goals:set (F-10.3)', () => {
  const para = (text: string): Input<'document:save'>['content'] => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('goals:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('goals:set', { dailyTarget: 5 })).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('counts net words of manuscript saves only, and resets the session on reopen', async () => {
    const created = await invoke('project:create', {
      name: 'Goals',
      format: 'novel',
      directory: tmp
    })
    const rows = await invoke('tree:list', undefined)
    const scene = manuscriptReadingOrder(rows)[0] ?? ''
    const front = rows.find((r) => r.sectionType === 'front')
    const matter = await invoke('tree:create', {
      parentId: front?.id ?? '',
      kind: 'document',
      hierarchyLevel: null
    })
    await invoke('document:save', { id: scene, content: para('The storm broke at dusk.') })
    await invoke('document:save', { id: scene, content: para('The storm broke at dusk again.') })
    await invoke('document:save', { id: matter.id, content: para('For my mother, always.') })
    // A replace rewrites the scene but writes no words.
    await invoke('replace:commit', {
      query: 'storm',
      replacement: 'great storm',
      matchCase: false,
      wholeWord: false,
      scopeId: null,
      ids: [scene]
    })
    const status = await invoke('goals:get', undefined)
    expect(status.today.words).toBe(6)
    expect(status.session.words).toBe(6)
    expect(status.manuscriptWords).toBe(7)

    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    const reopened = await invoke('goals:get', undefined)
    expect(reopened.session).toEqual({ words: 0, activeMs: 0 })
    expect(reopened.today.words).toBe(6)
  })

  it('switches and reverts drafts (F-8.5) without counting words written', async () => {
    await expect(invoke('drafts:list', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await invoke('project:create', { name: 'Drafts', format: 'novel', directory: tmp })
    const scene = manuscriptReadingOrder(await invoke('tree:list', undefined))[0] ?? ''
    await invoke('document:save', { id: scene, content: para('The storm broke.') })
    const first = (await invoke('drafts:list', undefined)).activeId
    const list = await invoke('drafts:duplicate', { id: first, name: ' Draft 2 ' })
    const second = list.drafts.find((each) => each.name === 'Draft 2')?.id ?? ''
    await invoke('drafts:switch', { id: second })
    await invoke('document:save', { id: scene, content: para('The storm broke at dawn.') })
    const words = (await invoke('goals:get', undefined)).today.words

    const back = await invoke('drafts:switch', { id: first })
    expect(back.changed).toEqual([{ id: scene, wordCount: 3 }])
    expect((await invoke('document:get', { id: scene })).content).toEqual(para('The storm broke.'))
    const compared = await invoke('drafts:compare', { fromId: first, toId: second })
    expect(compared.docs.map((each) => [each.nodeId, each.wordsAdded])).toEqual([[scene, 3]])
    const reverted = await invoke('drafts:revert', { fromId: second, nodeIds: [scene] })
    expect(reverted.changed).toEqual([{ id: scene, wordCount: 5 }])
    expect((await invoke('goals:get', undefined)).today.words).toBe(words)
    await expect(invoke('drafts:delete', { id: first })).rejects.toThrowError(/^VALIDATION: /)
  })

  it('stores targets, sets and clears a node target, and refuses one outside the manuscript', async () => {
    await invoke('project:create', { name: 'Goals', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const chapter = rows.find((r) => r.hierarchyLevel === 'chapter')?.id ?? ''
    const front = rows.find((r) => r.sectionType === 'front')?.id ?? ''
    const set = await invoke('goals:set', {
      projectTarget: 80000,
      deadline: '2099-12-31',
      dailyTarget: 500,
      nodeTargets: [{ nodeId: chapter, target: 4000 }]
    })
    expect(set.goals).toEqual({
      projectTarget: 80000,
      deadline: '2099-12-31',
      dailyTarget: 500,
      nodeTargets: { [chapter]: 4000 }
    })
    expect(set.perDayNeeded).toBeGreaterThan(0)
    expect((await invoke('goals:get', undefined)).goals).toEqual(set.goals)
    const cleared = await invoke('goals:set', {
      deadline: null,
      nodeTargets: [{ nodeId: chapter, target: null }]
    })
    expect(cleared.goals).toMatchObject({ deadline: null, nodeTargets: {}, dailyTarget: 500 })
    expect(cleared.perDayNeeded).toBeNull()
    await expect(
      invoke('goals:set', { nodeTargets: [{ nodeId: front, target: 10 }] })
    ).rejects.toThrowError(/^VALIDATION: /)
    await expect(invoke('goals:set', { dailyTarget: 0 })).rejects.toThrowError(/^VALIDATION: /)
  })
})

describe('notes:get / notes:save', () => {
  const para = (text: string): Input<'notes:save'>['notes'] => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('notes:get', { id: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('notes:save', { id: 'x', notes: para('x') })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('round-trips folder notes and leaves the document content alone (F-3.7)', async () => {
    await invoke('project:create', { name: 'Notes', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const chapter = rows.find((r) => r.hierarchyLevel === 'chapter')
    expect(await invoke('notes:get', { id: chapter?.id ?? '' })).toEqual({
      id: chapter?.id,
      notes: null
    })
    const saved = await invoke('notes:save', { id: chapter?.id ?? '', notes: para('Chapter goal') })
    expect(typeof saved.modified).toBe('string')
    expect(await invoke('notes:get', { id: chapter?.id ?? '' })).toEqual({
      id: chapter?.id,
      notes: para('Chapter goal')
    })
    const listed = (await invoke('tree:list', undefined)).find((r) => r.id === chapter?.id)
    expect(listed).toMatchObject({ wordCount: 0, modified: saved.modified })
    await expect(invoke('document:get', { id: chapter?.id ?? '' })).rejects.toThrowError(
      /^VALIDATION: /
    )
  })

  it('refuses section roots with VALIDATION and unknown ids with NOT_FOUND', async () => {
    await invoke('project:create', { name: 'Notes', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const manuscript = rows.find((r) => r.sectionType === 'manuscript')
    await expect(invoke('notes:get', { id: manuscript?.id ?? '' })).rejects.toThrowError(
      /^VALIDATION: /
    )
    await expect(
      invoke('notes:save', { id: manuscript?.id ?? '', notes: para('x') })
    ).rejects.toThrowError(/^VALIDATION: /)
    await expect(invoke('notes:get', { id: 'missing' })).rejects.toThrowError(/^NOT_FOUND: /)
  })
})

describe('sceneMeta:get / sceneMeta:set (F-4.5)', () => {
  const filled = {
    location: 'dark-forest',
    pov: 'mara',
    timeline: 'Day 3, after the storm',
    brief: { ...EMPTY_SCENE_BRIEF, goal: 'Cross the river tonight.' },
    synopsis: 'Mara bargains for a crossing.',
    status: 'idea' as const,
    beats: { threeAct: 'inciting-incident' }
  }

  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('sceneMeta:get', { id: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('sceneMeta:set', { id: 'x', meta: filled })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('round-trips scene and chapter metadata and stamps modified', async () => {
    await invoke('project:create', { name: 'Meta', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.hierarchyLevel === 'scene')
    const chapter = rows.find((r) => r.hierarchyLevel === 'chapter')
    expect(await invoke('sceneMeta:get', { id: scene?.id ?? '' })).toEqual({
      id: scene?.id,
      meta: EMPTY_SCENE_META
    })
    const saved = await invoke('sceneMeta:set', { id: scene?.id ?? '', meta: filled })
    expect(typeof saved.modified).toBe('string')
    expect(await invoke('sceneMeta:get', { id: scene?.id ?? '' })).toEqual({
      id: scene?.id,
      meta: filled
    })
    await invoke('sceneMeta:set', {
      id: chapter?.id ?? '',
      meta: { ...EMPTY_SCENE_META, location: 'the coast' }
    })
    expect((await invoke('sceneMeta:get', { id: chapter?.id ?? '' })).meta).toEqual({
      ...EMPTY_SCENE_META,
      location: 'the coast'
    })
    const listed = (await invoke('tree:list', undefined)).find((r) => r.id === scene?.id)
    expect(listed).toMatchObject({ modified: saved.modified })
  })

  it('surfaces VALIDATION for section roots and over-length fields, NOT_FOUND for unknown ids', async () => {
    await invoke('project:create', { name: 'Meta', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const manuscript = rows.find((r) => r.sectionType === 'manuscript')
    const scene = rows.find((r) => r.hierarchyLevel === 'scene')
    await expect(invoke('sceneMeta:get', { id: manuscript?.id ?? '' })).rejects.toThrowError(
      /^VALIDATION: /
    )
    await expect(
      invoke('sceneMeta:set', { id: manuscript?.id ?? '', meta: filled })
    ).rejects.toThrowError(/^VALIDATION: /)
    await expect(invoke('sceneMeta:get', { id: 'missing' })).rejects.toThrowError(/^NOT_FOUND: /)
    const raw = handlerFor('sceneMeta:set')
    const result = await raw(undefined, {
      id: scene?.id,
      meta: { ...filled, location: 'x'.repeat(201) }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect((await invoke('sceneMeta:get', { id: scene?.id ?? '' })).meta).toEqual(EMPTY_SCENE_META)
  })
})

describe('editorSettings:get / editorSettings:set', () => {
  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('editorSettings:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('editorSettings:set', defaultEditorSettings('novel'))).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it("returns the seeded defaults for the project's format (F-3.6)", async () => {
    await invoke('project:create', { name: 'Serial', format: 'webnovel', directory: tmp })
    expect(await invoke('editorSettings:get', undefined)).toEqual(defaultEditorSettings('webnovel'))
  })

  it('persists a change so get returns it, also after a reopen', async () => {
    const created = await invoke('project:create', { name: 'Fmt', format: 'novel', directory: tmp })
    const next = {
      ...defaultEditorSettings('novel'),
      fontSize: 20,
      maxWidth: 900,
      sceneBreak: '###',
      typewriter: false
    }
    expect(await invoke('editorSettings:set', next)).toEqual(next)
    expect(await invoke('editorSettings:get', undefined)).toEqual(next)
    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    expect(await invoke('editorSettings:get', undefined)).toEqual(next)
  })

  it('refuses out-of-range values with VALIDATION and keeps the stored value', async () => {
    await invoke('project:create', { name: 'Fmt', format: 'novel', directory: tmp })
    const raw = handlerFor('editorSettings:set')
    const result = await raw(undefined, { ...defaultEditorSettings('novel'), fontSize: 40 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(await invoke('editorSettings:get', undefined)).toEqual(defaultEditorSettings('novel'))
  })
})

describe('aiSettings:get / aiSettings:set (F-14.4)', () => {
  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('aiSettings:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('aiSettings:set', defaultAiSettings())).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it("stores the wizard's AI source with the new project and changes nothing else (F-15.11)", async () => {
    await invoke('project:create', {
      name: 'Cloudy',
      format: 'novel',
      directory: tmp,
      aiSource: 'cloud'
    })
    expect(await invoke('aiSettings:get', undefined)).toEqual({
      ...defaultAiSettings(),
      source: 'cloud'
    })
    await invoke('project:create', {
      name: 'Keyed',
      format: 'novel',
      directory: tmp,
      aiSource: 'ownKey'
    })
    expect(await invoke('aiSettings:get', undefined)).toEqual(defaultAiSettings())
  })

  it("stores the wizard's AI switch with the new project; omitted keeps Off (F-5.18, F-5.21)", async () => {
    await invoke('project:create', {
      name: 'Assisted',
      format: 'novel',
      directory: tmp,
      aiSource: 'cloud',
      aiSwitch: 'ask'
    })
    expect(await invoke('aiSettings:get', undefined)).toEqual({
      ...defaultAiSettings(),
      source: 'cloud',
      dial: 1
    })
    await invoke('project:create', {
      name: 'Hands off',
      format: 'novel',
      directory: tmp,
      aiSwitch: 'auto'
    })
    expect(await invoke('aiSettings:get', undefined)).toMatchObject({ dial: 1, auto: true })
    await invoke('project:create', { name: 'Plain', format: 'novel', directory: tmp })
    expect(await invoke('aiSettings:get', undefined)).toEqual(defaultAiSettings())
  })

  it('answers the defaults (dial Off) for a new project, then what set wrote, also after a reopen', async () => {
    const created = await invoke('project:create', {
      name: 'Dial',
      format: 'novel',
      directory: tmp
    })
    expect(await invoke('aiSettings:get', undefined)).toEqual(defaultAiSettings())
    const next = {
      ...defaultAiSettings(),
      dial: 1 as const,
      features: { ...defaultAiSettings().features, ghostText: false }
    }
    expect(await invoke('aiSettings:set', next)).toEqual(next)
    expect(await invoke('aiSettings:get', undefined)).toEqual(next)
    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    expect(await invoke('aiSettings:get', undefined)).toEqual(next)
  })

  it('refuses a dial outside 0–3 with VALIDATION and keeps the stored value', async () => {
    await invoke('project:create', { name: 'Dial', format: 'novel', directory: tmp })
    const raw = handlerFor('aiSettings:set')
    const result = await raw(undefined, { ...defaultAiSettings(), dial: 4 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(await invoke('aiSettings:get', undefined)).toEqual(defaultAiSettings())
  })
})

describe('structure:get / structure:set (F-11.1b)', () => {
  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('structure:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('structure:set', { template: null })).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers no template for a new project, then what set wrote, also after a reopen', async () => {
    const created = await invoke('project:create', {
      name: 'Structure',
      format: 'novel',
      directory: tmp
    })
    expect(await invoke('structure:get', undefined)).toEqual({ template: null })
    expect(await invoke('structure:set', { template: 'herosJourney' })).toEqual({
      template: 'herosJourney'
    })
    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    expect(await invoke('structure:get', undefined)).toEqual({ template: 'herosJourney' })
  })

  it('refuses an unknown template with VALIDATION and keeps the stored value', async () => {
    await invoke('project:create', { name: 'Structure', format: 'novel', directory: tmp })
    const result = await handlerFor('structure:set')(undefined, { template: 'fiveAct' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(await invoke('structure:get', undefined)).toEqual({ template: null })
  })
})

describe('timeline:get / timeline:set (F-11.2)', () => {
  const siege = { id: 'a', label: 'The siege begins', when: 'Spring', year: 1201, note: '' }

  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('timeline:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('timeline:set', { events: [] })).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('round-trips the events, syncs a linked scene, and keeps them after a reopen', async () => {
    const created = await invoke('project:create', {
      name: 'Timeline',
      format: 'novel',
      directory: tmp
    })
    expect(await invoke('timeline:get', undefined)).toEqual({ events: [] })
    expect(await invoke('timeline:set', { events: [siege] })).toEqual({
      timeline: { events: [siege] },
      changedNodeIds: []
    })
    const tree = await invoke('tree:list', undefined)
    const scene = tree.find((row) => row.kind === 'document' && row.sectionType === null)
    if (!scene) throw new Error('no scene')
    const { meta } = await invoke('sceneMeta:get', { id: scene.id })
    await invoke('sceneMeta:set', {
      id: scene.id,
      meta: { ...meta, timeline: 'Spring: The siege begins', eventId: 'a' }
    })
    const renamed = { ...siege, label: 'The siege' }
    expect((await invoke('timeline:set', { events: [renamed] })).changedNodeIds).toEqual([scene.id])
    expect((await invoke('sceneMeta:get', { id: scene.id })).meta.timeline).toBe(
      'Spring: The siege'
    )
    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    expect(await invoke('timeline:get', undefined)).toEqual({ events: [renamed] })
  })

  it('refuses a duplicate label with VALIDATION and keeps the stored value', async () => {
    await invoke('project:create', { name: 'Timeline', format: 'novel', directory: tmp })
    const result = await handlerFor('timeline:set')(undefined, {
      events: [siege, { ...siege, id: 'b', label: 'the siege BEGINS' }]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(await invoke('timeline:get', undefined)).toEqual({ events: [] })
  })
})

describe('presets:get / presets:set (F-5.2)', () => {
  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('presets:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('presets:set', defaultWritingPresets())).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('answers the defaults (General) for a new project, then what set wrote, also after a reopen', async () => {
    const created = await invoke('project:create', {
      name: 'Presets',
      format: 'novel',
      directory: tmp
    })
    expect(await invoke('presets:get', undefined)).toEqual(defaultWritingPresets())
    const next = {
      active: 'custom' as const,
      custom: { ...builtinParams('dialogue'), styleInstruction: 'Keep it clipped.' }
    }
    expect(await invoke('presets:set', next)).toEqual(next)
    expect(await invoke('presets:get', undefined)).toEqual(next)
    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    expect(await invoke('presets:get', undefined)).toEqual(next)
  })

  it('refuses a temperature outside 0–1.5 with VALIDATION and keeps the stored value', async () => {
    await invoke('project:create', { name: 'Presets', format: 'novel', directory: tmp })
    const raw = handlerFor('presets:set')
    const defaults = defaultWritingPresets()
    const result = await raw(undefined, {
      ...defaults,
      custom: { ...defaults.custom, temperature: 4 }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(await invoke('presets:get', undefined)).toEqual(defaults)
  })
})

describe('session (F-1.7)', () => {
  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('session:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('session:set', defaultProjectSession())).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('answers the defaults for a new project, then what was set, also after a reopen', async () => {
    const created = await invoke('project:create', {
      name: 'Resume',
      format: 'novel',
      directory: tmp
    })
    expect(await invoke('session:get', undefined)).toEqual(defaultProjectSession())
    const value = { ...defaultProjectSession(), selectedNodeId: 'n1', focus: true }
    expect(await invoke('session:set', value)).toEqual(value)
    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    expect(await invoke('session:get', undefined)).toEqual(value)
  })

  it('refuses a value outside the schema with VALIDATION', async () => {
    await invoke('project:create', { name: 'Resume', format: 'novel', directory: tmp })
    const result = await handlerFor('session:set')(undefined, { sidebarTab: 'nowhere' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(await invoke('session:get', undefined)).toEqual(defaultProjectSession())
  })
})

describe('focusSettings and backgrounds (F-6.2)', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwTpsJAAICATNWh+JUAAAAAElFTkSuQmCC',
    'base64'
  )
  const image = (name: string, bytes: Buffer = PNG): string => {
    const file = path.join(tmp, name)
    fs.writeFileSync(file, bytes)
    return file
  }
  const backgroundsDir = (projectPath: string): string =>
    path.join(projectPath, 'assets', 'backgrounds')

  it('reports NO_PROJECT for every channel when nothing is open', async () => {
    await expect(invoke('focusSettings:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(
      invoke('focusSettings:set', { ...defaultFocusSettings(), backgroundId: null })
    ).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('background:list', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('background:add', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('background:remove', { id: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers no background and no files for a new project, then what was set, also after a reopen', async () => {
    const created = await invoke('project:create', {
      name: 'Focus',
      format: 'novel',
      directory: tmp
    })
    expect(await invoke('focusSettings:get', undefined)).toEqual({
      ...defaultFocusSettings(),
      backgroundId: null
    })
    expect(await invoke('background:list', undefined)).toEqual([])
    expect(
      await invoke('focusSettings:set', { ...defaultFocusSettings(), backgroundId: 'bg' })
    ).toEqual({ ...defaultFocusSettings(), backgroundId: 'bg' })
    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    expect(await invoke('focusSettings:get', undefined)).toEqual({
      ...defaultFocusSettings(),
      backgroundId: 'bg'
    })
  })

  it('refuses a non-string id with VALIDATION and keeps the stored value', async () => {
    await invoke('project:create', { name: 'Focus', format: 'novel', directory: tmp })
    const result = await handlerFor('focusSettings:set')(undefined, { backgroundId: 3 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(await invoke('focusSettings:get', undefined)).toEqual({
      ...defaultFocusSettings(),
      backgroundId: null
    })
  })

  it('copies the chosen images into the project folder, skipping refused ones by name', async () => {
    const created = await invoke('project:create', {
      name: 'Focus',
      format: 'novel',
      directory: tmp
    })
    chosenImages = [image('Sunset.PNG'), image('notes.txt'), image('b.jpg')]
    const result = await invoke('background:add', undefined)
    expect(result?.skipped).toEqual(['notes.txt'])
    expect(result?.added).toHaveLength(2)
    const [a, b] = result?.added ?? []
    expect(a?.name).toBe('Sunset.png')
    expect(a?.url).toBe(`mythscribe-asset://backgrounds/${a?.id}.png`)
    expect(b?.name).toBe('b.jpg')
    const dir = backgroundsDir(created?.path ?? '')
    // Stored as `<id>.<ext>`; `name` is the display name without the short id.
    expect(fs.readdirSync(dir).sort()).toEqual([`${a?.id}.png`, `${b?.id}.jpg`].sort())
    expect(fs.readFileSync(path.join(dir, `${a?.id}.png`))).toEqual(PNG)
    const listed = await invoke('background:list', undefined)
    expect(listed).toEqual([a, b].sort((x, y) => (x?.name ?? '').localeCompare(y?.name ?? '')))
  })

  it('answers null when the image dialog is cancelled', async () => {
    const created = await invoke('project:create', {
      name: 'Focus',
      format: 'novel',
      directory: tmp
    })
    expect(await invoke('background:add', undefined)).toBeNull()
    expect(fs.existsSync(backgroundsDir(created?.path ?? ''))).toBe(false)
  })

  it('removes a background, clearing the current selection when it was that one', async () => {
    const created = await invoke('project:create', {
      name: 'Focus',
      format: 'novel',
      directory: tmp
    })
    chosenImages = [image('a.png'), image('b.png')]
    const added = (await invoke('background:add', undefined))?.added ?? []
    const [a, b] = added
    if (!a || !b) throw new Error('two backgrounds expected')
    await invoke('focusSettings:set', { ...defaultFocusSettings(), backgroundId: a.id })
    expect(await invoke('background:remove', { id: b.id })).toBeNull()
    expect(await invoke('focusSettings:get', undefined)).toEqual({
      ...defaultFocusSettings(),
      backgroundId: a.id
    })
    expect(await invoke('background:remove', { id: a.id })).toBeNull()
    expect(await invoke('focusSettings:get', undefined)).toEqual({
      ...defaultFocusSettings(),
      backgroundId: null
    })
    expect(await invoke('background:list', undefined)).toEqual([])
    expect(fs.readdirSync(backgroundsDir(created?.path ?? ''))).toEqual([])
    await expect(invoke('background:remove', { id: a.id })).rejects.toThrowError(/^NOT_FOUND: /)
  })
})

describe('conversations:get / conversations:set (F-5.4)', () => {
  const stored: Conversations = {
    active: 'c1',
    items: [
      {
        id: 'c1',
        title: 'Why is Mara on the ridge?',
        mode: 'plan',
        paragraphs: 1,
        messages: [],
        created: '2026-09-15T10:00:00.000Z',
        modified: '2026-09-15T10:00:00.000Z'
      }
    ]
  }

  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('conversations:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('conversations:set', defaultConversations())).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('answers no conversations for a new project, then what set wrote, also after a reopen', async () => {
    const created = await invoke('project:create', {
      name: 'Chats',
      format: 'novel',
      directory: tmp
    })
    expect(await invoke('conversations:get', undefined)).toEqual(defaultConversations())
    expect(await invoke('conversations:set', stored)).toEqual(stored)
    expect(await invoke('conversations:get', undefined)).toEqual(stored)
    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    expect(await invoke('conversations:get', undefined)).toEqual(stored)
  })

  it('refuses a value outside the schema with VALIDATION and keeps the stored one', async () => {
    await invoke('project:create', { name: 'Chats', format: 'novel', directory: tmp })
    await invoke('conversations:set', stored)
    const result = await handlerFor('conversations:set')(undefined, {
      ...stored,
      items: [{ ...stored.items[0], paragraphs: 0 }]
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(await invoke('conversations:get', undefined)).toEqual(stored)
  })
})

describe('ai:chat (F-5.4)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const SCENE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'

  /** A project with the switch at Ask, a key, and a scene with text. */
  async function ready(dial: AiDial = 1): Promise<{ scene: string }> {
    await invoke('project:create', { name: 'Chat', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('document:save', {
      id: scene.id,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: SCENE }] }]
      }
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial })
    await invoke('ai:setKey', { key: KEY })
    streamChunks = [
      { delta: 'The storm, ' },
      { delta: 'per the opening.', usage: { inputTokens: 90, outputTokens: 8 } }
    ]
    complete.mockResolvedValue({
      text: '"Somewhere ahead the river was rising."',
      model: 'gpt-fake',
      usage: { inputTokens: 120, outputTokens: 12 }
    })
    return { scene: scene.id }
  }

  /** The `ai:chatDelta` events sent to the window (project:changed rides the same fake). */
  const deltasSent = (): unknown[][] =>
    vi.mocked(fakeWin.webContents.send).mock.calls.filter(([channel]) => channel === 'ai:chatDelta')

  const plan = (scene: string, requestId = 'req-1'): Input<'ai:chat'> => ({
    nodeId: scene,
    mode: 'plan',
    paragraphs: 1,
    message: 'What is Mara afraid of?',
    history: [],
    requestId
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('ai:chat', plan('x'))).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('Plan mode: emits one ai:chatDelta per delta with the requestId, then resolves the whole text, the cost, and a pending proposal with no fidelity flag', async () => {
    const { scene } = await ready()
    const result = await invoke('ai:chat', plan(scene, 'req-7'))
    if (!result.ok) throw new Error(result.message)
    expect(result.proposalId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result).toEqual({
      ok: true,
      text: 'The storm, per the opening.',
      usage: { inputTokens: 90, outputTokens: 8 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      flagged: false,
      violation: null,
      proposalId: result.proposalId,
      requestId: 'req-7'
    })
    expect(deltasSent()).toEqual([
      ['ai:chatDelta', { requestId: 'req-7', delta: 'The storm, ' }],
      ['ai:chatDelta', { requestId: 'req-7', delta: 'per the opening.' }]
    ])
    expect(complete).not.toHaveBeenCalled()
    expect(getProposal(manager.require().connection.orm, result.proposalId)).toMatchObject({
      feature: 'chat',
      nodeId: scene,
      promptVersion: 'chat.v5',
      model: 'gpt-fake',
      promptTokens: 90,
      completionTokens: 8,
      cached: false,
      content: 'The storm, per the opening.',
      flagged: null,
      violation: null,
      status: 'pending'
    })
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.total.requests).toBe(1)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['chat'])
    // F-5.9: the session counted the same request, and it is the newest of the ledger.
    expect(summary.session).toMatchObject({ requests: 1, tokens: 98 })
    expect(summary.recent[0]).toMatchObject({
      feature: 'chat',
      model: 'gpt-fake',
      promptTokens: 90,
      completionTokens: 8,
      cached: false
    })
  })

  it('Agent mode: no deltas, the post-processed draft, a proposal carrying the fidelity flag', async () => {
    const { scene } = await ready()
    const result = await invoke('ai:chat', {
      ...plan(scene, 'req-8'),
      mode: 'agent',
      paragraphs: 2,
      message: 'Bring Tomas onto the landing.'
    })
    if (!result.ok) throw new Error(result.message)
    expect(result).toMatchObject({
      text: 'Somewhere ahead the river was rising.',
      usage: { inputTokens: 120, outputTokens: 12 },
      flagged: false,
      violation: null,
      requestId: 'req-8'
    })
    expect(deltasSent()).toEqual([])
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0]![0]).toMatchObject({ tier: 'fast', maxTokens: 240 })
    expect(getProposal(manager.require().connection.orm, result.proposalId)).toMatchObject({
      feature: 'chat',
      content: 'Somewhere ahead the river was rising.',
      flagged: false
    })
  })

  it('answers each expected AI failure as data with its next step and the requestId', async () => {
    const { scene } = await ready(1)
    await invoke('ai:clearKey', undefined)
    expect(await invoke('ai:chat', plan(scene, 'req-9'))).toEqual({
      ok: false,
      code: 'NO_KEY',
      message: 'No API key is saved.',
      nextStep: 'Add a key above and save it.',
      requestId: 'req-9'
    })
    await invoke('ai:setKey', { key: KEY })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 0 })
    expect(await invoke('ai:chat', plan(scene, 'req-9'))).toEqual({
      ok: false,
      code: 'DISABLED',
      message: 'Assistant chat needs the AI switch at Ask or Auto (it is at Off).',
      nextStep:
        'Set the AI switch to Ask or Auto in the assistant panel or Settings, or enable the feature there.',
      requestId: 'req-9'
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    expect(deltasSent()).toEqual([])
    // A provider error mid-stream: the deltas already sent stay sent, the failure is data, no proposal.
    streamChunks = [{ delta: 'Half' }, new InvalidKeyError('OpenAI rejected the API key.')]
    expect(await invoke('ai:chat', plan(scene, 'req-9'))).toEqual({
      ok: false,
      code: 'INVALID_KEY',
      message: 'OpenAI rejected the API key.',
      nextStep: 'Check the key and try again.',
      requestId: 'req-9'
    })
    expect(deltasSent()).toEqual([['ai:chatDelta', { requestId: 'req-9', delta: 'Half' }]])
    expect(manager.require().connection.orm.select().from(aiProposal).all()).toHaveLength(0)
  })

  it('ai:cancel stops a streaming turn by its requestId: the deltas already sent stay sent, the reply is CANCELLED with the id, no proposal, no ledger row (F-5.10)', async () => {
    const { scene } = await ready()
    streamChunks = [{ delta: 'Half' }, untilCancelled]
    const pending = invoke('ai:chat', plan(scene, 'req-5'))
    await vi.waitFor(() => expect(deltasSent()).toHaveLength(1))
    expect(await invoke('ai:cancel', { requestId: 'req-5' })).toEqual({ cancelled: true })
    expect(await pending).toEqual({
      ok: false,
      code: 'CANCELLED',
      message: 'The request was stopped.',
      nextStep: 'Send it again whenever you like.',
      requestId: 'req-5'
    })
    expect(deltasSent()).toEqual([['ai:chatDelta', { requestId: 'req-5', delta: 'Half' }]])
    expect(manager.require().connection.orm.select().from(aiProposal).all()).toHaveLength(0)
    expect((await invoke('ai:usageSummary', undefined)).total.requests).toBe(0)
    // Settled: the id is gone, and a fresh turn under a new id still streams.
    expect(await invoke('ai:cancel', { requestId: 'req-5' })).toEqual({ cancelled: false })
    streamChunks = [{ delta: 'Whole.' }]
    const again = await invoke('ai:chat', plan(scene, 'req-6'))
    expect(again).toMatchObject({ ok: true, text: 'Whole.', requestId: 'req-6' })
  })

  it('lets an unknown node and an invalid input reach the error envelope as NOT_FOUND and VALIDATION', async () => {
    await ready()
    const unknown = await handlerFor('ai:chat')(undefined, plan('nope'))
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    const blank = await handlerFor('ai:chat')(undefined, { ...plan('nope'), message: '   ' })
    expect(blank.ok).toBe(false)
    if (!blank.ok) expect(blank.error.code).toBe('VALIDATION')
    const many = await handlerFor('ai:chat')(undefined, { ...plan('nope'), paragraphs: 11 })
    expect(many.ok).toBe(false)
    if (!many.ok) expect(many.error.code).toBe('VALIDATION')
  })
})

describe('ai:rewrite (F-14.10)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const PASSAGE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'

  /** A project with the switch at Ask, a key, and a scene holding the passage. */
  async function ready(dial: AiDial = 1): Promise<{ scene: string }> {
    await invoke('project:create', { name: 'Rewrite', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('document:save', {
      id: scene.id,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: PASSAGE }] }]
      }
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial })
    await invoke('ai:setKey', { key: KEY })
    streamChunks = [
      { delta: '"The storm broke at dusk. ' },
      { delta: 'Mara counted the gaps."', usage: { inputTokens: 90, outputTokens: 8 } }
    ]
    return { scene: scene.id }
  }

  /** The `ai:rewriteDelta` events sent to the window (project:changed rides the same fake). */
  const deltasSent = (): unknown[][] =>
    vi
      .mocked(fakeWin.webContents.send)
      .mock.calls.filter(([channel]) => channel === 'ai:rewriteDelta')

  const ask = (scene: string, requestId = 'rw-1'): Input<'ai:rewrite'> => ({
    nodeId: scene,
    from: 5,
    to: 5 + PASSAGE.length,
    text: PASSAGE,
    before: '',
    after: '',
    requestId
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('ai:rewrite', ask('x'))).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('emits one ai:rewriteDelta per delta, then resolves the post-processed rewrite and a pending proposal carrying the target range', async () => {
    const { scene } = await ready()
    const result = await invoke('ai:rewrite', ask(scene, 'rw-7'))
    if (!result.ok) throw new Error(result.message)
    expect(result).toEqual({
      ok: true,
      text: 'The storm broke at dusk. Mara counted the gaps.',
      usage: { inputTokens: 90, outputTokens: 8 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      flagged: false,
      violation: null,
      proposalId: result.proposalId,
      requestId: 'rw-7'
    })
    expect(deltasSent()).toEqual([
      ['ai:rewriteDelta', { requestId: 'rw-7', delta: '"The storm broke at dusk. ' }],
      ['ai:rewriteDelta', { requestId: 'rw-7', delta: 'Mara counted the gaps."' }]
    ])
    expect(getProposal(manager.require().connection.orm, result.proposalId)).toMatchObject({
      feature: 'rewrite',
      nodeId: scene,
      promptVersion: 'rewrite.v3',
      content: 'The storm broke at dusk. Mara counted the gaps.',
      flagged: false,
      violation: null,
      targetFrom: 5,
      targetTo: 5 + PASSAGE.length,
      regeneratedFrom: null,
      status: 'pending'
    })
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['rewrite'])
  })

  it('a regenerate goes through rewriteRegen.v1 and its proposal names the one it replaces', async () => {
    const { scene } = await ready()
    const first = await invoke('ai:rewrite', ask(scene, 'rw-8'))
    if (!first.ok) throw new Error(first.message)
    streamChunks = [{ delta: 'Dusk, and the storm over the forest.' }]
    const again = await invoke('ai:rewrite', {
      ...ask(scene, 'rw-9'),
      note: 'Colder, and keep the bell.',
      regeneratedFrom: first.proposalId
    })
    if (!again.ok) throw new Error(again.message)
    expect(again.text).toBe('Dusk, and the storm over the forest.')
    expect(getProposal(manager.require().connection.orm, again.proposalId)).toMatchObject({
      feature: 'rewrite',
      promptVersion: 'rewriteRegen.v3',
      regeneratedFrom: first.proposalId
    })
  })

  it('answers an expected AI failure as data with the requestId, and an unknown node or a passage outside the limits through the error envelope', async () => {
    const { scene } = await ready(0)
    expect(await invoke('ai:rewrite', ask(scene, 'rw-3'))).toEqual({
      ok: false,
      code: 'DISABLED',
      message: 'Rewrite in my voice needs the AI switch at Ask or Auto (it is at Off).',
      nextStep:
        'Set the AI switch to Ask or Auto in the assistant panel or Settings, or enable the feature there.',
      requestId: 'rw-3'
    })
    expect(deltasSent()).toEqual([])
    expect(manager.require().connection.orm.select().from(aiProposal).all()).toHaveLength(0)
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    const unknown = await handlerFor('ai:rewrite')(undefined, ask('nope'))
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    const short = await handlerFor('ai:rewrite')(undefined, { ...ask(scene), text: 'Too short.' })
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.error.code).toBe('VALIDATION')
  })
})

describe('ai:critique (F-14.8)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const SCENE =
    'The ferry landing was empty when Mara reached it. The rope hung slack in the water and ' +
    'the bell had lost its clapper years ago. She set the lantern down on the post and waited. ' +
    '"You came alone," a voice said behind her.'
  const QUOTE = 'The rope hung slack in the water'
  const NOTE = {
    kind: 'issue',
    category: 'pacing',
    quote: QUOTE,
    why: 'The image lands, but the sentence runs on past its beat.',
    fix: 'The rope hung slack in the water.'
  }

  /** A project with the dial at Ask, a key, a scene long enough to critique, and one note waiting. */
  async function ready(dial: AiDial = 1): Promise<{ scene: string }> {
    await invoke('project:create', { name: 'Critique', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('document:save', {
      id: scene.id,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: SCENE }] }]
      }
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial })
    await invoke('ai:setKey', { key: KEY })
    answersWith({ notes: [NOTE] })
    return { scene: scene.id }
  }

  /** The next provider answer, as the JSON the critique prompt asks for. */
  function answersWith(answer: unknown): void {
    complete.mockResolvedValue({
      text: JSON.stringify(answer),
      model: 'gpt-fake',
      usage: { inputTokens: 900, outputTokens: 120 }
    })
  }

  const ask = (scene: string, requestId = 'cq-1'): Input<'ai:critique'> => ({
    nodeId: scene,
    requestId
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('ai:critique', ask('x'))).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers the cited notes, drops an uncited one, and records them as one pending proposal', async () => {
    const { scene } = await ready()
    answersWith({
      notes: [NOTE, { ...NOTE, kind: 'praise', quote: 'The dragon circled the keep.', fix: null }]
    })
    const result = await invoke('ai:critique', ask(scene, 'cq-7'))
    if (!result.ok) throw new Error(result.message)
    expect(result).toEqual({
      ok: true,
      notes: [{ ...NOTE, flagged: false, violation: null }],
      truncated: false,
      dropped: 1,
      usage: { inputTokens: 900, outputTokens: 120 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      proposalId: result.proposalId,
      requestId: 'cq-7'
    })
    expect(getProposal(manager.require().connection.orm, result.proposalId)).toMatchObject({
      feature: 'critique',
      nodeId: scene,
      promptVersion: 'critique.v3',
      content: JSON.stringify(result.notes),
      flagged: false,
      violation: null,
      regeneratedFrom: null,
      status: 'pending'
    })
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['critique'])
  })

  it('a regenerate goes through critiqueRegen.v3 and its proposal names the one it replaces', async () => {
    const { scene } = await ready()
    const first = await invoke('ai:critique', ask(scene, 'cq-8'))
    if (!first.ok) throw new Error(first.message)
    answersWith({ notes: [{ ...NOTE, why: 'Still slack, and now twice.' }] })
    const again = await invoke('ai:critique', {
      ...ask(scene, 'cq-9'),
      note: 'Less about pacing, more about the dialogue.',
      regeneratedFrom: first.proposalId
    })
    if (!again.ok) throw new Error(again.message)
    expect(again.notes[0]?.why).toBe('Still slack, and now twice.')
    expect(getProposal(manager.require().connection.orm, again.proposalId)).toMatchObject({
      feature: 'critique',
      promptVersion: 'critiqueRegen.v3',
      regeneratedFrom: first.proposalId
    })
  })

  it('answers an expected AI failure as data with the requestId, and an unknown or too-short node through the error envelope', async () => {
    const { scene } = await ready(0)
    expect(await invoke('ai:critique', ask(scene, 'cq-3'))).toEqual({
      ok: false,
      code: 'DISABLED',
      message: "Editor's notes needs the AI switch at Ask or Auto (it is at Off).",
      nextStep:
        'Set the AI switch to Ask or Auto in the assistant panel or Settings, or enable the feature there.',
      requestId: 'cq-3'
    })
    expect(manager.require().connection.orm.select().from(aiProposal).all()).toHaveLength(0)
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    const unknown = await handlerFor('ai:critique')(undefined, ask('nope'))
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    await invoke('document:save', {
      id: scene,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Too short.' }] }]
      }
    })
    const short = await handlerFor('ai:critique')(undefined, ask(scene))
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.error.code).toBe('VALIDATION')
  })
})

describe('ai:proofread (F-14.12)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const SCENE =
    'The ferry landing was empty when Mara reached it. The the rope hung slack in the water ' +
    'and teh bell had lost its clapper years ago.'
  const TYPO = { kind: 'typo', quote: 'and teh bell', fix: 'and the bell' }

  /** A project with the dial at Ask, a key, a scene with two errors, and one fix waiting. */
  async function ready(dial: AiDial = 1): Promise<{ scene: string }> {
    await invoke('project:create', { name: 'Proofread', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('document:save', {
      id: scene.id,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: SCENE }] }]
      }
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial })
    await invoke('ai:setKey', { key: KEY })
    answersWith({ fixes: [TYPO] })
    return { scene: scene.id }
  }

  function answersWith(answer: unknown): void {
    complete.mockResolvedValue({
      text: JSON.stringify(answer),
      model: 'gpt-fake',
      usage: { inputTokens: 700, outputTokens: 90 }
    })
  }

  const ask = (scene: string, requestId = 'pr-1'): Input<'ai:proofread'> => ({
    nodeId: scene,
    requestId
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('ai:proofread', ask('x'))).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers the kept fixes, drops a fabricated one, and records them as one pending proposal', async () => {
    const { scene } = await ready()
    answersWith({
      fixes: [TYPO, { kind: 'spelling', quote: 'The dragon circled', fix: 'The dragon circles' }]
    })
    const result = await invoke('ai:proofread', ask(scene, 'pr-7'))
    if (!result.ok) throw new Error(result.message)
    expect(result).toEqual({
      ok: true,
      fixes: [{ ...TYPO, flagged: false, violation: null }],
      scope: 'scene',
      truncated: false,
      dropped: 1,
      usage: { inputTokens: 700, outputTokens: 90 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      proposalId: result.proposalId,
      requestId: 'pr-7'
    })
    expect(getProposal(manager.require().connection.orm, result.proposalId)).toMatchObject({
      feature: 'proofread',
      nodeId: scene,
      promptVersion: 'proofread.v1',
      content: JSON.stringify(result.fixes),
      flagged: false,
      violation: null,
      regeneratedFrom: null,
      status: 'pending'
    })
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['proofread'])
  })

  it('records a proposal for a clean result too, and proofreads only the selection when one is sent', async () => {
    const { scene } = await ready()
    answersWith({ fixes: [] })
    const clean = await invoke('ai:proofread', {
      ...ask(scene, 'pr-8'),
      selection: 'The ferry landing was empty when Mara reached it.'
    })
    if (!clean.ok) throw new Error(clean.message)
    expect(clean.fixes).toEqual([])
    expect(clean.scope).toBe('selection')
    expect(getProposal(manager.require().connection.orm, clean.proposalId)).toMatchObject({
      feature: 'proofread',
      content: '[]'
    })
  })

  it('answers an expected AI failure as data with the requestId, and an unknown or too-short node through the error envelope', async () => {
    const { scene } = await ready(0)
    expect(await invoke('ai:proofread', ask(scene, 'pr-3'))).toEqual({
      ok: false,
      code: 'DISABLED',
      message: 'Proofread needs the AI switch at Ask or Auto (it is at Off).',
      nextStep:
        'Set the AI switch to Ask or Auto in the assistant panel or Settings, or enable the feature there.',
      requestId: 'pr-3'
    })
    expect(manager.require().connection.orm.select().from(aiProposal).all()).toHaveLength(0)
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    const unknown = await handlerFor('ai:proofread')(undefined, ask('nope'))
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    const short = await handlerFor('ai:proofread')(undefined, {
      ...ask(scene),
      selection: 'Too short.'
    })
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.error.code).toBe('VALIDATION')
  })
})

describe('ai:whatNext (F-5.17)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const SCENE =
    'The ferry landing was empty when Mara reached it. The rope hung slack in the water and ' +
    'the bell had lost its clapper years ago.'
  const DIRECTIONS = [
    { title: 'Tomas arrives late', text: 'He comes without the ledger and lies about why.' },
    { title: 'The bell rings', text: 'Someone upriver rings a bell that has no clapper.' },
    { title: 'Mara leaves', text: 'She gives up waiting and takes the ferry alone.' }
  ]

  /** A project with the dial at Ask, a key, a written scene, and three directions waiting. */
  async function ready(dial: AiDial = 1): Promise<{ scene: string }> {
    await invoke('project:create', { name: 'What next', format: 'novel', directory: tmp })
    const scene = manuscriptDocuments(manager.require().connection.orm)[0]
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('document:save', {
      id: scene.id,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: SCENE }] }]
      }
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial })
    await invoke('ai:setKey', { key: KEY })
    answersWith({ directions: DIRECTIONS })
    return { scene: scene.id }
  }

  function answersWith(answer: unknown): void {
    complete.mockResolvedValue({
      text: JSON.stringify(answer),
      model: 'gpt-fake',
      usage: { inputTokens: 600, outputTokens: 80 }
    })
  }

  const ask = (scene: string, requestId = 'wn-1'): Input<'ai:whatNext'> => ({
    nodeId: scene,
    requestId
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('ai:whatNext', ask('x'))).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers the directions, drops the blank ones, and records them as one pending proposal', async () => {
    const { scene } = await ready()
    answersWith({ directions: [{ title: ' ', text: 'Blank title.' }, ...DIRECTIONS] })
    const result = await invoke('ai:whatNext', ask(scene, 'wn-7'))
    if (!result.ok) throw new Error(result.message)
    expect(result).toEqual({
      ok: true,
      directions: DIRECTIONS,
      dropped: 1,
      usage: { inputTokens: 600, outputTokens: 80 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      proposalId: result.proposalId,
      requestId: 'wn-7'
    })
    expect(getProposal(manager.require().connection.orm, result.proposalId)).toMatchObject({
      feature: 'whatNext',
      nodeId: scene,
      promptVersion: 'whatNext.v2',
      content: JSON.stringify(DIRECTIONS),
      flagged: false,
      violation: null,
      regeneratedFrom: null,
      status: 'pending'
    })
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['whatNext'])
  })

  it('sends the text up to the selection when the renderer sent it', async () => {
    const { scene } = await ready()
    const before = 'The ferry landing was empty when Mara reached it.'
    const result = await invoke('ai:whatNext', { ...ask(scene, 'wn-8'), before })
    expect(result.ok).toBe(true)
    const user = complete.mock.calls.at(-1)?.[0].messages[1]?.content ?? ''
    expect(user).toContain(`Text so far:\n"""\n${before}\n"""`)
  })

  it('answers an expected AI failure as data with the requestId, and an unknown or too-short node through the error envelope', async () => {
    const { scene } = await ready(0)
    expect(await invoke('ai:whatNext', ask(scene, 'wn-3'))).toEqual({
      ok: false,
      code: 'DISABLED',
      message: 'What comes next needs the AI switch at Ask or Auto (it is at Off).',
      nextStep:
        'Set the AI switch to Ask or Auto in the assistant panel or Settings, or enable the feature there.',
      requestId: 'wn-3'
    })
    expect(manager.require().connection.orm.select().from(aiProposal).all()).toHaveLength(0)
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    const unknown = await handlerFor('ai:whatNext')(undefined, ask('nope'))
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    const short = await handlerFor('ai:whatNext')(undefined, {
      ...ask(scene),
      before: 'Too short.'
    })
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.error.code).toBe('VALIDATION')
  })
})

describe('ai:route (F-5.19)', () => {
  const KEY = 'sk-test-secret-1234abcd'

  async function ready(dial: AiDial = 1): Promise<{ scene: string }> {
    await invoke('project:create', { name: 'Route', format: 'novel', directory: tmp })
    const scene = manuscriptDocuments(manager.require().connection.orm)[0]
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial })
    await invoke('ai:setKey', { key: KEY })
    return { scene: scene.id }
  }

  function answersWith(answer: unknown): void {
    complete.mockResolvedValue({
      text: typeof answer === 'string' ? answer : JSON.stringify(answer),
      model: 'gpt-fake',
      usage: { inputTokens: 300, outputTokens: 12 }
    })
  }

  const ask = (over: Partial<Input<'ai:route'>> = {}): Input<'ai:route'> => ({
    nodeId: null,
    message: 'Make this colder.',
    history: [],
    selection: null,
    requestId: 'rt-1',
    ...over
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('ai:route', ask())).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('asks the fast tier for JSON with the selection opening and the open scene, and answers the action and instruction', async () => {
    const { scene } = await ready()
    answersWith({ action: 'rewrite', instruction: 'Colder, fewer adjectives.' })
    const result = await invoke(
      'ai:route',
      ask({ nodeId: scene, selection: { text: 'He looked at the lantern.' } })
    )
    expect(result).toEqual({
      ok: true,
      action: 'rewrite',
      instruction: 'Colder, fewer adjectives.',
      routedBy: 'model',
      usage: { inputTokens: 300, outputTokens: 12 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      requestId: 'rt-1'
    })
    const request = complete.mock.calls.at(-1)?.[0]
    expect(request?.tier).toBe('fast')
    expect(request?.json).toBe(true)
    const user = request?.messages[1]?.content ?? ''
    expect(user).toContain('Open document: scene "Scene 1"')
    expect(user).toContain('Selected passage (opening):\n"""\nHe looked at the lantern.\n"""')
    expect(manager.require().connection.orm.select().from(aiProposal).all()).toHaveLength(0)
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['route'])
  })

  it('falls back to chat for a rewrite with no selection and for an unreadable answer', async () => {
    const { scene } = await ready()
    answersWith({ action: 'rewrite', instruction: 'Colder.' })
    const noSelection = await invoke('ai:route', ask({ nodeId: scene, requestId: 'rt-2' }))
    expect(noSelection).toMatchObject({ ok: true, action: 'chat', instruction: null })
    answersWith('not json at all')
    const garbled = await invoke(
      'ai:route',
      ask({ nodeId: scene, message: 'Something else.', requestId: 'rt-3' })
    )
    expect(garbled).toMatchObject({ ok: true, action: 'chat', routedBy: 'model' })
  })

  it('decides an exact action id locally, without a request or a ledger row', async () => {
    const { scene } = await ready()
    const result = await invoke('ai:route', ask({ nodeId: scene, message: 'Proofread' }))
    expect(result).toEqual({
      ok: true,
      action: 'proofread',
      instruction: null,
      routedBy: 'local',
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      cached: false,
      model: null,
      requestId: 'rt-1'
    })
    expect(complete).not.toHaveBeenCalled()
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.total.requests).toBe(0)
  })

  it('answers DISABLED as data below Ask', async () => {
    await ready(0)
    expect(await invoke('ai:route', ask())).toMatchObject({
      ok: false,
      code: 'DISABLED',
      requestId: 'rt-1'
    })
    expect(complete).not.toHaveBeenCalled()
  })
})

describe('ai:suggestSynopsis and ai:suggestNotes (F-5.20)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const SCENE =
    'The ferry landing was empty when Mara reached it. The rope hung slack in the water and ' +
    'the bell had lost its clapper years ago. She set the lantern down and waited for Tomas.'

  async function ready(dial: AiDial = 1): Promise<{ scene: string }> {
    await invoke('project:create', { name: 'Suggest', format: 'novel', directory: tmp })
    const scene = manuscriptDocuments(manager.require().connection.orm)[0]
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('document:save', {
      id: scene.id,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: SCENE }] }]
      }
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial })
    await invoke('ai:setKey', { key: KEY })
    return { scene: scene.id }
  }

  function answersWith(answer: unknown): void {
    complete.mockResolvedValue({
      text: JSON.stringify(answer),
      model: 'gpt-fake',
      usage: { inputTokens: 500, outputTokens: 60 }
    })
  }

  it('suggests a synopsis as one pending proposal and writes nothing into the side panel', async () => {
    const { scene } = await ready()
    answersWith({ synopsis: ' Mara waits for Tomas at the empty landing. ' })
    const result = await invoke('ai:suggestSynopsis', { nodeId: scene, requestId: 'syn-1' })
    if (!result.ok) throw new Error(result.message)
    expect(result).toEqual({
      ok: true,
      synopsis: 'Mara waits for Tomas at the empty landing.',
      truncated: false,
      usage: { inputTokens: 500, outputTokens: 60 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      proposalId: result.proposalId,
      requestId: 'syn-1'
    })
    expect(getProposal(manager.require().connection.orm, result.proposalId)).toMatchObject({
      feature: 'synopsis',
      nodeId: scene,
      promptVersion: 'synopsis.v1',
      content: 'Mara waits for Tomas at the empty landing.',
      flagged: false,
      status: 'pending'
    })
    const request = complete.mock.calls.at(-1)?.[0]
    expect(request?.tier).toBe('fast')
    expect(request?.messages[1]?.content).toContain(SCENE)
    const { meta } = await invoke('sceneMeta:get', { id: scene })
    expect(meta.synopsis).toBe('')
  })

  it('suggests notes with the focus and the current notes, as one pending proposal holding the points', async () => {
    const { scene } = await ready()
    await invoke('notes:save', {
      id: scene,
      notes: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tomas is late.' }] }]
      }
    })
    const points = ['The bell has no clapper.', 'Tomas owes the mill.']
    answersWith({ points: [...points, ''] })
    const result = await invoke('ai:suggestNotes', {
      nodeId: scene,
      requestId: 'notes-1',
      instruction: 'the ledger'
    })
    if (!result.ok) throw new Error(result.message)
    expect(result).toMatchObject({ ok: true, points, dropped: 1, requestId: 'notes-1' })
    expect(getProposal(manager.require().connection.orm, result.proposalId)).toMatchObject({
      feature: 'notesSuggest',
      promptVersion: 'notesSuggest.v1',
      content: JSON.stringify(points),
      status: 'pending'
    })
    const user = complete.mock.calls.at(-1)?.[0].messages[1]?.content ?? ''
    expect(user).toContain('Current notes:\n"""\nTomas is late.\n"""')
    expect(user).toContain('List the key points, focusing on: the ledger')
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['notesSuggest'])
  })

  it('answers DISABLED as data, a bad answer as PROVIDER, and refuses an unknown or too-short scene', async () => {
    const { scene } = await ready(0)
    expect(await invoke('ai:suggestSynopsis', { nodeId: scene, requestId: 's-0' })).toMatchObject({
      ok: false,
      code: 'DISABLED',
      requestId: 's-0'
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    answersWith({ nothing: true })
    expect(await invoke('ai:suggestNotes', { nodeId: scene, requestId: 'n-1' })).toMatchObject({
      ok: false,
      code: 'PROVIDER',
      requestId: 'n-1'
    })
    expect(manager.require().connection.orm.select().from(aiProposal).all()).toHaveLength(0)
    const unknown = await handlerFor('ai:suggestSynopsis')(undefined, {
      nodeId: 'nope',
      requestId: 's-1'
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    await invoke('document:save', {
      id: scene,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Too short.' }] }]
      }
    })
    const short = await handlerFor('ai:suggestNotes')(undefined, {
      nodeId: scene,
      requestId: 'n-2'
    })
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.error.code).toBe('VALIDATION')
  })
})

describe('continuity (F-13.4)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const OPENING =
    'The ferry landing was empty when Mara reached it. The rope hung slack in the water and ' +
    'the bell had lost its clapper years ago.'
  const AGE_LINE = 'Mara was twenty-nine that winter, and she had stopped counting the crossings.'
  const CLOSING = 'She set the lantern down on the post and waited. She did not turn.'
  const QUOTE = 'Mara was twenty-nine that winter'
  const FINDING = {
    ref: 1,
    quote: QUOTE,
    why: 'The sheet gives her age as 34.',
    fix: 'Mara was thirty-four that winter'
  }
  /** What the summary job answers for the scene: a summary and the one fact that differs from the sheet. */
  const SUMMARY = {
    summary: 'Mara waits at the ferry landing.',
    keyPoints: [],
    characters: ['Mara'],
    facts: [
      { entity: 'Mara', kind: 'character', attribute: 'age', value: 'twenty-nine', quote: QUOTE }
    ]
  }

  /** A project at Ask with a key, a three-paragraph scene, and a sheet that says Mara is 34. */
  async function ready(): Promise<{ scene: string; mara: string }> {
    await invoke('project:create', { name: 'Continuity', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('document:save', {
      id: scene.id,
      content: {
        type: 'doc',
        content: [OPENING, AGE_LINE, CLOSING].map((text) => ({
          type: 'paragraph',
          content: [{ type: 'text', text }]
        }))
      }
    })
    const mara = await invoke('entity:create', {
      kind: 'character',
      name: 'Mara',
      fields: { age: '34' }
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    await invoke('ai:setKey', { key: KEY })
    return { scene: scene.id, mara: mara.id }
  }

  function answerOnce(answer: unknown): void {
    complete.mockResolvedValueOnce({
      text: typeof answer === 'string' ? answer : JSON.stringify(answer),
      model: 'gpt-fake',
      usage: { inputTokens: 700, outputTokens: 90 }
    })
  }

  /** The `continuity:changed` payloads sent to the window, in order. */
  const changed = (): unknown[] =>
    vi
      .mocked(fakeWin.webContents.send)
      .mock.calls.filter(([channel]) => channel === 'continuity:changed')
      .map(([, payload]) => payload)

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('ai:continuity', { nodeId: 'x', requestId: 'c-0' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
    await expect(invoke('continuity:list', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(
      invoke('continuity:settle', { id: 'x', status: 'dismissed' })
    ).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('checks a scene on the strong tier, stores the cited findings under one proposal, and tells the windows', async () => {
    const { scene, mara } = await ready()
    answerOnce({
      findings: [
        FINDING,
        { ...FINDING, quote: 'The dragon circled the keep.' },
        { ...FINDING, ref: 7 }
      ]
    })
    const result = await invoke('ai:continuity', { nodeId: scene, requestId: 'c-1' })
    if (!result.ok) throw new Error(result.message)
    expect(result).toEqual({
      ok: true,
      findings: [
        {
          id: result.findings[0]?.id,
          nodeId: scene,
          ref: {
            kind: 'sheet',
            entityId: mara,
            entityName: 'Mara',
            entityKind: 'character',
            attribute: 'age',
            label: 'Age',
            value: '34',
            nodeId: null,
            quote: null
          },
          quote: QUOTE,
          why: FINDING.why,
          fix: FINDING.fix,
          flagged: false,
          violation: null,
          status: 'open',
          origin: 'request',
          proposalId: result.proposalId,
          createdAt: result.findings[0]?.createdAt
        }
      ],
      truncated: false,
      dropped: 2,
      references: 1,
      usage: { inputTokens: 700, outputTokens: 90 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      proposalId: result.proposalId,
      requestId: 'c-1'
    })
    expect(complete.mock.calls.at(-1)?.[0]).toMatchObject({ tier: 'strong', json: true })
    expect(getProposal(manager.require().connection.orm, result.proposalId ?? '')).toMatchObject({
      feature: 'continuity',
      nodeId: scene,
      promptVersion: 'continuity.v1',
      status: 'pending'
    })
    expect(await invoke('continuity:list', undefined)).toEqual(result.findings)
    expect(changed()).toEqual([{ nodeIds: [scene] }])
    const usage = await invoke('ai:usageSummary', undefined)
    expect(usage.byFeature.map((f) => f.feature)).toEqual(['continuity'])
  })

  it('dismisses a finding as changed in the story: it leaves the list and is never raised again for that scene', async () => {
    const { scene } = await ready()
    answerOnce({ findings: [FINDING] })
    const first = await invoke('ai:continuity', { nodeId: scene, requestId: 'c-2' })
    if (!first.ok) throw new Error(first.message)
    const finding = first.findings[0]
    if (!finding) throw new Error('expected a finding')

    expect(await invoke('continuity:settle', { id: finding.id, status: 'dismissed' })).toEqual({
      ...finding,
      status: 'dismissed'
    })
    expect(await invoke('continuity:list', undefined)).toEqual([])
    expect(changed()).toEqual([{ nodeIds: [scene] }, { nodeIds: [scene] }])
    // The last open finding of the proposal settles it; nothing was applied.
    expect(getProposal(manager.require().connection.orm, first.proposalId ?? '')?.status).toBe(
      'rejected'
    )

    // The sheet's age was the only reference and it is dismissed: nothing to check against.
    const again = await invoke('ai:continuity', { nodeId: scene, requestId: 'c-3' })
    expect(again).toMatchObject({
      ok: true,
      findings: [],
      references: 0,
      costUsd: 0,
      proposalId: null
    })
    expect(complete).toHaveBeenCalledTimes(1)

    await expect(
      invoke('continuity:settle', { id: 'missing', status: 'applied' })
    ).rejects.toThrowError(/^NOT_FOUND: /)
  })

  it('records an applied fix and settles the proposal as accepted', async () => {
    const { scene } = await ready()
    answerOnce({ findings: [FINDING] })
    const result = await invoke('ai:continuity', { nodeId: scene, requestId: 'c-4' })
    if (!result.ok) throw new Error(result.message)
    const settled = await invoke('continuity:settle', {
      id: result.findings[0]?.id ?? '',
      status: 'applied'
    })
    expect(settled.status).toBe('applied')
    expect(await invoke('continuity:list', undefined)).toEqual([])
    expect(getProposal(manager.require().connection.orm, result.proposalId ?? '')?.status).toBe(
      'accepted'
    )
  })

  it('answers the dial, the toggle, and an unreadable answer as data with the echoed id, and bad nodes through the envelope', async () => {
    const { scene } = await ready()
    answerOnce('I found nothing.')
    expect(await invoke('ai:continuity', { nodeId: scene, requestId: 'c-5' })).toEqual({
      ok: false,
      code: 'PROVIDER',
      message: 'The model did not answer in the expected format.',
      nextStep: AI_NEXT_STEP.PROVIDER,
      requestId: 'c-5'
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 0 })
    expect(await invoke('ai:continuity', { nodeId: scene, requestId: 'c-6' })).toMatchObject({
      ok: false,
      code: 'DISABLED',
      requestId: 'c-6'
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    const unknown = await handlerFor('ai:continuity')(undefined, {
      nodeId: 'nope',
      requestId: 'c-7'
    })
    expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(changed()).toEqual([])
  })

  it('checks quietly after the summary job stored the scene’s facts: fast tier, the one paragraph, a background finding', async () => {
    const { scene } = await ready()
    answerOnce(SUMMARY)
    answerOnce({ findings: [FINDING] })
    const summarized = await invoke('ai:summarize', { nodeId: scene, requestId: 's-1' })
    expect(summarized.ok).toBe(true)

    expect(complete).toHaveBeenCalledTimes(2)
    const check = complete.mock.calls[1]![0]
    expect(check).toMatchObject({ tier: 'fast', json: true })
    expect(check.messages[1]?.content).toBe(
      'References:\n[1] Mara (character), sheet, Age: 34\n\n' +
        `Scene text:\n"""\n${AGE_LINE}\n"""\n\nList the contradictions.`
    )
    const findings = await invoke('continuity:list', undefined)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      nodeId: scene,
      quote: QUOTE,
      fix: FINDING.fix,
      status: 'open',
      origin: 'background'
    })
    expect(changed()).toEqual([{ nodeIds: [scene] }])
    const usage = await invoke('ai:usageSummary', undefined)
    expect(usage.byFeature.map((f) => f.feature).sort()).toEqual(['continuity', 'summary'])

    // Summarize now over the unchanged scene: the stored summary answers, and the check, whose
    // paragraph and reference have not moved, asks nothing and leaves the finding as it is.
    await invoke('ai:summarize', { nodeId: scene, requestId: 's-2' })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(await invoke('continuity:list', undefined)).toEqual(findings)
    expect(changed()).toHaveLength(1)
  })

  it('costs nothing in the background when the scene agrees with the story bible', async () => {
    const { scene } = await ready()
    answerOnce({
      ...SUMMARY,
      facts: [{ ...SUMMARY.facts[0], attribute: 'personality', value: 'Patient' }]
    })
    expect((await invoke('ai:summarize', { nodeId: scene, requestId: 's-3' })).ok).toBe(true)
    expect(complete).toHaveBeenCalledTimes(1)
    expect(await invoke('continuity:list', undefined)).toEqual([])
    expect(changed()).toEqual([])
  })

  it('stays silent in the background with the toggle off, and never fails the summary for an answer it cannot read', async () => {
    const { scene } = await ready()
    const on = defaultAiSettings()
    await invoke('aiSettings:set', {
      ...on,
      dial: 1,
      features: { ...on.features, continuity: false }
    })
    answerOnce(SUMMARY)
    expect((await invoke('ai:summarize', { nodeId: scene, requestId: 's-4' })).ok).toBe(true)
    expect(complete).toHaveBeenCalledTimes(1)

    await invoke('aiSettings:set', { ...on, dial: 1 })
    answerOnce('Sure! Here is what I found:')
    const again = await invoke('ai:summarize', { nodeId: scene, requestId: 's-5' })
    expect(again.ok).toBe(true)
    expect(complete).toHaveBeenCalledTimes(2)
    expect(await invoke('continuity:list', undefined)).toEqual([])
    expect(changed()).toEqual([])
  })

  // Verifier (F-13.4): the summary was stored and charged before the check went out, so a
  // provider failure of the check alone must not turn the author's Summarize now into a failure.
  it('never fails Summarize now for a provider failure of the background check', async () => {
    const { scene } = await ready()
    answerOnce(SUMMARY)
    complete.mockRejectedValueOnce(new AiNetworkError('The network is unreachable.'))
    const summarized = await invoke('ai:summarize', { nodeId: scene, requestId: 's-6' })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(summarized.ok).toBe(true)
  })
})

describe('ai:betaReader (F-14.11)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const SCENE =
    'The ferry landing was empty when Mara reached it. The rope hung slack in the water and ' +
    'the bell had lost its clapper years ago. She set the lantern down on the post and waited. ' +
    '"You came alone," a voice said behind her.'
  const QUOTE = 'The rope hung slack in the water'
  const SUMMARY = 'Mara finds the ledger her brother copied and hides it under the floor.'
  const ITEM = {
    category: 'knows',
    scene: 2,
    quote: QUOTE,
    note: 'I know she came to meet someone she does not trust.'
  }

  /**
   * A project with the dial at Ask, a key, the second manuscript scene written, and the first
   * one carrying a stored summary (F-5.6) so the reader has something to read before it.
   */
  async function ready(dial: AiDial = 1): Promise<{ scene: string; first: string }> {
    await invoke('project:create', { name: 'Reader', format: 'novel', directory: tmp })
    growLegacyStarter(manager.require(), 'novel')
    // Reading order, not tree:list order: the reader reads the manuscript as the tree shows it.
    const documents = manuscriptDocuments(manager.require().connection.orm)
    const first = documents[0]
    const scene = documents[1]
    if (!first || !scene) throw new Error('skeleton not seeded')
    await invoke('document:save', {
      id: scene.id,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: SCENE }] }]
      }
    })
    upsertSummary(manager.require().connection.orm, {
      nodeId: first.id,
      contentHash: 'hash-1',
      summary: SUMMARY,
      keyPoints: ['The ledger is a copy.'],
      characters: ['Mara'],
      promptVersion: 'summary.v1',
      model: 'gpt-fake',
      truncated: false,
      createdAt: new Date().toISOString()
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial })
    await invoke('ai:setKey', { key: KEY })
    answersWith({ items: [ITEM] })
    return { scene: scene.id, first: first.id }
  }

  /** The next provider answer, as the JSON the beta-reader prompt asks for. */
  function answersWith(answer: unknown): void {
    complete.mockResolvedValue({
      text: JSON.stringify(answer),
      model: 'gpt-fake',
      usage: { inputTokens: 900, outputTokens: 120 }
    })
  }

  const ask = (scene: string, requestId = 'br-1'): Input<'ai:betaReader'> => ({
    nodeId: scene,
    requestId
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('ai:betaReader', ask('x'))).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers the cited items with the scenes read, drops an uncited one, and records one pending proposal', async () => {
    const { scene, first } = await ready()
    answersWith({
      items: [ITEM, { ...ITEM, category: 'confusion', quote: 'The dragon circled the keep.' }]
    })
    const result = await invoke('ai:betaReader', ask(scene, 'br-7'))
    if (!result.ok) throw new Error(result.message)
    expect(result).toEqual({
      ok: true,
      items: [ITEM],
      scenes: [
        { nodeId: first, title: 'Chapter 1 \u203a Scene 1', current: false },
        { nodeId: scene, title: 'Chapter 2 \u203a Scene 1', current: true }
      ],
      truncated: false,
      skipped: 0,
      missing: 0,
      dropped: 1,
      usage: { inputTokens: 900, outputTokens: 120 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      proposalId: result.proposalId,
      requestId: 'br-7'
    })
    expect(getProposal(manager.require().connection.orm, result.proposalId)).toMatchObject({
      feature: 'betaReader',
      nodeId: scene,
      promptVersion: 'betaReader.v1',
      content: JSON.stringify(result.items),
      flagged: false,
      violation: null,
      regeneratedFrom: null,
      status: 'pending'
    })
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['betaReader'])
  })

  it('a regenerate goes through betaReaderRegen.v1 and its proposal names the one it replaces', async () => {
    const { scene } = await ready()
    const first = await invoke('ai:betaReader', ask(scene, 'br-8'))
    if (!first.ok) throw new Error(first.message)
    answersWith({ items: [{ ...ITEM, note: 'Now I expect her brother to show up.' }] })
    const again = await invoke('ai:betaReader', {
      ...ask(scene, 'br-9'),
      note: 'Less about what you expect, more about where you got lost.',
      regeneratedFrom: first.proposalId
    })
    if (!again.ok) throw new Error(again.message)
    expect(again.items[0]?.note).toBe('Now I expect her brother to show up.')
    expect(getProposal(manager.require().connection.orm, again.proposalId)).toMatchObject({
      feature: 'betaReader',
      promptVersion: 'betaReaderRegen.v1',
      regeneratedFrom: first.proposalId
    })
  })

  it('answers an expected AI failure as data with the requestId, and an unknown or too-short node through the error envelope', async () => {
    const { scene } = await ready(0)
    expect(await invoke('ai:betaReader', ask(scene, 'br-3'))).toEqual({
      ok: false,
      code: 'DISABLED',
      message: 'Beta reader needs the AI switch at Ask or Auto (it is at Off).',
      nextStep:
        'Set the AI switch to Ask or Auto in the assistant panel or Settings, or enable the feature there.',
      requestId: 'br-3'
    })
    expect(manager.require().connection.orm.select().from(aiProposal).all()).toHaveLength(0)
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    const unknown = await handlerFor('ai:betaReader')(undefined, ask('nope'))
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    await invoke('document:save', {
      id: scene,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Too short.' }] }]
      }
    })
    const short = await handlerFor('ai:betaReader')(undefined, ask(scene))
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.error.code).toBe('VALIDATION')
  })
})

describe('ai:query (F-5.7)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const LEDGER =
    'The ledger sat on the mill desk where Tomas had left it. Mara copied the ledger twice ' +
    'and hid the copy under the elm in the north pasture.'
  const QUIET = 'Mara stood in the yard and the lantern would not stay lit.'
  const QUOTE = 'Mara copied the ledger twice'
  const QUESTION = 'Where did Mara hide the ledger?'

  const body = (text: string): Input<'document:save'>['content'] => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

  /** A project with the dial at Ask, a key, and the first two manuscript scenes written. */
  async function ready(dial: AiDial = 1): Promise<{ first: string; second: string }> {
    await invoke('project:create', { name: 'Query', format: 'novel', directory: tmp })
    growLegacyStarter(manager.require(), 'novel')
    const documents = manuscriptDocuments(manager.require().connection.orm)
    const first = documents[0]
    const second = documents[1]
    if (!first || !second) throw new Error('skeleton not seeded')
    await invoke('document:save', { id: first.id, content: body(LEDGER) })
    await invoke('document:save', { id: second.id, content: body(QUIET) })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial })
    await invoke('ai:setKey', { key: KEY })
    answersWith({
      found: true,
      answer: 'Under the elm. [1]',
      citations: [{ scene: 1, quote: QUOTE }]
    })
    return { first: first.id, second: second.id }
  }

  /** The next provider answer, as the JSON the query prompt asks for. */
  function answersWith(answer: unknown): void {
    complete.mockResolvedValue({
      text: JSON.stringify(answer),
      model: 'gpt-fake',
      usage: { inputTokens: 900, outputTokens: 60 }
    })
  }

  const ask = (requestId = 'q-1'): Input<'ai:query'> => ({
    nodeId: null,
    message: QUESTION,
    history: [],
    requestId
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('ai:query', ask())).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers the verified citations, drops the rest with their markers, and records one pending proposal', async () => {
    const { first, second } = await ready()
    answersWith({
      found: true,
      answer: 'Under the elm [1], by the river [2], after the thaw [9].',
      citations: [
        { scene: 1, quote: QUOTE },
        { scene: 2, quote: 'The dragon circled the keep.' },
        { scene: 9, quote: QUOTE }
      ]
    })
    const result = await invoke('ai:query', ask('q-7'))
    if (!result.ok) throw new Error(result.message)
    expect(result).toEqual({
      ok: true,
      answer: 'Under the elm [1], by the river, after the thaw.',
      found: true,
      uncited: false,
      citations: [{ nodeId: first, title: 'Chapter 1 \u203a Scene 1', scene: 1, quote: QUOTE }],
      sheets: [],
      also: [{ nodeId: second, title: 'Chapter 2 \u203a Scene 1' }],
      dropped: 2,
      usage: { inputTokens: 900, outputTokens: 60 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      proposalId: result.proposalId,
      requestId: 'q-7'
    })
    expect(getProposal(manager.require().connection.orm, result.proposalId)).toMatchObject({
      feature: 'query',
      nodeId: null,
      promptVersion: 'query.v4',
      content: JSON.stringify({
        answer: result.answer,
        citations: result.citations,
        sheets: result.sheets
      }),
      flagged: false,
      violation: null,
      regeneratedFrom: null,
      status: 'pending'
    })
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['query'])
  })

  it('answers an expected AI failure as data with the requestId, and proposes nothing', async () => {
    await ready(0)
    expect(await invoke('ai:query', ask('q-3'))).toEqual({
      ok: false,
      code: 'DISABLED',
      message: 'Story Intelligence needs the AI switch at Ask or Auto (it is at Off).',
      nextStep:
        'Set the AI switch to Ask or Auto in the assistant panel or Settings, or enable the feature there.',
      requestId: 'q-3'
    })
    expect(manager.require().connection.orm.select().from(aiProposal).all()).toHaveLength(0)
  })

  it('ranks the active scene first with pinActive (F-5.17), so the best match cites as [2]', async () => {
    const { first, second } = await ready()
    answersWith({
      found: true,
      answer: 'Under the elm. [2]',
      citations: [{ scene: 2, quote: QUOTE }]
    })
    const result = await invoke('ai:query', {
      ...ask('q-9'),
      nodeId: second,
      message: 'What happens in this scene? Give a short recap, citing the passages.',
      pinActive: true
    })
    if (!result.ok) throw new Error(result.message)
    expect(result.citations).toEqual([
      { nodeId: first, title: 'Chapter 1 \u203a Scene 1', scene: 2, quote: QUOTE }
    ])
    const sent = complete.mock.calls.at(-1)?.[0].messages[0]?.content ?? ''
    expect(sent).toContain(`[1] Chapter 2 \u203a Scene 1\n"""\n${QUIET}`)
  })

  it('refuses through the error envelope when no scene has been written yet', async () => {
    await invoke('project:create', { name: 'Empty', format: 'novel', directory: tmp })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    await invoke('ai:setKey', { key: KEY })
    const empty = await handlerFor('ai:query')(undefined, ask())
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error.code).toBe('VALIDATION')
  })
})

describe('ai:agent (F-5.22)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const LEDGER =
    'The ledger sat on the mill desk where Tomas had left it. Mara copied the ledger twice ' +
    'and hid the copy under the elm in the north pasture.'

  const body = (text: string): Input<'document:save'>['content'] => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

  /** The `ai:agentStep` events sent to the window. */
  const stepsSent = (): unknown[][] =>
    vi.mocked(fakeWin.webContents.send).mock.calls.filter(([channel]) => channel === 'ai:agentStep')

  const ask = (nodeId: string, over: Partial<Input<'ai:agent'>> = {}): Input<'ai:agent'> => ({
    nodeId,
    message: 'Where did Mara hide the ledger? Tighten the line too.',
    history: [],
    access: 'write',
    focus: { beforeCaret: '', selection: '' },
    requestId: 'ag-1',
    ...over
  })

  it('announces each lookup, answers with the resolved edits unapplied, and records one pending proposal', async () => {
    await invoke('project:create', { name: 'Agent', format: 'novel', directory: tmp })
    const scene = manuscriptDocuments(manager.require().connection.orm)[0]
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('document:save', { id: scene.id, content: body(LEDGER) })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1, auto: true })
    await invoke('ai:setKey', { key: KEY })
    const said = (value: unknown): CompletionResult => ({
      text: JSON.stringify(value),
      model: 'gpt-fake',
      usage: { inputTokens: 400, outputTokens: 30 }
    })
    complete
      .mockResolvedValueOnce(said({ tool: 'outline', args: {} }))
      .mockResolvedValueOnce(
        said({
          answer: 'Under the elm.',
          found: true,
          citations: [],
          edits: [
            {
              edit: 'text',
              id: loadAgentProject(manager.require().connection.orm).refOf.get(scene.id),
              find: 'Mara copied the ledger twice',
              replace: 'Mara copied it twice'
            }
          ]
        })
      )
    const result = await invoke('ai:agent', ask(scene.id))
    if (!result.ok) throw new Error(result.message)
    expect(stepsSent()).toEqual([
      ['ai:agentStep', { requestId: 'ag-1', step: { tool: 'outline', label: 'Reading the outline…' } }]
    ])
    expect(result.steps).toHaveLength(1)
    expect(result.usage).toEqual({ inputTokens: 800, outputTokens: 60 })
    expect(result.dropped).toBe(0)
    expect(result.changes).toEqual([
      {
        edit: {
          kind: 'text',
          nodeId: scene.id,
          title: loadAgentProject(manager.require().connection.orm).titleOf(scene.id),
          find: 'Mara copied the ledger twice',
          replace: 'Mara copied it twice'
        },
        violation: null
      }
    ])
    // Nothing was written: the scene still reads as it did.
    const stored = await invoke('document:get', { id: scene.id })
    expect(JSON.stringify(stored.content)).toContain('Mara copied the ledger twice')
    expect(getProposal(manager.require().connection.orm, result.proposalId)).toMatchObject({
      feature: 'agent',
      status: 'pending'
    })
  })

  it('answers DISABLED as data at Off, with the requestId', async () => {
    await invoke('project:create', { name: 'Off', format: 'novel', directory: tmp })
    const scene = manuscriptDocuments(manager.require().connection.orm)[0]
    if (!scene) throw new Error('skeleton not seeded')
    expect(await invoke('ai:agent', ask(scene.id, { requestId: 'ag-2' }))).toMatchObject({
      ok: false,
      code: 'DISABLED',
      requestId: 'ag-2'
    })
  })
})

describe('ai:draftBrief (F-14.3)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const SCENE =
    'The ferry landing was empty when Mara reached it. The rope hung slack in the water and ' +
    'the bell had lost its clapper years ago. She set the lantern down on the post and waited. ' +
    '"You came alone," a voice said behind her.'
  const DRAFT = {
    goal: 'Mara wants to cross the river tonight.',
    conflict: 'The river is up and Tomas will not row.',
    turn: 'She decides to wait for morning.',
    beat: 'Dread giving way to resolve.',
    after: 'The crossing is off until dawn.'
  }

  /** A project with the dial at Ask, a key, and a scene long enough to draft a brief from. */
  async function ready(dial: AiDial = 1): Promise<{ scene: string; folder: string }> {
    await invoke('project:create', { name: 'Brief', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    const folder = rows.find((r) => r.kind === 'folder' && r.hierarchyLevel === 'chapter')
    if (!scene || !folder) throw new Error('skeleton not seeded')
    await invoke('document:save', {
      id: scene.id,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: SCENE }] }]
      }
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial })
    await invoke('ai:setKey', { key: KEY })
    answersWith(DRAFT)
    return { scene: scene.id, folder: folder.id }
  }

  /** The next provider answer, as the JSON the brief prompt asks for. */
  function answersWith(answer: unknown): void {
    complete.mockResolvedValue({
      text: JSON.stringify(answer),
      model: 'gpt-fake',
      usage: { inputTokens: 500, outputTokens: 70 }
    })
  }

  const ask = (scene: string, requestId = 'br-1'): Input<'ai:draftBrief'> => ({
    nodeId: scene,
    requestId
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('ai:draftBrief', ask('x'))).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers the five lines and records them as one pending proposal with a ledger row', async () => {
    const { scene } = await ready()
    const result = await invoke('ai:draftBrief', ask(scene, 'br-7'))
    if (!result.ok) throw new Error(result.message)
    expect(result).toEqual({
      ok: true,
      brief: DRAFT,
      truncated: false,
      usage: { inputTokens: 500, outputTokens: 70 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      proposalId: result.proposalId,
      requestId: 'br-7'
    })
    expect(getProposal(manager.require().connection.orm, result.proposalId)).toMatchObject({
      feature: 'brief',
      nodeId: scene,
      promptVersion: 'brief.v1',
      content: JSON.stringify(DRAFT),
      flagged: false,
      violation: null,
      regeneratedFrom: null,
      status: 'pending'
    })
    // Nothing is written to the node: the author fills the fields on Use draft.
    expect((await invoke('sceneMeta:get', { id: scene })).meta.brief).toEqual(EMPTY_SCENE_BRIEF)
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['brief'])
  })

  it('answers an expected AI failure as data with the requestId, and a folder, an unknown node, or too little text through the error envelope', async () => {
    const { scene, folder } = await ready(0)
    expect(await invoke('ai:draftBrief', ask(scene, 'br-3'))).toEqual({
      ok: false,
      code: 'DISABLED',
      message: 'Scene brief drafts needs the AI switch at Ask or Auto (it is at Off).',
      nextStep:
        'Set the AI switch to Ask or Auto in the assistant panel or Settings, or enable the feature there.',
      requestId: 'br-3'
    })
    expect(manager.require().connection.orm.select().from(aiProposal).all()).toHaveLength(0)
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    const unknown = await handlerFor('ai:draftBrief')(undefined, ask('nope'))
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    const onFolder = await handlerFor('ai:draftBrief')(undefined, ask(folder))
    expect(onFolder.ok).toBe(false)
    if (!onFolder.ok) expect(onFolder.error.code).toBe('VALIDATION')
    await invoke('document:save', {
      id: scene,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Too short.' }] }]
      }
    })
    const short = await handlerFor('ai:draftBrief')(undefined, ask(scene))
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.error.code).toBe('VALIDATION')
  })
})

describe('scene summaries (F-5.6)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const SCENE =
    'The ferry landing was empty when Mara reached it. The rope hung slack in the water and ' +
    'the bell had lost its clapper years ago. She set the lantern down on the post and waited. ' +
    '"You came alone," a voice said behind her.'
  const ANSWER = {
    summary: 'Mara waited alone at the ferry landing until a voice spoke behind her.',
    keyPoints: ['The bell has no clapper', 'Someone follows her'],
    characters: ['Mara']
  }

  /** A project with the dial at Ask, a key, and a scene long enough to summarise. */
  async function ready(dial: AiDial = 1): Promise<{ scene: string; folder: string }> {
    await invoke('project:create', { name: 'Summary', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    const folder = rows.find((r) => r.kind === 'folder' && r.hierarchyLevel === 'chapter')
    if (!scene || !folder) throw new Error('skeleton not seeded')
    await write(scene.id, SCENE)
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial })
    await invoke('ai:setKey', { key: KEY })
    complete.mockResolvedValue({
      text: JSON.stringify(ANSWER),
      model: 'gpt-fake',
      usage: { inputTokens: 400, outputTokens: 60 }
    })
    return { scene: scene.id, folder: folder.id }
  }

  const write = (id: string, text: string): Promise<unknown> =>
    invoke('document:save', {
      id,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
    })

  /** The `ai:summaryChanged` payloads sent to the window. */
  const statusesSent = (): unknown[] =>
    vi
      .mocked(fakeWin.webContents.send)
      .mock.calls.filter(([channel]) => channel === 'ai:summaryChanged')
      .map(([, payload]) => payload)

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('summary:get', { id: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('ai:summarize', { nodeId: 'x', requestId: 's-0' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('says a long scene has no summary yet and is out of date, and that a folder has none at all', async () => {
    const { scene, folder } = await ready()
    // The save in `ready` landed while the dial was still Off, so nothing was queued and the
    // pane never said "Updating…" for a run that would not happen; the scene is simply out of
    // date. A save once the feature is allowed queues the node and reads as pending from the
    // save, not from the moment the request leaves.
    expect(await invoke('summary:get', { id: scene })).toEqual({
      available: true,
      summary: null,
      stale: true,
      status: 'idle',
      error: null
    })
    expect(statusesSent()).toEqual([])
    await write(scene, `${SCENE} She waited.`)
    expect(await invoke('summary:get', { id: scene })).toMatchObject({ status: 'pending' })
    expect(statusesSent()).toEqual([{ nodeId: scene, status: 'pending' }])
    for (const id of [folder, 'nope']) {
      expect(await invoke('summary:get', { id })).toEqual({
        available: false,
        summary: null,
        stale: false,
        status: 'idle',
        error: null
      })
    }
  })

  it('summarises now, stores the row, and answers the state with what the run cost', async () => {
    const { scene } = await ready()
    const result = await invoke('ai:summarize', { nodeId: scene, requestId: 's-1' })
    if (!result.ok) throw new Error(result.message)
    expect(result).toMatchObject({
      ok: true,
      usage: { inputTokens: 400, outputTokens: 60 },
      cached: false,
      model: 'gpt-fake',
      requestId: 's-1'
    })
    expect(result.state).toMatchObject({ available: true, stale: false, status: 'idle' })
    expect(result.state.summary).toMatchObject({
      ...ANSWER,
      nodeId: scene,
      promptVersion: 'summary.v3',
      model: 'gpt-fake',
      truncated: false
    })
    expect(await invoke('summary:get', { id: scene })).toEqual(result.state)
    const usage = await invoke('ai:usageSummary', undefined)
    expect(usage.byFeature.map((f) => f.feature)).toEqual(['summary'])
    // The pane hears about the run without polling.
    expect(statusesSent()).toContainEqual({ nodeId: scene, status: 'idle' })
  })

  it('tags the scene from the summary answer and tells the windows: the tags and the scene (F-4.13)', async () => {
    const { scene } = await ready()
    complete.mockResolvedValue({
      text: JSON.stringify({ ...ANSWER, tags: [{ name: 'Dread', category: 'tone' }] }),
      model: 'gpt-fake',
      usage: { inputTokens: 400, outputTokens: 60 }
    })
    const result = await invoke('ai:summarize', { nodeId: scene, requestId: 's-t' })
    if (!result.ok) throw new Error(result.message)
    const linked = await invoke('documentTag:list', { nodeId: scene })
    expect(linked).toMatchObject([{ name: 'dread', category: 'tone', source: 'ai', usageCount: 1 }])
    const sent = (channel: string): unknown[] =>
      vi
        .mocked(fakeWin.webContents.send)
        .mock.calls.filter(([name]) => name === channel)
        .map(([, payload]) => payload)
    expect(sent('tag:changed')).toMatchObject([{ name: 'dread', usageCount: 1 }])
    expect(sent('documentTag:changed')).toEqual([{ nodeIds: [scene] }])
    // One click removes it, and the removal is the author's: the tag stays in the bank.
    const dread = linked[0]
    if (!dread) throw new Error('no tag linked')
    await invoke('documentTag:remove', { nodeId: scene, tagId: dread.id })
    expect(await invoke('documentTag:list', { nodeId: scene })).toEqual([])
    expect(await invoke('tag:list', undefined)).toMatchObject([{ name: 'dread', usageCount: 0 }])
  })

  it('logs the facts the summary answers and tells the windows: the new entity, its tag, and whose facts moved (F-5.16)', async () => {
    const { scene } = await ready()
    complete.mockResolvedValue({
      text: JSON.stringify({
        ...ANSWER,
        facts: [
          {
            entity: 'Mara',
            kind: 'character',
            attribute: 'appearance',
            value: 'Carries a lantern',
            quote: 'She set the lantern down on the post'
          }
        ]
      }),
      model: 'gpt-fake',
      usage: { inputTokens: 400, outputTokens: 60 }
    })
    const result = await invoke('ai:summarize', { nodeId: scene, requestId: 's-f' })
    if (!result.ok) throw new Error(result.message)
    const entities = await invoke('entity:list', undefined)
    expect(entities).toMatchObject([{ kind: 'character', name: 'Mara', origin: 'ai' }])
    const mara = entities[0]
    const sent = (channel: string): unknown[] =>
      vi
        .mocked(fakeWin.webContents.send)
        .mock.calls.filter(([name]) => name === channel)
        .map(([, payload]) => payload)
    expect(sent('entity:changed')).toEqual([mara])
    expect(sent('tag:changed')).toMatchObject([{ id: mara?.tagId, name: 'mara' }])
    expect(sent('observedFact:changed')).toEqual([{ entityIds: [mara?.id] }])
    expect(await invoke('observedFact:listForEntity', { entityId: mara?.id ?? '' })).toMatchObject([
      { nodeId: scene, attribute: 'appearance', value: 'Carries a lantern', hidden: false }
    ])
    // The run created an entity the scene names and still left the scene current.
    expect(result.state).toMatchObject({ stale: false, status: 'idle' })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('attaches a fact to the author’s own entity: nothing is created, the sheet is untouched, and only the facts are announced (F-5.16)', async () => {
    const { scene } = await ready()
    const mara = await invoke('entity:create', {
      kind: 'character',
      name: 'Mara',
      fields: { appearance: 'Tall, grey-eyed' }
    })
    vi.mocked(fakeWin.webContents.send).mockClear()
    complete.mockResolvedValue({
      text: JSON.stringify({
        ...ANSWER,
        facts: [
          {
            entity: 'mara',
            kind: 'character',
            attribute: 'appearance',
            value: 'Carries a lantern',
            quote: 'She set the lantern down on the post'
          }
        ]
      }),
      model: 'gpt-fake',
      usage: { inputTokens: 400, outputTokens: 60 }
    })
    const result = await invoke('ai:summarize', { nodeId: scene, requestId: 's-a' })
    if (!result.ok) throw new Error(result.message)
    // The request named her as the author spells her, so the model attaches rather than invents.
    expect(complete.mock.calls[0]![0].messages[0]?.content).toContain(
      'Story-bible names in this scene: characters Mara.'
    )
    // Still one entity, still the author's, sheet as written.
    expect(await invoke('entity:list', undefined)).toEqual([mara])
    expect(mara).toMatchObject({ origin: 'author', fields: { appearance: 'Tall, grey-eyed' } })
    const sent = (channel: string): unknown[] =>
      vi
        .mocked(fakeWin.webContents.send)
        .mock.calls.filter(([name]) => name === channel)
        .map(([, payload]) => payload)
    expect(sent('entity:changed')).toEqual([])
    expect(sent('tag:changed')).toEqual([])
    expect(sent('observedFact:changed')).toEqual([{ entityIds: [mara.id] }])
    expect(await invoke('observedFact:listForEntity', { entityId: mara.id })).toMatchObject([
      {
        entityId: mara.id,
        nodeId: scene,
        attribute: 'appearance',
        value: 'Carries a lantern',
        quote: 'She set the lantern down on the post',
        hidden: false
      }
    ])
    expect(result.state).toMatchObject({ stale: false, status: 'idle' })
    // One summary request. The sheet fills `appearance` and the fact says something else, so
    // the background consistency check (F-13.4) asks its own question after it.
    const summaries = complete.mock.calls.filter(([request]) =>
      request.messages[0]?.content.startsWith('You are the scene-summary feature')
    )
    expect(summaries).toHaveLength(1)
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[1]![0].messages[0]?.content).toContain(
      'You are the continuity feature'
    )
  })

  it('answers an unchanged scene from the stored row, and calls it out of date once it is edited', async () => {
    const { scene } = await ready()
    await invoke('ai:summarize', { nodeId: scene, requestId: 's-1' })
    const again = await invoke('ai:summarize', { nodeId: scene, requestId: 's-2' })
    if (!again.ok) throw new Error(again.message)
    expect(again.cached).toBe(true)
    expect(again.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(complete).toHaveBeenCalledTimes(1)

    await write(scene, `${SCENE} She did not turn.`)
    const state = await invoke('summary:get', { id: scene })
    expect(state.stale).toBe(true)
    expect(state.summary?.summary).toBe(ANSWER.summary)
  })

  it('answers an expected AI failure as data, and a folder through the error envelope', async () => {
    const { scene, folder } = await ready(0)
    expect(await invoke('ai:summarize', { nodeId: scene, requestId: 's-3' })).toEqual({
      ok: false,
      code: 'DISABLED',
      message:
        'Scene summaries, story bible, and tags needs the AI switch at Ask or Auto (it is at Off).',
      nextStep:
        'Set the AI switch to Ask or Auto in the assistant panel or Settings, or enable the feature there.',
      requestId: 's-3'
    })
    expect(complete).not.toHaveBeenCalled()
    // A refused run is not a failure the author must act on: the node goes quiet again.
    expect((await invoke('summary:get', { id: scene })).status).toBe('idle')

    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    const onFolder = await handlerFor('ai:summarize')(undefined, {
      nodeId: folder,
      requestId: 's-4'
    })
    expect(onFolder.ok).toBe(false)
    if (!onFolder.ok) expect(onFolder.error.code).toBe('VALIDATION')
  })

  it('marks a saved scene pending at once and summarises it after the debounce, in the background', async () => {
    // Fake timers before the project, so every debounce this test starts is a fake one.
    vi.useFakeTimers()
    try {
      const { scene } = await ready()
      await write(scene, `${SCENE} The wind pushed the flame flat.`)
      expect((await invoke('summary:get', { id: scene })).status).toBe('pending')
      expect(statusesSent()).toContainEqual({ nodeId: scene, status: 'pending' })
      expect(complete).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(3_000)
      expect(complete).toHaveBeenCalledTimes(1)
      const state = await invoke('summary:get', { id: scene })
      expect(state).toMatchObject({ status: 'idle', stale: false })
      expect(state.summary?.summary).toBe(ANSWER.summary)
      expect(statusesSent()).toContainEqual({ nodeId: scene, status: 'idle' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('indexes the text written before AI was on, a moment after the dial and the key, unasked', async () => {
    vi.useFakeTimers()
    try {
      const { scene } = await ready()
      expect(complete).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(SUMMARY_BACKFILL_DELAY_MS)
      expect(complete).toHaveBeenCalledTimes(1)
      const state = await invoke('summary:get', { id: scene })
      expect(state).toMatchObject({ status: 'idle', stale: false })
      // A settings change over an indexed book queues nothing and costs nothing.
      await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
      await vi.advanceTimersByTimeAsync(SUMMARY_BACKFILL_DELAY_MS)
      expect(complete).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('indexes nothing until a provider can answer, then picks the book up once the key is saved', async () => {
    vi.useFakeTimers()
    try {
      await invoke('project:create', { name: 'Keyless', format: 'novel', directory: tmp })
      const rows = await invoke('tree:list', undefined)
      const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
      if (!scene) throw new Error('skeleton not seeded')
      await write(scene.id, SCENE)
      await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
      await vi.advanceTimersByTimeAsync(SUMMARY_BACKFILL_DELAY_MS)
      expect(complete).not.toHaveBeenCalled()
      expect((await invoke('jobs:status', undefined)).paused).toBeNull()
      complete.mockResolvedValue({
        text: JSON.stringify(ANSWER),
        model: 'gpt-fake',
        usage: { inputTokens: 400, outputTokens: 60 }
      })
      await invoke('ai:setKey', { key: KEY })
      await vi.advanceTimersByTimeAsync(SUMMARY_BACKFILL_DELAY_MS)
      expect(complete).toHaveBeenCalledTimes(1)
      expect((await invoke('summary:get', { id: scene.id })).stale).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the book alone with the summaries toggle off', async () => {
    vi.useFakeTimers()
    try {
      const { scene } = await ready()
      const settings = defaultAiSettings()
      await invoke('aiSettings:set', {
        ...settings,
        dial: 1,
        features: { ...settings.features, summary: false }
      })
      await vi.advanceTimersByTimeAsync(SUMMARY_BACKFILL_DELAY_MS)
      expect(complete).not.toHaveBeenCalled()
      expect((await invoke('summary:get', { id: scene })).stale).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('records a provider failure on the node, where the author can act on it', async () => {
    const { scene } = await ready()
    complete.mockRejectedValueOnce(new InvalidKeyError('The API key was rejected.'))
    const failed = await invoke('ai:summarize', { nodeId: scene, requestId: 's-5' })
    expect(failed).toMatchObject({ ok: false, code: 'INVALID_KEY', requestId: 's-5' })
    expect(await invoke('summary:get', { id: scene })).toMatchObject({
      status: 'failed',
      error: {
        message: 'The API key was rejected.',
        nextStep: 'Check the key and try again.'
      }
    })
    expect(statusesSent()).toContainEqual({ nodeId: scene, status: 'failed' })
  })

  it('forgets a pending summary when the project closes, so nothing runs against the next one', async () => {
    vi.useFakeTimers()
    try {
      const { scene } = await ready()
      await write(scene, `${SCENE} The lantern went out.`)
      await invoke('project:close', undefined)
      await vi.advanceTimersByTimeAsync(3_000 * 2)
      expect(complete).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('tag handlers (F-4.1)', () => {
  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('tag:list', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('tag:create', { name: 'x', category: 'custom' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('creates a tag that tag:list then shows with the category color and no usage', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    const created = await invoke('tag:create', { name: 'Dark Forest', category: 'setting' })
    expect(created).toMatchObject({
      name: 'dark-forest',
      category: 'setting',
      color: DEFAULT_CATEGORY_COLOR.setting,
      parentId: null,
      usageCount: 0
    })
    expect(await invoke('tag:list', undefined)).toEqual([created])
  })

  it('recolors and renames through tag:update and removes through tag:delete', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    const created = await invoke('tag:create', { name: 'Rain', category: 'tone' })
    const updated = await invoke('tag:update', {
      id: created.id,
      color: '#112233',
      name: 'Heavy Rain'
    })
    expect(updated).toMatchObject({ id: created.id, color: '#112233', name: 'heavy-rain' })
    expect((await invoke('tag:list', undefined)).map((t) => t.name)).toEqual(['heavy-rain'])
    expect(await invoke('tag:delete', { id: created.id })).toBeNull()
    expect(await invoke('tag:list', undefined)).toEqual([])
  })

  it('survives a reopen', async () => {
    const project = await invoke('project:create', {
      name: 'Tags',
      format: 'novel',
      directory: tmp
    })
    const created = await invoke('tag:create', { name: 'Rain', category: 'tone' })
    await invoke('project:close', undefined)
    await invoke('project:open', { path: project?.path ?? '' })
    expect(await invoke('tag:list', undefined)).toEqual([created])
  })

  it('surfaces VALIDATION, ALREADY_EXISTS, and NOT_FOUND through the envelope', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    await invoke('tag:create', { name: 'Rain', category: 'tone' })
    await expect(invoke('tag:create', { name: '—', category: 'tone' })).rejects.toThrowError(
      /^VALIDATION: /
    )
    await expect(invoke('tag:create', { name: 'rain!', category: 'custom' })).rejects.toThrowError(
      /^ALREADY_EXISTS: /
    )
    await expect(invoke('tag:update', { id: 'missing', color: '#000000' })).rejects.toThrowError(
      /^NOT_FOUND: /
    )
    await expect(invoke('tag:delete', { id: 'missing' })).rejects.toThrowError(/^NOT_FOUND: /)
    // Contract boundary: a bad color or category never reaches the store.
    const raw = handlerFor('tag:create')
    for (const bad of [
      { name: 'x', category: 'tone', color: '#FFF' },
      { name: 'x', category: 'plot-thread' },
      { name: '   ', category: 'tone' }
    ]) {
      const result = await raw(undefined, bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect((await invoke('tag:list', undefined)).map((t) => t.name)).toEqual(['rain'])
  })
})

describe('entity handlers (F-9.1)', () => {
  const openProject = (): Promise<unknown> =>
    invoke('project:create', { name: 'Bible', format: 'novel', directory: tmp })

  /** Every tag sent to the window as `tag:changed` (F-9.4), in order, as its names. */
  const tagsChanged = (): string[] =>
    vi
      .mocked(fakeWin.webContents.send)
      .mock.calls.filter(([channel]) => channel === 'tag:changed')
      .map(([, payload]) => (payload as { name: string }).name)

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('entity:list', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('entity:create', { kind: 'character', name: 'Ada' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
    await expect(invoke('entity:linkTag', { id: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('creates, lists, gets, updates, and deletes an entity', async () => {
    await openProject()
    const created = await invoke('entity:create', {
      kind: 'character',
      name: 'Ada Lovelace',
      fields: { age: '36' }
    })
    expect(created).toMatchObject({
      kind: 'character',
      name: 'Ada Lovelace',
      template: 'structured',
      fields: { age: '36' },
      body: null,
      image: null
    })
    // F-9.4: the tag of the name is created with the entity.
    expect(typeof created.tagId).toBe('string')
    expect(await invoke('entity:list', undefined)).toEqual([created])
    expect(await invoke('entity:get', { id: created.id })).toEqual(created)
    const updated = await invoke('entity:update', {
      id: created.id,
      name: 'Ada',
      fields: { age: '', goals: 'Finish the engine.' }
    })
    expect(updated).toMatchObject({ name: 'Ada', fields: { goals: 'Finish the engine.' } })
    expect(await invoke('entity:delete', { id: created.id })).toBeNull()
    expect(await invoke('entity:list', undefined)).toEqual([])
  })

  it('lists the story bible by kind and then by name', async () => {
    await openProject()
    await invoke('entity:create', { kind: 'world', name: 'Tide Law', template: 'blank' })
    await invoke('entity:create', { kind: 'setting', name: 'harbor' })
    await invoke('entity:create', { kind: 'character', name: 'Brann' })
    await invoke('entity:create', { kind: 'setting', name: 'Blackreach' })
    expect((await invoke('entity:list', undefined)).map((e) => [e.kind, e.name])).toEqual([
      ['character', 'Brann'],
      ['setting', 'Blackreach'],
      ['setting', 'harbor'],
      ['world', 'Tide Law']
    ])
  })

  it('survives a reopen', async () => {
    const project = await invoke('project:create', {
      name: 'Bible',
      format: 'novel',
      directory: tmp
    })
    const created = await invoke('entity:create', {
      kind: 'world',
      name: 'The Tide Law',
      template: 'blank',
      body: 'Salt binds.'
    })
    await invoke('project:close', undefined)
    await invoke('project:open', { path: project?.path ?? '' })
    expect(await invoke('entity:list', undefined)).toEqual([created])
  })

  it('surfaces ALREADY_EXISTS, VALIDATION, and NOT_FOUND through the envelope', async () => {
    await openProject()
    const ada = await invoke('entity:create', { kind: 'character', name: 'Ada' })
    await expect(
      invoke('entity:create', { kind: 'character', name: ' ada ' })
    ).rejects.toThrowError(/^ALREADY_EXISTS: /)
    // The same name under another kind is free.
    await invoke('entity:create', { kind: 'setting', name: 'Ada' })
    await expect(
      invoke('entity:create', { kind: 'setting', name: 'Harbor', fields: { age: '400' } })
    ).rejects.toThrowError(/^VALIDATION: /)
    await expect(
      invoke('entity:update', { id: ada.id, fields: { atmosphere: 'Damp' } })
    ).rejects.toThrowError(/^VALIDATION: /)
    await expect(invoke('entity:get', { id: 'missing' })).rejects.toThrowError(/^NOT_FOUND: /)
    await expect(invoke('entity:update', { id: 'missing', name: 'x' })).rejects.toThrowError(
      /^NOT_FOUND: /
    )
    await expect(invoke('entity:delete', { id: 'missing' })).rejects.toThrowError(/^NOT_FOUND: /)
    // Contract boundary: an unknown kind, an unknown field id, or an empty name never reaches
    // the store.
    const raw = handlerFor('entity:create')
    for (const bad of [
      { kind: 'creature', name: 'Wyrm' },
      { kind: 'character', name: 'Ada', fields: { favourite: 'tea' } },
      { kind: 'character', name: '   ' }
    ]) {
      const result = await raw(undefined, bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect((await invoke('entity:list', undefined)).map((e) => e.name)).toEqual(['Ada', 'Ada'])
  })

  it('creates the entity’s tag, puts it in the bank, and tells the windows (F-9.4)', async () => {
    await openProject()
    const mara = await invoke('entity:create', { kind: 'character', name: 'Mara Vell' })
    const bank = await invoke('tag:list', undefined)
    expect(bank.map((t) => [t.name, t.category])).toEqual([['mara-vell', 'character']])
    expect(mara.tagId).toBe(bank[0]?.id)
    expect(tagsChanged()).toEqual(['mara-vell'])

    // A rename carries the tag with it, and the windows hear the new name.
    const renamed = await invoke('entity:update', { id: mara.id, name: 'Mara Sedge' })
    expect(renamed.tagId).toBe(mara.tagId)
    expect((await invoke('tag:list', undefined)).map((t) => t.name)).toEqual(['mara-sedge'])
    expect(tagsChanged()).toEqual(['mara-vell', 'mara-sedge'])

    // A patch that is not a rename says nothing about the bank.
    await invoke('entity:update', { id: mara.id, fields: { age: '31' } })
    expect(tagsChanged()).toEqual(['mara-vell', 'mara-sedge'])

    // Deleting the entity leaves its tag in the bank.
    await invoke('entity:delete', { id: mara.id })
    expect((await invoke('tag:list', undefined)).map((t) => t.name)).toEqual(['mara-sedge'])
  })

  it('links an existing tag, and links one again after it was deleted (F-9.4)', async () => {
    await openProject()
    const rose = await invoke('tag:create', { name: 'Rose', category: 'plotThread' })
    const entity = await invoke('entity:create', { kind: 'character', name: 'Rose' })
    expect(entity.tagId).toBe(rose.id)
    // Nothing was created, so nothing was announced.
    expect(tagsChanged()).toEqual([])
    expect(await invoke('tag:list', undefined)).toHaveLength(1)

    // The pair comes back unchanged for an entity already linked to the tag of its name.
    expect(await invoke('entity:linkTag', { id: entity.id })).toEqual({ entity, tag: rose })

    await invoke('tag:delete', { id: rose.id })
    expect((await invoke('entity:get', { id: entity.id })).tagId).toBeNull()
    const linked = await invoke('entity:linkTag', { id: entity.id })
    expect(linked.tag).toMatchObject({ name: 'rose', category: 'character' })
    expect(linked.entity.tagId).toBe(linked.tag.id)
    expect(tagsChanged()).toEqual(['rose'])
  })

  it('refuses entity:linkTag for an unknown id and a nameless name (F-9.4)', async () => {
    await openProject()
    await expect(invoke('entity:linkTag', { id: 'missing' })).rejects.toThrowError(/^NOT_FOUND: /)
    const nameless = await invoke('entity:create', { kind: 'character', name: '???' })
    expect(nameless.tagId).toBeNull()
    expect(await invoke('tag:list', undefined)).toEqual([])
    await expect(invoke('entity:linkTag', { id: nameless.id })).rejects.toThrowError(
      /^VALIDATION: /
    )
  })
})

describe('search:query (F-10.1)', () => {
  const request = (
    query: string
  ): { query: string; types: ['document', 'character']; tagId: null } => ({
    query,
    types: ['document', 'character'],
    tagId: null
  })

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('search:query', request('lantern'))).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers the matching documents and entities, and empty for a query under the minimum', async () => {
    await invoke('project:create', { name: 'Search', format: 'novel', directory: tmp })
    const scene = manuscriptReadingOrder(await invoke('tree:list', undefined))[0]
    if (scene === undefined) throw new Error('skeleton not seeded')
    await invoke('document:save', {
      id: scene,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The Lantern swung.' }] }]
      }
    })
    const ada = await invoke('entity:create', {
      kind: 'character',
      name: 'Ada',
      fields: { goals: 'Keep the lantern lit.' }
    })
    const answer = await invoke('search:query', request(' lantern '))
    expect(answer.total).toBe(2)
    expect(answer.truncated).toBe(false)
    expect(answer.results).toMatchObject([
      {
        type: 'document',
        id: scene,
        snippet: { text: 'The Lantern swung.', highlights: [[4, 11]] },
        count: 1
      },
      { type: 'character', id: ada.id, title: 'Ada', field: 'Goals / motivations', count: 1 }
    ])
    expect(await invoke('search:query', request('l'))).toEqual({
      results: [],
      total: 0,
      truncated: false
    })
    // The text cache is the closed project's: another project never reads it.
    await invoke('project:close', undefined)
    await invoke('project:create', { name: 'Other', format: 'novel', directory: tmp })
    expect((await invoke('search:query', request('lantern'))).total).toBe(0)
  })
})

describe('replace:* (F-10.2)', () => {
  const request = (
    query: string,
    replacement: string
  ): {
    query: string
    replacement: string
    matchCase: boolean
    wholeWord: boolean
    scopeId: string | null
  } => ({ query, replacement, matchCase: false, wholeWord: false, scopeId: null })

  const prose = (
    text: string
  ): { type: string; content: { type: string; content: { type: string; text: string }[] }[] } => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

  /** A project whose first scene holds `text`; answers the scene's id. */
  async function ready(text: string, name = 'Replace'): Promise<string> {
    await invoke('project:create', { name, format: 'novel', directory: tmp })
    const scene = manuscriptReadingOrder(await invoke('tree:list', undefined))[0]
    if (scene === undefined) throw new Error('skeleton not seeded')
    await invoke('document:save', { id: scene, content: prose(text) })
    return scene
  }

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('replace:preview', request('a', 'b'))).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('replace:commit', { ...request('a', 'b'), ids: [] })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
    await expect(invoke('replace:undo', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('previews, commits, and undoes over the stored document', async () => {
    const scene = await ready('The Lantern swung. A lantern.')
    const preview = await invoke('replace:preview', request('lantern', 'lamp'))
    expect(preview).toMatchObject({
      total: 1,
      truncated: false,
      items: [{ id: scene, count: 2 }]
    })
    expect((await invoke('document:get', { id: scene })).content).toEqual(
      prose('The Lantern swung. A lantern.')
    )

    const committed = await invoke('replace:commit', {
      ...request('lantern', 'oil lamp'),
      ids: [scene]
    })
    expect(committed).toEqual({ changed: [{ id: scene, count: 2, wordCount: 7 }], total: 2 })
    expect((await invoke('document:get', { id: scene })).content).toEqual(
      prose('The oil lamp swung. A oil lamp.')
    )
    const tree = await invoke('tree:list', undefined)
    expect(tree.find((row) => row.id === scene)?.wordCount).toBe(7)
    // The search answers from the rewritten text, not from its cache.
    const types: ['document'] = ['document']
    expect((await invoke('search:query', { query: 'lantern', types, tagId: null })).total).toBe(0)
    expect((await invoke('search:query', { query: 'oil lamp', types, tagId: null })).total).toBe(1)

    expect(await invoke('replace:undo', undefined)).toEqual({
      restored: [{ id: scene, wordCount: 5 }],
      skipped: []
    })
    expect((await invoke('document:get', { id: scene })).content).toEqual(
      prose('The Lantern swung. A lantern.')
    )
    expect(await invoke('replace:undo', undefined)).toEqual({ restored: [], skipped: [] })
  })

  it('refuses an unknown scope and a request over the limits', async () => {
    await ready('A lantern.')
    await expect(
      invoke('replace:preview', { ...request('lantern', 'lamp'), scopeId: 'gone' })
    ).rejects.toThrowError(/^NOT_FOUND: /)
    await expect(
      invoke('replace:preview', request('lantern', 'x'.repeat(1001)))
    ).rejects.toThrowError(/^VALIDATION: /)
  })

  it('undo leaves a document saved since the commit alone', async () => {
    const scene = await ready('A lantern.')
    await invoke('replace:commit', { ...request('lantern', 'lamp'), ids: [scene] })
    await invoke('document:save', { id: scene, content: prose('A lamp. And more.') })
    expect(await invoke('replace:undo', undefined)).toEqual({ restored: [], skipped: [scene] })
    expect((await invoke('document:get', { id: scene })).content).toEqual(
      prose('A lamp. And more.')
    )
  })

  it('forgets the undo when the project changes', async () => {
    await ready('A lantern.')
    const scene = manuscriptReadingOrder(await invoke('tree:list', undefined))[0] ?? ''
    await invoke('replace:commit', { ...request('lantern', 'lamp'), ids: [scene] })
    await invoke('project:close', undefined)
    await ready('A lantern.', 'Other')
    expect(await invoke('replace:undo', undefined)).toEqual({ restored: [], skipped: [] })
  })

  it('rescans the mentions of a replaced document, and again after the undo, like a save', async () => {
    vi.useFakeTimers()
    try {
      const SCAN = 3_000
      const scene = await ready('Mara waited at the landing.')
      const rose = await invoke('tag:create', { name: 'Rose', category: 'character' })
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(await invoke('mention:listForNode', { nodeId: scene })).toEqual([])
      vi.mocked(fakeWin.webContents.send).mockClear()

      await invoke('replace:commit', { ...request('Mara', 'Rose'), ids: [scene] })
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(await invoke('mention:listForNode', { nodeId: scene })).toEqual([
        { tagId: rose.id, nodeId: scene, count: 1, ranges: [[1, 5]] }
      ])
      const changed = (): string[] =>
        vi
          .mocked(fakeWin.webContents.send)
          .mock.calls.filter(([channel]) => channel === 'mention:changed')
          .flatMap(([, payload]) => (payload as { nodeIds: string[] }).nodeIds)
      expect(changed()).toEqual([scene])

      await invoke('replace:undo', undefined)
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(await invoke('mention:listForNode', { nodeId: scene })).toEqual([])
      expect(changed()).toEqual([scene, scene])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('observed facts (F-5.16)', () => {
  /** The `observedFact:changed` payloads sent to the window, in order. */
  const factsChanged = (): unknown[] =>
    vi
      .mocked(fakeWin.webContents.send)
      .mock.calls.filter(([channel]) => channel === 'observedFact:changed')
      .map(([, payload]) => payload)

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('observedFact:listForEntity', { entityId: 'x' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
    await expect(invoke('observedFact:setHidden', { id: 'x', hidden: true })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('lists an entity’s facts, hides and restores one, and tells the windows', async () => {
    await invoke('project:create', { name: 'Bible', format: 'novel', directory: tmp })
    const mara = await invoke('entity:create', { kind: 'character', name: 'Mara' })
    expect(mara.origin).toBe('author')
    expect(await invoke('observedFact:listForEntity', { entityId: mara.id })).toEqual([])
    const scene = (await invoke('tree:list', undefined)).find(
      (node) => node.kind === 'document' && node.sectionType === null
    )
    replaceSceneFacts(manager.require().connection.orm, scene?.id ?? '', [
      { entityId: mara.id, attribute: 'age', value: 'nineteen', quote: 'She was nineteen.' }
    ])
    const [fact, ...rest] = await invoke('observedFact:listForEntity', { entityId: mara.id })
    expect(rest).toEqual([])
    expect(fact).toMatchObject({ entityId: mara.id, nodeId: scene?.id, hidden: false })

    const id = fact?.id ?? ''
    expect(await invoke('observedFact:setHidden', { id, hidden: true })).toEqual({
      ...fact,
      hidden: true
    })
    expect(await invoke('observedFact:listForEntity', { entityId: mara.id })).toEqual([
      { ...fact, hidden: true }
    ])
    expect(await invoke('observedFact:setHidden', { id, hidden: false })).toEqual(fact)
    expect(factsChanged()).toEqual([{ entityIds: [mara.id] }, { entityIds: [mara.id] }])

    await expect(
      invoke('observedFact:setHidden', { id: 'missing', hidden: true })
    ).rejects.toThrowError(/^NOT_FOUND: /)
    expect(factsChanged()).toHaveLength(2)
  })
})

describe('entity images (F-9.3)', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwTpsJAAICATNWh+JUAAAAAElFTkSuQmCC',
    'base64'
  )
  /** The project folder of a project created for one of these tests. */
  let projectPath: string

  const image = (name: string): string => {
    const file = path.join(tmp, name)
    fs.writeFileSync(file, PNG)
    return file
  }
  const entitiesDir = (): string => path.join(projectPath, 'assets', 'entities')
  const storedFiles = (): string[] =>
    fs.existsSync(entitiesDir()) ? fs.readdirSync(entitiesDir()).sort() : []

  const openProject = async (): Promise<void> => {
    const created = await invoke('project:create', {
      name: 'Bible',
      format: 'novel',
      directory: tmp
    })
    projectPath = created?.path ?? ''
  }

  it('reports NO_PROJECT for both channels when nothing is open', async () => {
    await expect(invoke('entity:setImage', { id: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('entity:removeImage', { id: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('copies the chosen image into the project and puts its file name on the row', async () => {
    await openProject()
    const mara = await invoke('entity:create', { kind: 'character', name: 'Mara' })
    chosenEntityImage = image('Portrait.PNG')
    const updated = await invoke('entity:setImage', { id: mara.id })
    const file = updated?.image ?? ''
    expect(file).toMatch(/^Portrait\.[0-9a-f]{8}\.png$/)
    expect(entityImageUrl(file)).toBe(`mythscribe-asset://entities/${file}`)
    expect(fs.readFileSync(path.join(entitiesDir(), file))).toEqual(PNG)
    expect((await invoke('entity:get', { id: mara.id })).image).toBe(file)
  })

  it('answers null and changes nothing when the dialog is cancelled', async () => {
    await openProject()
    const mara = await invoke('entity:create', { kind: 'character', name: 'Mara' })
    expect(await invoke('entity:setImage', { id: mara.id })).toBeNull()
    expect((await invoke('entity:get', { id: mara.id })).image).toBeNull()
    expect(storedFiles()).toEqual([])
  })

  it('refuses a world item with VALIDATION and leaves no file behind', async () => {
    await openProject()
    const law = await invoke('entity:create', { kind: 'world', name: 'Tide Law' })
    chosenEntityImage = image('Portrait.png')
    await expect(invoke('entity:setImage', { id: law.id })).rejects.toThrowError(/^VALIDATION: /)
    expect((await invoke('entity:get', { id: law.id })).image).toBeNull()
    expect(storedFiles()).toEqual([])
    await expect(invoke('entity:setImage', { id: 'missing' })).rejects.toThrowError(/^NOT_FOUND: /)
    expect(storedFiles()).toEqual([])
  })

  it('deletes the previous file when the image is replaced', async () => {
    await openProject()
    const mara = await invoke('entity:create', { kind: 'character', name: 'Mara' })
    chosenEntityImage = image('first.png')
    const first = (await invoke('entity:setImage', { id: mara.id }))?.image ?? ''
    chosenEntityImage = image('second.jpg')
    const second = (await invoke('entity:setImage', { id: mara.id }))?.image ?? ''
    expect(second).toMatch(/^second\.[0-9a-f]{8}\.jpg$/)
    expect(storedFiles()).toEqual([second])
    expect(fs.existsSync(path.join(entitiesDir(), first))).toBe(false)
  })

  it('removes the image: the column is null again and the file is gone', async () => {
    await openProject()
    const mara = await invoke('entity:create', { kind: 'character', name: 'Mara' })
    chosenEntityImage = image('first.png')
    await invoke('entity:setImage', { id: mara.id })
    const cleared = await invoke('entity:removeImage', { id: mara.id })
    expect(cleared.image).toBeNull()
    expect(storedFiles()).toEqual([])
    // Removing again is not an error: there is simply nothing to take out.
    expect((await invoke('entity:removeImage', { id: mara.id })).image).toBeNull()
    await expect(invoke('entity:removeImage', { id: 'missing' })).rejects.toThrowError(
      /^NOT_FOUND: /
    )
  })

  it('takes the image file with the entity when it is deleted', async () => {
    await openProject()
    const mara = await invoke('entity:create', { kind: 'character', name: 'Mara' })
    const other = await invoke('entity:create', { kind: 'setting', name: 'The Harbor' })
    chosenEntityImage = image('mara.png')
    await invoke('entity:setImage', { id: mara.id })
    chosenEntityImage = image('harbor.png')
    const kept = (await invoke('entity:setImage', { id: other.id }))?.image ?? ''
    expect(await invoke('entity:delete', { id: mara.id })).toBeNull()
    expect(storedFiles()).toEqual([kept])
  })
})

// F-9.5: the three channels around the review dialog. The formats and the merge rules have their
// own tests in `shared/entityExchange.test.ts` and `entity/entityExchange.test.ts`; these cover
// the wiring — the dialogs, the default name, the errors, and the one tag announcement per import.
describe('reference pins (F-9.6)', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwTpsJAAICATNWh+JUAAAAAElFTkSuQmCC',
    'base64'
  )
  const image = (name: string): string => {
    const file = path.join(tmp, name)
    fs.writeFileSync(file, PNG)
    return file
  }
  const referencesDir = (projectPath: string): string =>
    path.join(projectPath, 'assets', 'references')

  it('reports NO_PROJECT for all three when nothing is open', async () => {
    await expect(invoke('reference:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('reference:set', { pins: [] })).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('reference:addImages', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers no pins for a new project, then what was set in order, also after a reopen', async () => {
    const created = await invoke('project:create', {
      name: 'Pins',
      format: 'novel',
      directory: tmp
    })
    expect(await invoke('reference:get', undefined)).toEqual({ pins: [] })
    const mara = await invoke('entity:create', { kind: 'character', name: 'Mara' })
    const harbor = await invoke('entity:create', { kind: 'setting', name: 'Harbor' })
    const [node] = await invoke('tree:list', undefined)
    if (!node) throw new Error('a seeded node expected')
    const pins = [
      { type: 'entity' as const, id: harbor.id },
      { type: 'note' as const, id: node.id },
      { type: 'entity' as const, id: mara.id }
    ]
    // A duplicate in the request is dropped; the first copy keeps its place.
    expect(await invoke('reference:set', { pins: [...pins, pins[0]!] })).toEqual({ pins })
    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    expect(await invoke('reference:get', undefined)).toEqual({ pins })
  })

  it('refuses a value outside the schema with VALIDATION and keeps the stored pins', async () => {
    await invoke('project:create', { name: 'Pins', format: 'novel', directory: tmp })
    const raw = handlerFor('reference:set')
    for (const bad of [
      { pins: [{ type: 'scene', id: 'x' }] },
      { pins: [{ type: 'image', file: '../project.db' }] },
      { pins: Array.from({ length: 51 }, (_, i) => ({ type: 'entity', id: `e${i}` })) }
    ]) {
      const result = await raw(undefined, bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect(await invoke('reference:get', undefined)).toEqual({ pins: [] })
  })

  it('drops the pin of a deleted entity on the next read and rewrites the row', async () => {
    await invoke('project:create', { name: 'Pins', format: 'novel', directory: tmp })
    const mara = await invoke('entity:create', { kind: 'character', name: 'Mara' })
    const brann = await invoke('entity:create', { kind: 'character', name: 'Brann' })
    await invoke('reference:set', {
      pins: [
        { type: 'entity', id: mara.id },
        { type: 'entity', id: brann.id },
        { type: 'note', id: 'no-such-node' }
      ]
    })
    await invoke('entity:delete', { id: mara.id })
    const expected = { pins: [{ type: 'entity', id: brann.id }] }
    expect(await invoke('reference:get', undefined)).toEqual(expected)
    expect(await invoke('reference:get', undefined)).toEqual(expected)
  })

  it('copies the chosen images in, pins them after the existing pins, and skips refused ones by name', async () => {
    const created = await invoke('project:create', {
      name: 'Pins',
      format: 'novel',
      directory: tmp
    })
    const mara = await invoke('entity:create', { kind: 'character', name: 'Mara' })
    await invoke('reference:set', { pins: [{ type: 'entity', id: mara.id }] })
    chosenImages = [image('Harbor Map.PNG'), image('notes.txt'), image('b.jpg')]
    const result = await invoke('reference:addImages', undefined)
    expect(result?.skipped).toEqual(['notes.txt'])
    const files = fs.readdirSync(referencesDir(created?.path ?? ''))
    const map = files.find((file) => file.startsWith('Harbor-Map.'))
    const b = files.find((file) => file.startsWith('b.'))
    expect(files).toHaveLength(2)
    expect(result?.pins).toEqual({
      pins: [
        { type: 'entity', id: mara.id },
        { type: 'image', file: map },
        { type: 'image', file: b }
      ]
    })
    expect(await invoke('reference:get', undefined)).toEqual(result?.pins)
  })

  it('answers null when the image dialog is cancelled', async () => {
    const created = await invoke('project:create', {
      name: 'Pins',
      format: 'novel',
      directory: tmp
    })
    expect(await invoke('reference:addImages', undefined)).toBeNull()
    expect(fs.existsSync(referencesDir(created?.path ?? ''))).toBe(false)
  })

  it('skips the images that would go past the maximum', async () => {
    await invoke('project:create', { name: 'Pins', format: 'novel', directory: tmp })
    const [node] = await invoke('tree:list', undefined)
    if (!node) throw new Error('a seeded node expected')
    chosenImages = Array.from({ length: 49 }, (_, i) => image(`p${i}.png`))
    await invoke('reference:addImages', undefined)
    const full = await invoke('reference:set', {
      pins: [...(await invoke('reference:get', undefined)).pins, { type: 'note', id: node.id }]
    })
    expect(full.pins).toHaveLength(50)
    chosenImages = [image('late.png')]
    const result = await invoke('reference:addImages', undefined)
    expect(result?.skipped).toEqual(['late.png'])
    expect(result?.pins.pins).toHaveLength(50)
  })

  it('deletes the file of an unpinned image, and only that one; a reorder deletes nothing', async () => {
    const created = await invoke('project:create', {
      name: 'Pins',
      format: 'novel',
      directory: tmp
    })
    chosenImages = [image('a.png'), image('b.png')]
    const added = (await invoke('reference:addImages', undefined))?.pins.pins ?? []
    const [a, b] = added
    if (a?.type !== 'image' || b?.type !== 'image') throw new Error('two image pins expected')
    const dir = referencesDir(created?.path ?? '')
    expect(await invoke('reference:set', { pins: [b, a] })).toEqual({ pins: [b, a] })
    expect(fs.readdirSync(dir).sort()).toEqual([a.file, b.file].sort())
    expect(await invoke('reference:set', { pins: [b] })).toEqual({ pins: [b] })
    expect(fs.readdirSync(dir)).toEqual([b.file])
    // The file taken out of the folder by hand takes its pin with it on the next read.
    fs.rmSync(path.join(dir, b.file))
    expect(await invoke('reference:get', undefined)).toEqual({ pins: [] })
  })
})

describe('entity export and import (F-9.5)', () => {
  const openProject = (name = 'My Book'): Promise<unknown> =>
    invoke('project:create', { name, format: 'novel', directory: tmp })

  /** Every tag sent to the window as `tag:changed`, in order, as its names. */
  const tagsChanged = (): string[] =>
    vi
      .mocked(fakeWin.webContents.send)
      .mock.calls.filter(([channel]) => channel === 'tag:changed')
      .map(([, payload]) => (payload as { name: string }).name)

  const write = (name: string, text: string): string => {
    const file = path.join(tmp, name)
    fs.writeFileSync(file, text)
    return file
  }

  it('reports NO_PROJECT for all three when nothing is open', async () => {
    await expect(
      invoke('entity:export', { kind: 'character', format: 'json' })
    ).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('entity:importOpen', { kind: 'character' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
    await expect(
      invoke('entity:importCommit', {
        items: [
          {
            id: 'r1',
            record: {
              kind: 'character',
              name: 'Ilse',
              template: 'structured',
              fields: {},
              body: null
            },
            existingId: null,
            action: 'add'
          }
        ]
      })
    ).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('exports one kind to the chosen path, defaulting beside the project folder', async () => {
    await openProject()
    await invoke('entity:create', { kind: 'character', name: 'Mara Vell', fields: { age: '31' } })
    await invoke('entity:create', { kind: 'setting', name: 'Harbour' })
    exportPath = path.join(tmp, 'out', 'characters.json')
    fs.mkdirSync(path.dirname(exportPath), { recursive: true })
    expect(await invoke('entity:export', { kind: 'character', format: 'json' })).toEqual({
      path: exportPath,
      count: 1
    })
    expect(exportAsked).toEqual({ defaultName: 'My Book-characters.json', directory: tmp })
    const written: unknown = JSON.parse(fs.readFileSync(exportPath, 'utf8'))
    expect(written).toEqual({
      format: 'mythscribe-entities',
      version: 1,
      entities: [
        {
          kind: 'character',
          name: 'Mara Vell',
          template: 'structured',
          fields: { age: '31' },
          body: null
        }
      ]
    })
    expect(fs.existsSync(`${exportPath}.tmp`)).toBe(false)
  })

  it('answers null on a cancelled save dialog, and refuses a kind with nothing in it', async () => {
    await openProject()
    await invoke('entity:create', { kind: 'character', name: 'Mara Vell' })
    expect(await invoke('entity:export', { kind: 'character', format: 'csv' })).toBeNull()
    expect(exportAsked).toEqual({ defaultName: 'My Book-characters.csv', directory: tmp })
    await expect(invoke('entity:export', { kind: 'world', format: 'json' })).rejects.toThrowError(
      /^VALIDATION: No world to export/
    )
    expect(fs.readdirSync(tmp).filter((file) => file.endsWith('.csv'))).toEqual([])
  })

  it('writes a CSV of the kind and reads its own file back as a plan', async () => {
    await openProject()
    await invoke('entity:create', {
      kind: 'character',
      name: 'Mara Vell',
      fields: { goals: 'Find the ship, then rest.' }
    })
    const file = path.join(tmp, 'characters.csv')
    expect(await invoke('entity:export', { kind: 'character', format: 'csv', path: file })).toEqual(
      {
        path: file,
        count: 1
      }
    )
    const plan = await invoke('entity:importOpen', { kind: 'character', path: file })
    expect(plan?.source).toEqual({ name: 'characters.csv', format: 'csv' })
    expect(plan?.items.map((item) => [item.record.name, item.action])).toEqual([
      ['Mara Vell', 'merge']
    ])
  })

  it('plans a file against the bible without writing anything, and cancels to null', async () => {
    await openProject()
    const mara = await invoke('entity:create', { kind: 'character', name: 'Mara Vell' })
    entityFilePath = write(
      'library.json',
      JSON.stringify({
        format: 'mythscribe-entities',
        version: 1,
        entities: [
          { kind: 'character', name: 'Ilse', fields: { age: '30' } },
          { kind: 'character', name: 'mara vell', fields: { background: 'Born at sea.' } },
          { kind: 'character', name: 'ILSE' }
        ]
      })
    )
    const plan = await invoke('entity:importOpen', { kind: 'character' })
    expect(plan?.duplicates).toBe(1)
    expect(
      plan?.items.map((item) => [item.id, item.record.name, item.existingId, item.action])
    ).toEqual([
      ['r1', 'Ilse', null, 'add'],
      ['r2', 'mara vell', mara.id, 'merge']
    ])
    expect((await invoke('entity:list', undefined)).map((entity) => entity.name)).toEqual([
      'Mara Vell'
    ])

    entityFilePath = null
    expect(await invoke('entity:importOpen', { kind: 'character' })).toBeNull()
  })

  it('reports an unsupported file, another format, and a bad row as VALIDATION', async () => {
    await openProject()
    await expect(
      invoke('entity:importOpen', { kind: 'character', path: write('a.txt', 'x') })
    ).rejects.toThrowError(/^VALIDATION: Unsupported file type/)
    await expect(
      invoke('entity:importOpen', { kind: 'character', path: write('b.json', '{"format":"x"}') })
    ).rejects.toThrowError(/^VALIDATION: That file is not a MythScribe entity file\./)
    await expect(
      invoke('entity:importOpen', {
        kind: 'character',
        path: write('c.csv', 'kind,name\r\ncreature,Wyrm\r\n')
      })
    ).rejects.toThrowError(/^VALIDATION: Row 1: "creature" is not a kind of entity/)
  })

  it('commits the reviewed rows, rescans once, and announces each created tag', async () => {
    await openProject()
    const mara = await invoke('entity:create', { kind: 'character', name: 'Mara Vell' })
    expect(tagsChanged()).toEqual(['mara-vell'])
    entityFilePath = write(
      'library.json',
      JSON.stringify({
        format: 'mythscribe-entities',
        version: 1,
        entities: [
          { kind: 'character', name: 'Ilse', fields: { age: '30' } },
          { kind: 'character', name: 'Mara Vell', fields: { background: 'Born at sea.' } },
          { kind: 'setting', name: 'Harbour', fields: { atmosphere: 'Salt air' } }
        ]
      })
    )
    const plan = await invoke('entity:importOpen', { kind: 'character' })
    if (!plan) throw new Error('expected a plan')
    const result = await invoke('entity:importCommit', { items: plan.items })
    expect(result).toMatchObject({ added: 2, merged: 1, replaced: 0 })
    expect(result.entities.map((entity) => entity.name)).toEqual(['Ilse', 'Mara Vell', 'Harbour'])
    expect(result.entities.find((entity) => entity.name === 'Mara Vell')).toMatchObject({
      id: mara.id,
      fields: { background: 'Born at sea.' }
    })
    // F-9.4: the two new entities created their tags, and each is announced once.
    expect(tagsChanged()).toEqual(['mara-vell', 'ilse', 'harbour'])
    expect((await invoke('tag:list', undefined)).map((tag) => tag.name)).toEqual([
      'harbour',
      'ilse',
      'mara-vell'
    ])
  })

  it('rolls the import back when a name was taken since the plan was made', async () => {
    await openProject()
    entityFilePath = write(
      'library.json',
      JSON.stringify({
        format: 'mythscribe-entities',
        version: 1,
        entities: [
          { kind: 'character', name: 'Ilse' },
          { kind: 'character', name: 'Tomas' }
        ]
      })
    )
    const plan = await invoke('entity:importOpen', { kind: 'character' })
    if (!plan) throw new Error('expected a plan')
    await invoke('entity:create', { kind: 'character', name: 'tomas' })
    await expect(invoke('entity:importCommit', { items: plan.items })).rejects.toThrowError(
      /^ALREADY_EXISTS: /
    )
    expect((await invoke('entity:list', undefined)).map((entity) => entity.name)).toEqual(['tomas'])
  })
})

describe('automatic mentions (F-4.12)', () => {
  /** The debounce is 1.5 s; 3 s covers it and the scan that follows. */
  const SCAN = 3_000

  const save = (id: string, ...paragraphs: string[]): Promise<unknown> =>
    invoke('document:save', {
      id,
      content: {
        type: 'doc',
        content: paragraphs.map((text) => ({
          type: 'paragraph',
          content: [{ type: 'text', text }]
        }))
      }
    })

  /** The documents named by every `mention:changed` event sent to the window, flattened. */
  const changedNodes = (): string[] =>
    vi
      .mocked(fakeWin.webContents.send)
      .mock.calls.filter(([channel]) => channel === 'mention:changed')
      .flatMap(([, payload]) => (payload as { nodeIds: string[] }).nodeIds)

  /** A project with one scene written; the manuscript's first document id. */
  async function ready(...paragraphs: string[]): Promise<string> {
    await invoke('project:create', { name: 'Mentions', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = manuscriptReadingOrder(rows)[0]
    if (scene === undefined) throw new Error('skeleton not seeded')
    if (paragraphs.length > 0) await save(scene, ...paragraphs)
    return scene
  }

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('mention:listForTag', { tagId: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('mention:listForNode', { nodeId: 'x' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('records where a character tag is named after a save, and tells the window', async () => {
    vi.useFakeTimers()
    try {
      const scene = await ready()
      const rose = await invoke('tag:create', { name: 'Rose', category: 'character' })
      await save(scene, 'Rose waited at the landing.', 'The rose had closed.')
      expect(await invoke('mention:listForNode', { nodeId: scene })).toEqual([])

      await vi.advanceTimersByTimeAsync(SCAN)
      // "rose" the flower is not the character: a character tag must read as a proper noun.
      expect(await invoke('mention:listForNode', { nodeId: scene })).toEqual([
        { tagId: rose.id, nodeId: scene, count: 1, ranges: [[1, 5]] }
      ])
      expect(await invoke('mention:listForTag', { tagId: rose.id })).toEqual([
        { tagId: rose.id, nodeId: scene, count: 1, ranges: [[1, 5]] }
      ])
      expect(changedNodes()).toContain(scene)
    } finally {
      vi.useRealTimers()
    }
  })

  it('matches a tag of any other category whatever the case', async () => {
    vi.useFakeTimers()
    try {
      const scene = await ready()
      const rain = await invoke('tag:create', { name: 'Rain', category: 'tone' })
      await save(scene, 'Rain, then rain, then RAIN.')
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(await invoke('mention:listForNode', { nodeId: scene })).toMatchObject([
        { tagId: rain.id, count: 3 }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('scans the manuscript when a tag is created, without waiting for another save', async () => {
    vi.useFakeTimers()
    try {
      const scene = await ready('Rose waited at the landing.')
      await vi.advanceTimersByTimeAsync(SCAN)
      const rose = await invoke('tag:create', { name: 'Rose', category: 'character' })
      await vi.advanceTimersByTimeAsync(0)
      expect(await invoke('mention:listForTag', { tagId: rose.id })).toMatchObject([
        { nodeId: scene, count: 1 }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('forgets a tag’s mentions the moment its tracking is turned off, and finds them again', async () => {
    vi.useFakeTimers()
    try {
      const scene = await ready('Rose waited at the landing.')
      const rose = await invoke('tag:create', { name: 'Rose', category: 'character' })
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(await invoke('mention:listForTag', { tagId: rose.id })).toHaveLength(1)

      const off = await invoke('tag:update', { id: rose.id, trackMentions: false })
      expect(off.trackMentions).toBe(false)
      expect(await invoke('mention:listForTag', { tagId: rose.id })).toEqual([])
      expect(await invoke('mention:listForNode', { nodeId: scene })).toEqual([])
      expect(changedNodes()).toContain(scene)

      await invoke('tag:update', { id: rose.id, trackMentions: true })
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(await invoke('mention:listForTag', { tagId: rose.id })).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rescans after a rename and forgets everything when the tag is deleted', async () => {
    vi.useFakeTimers()
    try {
      const scene = await ready('Rose waited at the landing.')
      const rose = await invoke('tag:create', { name: 'Rose', category: 'character' })
      await vi.advanceTimersByTimeAsync(SCAN)

      await invoke('tag:update', { id: rose.id, name: 'Marsh' })
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(await invoke('mention:listForTag', { tagId: rose.id })).toEqual([])

      await invoke('tag:update', { id: rose.id, name: 'Rose' })
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(await invoke('mention:listForTag', { tagId: rose.id })).toHaveLength(1)

      await invoke('tag:delete', { id: rose.id })
      expect(await invoke('mention:listForNode', { nodeId: scene })).toEqual([])
      expect(changedNodes()).toContain(scene)
      await expect(invoke('mention:listForTag', { tagId: rose.id })).rejects.toThrowError(
        /^NOT_FOUND: /
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('backfills a manuscript written before the scan existed when the project opens', async () => {
    const project = await invoke('project:create', {
      name: 'Mentions',
      format: 'novel',
      directory: tmp
    })
    const rows = await invoke('tree:list', undefined)
    const scene = manuscriptReadingOrder(rows)[0]
    if (scene === undefined) throw new Error('skeleton not seeded')
    const rose = await invoke('tag:create', { name: 'Rose', category: 'character' })
    await save(scene, 'Rose waited at the landing.')
    await invoke('project:close', undefined)
    // Nothing was scanned: the debounce never ran before the project closed.

    await invoke('project:open', { path: project?.path ?? '' })
    await vi.waitFor(async () => {
      expect(await invoke('mention:listForTag', { tagId: rose.id })).toHaveLength(1)
    })
  })

  it('answers NOT_FOUND for a tag and a node it does not know', async () => {
    await ready()
    await expect(invoke('mention:listForTag', { tagId: 'nope' })).rejects.toThrowError(
      /^NOT_FOUND: /
    )
    await expect(invoke('mention:listForNode', { nodeId: 'nope' })).rejects.toThrowError(
      /^NOT_FOUND: /
    )
  })
})

describe('proposed tags (F-4.12b)', () => {
  /** The mention scan's debounce is 1.5 s, and the proposals ride on it; 3 s covers both. */
  const SCAN = 3_000
  /** Three mid-sentence uses of a name, which is what a proposal takes. */
  const TASH = 'The road bent. Then Tash saw Tash and Tash.'

  const save = (id: string, ...paragraphs: string[]): Promise<unknown> =>
    invoke('document:save', {
      id,
      content: {
        type: 'doc',
        content: paragraphs.map((text) => ({
          type: 'paragraph',
          content: [{ type: 'text', text }]
        }))
      }
    })

  /** Every list sent to the window as `tag:proposedChanged`, in order, as its names. */
  const published = (): string[][] =>
    vi
      .mocked(fakeWin.webContents.send)
      .mock.calls.filter(([channel]) => channel === 'tag:proposedChanged')
      .map(([, payload]) => (payload as { name: string }[]).map((proposal) => proposal.name))

  /** A project with one scene; the manuscript's first document id. */
  async function ready(...paragraphs: string[]): Promise<string> {
    await invoke('project:create', { name: 'Proposed', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = manuscriptReadingOrder(rows)[0]
    if (scene === undefined) throw new Error('skeleton not seeded')
    if (paragraphs.length > 0) await save(scene, ...paragraphs)
    return scene
  }

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('tag:proposed', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('tag:dismissProposed', { name: 'tash' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
    await expect(invoke('tag:dismissedNames', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('publishes the list once a scan has read the saved text', async () => {
    vi.useFakeTimers()
    try {
      const scene = await ready(TASH)
      expect(await invoke('tag:proposed', undefined)).toMatchObject([{ name: 'tash', count: 3 }])
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(published()).toContainEqual(['tash'])
      const before = published().length

      // A save that changes nothing about the names publishes nothing new.
      await save(scene, TASH)
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(published()).toHaveLength(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a proposal the author accepted, and publishes the list without it', async () => {
    vi.useFakeTimers()
    try {
      await ready(TASH)
      await vi.advanceTimersByTimeAsync(SCAN)
      await invoke('tag:create', { name: 'Tash', category: 'character' })
      expect(published().at(-1)).toEqual([])
      expect(await invoke('tag:proposed', undefined)).toEqual([])
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(published().at(-1)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a dismissed name out for good, and tells every window at once', async () => {
    vi.useFakeTimers()
    try {
      const scene = await ready(TASH)
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(await invoke('tag:dismissProposed', { name: 'Tash' })).toEqual([])
      expect(published().at(-1)).toEqual([])
      // F-2.8: the stored names are readable, kebab-cased, for the title offer.
      expect(await invoke('tag:dismissedNames', undefined)).toEqual(['tash'])

      // Another save rescans the document and still proposes nothing: the dismissal is stored.
      await save(scene, TASH, 'Tash rode on with Tash and Tash.')
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(await invoke('tag:proposed', undefined)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes the reopened project’s list again, and nothing while none is open', async () => {
    const project = await invoke('project:create', {
      name: 'Proposed',
      format: 'novel',
      directory: tmp
    })
    const rows = await invoke('tree:list', undefined)
    const scene = manuscriptReadingOrder(rows)[0]
    if (scene === undefined) throw new Error('skeleton not seeded')
    await save(scene, TASH)
    await invoke('project:close', undefined)
    await expect(invoke('tag:proposed', undefined)).rejects.toThrowError(/^NO_PROJECT: /)

    await invoke('project:open', { path: project?.path ?? '' })
    await vi.waitFor(() => {
      expect(published().at(-1)).toEqual(['tash'])
    })
  })
})

describe('tag:loadTemplate (F-4.3)', () => {
  const standard = TAG_TEMPLATES.find((t) => t.id === 'standard-fiction')!

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('tag:loadTemplate', { template: 'fantasy' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('creates the template tags once, then skips them all on a reload', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    const first = await invoke('tag:loadTemplate', { template: 'standard-fiction' })
    expect(first.skipped).toEqual([])
    expect(first.created).toHaveLength(standard.tags.length)
    expect(first.created[0]).toMatchObject({
      name: 'protagonist',
      category: 'character',
      color: DEFAULT_CATEGORY_COLOR.character,
      usageCount: 0
    })
    expect(await invoke('tag:list', undefined)).toHaveLength(standard.tags.length)

    const again = await invoke('tag:loadTemplate', { template: 'standard-fiction' })
    expect(again.created).toEqual([])
    expect(again.skipped).toEqual(standard.tags.map((t) => t.name))
    expect(await invoke('tag:list', undefined)).toHaveLength(standard.tags.length)

    // Contract boundary: an unknown template id never reaches the store.
    const result = await handlerFor('tag:loadTemplate')(undefined, { template: 'western' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
  })
})

describe('custom tag templates (F-4.11)', () => {
  it('saves a bank, or a selection, app-wide, and loads it into another project', async () => {
    await expect(invoke('tagTemplate:save', { name: 'Saga' })).rejects.toThrowError(/^NO_PROJECT: /)
    expect(await invoke('tagTemplate:list', undefined)).toEqual([])
    await invoke('project:create', { name: 'Book one', format: 'novel', directory: tmp })
    const mara = await invoke('tag:create', { name: 'Mara', category: 'character' })
    const young = await invoke('tag:create', {
      name: 'Mara young',
      category: 'character',
      parentId: mara.id
    })
    const mill = await invoke('tag:create', {
      name: 'The mill',
      category: 'setting',
      color: '#123456'
    })

    const whole = await invoke('tagTemplate:save', { name: 'Saga' })
    expect(whole.tags.map((t) => [t.name, t.parent, t.color])).toEqual([
      ['mara', null, DEFAULT_CATEGORY_COLOR.character],
      ['mara-young', 'mara', DEFAULT_CATEGORY_COLOR.character],
      ['the-mill', null, '#123456']
    ])
    const part = await invoke('tagTemplate:save', { name: 'Places', tagIds: [mill.id, young.id] })
    expect(part.tags.map((t) => [t.name, t.parent])).toEqual([
      ['mara-young', null],
      ['the-mill', null]
    ])
    await expect(invoke('tagTemplate:save', { name: 'saga' })).rejects.toThrowError(
      /^ALREADY_EXISTS: /
    )
    await expect(
      invoke('tagTemplate:save', { name: 'Ghost', tagIds: ['nope'] })
    ).rejects.toThrowError(/^NOT_FOUND: /)
    expect((await invoke('tagTemplate:list', undefined)).map((t) => t.name)).toEqual([
      'Places',
      'Saga'
    ])

    await invoke('project:close', undefined)
    await invoke('project:create', { name: 'Book two', format: 'novel', directory: tmp })
    await invoke('tag:create', { name: 'Mara', category: 'character' })
    const loaded = await invoke('tag:loadCustomTemplate', { id: whole.id })
    expect(loaded.skipped).toEqual(['mara'])
    expect(loaded.created.map((t) => t.name)).toEqual(['mara-young', 'the-mill'])
    const bank = await invoke('tag:list', undefined)
    const parentOf = bank.find((t) => t.name === 'mara-young')?.parentId
    expect(bank.find((t) => t.id === parentOf)?.name).toBe('mara')
    expect(bank.find((t) => t.name === 'the-mill')?.color).toBe('#123456')
  })

  it('renames, trims, and deletes a template; a template needs a tag and an unknown id is NOT_FOUND', async () => {
    await invoke('project:create', { name: 'Book', format: 'novel', directory: tmp })
    await invoke('tag:create', { name: 'Mara', category: 'character' })
    await invoke('tag:create', { name: 'Tomas', category: 'character' })
    const saved = await invoke('tagTemplate:save', { name: 'Cast' })
    const renamed = await invoke('tagTemplate:update', { id: saved.id, name: 'Main cast' })
    expect(renamed.name).toBe('Main cast')
    const trimmed = await invoke('tagTemplate:update', { id: saved.id, keep: ['tomas'] })
    expect(trimmed.tags.map((t) => t.name)).toEqual(['tomas'])
    await expect(invoke('tagTemplate:update', { id: saved.id, keep: [] })).rejects.toThrowError(
      /^VALIDATION: /
    )
    await expect(invoke('tag:loadCustomTemplate', { id: 'nope' })).rejects.toThrowError(
      /^NOT_FOUND: /
    )
    expect(await invoke('tagTemplate:delete', { id: saved.id })).toBeNull()
    expect(await invoke('tagTemplate:list', undefined)).toEqual([])
    await expect(invoke('tagTemplate:delete', { id: saved.id })).rejects.toThrowError(
      /^NOT_FOUND: /
    )
  })
})

describe('tag bulk operations and exchange (F-4.9)', () => {
  /** The debounce is 1.5 s; 3 s covers it and the scan that follows. */
  const SCAN = 3_000

  const sent = (channel: string): unknown[] =>
    vi
      .mocked(fakeWin.webContents.send)
      .mock.calls.filter(([name]) => name === channel)
      .map(([, payload]) => payload)

  /** A project with its first scene saved with `text`; the scene id. */
  async function ready(text?: string): Promise<string> {
    await invoke('project:create', { name: 'My Book', format: 'novel', directory: tmp })
    const scene = manuscriptReadingOrder(await invoke('tree:list', undefined))[0]
    if (scene === undefined) throw new Error('skeleton not seeded')
    if (text !== undefined) {
      await invoke('document:save', {
        id: scene,
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
        }
      })
    }
    return scene
  }

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('tag:recolor', { ids: ['x'], color: '#000000' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
    await expect(invoke('tag:deleteMany', { ids: ['x'] })).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('tag:merge', { targetId: 'x', sourceIds: ['y'] })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
    await expect(invoke('tag:aliases', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('tag:export', {})).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('tag:import', {})).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('recolors and deletes several tags, refusing an unknown id and an empty list', async () => {
    await ready()
    const rain = await invoke('tag:create', { name: 'Rain', category: 'tone' })
    const fog = await invoke('tag:create', { name: 'Fog', category: 'tone' })
    expect(
      (await invoke('tag:recolor', { ids: [rain.id, fog.id], color: '#123456' })).map((t) => [
        t.name,
        t.color
      ])
    ).toEqual([
      ['rain', '#123456'],
      ['fog', '#123456']
    ])
    await expect(
      invoke('tag:recolor', { ids: [rain.id, 'missing'], color: '#000000' })
    ).rejects.toThrowError(/^NOT_FOUND: /)
    await expect(invoke('tag:deleteMany', { ids: [rain.id, 'missing'] })).rejects.toThrowError(
      /^NOT_FOUND: /
    )
    expect(await invoke('tag:list', undefined)).toHaveLength(2)
    const empty = await handlerFor('tag:deleteMany')(undefined, { ids: [] })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error.code).toBe('VALIDATION')

    expect(await invoke('tag:deleteMany', { ids: [rain.id, fog.id] })).toBeNull()
    expect(await invoke('tag:list', undefined)).toEqual([])
  })

  it('tells the windows which documents lost mentions when several tags go', async () => {
    vi.useFakeTimers()
    try {
      const scene = await ready('Rose met Kael.')
      const rose = await invoke('tag:create', { name: 'Rose', category: 'character' })
      const kael = await invoke('tag:create', { name: 'Kael', category: 'character' })
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(await invoke('mention:listForNode', { nodeId: scene })).toHaveLength(2)
      vi.mocked(fakeWin.webContents.send).mockClear()
      await invoke('tag:deleteMany', { ids: [rose.id, kael.id] })
      expect(sent('mention:changed')).toEqual([{ nodeIds: [scene] }])
      expect(await invoke('mention:listForNode', { nodeId: scene })).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('merges into the target, announces the moved links, rescans, and stores the aliases', async () => {
    vi.useFakeTimers()
    try {
      const scene = await ready('Rose waited for Rosie.')
      const rose = await invoke('tag:create', { name: 'Rose', category: 'character' })
      const rosie = await invoke('tag:create', { name: 'Rosie', category: 'character' })
      await invoke('documentTag:add', { nodeId: scene, tagId: rosie.id })
      const character = await invoke('entity:create', { kind: 'character', name: 'Rosie' })
      expect(character.tagId).toBe(rosie.id)
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(await invoke('mention:listForTag', { tagId: rosie.id })).toHaveLength(1)
      vi.mocked(fakeWin.webContents.send).mockClear()

      const result = await invoke('tag:merge', { targetId: rose.id, sourceIds: [rosie.id] })
      expect(result.target).toMatchObject({ id: rose.id, name: 'rose', usageCount: 1 })
      expect(result.removedIds).toEqual([rosie.id])
      expect(result.aliases).toEqual({ [rosie.id]: rose.id })
      expect(await invoke('tag:aliases', undefined)).toEqual({ [rosie.id]: rose.id })
      expect(sent('documentTag:changed')).toEqual([{ nodeIds: [scene] }])
      expect(sent('mention:changed')).toContainEqual({ nodeIds: [scene] })
      expect(sent('entity:changed')).toEqual([
        expect.objectContaining({ id: character.id, tagId: rose.id })
      ])
      expect((await invoke('documentTag:list', { nodeId: scene })).map((t) => t.id)).toEqual([
        rose.id
      ])
      await vi.advanceTimersByTimeAsync(SCAN)
      expect(await invoke('mention:listForTag', { tagId: rose.id })).toHaveLength(1)

      await expect(
        invoke('tag:merge', { targetId: rose.id, sourceIds: [rose.id] })
      ).rejects.toThrowError(/^VALIDATION: /)
      await expect(
        invoke('tag:merge', { targetId: rose.id, sourceIds: ['missing'] })
      ).rejects.toThrowError(/^NOT_FOUND: /)
    } finally {
      vi.useRealTimers()
    }
  })

  it('exports the bank beside the project folder and answers null on a cancel', async () => {
    await ready()
    await expect(invoke('tag:export', {})).rejects.toThrowError(/^VALIDATION: No tags to export/)
    await invoke('tag:create', { name: 'Rain', category: 'tone', color: '#123456' })
    expect(await invoke('tag:export', {})).toBeNull()
    expect(exportAsked).toEqual({ defaultName: 'My Book tags.json', directory: tmp })

    exportPath = path.join(tmp, 'bank.json')
    expect(await invoke('tag:export', {})).toEqual({ path: exportPath, count: 1 })
    expect(JSON.parse(fs.readFileSync(exportPath, 'utf8'))).toEqual({
      format: 'mythscribe-tags',
      version: 1,
      tags: [
        { name: 'rain', category: 'tone', color: '#123456', parent: null, trackMentions: true }
      ]
    })
    expect(fs.existsSync(`${exportPath}.tmp`)).toBe(false)
  })

  it('imports new names from the chosen file, skips taken ones, and refuses a bad file', async () => {
    await ready()
    await invoke('tag:create', { name: 'Rain', category: 'tone' })
    expect(await invoke('tag:import', {})).toBeNull()

    tagBankPath = path.join(tmp, 'bank.json')
    fs.writeFileSync(
      tagBankPath,
      JSON.stringify({
        format: 'mythscribe-tags',
        version: 1,
        tags: [
          { name: 'Rain', category: 'custom', color: '#000000' },
          { name: 'Dark Forest', category: 'setting', color: '#abcdef' }
        ]
      })
    )
    const result = await invoke('tag:import', {})
    expect(result?.skipped).toEqual(['rain'])
    expect(result?.created).toMatchObject([
      { name: 'dark-forest', category: 'setting', color: '#abcdef' }
    ])
    expect((await invoke('tag:list', undefined)).map((t) => t.name)).toEqual([
      'dark-forest',
      'rain'
    ])

    const bad = path.join(tmp, 'bad.json')
    fs.writeFileSync(bad, '{"format":"mythscribe-tags","version":1,"tags":[{"name":"x"}]}')
    await expect(invoke('tag:import', { path: bad })).rejects.toThrowError(
      /^VALIDATION: Tag 1 is not valid/
    )
    fs.writeFileSync(bad, '{"format":"mythscribe-tags","version":1,"tags":[]}')
    await expect(invoke('tag:import', { path: bad })).rejects.toThrowError(
      /^VALIDATION: That file has no tags/
    )
    await expect(
      invoke('tag:import', { path: path.join(tmp, 'missing.json') })
    ).rejects.toThrowError(/^VALIDATION: Could not read the file/)
  })
})

describe('documentTag handlers (F-4.4)', () => {
  /** The first seeded scene's id and the id of its chapter (a folder). */
  async function seeded(): Promise<{ scene: string; folder: string; section: string }> {
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    const folder = rows.find((r) => r.kind === 'folder' && r.sectionType === null)
    const section = rows.find((r) => r.sectionType !== null)
    if (!scene || !folder || !section) throw new Error('skeleton not seeded')
    return { scene: scene.id, folder: folder.id, section: section.id }
  }

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('documentTag:list', { nodeId: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('documentTag:add', { nodeId: 'x', tagId: 'y' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
    await expect(invoke('documentTag:remove', { nodeId: 'x', tagId: 'y' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
    await expect(invoke('documentTag:listAll', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('lists every link in the project in one read (F-4.10)', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    const { scene, folder } = await seeded()
    expect(await invoke('documentTag:listAll', undefined)).toEqual([])
    const rain = await invoke('tag:create', { name: 'Rain', category: 'tone' })
    const forest = await invoke('tag:create', { name: 'Dark Forest', category: 'setting' })
    await invoke('documentTag:add', { nodeId: scene, tagId: rain.id })
    await invoke('documentTag:add', { nodeId: scene, tagId: forest.id })
    await invoke('documentTag:add', { nodeId: folder, tagId: rain.id })
    const links = await invoke('documentTag:listAll', undefined)
    expect(links).toHaveLength(3)
    expect(links.filter((link) => link.nodeId === scene)).toEqual([
      { nodeId: scene, tagId: forest.id },
      { nodeId: scene, tagId: rain.id }
    ])
    expect(links.filter((link) => link.nodeId === folder)).toEqual([
      { nodeId: folder, tagId: rain.id }
    ])
    await invoke('documentTag:remove', { nodeId: scene, tagId: rain.id })
    expect(await invoke('documentTag:listAll', undefined)).toHaveLength(2)
  })

  it('links and unlinks a tag, moving the usage count tag:list reports, idempotently', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    const { scene } = await seeded()
    const rain = await invoke('tag:create', { name: 'Rain', category: 'tone' })
    expect(await invoke('documentTag:list', { nodeId: scene })).toEqual([])
    const linked = await invoke('documentTag:add', { nodeId: scene, tagId: rain.id })
    expect(linked).toEqual({ ...rain, usageCount: 1 })
    expect(await invoke('documentTag:add', { nodeId: scene, tagId: rain.id })).toEqual(linked)
    expect(await invoke('documentTag:list', { nodeId: scene })).toEqual([
      { ...linked, source: 'author' }
    ])
    expect(await invoke('tag:list', undefined)).toEqual([linked])
    const unlinked = await invoke('documentTag:remove', { nodeId: scene, tagId: rain.id })
    expect(unlinked).toEqual({ ...rain, usageCount: 0 })
    expect(await invoke('documentTag:remove', { nodeId: scene, tagId: rain.id })).toEqual(unlinked)
    expect(await invoke('documentTag:list', { nodeId: scene })).toEqual([])
    expect(await invoke('tag:list', undefined)).toEqual([unlinked])
  })

  it('links a tag to a folder too (a chapter carries tags, F-4.5)', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    const { folder } = await seeded()
    const rain = await invoke('tag:create', { name: 'Rain', category: 'tone' })
    expect(await invoke('documentTag:list', { nodeId: folder })).toEqual([])
    expect(await invoke('documentTag:add', { nodeId: folder, tagId: rain.id })).toEqual({
      ...rain,
      usageCount: 1
    })
    expect(await invoke('documentTag:list', { nodeId: folder })).toEqual([
      { ...rain, usageCount: 1, source: 'author' }
    ])
  })

  it('surfaces NOT_FOUND and VALIDATION through the envelope', async () => {
    await invoke('project:create', { name: 'Tags', format: 'novel', directory: tmp })
    const { scene, section } = await seeded()
    const rain = await invoke('tag:create', { name: 'Rain', category: 'tone' })
    await expect(invoke('documentTag:list', { nodeId: 'missing' })).rejects.toThrowError(
      /^NOT_FOUND: /
    )
    await expect(invoke('documentTag:list', { nodeId: section })).rejects.toThrowError(
      /^VALIDATION: /
    )
    await expect(
      invoke('documentTag:add', { nodeId: section, tagId: rain.id })
    ).rejects.toThrowError(/^VALIDATION: /)
    await expect(
      invoke('documentTag:add', { nodeId: scene, tagId: 'missing' })
    ).rejects.toThrowError(/^NOT_FOUND: /)
    await expect(
      invoke('documentTag:remove', { nodeId: scene, tagId: 'missing' })
    ).rejects.toThrowError(/^NOT_FOUND: /)
    expect(await invoke('tag:list', undefined)).toEqual([rain])
  })
})

describe('layout:get / layout:set (F-7.2)', () => {
  it('returns the default layout before anything is saved, with no project needed', async () => {
    expect(await invoke('layout:get', undefined)).toEqual(defaultLayout())
  })

  it('persists a layout so get returns it, also from a fresh store over the same file', async () => {
    const next = {
      sidebar: { open: false, size: 0.3, tab: 'manuscript' as const },
      notes: { open: true, size: 0.4 },
      tags: { open: false, size: 0.2 },
      assistant: { open: false, size: 0.3 },
      references: { open: false, size: 0.22 },
      floating: defaultFloating(),
      dock: { columns: defaultDock() }
    }
    expect(await invoke('layout:set', next)).toEqual(next)
    expect(await invoke('layout:get', undefined)).toEqual(next)
    const reread = new AppStateStore(path.join(tmp, 'userData', 'app-state.json')).get()
    expect(reread.layout).toEqual(next)
    expect(reread.recents).toEqual([])
  })

  it('refuses out-of-range or malformed layouts with VALIDATION and keeps the stored one', async () => {
    const stored = {
      sidebar: { open: true, size: 0.2, tab: 'manuscript' as const },
      notes: { open: false, size: 0.25 },
      tags: { open: false, size: 0.2 },
      assistant: { open: false, size: 0.3 },
      references: { open: false, size: 0.22 },
      floating: defaultFloating(),
      dock: { columns: defaultDock() }
    }
    await invoke('layout:set', stored)
    const raw = handlerFor('layout:set')
    for (const bad of [
      { ...stored, sidebar: { open: true, size: 0.5, tab: 'manuscript' as const } },
      { ...stored, notes: { open: true, size: 0.1 } },
      { sidebar: { open: true, size: 0.2, tab: 'manuscript' as const } },
      { ...stored, sidebar: { open: 'yes', size: 0.2 } },
      null
    ]) {
      const result = await raw(undefined, bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect(await invoke('layout:get', undefined)).toEqual(stored)
  })

  it('keeps the recents when the layout changes and vice versa', async () => {
    const created = await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    const next = {
      sidebar: { open: true, size: 0.3, tab: 'manuscript' as const },
      notes: { open: true, size: 0.3 },
      tags: { open: false, size: 0.2 },
      assistant: { open: false, size: 0.3 },
      references: { open: false, size: 0.22 },
      floating: defaultFloating(),
      dock: { columns: defaultDock() }
    }
    await invoke('layout:set', next)
    const list = await invoke('recents:list', undefined)
    expect(list.map((r) => r.path)).toEqual([created?.path])
    await invoke('recents:remove', { path: created?.path ?? '' })
    expect(await invoke('layout:get', undefined)).toEqual(next)
  })

  // The spec's "editor keeps at least 30 %" is enforced jointly here, not only by the renderer's
  // clampForEditorMin: each size may be in range while both together squeeze the editor.
  it('refuses a layout that leaves the editor under its minimum even if each panel is individually in range', async () => {
    const bothMaxed = {
      sidebar: { open: true, size: 0.35, tab: 'manuscript' as const },
      notes: { open: true, size: 0.5 },
      tags: { open: false, size: 0.2 },
      assistant: { open: false, size: 0.3 },
      references: { open: false, size: 0.22 },
      floating: defaultFloating(),
      dock: { columns: defaultDock() }
    }
    const raw = handlerFor('layout:set')
    const result = await raw(undefined, bothMaxed)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    // A closed panel does not count.
    const notesClosed = { ...bothMaxed, notes: { open: false, size: 0.5 } }
    expect(await invoke('layout:set', notesClosed)).toEqual(notesClosed)
  })

  it('layout:get normalizes an over-wide layout from a hand-edited app-state file', async () => {
    const file = path.join(tmp, 'userData', 'app-state.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        recents: [],
        layout: {
          sidebar: { open: true, size: 0.35, tab: 'manuscript' as const },
          notes: { open: true, size: 0.5 },
          tags: { open: false, size: 0.2 },
          assistant: { open: false, size: 0.3 },
          references: { open: false, size: 0.22 },
          floating: defaultFloating(),
          dock: { columns: defaultDock() }
        }
      })
    )
    const got = await invoke('layout:get', undefined)
    expect(got.sidebar.size).toBe(0.35)
    expect(got.notes.size).toBeCloseTo(0.35, 9)
  })
})

describe('window:close', () => {
  it('closes the project and every window', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    expect(manager.current()).not.toBeNull()
    await invoke('window:close', undefined)
    expect(manager.current()).toBeNull()
    expect(fakeWin.close).toHaveBeenCalledTimes(1)
    expect(fakeWin.webContents.send).toHaveBeenLastCalledWith('project:changed', null)
  })

  it('closes the windows even when no project is open', async () => {
    await invoke('window:close', undefined)
    expect(fakeWin.close).toHaveBeenCalledTimes(1)
  })

  it('skips windows that are already destroyed', async () => {
    fakeWin.isDestroyed = () => true
    await invoke('window:close', undefined)
    expect(fakeWin.close).not.toHaveBeenCalled()
  })
})

describe('window:setFullScreen (F-6.1)', () => {
  it('asks the first live window and answers the state it reports', async () => {
    expect(await invoke('window:setFullScreen', { on: true })).toEqual({ on: true })
    expect(fakeWin.setFullScreen).toHaveBeenLastCalledWith(true)
    expect(await invoke('window:setFullScreen', { on: false })).toEqual({ on: false })
    expect(fakeWin.setFullScreen).toHaveBeenLastCalledWith(false)
  })

  it('answers what the window reports, not what was asked, when the window manager refuses', async () => {
    fakeWin.isFullScreen = () => false
    expect(await invoke('window:setFullScreen', { on: true })).toEqual({ on: false })
    expect(fakeWin.setFullScreen).toHaveBeenCalledWith(true)
  })

  it('skips a destroyed window and answers windowed', async () => {
    fakeWin.isDestroyed = () => true
    expect(await invoke('window:setFullScreen', { on: true })).toEqual({ on: false })
    expect(fakeWin.setFullScreen).not.toHaveBeenCalled()
  })

  it('rejects a malformed input', async () => {
    const result = await handlerFor('window:setFullScreen')(null, { on: 'yes' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
  })
})

describe('view (F-7.10)', () => {
  /** The settings as they stand in app-state.json, read back through a fresh store. */
  const storedView = (): ViewSettings =>
    new AppStateStore(path.join(tmp, 'userData', 'app-state.json')).get().view

  it('answers the installed defaults before anything is changed', async () => {
    expect(await invoke('view:get', undefined)).toEqual({
      editorZoom: 1,
      uiScale: 'medium',
      pageEdges: true,
      theme: 'dark',
      customThemes: []
    })
  })

  it('steps the document zoom in and out and persists it, leaving the window alone', async () => {
    expect(await invoke('view:zoomDocument', { step: 'in' })).toEqual({
      editorZoom: 1.1,
      uiScale: 'medium',
      pageEdges: true,
      theme: 'dark',
      customThemes: []
    })
    expect(storedView().editorZoom).toBe(1.1)
    // The document zoom is the renderer's to apply; the window keeps the interface size.
    expect(fakeWin.webContents.setZoomFactor).not.toHaveBeenCalled()
    expect((await invoke('view:zoomDocument', { step: 'in' })).editorZoom).toBe(1.25)
    expect((await invoke('view:zoomDocument', { step: 'out' })).editorZoom).toBe(1.1)
    expect(storedView().editorZoom).toBe(1.1)
  })

  it('resets to 100 % and stops at the ends of the table', async () => {
    for (let i = 0; i < 12; i++) await invoke('view:zoomDocument', { step: 'in' })
    expect((await invoke('view:zoomDocument', { step: 'in' })).editorZoom).toBe(2)
    expect((await invoke('view:zoomDocument', { step: 'reset' })).editorZoom).toBe(1)
    expect(storedView().editorZoom).toBe(1)
    for (let i = 0; i < 12; i++) await invoke('view:zoomDocument', { step: 'out' })
    expect((await invoke('view:zoomDocument', { step: 'out' })).editorZoom).toBe(0.67)
    expect(storedView().editorZoom).toBe(0.67)
  })

  it('applies the interface size to every live window and persists it', async () => {
    expect(await invoke('view:setUiScale', { scale: 'large' })).toEqual({
      editorZoom: 1,
      uiScale: 'large',
      pageEdges: true,
      theme: 'dark',
      customThemes: []
    })
    expect(fakeWin.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.15)
    expect(storedView().uiScale).toBe('large')
    await invoke('view:setUiScale', { scale: 'small' })
    expect(fakeWin.webContents.setZoomFactor).toHaveBeenLastCalledWith(0.9)
    expect(storedView().uiScale).toBe('small')
  })

  it('keeps the two settings apart: the size does not disturb the zoom', async () => {
    await invoke('view:zoomDocument', { step: 'in' })
    expect(await invoke('view:setUiScale', { scale: 'small' })).toEqual({
      editorZoom: 1.1,
      uiScale: 'small',
      pageEdges: true,
      theme: 'dark',
      customThemes: []
    })
    expect(await invoke('view:zoomDocument', { step: 'reset' })).toEqual({
      editorZoom: 1,
      uiScale: 'small',
      pageEdges: true,
      theme: 'dark',
      customThemes: []
    })
  })

  it('skips a destroyed window but still records the size', async () => {
    fakeWin.isDestroyed = () => true
    expect((await invoke('view:setUiScale', { scale: 'large' })).uiScale).toBe('large')
    expect(fakeWin.webContents.setZoomFactor).not.toHaveBeenCalled()
    expect(storedView().uiScale).toBe('large')
  })

  it('persists the page edges and leaves the window and the other two alone (F-7.11)', async () => {
    await invoke('view:zoomDocument', { step: 'in' })
    expect(await invoke('view:setPageEdges', { on: false })).toEqual({
      editorZoom: 1.1,
      uiScale: 'medium',
      pageEdges: false,
      theme: 'dark',
      customThemes: []
    })
    expect(storedView().pageEdges).toBe(false)
    expect(fakeWin.webContents.setZoomFactor).not.toHaveBeenCalled()
    expect((await invoke('view:setPageEdges', { on: true })).pageEdges).toBe(true)
    expect(storedView()).toEqual({
      editorZoom: 1.1,
      uiScale: 'medium',
      pageEdges: true,
      theme: 'dark',
      customThemes: []
    })
    const bad = await handlerFor('view:setPageEdges')(null, { on: 'yes' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('VALIDATION')
  })

  it('switches between the free themes and paints the window behind them (F-7.8)', async () => {
    const view = await invoke('view:setTheme', { theme: 'light' })
    expect(view.theme).toBe('light')
    expect(storedView().theme).toBe('light')
    expect(fakeWin.setBackgroundColor).toHaveBeenLastCalledWith('#eeeef0')
    expect((await invoke('view:setTheme', { theme: 'high-contrast' })).theme).toBe('high-contrast')
    expect(fakeWin.setBackgroundColor).toHaveBeenLastCalledWith('#000000')
  })

  it('refuses the Supporter themes without a license, and an id that names nothing (F-7.8)', async () => {
    const codes = async (channel: Channel, input: unknown): Promise<string | null> => {
      const result = await handlerFor(channel)(null, input)
      return result.ok ? null : result.error.code
    }
    expect(await codes('view:setTheme', { theme: 'sepia' })).toBe('VALIDATION')
    expect(await codes('view:setTheme', { theme: 'custom-gone' })).toBe('VALIDATION')
    expect(await codes('view:setTheme', { theme: 'neon' })).toBe('VALIDATION')
    const theme = { name: 'Night', base: 'dark', colors: builtInTheme('dark').colors }
    expect(await codes('view:saveCustomTheme', { theme })).toBe('VALIDATION')
    expect(storedView().theme).toBe('dark')
    expect(storedView().customThemes).toEqual([])
  })

  it('rejects a step and a size that are not one of the named ones', async () => {
    const step = await handlerFor('view:zoomDocument')(null, { step: 'bigger' })
    expect(step.ok).toBe(false)
    if (!step.ok) expect(step.error.code).toBe('VALIDATION')
    const scale = await handlerFor('view:setUiScale')(null, { scale: 'enormous' })
    expect(scale.ok).toBe(false)
    if (!scale.ok) expect(scale.error.code).toBe('VALIDATION')
  })
})

describe('window:close-cancelled (F-8.3)', () => {
  it('tells main the close was abandoned and leaves the project and windows alone', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    expect(await invoke('window:close-cancelled', undefined)).toBeNull()
    expect(onCloseCancelled).toHaveBeenCalledTimes(1)
    expect(manager.current()).not.toBeNull()
    expect(fakeWin.close).not.toHaveBeenCalled()
  })
})

describe('menu:edit / menu:openExternal (F-7.1)', () => {
  it('runs the edit command on the focused window', async () => {
    const other: ClosableWindow = {
      ...fakeWin,
      webContents: { ...fakeWin.webContents, paste: vi.fn() }
    }
    focusedWindow = other
    expect(await invoke('menu:edit', { role: 'paste' })).toBeNull()
    expect(other.webContents.paste).toHaveBeenCalledTimes(1)
    expect(fakeWin.webContents.paste).not.toHaveBeenCalled()
  })

  it('falls back to the first live window when none has the focus', async () => {
    await invoke('menu:edit', { role: 'undo' })
    expect(fakeWin.webContents.undo).toHaveBeenCalledTimes(1)
    fakeWin.isDestroyed = () => true
    await invoke('menu:edit', { role: 'redo' })
    expect(fakeWin.webContents.redo).not.toHaveBeenCalled()
  })

  it('rejects a role that is not an edit command', async () => {
    const result = await handlerFor('menu:edit')(null, { role: 'selectAll' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
  })

  it('opens documentation on mythscribe.app and refuses every other host', async () => {
    expect(await invoke('menu:openExternal', { url: 'https://mythscribe.app/docs/' })).toBeNull()
    expect(openExternal).toHaveBeenCalledWith('https://mythscribe.app/docs/')
    for (const url of ['https://example.com/', 'http://mythscribe.app/', 'file:///etc/passwd']) {
      const result = await handlerFor('menu:openExternal')(null, { url })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})

describe('dictionary:* / spellcheck:replace (F-3.11)', () => {
  it('answers no words for a new project and refuses without one', async () => {
    const closed = await handlerFor('dictionary:get')(null, undefined)
    expect(closed.ok).toBe(false)
    if (!closed.ok) expect(closed.error.code).toBe('NO_PROJECT')
    await invoke('project:create', { name: 'Words', format: 'novel', directory: tmp })
    expect(await invoke('dictionary:get', undefined)).toEqual({ words: [], notNames: [] })
  })

  it('adds a word, keeps the list sorted, and syncs the spellchecker to the stored list', async () => {
    await invoke('project:create', { name: 'Words', format: 'novel', directory: tmp })
    spellSync.mockClear()
    expect(await invoke('dictionary:add', { word: ' Zorvath ' })).toEqual({
      words: ['Zorvath'],
      notNames: []
    })
    expect(await invoke('dictionary:add', { word: 'Mara' })).toEqual({
      words: ['Mara', 'Zorvath'],
      notNames: []
    })
    expect(spellSync.mock.calls).toEqual([[['Zorvath']], [['Mara', 'Zorvath']]])
    // A word already there stores nothing new and answers the same list.
    expect(await invoke('dictionary:add', { word: 'Mara' })).toEqual({
      words: ['Mara', 'Zorvath'],
      notNames: []
    })
    expect(await invoke('dictionary:get', undefined)).toEqual({
      words: ['Mara', 'Zorvath'],
      notNames: []
    })
  })

  it('refuses an empty word and a phrase', async () => {
    await invoke('project:create', { name: 'Words', format: 'novel', directory: tmp })
    for (const word of ['   ', 'salt marsh']) {
      const result = await handlerFor('dictionary:add')(null, { word })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect(await invoke('dictionary:get', undefined)).toEqual({ words: [], notNames: [] })
  })

  it('removes a word and syncs the spellchecker without it', async () => {
    await invoke('project:create', { name: 'Words', format: 'novel', directory: tmp })
    await invoke('dictionary:add', { word: 'Mara' })
    await invoke('dictionary:add', { word: 'Zorvath' })
    spellSync.mockClear()
    expect(await invoke('dictionary:remove', { word: 'Mara' })).toEqual({
      words: ['Zorvath'],
      notNames: []
    })
    expect(spellSync).toHaveBeenLastCalledWith(['Zorvath'])
    // A word that is not there changes nothing.
    expect(await invoke('dictionary:remove', { word: 'Nobody' })).toEqual({
      words: ['Zorvath'],
      notNames: []
    })
  })

  it('syncs the spellchecker to each project as it opens and to nothing on close', async () => {
    const a = await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    expect(spellSync).toHaveBeenLastCalledWith([])
    await invoke('dictionary:add', { word: 'Mara' })
    await invoke('project:create', { name: 'B', format: 'novel', directory: tmp })
    expect(spellSync).toHaveBeenLastCalledWith([])
    await invoke('project:open', { path: a?.path ?? '' })
    expect(spellSync).toHaveBeenLastCalledWith(['Mara'])
    await invoke('project:close', undefined)
    expect(spellSync).toHaveBeenLastCalledWith([])
  })

  it('accepts the story names with the dictionary and follows renames and deletions (F-3.14)', async () => {
    await invoke('project:create', { name: 'Names', format: 'novel', directory: tmp })
    await invoke('dictionary:add', { word: 'Zorvath' })
    const mara = await invoke('entity:create', { kind: 'character', name: 'Mara Voss' })
    // The entity's own words and its tag's (F-9.4: "mara-voss").
    expect(spellSync).toHaveBeenLastCalledWith(['Zorvath', 'mara', 'Mara', 'voss', 'Voss'])
    const tag = await invoke('tag:create', { name: 'rose-marsh', category: 'setting' })
    expect(spellSync.mock.lastCall?.[0]).toEqual(expect.arrayContaining(['rose', 'marsh', 'Mara']))
    // The stored dictionary holds only what the author added.
    expect(await invoke('dictionary:get', undefined)).toEqual({ words: ['Zorvath'], notNames: [] })

    await invoke('entity:update', { id: mara?.id ?? '', name: 'Maren Voss' })
    const renamed = spellSync.mock.lastCall?.[0] ?? []
    expect(renamed).toContain('Maren')
    expect(renamed).not.toContain('Mara')

    await invoke('tag:delete', { id: tag?.id ?? '' })
    expect(spellSync.mock.lastCall?.[0]).not.toContain('marsh')
    await invoke('entity:delete', { id: mara?.id ?? '' })
    expect(spellSync.mock.lastCall?.[0]).not.toContain('Maren')

    await invoke('project:close', undefined)
    expect(spellSync).toHaveBeenLastCalledWith([])
  })

  it('remembers a word as not a name, lower-cased and once (F-3.14)', async () => {
    await invoke('project:create', { name: 'Names', format: 'novel', directory: tmp })
    spellSync.mockClear()
    expect(await invoke('dictionary:notName', { word: 'Marta' })).toEqual({
      words: [],
      notNames: ['marta']
    })
    expect(await invoke('dictionary:notName', { word: 'MARTA' })).toEqual({
      words: [],
      notNames: ['marta']
    })
    await invoke('dictionary:add', { word: 'Zorvath' })
    expect(await invoke('dictionary:get', undefined)).toEqual({
      words: ['Zorvath'],
      notNames: ['marta']
    })
    // Dismissing a near name says nothing to the spellchecker; the added word does.
    expect(spellSync.mock.calls).toEqual([[['Zorvath']]])
  })

  it('replaces the misspelled word on the focused window', async () => {
    const other: ClosableWindow = {
      ...fakeWin,
      webContents: { ...fakeWin.webContents, replaceMisspelling: vi.fn() }
    }
    focusedWindow = other
    expect(await invoke('spellcheck:replace', { word: 'receive' })).toBeNull()
    expect(other.webContents.replaceMisspelling).toHaveBeenCalledWith('receive')
    expect(fakeWin.webContents.replaceMisspelling).not.toHaveBeenCalled()
  })

  it('falls back to the first live window, and does nothing when it is gone', async () => {
    await invoke('spellcheck:replace', { word: 'receive' })
    expect(fakeWin.webContents.replaceMisspelling).toHaveBeenCalledTimes(1)
    fakeWin.isDestroyed = () => true
    await invoke('spellcheck:replace', { word: 'relieve' })
    expect(fakeWin.webContents.replaceMisspelling).toHaveBeenCalledTimes(1)
  })
})

/**
 * account:getCredits and account:buyCredits (F-15.3): unlike the other account channels (a plain
 * forward to the service, tested at that layer), `account:buyCredits` adds its own gate
 * (`isCheckoutUrl`) before ever calling `openExternal` — that gate is what stops the channel from
 * becoming a general "open any URL" hole (a wrong or tampered checkout URL from the Worker), so
 * it is tested here against the real handler and a real, signed-in `AccountService`.
 */
describe('account:getCredits / account:buyCredits (F-15.3) and the license (F-15.9)', () => {
  const SESSION: CloudSession = {
    token: 'tok-cloud-1',
    email: 'author@example.com',
    userId: 'u-cloud-1'
  }
  const SUPPORTER = { variantId: 'supporter', priceCents: 3900 }
  const NOW = Date.now()
  const LICENSE_TOKEN = signLicense({
    v: 1,
    sub: SESSION.userId,
    iat: NOW,
    exp: NOW + LICENSE_GRACE_MS
  })
  let credits: ReturnType<typeof vi.fn<(token: string) => Promise<CreditsResult>>>
  let checkout: ReturnType<
    typeof vi.fn<(token: string, variantId: string) => Promise<CheckoutResult>>
  >
  let license: ReturnType<typeof vi.fn<(token: string) => Promise<LicenseResult>>>
  let creditsInvoke: Invoke
  let creditsHandlerFor: (
    channel: Channel
  ) => (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>

  beforeEach(() => {
    credits = vi.fn(() =>
      Promise.resolve({
        balanceMicros: 100,
        spend: [],
        periodDays: USAGE_PERIOD_DAYS,
        periodSpend: [],
        periodFirstChargeAt: null,
        packs: []
      })
    )
    checkout = vi.fn(() => Promise.reject(new Error('set a checkout answer per test')))
    // F-15.9: no license and nothing on sale unless a test says so.
    license = vi.fn(() => Promise.resolve({ token: null, product: null }))
    const cloudKeyStore = new AiKeyStore(
      path.join(tmp, 'userData', 'ai-keys-credits.json'),
      safe,
      'win32'
    )
    cloudKeyStore.setKey('cloudSession', JSON.stringify(SESSION))
    const cloudClient: CloudAuthClient = {
      start: () => Promise.reject(new Error('no cloud in these tests')),
      poll: () => Promise.reject(new Error('no cloud in these tests')),
      me: () => Promise.reject(new Error('no cloud in these tests')),
      signOut: () => Promise.resolve(),
      credits,
      checkout,
      license
    }
    const appState = new AppStateStore(path.join(tmp, 'userData', 'app-state-credits.json'))
    const account = new AccountService({
      client: cloudClient,
      keyStore: cloudKeyStore,
      appState,
      licensePublicKey: LICENSE_PUBLIC_JWK,
      onChange: () => {},
      onSupporterChange: () => {}
    })
    const neverProvider: Provider = {
      id: 'openai',
      resolveModel: () => 'gpt-fake',
      complete: () => Promise.reject(new Error('not used by these tests')),
      stream: async function* () {},
      testConnection: () => Promise.reject(new Error('not used by these tests'))
    }
    registerHandlers({
      manager,
      appState,
      keyStore: cloudKeyStore,
      ai: new AiProviderRegistry(
        cloudKeyStore,
        () => appState.get().models,
        () => neverProvider
      ),
      account,
      updates: unsupportedUpdates(appState),
      diagnostics: localDiagnostics(appState),
      backups: localBackups(appState),
      dialogs,
      windows: () => [fakeWin],
      focusedWindow: () => focusedWindow,
      spellDictionary: { sync: spellSync },
      openExternal,
      openPath,
      onCloseCancelled
    })
    // A second registration on the shared `ipcMain.handle` mock: rebuild the map from every call
    // so far, which leaves the last registration (this one) as the one these tests invoke.
    const handlers = new Map<
      string,
      (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>
    >()
    for (const [channel, fn] of vi.mocked(ipcMain.handle).mock.calls) {
      handlers.set(channel, fn as (event: unknown, raw: unknown) => Promise<IpcResult<unknown>>)
    }
    creditsHandlerFor = (channel) => {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`No handler registered for ${channel}`)
      return fn
    }
    creditsInvoke = async (channel, input) => {
      const fn = handlers.get(channel)
      if (!fn) throw new Error(`No handler registered for ${channel}`)
      const result = await fn(undefined, input)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.data as Output<typeof channel>
    }
  })

  it('answers the signed-in account balance', async () => {
    const body: CreditsResult = {
      balanceMicros: 2_500_000,
      spend: [{ feature: 'ghostText', micros: 900, requests: 1, tokens: 100 }],
      periodDays: USAGE_PERIOD_DAYS,
      periodSpend: [{ feature: 'ghostText', micros: 400, requests: 1, tokens: 50 }],
      periodFirstChargeAt: 1_758_000_000_000,
      packs: [{ variantId: 'pack-5', priceCents: 500 }]
    }
    credits.mockResolvedValueOnce(body)
    expect(await creditsInvoke('account:getCredits', undefined)).toEqual(body)
    expect(credits).toHaveBeenCalledWith(SESSION.token)
  })

  it('opens the checkout URL the Worker built for a known pack', async () => {
    const url = 'https://mythscribe.lemonsqueezy.com/buy/five?checkout[custom][user_id]=u-cloud-1'
    checkout.mockResolvedValueOnce({ url })
    expect(await creditsInvoke('account:buyCredits', { variantId: 'pack-5' })).toBeNull()
    expect(checkout).toHaveBeenCalledWith(SESSION.token, 'pack-5')
    expect(openExternal).toHaveBeenCalledWith(url)
  })

  it('refuses to open a URL that is not a Lemon Squeezy checkout', async () => {
    checkout.mockResolvedValueOnce({ url: 'https://evil.example.com/buy/five' })
    const result = await creditsHandlerFor('account:buyCredits')(null, { variantId: 'pack-5' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('answers the license the Worker signed, and stores an accent while it holds (F-15.9)', async () => {
    license.mockResolvedValue({ token: LICENSE_TOKEN, product: SUPPORTER })
    const refreshed = await creditsInvoke('account:refreshSupporter', undefined)
    expect(refreshed).toMatchObject({ licensed: true, offline: false, accent: 'default' })
    expect(license).toHaveBeenCalledWith(SESSION.token)
    // The cached status is the same answer, without asking the Worker again.
    const calls = license.mock.calls.length
    expect(await creditsInvoke('account:getSupporter', undefined)).toEqual(refreshed)
    expect(license).toHaveBeenCalledTimes(calls)

    const accented = await creditsInvoke('account:setAccent', { accent: 'ember' })
    expect(accented.accent).toBe('ember')
    expect((await creditsInvoke('account:getSupporter', undefined)).accent).toBe('ember')
  })

  it('unlocks Sepia and custom themes with the license (F-7.8)', async () => {
    license.mockResolvedValue({ token: LICENSE_TOKEN, product: SUPPORTER })
    await creditsInvoke('account:refreshSupporter', undefined)
    expect((await creditsInvoke('view:setTheme', { theme: 'sepia' })).theme).toBe('sepia')

    const colors = { ...builtInTheme('light').colors, bg: '#102030' }
    const created = await creditsInvoke('view:saveCustomTheme', {
      theme: { name: ' Harbour ', base: 'light', colors }
    })
    const [harbour] = created.customThemes
    expect(harbour).toMatchObject({ name: 'Harbour', base: 'light', colors })
    expect(harbour?.id).toMatch(/^custom-[a-z0-9]{12}$/)
    // Saving makes it current.
    expect(created.theme).toBe(harbour?.id)

    const id = harbour?.id ?? ''
    const edited = await creditsInvoke('view:saveCustomTheme', {
      theme: { id, name: 'Harbour at night', base: 'dark', colors }
    })
    expect(edited.customThemes).toEqual([{ id, name: 'Harbour at night', base: 'dark', colors }])

    // Deleting the current one falls back to its base.
    const deleted = await creditsInvoke('view:deleteCustomTheme', { id })
    expect(deleted).toMatchObject({ theme: 'dark', customThemes: [] })
    const again = await creditsHandlerFor('view:deleteCustomTheme')(null, { id })
    expect(again.ok).toBe(false)
  })

  it('keeps at most eight custom themes (F-7.8)', async () => {
    license.mockResolvedValue({ token: LICENSE_TOKEN, product: SUPPORTER })
    await creditsInvoke('account:refreshSupporter', undefined)
    const theme = { name: 'T', base: 'dark' as const, colors: builtInTheme('dark').colors }
    for (let i = 0; i < CUSTOM_THEMES_MAX; i++) {
      await creditsInvoke('view:saveCustomTheme', { theme })
    }
    const over = await creditsHandlerFor('view:saveCustomTheme')(null, { theme })
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error.code).toBe('VALIDATION')
    expect((await creditsInvoke('view:get', undefined)).customThemes).toHaveLength(8)
  })

  it('refuses an accent without a license (F-15.9)', async () => {
    const result = await creditsHandlerFor('account:setAccent')(null, { accent: 'ember' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    // The default accent is every install's, so it is not refused.
    expect((await creditsInvoke('account:setAccent', { accent: 'default' })).accent).toBe('default')
  })

  it('opens the Supporter checkout, and nothing that is not one (F-15.9)', async () => {
    license.mockResolvedValue({ token: null, product: SUPPORTER })
    await creditsInvoke('account:refreshSupporter', undefined)
    const url = 'https://mythscribe.lemonsqueezy.com/buy/supporter?checkout[custom][user_id]=u1'
    checkout.mockResolvedValueOnce({ url })
    expect(await creditsInvoke('account:buySupporter', undefined)).toBeNull()
    expect(checkout).toHaveBeenCalledWith(SESSION.token, SUPPORTER.variantId)
    expect(openExternal).toHaveBeenCalledWith(url)

    checkout.mockResolvedValueOnce({ url: 'https://evil.example.com/buy/supporter' })
    const result = await creditsHandlerFor('account:buySupporter')(null, undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})

describe('updates handlers (F-15.7)', () => {
  it('forwards the state of a build that cannot update itself', async () => {
    expect(await invoke('updates:getState', undefined)).toEqual({
      currentVersion: '0.0.0',
      channel: 'stable',
      autoCheck: true,
      status: { state: 'unsupported', reason: UNSUPPORTED_UPDATES },
      installedNotes: null,
      unseenNotes: false
    })
  })

  it('stores the channel the author picked, which the next call answers', async () => {
    const state = await invoke('updates:setChannel', { channel: 'beta' })
    expect(state.channel).toBe('beta')
    expect((await invoke('updates:getState', undefined)).channel).toBe('beta')
  })

  it('refuses to install while a project is open, and says what to do first', async () => {
    await invoke('project:create', { name: 'Updating', format: 'novel', directory: tmp })
    const result = await handlerFor('updates:install')(undefined, undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION')
      expect(result.error.message).toContain('Close the project first')
    }
  })

  it('refuses to install with nothing downloaded, once the project is closed', async () => {
    const result = await handlerFor('updates:install')(undefined, undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
  })
})

describe('backups handlers (F-8.4)', () => {
  const backupsRoot = (): string => path.join(tmp, 'backups')

  it('backs up now, lists the backup, and restores it as a new project beside the original', async () => {
    const created = await invoke('project:create', {
      name: 'Ridge',
      format: 'novel',
      directory: tmp
    })
    const state = await invoke('backups:now', undefined)
    expect(state.folder).toBe(backupsRoot())
    expect(state.backups).toHaveLength(1)
    const file = state.backups[0]?.file ?? ''
    expect(file.startsWith(backupsRoot())).toBe(true)

    const restored = await invoke('backups:restore', { file })
    expect(restored?.id).toBe(created?.id)
    expect(path.dirname(restored?.path ?? '')).toBe(tmp)
    expect(path.basename(restored?.path ?? '')).toMatch(/^Ridge \(restored .+\)\.mythscribe$/)
    expect(manager.current()?.path).toBe(restored?.path)
    // The original is untouched and still opens.
    expect(fs.existsSync(path.join(created?.path ?? '', 'project.db'))).toBe(true)
  })

  it("refuses a file that is not one of the open project's backups", async () => {
    await invoke('project:create', { name: 'Ridge', format: 'novel', directory: tmp })
    const stray = path.join(tmp, 'Ridge 2026-10-04 120000.zip')
    fs.writeFileSync(stray, 'x')
    await expect(invoke('backups:restore', { file: stray })).rejects.toThrow(/NOT_FOUND/)
  })

  it('restores from a chosen file with no project open, and refuses a zip that is not a backup', async () => {
    await invoke('project:create', { name: 'Ridge', format: 'novel', directory: tmp })
    const { backups } = await invoke('backups:now', undefined)
    await invoke('project:close', undefined)
    expect(await invoke('backups:restore', {})).toBeNull()
    backupFile = backups[0]?.file ?? null
    expect(await invoke('backups:restore', {})).toBeNull()
    const into = path.join(tmp, 'restored-here')
    fs.mkdirSync(into)
    restoreParent = into
    const restored = await invoke('backups:restore', {})
    expect(path.dirname(restored?.path ?? '')).toBe(into)

    const notBackup = path.join(tmp, 'photos.zip')
    fs.writeFileSync(notBackup, 'not a zip')
    backupFile = notBackup
    await expect(invoke('backups:restore', {})).rejects.toThrow(
      'VALIDATION: This file is not a MythScribe backup'
    )
  })

  it('changes settings, picks a folder from the dialog, and reveals it', async () => {
    const changed = await invoke('backups:setSettings', { patch: { keep: 20, onClose: false } })
    expect(changed.settings).toMatchObject({ keep: 20, onClose: false, enabled: true })
    expect((await invoke('backups:chooseFolder', undefined)).folder).toBe(backupsRoot())
    backupFolder = path.join(tmp, 'elsewhere')
    expect((await invoke('backups:chooseFolder', undefined)).folder).toBe(backupFolder)
    expect(await invoke('backups:reveal', undefined)).toBeNull()
    expect(openPath).toHaveBeenCalledWith(backupFolder)
    expect(fs.existsSync(backupFolder)).toBe(true)
    openPath.mockResolvedValueOnce('No application is associated')
    await expect(invoke('backups:reveal', undefined)).rejects.toThrow('IO: No application')
    const reset = await invoke('backups:setSettings', { patch: { folder: null } })
    expect(reset.folder).toBe(backupsRoot())
  })

  it('backs a changed project up when it closes', async () => {
    await invoke('project:create', { name: 'Ridge', format: 'novel', directory: tmp })
    await invoke('project:close', undefined)
    const dirs = fs.readdirSync(backupsRoot())
    expect(dirs).toHaveLength(1)
    expect(fs.readdirSync(path.join(backupsRoot(), dirs[0] ?? ''))).toHaveLength(1)
  })
})

describe('diagnostics handlers (F-15.8)', () => {
  it('answers off on a fresh install, with nothing pending', async () => {
    const state = await invoke('diagnostics:getState', undefined)
    expect(state.enabled).toBe(false)
    expect(state.lastSentDay).toBeNull()
    expect(JSON.parse(state.pending)).toEqual({
      ...DIAGNOSTICS_ENVIRONMENT,
      counts: [],
      crashes: []
    })
  })

  it('stores the switch the author flipped, which the next call answers', async () => {
    expect((await invoke('diagnostics:setEnabled', { on: true })).enabled).toBe(true)
    expect((await invoke('diagnostics:getState', undefined)).enabled).toBe(true)
    expect((await invoke('diagnostics:setEnabled', { on: false })).enabled).toBe(false)
  })

  it('drops a renderer error while diagnostics are off and scrubs it once they are on', async () => {
    const error = {
      name: 'TypeError',
      message: 'Could not render "She turned from the window." from /home/u/novel/x.db',
      stack: '    at render (/app/out/renderer/main.js:9:2)'
    }
    expect(await invoke('diagnostics:reportRendererError', error)).toBeNull()
    expect(JSON.parse((await invoke('diagnostics:getState', undefined)).pending)).toMatchObject({
      crashes: []
    })

    await invoke('diagnostics:setEnabled', { on: true })
    await invoke('diagnostics:reportRendererError', error)
    const pending = JSON.parse(
      (await invoke('diagnostics:getState', undefined)).pending
    ) as DiagnosticsBody
    expect(pending.crashes).toEqual([
      {
        ...DIAGNOSTICS_ENVIRONMENT,
        kind: 'renderer',
        name: 'TypeError',
        message: 'Could not render <text> from <path>',
        stack: ['out/renderer/main.js:9:2']
      }
    ])
    await invoke('diagnostics:setEnabled', { on: false })
  })

  /**
   * The tally as it stands on disk, read through a fresh store so nothing is served from the
   * handlers' own cache. One run of a test is one day, so there is at most one day's tally.
   */
  const storedCounts = (): Record<string, number> => {
    const stored = new AppStateStore(path.join(tmp, 'userData', 'app-state.json')).get()
    return Object.values(stored.diagnostics.counts)[0] ?? {}
  }

  it('counts the events main owns, and records nothing at all while it is off', async () => {
    const KEY = 'sk-test-secret-1234abcd'
    complete.mockResolvedValue({
      text: 'Somewhere ahead the river was rising.',
      model: 'gpt-fake',
      usage: { inputTokens: 120, outputTokens: 12 }
    })

    // Off: creating a project and exporting leave nothing behind.
    await invoke('project:create', { name: 'Quiet', format: 'novel', directory: tmp })
    expect(storedCounts()).toEqual({})

    await invoke('diagnostics:setEnabled', { on: true })
    const created = await invoke('project:create', {
      name: 'Counted',
      format: 'novel',
      directory: tmp
    })
    await invoke('project:open', { path: created?.path ?? '' })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    await invoke('ai:setKey', { key: KEY })
    const ghost = await invoke('ai:ghostText', {
      nodeId: scene.id,
      before: 'The storm broke at dusk over the dark forest.',
      after: '',
      requestId: 'count-1'
    })
    if (!ghost.ok || ghost.proposalId === null) throw new Error('expected a proposal')
    await invoke('proposal:settle', { id: ghost.proposalId, status: 'accepted' })
    exportPath = path.join(tmp, 'counted-disclosure.md')
    await invoke('provenance:export', undefined)

    expect(storedCounts()).toEqual({
      'project.create': 1,
      'project.open': 1,
      'ai.request.ghostText': 1,
      'proposal.accept': 1,
      'export.run': 1
    })

    // Switching it off throws away everything that was recorded.
    await invoke('diagnostics:setEnabled', { on: false })
    expect(storedCounts()).toEqual({})
  })

  it('refuses a renderer error longer than the contract allows', async () => {
    const result = await handlerFor('diagnostics:reportRendererError')(undefined, {
      name: 'Error',
      message: 'x'.repeat(RENDERER_ERROR_MESSAGE_MAX + 1),
      stack: null
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
  })
})

describe('ai handlers (F-5.1)', () => {
  const KEY = 'sk-test-secret-1234abcd'

  it('reports no key and the encryption kind before anything is saved', async () => {
    expect(await invoke('ai:getStatus', undefined)).toEqual({
      provider: 'openai',
      hasKey: false,
      hint: null,
      encryption: 'os',
      // F-15.4: both provider maps, since the AI tab edits the one the project's source names.
      models: { openai: DEFAULT_MODELS, cloud: DEFAULT_MODELS, local: LOCAL_DEFAULT_MODELS },
      local: { baseUrl: 'http://localhost:11434/v1' }
    })
  })

  it('stores a key, answers with a mask only, and never returns the key', async () => {
    const status = await invoke('ai:setKey', { key: `  ${KEY}  ` })
    expect(status).toEqual({
      provider: 'openai',
      hasKey: true,
      hint: 'sk-…abcd',
      encryption: 'os',
      models: { openai: DEFAULT_MODELS, cloud: DEFAULT_MODELS, local: LOCAL_DEFAULT_MODELS },
      local: { baseUrl: 'http://localhost:11434/v1' }
    })
    expect(JSON.stringify(status)).not.toContain(KEY)
    expect(await invoke('ai:getStatus', undefined)).toEqual(status)
    expect(fs.readFileSync(keyFile, 'utf8')).not.toContain(KEY)
    expect(safe.encrypted).toEqual([KEY])
  })

  it('refuses a key outside the length bounds with VALIDATION', async () => {
    const result = await handlerFor('ai:setKey')(undefined, { key: 'short' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(safe.encrypted).toEqual([])
  })

  it('refuses to store a key with IO when safe storage is unavailable', async () => {
    safe.isEncryptionAvailable = () => false
    expect(await invoke('ai:getStatus', undefined)).toMatchObject({ encryption: 'none' })
    const result = await handlerFor('ai:setKey')(undefined, { key: KEY })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('IO')
      expect(result.error.message).not.toContain(KEY)
    }
    expect(fs.existsSync(keyFile)).toBe(false)
  })

  it('clears the key and reports no key again', async () => {
    await invoke('ai:setKey', { key: KEY })
    expect(await invoke('ai:clearKey', undefined)).toMatchObject({ hasKey: false, hint: null })
    expect(await invoke('ai:getStatus', undefined)).toMatchObject({ hasKey: false })
  })

  it('answers NO_KEY as data without asking the provider when no key is saved', async () => {
    expect(await invoke('ai:testConnection', undefined)).toEqual({
      ok: false,
      code: 'NO_KEY',
      message: 'No API key is saved.',
      nextStep: 'Add a key above and save it.'
    })
    expect(testConnection).not.toHaveBeenCalled()
  })

  it('answers with the model on success and an expected failure as data with its next step', async () => {
    await invoke('ai:setKey', { key: KEY })
    expect(await invoke('ai:testConnection', undefined)).toEqual({ ok: true, model: 'gpt-fake' })

    testConnection.mockRejectedValueOnce(new InvalidKeyError('OpenAI rejected the API key.'))
    expect(await invoke('ai:testConnection', undefined)).toEqual({
      ok: false,
      code: 'INVALID_KEY',
      message: 'OpenAI rejected the API key.',
      nextStep: 'Check the key and try again.'
    })
  })

  it('sends a project whose source is MythScribe Cloud through the proxy adapter (F-15.4)', async () => {
    await invoke('project:create', { name: 'Cloudy', format: 'novel', directory: tmp })
    await invoke('aiSettings:set', { ...defaultAiSettings(), source: 'cloud' })
    // No key is saved, and none is needed: the Cloud adapter carries the session instead.
    expect(await invoke('ai:testConnection', undefined)).toEqual({ ok: true, model: 'cloud-fake' })
    expect(testConnection).not.toHaveBeenCalled()
    expect(cloudTestConnection).toHaveBeenCalledOnce()

    // And back: the same project on its own key reaches the key adapter again.
    await invoke('ai:setKey', { key: KEY })
    await invoke('aiSettings:set', { ...defaultAiSettings(), source: 'ownKey' })
    expect(await invoke('ai:testConnection', undefined)).toEqual({ ok: true, model: 'gpt-fake' })
    expect(cloudTestConnection).toHaveBeenCalledOnce()
  })

  it('lets an unexpected failure reach the error envelope', async () => {
    await invoke('ai:setKey', { key: KEY })
    testConnection.mockRejectedValueOnce(new TypeError('boom'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await handlerFor('ai:testConnection')(undefined, undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INTERNAL')
    vi.restoreAllMocks()
    expect(new InvalidKeyError('x')).toBeInstanceOf(AiProviderError)
  })
})

describe('ai:recommendTags (F-4.7)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const LONG = 'The storm broke at dusk over the dark forest, and Mara counted the lightning gaps.'

  /** A project with a scene of enough text, the dial at Ask, and two bank tags. */
  async function ready(): Promise<{ scene: string; folder: string; forest: Tag; hero: Tag }> {
    await invoke('project:create', { name: 'Rec', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    const folder = rows.find((r) => r.kind === 'folder' && r.sectionType === null)
    if (!scene || !folder) throw new Error('skeleton not seeded')
    await invoke('document:save', {
      id: scene.id,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: LONG }] }]
      }
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    const forest = await invoke('tag:create', { name: 'Dark Forest', category: 'setting' })
    const hero = await invoke('tag:create', { name: 'Protagonist', category: 'character' })
    return { scene: scene.id, folder: folder.id, forest, hero }
  }

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('ai:recommendTags', { nodeId: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers the unlinked bank tags the model named, with the cost, and logs one ledger row', async () => {
    const { scene, forest, hero } = await ready()
    await invoke('ai:setKey', { key: KEY })
    await invoke('documentTag:add', { nodeId: scene, tagId: forest.id })
    const result = await invoke('ai:recommendTags', { nodeId: scene })
    if (!result.ok) throw new Error(result.message)
    expect(result.proposalId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result).toEqual({
      ok: true,
      suggestions: [hero],
      usage: { inputTokens: 40, outputTokens: 10 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      promptVersion: 'tags.v1',
      proposalId: result.proposalId
    })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0]![0]).toMatchObject({ tier: 'fast', json: true, maxTokens: 200 })
    expect((await invoke('ai:usageSummary', undefined)).total.requests).toBe(1)
    // Nothing was linked by the suggestion itself.
    expect(await invoke('documentTag:list', { nodeId: scene })).toEqual([
      { ...forest, usageCount: 1, source: 'author' }
    ])
  })

  it('answers each expected AI failure as data with its next step', async () => {
    const { scene } = await ready()
    expect(await invoke('ai:recommendTags', { nodeId: scene })).toEqual({
      ok: false,
      code: 'NO_KEY',
      message: 'No API key is saved.',
      nextStep: 'Add a key above and save it.'
    })
    await invoke('ai:setKey', { key: KEY })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 0 })
    expect(await invoke('ai:recommendTags', { nodeId: scene })).toEqual({
      ok: false,
      code: 'DISABLED',
      message: 'Tag suggestions needs the AI switch at Ask or Auto (it is at Off).',
      nextStep:
        'Set the AI switch to Ask or Auto in the assistant panel or Settings, or enable the feature there.'
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    complete.mockRejectedValueOnce(new InvalidKeyError('OpenAI rejected the API key.'))
    expect(await invoke('ai:recommendTags', { nodeId: scene })).toEqual({
      ok: false,
      code: 'INVALID_KEY',
      message: 'OpenAI rejected the API key.',
      nextStep: 'Check the key and try again.'
    })
    // A provider failure writes nothing, so the next call reaches the provider again.
    complete.mockResolvedValueOnce({
      text: 'not json',
      model: 'gpt-fake',
      usage: { inputTokens: 1, outputTokens: 1 }
    })
    expect(await invoke('ai:recommendTags', { nodeId: scene })).toEqual({
      ok: false,
      code: 'PROVIDER',
      message: 'The model did not answer in the expected format.',
      nextStep: 'Try again in a moment.'
    })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('ai:cancel stops a request by the requestId the caller passed; without one the request cannot be stopped (F-5.10)', async () => {
    const { scene } = await ready()
    await invoke('ai:setKey', { key: KEY })
    complete.mockImplementationOnce(untilCancelled)
    const pending = invoke('ai:recommendTags', { nodeId: scene, requestId: 'req-1' })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(complete.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal)
    expect(await invoke('ai:cancel', { requestId: 'req-1' })).toEqual({ cancelled: true })
    expect(await pending).toEqual({
      ok: false,
      code: 'CANCELLED',
      message: 'The request was stopped.',
      nextStep: 'Send it again whenever you like.'
    })
    expect(manager.require().connection.orm.select().from(aiProposal).all()).toHaveLength(0)
    expect((await invoke('ai:usageSummary', undefined)).total.requests).toBe(0)
    expect(await invoke('ai:cancel', { requestId: 'req-1' })).toEqual({ cancelled: false })
    // No requestId: the provider sees no signal, and nothing is registered to cancel.
    const plain = await invoke('ai:recommendTags', { nodeId: scene })
    expect(plain.ok).toBe(true)
    expect('signal' in complete.mock.calls[1]![0]).toBe(false)
  })

  it('records the batch as one pending proposal holding the offered names, and a regenerate with its note and predecessor (F-14.5)', async () => {
    const { scene, hero } = await ready()
    await invoke('ai:setKey', { key: KEY })
    const first = await invoke('ai:recommendTags', { nodeId: scene })
    if (!first.ok) throw new Error(first.message)
    const db = manager.require().connection.orm
    expect(getProposal(db, first.proposalId)).toMatchObject({
      feature: 'tags',
      nodeId: scene,
      promptVersion: 'tags.v1',
      model: 'gpt-fake',
      promptTokens: 40,
      completionTokens: 10,
      cached: false,
      content: JSON.stringify(['dark-forest', 'protagonist']),
      flagged: null,
      violation: null,
      status: 'pending',
      regeneratedFrom: null
    })
    complete.mockResolvedValueOnce({
      text: '{"tags":["protagonist"]}',
      model: 'gpt-fake',
      usage: { inputTokens: 44, outputTokens: 6 }
    })
    const again = await invoke('ai:recommendTags', {
      nodeId: scene,
      note: 'Less setting.',
      regeneratedFrom: first.proposalId
    })
    expect(again).toMatchObject({
      ok: true,
      suggestions: [hero],
      promptVersion: 'tagsRegen.v1',
      cached: false
    })
    if (!again.ok) throw new Error(again.message)
    expect(getProposal(db, again.proposalId)).toMatchObject({
      promptVersion: 'tagsRegen.v1',
      content: JSON.stringify(['protagonist']),
      regeneratedFrom: first.proposalId
    })
    expect(complete.mock.calls[1]![0].messages[0]?.content).toContain('said: "Less setting."')
    expect(db.select().from(aiProposal).all()).toHaveLength(2)
  })

  it('refuses a note over the limit as VALIDATION before touching the provider', async () => {
    const { scene } = await ready()
    await invoke('ai:setKey', { key: KEY })
    const result = await handlerFor('ai:recommendTags')(undefined, {
      nodeId: scene,
      note: 'n'.repeat(301)
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(complete).not.toHaveBeenCalled()
  })

  it('lets a folder and an unknown id reach the error envelope as VALIDATION and NOT_FOUND', async () => {
    const { folder } = await ready()
    const onFolder = await handlerFor('ai:recommendTags')(undefined, { nodeId: folder })
    expect(onFolder.ok).toBe(false)
    if (!onFolder.ok) expect(onFolder.error.code).toBe('VALIDATION')
    const unknown = await handlerFor('ai:recommendTags')(undefined, { nodeId: 'nope' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    expect(complete).not.toHaveBeenCalled()
  })
})

describe('ai:ghostText (F-5.3)', () => {
  const KEY = 'sk-test-secret-1234abcd'
  const BEFORE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'

  /** A project with the switch at Ask and a scene to continue. */
  async function ready(): Promise<{ scene: string }> {
    await invoke('project:create', { name: 'Ghost', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    complete.mockResolvedValue({
      text: 'Somewhere ahead the river was rising.',
      model: 'gpt-fake',
      usage: { inputTokens: 120, outputTokens: 12 }
    })
    return { scene: scene.id }
  }

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(
      invoke('ai:ghostText', { nodeId: 'x', before: 'a', after: '', requestId: '1' })
    ).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers the continuation with the cost and the echoed requestId, and logs one ledger row', async () => {
    const { scene } = await ready()
    await invoke('ai:setKey', { key: KEY })
    const result = await invoke('ai:ghostText', {
      nodeId: scene,
      before: BEFORE,
      after: '',
      requestId: 'req-7'
    })
    if (!result.ok) throw new Error(result.message)
    expect(result.proposalId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result).toEqual({
      ok: true,
      text: ' Somewhere ahead the river was rising.',
      usage: { inputTokens: 120, outputTokens: 12 },
      costUsd: 0,
      cached: false,
      model: 'gpt-fake',
      flagged: false,
      violation: null,
      proposalId: result.proposalId,
      requestId: 'req-7'
    })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(complete.mock.calls[0]![0]).toMatchObject({ tier: 'fast', maxTokens: 40 })
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.total.requests).toBe(1)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['ghostText'])
  })

  it('records a shown suggestion as a pending proposal and no row for an empty answer (F-14.5)', async () => {
    const { scene } = await ready()
    await invoke('ai:setKey', { key: KEY })
    const shown = await invoke('ai:ghostText', {
      nodeId: scene,
      before: BEFORE,
      after: '',
      requestId: 'req-9'
    })
    if (!shown.ok || shown.proposalId === null) throw new Error('expected a proposal')
    const db = manager.require().connection.orm
    expect(getProposal(db, shown.proposalId)).toMatchObject({
      feature: 'ghostText',
      nodeId: scene,
      promptVersion: 'ghostText.v4',
      model: 'gpt-fake',
      promptTokens: 120,
      completionTokens: 12,
      cached: false,
      content: ' Somewhere ahead the river was rising.',
      flagged: false,
      violation: null,
      status: 'pending',
      note: null,
      settledAt: null
    })
    complete.mockResolvedValueOnce({
      text: '   ',
      model: 'gpt-fake',
      usage: { inputTokens: 120, outputTokens: 1 }
    })
    const empty = await invoke('ai:ghostText', {
      nodeId: scene,
      before: `${BEFORE} More.`,
      after: '',
      requestId: 'req-10'
    })
    expect(empty).toMatchObject({ ok: true, text: '', proposalId: null })
    expect(db.select().from(aiProposal).all()).toHaveLength(1)
  })

  it('answers each expected AI failure as data with its next step and the requestId', async () => {
    const { scene } = await ready()
    const input = { nodeId: scene, before: BEFORE, after: '', requestId: 'req-8' }
    expect(await invoke('ai:ghostText', input)).toEqual({
      ok: false,
      code: 'NO_KEY',
      message: 'No API key is saved.',
      nextStep: 'Add a key above and save it.',
      requestId: 'req-8'
    })
    await invoke('ai:setKey', { key: KEY })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 0 })
    expect(await invoke('ai:ghostText', input)).toEqual({
      ok: false,
      code: 'DISABLED',
      message: 'Ghost text needs the AI switch at Ask or Auto (it is at Off).',
      nextStep:
        'Set the AI switch to Ask or Auto in the assistant panel or Settings, or enable the feature there.',
      requestId: 'req-8'
    })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    complete.mockRejectedValueOnce(new InvalidKeyError('OpenAI rejected the API key.'))
    expect(await invoke('ai:ghostText', input)).toEqual({
      ok: false,
      code: 'INVALID_KEY',
      message: 'OpenAI rejected the API key.',
      nextStep: 'Check the key and try again.',
      requestId: 'req-8'
    })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('lets an unknown id and an over-long window reach the error envelope as NOT_FOUND and VALIDATION', async () => {
    await ready()
    const unknown = await handlerFor('ai:ghostText')(undefined, {
      nodeId: 'nope',
      before: BEFORE,
      after: '',
      requestId: '1'
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    const long = await handlerFor('ai:ghostText')(undefined, {
      nodeId: 'nope',
      before: 'x'.repeat(501),
      after: '',
      requestId: '1'
    })
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.error.code).toBe('VALIDATION')
    expect(complete).not.toHaveBeenCalled()
  })
})

describe('proposal:settle (F-14.5)', () => {
  const KEY = 'sk-test-secret-1234abcd'

  /** A project with the switch at Ask, a key, and one pending ghost-text proposal. */
  async function ready(): Promise<string> {
    await invoke('project:create', { name: 'Settle', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    await invoke('ai:setKey', { key: KEY })
    complete.mockResolvedValue({
      text: 'Somewhere ahead the river was rising.',
      model: 'gpt-fake',
      usage: { inputTokens: 120, outputTokens: 12 }
    })
    const result = await invoke('ai:ghostText', {
      nodeId: scene.id,
      before: 'The storm broke at dusk over the dark forest.',
      after: '',
      requestId: '1'
    })
    if (!result.ok || result.proposalId === null) throw new Error('expected a proposal')
    return result.proposalId
  }

  it('reports NO_PROJECT when nothing is open', async () => {
    await expect(invoke('proposal:settle', { id: 'x', status: 'rejected' })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('settles a pending proposal once with the status and a trimmed note; a second settlement is a no-op', async () => {
    const id = await ready()
    expect(
      await invoke('proposal:settle', { id, status: 'regenerated', note: '  Too purple. ' })
    ).toBeNull()
    const db = manager.require().connection.orm
    const settled = getProposal(db, id)
    expect(settled).toMatchObject({ status: 'regenerated', note: 'Too purple.' })
    expect(settled?.settledAt).toEqual(expect.any(String))
    expect(await invoke('proposal:settle', { id, status: 'accepted' })).toBeNull()
    expect(getProposal(db, id)).toEqual(settled)
    // An unknown id is a silent no-op too.
    expect(await invoke('proposal:settle', { id: 'gone', status: 'accepted' })).toBeNull()
  })

  it('stores a blank note as none and refuses pending as a status or a note over the limit', async () => {
    const id = await ready()
    await invoke('proposal:settle', { id, status: 'acceptedPart', note: '   ' })
    expect(getProposal(manager.require().connection.orm, id)).toMatchObject({
      status: 'acceptedPart',
      note: null
    })
    const pending = await handlerFor('proposal:settle')(undefined, { id, status: 'pending' })
    expect(pending.ok).toBe(false)
    if (!pending.ok) expect(pending.error.code).toBe('VALIDATION')
    const long = await handlerFor('proposal:settle')(undefined, {
      id,
      status: 'rejected',
      note: 'n'.repeat(301)
    })
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.error.code).toBe('VALIDATION')
  })
})

describe('ai:cancel (F-5.10)', () => {
  it('needs no project and answers false for an id that is not in flight', async () => {
    expect(await invoke('ai:cancel', { requestId: 'never' })).toEqual({ cancelled: false })
  })

  it('also reaches a fidelity regenerate registered under id:regen (F-14.7)', async () => {
    const regen = registerInflight('req-3:regen')
    expect(await invoke('ai:cancel', { requestId: 'req-3' })).toEqual({ cancelled: true })
    expect(regen.signal.aborted).toBe(true)
  })

  it('passes the ghost-text requestId through so the provider gets a signal (F-5.3)', async () => {
    await invoke('project:create', { name: 'Ghost', format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
    await invoke('ai:setKey', { key: 'sk-test-secret-1234abcd' })
    complete.mockImplementationOnce(untilCancelled)
    const pending = invoke('ai:ghostText', {
      nodeId: scene.id,
      before: 'The storm broke at dusk.',
      after: '',
      requestId: 'req-4'
    })
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
    expect(await invoke('ai:cancel', { requestId: 'req-4' })).toEqual({ cancelled: true })
    expect(await pending).toEqual({
      ok: false,
      code: 'CANCELLED',
      message: 'The request was stopped.',
      nextStep: 'Send it again whenever you like.',
      requestId: 'req-4'
    })
    expect(manager.require().connection.orm.select().from(aiProposal).all()).toHaveLength(0)
  })
})

describe('ai:usageSummary / ai:setDailyCap (F-5.14)', () => {
  const zero = { requests: 0, tokens: 0, costUsd: 0 }

  it('needs an open project', async () => {
    await expect(invoke('ai:usageSummary', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('answers the default cap and an empty ledger for a fresh project', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    expect(await invoke('ai:usageSummary', undefined)).toEqual({
      today: zero,
      session: zero,
      total: zero,
      byFeature: [],
      recent: [],
      dailyCapUsd: 2
    })
  })

  it('sums the project ledger per feature and reports the app-wide day from app state', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    const row = {
      at: '2026-09-12T10:00:00.000Z',
      tier: 'fast' as const,
      model: 'gpt-5.4-mini',
      provider: 'openai' as const,
      promptTokens: 100,
      completionTokens: 20,
      cached: false,
      contextHash: 'ctx'
    }
    insertUsage(manager.require().connection.orm, { ...row, feature: 'tags', costUsd: 0.001 })
    insertUsage(manager.require().connection.orm, { ...row, feature: 'summary', costUsd: 0.002 })
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.byFeature.map((f) => f.feature)).toEqual(['summary', 'tags'])
    expect(summary.total).toMatchObject({ requests: 2, tokens: 240 })
    expect(summary.total.costUsd).toBeCloseTo(0.003, 8)
    // The day is app-wide: nothing in this project's ledger moves it.
    expect(summary.today).toEqual(zero)
    // The session tally counts what this run of the app spent, not what the ledger holds (F-5.9).
    expect(summary.session).toEqual(zero)
    expect(summary.recent.map((r) => r.feature)).toEqual(['summary', 'tags'])
    expect(summary.recent[0]).toMatchObject({
      feature: 'summary',
      model: 'gpt-5.4-mini',
      promptTokens: 100,
      completionTokens: 20,
      costUsd: 0.002,
      cached: false
    })
  })

  it('caps the recent list at USAGE_RECENT_LIMIT, newest first (F-5.9)', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    for (let i = 0; i < USAGE_RECENT_LIMIT + 3; i += 1) {
      insertUsage(manager.require().connection.orm, {
        at: `2026-09-12T10:${String(i).padStart(2, '0')}:00.000Z`,
        feature: 'tags',
        tier: 'fast',
        model: 'gpt-5.4-mini',
        provider: 'openai',
        promptTokens: i,
        completionTokens: 0,
        cached: false,
        costUsd: 0,
        contextHash: 'ctx'
      })
    }
    const summary = await invoke('ai:usageSummary', undefined)
    expect(summary.recent).toHaveLength(USAGE_RECENT_LIMIT)
    expect(summary.recent[0]?.promptTokens).toBe(USAGE_RECENT_LIMIT + 2)
    expect(summary.total.requests).toBe(USAGE_RECENT_LIMIT + 3)
  })

  it('persists a new cap, answers the summary with it, and refuses one outside 0–500', async () => {
    await invoke('project:create', { name: 'A', format: 'novel', directory: tmp })
    expect((await invoke('ai:setDailyCap', { dailyCapUsd: 5 })).dailyCapUsd).toBe(5)
    expect((await invoke('ai:usageSummary', undefined)).dailyCapUsd).toBe(5)
    const file = path.join(tmp, 'userData', 'app-state.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      aiUsage: { dailyCapUsd: 5 }
    })
    for (const dailyCapUsd of [-1, 500.5]) {
      const result = await handlerFor('ai:setDailyCap')(undefined, { dailyCapUsd })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect((await invoke('ai:usageSummary', undefined)).dailyCapUsd).toBe(5)
  })
})

describe('ai:setModels (F-5.11)', () => {
  const models = { fast: 'gpt-5.4-nano', strong: 'gpt-5.4-pro' }

  it('persists the mapping, trimmed, and a fresh status carries it', async () => {
    const status = await invoke('ai:setModels', {
      provider: 'openai',
      models: { fast: ' gpt-5.4-nano ', strong: 'gpt-5.4-pro' }
    })
    expect(status.models.openai).toEqual(models)
    // F-15.4: the other provider's map is untouched by a write to this one.
    expect(status.models.cloud).toEqual(DEFAULT_MODELS)
    expect(await invoke('ai:getStatus', undefined)).toMatchObject({ models: { openai: models } })
    const file = path.join(tmp, 'userData', 'app-state.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ models: { openai: models } })
  })

  it('writes the Cloud map on its own, leaving the key path alone (F-15.4)', async () => {
    const cloud = { fast: 'gpt-5.4-mini', strong: 'gpt-5.4-nano' }
    const status = await invoke('ai:setModels', { provider: 'cloud', models: cloud })
    expect(status.models).toEqual({ openai: DEFAULT_MODELS, cloud, local: LOCAL_DEFAULT_MODELS })
  })

  it('refuses an empty or over-long model id with VALIDATION and keeps the stored mapping', async () => {
    await invoke('ai:setModels', { provider: 'openai', models })
    for (const fast of ['', '   ', 'x'.repeat(101)]) {
      const result = await handlerFor('ai:setModels')(undefined, {
        provider: 'openai',
        models: { fast, strong: 'gpt-5.4' }
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
    expect(await invoke('ai:getStatus', undefined)).toMatchObject({ models: { openai: models } })
  })
})

describe('ai:setLocalEndpoint (F-5.15)', () => {
  it("answers Ollama's address by default, stores a new one without its trailing slash, and refuses a non-http one", async () => {
    expect((await invoke('ai:getStatus', undefined)).local).toEqual({
      baseUrl: 'http://localhost:11434/v1'
    })
    const status = await invoke('ai:setLocalEndpoint', { baseUrl: ' http://localhost:1234/v1/ ' })
    expect(status.local).toEqual({ baseUrl: 'http://localhost:1234/v1' })
    const file = path.join(tmp, 'userData', 'app-state.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      localAi: { baseUrl: 'http://localhost:1234/v1' }
    })
    for (const baseUrl of ['ftp://host/v1', 'localhost:11434', '']) {
      const result = await handlerFor('ai:setLocalEndpoint')(undefined, { baseUrl })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    }
  })

  it('sends a project on the local source to the local provider and logs it as local', async () => {
    await invoke('project:create', { name: 'Local', format: 'novel', directory: tmp })
    await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1, source: 'local' })
    // No key is saved: the local source needs none.
    expect(await invoke('ai:testConnection', undefined)).toMatchObject({ ok: true })
  })
})

describe('authorRules handlers (F-14.2)', () => {
  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('authorRules:get', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('authorRules:set', { rules: '', bannedPhrases: [] })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
  })

  it('answers the seeded phrases for a new project, round-trips a write, and survives a reopen', async () => {
    const created = await invoke('project:create', {
      name: 'Rules',
      format: 'novel',
      directory: tmp
    })
    expect(await invoke('authorRules:get', undefined)).toEqual(defaultAuthorRules())
    const kept = DEFAULT_BANNED_PHRASES.filter((phrase) => phrase !== 'delve')
    expect(
      await invoke('authorRules:set', { rules: 'British spelling.', bannedPhrases: [...kept] })
    ).toEqual({ rules: 'British spelling.', bannedPhrases: kept })
    await invoke('project:close', undefined)
    await invoke('project:open', { path: created?.path ?? '' })
    const stored = await invoke('authorRules:get', undefined)
    expect(stored.rules).toBe('British spelling.')
    expect(stored.bannedPhrases).not.toContain('delve')
  })

  it('bumps the voice version so the profile carries the new rules at once', async () => {
    await invoke('project:create', { name: 'Rules', format: 'novel', directory: tmp })
    expect((await invoke('voice:profile', {})).authorRules).toEqual(defaultAuthorRules())
    await invoke('authorRules:set', { rules: 'No rhetorical questions.', bannedPhrases: ['delve'] })
    expect((await invoke('voice:profile', {})).authorRules).toEqual({
      rules: 'No rhetorical questions.',
      bannedPhrases: ['delve']
    })
  })

  it('refuses rules text over the limit with VALIDATION and keeps the stored value', async () => {
    await invoke('project:create', { name: 'Rules', format: 'novel', directory: tmp })
    await invoke('authorRules:set', { rules: 'Kept.', bannedPhrases: [] })
    const result = await handlerFor('authorRules:set')(undefined, {
      rules: 'r'.repeat(AUTHOR_RULES_TEXT_MAX + 1),
      bannedPhrases: []
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(await invoke('authorRules:get', undefined)).toEqual({
      rules: 'Kept.',
      bannedPhrases: []
    })
  })
})

describe('voice handlers (F-14.1)', () => {
  const PASSAGE =
    'Mara turned from the window and looked at the ridge, where the storm had settled for the ' +
    'night. She knew she was tired, and she thought about the river and what it wanted from her.'
  const para = (text: string): Input<'document:save'>['content'] => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

  /** A project with its first scene's id. */
  async function ready(name = 'Voice'): Promise<string> {
    await invoke('project:create', { name, format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    return scene.id
  }

  it('reports NO_PROJECT for all four when nothing is open', async () => {
    await expect(invoke('voice:listExemplars', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('voice:addExemplar', { nodeId: 'x', text: PASSAGE })).rejects.toThrowError(
      /^NO_PROJECT: /
    )
    await expect(invoke('voice:removeExemplar', { id: 'x' })).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('voice:profile', {})).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('voice:consistencyReport', {})).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('scores every manuscript document against the profile in the consistency report (F-14.7)', async () => {
    const scene = await ready()
    await invoke('document:save', { id: scene, content: para(Array(6).fill(PASSAGE).join(' ')) })
    const report = await invoke('voice:consistencyReport', {})
    expect(report.profileWordCount).toBeGreaterThan(0)
    const rows = await invoke('tree:list', undefined)
    expect(report.documents.map((d) => d.id)).toEqual(manuscriptReadingOrder(rows))
    expect(report.documents.find((d) => d.id === scene)).toMatchObject({
      title: 'Scene 1',
      status: 'ok',
      violations: []
    })
    for (const entry of report.documents.filter((d) => d.id !== scene)) {
      expect(entry).toMatchObject({ wordCount: 0, status: 'short', violations: [] })
    }
  })

  it('adds, lists, and removes exemplars; the profile carries them and follows document saves', async () => {
    const scene = await ready()
    await invoke('sceneMeta:set', { id: scene, meta: { location: '', pov: 'Mara', timeline: '' } })
    const added = await invoke('voice:addExemplar', { nodeId: scene, text: `  ${PASSAGE}  ` })
    expect(added).toMatchObject({ nodeId: scene, text: PASSAGE, pov: 'Mara', kind: 'mixed' })
    expect(await invoke('voice:listExemplars', undefined)).toEqual([added])
    const empty = await invoke('voice:profile', {})
    expect(empty).toMatchObject({ rules: [], exemplars: [added], wordCount: 0, confidence: 0 })
    await invoke('document:save', { id: scene, content: para(PASSAGE) })
    const saved = await invoke('voice:profile', { pov: 'Mara' })
    expect(saved.wordCount).toBeGreaterThan(0)
    expect(saved.confidence).toBeGreaterThan(0)
    expect(await invoke('voice:removeExemplar', { id: added.id })).toBeNull()
    expect(await invoke('voice:listExemplars', undefined)).toEqual([])
    expect((await invoke('voice:profile', {})).exemplars).toEqual([])
  })

  it('lets a short text, an unknown node, and an unknown id reach the envelope as VALIDATION and NOT_FOUND', async () => {
    const scene = await ready()
    const short = await handlerFor('voice:addExemplar')(undefined, { nodeId: scene, text: 'short' })
    expect(short.ok).toBe(false)
    if (!short.ok) expect(short.error.code).toBe('VALIDATION')
    const unknown = await handlerFor('voice:addExemplar')(undefined, {
      nodeId: 'nope',
      text: PASSAGE
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.code).toBe('NOT_FOUND')
    const gone = await handlerFor('voice:removeExemplar')(undefined, { id: 'nope' })
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.error.code).toBe('NOT_FOUND')
    expect(await invoke('voice:listExemplars', undefined)).toEqual([])
  })

  it('answers the learned style notes and clears them, and the profile follows (F-14.14)', async () => {
    await ready()
    await expect(invoke('voice:notes', undefined)).resolves.toBeNull()
    await expect(invoke('voice:clearNotes', undefined)).resolves.toBeNull()
    const orm = manager.require().connection.orm
    setVoiceNotes(orm, {
      notes: ['Opens on a concrete object.'],
      basedOnWords: 0,
      model: 'gpt-5.4-mini',
      updated: '2026-10-06T09:00:00.000Z'
    })
    bumpVoiceVersion()
    expect((await invoke('voice:notes', undefined))?.notes).toEqual(['Opens on a concrete object.'])
    expect((await invoke('voice:profile', {})).notes).toEqual(['Opens on a concrete object.'])
    const cleared = await invoke('voice:clearNotes', undefined)
    expect(cleared).toMatchObject({ notes: [], model: null })
    expect(await invoke('voice:notes', undefined)).toEqual(cleared)
    expect((await invoke('voice:profile', {})).notes).toEqual([])
  })

  it('remembers a removed automatic exemplar so the voice job does not pick it again (F-14.14)', async () => {
    const scene = await ready()
    const orm = manager.require().connection.orm
    replaceAutoExemplars(
      orm,
      [{ nodeId: scene, text: PASSAGE, pov: null, kind: 'mixed' }],
      new Date('2099-01-01T00:00:00.000Z')
    )
    const [auto] = await invoke('voice:listExemplars', undefined)
    expect(auto).toMatchObject({ text: PASSAGE, source: 'auto' })
    expect(await invoke('voice:removeExemplar', { id: auto?.id ?? '' })).toBeNull()
    expect(getVoiceAutoState(orm).dismissed).toEqual([passageHash(PASSAGE)])
  })

  it('never serves the profile of a previous project', async () => {
    const scene = await ready('First')
    await invoke('voice:addExemplar', { nodeId: scene, text: PASSAGE })
    expect((await invoke('voice:profile', {})).exemplars).toHaveLength(1)
    await invoke('project:close', undefined)
    await ready('Second')
    expect((await invoke('voice:profile', {})).exemplars).toEqual([])
  })
})

describe('provenance handlers (F-14.6)', () => {
  const marked = (mine: string, theirs: string): Input<'document:save'>['content'] => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: mine },
          {
            type: 'text',
            text: theirs,
            marks: [{ type: 'aiOrigin', attrs: { proposalId: 'p1', accepted: theirs.length } }]
          }
        ]
      }
    ]
  })

  async function ready(name = 'Ledger'): Promise<string> {
    await invoke('project:create', { name, format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    return scene.id
  }

  it('reports NO_PROJECT for both when nothing is open', async () => {
    await expect(invoke('provenance:report', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
    await expect(invoke('provenance:export', undefined)).rejects.toThrowError(/^NO_PROJECT: /)
  })

  it('reports the marked characters of the saved documents in tree order', async () => {
    const scene = await ready()
    await invoke('document:save', { id: scene, content: marked('Mine. ', 'Theirs, kept.') })
    const report = await invoke('provenance:report', undefined)
    const rows = await invoke('tree:list', undefined)
    expect(report.documents.map((d) => d.id)).toEqual(manuscriptReadingOrder(rows))
    expect(report.documents.find((d) => d.id === scene)).toEqual({
      id: scene,
      title: 'Scene 1',
      aiChars: 13,
      totalChars: 19,
      percent: 68,
      proposals: 1
    })
    expect(report).toMatchObject({ projectPercent: 68, aiChars: 13, totalChars: 19 })
  })

  it('exports the disclosure to the chosen path, defaulting beside the project folder', async () => {
    const scene = await ready('My Book')
    await invoke('document:save', { id: scene, content: marked('Mine. ', 'Theirs, kept.') })
    exportPath = path.join(tmp, 'out', 'disclosure.md')
    fs.mkdirSync(path.dirname(exportPath), { recursive: true })
    expect(await invoke('provenance:export', undefined)).toEqual({ path: exportPath })
    expect(exportAsked).toEqual({ defaultName: 'My Book-ai-disclosure.md', directory: tmp })
    const text = fs.readFileSync(exportPath, 'utf8')
    expect(text).toContain('# AI disclosure: My Book')
    expect(text).toContain('| Scene 1 | 13 | 19 | 68% |')
    expect(text).toContain('**AI-origin text:** 68% of the manuscript (13 of 19 characters).')
    expect(fs.existsSync(`${exportPath}.tmp`)).toBe(false)
  })

  it('answers null and writes nothing when the dialog is cancelled', async () => {
    await ready()
    expect(await invoke('provenance:export', undefined)).toBeNull()
    expect(exportAsked?.defaultName).toBe('Ledger-ai-disclosure.md')
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith('.md'))).toEqual([])
  })
})

// F-12.2: the two channels around the review dialog. The heuristics and the write have their own
// tests under `src/main/import/`; these cover the wiring — the dialog, the errors, and the rows
// the renderer merges into its tree.
describe('export handler (F-12.1)', () => {
  const options = (scope: Input<'export:run'>['options']['scope'] = { kind: 'manuscript' }) => ({
    format: 'md' as const,
    scope,
    includeFront: true,
    includeEnd: true,
    formatting: defaultExportFormatting('* * *')
  })

  async function ready(name = 'Exported'): Promise<string> {
    await invoke('project:create', { name, format: 'novel', directory: tmp })
    const rows = await invoke('tree:list', undefined)
    const scene = rows.find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('skeleton not seeded')
    return scene.id
  }

  it('writes the chosen file beside the project folder and pushes progress under the id', async () => {
    const scene = await ready('My Book')
    await invoke('document:save', {
      id: scene,
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The storm broke.' }] }]
      }
    })
    exportPath = path.join(tmp, 'book.md')
    vi.mocked(fakeWin.webContents.send).mockClear()
    expect(await invoke('export:run', { options: options(), requestId: 'r1' })).toEqual({
      path: exportPath,
      format: 'md',
      words: 3
    })
    expect(exportAsked).toEqual({ defaultName: 'My Book.md', directory: tmp })
    expect(fs.readFileSync(exportPath, 'utf8')).toContain('The storm broke.')
    const pushed = vi
      .mocked(fakeWin.webContents.send)
      .mock.calls.filter(([channel]) => channel === 'export:progress')
      .map(([, progress]) => progress)
    expect(pushed.at(-1)).toEqual({ requestId: 'r1', stage: 'write', done: 1, total: 1 })
    expect(pushed).toHaveLength(6)
  })

  it('answers null and writes nothing when the save dialog is cancelled', async () => {
    await ready()
    exportPath = null
    expect(await invoke('export:run', { options: options(), requestId: 'r2' })).toBeNull()
  })

  it('refuses a project with nothing to print', async () => {
    await ready()
    exportPath = path.join(tmp, 'empty.md')
    await expect(
      invoke('export:run', { options: options(), requestId: 'r3' })
    ).rejects.toThrowError(/^VALIDATION: Nothing to export\.$/)
    expect(fs.existsSync(exportPath)).toBe(false)
  })
})

describe('manuscript import', () => {
  async function ready(): Promise<void> {
    await invoke('project:create', { name: 'Imported', format: 'novel', directory: tmp })
  }

  function write(name: string, text: string): string {
    const file = path.join(tmp, name)
    fs.writeFileSync(file, text)
    return file
  }

  const MARKDOWN =
    '# Chapter One\n\nThe bell rang.\n\n* * *\n\nMorning came.\n\n# Chapter Two\n\nShe left.\n'

  it('reads the file the dialog answers and builds a draft without writing anything', async () => {
    await ready()
    const before = await invoke('tree:list', undefined)
    manuscriptPath = write('Book.md', MARKDOWN)

    const draft = await invoke('import:open', {})
    expect(draft?.source).toEqual({ name: 'Book.md', format: 'md', words: 7, paragraphs: 3 })
    // The combined outline: the project's starter part first, the file's after it.
    expect(draft?.parts.map((part) => [part.title, part.existing === true])).toEqual([
      ['Part 1', true],
      ['Book', false]
    ])
    expect(draft?.existing?.scenes).toHaveLength(1)
    expect(
      draft?.parts[1]?.chapters.map((chapter) => [chapter.title, chapter.scenes.length])
    ).toEqual([
      ['Chapter One', 2],
      ['Chapter Two', 1]
    ])
    expect(await invoke('tree:list', undefined)).toHaveLength(before.length)
  })

  it('answers null when the dialog is cancelled', async () => {
    await ready()
    expect(await invoke('import:open', {})).toBeNull()
  })

  it('reports an unsupported file and an unreadable one as VALIDATION', async () => {
    await ready()
    await expect(invoke('import:open', { path: write('Book.rtf', 'x') })).rejects.toThrowError(
      /^VALIDATION: Unsupported file type/
    )
    await expect(
      invoke('import:open', { path: path.join(tmp, 'missing.md') })
    ).rejects.toThrowError(/^VALIDATION: Could not read the file/)
    await expect(invoke('import:open', { path: write('Empty.md', '\n\n') })).rejects.toThrowError(
      /^VALIDATION: The file has no text to import\./
    )
  })

  it('commits the draft and answers the created nodes and the words', async () => {
    await ready()
    const draft = await invoke('import:open', { path: write('Book.md', MARKDOWN) })
    if (!draft) throw new Error('expected a draft')

    const result = await invoke('import:commit', { draft })
    expect(result.words).toBe(7)
    expect(result.rewritten).toEqual([])
    expect(result.tree).toEqual(await invoke('tree:list', undefined))
    expect(result.nodes.map((node) => node.title)).toEqual([
      'Book',
      'Chapter One',
      'Scene 1',
      'Scene 2',
      'Chapter Two',
      'Scene 1'
    ])
    const rows = await invoke('tree:list', undefined)
    expect(rows.filter((row) => row.title === 'Book')).toHaveLength(1)
    const scene = result.nodes[2]
    const stored = await invoke('document:get', { id: scene?.id ?? '' })
    expect(stored.content?.content?.[0]).toMatchObject({ attrs: { origin: 'imported' } })
  })

  it('reports a draft with nothing left to import as VALIDATION', async () => {
    await ready()
    const draft = await invoke('import:open', { path: write('Book.md', MARKDOWN) })
    if (!draft) throw new Error('expected a draft')
    // Everything imported left out, the project's own part untouched: nothing changes.
    const empty = {
      ...draft,
      parts: draft.parts.map((part) => (part.existing ? part : { ...part, excluded: true }))
    }
    await expect(invoke('import:commit', { draft: empty })).rejects.toThrowError(
      /^VALIDATION: Nothing selected to import\./
    )
  })

  it('reads a file for a new project when nothing is open, and refuses a commit', async () => {
    const draft = await invoke('import:open', { path: write('Book.md', MARKDOWN) })
    expect(draft?.existing).toBeUndefined()
    expect(draft?.parts.map((part) => part.title)).toEqual(['Book'])
    if (!draft) throw new Error('expected a draft')
    await expect(invoke('import:commit', { draft })).rejects.toThrowError(/^NO_PROJECT: /)
  })

  // Import to start: the welcome screen's Import manuscript… creates the project from the draft.
  it('creates a project without the skeleton, writes the draft, and opens it', async () => {
    const draft = await invoke('import:open', { path: write('Book.md', MARKDOWN) })
    if (!draft) throw new Error('expected a draft')
    const info = await invoke('import:createProject', {
      draft,
      name: 'From File',
      format: 'epic',
      directory: tmp
    })
    expect(info).toMatchObject({ name: 'From File', format: 'epic' })
    expect(await invoke('project:current', undefined)).toEqual(info)
    const rows = await invoke('tree:list', undefined)
    const outline = rows.filter((row) => row.hierarchyLevel !== null).map((row) => row.title)
    expect(outline.sort()).toEqual(
      ['Book', 'Chapter One', 'Chapter Two', 'Scene 1', 'Scene 1', 'Scene 2'].sort()
    )
  })

  it('answers null when the save dialog is cancelled and leaves no folder for a refused draft', async () => {
    const draft = await invoke('import:open', { path: write('Book.md', MARKDOWN) })
    if (!draft) throw new Error('expected a draft')
    expect(
      await invoke('import:createProject', { draft, name: 'Nope', format: 'novel' })
    ).toBeNull()
    const empty = { ...draft, parts: draft.parts.map((part) => ({ ...part, excluded: true })) }
    await expect(
      invoke('import:createProject', {
        draft: empty,
        name: 'Empty',
        format: 'novel',
        directory: tmp
      })
    ).rejects.toThrowError(/^VALIDATION: Nothing selected to import\./)
    expect(fs.readdirSync(tmp).some((name) => name.startsWith('Empty'))).toBe(false)
    expect(await invoke('project:current', undefined)).toBeNull()
  })

  // F-12.3: the AI pass and what it leaves behind. The runner and the merge have their own
  // tests; these cover the wiring — the progress event, the cancel, the failures as data, and
  // the pending tag proposals the commit writes for the tag bar.
  describe('AI structure detection', () => {
    const KEY = 'sk-test-secret-1234abcd'
    type ImportedDraft = NonNullable<Output<'import:open'>>

    async function readyForDetect(): Promise<ImportedDraft> {
      await ready()
      await invoke('ai:setKey', { key: KEY })
      await invoke('aiSettings:set', { ...defaultAiSettings(), dial: 1 })
      await invoke('tag:create', { name: 'Protagonist', category: 'character' })
      return draftFrom(write('Book.md', MARKDOWN))
    }

    async function draftFrom(file: string): Promise<ImportedDraft> {
      const draft = await invoke('import:open', { path: file })
      if (!draft) throw new Error('expected a draft')
      return draft
    }

    it('answers the merged suggestions, emits progress, and leaves one pending proposal per chunk', async () => {
      const draft = await readyForDetect()
      complete.mockResolvedValue({
        text: '{"breaks":[{"before":1,"kind":"chapter","reason":"time skip"}],"scenes":[{"start":0,"title":"The Bell","tags":["protagonist"]}]}',
        model: 'gpt-fake',
        usage: { inputTokens: 40, outputTokens: 10 }
      })
      const result = await invoke('import:detectStructure', { draft, requestId: 'd-1' })
      if (!result.ok) throw new Error(result.message)

      expect(result.suggestions).toEqual({
        breaks: [{ before: 1, kind: 'chapter', reason: 'time skip' }],
        scenes: [{ start: 0, title: 'The Bell', tags: ['protagonist'] }]
      })
      expect(result).toMatchObject({
        chunks: 1,
        model: 'gpt-fake',
        promptVersion: 'importStructure.v1'
      })
      expect(result.proposalIds).toHaveLength(1)
      expect(
        getProposal(manager.require().connection.orm, result.proposalIds[0] ?? '')
      ).toMatchObject({
        feature: 'importStructure',
        nodeId: null,
        status: 'pending'
      })
      expect(fakeWin.webContents.send).toHaveBeenCalledWith('import:detectProgress', {
        done: 1,
        total: 1,
        costUsd: 0
      })
      // Nothing is written to the project: the renderer merges the suggestions into the draft.
      expect((await invoke('tree:list', undefined)).some((row) => row.title === 'The Bell')).toBe(
        false
      )
    })

    it('answers an expected AI failure as data and releases the request id', async () => {
      await ready()
      const draft = await draftFrom(write('Book.md', MARKDOWN))
      // The dial is at Off, which is where every install starts.
      expect(await invoke('import:detectStructure', { draft, requestId: 'd-1' })).toEqual({
        ok: false,
        code: 'DISABLED',
        message: 'Import structure detection needs the AI switch at Ask or Auto (it is at Off).',
        nextStep: AI_NEXT_STEP.DISABLED
      })
      expect(complete).not.toHaveBeenCalled()
      // The id is free again, so asking a second time is not a duplicate.
      expect(await invoke('import:detectStructure', { draft, requestId: 'd-1' })).toMatchObject({
        ok: false
      })
    })

    it('stops the pass when ai:cancel names the request id', async () => {
      const draft = await readyForDetect()
      complete.mockImplementationOnce(untilCancelled)
      const pending = invoke('import:detectStructure', { draft, requestId: 'd-1' })
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
      expect(await invoke('ai:cancel', { requestId: 'd-1' })).toEqual({ cancelled: true })
      expect(await pending).toMatchObject({ ok: false, code: 'CANCELLED' })
      // A failure answers no proposal ids, so main settles what the pass created: nothing is
      // left pending for a renderer that cannot name it.
      const rows = manager.require().connection.orm.select().from(aiProposal).all()
      expect(rows.filter((row) => row.status === 'pending')).toEqual([])
    })

    it('turns each imported scene’s tag candidates into one pending proposal the tag bar can ask for', async () => {
      const draft = await readyForDetect()
      const tagged = {
        ...draft,
        parts: draft.parts.map((part) => ({
          ...part,
          chapters: part.chapters.map((chapter, index) => ({
            ...chapter,
            scenes: chapter.scenes.map((scene) => ({
              ...scene,
              tags: index === 0 ? ['protagonist'] : []
            }))
          }))
        }))
      }
      const { nodes } = await invoke('import:commit', { draft: tagged })
      const scenes = nodes.filter((node) => node.hierarchyLevel === 'scene')
      const first = scenes[0]?.id ?? ''
      const last = scenes.at(-1)?.id ?? ''

      const pending = await invoke('proposal:pendingTags', { nodeId: first })
      expect(pending?.proposalId).toMatch(/^[0-9a-f-]{36}$/)
      expect(pending).toMatchObject({ tags: ['protagonist'], model: 'gpt-fake' })
      // The scene in the untagged chapter has none, and neither has a folder.
      expect(await invoke('proposal:pendingTags', { nodeId: last })).toBeNull()

      // Settled once, it is not offered again (F-14.5).
      await invoke('proposal:settle', { id: pending?.proposalId ?? '', status: 'accepted' })
      expect(await invoke('proposal:pendingTags', { nodeId: first })).toBeNull()
    })
  })
})
