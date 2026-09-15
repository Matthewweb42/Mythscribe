import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  aiFailure,
  testConnectionFailure,
  type AiStatus,
  type AiTestConnectionResult,
  type AiUsageSummary
} from '@shared/ai'
import type { Background } from '@shared/focus'
import type { AiChatResult, AiGhostTextResult, AiRecommendTagsResult } from '@shared/ipc/contract'
import { runChat } from '../ai/chat'
import { dayOf, rollIfNewDay } from '../ai/dailyCap'
import { generateGhostText } from '../ai/ghostText'
import { cancelInflight, regenRequestId } from '../ai/inflight'
import type { AiKeyStore } from '../ai/keyStore'
import { createProposal, settleProposal } from '../ai/proposalStore'
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
import { addBackground, listBackgrounds, removeBackground } from '../project/backgroundStore'
import type { ProjectManager } from '../project/manager'
import { isProjectFolder, projectFolderFor, sanitizeName } from '../project/projectStore'
import { renderDisclosure } from '../provenance/disclosure'
import { buildProvenanceReport } from '../provenance/report'
import {
  getAiSettings,
  getConversations,
  getEditorSettings,
  getFocusSettings,
  getWritingPresets,
  setAiSettings,
  setConversations,
  setEditorSettings,
  setFocusSettings,
  setWritingPresets
} from '../project/settingsStore'
import { fitsEditorMin, normalizeLayout } from '@shared/layout'
import { EXTERNAL_HOST, isAllowedExternalUrl, type EditRole } from '@shared/menu'
import { normalizeProposalNote } from '@shared/proposal'
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
import { buildConsistencyReport } from '../voice/consistency'
import { buildVoiceProfile } from '../voice/profile'
import { bumpVoiceVersion, resetVoiceProfileCache } from '../voice/versionCache'
import { AppError } from './errors'
import { emit, register, type EmitTarget } from './registry'

/** The parts of a BrowserWindow the handlers need; structural so tests can pass a fake. */
export interface ClosableWindow extends EmitTarget {
  close(): void
  setFullScreen(on: boolean): void
  isFullScreen(): boolean
  /** `send` for events, plus the edit commands the in-app Edit menu runs (F-7.1). */
  webContents: EmitTarget['webContents'] & Record<EditRole, () => void>
}

export interface HandlerDeps {
  manager: ProjectManager
  appState: AppStateStore
  keyStore: AiKeyStore
  ai: AiProviderRegistry
  dialogs: ProjectDialogs
  windows: () => ClosableWindow[]
  /** The window with keyboard focus, for the edit commands (F-7.1); null when none has it. */
  focusedWindow: () => ClosableWindow | null
  /** Opens a URL in the default browser (F-7.1); `shell.openExternal` in the app. */
  openExternal: (url: string) => Promise<void>
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
  focusedWindow,
  openExternal,
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

  register('focusSettings:get', () => getFocusSettings(manager.require().connection.orm))

  register('focusSettings:set', (value) =>
    setFocusSettings(manager.require().connection.orm, value)
  )

  // F-6.2: the backgrounds are the files in the project's `assets/backgrounds/` folder.
  register('background:list', () => listBackgrounds(manager.require().folder))

  register('background:add', async () => {
    const session = manager.require()
    const chosen = await dialogs.chooseImages()
    if (chosen === null) return null
    const added: Background[] = []
    const skipped: string[] = []
    for (const source of chosen) {
      try {
        added.push(addBackground(session.folder, source))
      } catch (err) {
        // A refused file (type or size) is reported by name; anything else is a real failure.
        if (err instanceof AppError && err.code === 'VALIDATION')
          skipped.push(path.basename(source))
        else throw err
      }
    }
    return { added, skipped }
  })

  register('background:remove', ({ id }) => {
    const session = manager.require()
    removeBackground(session.folder, id)
    const focus = getFocusSettings(session.connection.orm)
    if (focus.backgroundId === id)
      setFocusSettings(session.connection.orm, { ...focus, backgroundId: null })
    return null
  })

  register('conversations:get', () => getConversations(manager.require().connection.orm))

  register('conversations:set', (value) =>
    setConversations(manager.require().connection.orm, value)
  )

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
  // The batch is one proposal (F-14.5); its content is the suggested names as a historical
  // snapshot (what was offered, not what was linked: linking is the tag bar's accept).
  register(
    'ai:recommendTags',
    async ({ nodeId, note, regeneratedFrom, requestId }): Promise<AiRecommendTagsResult> => {
      try {
        const db = manager.require().connection.orm
        const deps = buildAiRequestDeps({ db, providers: ai, appState })
        const result = await recommendTags(db, deps, nodeId, { note, regeneratedFrom, requestId })
        const proposal = createProposal(db, {
          feature: 'tags',
          nodeId,
          promptVersion: result.promptVersion,
          model: result.model,
          promptTokens: result.usage.inputTokens,
          completionTokens: result.usage.outputTokens,
          costUsd: result.costUsd,
          cached: result.cached,
          content: JSON.stringify(result.suggestions.map((tag) => tag.name)),
          flagged: null,
          violation: null,
          regeneratedFrom: regeneratedFrom ?? null
        })
        return { ok: true, ...result, proposalId: proposal.id }
      } catch (err) {
        if (err instanceof AiProviderError) return aiFailure(err.code, err.message)
        throw err
      }
    }
  )

  // F-5.3: same envelope as `ai:recommendTags`, with the caller's `requestId` on both branches
  // so the renderer can drop an answer that arrived after the caret moved on.
  register(
    'ai:ghostText',
    async ({ nodeId, before, after, requestId }): Promise<AiGhostTextResult> => {
      try {
        const db = manager.require().connection.orm
        const deps = buildAiRequestDeps({ db, providers: ai, appState })
        const result = await generateGhostText(db, deps, { nodeId, before, after, requestId })
        const { text, usage, costUsd, cached, model, flagged, violation } = result
        // F-14.5: a shown suggestion is a proposal; "no suggestion" has nothing to settle.
        const proposalId =
          text === ''
            ? null
            : createProposal(db, {
                feature: 'ghostText',
                nodeId,
                promptVersion: result.promptVersion,
                model,
                promptTokens: usage.inputTokens,
                completionTokens: usage.outputTokens,
                costUsd,
                cached,
                content: text,
                flagged,
                violation
              }).id
        return {
          ok: true,
          text,
          usage,
          costUsd,
          cached,
          model,
          flagged,
          violation,
          proposalId,
          requestId
        }
      } catch (err) {
        if (err instanceof AiProviderError)
          return { ...aiFailure(err.code, err.message), requestId }
        throw err
      }
    }
  )

  // F-5.4: same envelope as `ai:ghostText`. Plan mode streams its answer as `ai:chatDelta`
  // events for the caller's `requestId` before resolving with the whole text; Agent mode
  // resolves only. Every answer is a proposal (F-14.5): a Plan answer stays pending (it never
  // enters the manuscript), an Agent draft settles through ghost text. `flagged` is null for
  // Plan answers, which run no fidelity check.
  register(
    'ai:chat',
    async ({ nodeId, mode, paragraphs, message, history, requestId }): Promise<AiChatResult> => {
      try {
        const db = manager.require().connection.orm
        const deps = buildAiRequestDeps({ db, providers: ai, appState })
        const result = await runChat(
          db,
          deps,
          { nodeId, mode, paragraphs, message, history, requestId },
          (delta) => emit(windows(), 'ai:chatDelta', { requestId, delta })
        )
        const { text, usage, costUsd, cached, model, flagged, violation } = result
        const proposal = createProposal(db, {
          feature: 'chat',
          nodeId,
          promptVersion: result.promptVersion,
          model,
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
          costUsd,
          cached,
          content: text,
          flagged: mode === 'agent' ? flagged : null,
          violation
        })
        return {
          ok: true,
          text,
          usage,
          costUsd,
          cached,
          model,
          flagged,
          violation,
          proposalId: proposal.id,
          requestId
        }
      } catch (err) {
        if (err instanceof AiProviderError)
          return { ...aiFailure(err.code, err.message), requestId }
        throw err
      }
    }
  )

  // F-5.10: aborts the request registered under the id, or its fidelity regenerate (F-14.7)
  // when the second call is the one in flight. Needs no project: the registry is process-wide.
  // The request's own reply comes back as the CANCELLED failure; `cancelled` is false when
  // nothing by that id is in flight (already settled, or never sent).
  register('ai:cancel', ({ requestId }) => {
    const main = cancelInflight(requestId)
    const regen = cancelInflight(regenRequestId(requestId))
    return { cancelled: main || regen }
  })

  // F-14.5: idempotent in the store (only a pending row changes); a blank note is stored as none.
  register('proposal:settle', ({ id, status, note }) => {
    settleProposal(manager.require().connection.orm, id, status, normalizeProposalNote(note))
    return null
  })

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

  // F-14.7: the whole-manuscript report, local and on demand.
  register('voice:consistencyReport', ({ pov }) =>
    buildConsistencyReport(manager.require().connection.orm, { pov })
  )

  // F-14.6: the provenance ledger, read from the saved documents; local and on demand.
  register('provenance:report', () => buildProvenanceReport(manager.require().connection.orm))

  register('provenance:export', async () => {
    const session = manager.require()
    const report = buildProvenanceReport(session.connection.orm)
    const text = renderDisclosure(report, { projectName: session.info.name, date: new Date() })
    const chosen = await dialogs.chooseExportPath(
      `${sanitizeName(session.info.name)}-ai-disclosure.md`,
      [{ name: 'Markdown', extensions: ['md'] }],
      path.dirname(session.folder)
    )
    if (chosen === null) return null
    writeTextAtomic(chosen, text)
    return { path: chosen }
  })

  register('window:close', () => {
    manager.close()
    for (const w of windows()) if (!w.isDestroyed()) w.close()
    return null
  })

  register('window:close-cancelled', () => {
    onCloseCancelled()
    return null
  })

  // F-6.1: the answer is what the window reports, not what was asked for; a window manager
  // that refuses fullscreen leaves the renderer windowed and honest about it.
  register('window:setFullScreen', ({ on }) => {
    const win = windows().find((w) => !w.isDestroyed())
    if (!win) return { on: false }
    win.setFullScreen(on)
    return { on: win.isFullScreen() }
  })

  // F-7.1: the in-app Edit menu edits whatever has the focus, like the native roles do. A click
  // on the bar does not move the focus (the bar prevents it), so the editor or input keeps it.
  register('menu:edit', ({ role }) => {
    const win = focusedWindow() ?? windows().find((w) => !w.isDestroyed())
    if (win && !win.isDestroyed()) win.webContents[role]()
    return null
  })

  register('menu:openExternal', async ({ url }) => {
    if (!isAllowedExternalUrl(url)) {
      throw new AppError('VALIDATION', `Only pages on ${EXTERNAL_HOST} can be opened`)
    }
    await openExternal(url)
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

/** Writes through a sibling temp file and renames, as the app-state store does, so a failed write leaves no half file. */
function writeTextAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}
