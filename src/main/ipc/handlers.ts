import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  aiFailure as aiFailureEnvelope,
  AiFeatureId,
  testConnectionFailure,
  type AiErrorCode,
  type AiStatus,
  type AiTestConnectionResult,
  USAGE_RECENT_LIMIT,
  type AiUsageSummary,
  type OwnKeyProvider
} from '@shared/ai'
import type { AiModelChoice } from '@shared/aiRouting'
import { TRIAL_ENDED_MESSAGE } from '@shared/appAccess'
import { aliasKey } from '@shared/aliases'
import { type AiSource, aiSwitchPatch, isFeatureAllowed } from '@shared/aiSettings'
import { BOOK_COVER_DIR, bookTitle } from '@shared/bookDetails'
import {
  COMPILE_OUTPUT_EXTENSIONS,
  COMPILE_OUTPUT_LABELS,
  sortFormats
} from '@shared/compileFormat'
import { CHECKOUT_HOST_SUFFIX, isCheckoutUrl, type PricingResult } from '@shared/cloudApi'
import { bundledPricing, hostedQuote } from '@shared/hostedPricing'
import { aiRequestCounter } from '@shared/diagnostics'
import { formatDiagnosticsReport } from '@shared/devtools'
import { ENTITY_IMAGES_DIR } from '@shared/entities'
import {
  ENTITY_EXCHANGE_EXTENSIONS,
  ENTITY_EXCHANGE_LABEL,
  entityExportFileName,
  planEntityImport,
  toExchangeRecord
} from '@shared/entityExchange'
import type { Background } from '@shared/focus'
import type { ContextProcessResult } from '@shared/contextLibrary'
import type { OrganisePlanResult } from '@shared/organise'
import type { ReviewChatResult } from '@shared/reviewChat'
import type { ImportDetectResult, PendingTagProposal } from '@shared/importStructure'
import { MENTION_DEBOUNCE_MS } from '@shared/mentions'
import { VOICE_JOB_DEBOUNCE_MS } from '@shared/voice'
import { PLAN_LINKS_DEBOUNCE_MS, type PlanLinksRunResult } from '@shared/planLinks'
import type {
  AiBetaReaderResult,
  AiChatResult,
  AiContinuityResult,
  AiCritiqueResult,
  AiProofreadResult,
  EditPassStartResult,
  AiDraftBriefResult,
  AiGhostTextResult,
  AiAgentResult,
  AiQueryResult,
  AiRecommendTagsResult,
  AiRewriteResult,
  AiSummarizeResult,
  AiWhatNextResult,
  AiRouteResult,
  AiSuggestNotesResult,
  AiSuggestSynopsisResult,
  ChangeUndoReply,
  Channel,
  Entity,
  IpcError,
  JobsIndexAllResult
} from '@shared/ipc/contract'
import {
  SUMMARY_BACKFILL_DELAY_MS,
  SUMMARY_DEBOUNCE_MS,
  SUMMARY_TEXT_MIN,
  UNAVAILABLE_SUMMARY,
  type SceneSummaryState
} from '@shared/summary'
import { UI_SCALE_FACTORS, nextZoom, type ViewSettings } from '@shared/zoom'
import {
  BUILT_IN_THEME_IDS,
  CUSTOM_THEMES_MAX,
  THEME_NEEDS_LICENSE_MESSAGE,
  THEME_NOT_FOUND_MESSAGE,
  themeBackground,
  themeNeedsLicense
} from '@shared/themes'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import type { AccountService } from '../account/accountService'
import type { AppAccessService } from '../account/appAccess'
import type { BackupService } from '../backups/backupService'
import type { CloudSyncService } from '../project/cloudSyncService'
import type { DiagnosticsService } from '../diagnostics/diagnosticsService'
import type { DevToolsService } from '../devtools/devToolsService'
import type { UpdateService } from '../updates/updateService'
import { runBetaReader } from '../ai/betaReader'
import { runChat } from '../ai/chat'
import {
  runBackgroundContinuity,
  runContinuity,
  settleContinuityFinding,
  storeContinuityRun
} from '../ai/continuity'
import { listOpenFindings } from '../ai/continuityFindingStore'
import { runCritique } from '../ai/critique'
import { runProofread } from '../ai/proofread'
import { createEditPassRunner } from '../ai/editPass'
import {
  deletePass,
  getPresets,
  interruptRunningPasses,
  listPassRows,
  passDetail,
  pendingChangesFor,
  proposalChangeCounts,
  requirePass,
  setPresets,
  settleChanges,
  toSummary
} from '../editPass/editPassStore'
import { dayOf, rollIfNewDay } from '../ai/dailyCap'
import { assertFeatureAllowed } from '../ai/dial'
import { draftBrief } from '../ai/draftBrief'
import { generateGhostText } from '../ai/ghostText'
import { detectImportStructure } from '../ai/importStructure'
import { estimateContextImport, sortContextFiles } from '../ai/contextImport'
import { runOrganise } from '../ai/organise'
import { runReviewChat } from '../ai/reviewChat'
import { cancelInflight, regenRequestId, registerInflight, releaseInflight } from '../ai/inflight'
import type { AiKeyStore } from '../ai/keyStore'
import type { AutoTagsChange } from '../ai/autoTags'
import {
  convertKnowledgeIndex,
  convertThreadRecords,
  ensureRecordForTag,
  ensureRecordsForTags,
  makeRecordForTag
} from '../knowledge/records'
import { prunePassages } from '../search/passageIndex'
import type { ObservedFactsChange } from '../ai/observedFacts'
import { IMPORT_STRUCTURE_PROMPT_VERSION } from '../ai/prompts/importStructure.v1'
import { createProposal, listPendingProposals, settleProposal } from '../ai/proposalStore'
import { clearVoiceNotes } from '../ai/voiceNotes'
import {
  AiCancelledError,
  AiCutOffError,
  AiProviderError,
  AiTrialEndedError,
  NoKeyError
} from '../ai/providers/types'
import { runQuery } from '../ai/query'
import { runAgent } from '../ai/agent'
import { draftForAgent } from '../ai/agentDraft'
import { runWhatNext } from '../ai/whatNext'
import { runRoute } from '../ai/route'
import { runSuggestNotes, runSuggestSynopsis } from '../ai/sceneSuggest'
import { recommendTags } from '../ai/recommendTags'
import { runRewrite } from '../ai/rewrite'
import type { AiProviderRegistry } from '../ai/registry'
import { buildAiRequestDeps, type AiRequestDeps } from '../ai/request'
import { createSessionUsage } from '../ai/sessionUsage'
import { staleSummaryNodeIds, summarizeScene, summarySource } from '../ai/summarize'
import { ledgerSummary, recentUsage, usageHistory, type AiDb } from '../ai/usageStore'
import { createIndexQueue } from '../jobs/indexQueue'
import { createSheetSyncService } from '../ai/sheetSyncService'
import { rebaseAuthorPage, staleWriteUpBase } from '../ai/sheetSync'
import { setCategoryFields } from '../entity/categoryFields'
import {
  confirmPlanLink,
  dismissPlanLink,
  getPlanLinks,
  runPlanLinks,
  unlinkPlan
} from '../ai/planLinks'
import type { AppStateStore } from '../appState/appStateStore'
import { removeRecent, toRecentEntry, touchRecent, withExists } from '../appState/recents'
import type { ProjectDialogs } from '../dialogs'
import { compileManuscript, compileSource } from '../document/compileStore'
import { createFormat, deleteFormat, saveFormat } from '../export/formatLibrary'
import { renderPdf } from '../export/pdf'
import { compileToFile } from '../export/run'
import {
  compareDrafts,
  deleteDraft,
  duplicateDraft,
  listDrafts,
  renameDraft,
  revertDocuments,
  switchDraft
} from '../draft/draftStore'
import { getDocumentContent, saveDocument, type SaveResult } from '../document/documentStore'
import {
  compareSnapshot,
  deleteSnapshot,
  listSnapshots,
  restoreSnapshot,
  takeSnapshot,
  updateSnapshot
} from '../snapshot/snapshotStore'
import {
  goalsStatus,
  manuscriptWordCount,
  recordWriting,
  resetGoalsSession,
  updateGoals
} from '../goals/goalsStore'
import { importEntities, readEntityFile, writeEntityFile } from '../entity/entityExchange'
import { applyContextReview } from '../library/apply'
import {
  addContextFiles,
  listContextFiles,
  requireContextFileRow,
  storedPath
} from '../library/libraryStore'
import { getNotes, saveNotes } from '../document/notesStore'
import { getSceneMeta, setSceneMeta } from '../document/sceneMetaStore'
import { getSummary } from '../document/summaryStore'
import { wordCountReport } from '../document/wordCountReport'
import {
  addEntityField,
  createEntity,
  removeEntityField,
  deleteEntity,
  getEntity,
  linkEntityTag,
  listEntities,
  mergeEntities,
  setEntityImage,
  updateEntity,
  type EntityTagChange,
  type EntityWrite
} from '../entity/entityStore'
import { loadOrganiseProject, organiseCandidates } from '../organise/organiseProject'
import {
  createCategory,
  listCategories,
  requireCategory,
  updateCategory
} from '../entity/categoryStore'
import type { Fact } from '@shared/facts'
import type { KnowledgeConversion } from '@shared/knowledge'
import { relationAttribute } from '@shared/relations'
import { threadAttribute } from '@shared/threads'
import {
  addAuthorStatement,
  deleteAuthorStatement,
  listFactsForEntity,
  setFactHidden,
  setFactStatus
} from '../entity/factStore'
import { listThreads } from '../knowledge/threads'
import { TODO_DEBOUNCE_MS, type TodoCheckResult, type TodoSuggestResult } from '@shared/todo'
import { sceneCardFor } from '../knowledge/sceneCard'
import { confirmConversion, conversionPending, estimateConversion } from '../knowledge/conversion'
import {
  listChanges,
  noteCreatedSheet,
  noteCreatedTag,
  recordChanges,
  undoChange,
  undoRun,
  type UndoOutcome
} from '../knowledge/changeLog'
import { changeRunId } from '@shared/changes'
import { clearStoryBible } from '../knowledge/bibleClear'
import { convertKnowledgeFacts } from '../knowledge/factConversion'
import { listTodo, reopenTodo, settleTodo, syncLocalTodo } from '../knowledge/todoStore'
import {
  runTodoPass,
  suggestTodo,
  todoCheckEstimate,
  todoCheckView,
  type TodoCheckContext,
  type TodoCheckEstimate
} from '../ai/todoPass'
import { importDraft, type ImportResult } from '../import/commit'
import { withExisting } from '../import/existing'
import { readManuscript } from '../import/read'
import { buildDraft } from '../import/structure'
import { addBackground, listBackgrounds, removeBackground } from '../project/backgroundStore'
import { addImageAsset, removeImageAsset } from '../project/imageAssets'
import {
  clearRecovery,
  discardRecovery,
  readRecovery,
  stashRecovery,
  type RecoveryEntry
} from '../project/recoveryJournal'
import {
  addReferenceImage,
  pruneReferencePins,
  removeReferenceImage
} from '../project/referenceStore'
import type { ProjectManager } from '../project/manager'
import {
  isProjectFolder,
  locateProject,
  projectFolderFor,
  sanitizeName
} from '../project/projectStore'
import { convertLegacyProject, legacyBackupPath } from '../project/legacyImport'
import { writeTextAtomic } from '../fs'
import { renderDisclosure } from '../provenance/disclosure'
import {
  clearReplaceUndo,
  commitReplace,
  previewReplace,
  undoReplace
} from '../search/replaceStore'
import { clearSearchCache, searchProject } from '../search/searchStore'
import { buildProvenanceReport } from '../provenance/report'
import { projectSpellingWords } from '../spellcheck/projectWords'
import { statsDashboard } from '../stats/dashboardStore'
import {
  getAiSettings,
  getAuthorRules,
  getStoryBibleSettings,
  setStoryBibleSettings,
  getConversations,
  getDismissedNames,
  getKeptSpellings,
  setKeptSpellings,
  getEditorSettings,
  getFocusSettings,
  getProjectDictionary,
  getProjectSession,
  getProjectStructure,
  getProjectTimeline,
  getReferencePins,
  getTagAliases,
  getVoiceNotes,
  getWritingPresets,
  getBookDetails,
  getCompileState,
  setAiSettings,
  setAuthorRules,
  setBookDetails,
  setCompileState,
  setConversations,
  setEditorSettings,
  setFocusSettings,
  setProjectDictionary,
  setProjectSession,
  setProjectStructure,
  setReferencePins,
  setWritingPresets
} from '../project/settingsStore'
import { setProjectTimeline } from '../project/timelineStore'
import { addNotName, addWord, removeWord } from '@shared/dictionary'
import { fitsEditorMin, normalizeLayout } from '@shared/layout'
import { EXTERNAL_HOST, isAllowedExternalUrl, type EditRole } from '@shared/menu'
import { normalizeProposalNote } from '@shared/proposal'
import { REFERENCE_PINS_MAX, dedupePins, hasPin } from '@shared/references'
import {
  TAG_EXCHANGE_EXTENSION,
  tagExportFileName,
  type TagExchangeRecord
} from '@shared/tagExchange'
import { keepTemplateRecords } from '@shared/tagTemplates'
import {
  addDocumentTag,
  listAllDocumentTagLinks,
  listDocumentTags,
  removeDocumentTag
} from '../tag/documentTagStore'
import { deleteMentionsForTag, listMentionsForNode, listMentionsForTag } from '../tag/mentionStore'
import { dismissName, listProposedTags, resetProposedTagCache } from '../tag/proposedTags'
import { scanMentions, staleMentionNodeIds } from '../tag/scanMentions'
import { readTagBankFile, writeTagBankFile } from '../tag/tagExchange'
import {
  createTag,
  deleteTag,
  deleteTags,
  exportTagBank,
  getTag,
  getTagWithUsage,
  importTagBank,
  listTags,
  loadTagTemplate,
  mergeTags,
  recolorTags,
  updateTag
} from '../tag/tagStore'
import {
  createNode,
  deleteNode,
  duplicateNode,
  getNode,
  listNodes,
  moveNode,
  renameNode,
  toTreeNode,
  type TreeDb
} from '../tree/treeStore'
import { addExemplar, listExemplars, removeExemplar } from '../voice/exemplarStore'
import { buildConsistencyReport } from '../voice/consistency'
import { buildVoiceProfile, manuscriptDocuments } from '../voice/profile'
import { bumpVoiceVersion, resetVoiceProfileCache } from '../voice/versionCache'
import {
  manuscriptRootId,
  runVoiceJob,
  type VoiceJobMemo,
  type VoiceJobResult
} from '../voice/voiceJob'
import { AppError } from './errors'
import {
  addCustomTemplate,
  removeCustomTemplate,
  updateCustomTemplate
} from '../tag/customTemplates'
import { isWriteChannel } from './channelAccess'
import { emit, register as registerChannel, type EmitTarget, type Handler } from './registry'

/** The parts of a BrowserWindow the handlers need; structural so tests can pass a fake. */
export interface ClosableWindow extends EmitTarget {
  close(): void
  /** F-7.8: the colour behind the page, so a resize or a reload never flashes the old theme. */
  setBackgroundColor(color: string): void
  setFullScreen(on: boolean): void
  isFullScreen(): boolean
  /**
   * `send` for events, the edit commands the in-app Edit menu runs (F-7.1), and the window's
   * zoom factor, which carries the interface size (F-7.10).
   */
  webContents: EmitTarget['webContents'] &
    Record<EditRole, () => void> & {
      setZoomFactor(factor: number): void
      /** F-3.11: swaps the misspelled word under the caret for a suggestion. */
      replaceMisspelling(word: string): void
    }
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
   * AI-BILLING-SPEC M1: the trial and the license. Every `write` channel (`channelAccess.ts`)
   * and every AI request asks it first; after the trial without the license both are refused.
   */
  access: AppAccessService
  /**
   * F-15.7: the update state. Like the account it owns its own timer and pushes
   * `updates:changed` through the `onChange` it was built with in `index.ts`; these handlers
   * only ask it questions and forward the author's choices.
   */
  updates: UpdateService
  /**
   * F-15.8: opt-in diagnostics. Off on every install; it records nothing until the author turns
   * it on, and these handlers only read it and forward the switch. Main counts and reports
   * through the same service at the places that own those events.
   */
  diagnostics: DiagnosticsService
  /**
   * Developer tools (2026-10-07): the live log and the AI inspector, in memory only and only
   * while the author's switch is on. Every channel's error envelope and every AI request is
   * reported to it; it drops them itself while off.
   */
  devtools: DevToolsService
  /**
   * F-8.4: automatic backups. Like the update service it owns its settings, its timer, and what
   * it pushes (`backups:changed`); these handlers forward the author's choices and wire it to
   * the project's open and close.
   */
  backups: BackupService
  /**
   * 2026-10-08: copies a project in a cloud-synced folder back from its working copy while it is
   * open. Absent (the unit tests) every project is in a plain folder and the channels answer null.
   */
  cloudSync?: CloudSyncService
  /**
   * AI-BILLING-SPEC P5: the hosted price table (`GET /pricing`), cached in app state and fetched
   * again once it is an hour old. Absent in a build with no Cloud wiring: the cache alone answers.
   */
  cloudPricing?: { refresh(): Promise<PricingResult | null> }
  dialogs: ProjectDialogs
  windows: () => ClosableWindow[]
  /** The window with keyboard focus, for the edit commands (F-7.1); null when none has it. */
  focusedWindow: () => ClosableWindow | null
  /**
   * F-3.11: the spellchecker's custom words, kept equal to the open project's dictionary. Built
   * in `index.ts` from the default session; it never rejects (its own error handler logs).
   */
  spellDictionary: { sync(words: string[]): Promise<void> }
  /** Opens a URL in the default browser (F-7.1); `shell.openExternal` in the app. */
  openExternal: (url: string) => Promise<void>
  /**
   * Opens a folder in the OS file manager (F-8.4); `shell.openPath` in the app, which answers
   * an error message (empty on success) rather than throwing.
   */
  openPath: (folder: string) => Promise<string>
  /** The renderer abandoned a window close (its flush failed); forget any quit that asked for it. */
  onCloseCancelled: () => void
}

export function registerHandlers({
  manager,
  appState,
  keyStore,
  ai,
  account,
  access,
  updates,
  diagnostics,
  devtools,
  backups,
  cloudSync,
  cloudPricing,
  dialogs,
  windows,
  focusedWindow,
  spellDictionary,
  openExternal,
  openPath,
  onCloseCancelled
}: HandlerDeps): void {
  /**
   * AI-BILLING-SPEC M1: every channel is registered through the read-only gate. A `write` channel
   * is refused after the trial without the license; reading, export, and backup never are.
   */
  const register = <C extends Channel>(channel: C, fn: Handler<C>): void => {
    // Developer tools: every error envelope reaches the live log (a no-op while it is off).
    const onFailure = (failed: Channel, error: IpcError, cause?: unknown): void =>
      devtools.ipcFailure(failed, error, cause)
    if (!isWriteChannel(channel)) {
      registerChannel(channel, fn, onFailure)
      return
    }
    registerChannel(
      channel,
      (input) => {
        access.assertWritable()
        return fn(input)
      },
      onFailure
    )
  }
  /**
   * The failure envelope every AI channel answers with. Developer tools: the request path traces
   * and logs its own failures, but a feature the AI switch or its toggle forbids is refused
   * before any request exists (DISABLED), so that refusal is logged here.
   */
  const aiFailure = (code: AiErrorCode, message: string): ReturnType<typeof aiFailureEnvelope> => {
    if (code === 'DISABLED') devtools.record('warn', 'ai', `AI refused: ${code}: ${message}`, null)
    return aiFailureEnvelope(code, message)
  }
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
  /** The provider a project's requests go to, refused outright once the app is read-only. */
  const providerFor = (db: AiDb): ReturnType<AiProviderRegistry['get']> => {
    if (!access.writable()) throw new AiTrialEndedError(TRIAL_ENDED_MESSAGE)
    return ai.get(sourceOf(db))
  }
  const requestDeps = (db: AiDb): AiRequestDeps => {
    const deps = buildAiRequestDeps({
      db,
      providers: { get: () => providerFor(db) },
      appState,
      session: sessionUsage
    })
    // F-15.8: one count per request, at the ledger row every request writes — a cache hit
    // included, which is what the ledger counts as a request too. The stored feature is a
    // column, so it is checked against the enum before it can become a counter name.
    return {
      ...deps,
      // Developer tools' AI inspector: a trace per request while the switch is on.
      observe: devtools.observer,
      ledger: {
        insert: (entry) => {
          deps.ledger.insert(entry)
          const feature = AiFeatureId.safeParse(entry.feature)
          if (feature.success) diagnostics.count(aiRequestCounter(feature.data))
        }
      }
    }
  }

  /**
   * F-5.13: the background index queue, which took over the F-5.6 summary scheduler. One
   * instance per kind of work for the session; each reads the open project through the manager
   * at run time, never a captured handle, and `manager.onChange` clears it and loads the next
   * project's jobs, so a run queued for one project never writes into another. Their timers are
   * unref'd: a pending summary never holds the app (or a test) open.
   *
   * There are two: this one for `summary` jobs, which needs a key and pauses without one, and
   * `mentionQueue` below for F-4.12's local scan, which must run whatever the dial says. They
   * share `index_job` and each passes its `kind`, so neither ever sees the other's rows (no
   * provider batch API at launch, see `FEATURES.md` F-5.13).
   */
  /**
   * F-13.4: the context each scene's last background consistency check was made from, for this
   * session and this project (`manager.onChange` clears it). A summary run over a scene whose
   * candidate paragraphs and references have not moved asks nothing again.
   */
  const continuityChecked = new Map<string, string>()
  const queue = createIndexQueue<Awaited<ReturnType<typeof summarizeScene>>>({
    kind: 'summary',
    db: () => (manager.current() === null ? null : manager.require().connection.orm),
    run: async (job, requestId) => {
      const db = manager.require().connection.orm
      const deps = requestDeps(db)
      const result = await summarizeScene(db, deps, {
        nodeId: job.nodeId,
        requestId,
        onFactsChanged: (change) => publishObservedFacts(db, change),
        onTagsChanged: (change) => publishAutoTags(db, job.nodeId, change),
        onChangesLogged: () => emit(windows(), 'changes:changed', {})
      })
      // F-13.4: with the scene's facts in place, the quiet consistency check. Local unless a
      // fact of this scene differs from the sheet or from another scene, silent when the dial
      // or its toggle forbids it, and never the summary's failure: the summary is stored and
      // paid for by now, so any error of the check (provider, parse, budget) is dropped here.
      // The memo is not set on a throw, so the scene's next summary run checks again. Only a
      // cancel is passed on, so Stop still stops the job. Nothing is shown but the panel's count.
      let checked: Awaited<ReturnType<typeof runBackgroundContinuity>>
      try {
        checked = await runBackgroundContinuity(db, deps, {
          nodeId: job.nodeId,
          requestId,
          memo: continuityChecked
        })
        if (checked !== null) {
          const stored = storeContinuityRun(db, job.nodeId, 'background', checked, deps.now())
          if (stored.changed) emit(windows(), 'continuity:changed', { nodeIds: [job.nodeId] })
        }
      } catch (err) {
        if (err instanceof AiCancelledError) throw err
        checked = null
      }
      // F-11.1d: a scene with a fresh summary may fulfil a plan; one debounced plan-link job per
      // burst, gated here so a project with the feature off never queues one.
      if (!result.cached) queuePlanLinks(db)
      // F-9.16: the scene's facts, threads, and findings may have moved the To do list.
      queueTodo(db)
      // A stored row whose hash still matches (or a cache hit) made no request, so the rate
      // limit must not charge it a turn; a check that went out is a request like any other.
      const asked = checked !== null && checked.requested && !checked.cached
      return { requested: !result.cached || asked, value: result }
    },
    cancelRequest: (requestId) => void cancelInflight(requestId),
    debounceMs: SUMMARY_DEBOUNCE_MS,
    onChange: (status) => emit(windows(), 'jobs:changed', status),
    onNodeStatus: (nodeId, status) => emit(windows(), 'ai:summaryChanged', { nodeId, status })
  })

  /**
   * F-9.16: the To do list's own queue, one `todo` job per project keyed to the manuscript root,
   * debounced past a burst of knowledge changes. Local and free: it syncs the open items the
   * local rules find (`syncLocalTodo`) and tells the windows when the list moved. Never an AI
   * request: the whole-book check runs only when the author clicks it (the author's call,
   * 2026-10-09). Silent like the voice queue: a failure is dropped, the next change queues it.
   */
  const todoQueue = createIndexQueue<boolean>({
    kind: 'todo',
    db: () => (manager.current() === null ? null : manager.require().connection.orm),
    run: () => {
      let changed = false
      try {
        changed = syncLocalTodo(manager.require().connection.orm).changed
      } catch (err) {
        console.warn('Could not update the To do list', err)
      }
      if (changed) todoListMoved()
      return Promise.resolve({ requested: false, value: changed })
    },
    cancelRequest: () => undefined,
    debounceMs: TODO_DEBOUNCE_MS,
    minIntervalMs: 0
  })
  /**
   * F-9.16: what the To do header's check would send, priced, kept until the book moves: building
   * it reads every scene card and sheet, too much for every `todo:list`. `todoBookVersion` moves
   * with every trigger of the To do sync and every change to the list; the key also holds the
   * model and price it was estimated on, and a project change empties it.
   */
  let todoBookVersion = 0
  let todoEstimateMemo: { key: string; estimate: TodoCheckEstimate } | null = null
  const todoBookMoved = (): void => {
    todoBookVersion++
    todoEstimateMemo = null
  }
  const memoTodoEstimate = (db: TreeDb, context: TodoCheckContext): TodoCheckEstimate => {
    const key = JSON.stringify([todoBookVersion, context.source, context.model, context.pricing])
    if (todoEstimateMemo?.key === key) return todoEstimateMemo.estimate
    const estimate = todoCheckEstimate(db, context)
    todoEstimateMemo = { key, estimate }
    return estimate
  }
  /** F-9.16: the list moved; the windows re-read it. */
  const todoListMoved = (): void => {
    todoBookMoved()
    emit(windows(), 'todo:changed', {})
  }
  /** F-9.16: the knowledge moved (facts, records, tags, threads, findings, notes, metadata). */
  const queueTodo = (db: TreeDb): void => {
    todoBookMoved()
    const root = manuscriptRootId(db)
    if (root !== null) todoQueue.touch('todo', root)
  }

  /**
   * F-4.12: the automatic mention scan's own queue. Everything it does is local — read the saved
   * document, match the tracked tag names, write `tag_mention` — so there is no key, no dial, no
   * rate limit (`minIntervalMs: 0`) and nothing to abort, and it is deliberately silent: no
   * `onChange` (the indexing indicator counts provider work, not this) and no `onNodeStatus`
   * (the summary pane's "Updating…" is not about mentions). A scan that changed rows tells the
   * windows which document moved, and only then.
   */
  /**
   * F-4.12b: the proposed tags as they stand now, pushed to the windows when they differ from
   * what was last pushed. The list is computed, not stored, so everything that can move it — a
   * scan, a tag, a dismissal, a project — calls this, and the JSON comparison keeps a burst of
   * scans (the backfill of a whole manuscript) down to the one event that says something new.
   * `lastProposed` is null for "nothing pushed yet", which is what a project change restores, so
   * a reopened project publishes its list again even though it has not changed since.
   */
  let lastProposed: string | null = null
  const publishProposed = (): void => {
    if (manager.current() === null) return
    const proposals = listProposedTags(manager.require().connection.orm)
    const json = JSON.stringify(proposals)
    if (json === lastProposed) return
    lastProposed = json
    emit(windows(), 'tag:proposedChanged', proposals)
    // F-9.16: the untagged names are To do items too.
    queueTodo(manager.require().connection.orm)
  }

  /**
   * F-3.14: the spellchecker accepts the open project's dictionary and the words of its story's
   * names (entities and tags), and nothing once the project is closed. The names are read on
   * every sync rather than stored, so everything that adds, renames, or removes one calls this
   * and a name that is gone leaves no word behind. Local string work: no AI, whatever the dial.
   */
  const syncSpelling = (): Promise<void> => {
    if (manager.current() === null) return spellDictionary.sync([])
    return spellDictionary.sync(projectSpellingWords(manager.require().connection.orm))
  }

  const mentionQueue = createIndexQueue<{ changed: boolean; scanned: boolean }>({
    kind: 'mentions',
    db: () => (manager.current() === null ? null : manager.require().connection.orm),
    run: (job) => {
      const value = scanMentions(manager.require().connection.orm, job.nodeId, new Date())
      if (value.changed) {
        emit(windows(), 'mention:changed', { nodeIds: [job.nodeId] })
        // F-9.16: which scenes name which records is what most local To do rules count.
        queueTodo(manager.require().connection.orm)
      }
      // F-4.12b: a scan that read the document again may have changed which names are proposed,
      // whether or not any tag's mentions moved; one that short-circuited on the hash cannot.
      if (value.scanned) publishProposed()
      // Nothing was sent anywhere: the rate limit must not count a local scan a turn.
      return Promise.resolve({ requested: false, value })
    },
    // A scan is synchronous and local: by the time anything could cancel it, it is over.
    cancelRequest: () => undefined,
    debounceMs: MENTION_DEBOUNCE_MS,
    minIntervalMs: 0
  })

  /**
   * F-14.14: automatic voice learning's own queue, one `voice` job per project keyed to the
   * manuscript root. Silent like the mention queue (no indicator, no node status): the local
   * step re-picks the automatic exemplars, and the AI step refreshes the learned style notes
   * only when due, allowed, and a provider is set up; it swallows its failures (`runVoiceJob`),
   * so nothing here ever pauses. The memo of the last notes failure belongs to the project.
   */
  const voiceMemo: VoiceJobMemo = { failedAtWords: null }
  const voiceQueue = createIndexQueue<VoiceJobResult>({
    kind: 'voice',
    db: () => (manager.current() === null ? null : manager.require().connection.orm),
    run: async (_job, requestId) => {
      const db = manager.require().connection.orm
      const value = await runVoiceJob(
        db,
        {
          request: () => requestDeps(db),
          providerReady: () => access.writable() && Boolean(ai.get(sourceOf(db))),
          now: () => new Date()
        },
        { requestId, memo: voiceMemo }
      )
      return { requested: value.requested, value }
    },
    cancelRequest: (requestId) => void cancelInflight(requestId),
    debounceMs: VOICE_JOB_DEBOUNCE_MS,
    minIntervalMs: 0
  })
  /**
   * F-11.1d: the plan-link job's own queue, one `planLinks` job per project keyed to the
   * manuscript root, debounced well past a burst of summaries. Silent like the voice queue: a
   * failure is dropped (the next summary queues it again), only a cancel is passed on. What it
   * did reaches the windows as `planLinks:changed`, so the outline refetches and reloads the
   * scene metadata it rewrote.
   */
  const planQueue = createIndexQueue<PlanLinksRunResult | null>({
    kind: 'planLinks',
    db: () => (manager.current() === null ? null : manager.require().connection.orm),
    run: async (_job, requestId) => {
      const db = manager.require().connection.orm
      let value: PlanLinksRunResult
      try {
        value = await runPlanLinks(db, requestDeps(db), { requestId })
      } catch (err) {
        if (err instanceof AiCancelledError) throw err
        return { requested: false, value: null }
      }
      if (value.requested) {
        emit(windows(), 'planLinks:changed', { changedNodeIds: value.changedNodeIds })
      }
      return { requested: value.requested, value }
    },
    cancelRequest: (requestId) => void cancelInflight(requestId),
    debounceMs: PLAN_LINKS_DEBOUNCE_MS,
    minIntervalMs: 0
  })
  /**
   * F-9.18: a story-bible sheet's two views kept true. Each sheet the author edits waits out its
   * own 30-second pause, then joins the due list that the `sheetSync` job works one by one (fast
   * tier, nothing sent while the hashes agree). Nothing is scheduled while Use AI or the toggle is
   * off or no provider is set up; the sheet then shows it is out of date instead.
   */
  const sheetSync = createSheetSyncService({
    db: () => (manager.current() === null ? null : manager.require().connection.orm),
    request: (db) => requestDeps(db),
    ready: (db) => access.writable() && Boolean(ai.get(sourceOf(db))),
    cancelRequest: (requestId) => void cancelInflight(requestId),
    onStatuses: (statuses) => emit(windows(), 'sheetSync:changed', statuses),
    onEntity: (entity) => {
      emit(windows(), 'entity:changed', entity)
      // The sheet's own text moved: its baseline facts did too.
      emit(windows(), 'fact:changed', { entityIds: [entity.id] })
    },
    onChangesLogged: () => emit(windows(), 'changes:changed', {})
  })

  const queuePlanLinks = (db: TreeDb): void => {
    if (!isFeatureAllowed(getAiSettings(db), 'planLinks')) return
    const root = manuscriptRootId(db)
    if (root !== null) planQueue.touch('planLinks', root)
  }

  /** F-14.14: queue the voice job now (open, an AI settings change); it decides itself whether anything is due. */
  const queueVoice = (db: TreeDb): void => {
    const root = manuscriptRootId(db)
    if (root !== null) voiceQueue.indexAll('voice', [root])
  }

  /** F-4.12: every manuscript document is rescanned when the tag bank itself changes. */
  const rescanManuscript = (db: TreeDb): void => {
    mentionQueue.indexAll(
      'mentions',
      manuscriptDocuments(db).map((row) => row.id)
    )
  }

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
      error: failure === null ? null : { message: failure.message, nextStep: failure.nextStep },
      // F-9.14: the scene card, put together from what is stored (no AI, no write).
      card: sceneCardFor(db, nodeId)
    }
  }

  register('app:info', () => ({ version: app.getVersion(), platform: process.platform }))

  // AI-BILLING-SPEC M1: the trial or the license; a change arrives as `app:accessChanged`.
  register('app:getAccess', () => access.status())

  register('project:create', async ({ name, format, directory, aiSource, aiSwitch }) => {
    const folder = directory
      ? projectFolderFor(directory, name)
      : await dialogs.chooseProjectSavePath(name)
    if (!folder) return null
    const info = manager.create(folder, name, format)
    diagnostics.count('project.create')
    // F-15.11, F-5.18: the wizard's choices are written before this answers, so the renderer's
    // first `aiSettings:get` already reads them.
    if (aiSource !== undefined || aiSwitch !== undefined) {
      const orm = manager.require().connection.orm
      const settings = getAiSettings(orm)
      const next = {
        ...settings,
        ...(aiSwitch === undefined ? {} : aiSwitchPatch(aiSwitch)),
        source: aiSource ?? settings.source
      }
      if (
        next.source !== settings.source ||
        next.dial !== settings.dial ||
        next.chatMode !== settings.chatMode
      ) {
        setAiSettings(orm, next)
      }
    }
    return info
  })

  register('project:open', async ({ path }) => {
    const chosen = path ?? (await dialogs.chooseProjectToOpen())
    if (!chosen) return null
    let folder = chosen
    manager.closeIfOpen(chosen)
    // F-1.6: a v0 project is converted after the author agrees; the original is kept beside it.
    const location = locateProject(chosen)
    if (location.kind === 'legacy') {
      const backup = legacyBackupPath(location.source, new Date())
      if (!(await dialogs.confirmLegacyConversion(location.source, backup))) return null
      folder = convertLegacyProject(location).folder
    }
    const info = manager.open(folder)
    diagnostics.count('project.open')
    return info
  })

  register('project:close', () => {
    manager.close()
    // F-7.9: closing the project on purpose means the next launch starts on the welcome screen;
    // a window close or a quit leaves it, so the project opens again.
    appState.update((s) => ({ ...s, window: { ...s.window, lastProject: null } }))
    return null
  })

  register('project:current', () => manager.current())

  register('project:cloudSyncStatus', () => cloudSync?.status() ?? null)

  register('project:cloudSyncNow', async () => (cloudSync ? cloudSync.syncNow() : null))

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

  register('tree:rename', ({ id, title }) => {
    const renamed = toTreeNode(renameNode(manager.require().connection.orm, id, title))
    // F-9.16: a scene's title is part of what the To do check sends.
    todoBookMoved()
    return renamed
  })

  register('tree:duplicate', ({ id }) =>
    duplicateNode(manager.require().connection.orm, id).map(toTreeNode)
  )

  register('tree:delete', ({ id }) => {
    const entityIds = deleteNode(manager.require().connection.orm, id)
    // F-13.4: the scene's findings went with it (cascade), and the panel holds a copy.
    emit(windows(), 'continuity:changed', { nodeIds: [id] })
    // F-9.13: and so did what it stated; the sheets that held its facts refetch.
    if (entityIds.length > 0) emit(windows(), 'fact:changed', { entityIds })
    // F-9.16: the scene's items lose their passage; the rules count one scene fewer.
    queueTodo(manager.require().connection.orm)
    return null
  })

  register('tree:move', ({ id, parentId, afterId }) => {
    const db = manager.require().connection.orm
    const moved = toTreeNode(moveNode(db, id, parentId, afterId))
    // F-9.16: reading order decides loose ends and an age that goes down.
    queueTodo(db)
    return moved
  })

  register('document:get', ({ id }) => getDocumentContent(manager.require().connection.orm, id))

  /**
   * What follows every write of document content, whoever wrote it: the editor's `document:save`
   * and the bulk writes of find and replace (F-10.2) both end here, so a replaced document is
   * re-summarized and rescanned exactly like a typed one.
   */
  const documentsWritten = (db: TreeDb, ids: readonly string[]): void => {
    if (ids.length === 0) return
    // F-14.1: every save moves the voice profile's version (a cheap integer; checking whether the
    // document is under the manuscript would cost a lookup on the hot path for nothing).
    bumpVoiceVersion()
    // F-5.6: the summary is rewritten once the author pauses, never on the save itself. The
    // gate is read here, not at run time: a save with summaries off must not show the pane
    // "Updating…" for a run that will never happen, nor leave a run queued for the moment the
    // toggle comes on (one settings row per save; the run gates again anyway).
    const summaries = isFeatureAllowed(getAiSettings(db), 'summary')
    for (const id of ids) {
      if (summaries) queue.touch('summary', id)
      // F-4.12: the mention scan is local, so it has no gate to read — every save queues one, and
      // the scan itself answers "nothing changed" for a node that is not a manuscript document.
      // F-4.12b: a scan that read the document again republishes the proposed tags itself.
      mentionQueue.touch('mentions', id)
    }
    // F-14.14: one debounced voice job per burst of saves, whichever documents they were.
    const root = manuscriptRootId(db)
    if (root !== null) voiceQueue.touch('voice', root)
  }

  /**
   * The core workflow: the AI keeps track of the whole book on its own. Whenever background
   * indexing is allowed and a provider can answer, every scene without a current summary is
   * queued, so text written before AI was on, or brought in by an import, is indexed without the
   * author pressing "Summarize all scenes". Called on open, on an AI settings change, on a saved
   * key, and after an import; a scene whose summary is current costs nothing, so repeating it
   * is free. `resume` lifts a pause the author's action may have just fixed (a key, the dial).
   */
  let backfillTimer: ReturnType<typeof setTimeout> | null = null
  let backfillResume = false
  const backfillSummaries = (resume: boolean): void => {
    // One pass a moment later rather than one per trigger: the dial and the key are usually set
    // one after the other, and an open is followed by the window's own first reads.
    backfillResume ||= resume
    if (backfillTimer !== null) clearTimeout(backfillTimer)
    backfillTimer = setTimeout(() => {
      backfillTimer = null
      const lift = backfillResume
      backfillResume = false
      if (manager.current() === null) return
      const db = manager.require().connection.orm
      // F-14.14: the voice job rides the same triggers; it checks its own gate and thresholds.
      queueVoice(db)
      // F-9.14: while the conversion waits for the author, the scenes an older prompt read are
      // held back, and the windows hear what it would cost (the dialog shows on `pending`).
      const hold = conversionPending(db)
      if (hold) emit(windows(), 'knowledge:conversionChanged', conversionOf(db))
      if (!access.writable()) return
      if (!isFeatureAllowed(getAiSettings(db), 'summary') || !ai.get(sourceOf(db))) return
      if (lift && queue.status().paused !== null) queue.resume()
      queue.indexAll('summary', staleSummaryNodeIds(db, { holdOutdated: hold }))
    }, SUMMARY_BACKFILL_DELAY_MS)
  }

  /**
   * F-9.14: the conversion pass as the dialog reads it. Available only where the background
   * summary could run now (writable, Use AI and summaries on, a provider set up); priced on the
   * fast tier's model, the hosted quote on MythScribe Cloud, nothing on a local model.
   */
  let conversionDeferred = false
  /** F-9.16: may the To do check and suggestions run, and on what model at what price. */
  const todoCheckContext = (db: TreeDb): TodoCheckContext => {
    const source = sourceOf(db)
    const provider = access.writable() ? ai.get(source) : undefined
    return {
      allowed: isFeatureAllowed(getAiSettings(db), 'todo') && Boolean(provider),
      source,
      model: provider?.resolveModel('fast') ?? '',
      pricing: appState.get().cloudPricing?.pricing ?? null
    }
  }
  const conversionOf = (db: TreeDb): KnowledgeConversion => {
    const source = sourceOf(db)
    const provider = access.writable() ? ai.get(source) : undefined
    return estimateConversion(db, {
      available: isFeatureAllowed(getAiSettings(db), 'summary') && Boolean(provider),
      source,
      model: provider?.resolveModel('fast') ?? '',
      pricing: appState.get().cloudPricing?.pricing ?? null,
      deferred: conversionDeferred
    })
  }
  /** A project change drops a pass meant for the project that left. */
  const cancelBackfill = (): void => {
    if (backfillTimer !== null) clearTimeout(backfillTimer)
    backfillTimer = null
    backfillResume = false
  }

  /**
   * The editor's write of one document: `document:save` and crash recovery (F-8.3) both end
   * here, so a recovered scene counts as words written and is re-summarized like a typed one.
   */
  const saveFromEditor = (db: TreeDb, id: string, content: TiptapNodeT): SaveResult => {
    // F-10.3: only the editor's saves of manuscript documents count as words written, so the
    // count before the save is read here and not in `documentsWritten` (replace writes too).
    const previous = manuscriptWordCount(db, id)
    const saved = saveDocument(db, id, content)
    if (previous !== null) recordWriting(db, saved.wordCount - previous)
    documentsWritten(db, [id])
    return saved
  }

  register('document:save', ({ id, content }) =>
    saveFromEditor(manager.require().connection.orm, id, content)
  )

  register('notes:get', ({ id }) => getNotes(manager.require().connection.orm, id))

  register('notes:save', ({ id, notes }) => {
    const db = manager.require().connection.orm
    const saved = saveNotes(db, id, notes)
    // F-9.16: a name the notes explain is no longer undefined.
    queueTodo(db)
    return saved
  })

  /**
   * The journal entries that still differ from what is stored (F-8.3). Entries whose node is gone
   * or no longer fits the kind (the getters refuse with an AppError), and entries equal to the
   * stored content, are deleted on the way.
   */
  const liveRecoveryEntries = (db: TreeDb, folder: string): RecoveryEntry[] => {
    const live: RecoveryEntry[] = []
    for (const entry of readRecovery(folder)) {
      let stored: TiptapNodeT | null
      try {
        stored =
          entry.kind === 'document'
            ? getDocumentContent(db, entry.id).content
            : getNotes(db, entry.id).notes
      } catch (err) {
        if (!(err instanceof AppError)) throw err
        clearRecovery(folder, entry.kind, entry.id)
        continue
      }
      if (JSON.stringify(stored ?? EMPTY_DOC) === JSON.stringify(entry.content)) {
        clearRecovery(folder, entry.kind, entry.id)
        continue
      }
      live.push(entry)
    }
    return live
  }

  register('recovery:stash', ({ kind, id, content }) => {
    stashRecovery(manager.require().localFolder, kind, id, content)
    return null
  })

  register('recovery:clear', ({ kind, id }) => {
    clearRecovery(manager.require().localFolder, kind, id)
    return null
  })

  register('recovery:list', () => {
    const session = manager.require()
    const db = session.connection.orm
    return liveRecoveryEntries(db, session.localFolder).map(({ kind, id }) => ({
      kind,
      id,
      title: getNode(db, id)?.title ?? ''
    }))
  })

  register('recovery:restore', () => {
    const session = manager.require()
    const db = session.connection.orm
    return liveRecoveryEntries(db, session.localFolder).map(({ kind, id, content }) => {
      let wordCount: number | null = null
      if (kind === 'document') wordCount = saveFromEditor(db, id, content).wordCount
      else saveNotes(db, id, content)
      clearRecovery(session.localFolder, kind, id)
      return { kind, id, wordCount }
    })
  })

  register('recovery:discard', () => {
    discardRecovery(manager.require().localFolder)
    return null
  })

  register('sceneMeta:get', ({ id }) => getSceneMeta(manager.require().connection.orm, id))

  register('sceneMeta:set', ({ id, meta }) => {
    const db = manager.require().connection.orm
    const stored = setSceneMeta(db, id, meta)
    // F-9.16: a scene's point of view and its idea status feed the To do rules.
    queueTodo(db)
    return stored
  })

  register('editorSettings:get', () => {
    const session = manager.require()
    return getEditorSettings(session.connection.orm, session.info.format)
  })

  register('editorSettings:set', (value) =>
    setEditorSettings(manager.require().connection.orm, value)
  )

  register('aiSettings:get', () => getAiSettings(manager.require().connection.orm))

  register('aiSettings:set', (value) => {
    const settings = setAiSettings(manager.require().connection.orm, value)
    backfillSummaries(true)
    return settings
  })

  register('presets:get', () => getWritingPresets(manager.require().connection.orm))

  register('presets:set', (value) => setWritingPresets(manager.require().connection.orm, value))

  register('structure:get', () => getProjectStructure(manager.require().connection.orm))

  register('structure:set', (value) => {
    const db = manager.require().connection.orm
    const stored = setProjectStructure(db, value)
    // F-11.1d: a new template brings new empty beats to link.
    queuePlanLinks(db)
    return stored
  })

  register('planLinks:get', () => getPlanLinks(manager.require().connection.orm))

  register('planLinks:run', ({ requestId }) => {
    const db = manager.require().connection.orm
    return runPlanLinks(db, requestDeps(db), { requestId })
  })

  register('planLinks:confirm', ({ key }) => confirmPlanLink(manager.require().connection.orm, key))

  register('planLinks:dismiss', ({ key }) => {
    dismissPlanLink(manager.require().connection.orm, key)
    return null
  })

  register('planLinks:unlink', ({ plan }) => unlinkPlan(manager.require().connection.orm, plan))

  register('timeline:get', () => getProjectTimeline(manager.require().connection.orm))

  register('timeline:set', (value) => setProjectTimeline(manager.require().connection.orm, value))

  register('focusSettings:get', () => getFocusSettings(manager.require().connection.orm))

  register('focusSettings:set', (value) =>
    setFocusSettings(manager.require().connection.orm, value)
  )

  register('session:get', () => getProjectSession(manager.require().connection.orm))

  register('session:set', (value) => setProjectSession(manager.require().connection.orm, value))

  // F-14.2: the author's rules are part of the voice profile, so a write invalidates its cache.
  register('authorRules:get', () => getAuthorRules(manager.require().connection.orm))

  // F-9.17, F-9.19: the story bible's view choice, default view, and write-up style.
  register('storyBible:get', () => getStoryBibleSettings(manager.require().connection.orm))

  register('storyBible:set', (value) =>
    setStoryBibleSettings(manager.require().connection.orm, value)
  )

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

  /**
   * F-9.6: the quick reference panel's pins. Reading prunes: a pin whose entity, node, or image
   * file is gone is dropped and the row rewritten, so a deleted target never comes back as a
   * dead card and the list never fills up with pins nobody can see.
   */
  register('reference:get', () => {
    const session = manager.require()
    const stored = getReferencePins(session.connection.orm)
    const pins = pruneReferencePins(session.connection.orm, session.folder, stored.pins)
    if (pins === stored.pins) return stored
    return setReferencePins(session.connection.orm, { pins: [...pins] })
  })

  // The row first, the files second: a refused write never deletes an image that is still pinned.
  register('reference:set', (value) => {
    const session = manager.require()
    const previous = getReferencePins(session.connection.orm)
    const stored = setReferencePins(session.connection.orm, { pins: dedupePins(value.pins) })
    for (const pin of previous.pins)
      if (pin.type === 'image' && !hasPin(stored.pins, pin))
        removeReferenceImage(session.folder, pin.file)
    return stored
  })

  register('reference:addImages', async () => {
    const session = manager.require()
    const chosen = await dialogs.chooseImages('Pin images to References')
    if (chosen === null) return null
    let pins = getReferencePins(session.connection.orm).pins
    const skipped: string[] = []
    for (const source of chosen) {
      if (pins.length >= REFERENCE_PINS_MAX) {
        skipped.push(path.basename(source))
        continue
      }
      try {
        pins = [...pins, { type: 'image', file: addReferenceImage(session.folder, source) }]
      } catch (err) {
        // A refused file (type or size) is reported by name; anything else is a real failure.
        if (err instanceof AppError && err.code === 'VALIDATION')
          skipped.push(path.basename(source))
        else throw err
      }
    }
    return { pins: setReferencePins(session.connection.orm, { pins }), skipped }
  })

  register('goals:get', () => goalsStatus(manager.require().connection.orm))

  register('stats:wordCount', ({ nodeId }) =>
    wordCountReport(manager.require().connection.orm, nodeId)
  )

  register('stats:dashboard', () => statsDashboard(manager.require().connection.orm))

  register('manuscript:compile', () => compileManuscript(manager.require().connection.orm))

  /**
   * Compile v2: the book in one output with the compile window's format. The default file is
   * named after the book's title and sits beside the project folder, as exports do.
   */
  register('compile:run', async ({ format, output, scope, requestId }) => {
    const session = manager.require()
    const db = session.connection.orm
    const extension = COMPILE_OUTPUT_EXTENSIONS[output]
    const title = bookTitle(getBookDetails(db), session.info.name)
    const chosen = await dialogs.chooseExportPath(
      `${sanitizeName(title) || sanitizeName(session.info.name)}.${extension}`,
      [{ name: COMPILE_OUTPUT_LABELS[output], extensions: [extension] }],
      path.dirname(session.folder)
    )
    if (chosen === null) return null
    const result = await compileToFile(db, {
      format,
      output,
      scope,
      projectName: session.info.name,
      projectFolder: session.folder,
      path: chosen,
      requestId,
      onProgress: (progress) => emit(windows(), 'export:progress', progress),
      renderPdf
    })
    // Counted with exports: the diagnostics counters are a fixed, shipped list.
    diagnostics.count('export.run')
    return result
  })

  // Compile v2 (CV1): the model's source, the project's compile state and Book details, and the
  // app-wide format library. The model itself is pure (`@shared/compileModel`).
  register('compile:source', () => compileSource(manager.require().connection.orm))

  register('compileState:get', () => getCompileState(manager.require().connection.orm))

  register('compileState:set', (value) => setCompileState(manager.require().connection.orm, value))

  register('bookDetails:get', () => getBookDetails(manager.require().connection.orm))

  register('bookDetails:set', (value) => {
    const db = manager.require().connection.orm
    // The cover changes only through its own channels, which own the file.
    return setBookDetails(db, { ...value, cover: getBookDetails(db).cover })
  })

  register('bookDetails:setCover', async () => {
    const session = manager.require()
    const source = await dialogs.chooseEntityImage()
    if (source === null) return null
    const db = session.connection.orm
    const previous = getBookDetails(db)
    const fileName = addImageAsset(session.folder, BOOK_COVER_DIR, source, 'cover')
    const updated = setBookDetails(db, { ...previous, cover: fileName })
    if (previous.cover !== null) removeImageAsset(session.folder, BOOK_COVER_DIR, previous.cover)
    return updated
  })

  register('bookDetails:removeCover', () => {
    const session = manager.require()
    const db = session.connection.orm
    const previous = getBookDetails(db)
    const updated = setBookDetails(db, { ...previous, cover: null })
    if (previous.cover !== null) removeImageAsset(session.folder, BOOK_COVER_DIR, previous.cover)
    return updated
  })

  register('compileFormat:list', () => sortFormats(appState.get().compileFormats))

  register('compileFormat:create', ({ fromId, name }) => {
    const next = createFormat(appState.get().compileFormats, fromId, name)
    appState.update((s) => ({ ...s, compileFormats: next.library }))
    return next.format
  })

  register('compileFormat:save', (value) => {
    const next = saveFormat(appState.get().compileFormats, value)
    appState.update((s) => ({ ...s, compileFormats: next.library }))
    return next.format
  })

  register('compileFormat:delete', ({ id }) => {
    const library = deleteFormat(appState.get().compileFormats, id)
    appState.update((s) => ({ ...s, compileFormats: library }))
    return null
  })

  register('goals:set', (patch) => {
    const db = manager.require().connection.orm
    updateGoals(db, patch)
    return goalsStatus(db)
  })

  register('conversations:get', () => getConversations(manager.require().connection.orm))

  register('conversations:set', (value) =>
    setConversations(manager.require().connection.orm, value)
  )

  register('tag:list', () => listTags(manager.require().connection.orm))

  // F-4.12: a new name is a new thing to look for, so the manuscript is rescanned behind the
  // author. The scans are hash-guarded, so a document the new tag does not touch costs one hash.
  register('tag:create', (input) => {
    const db = manager.require().connection.orm
    // F-9.12 (D8): a character, place, or world tag arrives with its record, in one transaction.
    const { created, record } = db.transaction((tx) => {
      const tag = createTag(tx, input)
      return { created: tag, record: ensureRecordForTag(tx, tag, 'author') }
    })
    // F-5.25: a chat run may log the tag as made by it, so its Undo deletes it again.
    noteCreatedTag(db, created.id)
    if (record !== null) emit(windows(), 'entity:changed', record.entity)
    rescanManuscript(db)
    // F-4.12b: the new name is a tag now, so it is proposed no longer — which is what accepting
    // a proposal comes down to. The scans that follow say nothing new about it.
    publishProposed()
    void syncSpelling()
    return created
  })

  /**
   * F-4.12: a rename, a recategorization, or tracking turned back on changes what a scan would
   * find, so the manuscript is queued again. Tracking turned off is answered at once instead:
   * the tag's recorded mentions go now, and the windows hear which documents lost them.
   */
  register('tag:update', ({ id, ...patch }) => {
    const db = manager.require().connection.orm
    const before = getTag(db, id)
    // F-9.12: a name tag the author renames, recategorises (a label made a character, place, or
    // world tag), or gives aliases gets its record now, in the same transaction, if it has none.
    const { updated, records } = db.transaction((tx) => {
      const tag = updateTag(tx, id, patch)
      const named =
        before !== undefined &&
        (before.name !== tag.name ||
          before.category !== tag.category ||
          before.aliases !== JSON.stringify(tag.aliases))
      return { updated: tag, records: named ? ensureRecordsForTags(tx, [tag]) : [] }
    })
    publishRecords(db, records)
    if (before !== undefined) {
      if (before.trackMentions && !updated.trackMentions) {
        const nodeIds = deleteMentionsForTag(db, id)
        if (nodeIds.length > 0) emit(windows(), 'mention:changed', { nodeIds })
      } else if (
        updated.trackMentions &&
        (before.name !== updated.name ||
          before.category !== updated.category ||
          before.aliases !== JSON.stringify(updated.aliases) ||
          !before.trackMentions)
      ) {
        rescanManuscript(db)
      }
      // F-4.14: a linked sheet reads its aliases from the tag, so an open page hears of them.
      if (before.aliases !== JSON.stringify(updated.aliases)) {
        for (const linked of listEntities(db)) {
          if (linked.tagId === id) emit(windows(), 'entity:changed', linked)
        }
      }
    }
    // F-4.12b: a rename frees the old name to be proposed and takes the new one out of the list,
    // whatever tracking says — the proposals are about the bank's names, not about the scan.
    publishProposed()
    if (before?.name !== updated.name || before.aliases !== JSON.stringify(updated.aliases)) {
      void syncSpelling()
    }
    return updated
  })

  /**
   * F-9.12: "Make a record" on a tag. A sheet the call made or linked reaches every window as
   * `entity:changed`; the tag itself only moved if F-9.4's link touched the bank.
   */
  register('tag:makeRecord', ({ tagId }) => {
    const db = manager.require().connection.orm
    const { entity: record, tag, write } = makeRecordForTag(db, tagId)
    if (write !== null) {
      emit(windows(), 'entity:changed', record)
      publishTagChange(db, write.tagChange)
      void syncSpelling()
    }
    return { entity: record, tag }
  })

  register('tag:delete', ({ id }) => {
    const db = manager.require().connection.orm
    // F-4.12: the rows cascade away with the tag, so the documents that had them are collected
    // first; the windows are told once the tag is actually gone.
    const nodeIds = listMentionsForTag(db, id).map((mention) => mention.nodeId)
    deleteTag(db, id)
    if (nodeIds.length > 0) emit(windows(), 'mention:changed', { nodeIds })
    // F-4.12b: the name the deleted tag held is a plain word again, so it may be proposed.
    publishProposed()
    void syncSpelling()
    return null
  })

  register('tag:loadTemplate', ({ template }) => {
    const db = manager.require().connection.orm
    // F-9.12: no records here. A built-in template's tags are placeholders for roles and topics
    // ("protagonist", "history"), not names; the author makes a record on one by hand.
    const result = loadTagTemplate(db, template)
    if (result.created.length > 0) {
      rescanManuscript(db)
      publishProposed()
      void syncSpelling()
    }
    return result
  })

  // F-4.9: a color changes nothing a scan, a proposal, or the spellchecker reads.
  register('tag:recolor', ({ ids, color }) =>
    recolorTags(manager.require().connection.orm, ids, color)
  )

  register('tag:deleteMany', ({ ids }) => {
    const db = manager.require().connection.orm
    // As `tag:delete`: the mention rows cascade away, so their documents are collected first.
    const nodeIds = [
      ...new Set(ids.flatMap((id) => listMentionsForTag(db, id).map((mention) => mention.nodeId)))
    ]
    deleteTags(db, ids)
    if (nodeIds.length > 0) emit(windows(), 'mention:changed', { nodeIds })
    publishProposed()
    void syncSpelling()
    return null
  })

  /**
   * F-4.9: the sources' document links now sit on the target, so the windows hear which nodes
   * changed; their mention rows cascaded away, and the rescan finds the target's names again.
   */
  register('tag:merge', ({ targetId, sourceIds }) => {
    const db = manager.require().connection.orm
    const mentionNodeIds = [
      ...new Set(
        sourceIds.flatMap((id) => listMentionsForTag(db, id).map((mention) => mention.nodeId))
      )
    ]
    // F-9.12: a tag the author merges names into gets its record if neither it nor a source had one.
    const { result, records } = db.transaction((tx) => {
      const merged = mergeTags(tx, targetId, sourceIds)
      return { result: merged, records: ensureRecordsForTags(tx, [merged.target]) }
    })
    publishRecords(db, records)
    if (result.nodeIds.length > 0) {
      emit(windows(), 'documentTag:changed', { nodeIds: result.nodeIds })
    }
    if (mentionNodeIds.length > 0) emit(windows(), 'mention:changed', { nodeIds: mentionNodeIds })
    // An entity that lived on a source lives on the target now; an open page shows its new tag.
    // F-4.14: every sheet of the target hears too, since the merged names are its aliases now.
    for (const linked of listEntities(db)) {
      if (linked.tagId === targetId) emit(windows(), 'entity:changed', linked)
    }
    rescanManuscript(db)
    publishProposed()
    void syncSpelling()
    return { target: result.target, removedIds: result.removedIds, aliases: result.aliases }
  })

  register('tag:aliases', () => getTagAliases(manager.require().connection.orm))

  /**
   * F-4.9: the whole bank out of the project, so another book of the series can read it in. The
   * default sits beside the project folder, as the entity library's does.
   */
  register('tag:export', async ({ path: given }) => {
    const session = manager.require()
    const records = exportTagBank(session.connection.orm)
    if (records.length === 0) throw new AppError('VALIDATION', 'No tags to export')
    const chosen =
      given ??
      (await dialogs.chooseExportPath(
        tagExportFileName(sanitizeName(session.info.name)),
        [{ name: 'Tag bank', extensions: [TAG_EXCHANGE_EXTENSION] }],
        path.dirname(session.folder)
      ))
    if (chosen === null) return null
    writeTagBankFile(chosen, records)
    diagnostics.count('export.run')
    return { path: chosen, count: records.length }
  })

  // F-4.9: picking the file is the confirmation; new names are created, taken ones skipped.
  register('tag:import', async ({ path: given }) => {
    const session = manager.require()
    const chosen = given ?? (await dialogs.chooseTagBankFile())
    if (chosen === null) return null
    const db = session.connection.orm
    const result = importTagBankWithRecords(db, readTagBankFile(chosen))
    if (result.created.length > 0) {
      rescanManuscript(db)
      publishProposed()
      void syncSpelling()
    }
    return result
  })

  // F-4.11: custom tag templates live in app state, so every project sees the same list.
  register('tagTemplate:list', () => appState.get().tagTemplates)

  register('tagTemplate:save', ({ name, tagIds }) => {
    const db = manager.require().connection.orm
    let records = exportTagBank(db)
    if (tagIds !== undefined) {
      const nameById = new Map(listTags(db).map((row) => [row.id, row.name]))
      const keep = new Set(
        tagIds.map((id) => {
          const tagName = nameById.get(id)
          if (tagName === undefined) throw new AppError('NOT_FOUND', 'Tag not found', { id })
          return tagName
        })
      )
      records = keepTemplateRecords(records, keep)
    }
    const next = addCustomTemplate(appState.get().tagTemplates, name, records)
    appState.update((s) => ({ ...s, tagTemplates: next.templates }))
    return next.template
  })

  register('tagTemplate:update', ({ id, name, keep }) => {
    const next = updateCustomTemplate(appState.get().tagTemplates, id, { name, keep })
    appState.update((s) => ({ ...s, tagTemplates: next.templates }))
    return next.template
  })

  register('tagTemplate:delete', ({ id }) => {
    appState.update((s) => ({ ...s, tagTemplates: removeCustomTemplate(s.tagTemplates, id) }))
    return null
  })

  // F-4.11: loading a saved template is an import of its records, with the same follow-ups.
  register('tag:loadCustomTemplate', ({ id }) => {
    const template = appState.get().tagTemplates.find((t) => t.id === id)
    if (!template) throw new AppError('NOT_FOUND', 'Tag template not found', { id })
    const db = manager.require().connection.orm
    const result = importTagBankWithRecords(db, template.tags)
    if (result.created.length > 0) {
      rescanManuscript(db)
      publishProposed()
      void syncSpelling()
    }
    return result
  })

  // F-4.12: what the tag detail view and the tag bar read. A jump uses the stored range first
  // and falls back to a search, so a range from before the last save is never a dead end.
  register('mention:listForTag', ({ tagId }) => {
    const db = manager.require().connection.orm
    if (getTag(db, tagId) === undefined) {
      throw new AppError('NOT_FOUND', 'Tag not found', { id: tagId })
    }
    return listMentionsForTag(db, tagId)
  })

  register('mention:listForNode', ({ nodeId }) => {
    const db = manager.require().connection.orm
    if (getNode(db, nodeId) === undefined) {
      throw new AppError('NOT_FOUND', 'Document not found', { id: nodeId })
    }
    return listMentionsForNode(db, nodeId)
  })

  // F-4.12b: what the tag bar's proposals read. Asking changes nothing: the list is computed
  // from the saved text, the bank, and the dismissals, and a scan pushes the next one on.
  register('tag:proposed', () => listProposedTags(manager.require().connection.orm))

  /**
   * F-4.12b: dismissing a proposal stores the name for the project, so the answer here is also
   * what every window must now show; `lastProposed` is moved on with it rather than emitting to
   * the window that asked.
   */
  register('tag:dismissProposed', ({ name }) => {
    const proposals = dismissName(manager.require().connection.orm, name)
    const json = JSON.stringify(proposals)
    if (json !== lastProposed) {
      lastProposed = json
      emit(windows(), 'tag:proposedChanged', proposals)
      queueTodo(manager.require().connection.orm)
    }
    return proposals
  })

  // F-2.8: the tag bar's title offer honours the same dismissals as the proposals.
  register('tag:dismissedNames', () => getDismissedNames(manager.require().connection.orm).names)

  // F-4.14: the tags column's misspelling offers honour these; the proposals may now offer the
  // kept spelling as a tag of its own, so they are published again.
  register('tag:keptSpellings', () => getKeptSpellings(manager.require().connection.orm))

  register('tag:keepSpelling', ({ text }) => {
    const db = manager.require().connection.orm
    const key = aliasKey(text)
    const stored = getKeptSpellings(db)
    const kept =
      key === '' || stored.includes(key) ? stored : setKeptSpellings(db, [...stored, key])
    publishProposed()
    return kept
  })

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

  // F-10.1: one scan of the stored text per query; a query under the minimum answers empty.
  register('search:query', (request) => searchProject(manager.require().connection.orm, request))

  // F-10.2: find and replace across documents. The preview writes nothing; the commit and the
  // undo are bulk document saves, so each ends in `documentsWritten`, once for the batch, and the
  // cached search texts of the rewritten documents are dropped with the rest.
  register('replace:preview', (request) =>
    previewReplace(manager.require().connection.orm, request)
  )

  register('replace:commit', ({ ids, ...request }) => {
    const db = manager.require().connection.orm
    const result = commitReplace(db, request, ids)
    if (result.changed.length > 0) {
      clearSearchCache()
      documentsWritten(
        db,
        result.changed.map((each) => each.id)
      )
    }
    return result
  })

  register('replace:undo', () => {
    const db = manager.require().connection.orm
    const result = undoReplace(db)
    if (result.restored.length > 0) {
      clearSearchCache()
      documentsWritten(
        db,
        result.restored.map((each) => each.id)
      )
    }
    return result
  })

  // F-8.5: drafts. A switch and a revert rewrite live text, so each ends in `documentsWritten`
  // for what moved (re-summarized and rescanned like a save) and never in `recordWriting`:
  // changing drafts is not words written.
  register('drafts:list', () => listDrafts(manager.require().connection.orm))

  register('drafts:switch', ({ id }) => {
    const db = manager.require().connection.orm
    const result = switchDraft(db, id)
    documentsWritten(
      db,
      result.changed.map((each) => each.id)
    )
    return result
  })

  register('drafts:duplicate', ({ id, name }) =>
    duplicateDraft(manager.require().connection.orm, id, name)
  )

  register('drafts:rename', ({ id, name }) =>
    renameDraft(manager.require().connection.orm, id, name)
  )

  register('drafts:delete', ({ id }) => deleteDraft(manager.require().connection.orm, id))

  register('drafts:compare', ({ fromId, toId }) =>
    compareDrafts(manager.require().connection.orm, fromId, toId)
  )

  register('drafts:revert', ({ fromId, nodeIds }) => {
    const db = manager.require().connection.orm
    const result = revertDocuments(db, fromId, nodeIds)
    documentsWritten(
      db,
      result.changed.map((each) => each.id)
    )
    return result
  })

  // F-8.6: snapshots. A restore rewrites live text like a draft revert: `documentsWritten` for
  // what moved, never `recordWriting` (restoring is not words written).
  register('snapshots:list', () => listSnapshots(manager.require().connection.orm))

  register('snapshots:take', (input) => takeSnapshot(manager.require().connection.orm, input))

  register('snapshots:update', (input) => updateSnapshot(manager.require().connection.orm, input))

  register('snapshots:delete', ({ id }) => deleteSnapshot(manager.require().connection.orm, id))

  register('snapshots:compare', ({ id, againstId }) =>
    compareSnapshot(manager.require().connection.orm, id, againstId)
  )

  register('snapshots:restore', ({ id, nodeIds }) => {
    const db = manager.require().connection.orm
    const result = restoreSnapshot(db, id, nodeIds)
    documentsWritten(
      db,
      result.changed.map((each) => each.id)
    )
    return result
  })

  // F-9.1: the story bible. The whole set comes in one call; the renderer store (F-9.2) keeps it
  // normalized, so nothing here reloads the world after a write.
  register('entity:list', () => listEntities(manager.require().connection.orm))

  register('entity:get', ({ id }) => {
    const found = getEntity(manager.require().connection.orm, id)
    if (found === undefined) throw new AppError('NOT_FOUND', 'Entity not found', { id })
    return found
  })

  /**
   * F-9.4: an entity write may have created or renamed a tag. A new name in the bank is a new
   * thing to look for, so the manuscript is rescanned and the proposals republished, exactly as
   * `tag:create` and `tag:update` do, and every window hears about the tag itself — the asking
   * one included, because merging a tag it already holds changes nothing. A tag that was only
   * linked is unchanged and already in every bank, so it is announced to no one.
   */
  const publishTagChange = (db: TreeDb, change: EntityTagChange | null): void => {
    if (change === null || !(change.created || change.renamed || change.aliased)) return
    rescanManuscript(db)
    publishProposed()
    emit(windows(), 'tag:changed', change.tag)
  }

  /** F-9.12: records a tag change made or linked reach every window, with their tag's change. */
  const publishRecords = (db: TreeDb, writes: readonly EntityWrite[]): void => {
    for (const write of writes) {
      emit(windows(), 'entity:changed', write.entity)
      publishTagChange(db, write.tagChange)
    }
  }

  /**
   * F-4.9 / F-4.11: a tag bank read in (a file or a saved template); F-9.12: its new name tags
   * arrive with their records, in the same transaction.
   */
  const importTagBankWithRecords = (
    db: TreeDb,
    records: readonly TagExchangeRecord[]
  ): ReturnType<typeof importTagBank> => {
    const { result, writes } = db.transaction((tx) => {
      const imported = importTagBank(tx, records)
      return { result: imported, writes: ensureRecordsForTags(tx, imported.created) }
    })
    publishRecords(db, writes)
    return result
  }

  /**
   * F-5.16: a summary run logged what its scene states. An entity the job created reaches the
   * windows as `entity:changed` and its tag through `publishTagChange`, exactly as if the author
   * had created it; then the entities whose facts moved are named, so an open page refetches.
   */
  const publishObservedFacts = (db: TreeDb, change: ObservedFactsChange): void => {
    for (const { entity: created, tagChange } of change.created) {
      emit(windows(), 'entity:changed', created)
      publishTagChange(db, tagChange)
    }
    if (change.entityIds.length > 0) {
      emit(windows(), 'fact:changed', { entityIds: change.entityIds })
    }
    // F-3.14: a name the job logged is a story name like any other.
    if (change.created.length > 0) void syncSpelling()
  }

  /**
   * F-4.13: a summary run tagged its scene. A tag the job created is a new name in the bank, so
   * the manuscript is rescanned, the proposals republished, and the spellchecker told, exactly as
   * `tag:create` does; every tag whose link moved reaches the windows as `tag:changed` (its usage
   * count moved), and the scene itself as `documentTag:changed`, so an open tag bar refetches.
   */
  const publishAutoTags = (db: TreeDb, nodeId: string, change: AutoTagsChange): void => {
    // F-9.12: the records the new name tags got reach the windows like any created sheet.
    for (const record of change.records) emit(windows(), 'entity:changed', record.entity)
    if (change.created.length > 0) {
      rescanManuscript(db)
      publishProposed()
      void syncSpelling()
    }
    for (const moved of change.moved) emit(windows(), 'tag:changed', moved)
    emit(windows(), 'documentTag:changed', { nodeIds: [nodeId] })
  }

  register('entity:create', (input) => {
    const db = manager.require().connection.orm
    const { entity: created, tagChange } = createEntity(db, input)
    // F-9.15: Organise may log this sheet with a deleteSheet Undo; main checks it made it.
    noteCreatedSheet(db, created.id, tagChange?.created === true ? tagChange.tag.id : null)
    publishTagChange(db, tagChange)
    void syncSpelling()
    queueTodo(db)
    // F-9.18: a sheet made with text gets its other view after the pause.
    if (created.sync.state !== 'none') sheetSync.touch(created.id)
    return created
  })

  register('entity:update', ({ id, baseModified, ...patch }) => {
    const db = manager.require().connection.orm
    // F-9.18: a page save made from a draft older than a write-up that just landed wins as typed;
    // the sync is then rebased so the next filing reads only the author's own edits.
    const editedFrom =
      patch.body !== undefined && baseModified !== undefined
        ? staleWriteUpBase(db, id, baseModified)
        : null
    const written = updateEntity(db, id, patch)
    if (editedFrom !== null) rebaseAuthorPage(db, id, editedFrom, new Date())
    const updated = editedFrom === null ? written.entity : (getEntity(db, id) ?? written.entity)
    const tagChange = written.tagChange
    publishTagChange(db, tagChange)
    void syncSpelling()
    // F-9.16: a filled field answers a gap.
    queueTodo(db)
    // F-9.13: an author line dated at a scene is a fact the sheet lists.
    if (patch.asOf != null && patch.fields !== undefined) {
      emit(windows(), 'fact:changed', { entityIds: [id] })
    }
    // F-9.18: the sheet's fields or page moved: its other view follows after the pause.
    if ((patch.fields !== undefined && patch.asOf == null) || patch.body !== undefined) {
      sheetSync.touch(id)
    }
    return updated
  })

  // F-9.18: the sheet's own fields, and its two views kept true.
  register('entity:addField', ({ id, label }) => {
    const updated = addEntityField(manager.require().connection.orm, id, label)
    sheetSync.touch(id)
    return updated
  })

  register('entity:removeField', ({ id, fieldId }) => {
    const updated = removeEntityField(manager.require().connection.orm, id, fieldId)
    sheetSync.touch(id)
    return updated
  })

  register('sheetSync:status', () => sheetSync.statuses())

  register('sheetSync:run', ({ id }) => sheetSync.runNow(id))

  /**
   * F-9.10: sheets merged by Organise. A tag merge inside it reaches the windows exactly as
   * `tag:merge` does; the merged-away sheets' pictures that did not move go with them.
   */
  register('entity:merge', ({ targetId, sourceIds }) => {
    const session = manager.require()
    const db = session.connection.orm
    const result = mergeEntities(db, targetId, sourceIds)
    for (const removed of result.removed) {
      if (removed.image !== null) removeImageAsset(session.folder, ENTITY_IMAGES_DIR, removed.image)
    }
    const merge = result.tagMerge
    if (merge !== null && merge.nodeIds.length > 0) {
      emit(windows(), 'documentTag:changed', { nodeIds: merge.nodeIds })
    }
    if (merge !== null || result.aliasedTag !== null) {
      rescanManuscript(db)
      publishProposed()
    }
    if (result.aliasedTag !== null) emit(windows(), 'tag:changed', result.aliasedTag)
    void syncSpelling()
    emit(windows(), 'fact:changed', { entityIds: [targetId] })
    emit(windows(), 'continuity:changed', { nodeIds: [] })
    queueTodo(db)
    return {
      entity: result.entity,
      removedIds: result.removed.map((removed) => removed.id),
      tags:
        merge === null
          ? null
          : { target: merge.target, removedIds: merge.removedIds, aliases: merge.aliases }
    }
  })

  // F-9.10: Organise's local pass, and the AI's plan. Like `library:reviewChat`, the parent
  // `requestId` is registered here so `ai:cancel` stops the chunk in flight; expected AI failures
  // come back as data.
  register('organise:candidates', () =>
    organiseCandidates(loadOrganiseProject(manager.require().connection.orm))
  )

  register(
    'organise:plan',
    async ({ instruction, scope, requestId }): Promise<OrganisePlanResult> => {
      const db = manager.require().connection.orm
      const controller = registerInflight(requestId)
      try {
        const answer = await runOrganise(db, requestDeps(db), {
          instruction,
          scope,
          requestId,
          signal: controller.signal
        })
        return { ok: true, ...answer, requestId }
      } catch (err) {
        if (err instanceof AiProviderError)
          return { ...aiFailure(err.code, err.message), requestId }
        throw err
      } finally {
        releaseInflight(requestId)
      }
    }
  )

  register('entity:linkTag', ({ id }) => {
    const db = manager.require().connection.orm
    const { entity: linked, tagChange } = linkEntityTag(db, id)
    publishTagChange(db, tagChange)
    void syncSpelling()
    return { entity: linked, tag: tagChange.tag }
  })

  /**
   * F-9.3: the entity's portrait or photograph. The file is copied into the project's
   * `assets/entities/` first and the row written second, so a refusal (a world item, an unknown
   * id) never leaves a stored file behind; the previous image goes only once the new one is in
   * the row, so a failed write never loses the image the author had.
   */
  register('entity:setImage', async ({ id }) => {
    const session = manager.require()
    const source = await dialogs.chooseEntityImage()
    if (source === null) return null
    const previous = getEntity(session.connection.orm, id)?.image ?? null
    const fileName = addImageAsset(session.folder, ENTITY_IMAGES_DIR, source, 'image')
    let updated: Entity
    try {
      updated = setEntityImage(session.connection.orm, id, fileName)
    } catch (err) {
      removeImageAsset(session.folder, ENTITY_IMAGES_DIR, fileName)
      throw err
    }
    if (previous !== null) removeImageAsset(session.folder, ENTITY_IMAGES_DIR, previous)
    return updated
  })

  register('entity:removeImage', ({ id }) => {
    const session = manager.require()
    const previous = getEntity(session.connection.orm, id)?.image ?? null
    const updated = setEntityImage(session.connection.orm, id, null)
    if (previous !== null) removeImageAsset(session.folder, ENTITY_IMAGES_DIR, previous)
    return updated
  })

  register('entity:delete', ({ id }) => {
    const session = manager.require()
    const deleted = deleteEntity(session.connection.orm, id)
    // F-9.3: the image is the entity's own file, so it goes with it.
    if (deleted.image !== null) removeImageAsset(session.folder, ENTITY_IMAGES_DIR, deleted.image)
    void syncSpelling()
    // F-13.4: the findings against the entity's sheet and facts went with it (cascade).
    emit(windows(), 'continuity:changed', { nodeIds: [] })
    queueTodo(session.connection.orm)
    return null
  })

  // F-9.13: a record's dated facts. The AI's are written by the index job; the author hides,
  // restores, or re-statuses one, which every window then hears about.
  register('fact:listForEntity', ({ entityId }) =>
    listFactsForEntity(manager.require().connection.orm, entityId)
  )

  /** F-9.14: a relationship moves both sheets. */
  const factOwners = (fact: Fact): string[] =>
    fact.objectEntityId === null ? [fact.entityId] : [fact.entityId, fact.objectEntityId]

  register('fact:setHidden', ({ id, hidden }) => {
    const fact = setFactHidden(manager.require().connection.orm, id, hidden)
    emit(windows(), 'fact:changed', { entityIds: factOwners(fact) })
    queueTodo(manager.require().connection.orm)
    return fact
  })

  register('fact:setStatus', ({ id, status }) => {
    const fact = setFactStatus(manager.require().connection.orm, id, status)
    emit(windows(), 'fact:changed', { entityIds: factOwners(fact) })
    queueTodo(manager.require().connection.orm)
    return fact
  })

  // F-9.14: the author's own relationships and thread events (dated facts that are no field).
  register('fact:create', (input) => {
    const fact = addAuthorStatement(
      manager.require().connection.orm,
      input.kind === 'relation'
        ? {
            entityId: input.entityId,
            attribute: relationAttribute(input.type),
            value: input.label,
            objectEntityId: input.objectEntityId,
            nodeId: input.nodeId
          }
        : {
            entityId: input.entityId,
            attribute: threadAttribute(input.event),
            value: input.note,
            objectEntityId: null,
            nodeId: input.nodeId
          }
    )
    emit(windows(), 'fact:changed', { entityIds: factOwners(fact) })
    queueTodo(manager.require().connection.orm)
    return fact
  })

  register('fact:delete', ({ id }) => {
    const fact = deleteAuthorStatement(manager.require().connection.orm, id)
    emit(windows(), 'fact:changed', { entityIds: factOwners(fact) })
    queueTodo(manager.require().connection.orm)
    return fact
  })

  register('thread:list', () => listThreads(manager.require().connection.orm))

  // F-9.16: the To do list. Settling or reopening an item is the author's; a dismissed name
  // reaches the Tags panel's proposals, a dismissed contradiction the Continuity panel.
  register('todo:list', () => {
    const db = manager.require().connection.orm
    return listTodo(
      db,
      todoCheckView(db, todoCheckContext(db), (context) => memoTodoEstimate(db, context))
    )
  })

  // F-9.16: Check the whole book, only on the author's click (the author's call, 2026-10-09:
  // never automatically). Whatever the outcome, the windows re-read the list: an answer is stored
  // as it comes, so a failure on a later request still leaves the earlier ones' items.
  register('todo:check', async ({ requestId }): Promise<TodoCheckResult> => {
    const db = manager.require().connection.orm
    try {
      const result = await runTodoPass(db, requestDeps(db), { requestId })
      return { ok: true, ...result, requestId }
    } catch (err) {
      if (err instanceof AiProviderError) return { ...aiFailure(err.code, err.message), requestId }
      throw err
    } finally {
      todoListMoved()
    }
  })

  // F-9.16: an item's suggestions when its card is first shown, stored on the item. The asking
  // window updates its own copy; no event, so the list does not re-read under the author.
  register('todo:suggest', async ({ id, requestId }): Promise<TodoSuggestResult> => {
    const db = manager.require().connection.orm
    try {
      const result = await suggestTodo(db, requestDeps(db), { id, requestId })
      return { ok: true, ...result, requestId }
    } catch (err) {
      if (err instanceof AiProviderError) return { ...aiFailure(err.code, err.message), requestId }
      throw err
    }
  })

  register('todo:settle', ({ id, status }) => {
    const db = manager.require().connection.orm
    const result = settleTodo(db, id, status)
    if (result.continuityNodeId !== null) {
      emit(windows(), 'continuity:changed', { nodeIds: [result.continuityNodeId] })
    }
    if (result.namesChanged) publishProposed()
    todoListMoved()
    return null
  })

  register('todo:reopen', ({ id }) => {
    const db = manager.require().connection.orm
    const result = reopenTodo(db, id)
    if (result.namesChanged) publishProposed()
    todoListMoved()
    return null
  })

  // F-9.13: the Changes log. An undo goes through the tombstones; what it removed or moved
  // reaches the windows as the same events the original writes would have.
  register('changes:list', ({ before, limit }) =>
    listChanges(manager.require().connection.orm, { before, limit })
  )

  const publishUndo = (outcome: UndoOutcome): ChangeUndoReply => {
    const session = manager.require()
    const db = session.connection.orm
    // F-9.15: a sheet an upload made takes its picture with it.
    for (const image of outcome.removedImages) {
      removeImageAsset(session.folder, ENTITY_IMAGES_DIR, image)
    }
    const tags = outcome.restoredTagIds.flatMap((id) => getTagWithUsage(db, id) ?? [])
    const entities = outcome.restoredEntityIds.flatMap((id) => getEntity(db, id) ?? [])
    if (outcome.removedTagIds.length > 0 || tags.length > 0) {
      rescanManuscript(db)
      publishProposed()
    }
    for (const restored of tags) emit(windows(), 'tag:changed', restored)
    for (const restored of entities) emit(windows(), 'entity:changed', restored)
    if (
      outcome.removedEntityIds.length > 0 ||
      outcome.removedTagIds.length > 0 ||
      tags.length > 0 ||
      entities.length > 0
    ) {
      void syncSpelling()
      emit(windows(), 'continuity:changed', { nodeIds: [] })
    }
    if (outcome.nodeIds.length > 0 || outcome.removedTagIds.length > 0) {
      emit(windows(), 'documentTag:changed', { nodeIds: outcome.nodeIds })
    }
    if (outcome.entityIds.length > 0)
      emit(windows(), 'fact:changed', { entityIds: outcome.entityIds })
    emit(windows(), 'changes:changed', {})
    queueTodo(db)
    return {
      entries: outcome.entries,
      removedEntityIds: outcome.removedEntityIds,
      removedTagIds: outcome.removedTagIds,
      entityIds: outcome.entityIds,
      nodeIds: outcome.nodeIds,
      entities,
      tags
    }
  }

  register('changes:undo', ({ id }) =>
    publishUndo(undoChange(manager.require().connection.orm, id))
  )

  register('changes:undoRun', ({ runId }) =>
    publishUndo(undoRun(manager.require().connection.orm, runId))
  )

  // F-9.15: what Organise and the chat applied through the stores, logged so Changes is its Undo.
  register('changes:record', (input) => {
    const entries = recordChanges(manager.require().connection.orm, input, new Date().toISOString())
    emit(windows(), 'changes:changed', {})
    return entries
  })

  // F-5.25: the chat's Clear the story bible. The backup comes first (a failure refuses with its
  // cause and nothing is deleted); then one transaction, one Changes row, and the same events the
  // one-by-one deletes send. Pictures and uploaded originals stay on disk for the Undo.
  register('bible:clear', ({ selection, run }) => {
    const db = manager.require().connection.orm
    backups.backupNow()
    const outcome = clearStoryBible(
      db,
      selection,
      changeRunId('chat', run),
      new Date().toISOString()
    )
    if (outcome.linkNodeIds.length > 0) {
      emit(windows(), 'mention:changed', { nodeIds: outcome.linkNodeIds })
      emit(windows(), 'documentTag:changed', { nodeIds: outcome.linkNodeIds })
    }
    if (outcome.removedTagIds.length > 0) publishProposed()
    if (outcome.removedEntityIds.length > 0 || outcome.removedTagIds.length > 0) {
      void syncSpelling()
      emit(windows(), 'continuity:changed', { nodeIds: [] })
      emit(windows(), 'fact:changed', { entityIds: outcome.removedEntityIds })
    }
    emit(windows(), 'changes:changed', {})
    queueTodo(db)
    return {
      entry: outcome.entry,
      counts: outcome.counts,
      removedEntityIds: outcome.removedEntityIds,
      removedTagIds: outcome.removedTagIds,
      removedLibraryIds: outcome.removedLibraryIds,
      notesNodeIds: outcome.notesNodeIds
    }
  })

  /**
   * F-9.5: the story bible out of the app. The JSON file is the reusable library — every kind
   * reads it back — and the CSV is one kind's rows for a spreadsheet. The file lands where the
   * author says; the default sits beside the project folder, as the disclosure report does.
   */
  register('entity:export', async ({ kind, format, path: given }) => {
    const session = manager.require()
    const rows = listEntities(session.connection.orm).filter((row) => row.kind === kind)
    const label = requireCategory(session.connection.orm, kind).name.toLowerCase()
    if (rows.length === 0) {
      throw new AppError('VALIDATION', `No ${label} to export`, { kind })
    }
    const chosen =
      given ??
      (await dialogs.chooseExportPath(
        entityExportFileName(sanitizeName(session.info.name), label, format),
        [{ name: ENTITY_EXCHANGE_LABEL[format], extensions: [ENTITY_EXCHANGE_EXTENSIONS[format]] }],
        path.dirname(session.folder)
      ))
    if (chosen === null) return null
    const categories = listCategories(session.connection.orm)
    writeEntityFile(
      chosen,
      format,
      rows.map((row) => toExchangeRecord(row, categories)),
      categories
    )
    diagnostics.count('export.run')
    return { path: chosen, count: rows.length }
  })

  // F-9.5: reading an entity file writes nothing, exactly as `import:open` does for a manuscript.
  // The plan goes to the renderer, the author sets an action per row, and only `entity:importCommit`
  // touches the project.
  register('entity:importOpen', async ({ kind, path: given }) => {
    const session = manager.require()
    const chosen = given ?? (await dialogs.chooseEntityLibraryFile())
    if (chosen === null) return null
    const file = readEntityFile(chosen, kind, listCategories(session.connection.orm))
    const { items, duplicates } = planEntityImport(
      listEntities(session.connection.orm),
      file.records
    )
    return { source: { name: file.name, format: file.format }, items, duplicates }
  })

  /**
   * F-9.5: the reviewed rows, in one transaction. However many tags the new entities created
   * (F-9.4), the manuscript is rescanned once and the proposals published once; each created or
   * renamed tag is still announced on its own, because a bank merges tags one at a time.
   */
  register('entity:importCommit', ({ items }) => {
    const db = manager.require().connection.orm
    const result = importEntities(db, items)
    const announce = result.tagChanges.filter(
      (change) => change.created || change.renamed || change.aliased
    )
    if (announce.length > 0) {
      rescanManuscript(db)
      publishProposed()
      for (const change of announce) emit(windows(), 'tag:changed', change.tag)
    }
    void syncSpelling()
    queueTodo(db)
    return {
      entities: result.entities,
      added: result.added,
      merged: result.merged,
      replaced: result.replaced
    }
  })

  // F-9.11: the story-bible categories. The library is code; the project's own categories and
  // the author's renames of library ones are rows.
  register('category:list', () => listCategories(manager.require().connection.orm))

  register('category:create', (input) =>
    createCategory(manager.require().connection.orm, input, 'author')
  )

  register('category:update', ({ id, ...patch }) =>
    updateCategory(manager.require().connection.orm, id, patch)
  )

  // F-9.19: a category's fields from Settings › Story bible; moved text reaches the open windows.
  register('category:setFields', ({ id, fields }) => {
    const db = manager.require().connection.orm
    const result = setCategoryFields(db, id, fields)
    if (result.entities.length > 0) {
      emit(windows(), 'fact:changed', { entityIds: result.entities.map((sheet) => sheet.id) })
    }
    queueTodo(db)
    return result
  })

  // F-9.8: the context library. Adding a file stores its original and reads its text; nothing is
  // sent anywhere until the author confirms the estimate, and nothing reaches the story bible
  // until they apply the review.
  register('library:list', () => listContextFiles(manager.require().connection.orm))

  register('library:choose', async () => (await dialogs.chooseContextFiles()) ?? [])

  register('library:add', async ({ paths, replaceId }) => {
    const session = manager.require()
    const chosen = paths ?? (await dialogs.chooseContextFiles())
    if (chosen === null) return null
    const sources = (replaceId === undefined ? chosen : chosen.slice(0, 1)).map((file) => ({
      name: path.basename(file),
      read: () => fs.readFileSync(file)
    }))
    return addContextFiles(session.connection.orm, session.folder, sources, replaceId)
  })

  register('library:addData', async ({ files }) => {
    const session = manager.require()
    const sources = files.map((file) => ({ name: file.name, read: () => Buffer.from(file.data) }))
    return addContextFiles(session.connection.orm, session.folder, sources)
  })

  register('library:open', async ({ id }) => {
    const session = manager.require()
    const row = requireContextFileRow(session.connection.orm, id)
    const failure = await openPath(storedPath(session.folder, row.stored))
    if (failure !== '') throw new AppError('IO', failure)
    return null
  })

  register('library:estimate', async ({ fileIds }) => {
    const session = manager.require()
    const db = session.connection.orm
    const source = sourceOf(db)
    const model = ai.get(source)?.resolveModel('strong') ?? ''
    const estimate = await estimateContextImport(db, session.folder, fileIds, model)
    if (source !== 'cloud') return estimate
    // AI-BILLING-SPEC flow 2, R3, E4: on Cloud the confirm shows the hosted quote (the chunks'
    // sum at the server's price, padded by the safety factor), not the provider's own price.
    const pricing = appState.get().cloudPricing?.pricing ?? bundledPricing()
    const quote = hostedQuote(pricing, model, estimate.tokensIn, estimate.tokensOut)
    return { ...estimate, costUsd: quote.costUsd, priced: quote.priced }
  })

  // Like `import:detectStructure` (F-12.3): the parent `requestId` is registered here so
  // `ai:cancel` stops the whole pass; expected AI failures come back as data.
  register('library:process', async ({ fileIds, requestId }): Promise<ContextProcessResult> => {
    const session = manager.require()
    const db = session.connection.orm
    const controller = registerInflight(requestId)
    try {
      const review = await sortContextFiles(db, requestDeps(db), {
        folder: session.folder,
        fileIds,
        requestId,
        signal: controller.signal,
        onProgress: (progress) => emit(windows(), 'library:progress', progress)
      })
      return { ok: true, review }
    } catch (err) {
      if (err instanceof AiProviderError) return aiFailure(err.code, err.message)
      throw err
    } finally {
      releaseInflight(requestId)
    }
  })

  // F-9.9: the review chat. Like `library:process`, the parent `requestId` is registered here so
  // `ai:cancel` stops the request or its retry; expected AI failures come back as data.
  register(
    'library:reviewChat',
    async ({ review, message, history, requestId }): Promise<ReviewChatResult> => {
      const db = manager.require().connection.orm
      const controller = registerInflight(requestId)
      try {
        const answer = await runReviewChat(db, requestDeps(db), {
          review,
          message,
          history,
          requestId,
          signal: controller.signal
        })
        return { ok: true, ...answer, requestId }
      } catch (err) {
        if (err instanceof AiProviderError)
          return { ...aiFailure(err.code, err.message), requestId }
        throw err
      } finally {
        releaseInflight(requestId)
      }
    }
  )

  /**
   * F-9.8: the reviewed upload, in one transaction. As with `entity:importCommit`, the manuscript
   * is rescanned once however many tags the sheets created, each created tag is announced on its
   * own, and the new names reach the spellchecker.
   */
  register('library:apply', async ({ review }) => {
    const session = manager.require()
    const db = session.connection.orm
    const result = await applyContextReview(db, session.folder, review)
    const announce = result.tagChanges.filter(
      (change) => change.created || change.renamed || change.aliased
    )
    if (announce.length > 0) {
      rescanManuscript(db)
      publishProposed()
      for (const change of announce) emit(windows(), 'tag:changed', change.tag)
    }
    void syncSpelling()
    queueTodo(db)
    return {
      entities: result.entities,
      files: result.files,
      categories: result.categories,
      created: result.created,
      updated: result.updated,
      notes: result.notes
    }
  })

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

  // 2026-10-08: refund the unused balance of one purchase; the Worker holds it before Lemon
  // Squeezy is asked, so a repeat never refunds twice.
  register('account:refund', ({ orderId }) => account.refund(orderId))

  // AI-BILLING-SPEC E7: one page of the account's ledger, newest first.
  register('account:getUsage', ({ cursor }) => account.usage(cursor))

  // AI-BILLING-SPEC P5: the hosted price table, refreshed when stale; null before any answer.
  register('account:getPricing', async () =>
    cloudPricing === undefined
      ? (appState.get().cloudPricing?.pricing ?? null)
      : cloudPricing.refresh()
  )

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

  // F-15.9: the Supporter license. The service owns the cached token, its verification, and the
  // daily refresh; a change it makes by itself (a background refresh, a sign-in, a sign-out)
  // arrives as `account:supporterChanged`. The token itself never crosses IPC.
  register('account:getSupporter', () => account.supporter())

  register('account:refreshSupporter', async () => {
    const status = await account.refreshLicense()
    // M1: a license just bought (or refunded) ends or starts the read-only state at once.
    access.refresh()
    return status
  })

  // The same gate as `account:buyCredits`: the Worker builds the checkout and this opens it, and
  // nothing but a Lemon Squeezy checkout is ever handed to the browser.
  register('account:buySupporter', async () => {
    const url = await account.supporterCheckoutUrl()
    if (!isCheckoutUrl(url)) {
      throw new AppError('VALIDATION', `Only a checkout on ${CHECKOUT_HOST_SUFFIX} can be opened`)
    }
    await openExternal(url)
    return null
  })

  register('account:setAccent', ({ accent }) => account.setAccent(accent))

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

  // F-15.8: opt-in diagnostics. The service owns the switch, what has been recorded, and the
  // flush timer; a change it makes by itself (a report left, or the author switched it in
  // another window) arrives as `diagnostics:changed`.
  register('diagnostics:getState', () => diagnostics.state())

  register('diagnostics:setEnabled', ({ on }) => diagnostics.setEnabled(on))

  // The renderer has no way to store or send anything itself: it hands the error over and main
  // scrubs it again before it is queued, or drops it when diagnostics are off.
  register('diagnostics:reportRendererError', (error) => {
    diagnostics.reportError('renderer', error)
    return null
  })

  // F-8.4: automatic backups. The service owns the settings, the schedule, and the files; a
  // backup it makes by itself (on the schedule, on close) arrives as `backups:changed`.
  register('backups:get', () => backups.state())

  register('backups:setSettings', ({ patch }) => backups.setSettings(patch))

  register('backups:chooseFolder', async () => {
    const folder = await dialogs.chooseBackupFolder(backups.state().folder)
    return folder === null ? backups.state() : backups.setFolder(folder)
  })

  register('backups:now', () => backups.backupNow())

  register('backups:reveal', async () => {
    const { folder } = backups.state()
    fs.mkdirSync(folder, { recursive: true })
    const failure = await openPath(folder)
    if (failure !== '') throw new AppError('IO', failure)
    return null
  })

  // Restoring never overwrites: the backup becomes a new project next to the original (or in
  // the folder the author picks) and opens in place of the current one, which closes — and is
  // backed up on close — first.
  register('backups:restore', async ({ file }) => {
    let zip: string
    let parent: string
    if (file !== undefined) {
      zip = backups.listedBackup(file).file
      parent = path.dirname(manager.require().folder)
    } else {
      const chosen = await dialogs.chooseBackupFile(backups.state().folder)
      if (chosen === null) return null
      const into = await dialogs.chooseRestoreParent()
      if (into === null) return null
      zip = chosen
      parent = into
    }
    return backups.restore(zip, parent, (folder) => manager.open(folder))
  })

  // F-5.1: the key is accepted by `ai:setKey` once and never returned; status carries a mask.
  // 2026-10-07: the key is for the own-key provider in effect (OpenRouter or OpenAI).
  const ownKey = (): OwnKeyProvider => ai.ownKeyProvider()
  const aiStatus = (): AiStatus => ({
    provider: ownKey(),
    hasKey: keyStore.hasKey(ownKey()),
    hint: keyStore.getHint(ownKey()),
    encryption: keyStore.encryption(),
    canStoreKey: keyStore.canStoreProviderKey(),
    // F-15.4: both maps, since the AI tab edits the one the project's source names.
    models: appState.get().models,
    local: appState.get().localAi
  })

  register('ai:getStatus', aiStatus)

  // Developer tools (2026-10-07): the switch, the panel's buffers, Chromium's DevTools, and the
  // copied report. All `read`: none of them touches what the author wrote.
  register('devtools:getState', () => devtools.state())
  register('devtools:setEnabled', ({ on }) => devtools.setEnabled(on))
  register('devtools:snapshot', () => devtools.snapshot())
  register('devtools:requestText', ({ id }) => devtools.text(id))
  register('devtools:log', ({ level, message, details }) => {
    devtools.record(level, 'renderer', message, details)
    return null
  })
  register('devtools:ghostSkip', ({ reason }) => {
    devtools.ghostSkip(reason)
    return null
  })
  register('devtools:aiNote', ({ requestId, note }) => {
    devtools.annotate(requestId, note)
    return null
  })
  register('devtools:clear', ({ what }) => {
    devtools.clear(what)
    return null
  })
  register('devtools:openChromium', () => {
    devtools.openChromium()
    return null
  })
  register('devtools:report', () => {
    const state = appState.get()
    const projectAi =
      manager.current() === null ? null : getAiSettings(manager.require().connection.orm)
    const snapshot = devtools.snapshot()
    const status = aiStatus()
    return formatDiagnosticsReport({
      generatedAt: new Date().toISOString(),
      app: {
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron ?? '-',
        node: process.versions.node,
        chrome: process.versions.chrome ?? '-'
      },
      ai: {
        source: projectAi?.source ?? null,
        ownKeyProvider: status.provider,
        keySaved: status.hasKey,
        encryption: status.encryption,
        models: status.models
      },
      // Not the recents, the window, or the diagnostics queue: paths and crash reports, not settings.
      settings: {
        app: {
          models: state.models,
          routing: state.routing,
          localAi: state.localAi,
          aiUsage: state.aiUsage,
          view: state.view,
          updates: { channel: state.updates.channel, autoCheck: state.updates.autoCheck },
          backups: state.backups,
          diagnosticsEnabled: state.diagnostics.enabled,
          devTools: state.devTools
        },
        project: projectAi
      },
      log: snapshot.log,
      requests: snapshot.requests
    })
  })

  register('ai:setKey', ({ key }) => {
    keyStore.setKey(ownKey(), key)
    backfillSummaries(true)
    return aiStatus()
  })

  register('ai:clearKey', () => {
    keyStore.clearKey(ownKey())
    return aiStatus()
  })

  register('ai:setOwnKeyProvider', ({ provider }) => {
    appState.update((s) => ({ ...s, ownKeyProvider: provider }))
    if (keyStore.hasKey(provider)) backfillSummaries(true)
    return aiStatus()
  })

  // AI-BILLING-SPEC M8, R4: the request path reads the overrides live (`buildAiRequestDeps`).
  const modelChoice = (): AiModelChoice => ({
    routing: appState.get().routing,
    cloudPricing: appState.get().cloudPricing?.pricing ?? null
  })

  register('ai:getModelChoice', modelChoice)

  register('ai:setRouting', (routing) => {
    appState.update((s) => ({ ...s, routing }))
    return modelChoice()
  })

  // F-5.15: the registry reads the address live and rebuilds the local client when it changes.
  register('ai:setLocalEndpoint', ({ baseUrl }) => {
    appState.update((s) => ({ ...s, localAi: { baseUrl: baseUrl.replace(/\/+$/, '') } }))
    backfillSummaries(true)
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

  register('ai:usageHistory', ({ offset, limit }) =>
    usageHistory(manager.require().connection.orm, offset, limit)
  )

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
        // Developer tools: an answer post-processing emptied is the silent "shows nothing" case.
        if (text === '') devtools.ghostEmpty(requestId)
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
        // 2026-10-07: an answer that was all reasoning is a failure the inspector explains.
        if (err instanceof AiCutOffError) {
          devtools.annotate(requestId, `No suggestion: ${err.message} Treated as a failure.`)
        }
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

  // F-14.12: Proofread a scene or the selection, JSON from the fast tier, not streamed. The
  // reply carries the fixes main kept — each a small correction of a passage that is in the
  // text sent and occurs once in the saved scene, `dropped` counts the rest — and one proposal
  // (F-14.5) holds them as JSON, even when there is none, so the cost still shows; it is
  // flagged when any fix failed the fidelity check (F-14.7). The renderer applies a fix on accept.
  register('ai:proofread', async ({ nodeId, requestId, selection }): Promise<AiProofreadResult> => {
    try {
      const db = manager.require().connection.orm
      const deps = requestDeps(db)
      const result = await runProofread(db, deps, { nodeId, selection, requestId })
      const { fixes, usage, costUsd, cached, model } = result
      const flaggedFix = fixes.find((entry) => entry.flagged)
      const proposal = createProposal(db, {
        feature: 'proofread',
        nodeId,
        promptVersion: result.promptVersion,
        model,
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        costUsd,
        cached,
        content: JSON.stringify(fixes),
        flagged: flaggedFix !== undefined,
        violation: flaggedFix?.violation ?? null,
        regeneratedFrom: null
      })
      return {
        ok: true,
        fixes,
        scope: result.scope,
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
      if (err instanceof AiProviderError) return { ...aiFailure(err.code, err.message), requestId }
      throw err
    }
  })

  /**
   * F-14.15: the edit passes. One runner for the session; it reads the open project through the
   * manager at every scene, and `manager.onChange` clears it, so a pass never writes into another
   * project. Every move of a pass reaches every window as `editPass:changed`.
   */
  const editPasses = createEditPassRunner({
    db: () => (manager.current() === null ? null : manager.require().connection.orm),
    requestDeps: (db) => requestDeps(db),
    onChange: (summary) => emit(windows(), 'editPass:changed', summary)
  })
  const passSummary = (db: AiDb, id: string): ReturnType<typeof toSummary> => {
    const running = editPasses.running()
    return toSummary(db, requirePass(db, id), running?.passId === id ? running.nodeId : null)
  }
  const startResult = (start: () => ReturnType<typeof toSummary>): EditPassStartResult => {
    try {
      return { ok: true, pass: start() }
    } catch (err) {
      if (err instanceof AiProviderError) return aiFailure(err.code, err.message)
      throw err
    }
  }

  register('editPass:start', ({ type, instruction, nodeIds }) => {
    const db = manager.require().connection.orm
    const text = instruction?.trim() ? instruction.trim() : null
    if (type === 'custom' && text === null) {
      throw new AppError('VALIDATION', 'Write an instruction for the custom pass')
    }
    const documents = new Set(
      listNodes(db)
        .filter((row) => row.kind === 'document')
        .map((row) => row.id)
    )
    const ids = [...new Set(nodeIds)].filter((id) => documents.has(id))
    if (ids.length === 0) throw new AppError('VALIDATION', 'Pick at least one scene for the pass')
    return startResult(() =>
      editPasses.start({ type, instruction: type === 'custom' ? text : null, nodeIds: ids })
    )
  })

  register('editPass:resume', ({ id }) => startResult(() => editPasses.resume(id)))

  register('editPass:cancel', ({ id }) => {
    editPasses.cancel(id)
    return null
  })

  register('editPass:list', () => {
    const db = manager.require().connection.orm
    return listPassRows(db).map((row) => passSummary(db, row.id))
  })

  register('editPass:get', ({ id }) => {
    const db = manager.require().connection.orm
    const running = editPasses.running()
    return passDetail(db, id, running?.passId === id ? running.nodeId : null)
  })

  register('editPass:delete', ({ id }) => {
    deletePass(manager.require().connection.orm, id)
    return null
  })

  register('editPass:changes', ({ nodeId }) =>
    pendingChangesFor(manager.require().connection.orm, nodeId)
  )

  // A scene's proposal (F-14.5) settles once none of its changes is pending: accepted when every
  // one was, rejected when none was, acceptedPart otherwise (a stale change counts as not taken).
  register('editPass:settle', ({ ids, status }) => {
    const db = manager.require().connection.orm
    const moved = settleChanges(db, ids, status)
    const proposals = new Set(moved.flatMap((change) => change.proposalId ?? []))
    for (const proposalId of proposals) {
      const counts = proposalChangeCounts(db, proposalId)
      if (counts.pending > 0) continue
      const taken = counts.accepted
      const total = taken + counts.rejected + counts.stale
      settleProposal(
        db,
        proposalId,
        taken === 0 ? 'rejected' : taken === total ? 'accepted' : 'acceptedPart'
      )
    }
    for (const passId of new Set(moved.map((change) => change.passId))) {
      emit(windows(), 'editPass:changed', passSummary(db, passId))
    }
    return moved
  })

  register('editPass:presets', () => getPresets(manager.require().connection.orm))

  register('editPass:setPresets', (presets) =>
    setPresets(manager.require().connection.orm, presets)
  )

  // F-5.17: What should come next? on a scene, JSON from the fast tier, not streamed. The reply
  // carries up to three directions (`dropped` counts the rest) and one proposal (F-14.5) holds
  // them as JSON, pending and never flagged: directions are advice in the chat, and one becomes
  // prose only through Author mode, which writes its own proposal. Nothing enters the manuscript.
  register('ai:whatNext', async ({ nodeId, requestId, before }): Promise<AiWhatNextResult> => {
    try {
      const db = manager.require().connection.orm
      const deps = requestDeps(db)
      const result = await runWhatNext(db, deps, { nodeId, before, requestId })
      const { directions, dropped, usage, costUsd, cached, model } = result
      const proposal = createProposal(db, {
        feature: 'whatNext',
        nodeId,
        promptVersion: result.promptVersion,
        model,
        promptTokens: usage.inputTokens,
        completionTokens: usage.outputTokens,
        costUsd,
        cached,
        content: JSON.stringify(directions),
        flagged: false,
        violation: null
      })
      return {
        ok: true,
        directions,
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

  // F-5.19: the assistant router, JSON from the fast tier (or no request at all for a local
  // decision). No proposal: the decision is never shown as content, only acted on by the
  // renderer, which then calls the chosen feature's own channel. The ledger row is the cost.
  register(
    'ai:route',
    async ({ nodeId, message, history, selection, requestId }): Promise<AiRouteResult> => {
      try {
        const db = manager.require().connection.orm
        const result = await runRoute(db, requestDeps(db), {
          nodeId,
          message,
          history,
          selection,
          requestId
        })
        const { action, instruction, routedBy, usage, costUsd, cached, model } = result
        return {
          ok: true,
          action,
          instruction,
          routedBy,
          usage,
          costUsd,
          cached,
          model,
          requestId
        }
      } catch (err) {
        if (err instanceof AiProviderError)
          return { ...aiFailure(err.code, err.message), requestId }
        throw err
      }
    }
  )

  // F-5.20: a suggested synopsis for the side panel, JSON from the fast tier. One proposal
  // (F-14.5) holds it, pending and never flagged (a synopsis is a planning note, not prose);
  // the renderer writes it into the panel only when the author accepts.
  register(
    'ai:suggestSynopsis',
    async ({ nodeId, requestId }): Promise<AiSuggestSynopsisResult> => {
      try {
        const db = manager.require().connection.orm
        const result = await runSuggestSynopsis(db, requestDeps(db), { nodeId, requestId })
        const { synopsis, truncated, usage, costUsd, cached, model } = result
        const proposal = createProposal(db, {
          feature: 'synopsis',
          nodeId,
          promptVersion: result.promptVersion,
          model,
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
          costUsd,
          cached,
          content: synopsis,
          flagged: false,
          violation: null
        })
        return {
          ok: true,
          synopsis,
          truncated,
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

  // F-5.20: suggested key points for the scene's notes, JSON from the fast tier. One proposal
  // holds the points as JSON, pending and never flagged; nothing enters the notes until the
  // author accepts.
  register(
    'ai:suggestNotes',
    async ({ nodeId, requestId, instruction }): Promise<AiSuggestNotesResult> => {
      try {
        const db = manager.require().connection.orm
        const result = await runSuggestNotes(db, requestDeps(db), {
          nodeId,
          requestId,
          instruction
        })
        const { points, dropped, truncated, usage, costUsd, cached, model } = result
        const proposal = createProposal(db, {
          feature: 'notesSuggest',
          nodeId,
          promptVersion: result.promptVersion,
          model,
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
          costUsd,
          cached,
          content: JSON.stringify(points),
          flagged: false,
          violation: null
        })
        return {
          ok: true,
          points,
          dropped,
          truncated,
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

  // F-13.4: Check consistency on one scene, JSON from the strong tier, not streamed. The run
  // replaces the scene's open findings (dismissed ones stay dismissed) and every window hears
  // `continuity:changed`; the reply carries the scene's open findings as stored, each citing a
  // passage of the text that was sent and a reference main built itself. A run that found
  // something records one proposal (F-14.5) holding the findings as JSON, flagged when any fix
  // failed the fidelity check (F-14.7). Nothing enters the manuscript here.
  register('ai:continuity', async ({ nodeId, requestId }): Promise<AiContinuityResult> => {
    try {
      const db = manager.require().connection.orm
      const deps = requestDeps(db)
      const run = await runContinuity(db, deps, { nodeId, requestId })
      const stored = storeContinuityRun(db, nodeId, 'request', run, deps.now())
      if (stored.changed) {
        emit(windows(), 'continuity:changed', { nodeIds: [nodeId] })
        // F-9.16: the open findings are To do items (and a fact conflict may now defer to one).
        queueTodo(db)
      }
      return {
        ok: true,
        findings: stored.findings,
        truncated: run.truncated,
        dropped: run.dropped,
        references: run.references,
        usage: run.usage,
        costUsd: run.costUsd,
        cached: run.cached,
        model: run.model,
        proposalId: stored.proposalId,
        requestId
      }
    } catch (err) {
      if (err instanceof AiProviderError) return { ...aiFailure(err.code, err.message), requestId }
      throw err
    }
  })

  // F-13.4: what the Continuity panel lists and its quiet count counts.
  register('continuity:list', () => listOpenFindings(manager.require().connection.orm))

  // F-13.4: Dismiss ("changed in the story": never raised again for that scene) or the record
  // that a fix was applied. The proposal the finding belongs to is settled with its last open
  // finding, and counted as `proposal:settle` counts one.
  register('continuity:settle', ({ id, status }) => {
    const db = manager.require().connection.orm
    const { finding, proposal } = settleContinuityFinding(db, id, status)
    if (proposal === 'rejected') diagnostics.count('proposal.reject')
    else if (proposal !== null && proposal !== 'regenerated') diagnostics.count('proposal.accept')
    emit(windows(), 'continuity:changed', { nodeIds: [finding.nodeId] })
    // F-9.16: the To do list lists the open findings.
    todoListMoved()
    return finding
  })

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

  // F-5.22: one chat agent turn. Each lookup is announced as `ai:agentStep` while the run goes
  // on; the reply carries the answer, the citations main verified, and the edits it resolved
  // against the project as it is now, none of them applied (the renderer applies or asks, per
  // the switch). One proposal (F-14.5) holds the answer and the edits; it stays pending until
  // the renderer settles it with the edits' fate.
  register(
    'ai:agent',
    async ({ nodeId, message, history, access, focus, requestId }): Promise<AiAgentResult> => {
      try {
        const db = manager.require().connection.orm
        const deps = requestDeps(db)
        const result = await runAgent(
          db,
          deps,
          { nodeId, message, history, access, focus, requestId },
          (step) => emit(windows(), 'ai:agentStep', { requestId, step }),
          {
            answer: (delta) => emit(windows(), 'ai:agentDelta', { requestId, delta, reset: false }),
            reset: () => emit(windows(), 'ai:agentDelta', { requestId, delta: '', reset: true }),
            note: (stepId, note) => devtools.annotate(stepId, note)
          }
        )
        const { answer, query, steps, changes, organise, dropped, usage, costUsd, cached, model } =
          result
        const proposal = createProposal(db, {
          feature: 'agent',
          nodeId,
          promptVersion: result.promptVersion,
          model,
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
          costUsd,
          cached,
          content: JSON.stringify({ answer, edits: changes.map((change) => change.edit) }),
          flagged: changes.some((change) => change.violation !== null),
          violation: changes.find((change) => change.violation !== null)?.violation ?? null
        })
        return {
          ok: true,
          answer,
          query,
          steps,
          changes,
          organise,
          dropped,
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

  // 2026-10-07: the prose behind one of the agent's write intents, streamed as
  // `ai:agentDraftDelta` while the first draft arrives. The answer is a proposal (F-14.5) of the
  // drafting feature (`chat` for an insertion, `rewrite` for a passage), settled by the renderer
  // when the author accepts or dismisses the ghost text or the change.
  register(
    'ai:agentDraft',
    async ({ nodeId, brief, words, before, after, passage, requestId }): Promise<AiChatResult> => {
      try {
        const db = manager.require().connection.orm
        const deps = requestDeps(db)
        const result = await draftForAgent(
          db,
          deps,
          { nodeId, brief, words, before, after, passage, requestId },
          (delta) => emit(windows(), 'ai:agentDraftDelta', { requestId, delta })
        )
        const { text, usage, costUsd, cached, model, flagged, violation } = result
        const proposal = createProposal(db, {
          feature: passage === null ? 'chat' : 'rewrite',
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
        if (err instanceof AiCutOffError) {
          devtools.annotate(requestId, `Nothing drafted: ${err.message} Treated as a failure.`)
        }
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
  register(
    'ai:query',
    async ({ nodeId, message, history, requestId, pinActive }): Promise<AiQueryResult> => {
      try {
        const db = manager.require().connection.orm
        const deps = requestDeps(db)
        const result = await runQuery(db, deps, { nodeId, message, history, requestId, pinActive })
        const {
          answer,
          found,
          uncited,
          citations,
          sheets,
          also,
          dropped,
          usage,
          costUsd,
          cached,
          model
        } = result
        const proposal = createProposal(db, {
          feature: 'query',
          nodeId,
          promptVersion: result.promptVersion,
          model,
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
          costUsd,
          cached,
          content: JSON.stringify({ answer, citations, sheets }),
          flagged: false,
          violation: null
        })
        return {
          ok: true,
          answer,
          found,
          uncited,
          citations,
          sheets,
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
        if (err instanceof AiProviderError)
          return { ...aiFailure(err.code, err.message), requestId }
        throw err
      }
    }
  )

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
    // F-9.14: "Summarize all scenes" does not get past the conversion's cost dialog: the scenes
    // it holds stay held, and the dialog opens again (Later is lifted) so the author can decide.
    const hold = conversionPending(db)
    const queued = queue.indexAll('summary', staleSummaryNodeIds(db, { holdOutdated: hold }))
    if (hold) {
      conversionDeferred = false
      emit(windows(), 'knowledge:conversionChanged', conversionOf(db))
    }
    return { ok: true, queued, status: queue.status() }
  })

  // F-9.14 (D11): the conversion pass. The dialog reads the estimate; Update now backs the
  // project up first (the Settings › Backups path, so a failed backup stops it with its cause),
  // records the go-ahead, and queues every scene to re-read; Later closes it for this session.
  register('knowledge:conversion', () => conversionOf(manager.require().connection.orm))

  register('knowledge:convert', () => {
    const db = manager.require().connection.orm
    const state = conversionOf(db)
    if (state.state !== 'pending') return state
    backups.backupNow()
    confirmConversion(db)
    if (queue.status().paused !== null) queue.resume()
    queue.indexAll('summary', staleSummaryNodeIds(db))
    const next = conversionOf(db)
    emit(windows(), 'knowledge:conversionChanged', next)
    return next
  })

  register('knowledge:later', () => {
    conversionDeferred = true
    const next = conversionOf(manager.require().connection.orm)
    emit(windows(), 'knowledge:conversionChanged', next)
    return next
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
    // F-15.8: `acceptedPart` put AI text in the manuscript too; `regenerated` settled nothing.
    if (status === 'rejected') diagnostics.count('proposal.reject')
    else if (status !== 'regenerated') diagnostics.count('proposal.accept')
    return null
  })

  // F-12.3: the tag candidates an import left on a scene, newest first — the tag bar asks for
  // them when the author opens a document and settles the row as it settles an F-4.7 answer.
  // A row whose content is not a list of names answers with no tags rather than an error the
  // author cannot act on: the tag bar shows nothing and settles it, so the row does not linger.
  register('proposal:pendingTags', ({ nodeId }): PendingTagProposal | null => {
    const db = manager.require().connection.orm
    const row = listPendingProposals(db, 'importStructure', nodeId)[0]
    if (!row) return null
    return { proposalId: row.id, tags: proposalTags(row.content), model: row.model }
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

  // F-14.14: the learned style notes (AI-made, refreshed by the voice job) and their Clear.
  register('voice:notes', () => getVoiceNotes(manager.require().connection.orm))

  register('voice:clearNotes', () => clearVoiceNotes(manager.require().connection.orm, new Date()))

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
    diagnostics.count('export.run')
    return { path: chosen }
  })

  // F-12.2: reading a manuscript writes nothing. The draft goes to the renderer, the author
  // corrects it there, and only `import:commit` (or `import:createProject` from the welcome
  // screen, where no project is open) writes it. With a project open, its existing outline
  // joins the draft so the author sorts both in one tree.
  register('import:open', async ({ path: given }) => {
    const session = manager.current() === null ? null : manager.require()
    const chosen = given ?? (await dialogs.chooseManuscriptFile())
    if (chosen === null) return null
    const file = await readManuscript(chosen)
    const draft = buildDraft(file.blocks, {
      name: file.name,
      format: file.format,
      novelFormat: session?.info.format ?? 'novel'
    })
    return session === null ? draft : withExisting(session.connection.orm, draft)
  })

  // F-12.3: the AI pass over the draft. The parent `requestId` is registered here, not in the
  // request path (each chunk registers its own `<id>:c<n>` there), so `ai:cancel` stops the
  // whole pass and not just the chunk in flight. Expected AI failures — no key, the dial, the
  // cap, a stop — come back as data like `ai:recommendTags`; NO_PROJECT stays an error.
  register('import:detectStructure', async ({ draft, requestId }): Promise<ImportDetectResult> => {
    const db = manager.require().connection.orm
    const controller = registerInflight(requestId)
    try {
      const result = await detectImportStructure(db, requestDeps(db), {
        draft,
        requestId,
        signal: controller.signal,
        onProgress: (progress) => emit(windows(), 'import:detectProgress', progress)
      })
      return { ok: true, ...result }
    } catch (err) {
      if (err instanceof AiProviderError) return aiFailure(err.code, err.message)
      throw err
    } finally {
      releaseInflight(requestId)
    }
  })

  /**
   * What follows every import write, into the open project or a new one: the AI pass's tag
   * candidates (F-12.3) become pending proposals on the created scenes, so the tag bar can offer
   * them one by one (F-4.7) whenever the author opens the scene. They cost nothing: the pass
   * itself was paid for by the chunk rows, and these only carry the names forward. The draft
   * does not record which model answered, so the row names the current fast model (or `import`
   * when there is none) and the catalogued prompt version of the pass that could have produced
   * it. Then the imported scenes are tracked like typed ones (mentions scanned, summaries
   * queued), existing scenes a merge or a split rewrote go through `documentsWritten` like a
   * save, and deleted ones tell the continuity panel to drop their findings.
   */
  const afterImport = (db: TreeDb, result: ImportResult): void => {
    if (result.tagCandidates.length > 0) {
      const model = ai.get(sourceOf(db))?.resolveModel('fast') ?? 'import'
      for (const candidate of result.tagCandidates) {
        createProposal(db, {
          feature: 'importStructure',
          nodeId: candidate.nodeId,
          promptVersion: IMPORT_STRUCTURE_PROMPT_VERSION,
          model,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          cached: false,
          content: JSON.stringify(candidate.tags),
          flagged: null,
          violation: null
        })
      }
    }
    documentsWritten(
      db,
      result.rewritten.map((each) => each.id)
    )
    if (result.deleted.length > 0)
      emit(windows(), 'continuity:changed', { nodeIds: result.deleted })
    // F-9.13: the deleted scenes' AI facts went with them; the sheets that held them refetch.
    if (result.factEntityIds.length > 0)
      emit(windows(), 'fact:changed', { entityIds: result.factEntityIds })
    mentionQueue.indexAll('mentions', staleMentionNodeIds(db))
    backfillSummaries(false)
    // A project in a cloud-synced folder gets the import copied back now, not in three minutes.
    cloudSync?.changed()
  }

  register('import:commit', ({ draft }) => {
    const session = manager.require()
    const db = session.connection.orm
    const result = importDraft(db, session.info.format, draft)
    afterImport(db, result)
    return {
      nodes: result.rows.map(toTreeNode),
      words: result.words,
      tree: listNodes(db).map(toTreeNode),
      rewritten: result.rewritten.map((each) => each.id)
    }
  })

  // F-12.2, import to start: the project is created without the starter skeleton and the draft
  // is written into it before it opens; a draft that cannot be imported undoes the create.
  register('import:createProject', async ({ draft, name, format, directory }) => {
    const folder = directory
      ? projectFolderFor(directory, name)
      : await dialogs.chooseProjectSavePath(name)
    if (!folder) return null
    const written: { result: ImportResult | null } = { result: null }
    const info = manager.create(folder, name, format, {
      skeleton: false,
      fill: (db) => {
        written.result = importDraft(db, format, draft)
      }
    })
    diagnostics.count('project.create')
    if (written.result !== null) afterImport(manager.require().connection.orm, written.result)
    return info
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

  // F-7.10: main owns both view settings, so the renderer's mirror starts from this.
  register('view:get', () => appState.get().view)

  // F-7.10: the document zoom is the renderer's to apply (it scales the editing surface, not the
  // window), so main only steps the persisted value — the next launch opens at the same level —
  // and answers the pair the renderer mirrors and announces.
  register('view:zoomDocument', ({ step }) => {
    const editorZoom = nextZoom(appState.get().view.editorZoom, step)
    return appState.update((s) => ({ ...s, view: { ...s.view, editorZoom } })).view
  })

  // F-7.10: the interface size is the window's zoom factor, so main writes it (the next launch
  // restores it) and applies it to every live window — the size is app-wide.
  register('view:setUiScale', ({ scale }) => {
    const view = appState.update((s) => ({ ...s, view: { ...s.view, uiScale: scale } })).view
    const factor = UI_SCALE_FACTORS[scale]
    for (const w of windows()) if (!w.isDestroyed()) w.webContents.setZoomFactor(factor)
    return view
  })

  // F-7.9: main reads the choice at launch, before any window exists; the tab only asks.
  register('startup:get', () => ({
    reopenLastProject: appState.get().window.reopenLastProject
  }))

  register('startup:setReopenLastProject', ({ on }) => {
    const next = appState.update((s) => ({ ...s, window: { ...s.window, reopenLastProject: on } }))
    return { reopenLastProject: next.window.reopenLastProject }
  })

  // F-7.11: the sheet is the renderer's to draw; main only keeps the choice for the next launch.
  register('view:setPageEdges', ({ on }) => {
    return appState.update((s) => ({ ...s, view: { ...s.view, pageEdges: on } })).view
  })

  // F-7.8: the theme is the renderer's to paint; main keeps the choice and the custom themes,
  // refuses a Supporter theme without the license (the extras are cosmetic, so the check lives
  // here, beside the accent's), and gives every window the theme's background.
  const licensed = (): boolean => account.supporter().licensed
  const paintWindows = (view: ViewSettings): ViewSettings => {
    const color = themeBackground(view, licensed())
    for (const w of windows()) if (!w.isDestroyed()) w.setBackgroundColor(color)
    return view
  }

  register('view:setTheme', ({ theme }) => {
    const known =
      (BUILT_IN_THEME_IDS as readonly string[]).includes(theme) ||
      appState.get().view.customThemes.some((t) => t.id === theme)
    if (!known) throw new AppError('VALIDATION', THEME_NOT_FOUND_MESSAGE)
    if (themeNeedsLicense(theme) && !licensed()) {
      throw new AppError('VALIDATION', THEME_NEEDS_LICENSE_MESSAGE)
    }
    return paintWindows(appState.update((s) => ({ ...s, view: { ...s.view, theme } })).view)
  })

  register('view:saveCustomTheme', ({ theme }) => {
    if (!licensed()) throw new AppError('VALIDATION', THEME_NEEDS_LICENSE_MESSAGE)
    const { customThemes } = appState.get().view
    const id = theme.id ?? `custom-${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const saved = { ...theme, id }
    let next: typeof customThemes
    if (theme.id) {
      if (!customThemes.some((t) => t.id === theme.id)) {
        throw new AppError('VALIDATION', THEME_NOT_FOUND_MESSAGE)
      }
      next = customThemes.map((t) => (t.id === id ? saved : t))
    } else {
      if (customThemes.length >= CUSTOM_THEMES_MAX) {
        throw new AppError(
          'VALIDATION',
          `You can keep up to ${CUSTOM_THEMES_MAX} custom themes. Delete one to make another.`
        )
      }
      next = [...customThemes, saved]
    }
    return paintWindows(
      appState.update((s) => ({ ...s, view: { ...s.view, customThemes: next, theme: id } })).view
    )
  })

  register('view:deleteCustomTheme', ({ id }) => {
    const { customThemes, theme } = appState.get().view
    const gone = customThemes.find((t) => t.id === id)
    if (!gone) throw new AppError('VALIDATION', THEME_NOT_FOUND_MESSAGE)
    return paintWindows(
      appState.update((s) => ({
        ...s,
        view: {
          ...s.view,
          customThemes: customThemes.filter((t) => t.id !== id),
          theme: theme === id ? gone.base : theme
        }
      })).view
    )
  })

  // F-7.1: the in-app Edit menu edits whatever has the focus, like the native roles do. A click
  // on the bar does not move the focus (the bar prevents it), so the editor or input keeps it.
  register('menu:edit', ({ role }) => {
    const win = focusedWindow() ?? windows().find((w) => !w.isDestroyed())
    if (win && !win.isDestroyed()) win.webContents[role]()
    return null
  })

  register('dictionary:get', () => getProjectDictionary(manager.require().connection.orm))

  // F-3.11: the stored list is the truth and the spellchecker follows it; a word already there
  // (or already gone) writes nothing, and the sync is awaited so the underline is gone on answer.
  register('dictionary:add', async ({ word }) => {
    const db = manager.require().connection.orm
    const current = getProjectDictionary(db)
    const next = addWord(current, word)
    const stored = next === current ? current : setProjectDictionary(db, next)
    await syncSpelling()
    return stored
  })

  register('dictionary:remove', async ({ word }) => {
    const db = manager.require().connection.orm
    const current = getProjectDictionary(db)
    const next = removeWord(current, word)
    const stored = next === current ? current : setProjectDictionary(db, next)
    await syncSpelling()
    return stored
  })

  // F-3.14: the word stays underlined by the spellchecker if it is misspelled; only the
  // near-name underline in the editor reads this list.
  register('dictionary:notName', ({ word }) => {
    const db = manager.require().connection.orm
    const current = getProjectDictionary(db)
    const next = addNotName(current, word)
    return next === current ? current : setProjectDictionary(db, next)
  })

  // F-3.11: like `menu:edit`, on the window with the focus; the renderer put the focus back on
  // the editable before asking, so the misspelled word is the one under its caret.
  register('spellcheck:replace', ({ word }) => {
    const win = focusedWindow() ?? windows().find((w) => !w.isDestroyed())
    if (win && !win.isDestroyed()) win.webContents.replaceMisspelling(word)
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
    // F-13.4: what was last checked belongs to the project that left.
    continuityChecked.clear()
    // F-4.12: the same for the mention queue, and a project that was written before this feature
    // (or by an older build) is backfilled from its own rows, silently, as soon as it opens.
    mentionQueue.clear()
    // F-14.14: the voice job and its failure memo belong to the project that left.
    voiceQueue.clear()
    voiceMemo.failedAtWords = null
    // F-9.16: the To do sync and the check's estimate belong to the project that left.
    todoQueue.clear()
    todoBookMoved()
    // F-9.18: every sheet's pause and status belong to the project that left.
    sheetSync.clear()
    // F-14.15: a pass running in the project that left stops without writing; one left running
    // by a crash or a quit reads as stopped in the project that opened, ready to resume.
    editPasses.clear()
    if (info) interruptRunningPasses(manager.require().connection.orm)
    // F-4.12b: the memoised word counts and what was last published belong to the project that
    // left, so a project opened again publishes its proposals afresh rather than staying silent
    // because the list happens to read the same as the last one's.
    resetProposedTagCache()
    lastProposed = null
    // F-10.1: the cached searchable texts are keyed by node id, which means nothing in
    // another project.
    clearSearchCache()
    // F-10.2: the last replace's undo holds another project's documents.
    clearReplaceUndo()
    // F-10.3: the session's words and active time start again with every project.
    resetGoalsSession()
    // F-9.14: Later holds for one session of one project.
    conversionDeferred = false
    // F-9.12: the local knowledge index, before anything reads the bank or the scenes: the
    // one-time conversion (every name tag a record, every record a tag) and the passages of
    // documents that left the manuscript. Local and free; a failure never stops the open.
    if (info) {
      try {
        const db = manager.require().connection.orm
        convertKnowledgeIndex(db)
        // F-9.14: the author's plot-thread tags get their thread records (once per project).
        convertThreadRecords(db)
        // F-9.13: old observed facts and the sheets' text into dated facts (every open, cheap).
        convertKnowledgeFacts(db)
        prunePassages(db)
      } catch (err) {
        console.warn('Could not update the knowledge index', err)
      }
    }
    // F-3.11, F-3.14: the spellchecker accepts the open project's words and story names and no
    // other project's.
    void syncSpelling()
    cancelBackfill()
    if (info) {
      queue.load()
      mentionQueue.load()
      mentionQueue.indexAll('mentions', staleMentionNodeIds(manager.require().connection.orm))
      voiceQueue.load()
      // F-9.16: the To do list is brought up to date on every open (local, free).
      todoQueue.load()
      // F-9.18: the sheets left due when the project closed are synced (no new pauses start).
      sheetSync.load()
      const opened = manager.require().connection.orm
      const todoRoot = manuscriptRootId(opened)
      if (todoRoot !== null) todoQueue.indexAll('todo', [todoRoot])
      backfillSummaries(false)
      publishProposed()
      try {
        // F-7.9: the project open now is the one a relaunch opens again.
        appState.update((s) => ({
          ...s,
          recents: touchRecent(s.recents, toRecentEntry(info)),
          window: { ...s.window, lastProject: info.path }
        }))
      } catch (err) {
        console.warn('Could not record recent project', err)
      }
    }
    emit(windows(), 'project:changed', info)
  })

  // F-8.4: registered after the listener above, so whatever it writes into the project while
  // opening it is already in the baseline and does not count as the author's change.
  manager.onChange((info) => {
    if (info) backups.projectOpened()
    else backups.projectClosed()
  })
  manager.onBeforeClose((session) => backups.projectClosing(session))
  if (cloudSync) {
    manager.onChange((info) => {
      if (info) cloudSync.projectOpened()
      else cloudSync.projectClosed()
    })
    manager.onBeforeClose(() => cloudSync.projectClosing())
  }
}

/** A tag proposal's stored content (F-12.3): the names as JSON, or none when it is anything else. */
function proposalTags(content: string): string[] {
  try {
    const parsed: unknown = JSON.parse(content)
    return Array.isArray(parsed) ? parsed.filter((name) => typeof name === 'string') : []
  } catch {
    return []
  }
}
