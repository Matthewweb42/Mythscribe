import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  aiFailure,
  testConnectionFailure,
  type AiStatus,
  type AiTestConnectionResult,
  USAGE_RECENT_LIMIT,
  type AiUsageSummary
} from '@shared/ai'
import { type AiSource, isFeatureAllowed } from '@shared/aiSettings'
import { CHECKOUT_HOST_SUFFIX, isCheckoutUrl } from '@shared/cloudApi'
import type { Background } from '@shared/focus'
import type {
  AiBetaReaderResult,
  AiChatResult,
  AiCritiqueResult,
  AiDraftBriefResult,
  AiGhostTextResult,
  AiQueryResult,
  AiRecommendTagsResult,
  AiRewriteResult,
  AiSummarizeResult,
  JobsIndexAllResult
} from '@shared/ipc/contract'
import {
  SUMMARY_DEBOUNCE_MS,
  SUMMARY_TEXT_MIN,
  UNAVAILABLE_SUMMARY,
  type SceneSummaryState
} from '@shared/summary'
import type { AccountService } from '../account/accountService'
import type { UpdateService } from '../updates/updateService'
import { runBetaReader } from '../ai/betaReader'
import { runChat } from '../ai/chat'
import { runCritique } from '../ai/critique'
import { dayOf, rollIfNewDay } from '../ai/dailyCap'
import { assertFeatureAllowed } from '../ai/dial'
import { draftBrief } from '../ai/draftBrief'
import { generateGhostText } from '../ai/ghostText'
import { cancelInflight, regenRequestId } from '../ai/inflight'
import type { AiKeyStore } from '../ai/keyStore'
import { createProposal, settleProposal } from '../ai/proposalStore'
import { AiProviderError, NoKeyError } from '../ai/providers/types'
import { runQuery } from '../ai/query'
import { recommendTags } from '../ai/recommendTags'
import { runRewrite } from '../ai/rewrite'
import type { AiProviderRegistry } from '../ai/registry'
import { buildAiRequestDeps, type AiRequestDeps } from '../ai/request'
import { createSessionUsage } from '../ai/sessionUsage'
import { staleSummaryNodeIds, summarizeScene, summarySource } from '../ai/summarize'
import { ledgerSummary, recentUsage, type AiDb } from '../ai/usageStore'
import { createIndexQueue } from '../jobs/indexQueue'
import type { AppStateStore } from '../appState/appStateStore'
import { removeRecent, toRecentEntry, touchRecent, withExists } from '../appState/recents'
import type { ProjectDialogs } from '../dialogs'
import { getDocumentContent, saveDocument } from '../document/documentStore'
import { getNotes, saveNotes } from '../document/notesStore'
import { getSceneMeta, setSceneMeta } from '../document/sceneMetaStore'
import { getSummary } from '../document/summaryStore'
import { addBackground, listBackgrounds, removeBackground } from '../project/backgroundStore'
import type { ProjectManager } from '../project/manager'
import { isProjectFolder, projectFolderFor, sanitizeName } from '../project/projectStore'
import { renderDisclosure } from '../provenance/disclosure'
import { buildProvenanceReport } from '../provenance/report'
import {
  getAiSettings,
  getAuthorRules,
  getConversations,
  getEditorSettings,
  getFocusSettings,
  getWritingPresets,
  setAiSettings,
  setAuthorRules,
  setConversations,
  setEditorSettings,
  setFocusSettings,
  setWritingPresets
} from '../project/settingsStore'
import { fitsEditorMin, normalizeLayout } from '@shared/layout'
import { EXTERNAL_HOST, isAllowedExternalUrl, type EditRole } from '@shared/menu'
import { normalizeProposalNote } from '@shared/proposal'
import {
  addDocumentTag,
  listAllDocumentTagLinks,
  listDocumentTags,
  removeDocumentTag
} from '../tag/documentTagStore'
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
  /**
   * F-15.2: the MythScribe account. It owns its own state and poll timer and emits
   * `account:changed` through the `onChange` it was built with in `index.ts`, so these handlers
   * only ask it questions.
   */
  account: AccountService
  /**
   * F-15.7: the update state. Like the account it owns its own timer and pushes
   * `updates:changed` through the `onChange` it was built with in `index.ts`; these handlers
   * only ask it questions and forward the author's choices.
   */
  updates: UpdateService
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
  account,
  updates,
  dialogs,
  windows,
  focusedWindow,
  openExternal,
  onCloseCancelled
}: HandlerDeps): void {
  /**
   * F-5.9: one session tally for this run of the app, shared by every request these handlers
   * make, so "this session, all projects" counts each one exactly once.
   */
  const sessionUsage = createSessionUsage()
  /**
   * F-15.4: where this project's requests go — the author's own key or the MythScribe Cloud
   * proxy — is a project setting, read on every request so a change in the AI tab applies to
   * the next one without rebuilding anything.
   */
  const sourceOf = (db: AiDb): AiSource => getAiSettings(db).source
  const requestDeps = (db: AiDb): AiRequestDeps =>
    buildAiRequestDeps({
      db,
      providers: { get: () => ai.get(sourceOf(db)) },
      appState,
      session: sessionUsage
    })

  /**
   * F-5.13: the background index queue, which took over the F-5.6 summary scheduler. One queue
   * for the session; it reads the open project through the manager at run time, never a
   * captured handle, and `manager.onChange` clears it and loads the next project's jobs, so a
   * run queued for one project never writes into another. Its timers are unref'd: a pending
   * summary never holds the app (or a test) open. Only `summary` jobs exist so far; a new kind
   * is a new branch in `run` (no provider batch API at launch, see `FEATURES.md` F-5.13).
   */
  const queue = createIndexQueue<Awaited<ReturnType<typeof summarizeScene>>>({
    db: () => (manager.current() === null ? null : manager.require().connection.orm),
    run: async (job, requestId) => {
      const db = manager.require().connection.orm
      const result = await summarizeScene(db, requestDeps(db), {
        nodeId: job.nodeId,
        requestId
      })
      // A stored row whose hash still matches (or a cache hit) made no request, so the rate
      // limit must not charge it a turn.
      return { requested: !result.cached, value: result }
    },
    cancelRequest: (requestId) => void cancelInflight(requestId),
    debounceMs: SUMMARY_DEBOUNCE_MS,
    onChange: (status) => emit(windows(), 'jobs:changed', status),
    onNodeStatus: (nodeId, status) => emit(windows(), 'ai:summaryChanged', { nodeId, status })
  })

  /**
   * A node's summary state: `available` only for a manuscript document, `stale` by content
   * hash (never by time), and the queue's status and last error for the node. The hash is
   * computed by `summarySource`, the same function the run hashes with, so "out of date" here
   * and "nothing to do" there can never disagree.
   */
  const summaryStateOf = (nodeId: string): SceneSummaryState => {
    const db = manager.require().connection.orm
    const source = summarySource(db, nodeId)
    if (source === null) return UNAVAILABLE_SUMMARY
    const summary = getSummary(db, nodeId)
    const failure = queue.nodeError(nodeId)
    return {
      available: true,
      summary,
      stale:
        summary === null
          ? source.length >= SUMMARY_TEXT_MIN
          : summary.contentHash !== source.contentHash,
      status: queue.nodeStatus(nodeId),
      // The queue's failure carries its code too; the pane shows what to do about it.
      error: failure === null ? null : { message: failure.message, nextStep: failure.nextStep }
    }
  }

  register('app:info', () => ({ version: app.getVersion(), platform: process.platform }))

  register('project:create', async ({ name, format, directory, aiSource }) => {
    const folder = directory
      ? projectFolderFor(directory, name)
      : await dialogs.chooseProjectSavePath(name)
    if (!folder) return null
    const info = manager.create(folder, name, format)
    // F-15.11: the wizard's choice is written before this answers, so the renderer's first
    // `aiSettings:get` already reads it.
    if (aiSource !== undefined) {
      const orm = manager.require().connection.orm
      const settings = getAiSettings(orm)
      if (settings.source !== aiSource) setAiSettings(orm, { ...settings, source: aiSource })
    }
    return info
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
    const db = manager.require().connection.orm
    const saved = saveDocument(db, id, content)
    bumpVoiceVersion()
    // F-5.6: the summary is rewritten once the author pauses, never on the save itself. The
    // gate is read here, not at run time: a save with summaries off must not show the pane
    // "Updating…" for a run that will never happen, nor leave a run queued for the moment the
    // toggle comes on (one settings row per save; the run gates again anyway).
    if (isFeatureAllowed(getAiSettings(db), 'summary')) queue.touch('summary', id)
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

  // F-14.2: the author's rules are part of the voice profile, so a write invalidates its cache.
  register('authorRules:get', () => getAuthorRules(manager.require().connection.orm))

  register('authorRules:set', (value) => {
    const stored = setAuthorRules(manager.require().connection.orm, value)
    bumpVoiceVersion()
    return stored
  })

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

  register('documentTag:listAll', () => listAllDocumentTagLinks(manager.require().connection.orm))

  // A hand-edited app-state file may squeeze the editor; reading normalizes, writing refuses.
  register('layout:get', () => normalizeLayout(appState.get().layout))

  register('layout:set', (layout) => {
    if (!fitsEditorMin(layout)) {
      throw new AppError('VALIDATION', 'The panels leave the editor less than its minimum width')
    }
    return appState.update((s) => ({ ...s, layout })).layout
  })

  // F-15.2: the MythScribe account. Optional everywhere: no other handler asks whether one is
  // signed in. The service answers each of these with the status as it then stands; a change it
  // makes by itself (the link was opened, or it expired) arrives as `account:changed`.
  register('account:getStatus', () => account.status())

  register('account:requestLink', ({ email }) => account.requestLink(email))

  register('account:cancelLink', () => account.cancelLink())

  register('account:signOut', () => account.signOut())

  register('account:refresh', () => account.refresh())

  // F-15.3: the Cloud credit balance, what each feature has spent, and the packs on sale.
  register('account:getCredits', () => account.credits())

  // The Worker builds the checkout URL (it knows the account and the pack) and this opens it;
  // the app never builds one, and it opens nothing that is not a Lemon Squeezy checkout, so a
  // wrong or tampered answer cannot turn this channel into a general "open any URL".
  register('account:buyCredits', async ({ variantId }) => {
    const url = await account.checkoutUrl(variantId)
    if (!isCheckoutUrl(url)) {
      throw new AppError('VALIDATION', `Only a checkout on ${CHECKOUT_HOST_SUFFIX} can be opened`)
    }
    await openExternal(url)
    return null
  })

  // F-15.7: automatic updates. The service owns the updater, the timer, and what is stored;
  // anything it decides by itself (a background check found a build, a download finished)
  // arrives as `updates:changed`.
  register('updates:getState', () => updates.state())

  register('updates:check', () => updates.check())

  register('updates:setChannel', ({ channel }) => updates.setChannel(channel))

  register('updates:setAutoCheck', ({ on }) => updates.setAutoCheck(on))

  register('updates:markSeen', () => updates.markSeen())

  // The installer starts before this process exits, so the project must already be closed:
  // the renderer flushes its saves and closes it, then invokes this.
  register('updates:install', () => {
    if (manager.current() !== null) {
      throw new AppError('VALIDATION', 'Close the project first, then install the update.')
    }
    updates.install()
    return null
  })

  // F-5.1: the key is accepted by `ai:setKey` once and never returned; status carries a mask.
  const aiStatus = (): AiStatus => ({
    provider: 'openai',
    hasKey: keyStore.hasKey('openai'),
    hint: keyStore.getHint('openai'),
    encryption: keyStore.encryption(),
    // F-15.4: both maps, since the AI tab edits the one the project's source names.
    models: appState.get().models
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
      // F-15.4: the open project decides where the test goes; with none open there is nothing
      // to read the source from, so it is the key path, as it was before Cloud existed.
      const open = manager.current()
      const source = open === null ? 'ownKey' : sourceOf(manager.require().connection.orm)
      const provider = ai.get(source)
      if (!provider) throw new NoKeyError('No API key is saved.')
      const { model } = await provider.testConnection()
      return { ok: true, model }
    } catch (err) {
      if (err instanceof AiProviderError) return testConnectionFailure(err.code, err.message)
      throw err
    }
  })

  // F-5.14: today's tally and the cap are app-wide (rolled to the current day on read, never
  // written here); the totals are the open project's ledger. F-5.9 adds the session tally
  // (this run of the app, every project) and the newest requests of this project.
  const usageSummary = (): AiUsageSummary => {
    const db = manager.require().connection.orm
    const { total, byFeature } = ledgerSummary(db)
    const day = rollIfNewDay(appState.get().aiUsage, dayOf(new Date()))
    return {
      today: { requests: day.requestsToday, tokens: day.tokensToday, costUsd: day.spentTodayUsd },
      session: sessionUsage.totals(),
      total,
      byFeature,
      recent: recentUsage(db, USAGE_RECENT_LIMIT),
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
        const deps = requestDeps(db)
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
        const deps = requestDeps(db)
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
        const deps = requestDeps(db)
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

  // F-14.10: the same envelope again. The first draft streams as `ai:rewriteDelta` events for
  // the caller's `requestId`; the reply comes once the fidelity check (F-14.7) and its one
  // regenerate are done, so the panel only ever offers Accept on a checked rewrite. The
  // proposal (F-14.5) records the range the rewrite targets as it stood when the author asked
  // (a snapshot; the editor maps the live range itself) and the proposal it replaces.
  register(
    'ai:rewrite',
    async ({
      nodeId,
      from,
      to,
      text,
      before,
      after,
      requestId,
      note,
      regeneratedFrom
    }): Promise<AiRewriteResult> => {
      try {
        const db = manager.require().connection.orm
        const deps = requestDeps(db)
        const result = await runRewrite(
          db,
          deps,
          { nodeId, text, before, after, note, regeneratedFrom, requestId },
          (delta) => emit(windows(), 'ai:rewriteDelta', { requestId, delta })
        )
        const { usage, costUsd, cached, model, flagged, violation } = result
        const proposal = createProposal(db, {
          feature: 'rewrite',
          nodeId,
          promptVersion: result.promptVersion,
          model,
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
          costUsd,
          cached,
          content: result.text,
          flagged,
          violation,
          targetFrom: from,
          targetTo: to,
          regeneratedFrom: regeneratedFrom ?? null
        })
        return {
          ok: true,
          text: result.text,
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

  // F-14.8: editor's notes on one scene, JSON from the strong tier, not streamed (the notes
  // are only useful whole). The reply carries the notes as main located them — every quote is
  // in the text that was sent, `dropped` counts the ones that were not — and the proposal
  // (F-14.5) holds them as JSON, flagged when any fix failed the fidelity check (F-14.7).
  // Nothing enters the manuscript here: the renderer applies a fix only on Apply.
  register(
    'ai:critique',
    async ({ nodeId, requestId, note, regeneratedFrom }): Promise<AiCritiqueResult> => {
      try {
        const db = manager.require().connection.orm
        const deps = requestDeps(db)
        const result = await runCritique(db, deps, { nodeId, note, regeneratedFrom, requestId })
        const { notes, usage, costUsd, cached, model } = result
        const flaggedNote = notes.find((entry) => entry.flagged)
        const proposal = createProposal(db, {
          feature: 'critique',
          nodeId,
          promptVersion: result.promptVersion,
          model,
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
          costUsd,
          cached,
          content: JSON.stringify(notes),
          flagged: flaggedNote !== undefined,
          violation: flaggedNote?.violation ?? null,
          regeneratedFrom: regeneratedFrom ?? null
        })
        return {
          ok: true,
          notes,
          truncated: result.truncated,
          dropped: result.dropped,
          usage,
          costUsd,
          cached,
          model,
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

  // F-14.11: the beta-reader read-through up to one scene, JSON from the strong tier, not
  // streamed (a report is only useful whole). The reply carries the items as main located them
  // — every quote is in the scene the item names, as that scene was sent — with the scenes the
  // reader read and what the budget left out, and the proposal (F-14.5) holds the items as
  // JSON. Nothing is flagged and nothing is applied: a reader reports, the editor's notes fix.
  register(
    'ai:betaReader',
    async ({ nodeId, requestId, note, regeneratedFrom }): Promise<AiBetaReaderResult> => {
      try {
        const db = manager.require().connection.orm
        const deps = requestDeps(db)
        const result = await runBetaReader(db, deps, { nodeId, note, regeneratedFrom, requestId })
        const { items, usage, costUsd, cached, model } = result
        const proposal = createProposal(db, {
          feature: 'betaReader',
          nodeId,
          promptVersion: result.promptVersion,
          model,
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
          costUsd,
          cached,
          content: JSON.stringify(items),
          flagged: false,
          violation: null,
          regeneratedFrom: regeneratedFrom ?? null
        })
        return {
          ok: true,
          items,
          scenes: result.scenes,
          truncated: result.truncated,
          skipped: result.skipped,
          missing: result.missing,
          dropped: result.dropped,
          usage,
          costUsd,
          cached,
          model,
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

  // F-5.7: one Story Intelligence turn. Main ranks the manuscript's scenes locally, sends the
  // top matches, and verifies every citation against the text it sent, so the reply carries
  // only passages the scenes really hold — `dropped` counts the rest, `uncited` says the answer
  // rests on none, `found: false` is the grounded "not found". JSON from the strong tier, not
  // streamed (the citations are checked before anything is shown). The proposal (F-14.5) holds
  // the answer and its citations and stays pending, as a Plan answer does: nothing here enters
  // the manuscript.
  register('ai:query', async ({ nodeId, message, history, requestId }): Promise<AiQueryResult> => {
    try {
      const db = manager.require().connection.orm
      const deps = requestDeps(db)
      const result = await runQuery(db, deps, { nodeId, message, history, requestId })
      const { answer, found, uncited, citations, also, dropped, usage, costUsd, cached, model } =
        result
      const proposal = createProposal(db, {
        feature: 'query',
        nodeId,
        promptVersion: result.promptVersion,
        model,
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        costUsd,
        cached,
        content: JSON.stringify({ answer, citations }),
        flagged: false,
        violation: null
      })
      return {
        ok: true,
        answer,
        found,
        uncited,
        citations,
        also,
        dropped,
        usage,
        costUsd,
        cached,
        model,
        proposalId: proposal.id,
        requestId
      }
    } catch (err) {
      if (err instanceof AiProviderError) return { ...aiFailure(err.code, err.message), requestId }
      throw err
    }
  })

  // F-14.3: the scene brief drafted from the scene's text, JSON from the fast tier, not
  // streamed (five short lines are only useful whole). Nothing is stored on the node: the
  // draft is a pending proposal (F-14.5) the metadata pane offers as Use draft, which writes
  // the fields through `sceneMeta:set` like any other edit.
  register('ai:draftBrief', async ({ nodeId, requestId }): Promise<AiDraftBriefResult> => {
    try {
      const db = manager.require().connection.orm
      const deps = requestDeps(db)
      const result = await draftBrief(db, deps, { nodeId, requestId })
      const { brief, usage, costUsd, cached, model } = result
      const proposal = createProposal(db, {
        feature: 'brief',
        nodeId,
        promptVersion: result.promptVersion,
        model,
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        costUsd,
        cached,
        content: JSON.stringify(brief),
        flagged: false,
        violation: null
      })
      return {
        ok: true,
        brief,
        truncated: result.truncated,
        usage,
        costUsd,
        cached,
        model,
        proposalId: proposal.id,
        requestId
      }
    } catch (err) {
      if (err instanceof AiProviderError) return { ...aiFailure(err.code, err.message), requestId }
      throw err
    }
  })

  // F-5.6: the pane reads the node's summary, whether it is out of date, and what the last
  // background run did. Cheap: two small queries and the scheduler's own maps.
  register('summary:get', ({ id }) => summaryStateOf(id))

  // F-5.6: Summarize now. The node's debounce is cancelled and its run awaited ahead of the
  // queue (a run already in flight is joined, not doubled); a content-hash match answers from
  // the stored row without a request. The queue records the status either way, so the pane's
  // event and this reply agree. VALIDATION (not a manuscript document, too little text) comes
  // back through the error envelope; the expected AI failures come back as data, like the rest.
  register('ai:summarize', async ({ nodeId, requestId }): Promise<AiSummarizeResult> => {
    try {
      const result = await queue.runNow('summary', nodeId, requestId)
      return {
        ok: true,
        state: summaryStateOf(nodeId),
        usage: result.usage,
        costUsd: result.costUsd,
        cached: result.cached,
        model: result.model,
        requestId
      }
    } catch (err) {
      if (err instanceof AiProviderError) return { ...aiFailure(err.code, err.message), requestId }
      throw err
    }
  })

  // F-5.13: the index queue. `status` is what the header indicator shows, `cancel` stops
  // everything (the job in flight is aborted through the inflight registry), `resume` clears a
  // pause and puts the failed jobs back in the queue. Each answers the queue as it then stands,
  // and the same status goes to every window as `jobs:changed`.
  register('jobs:status', () => queue.status())

  register('jobs:cancel', () => queue.cancelAll())

  register('jobs:resume', () => queue.resume())

  // F-5.13: "Summarize all scenes". Only the scenes that would show "Out of date" are queued
  // (`staleSummaryNodeIds`), so a second click over an indexed manuscript queues nothing and
  // costs nothing. The dial and the toggle are checked here, once, and come back as data like
  // `ai:summarize`'s failures; the runs gate again anyway.
  register('jobs:indexAll', (): JobsIndexAllResult => {
    const db = manager.require().connection.orm
    try {
      assertFeatureAllowed(getAiSettings(db), 'summary')
    } catch (err) {
      if (err instanceof AiProviderError) return aiFailure(err.code, err.message)
      throw err
    }
    const queued = queue.indexAll('summary', staleSummaryNodeIds(db))
    return { ok: true, queued, status: queue.status() }
  })

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
    // F-5.13: drop every pending job, timer, and status with the project that queued them;
    // the rows stay in that project's database, so opening it again takes the work up where it
    // stopped (`load` on an empty table does nothing, which is what a create lands on).
    queue.clear()
    if (info) {
      queue.load()
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
