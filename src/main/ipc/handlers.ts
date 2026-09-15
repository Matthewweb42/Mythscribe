import { app } from 'electron'
import {
  aiFailure,
  testConnectionFailure,
  type AiStatus,
  type AiTestConnectionResult,
  type AiUsageSummary
} from '@shared/ai'
import type { AiGhostTextResult, AiRecommendTagsResult } from '@shared/ipc/contract'
import { dayOf, rollIfNewDay } from '../ai/dailyCap'
import { generateGhostText } from '../ai/ghostText'
import type { AiKeyStore } from '../ai/keyStore'
import { AiProviderError, NoKeyError } from '../ai/providers/types'
import { recommendTags } from '../ai/recommendTags'
import type { AiProviderRegistry } from '../ai/registry'
import { buildAiRequestDeps } from '../ai/request'
import { ledgerSummary } from '../ai/usageStore'
import type { AppStateStore } from '../appState/appStateStore'
import { removeRecent, toRecentEntry, touchRecent, withExists } from '../appState/recents'
import type { ProjectDialogs } from '../dialogs'
import { getDocumentContent, saveDocument } from '../document/documentStore'
import { getNotes, saveNotes } from '../document/notesStore'
import { getSceneMeta, setSceneMeta } from '../document/sceneMetaStore'
import type { ProjectManager } from '../project/manager'
import { isProjectFolder, projectFolderFor } from '../project/projectStore'
import {
  getAiSettings,
  getEditorSettings,
  getWritingPresets,
  setAiSettings,
  setEditorSettings,
  setWritingPresets
} from '../project/settingsStore'
import { fitsEditorMin, normalizeLayout } from '@shared/layout'
import { addDocumentTag, listDocumentTags, removeDocumentTag } from '../tag/documentTagStore'
import { createTag, deleteTag, listTags, loadTagTemplate, updateTag } from '../tag/tagStore'
import {
  createNode,
  deleteNode,
  duplicateNode,
  listNodes,
  moveNode,
  renameNode,
  toTreeNode
} from '../tree/treeStore'
import { addExemplar, listExemplars, removeExemplar } from '../voice/exemplarStore'
import { buildVoiceProfile } from '../voice/profile'
import { bumpVoiceVersion, resetVoiceProfileCache } from '../voice/versionCache'
import { AppError } from './errors'
import { emit, register, type EmitTarget } from './registry'

/** The parts of a BrowserWindow the handlers need; structural so tests can pass a fake. */
export interface ClosableWindow extends EmitTarget {
  close(): void
}

export interface HandlerDeps {
  manager: ProjectManager
  appState: AppStateStore
  keyStore: AiKeyStore
  ai: AiProviderRegistry
  dialogs: ProjectDialogs
  windows: () => ClosableWindow[]
  /** The renderer abandoned a window close (its flush failed); forget any quit that asked for it. */
  onCloseCancelled: () => void
}

export function registerHandlers({
  manager,
  appState,
  keyStore,
  ai,
  dialogs,
  windows,
  onCloseCancelled
}: HandlerDeps): void {
  register('app:info', () => ({ version: app.getVersion(), platform: process.platform }))

  register('project:create', async ({ name, format, directory }) => {
    const folder = directory
      ? projectFolderFor(directory, name)
      : await dialogs.chooseProjectSavePath(name)
    if (!folder) return null
    return manager.create(folder, name, format)
  })

  register('project:open', async ({ path }) => {
    const folder = path ?? (await dialogs.chooseProjectToOpen())
    if (!folder) return null
    return manager.open(folder)
  })

  register('project:close', () => {
    manager.close()
    return null
  })

  register('project:current', () => manager.current())

  register('recents:list', () => withExists(appState.get().recents, isProjectFolder))

  register('recents:remove', ({ path }) => {
    const next = appState.update((s) => ({ ...s, recents: removeRecent(s.recents, path) }))
    return withExists(next.recents, isProjectFolder)
  })

  register('tree:list', () => listNodes(manager.require().connection.orm).map(toTreeNode))

  register('tree:create', (input) => {
    const session = manager.require()
    return toTreeNode(createNode(session.connection.orm, session.info.format, input))
  })

  register('tree:rename', ({ id, title }) =>
    toTreeNode(renameNode(manager.require().connection.orm, id, title))
  )

  register('tree:duplicate', ({ id }) =>
    duplicateNode(manager.require().connection.orm, id).map(toTreeNode)
  )

  register('tree:delete', ({ id }) => {
    deleteNode(manager.require().connection.orm, id)
    return null
  })

  register('tree:move', ({ id, parentId, afterId }) =>
    toTreeNode(moveNode(manager.require().connection.orm, id, parentId, afterId))
  )

  register('document:get', ({ id }) => getDocumentContent(manager.require().connection.orm, id))

  // F-14.1: every save moves the voice profile's version (a cheap integer; checking whether the
  // document is under the manuscript would cost a lookup on the hot path for nothing).
  register('document:save', ({ id, content }) => {
    const saved = saveDocument(manager.require().connection.orm, id, content)
    bumpVoiceVersion()
    return saved
  })

  register('notes:get', ({ id }) => getNotes(manager.require().connection.orm, id))

  register('notes:save', ({ id, notes }) => saveNotes(manager.require().connection.orm, id, notes))

  register('sceneMeta:get', ({ id }) => getSceneMeta(manager.require().connection.orm, id))

  register('sceneMeta:set', ({ id, meta }) =>
    setSceneMeta(manager.require().connection.orm, id, meta)
  )

  register('editorSettings:get', () => {
    const session = manager.require()
    return getEditorSettings(session.connection.orm, session.info.format)
  })

  register('editorSettings:set', (value) =>
    setEditorSettings(manager.require().connection.orm, value)
  )

  register('aiSettings:get', () => getAiSettings(manager.require().connection.orm))

  register('aiSettings:set', (value) => setAiSettings(manager.require().connection.orm, value))

  register('presets:get', () => getWritingPresets(manager.require().connection.orm))

  register('presets:set', (value) => setWritingPresets(manager.require().connection.orm, value))

  register('tag:list', () => listTags(manager.require().connection.orm))

  register('tag:create', (input) => createTag(manager.require().connection.orm, input))

  register('tag:update', ({ id, ...patch }) =>
    updateTag(manager.require().connection.orm, id, patch)
  )

  register('tag:delete', ({ id }) => {
    deleteTag(manager.require().connection.orm, id)
    return null
  })

  register('tag:loadTemplate', ({ template }) =>
    loadTagTemplate(manager.require().connection.orm, template)
  )

  register('documentTag:list', ({ nodeId }) =>
    listDocumentTags(manager.require().connection.orm, nodeId)
  )

  register('documentTag:add', ({ nodeId, tagId }) =>
    addDocumentTag(manager.require().connection.orm, nodeId, tagId)
  )

  register('documentTag:remove', ({ nodeId, tagId }) =>
    removeDocumentTag(manager.require().connection.orm, nodeId, tagId)
  )

  // A hand-edited app-state file may squeeze the editor; reading normalizes, writing refuses.
  register('layout:get', () => normalizeLayout(appState.get().layout))

  register('layout:set', (layout) => {
    if (!fitsEditorMin(layout)) {
      throw new AppError('VALIDATION', 'The panels leave the editor less than its minimum width')
    }
    return appState.update((s) => ({ ...s, layout })).layout
  })

  // F-5.1: the key is accepted by `ai:setKey` once and never returned; status carries a mask.
  const aiStatus = (): AiStatus => ({
    provider: 'openai',
    hasKey: keyStore.hasKey('openai'),
    hint: keyStore.getHint('openai'),
    encryption: keyStore.encryption(),
    models: appState.get().models.openai
  })

  register('ai:getStatus', aiStatus)

  register('ai:setKey', ({ key }) => {
    keyStore.setKey('openai', key)
    return aiStatus()
  })

  register('ai:clearKey', () => {
    keyStore.clearKey('openai')
    return aiStatus()
  })

  // F-5.11: the registry reads the mapping live, so no provider rebuild follows a change.
  register('ai:setModels', ({ provider, models }) => {
    appState.update((s) => ({ ...s, models: { ...s.models, [provider]: models } }))
    return aiStatus()
  })

  // Expected failures are data (the author acts on them inline); only a bug reaches the envelope.
  register('ai:testConnection', async (): Promise<AiTestConnectionResult> => {
    try {
      const provider = ai.get()
      if (!provider) throw new NoKeyError('No API key is saved.')
      const { model } = await provider.testConnection()
      return { ok: true, model }
    } catch (err) {
      if (err instanceof AiProviderError) return testConnectionFailure(err.code, err.message)
      throw err
    }
  })

  // F-5.14: today's tally and the cap are app-wide (rolled to the current day on read, never
  // written here); the totals are the open project's ledger.
  const usageSummary = (): AiUsageSummary => {
    const { total, byFeature } = ledgerSummary(manager.require().connection.orm)
    const day = rollIfNewDay(appState.get().aiUsage, dayOf(new Date()))
    return {
      today: { requests: day.requestsToday, tokens: day.tokensToday, costUsd: day.spentTodayUsd },
      total,
      byFeature,
      dailyCapUsd: day.dailyCapUsd
    }
  }

  register('ai:usageSummary', usageSummary)

  register('ai:setDailyCap', ({ dailyCapUsd }) => {
    appState.update((s) => ({ ...s, aiUsage: { ...s.aiUsage, dailyCapUsd } }))
    return usageSummary()
  })

  // F-4.7: the AI failures are data with a next step, like `ai:testConnection`; NOT_FOUND and
  // VALIDATION (unknown id, folder, too little text) are `AppError`s and take the envelope.
  register('ai:recommendTags', async ({ nodeId }): Promise<AiRecommendTagsResult> => {
    try {
      const db = manager.require().connection.orm
      const deps = buildAiRequestDeps({ db, providers: ai, appState })
      return { ok: true, ...(await recommendTags(db, deps, nodeId)) }
    } catch (err) {
      if (err instanceof AiProviderError) return aiFailure(err.code, err.message)
      throw err
    }
  })

  // F-5.3: same envelope as `ai:recommendTags`, with the caller's `requestId` on both branches
  // so the renderer can drop an answer that arrived after the caret moved on.
  register(
    'ai:ghostText',
    async ({ nodeId, before, after, requestId }): Promise<AiGhostTextResult> => {
      try {
        const db = manager.require().connection.orm
        const deps = buildAiRequestDeps({ db, providers: ai, appState })
        const { text, usage, costUsd, cached, model } = await generateGhostText(db, deps, {
          nodeId,
          before,
          after
        })
        return { ok: true, text, usage, costUsd, cached, model, requestId }
      } catch (err) {
        if (err instanceof AiProviderError)
          return { ...aiFailure(err.code, err.message), requestId }
        throw err
      }
    }
  )

  // F-14.1: the exemplars and the locally built profile; nothing here calls the provider.
  register('voice:listExemplars', () => listExemplars(manager.require().connection.orm))

  register('voice:addExemplar', ({ nodeId, text }) =>
    addExemplar(manager.require().connection.orm, nodeId, text)
  )

  register('voice:removeExemplar', ({ id }) => {
    removeExemplar(manager.require().connection.orm, id)
    return null
  })

  register('voice:profile', ({ pov }) =>
    buildVoiceProfile(manager.require().connection.orm, { pov })
  )

  register('window:close', () => {
    manager.close()
    for (const w of windows()) if (!w.isDestroyed()) w.close()
    return null
  })

  register('window:close-cancelled', () => {
    onCloseCancelled()
    return null
  })

  manager.onChange((info) => {
    // Open, create, and close all land here: a profile built for one project never answers for another.
    resetVoiceProfileCache()
    if (info) {
      try {
        appState.update((s) => ({ ...s, recents: touchRecent(s.recents, toRecentEntry(info)) }))
      } catch (err) {
        console.warn('Could not record recent project', err)
      }
    }
    emit(windows(), 'project:changed', info)
  })
}
