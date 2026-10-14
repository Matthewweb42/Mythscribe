import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { AgentStep } from '@shared/agent'
import {
  aiFailure as aiFailureEnvelope,
  AiFeatureId,
  HOSTED_DEFAULT_MODELS,
  OPENROUTER_DEFAULT_MODELS,
  testConnectionFailure,
  type AiErrorCode,
  type AiStatus,
  type AiTestConnectionResult,
  USAGE_RECENT_LIMIT,
  type AiUsageSummary,
  type OwnKeyProvider
} from '@shared/ai'
import type { AiModelChoice } from '@shared/aiRouting'
import { extrasUnlocked, TRIAL_ENDED_MESSAGE } from '@shared/appAccess'
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
import { aiRequestCounter, memoryInvariantCounter } from '@shared/diagnostics'
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
import type { FilingProcessResult } from '@shared/filing'
import { STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
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
  AiNavigateResult,
  AiRouteResult,
  AiSuggestNotesResult,
  AiSuggestSynopsisResult,
  ChangeUndoReply,
  Channel,
  Entity,
  IpcError,
  JobsIndexAllResult,
  Output,
  TreeNode
} from '@shared/ipc/contract'
import {
  SUMMARY_BACKFILL_DELAY_MS,
  SUMMARY_DEBOUNCE_MS,
  SUMMARY_TEXT_MIN,
  UNAVAILABLE_SUMMARY,
  type SceneSummaryState
} from '@shared/summary'
import { UI_SCALE_FACTORS, nextZoom, type ViewSettings } from '@shared/zoom'
import { normalizeAssistantName } from '@shared/assistantName'
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
import { runFilingChat, runReviewChat } from '../ai/reviewChat'
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
import { runAgent, type AgentHooks } from '../ai/agent'
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
  storedPath,
  type ContextSource
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
import { ensureResearchRoot } from '../project/seed'
import {
  addResearchFiles,
  copyResearchMeta,
  createResearchNote,
  listResearchDocs,
  researchDocOf,
  researchOriginalPath,
  setResearchNotCanon
} from '../research/researchStore'
import {
  applyFiling,
  clearFilingUndo,
  estimateFiling,
  fileResearch,
  undoFiling
} from '../research/filing'
import { filedConflicts, keepFiledLine, updateFiledLine } from '../research/filedLines'
import { buildStoryNotes } from '../memory/storyNotes'
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
import type { StoryMemoryVersion } from '@shared/storyMemory'
import type { NameQuestion } from '@shared/memory/nameQuestions'
import { normName } from '@shared/memory/names'
import type { RecordPage, StoryRecord, StoryRecordSummary } from '@shared/memory/records'
import { pinnedCanonLines } from '@shared/memory/storyNotes'
import { bornLines } from '@shared/memory/years'
import {
  createAuthorTodo,
  deleteAuthorTodo,
  listAuthorTodos,
  reorderAuthorTodos,
  updateAuthorTodo
} from '../memory/authorTodoStore'
import { listDismissed, undoDismissed } from '../memory/dismissedStore'
import {
  assignLabel,
  createLabel,
  deleteLabel,
  labelsForNode,
  listLabelLinks,
  listLabels,
  reorderLabels,
  unassignLabel,
  updateLabel
} from '../memory/labelStore'
import {
  listNameMentions,
  markNotAMention,
  namedInCounts,
  scanNamesFor,
  staleNameScans
} from '../memory/nameIndexer'
import { anchorsChanged, runAnchors } from '../memory/reading/anchors'
import {
  applyNotePatch,
  findingNotProblem,
  findingRight,
  findingTouches,
  looseEndNotProblem,
  looseEndsView,
  notePatch,
  requireFinding
} from '../memory/findings/findingActions'
import { findingCounts, runFindingsJob } from '../memory/findings/findingsJob'
import { findingsView } from '../memory/findings/findingViews'
import { sweepCalls } from '../memory/findings/findingsService'
import { forgetAnswer } from '../memory/findings/underlineLog'
import { underlinesOf, underlinesShown } from '../memory/findings/underlines'
import { isUnderResearch } from '../research/researchTree'
import { createReaderService, dropSummaryJobs } from '../memory/reading/readerService'
import { settleOwnedNames } from '../memory/reading/waiting'
import { claimInfo, knowsGridMemory, sceneMemory, sheetMemory } from '../memory/reading/views'
import { threadsMemory, timelineMemory } from '../memory/reading/timeViews'
import { setKnewBefore } from '../memory/reading/knewBeforeStore'
import {
  restoreTopicNotRight,
  splitReveal,
  topicNotRight,
  type TopicChange
} from '../memory/reading/topicActions'
import { cardLines } from '../memory/reading/cardContext'
import { keepPlanLink, restoreUnlinked, unlinkPlanV2 } from '../memory/reading/planLinks'
import { planLinkViewV2 } from '../memory/reading/planLinkStore'
import { cardNotRight, restoreNotRight } from '../memory/reading/notRight'
import {
  dropOwner,
  indexNodePassages,
  indexStaleRecords,
  pruneMemoryIndex,
  searchMemoryPassages,
  stalePassageOwners
} from '../memory/passageIndexer'
import { answerNameQuestion, listNameQuestions, resetNameQuestionCache } from '../memory/questions'
import { applyRename, clearRenameUndo, previewRename, undoRename } from '../memory/renameStore'
import { inlineTagReplacements, planSwitchover } from '../memory/switchover/plan'
import { getSwitchoverRecord } from '../memory/switchover/record'
import { SwitchoverRun } from '../memory/switchover/run'
import { createTrialCopy } from '../memory/switchover/trial'
import {
  createRecord,
  deleteRecord,
  gateName,
  getRecord,
  listRecords,
  pruneTopics,
  requireRecord,
  sameAs,
  savePage,
  setAliases,
  splitRecord,
  updateRecord,
  withTopicRelabels
} from '../memory/recordStore'
import { runNavigate } from '../scribe/navigate'
import { runScribe } from '../scribe/runScribe'
import { searchMisses } from '../scribe/searchMissStore'
import { addSheetLine, removeSheetLine } from '../scribe/sheetLines'
import { getSceneDetails, setSceneDetails } from '../memory/sceneDetailStore'

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
  /**
   * F-7.13: the assistant's name changed; `index.ts` rebuilds the native menu so View shows it.
   * Absent in the unit tests, which have no menu.
   */
  onAssistantNameChanged?: () => void
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
  onCloseCancelled,
  onAssistantNameChanged
}: HandlerDeps): void {
  /**
   * AI-BILLING-SPEC M1: every channel is registered through the read-only gate. A `write` channel
   * is refused after the trial without the license; reading, export, and backup never are.
   */
  const register = <C extends Channel>(channel: C, fn: Handler<C>): void => {
    // Developer tools: every error envelope reaches the live log (a no-op while it is off).
    const onFailure = (failed: Channel, error: IpcError, cause?: unknown): void =>
      devtools.ipcFailure(failed, error, cause)
    // F-16.4: a channel of the other story memory is refused before its handler runs.
    const memoryOf = (): StoryMemoryVersion | null => manager.current()?.storyMemory ?? null
    if (!isWriteChannel(channel)) {
      registerChannel(channel, fn, onFailure, memoryOf)
      return
    }
    registerChannel(
      channel,
      (input) => {
        access.assertWritable()
        return fn(input)
      },
      onFailure,
      memoryOf
    )
  }
  /**
   * F-16.4: the story memory the open project runs (the stored version, or the dev-only override),
   * which every branching feature takes as its `memory` input.
   */
  const memory = (): StoryMemoryVersion => manager.require().storyMemory
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
      const memoryNow = manager.require().storyMemory
      const result = await summarizeScene(db, deps, {
        nodeId: job.nodeId,
        memory: memoryNow,
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
      let checked: Awaited<ReturnType<typeof runBackgroundContinuity>> = null
      // F-16.4: the consistency check is v1's (its findings are v1 rows); P4 replaces it.
      if (memoryNow === 'v1') {
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
    // F-16.16: in a v2 project the reader's queue owns `jobs:changed` (no summary runs there).
    onChange: (status) => {
      if (manager.current()?.storyMemory !== 'v2') emit(windows(), 'jobs:changed', status)
    },
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
    // F-16.4: the To do list is v1's; a v2 project has the author's own to-dos instead.
    if (manager.current()?.storyMemory === 'v2') return
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
    // F-16.4: tag proposals are v1's; a v2 project asks name questions instead.
    if (manager.current()?.storyMemory !== 'v1') return
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
    return spellDictionary.sync(projectSpellingWords(manager.require().connection.orm, memory()))
  }

  /**
   * F-16.4: the name questions as they stand now, pushed when they differ from what was last
   * pushed (v2 only; the list is computed, as the proposed tags are in v1). Null for "nothing
   * pushed yet", which a project change restores.
   */
  let lastQuestions: string | null = null
  const publishQuestions = (): void => {
    if (manager.current()?.storyMemory !== 'v2') return
    const questions: NameQuestion[] = listNameQuestions(manager.require().connection.orm)
    const json = JSON.stringify(questions)
    if (json === lastQuestions) return
    lastQuestions = json
    emit(windows(), 'questions:changed', questions)
  }

  /**
   * F-16.17: a scene's claims checked against its sentences now (the anchors job's run, and Ms
   * Scribe's read-first before it reads, F-16.24); a claim that broke an invariant was demoted, and
   * only its kind is counted (P2a-D19). F-16.18: a line that went stale (or came back) dims at once
   * in True now, a shown sheet and ⓘ, with no reading in between; a scene with a card is looked at
   * again too, since Here, the card and decision 4's conflicts read its fields against the text as
   * it is now. Answers whether rows moved.
   */
  const checkAnchorsNow = (db: TreeDb, nodeId: string, now: Date): boolean => {
    const result = runAnchors(db, nodeId, now)
    for (const kind of result.violations) {
      const counter = memoryInvariantCounter(kind)
      if (counter !== null) diagnostics.count(counter)
    }
    const changed = anchorsChanged(result)
    if (changed || result.card) {
      memoryChanged({ nodeIds: [nodeId], recordIds: result.recordIds })
      if (result.card) reader.detailsChanged()
    }
    return changed
  }

  /** The value the mention queue's runs answer: whether rows moved, and whether the text was read. */
  const NO_SCAN = { changed: false, scanned: false }
  const mentionQueue = createIndexQueue<{ changed: boolean; scanned: boolean }>({
    // F-16.5: the v2 name scan and passage index ride the same local queue; each run below
    // keeps to its own story memory, so a job left by the other one is dropped quietly.
    kind: ['mentions', 'names', 'passages', 'anchors', 'findings'],
    db: () => (manager.current() === null ? null : manager.require().connection.orm),
    run: (job) => {
      const db = manager.require().connection.orm
      const now = new Date()
      const v2 = memory() === 'v2'
      if (job.kind === 'anchors') {
        if (!v2) return Promise.resolve({ requested: false, value: NO_SCAN })
        const changed = checkAnchorsNow(db, job.nodeId, now)
        return Promise.resolve({ requested: false, value: { changed, scanned: changed } })
      }
      if (job.kind === 'findings') {
        // F-16.27: the local recompute of the contradiction candidates (no AI, nothing sent); a
        // pair both of whose orders the verdict cache remembers is settled at no cost, and when
        // findings moved the ones still unjudged are handed to the judge on the reader's queue
        // (when the gates allow). Nothing moved, nothing is queued: a judge run's own pushes come
        // back here, and must not queue it again. The counts follow the switch (off, none).
        if (!v2) return Promise.resolve({ requested: false, value: NO_SCAN })
        // A *Not a problem* undone since: its finding is found again even when it is C7.
        const restore = new Set(restoreFindings)
        restoreFindings.clear()
        const result = runFindingsJob(db, now, {
          cachedVerdicts: true,
          shown: getAiSettings(db).features.judge,
          restore
        })
        if (result.counts !== null) emit(windows(), 'memory:findingsChanged', result.counts)
        if (result.changed) reader.queueJudge()
        // F-16.28: an underlined finding the text no longer produces moves underline precision.
        if (result.closed.some((each) => each.finding.shownAt !== null)) reader.noticesMoved()
        return Promise.resolve({
          requested: false,
          value: { changed: result.changed, scanned: result.changed }
        })
      }
      if (job.kind === 'names') {
        if (!v2) return Promise.resolve({ requested: false, value: NO_SCAN })
        const value = scanNamesFor(db, job.nodeId, now)
        if (value.changed) emit(windows(), 'names:changed', { nodeIds: [job.nodeId] })
        if (value.scanned) publishQuestions()
        return Promise.resolve({ requested: false, value })
      }
      if (job.kind === 'passages') {
        if (!v2) return Promise.resolve({ requested: false, value: NO_SCAN })
        // Keyed to the manuscript root, the job is every record page that changed; keyed to a
        // node, its scene and notes, or its Research page (F-16.8).
        const pages = job.nodeId === manuscriptRootId(db)
        const changed = pages
          ? indexStaleRecords(db, now) > 0
          : indexNodePassages(db, job.nodeId, now)
        // F-16.27: C6 reads the canon notes from the index, so a record page or a Research page
        // indexed anew is checked again (the code part of a note save, design §2.4).
        if (changed && (pages || isResearchDocument(db, job.nodeId))) queueFindings(db)
        return Promise.resolve({ requested: false, value: { changed, scanned: changed } })
      }
      // F-4.12: the tag mention scan is v1's.
      if (v2) return Promise.resolve({ requested: false, value: NO_SCAN })
      const value = scanMentions(db, job.nodeId, now)
      if (value.changed) {
        emit(windows(), 'mention:changed', { nodeIds: [job.nodeId] })
        // F-9.16: which scenes name which records is what most local To do rules count.
        queueTodo(db)
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
   * F-16.27 (v2): the contradiction candidates are found again, once the burst of changes settles
   * (the `findings` job, keyed to the manuscript root on the mention queue, debounced there).
   */
  /**
   * F-16.29: the *Not a problem* keys undone since the last findings job, which finds their
   * findings again (C7 included, `RecomputeOptions.restore`).
   */
  const restoreFindings = new Set<string>()

  const queueFindings = (db: TreeDb): void => {
    if (memory() !== 'v2') return
    const root = manuscriptRootId(db)
    if (root !== null) mentionQueue.touch('findings', root)
  }

  /**
   * F-16.17, F-16.27 (v2): the one way `memory:changed` is pushed. What the memory holds changed
   * for these scenes and records (a reading, the anchors job, *Not right*, a card's *Not right*,
   * knew-before, a split, *Not a secret*, an Undo, Rename in book, typed details, a tree move): the
   * renderer reads them again, and the contradiction candidates are found again.
   */
  const memoryChanged = (payload: {
    nodeIds: readonly string[]
    recordIds: readonly string[]
  }): void => {
    emit(windows(), 'memory:changed', {
      nodeIds: [...payload.nodeIds],
      recordIds: [...payload.recordIds]
    })
    if (manager.current() !== null) queueFindings(manager.require().connection.orm)
  }

  /** Whether a node is a Research document (its passages are canon notes C6 reads). */
  const isResearchDocument = (db: TreeDb, nodeId: string): boolean => {
    const row = getNode(db, nodeId)
    return row?.kind === 'document' && isUnderResearch(db, row)
  }

  /**
   * F-16.5: the v2 backfill: every scene whose name scan or passages are out of date (a roster
   * change makes every scene's scan stale), and one root job for the record pages.
   */
  const queueMemoryIndex = (db: TreeDb): void => {
    if (memory() !== 'v2') return
    mentionQueue.indexAll('names', staleNameScans(db))
    const stale = stalePassageOwners(db)
    const scenes = [...new Set(stale.filter((o) => o.kind !== 'record').map((o) => o.id))]
    mentionQueue.indexAll('passages', scenes)
    // F-16.17: a scene whose passages read differently now (an Idea status or compile inclusion
    // changed) has its claims parked or brought back by the anchors job.
    mentionQueue.indexAll('anchors', scenes)
    const root = manuscriptRootId(db)
    if (root !== null && stale.some((owner) => owner.kind === 'record')) {
      mentionQueue.indexAll('passages', [root])
    }
  }

  /**
   * F-16.16, F-16.17, F-16.19: story memory v2's reading. The reader service owns its
   * provider-backed queue (read, rebuild, spot checks, back-fills), its gates and notices; the
   * handlers only reach it. Its `jobs:changed` and status pushes go out only in a v2 project.
   */
  const reader = createReaderService({
    db: () => (manager.current() === null ? null : manager.require().connection.orm),
    memory: () => manager.current()?.storyMemory ?? null,
    settings: (db) => getAiSettings(db),
    requestDeps: (db) => requestDeps(db),
    provider: (db) => {
      if (!access.writable()) return null
      const provider = ai.get(sourceOf(db))
      if (!provider) return null
      return {
        id: provider.id,
        fastModel: provider.resolveModel('fast'),
        strongModel: provider.resolveModel('strong')
      }
    },
    pricing: () => appState.get().cloudPricing?.pricing ?? null,
    cloud: {
      get: () => appState.get().memoryCloud,
      update: (fn) => appState.update((s) => ({ ...s, memoryCloud: fn(s.memoryCloud) })).memoryCloud
    },
    credits: () => account.credits(),
    // The health notice's *Switch to DeepSeek V4 Flash*: the fast tier of the provider in use.
    useFlash: (provider) =>
      void appState.update((s) => {
        if (provider === 'openrouter') {
          return {
            ...s,
            models: {
              ...s.models,
              openrouter: { ...s.models.openrouter, fast: OPENROUTER_DEFAULT_MODELS.fast }
            }
          }
        }
        if (provider === 'cloud') {
          return {
            ...s,
            models: { ...s.models, cloud: { ...s.models.cloud, fast: HOSTED_DEFAULT_MODELS.fast } }
          }
        }
        return s
      }),
    cancelRequest: (requestId) => void cancelInflight(requestId),
    changed: (payload) => memoryChanged(payload),
    // P2b: secrets and threads a reading made or merged into; not names, so the roster stays.
    recordsChanged: (recordIds) => emit(windows(), 'record:changed', { recordIds, roster: false }),
    questions: () => publishQuestions(),
    // F-16.21: links applied after a reading live in `plan_link` (no scene metadata moved).
    planLinksChanged: () => emit(windows(), 'planLinks:changed', { changedNodeIds: [] }),
    status: (status) => emit(windows(), 'memory:statusChanged', status),
    notices: (notices) => emit(windows(), 'memory:noticesChanged', notices),
    jobs: (status) => emit(windows(), 'jobs:changed', status),
    findingsChanged: (counts) => emit(windows(), 'memory:findingsChanged', counts),
    log: (message) => devtools.record('warn', 'ai', message, null)
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
    // F-16.21: v2 links plans after each reading (the reader service); v1's job never runs there.
    if (manager.require().storyMemory === 'v2') return
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

  register('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    newProjectMemory: manager.newProjectMemory()
  }))

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

  register('project:open', async ({ path, cloudConflict }) => {
    const chosen = path ?? (await dialogs.chooseProjectToOpen())
    if (!chosen) return null
    let folder = chosen
    manager.closeIfOpen(chosen)
    // F-1.6: a v0 project is converted after the author agrees; the original is kept beside it.
    const location = locateProject(chosen)
    if (location.kind === 'legacy') {
      const backup = legacyBackupPath(location.source, new Date())
      if (!(await dialogs.confirmLegacyConversion(location.source, backup))) return null
      folder = convertLegacyProject(location, new Date(), manager.newProjectMemory()).folder
    }
    const info = manager.open(folder, cloudConflict)
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

  /**
   * F-16.23 (review of P2b slice 5): the book's order, its scenes or their titles moved (a scene
   * made, renamed, moved, copied or deleted; an Idea or a compile exclusion flipped). The Timeline's
   * rows, the scene references, the year carry and the ages, the Threads' statuses and "checked up
   * to" are all in reading order, so the renderer reads the views of the whole book again. v2 only.
   */
  const bookOrderMoved = (nodeIds: readonly string[]): void => {
    if (memory() !== 'v2') return
    memoryChanged({ nodeIds: [...nodeIds], recordIds: [] })
  }

  register('tree:create', (input) => {
    const session = manager.require()
    const made = toTreeNode(createNode(session.connection.orm, session.info.format, input))
    bookOrderMoved([made.id])
    return made
  })

  register('tree:rename', ({ id, title }) => {
    const renamed = toTreeNode(renameNode(manager.require().connection.orm, id, title))
    // F-9.16: a scene's title is part of what the To do check sends.
    todoBookMoved()
    bookOrderMoved([id])
    return renamed
  })

  register('tree:duplicate', ({ id }) => {
    const db = manager.require().connection.orm
    const rows = duplicateNode(db, id)
    // F-16.8: a copied Research page keeps its original and its Not canon switch.
    if (memory() === 'v2') copyResearchMeta(db, id, rows)
    const copies = rows.map(toTreeNode)
    // F-16.5: the copies are new manuscript scenes for the name scan and the passage index.
    queueMemoryIndex(db)
    bookOrderMoved(copies.map((copy) => copy.id))
    return copies
  })

  register('tree:delete', ({ id }) => {
    const db = manager.require().connection.orm
    const entityIds = deleteNode(db, id)
    // F-13.4: the scene's findings went with it (cascade), and the panel holds a copy.
    emit(windows(), 'continuity:changed', { nodeIds: [id] })
    // F-9.13: and so did what it stated; the sheets that held its facts refetch.
    if (entityIds.length > 0) emit(windows(), 'fact:changed', { entityIds })
    // P2b-D12: a secret or thread the AI made that only this scene backed goes with it.
    if (memory() === 'v2') {
      const pruned = pruneTopics(db)
      if (pruned.length > 0) emit(windows(), 'record:changed', { recordIds: pruned, roster: false })
    }
    // F-9.16: the scene's items lose their passage; the rules count one scene fewer.
    queueTodo(db)
    bookOrderMoved([id])
    return null
  })

  register('tree:move', ({ id, parentId, afterId }) => {
    const db = manager.require().connection.orm
    const moved = toTreeNode(moveNode(db, id, parentId, afterId))
    // F-9.16: reading order decides loose ends and an age that goes down.
    queueTodo(db)
    // F-16.5: a scene moved under an Idea or left-out folder is relabelled, one moved into the
    // manuscript is scanned and indexed (by hash: nothing else is read again).
    queueMemoryIndex(db)
    bookOrderMoved([id])
    return moved
  })

  register('document:get', ({ id }) => getDocumentContent(manager.require().connection.orm, id))

  /**
   * What follows every write of document content, whoever wrote it: the editor's `document:save`
   * and the bulk writes of find and replace (F-10.2) both end here, so a replaced document is
   * re-summarized and rescanned exactly like a typed one. `origin` says which (F-16.16): the
   * editor's saves come in bursts while the author types, the rest (replace, a draft switch or
   * revert, a restore, a rename, the chat's bulk tools) are one-off writes of many scenes.
   */
  const documentsWritten = (
    db: TreeDb,
    ids: readonly string[],
    origin: 'editor' | 'bulk'
  ): void => {
    if (ids.length === 0) return
    // F-14.1: every save moves the voice profile's version (a cheap integer; checking whether the
    // document is under the manuscript would cost a lookup on the hot path for nothing).
    bumpVoiceVersion()
    // F-5.6: the summary is rewritten once the author pauses, never on the save itself. The
    // gate is read here, not at run time: a save with summaries off must not show the pane
    // "Updating…" for a run that will never happen, nor leave a run queued for the moment the
    // toggle comes on (one settings row per save; the run gates again anyway).
    const v2 = memory() === 'v2'
    // F-16.17 (plan P2a §3.7): `summary.v5` is off in v2; the reader reads the scenes instead.
    const summaries = !v2 && isFeatureAllowed(getAiSettings(db), 'summary')
    for (const id of ids) {
      if (summaries) queue.touch('summary', id)
      if (v2) {
        // F-16.5: the local name scan and passage index, with no gate either. F-16.17: and the
        // claims' anchors, once a burst of typing settles, or at once after a bulk write.
        mentionQueue.touch('names', id)
        mentionQueue.touch('passages', id)
        if (origin === 'editor') mentionQueue.touch('anchors', id)
        continue
      }
      // F-4.12: the mention scan is local, so it has no gate to read — every save queues one, and
      // the scan itself answers "nothing changed" for a node that is not a manuscript document.
      // F-4.12b: a scan that read the document again republishes the proposed tags itself.
      mentionQueue.touch('mentions', id)
    }
    if (v2 && origin === 'bulk') {
      mentionQueue.indexAll('anchors', [...ids])
      // F-16.16: a write outside the editor: the backlog is checked once the burst settles.
      reader.bulkWritten()
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
      // F-16.17 (plan P2a §3.7): no summaries and no knowledge conversion in a v2 project.
      if (memory() === 'v2') return
      // F-9.14: while the conversion waits for the author, the scenes an older prompt read are
      // held back, and the windows hear what it would cost (the dialog shows on `pending`).
      const hold = conversionPending(db)
      // F-16.4: the conversion pass is v1's; a v2 project still holds those scenes back (no
      // unasked spend) but never hears about the dialog.
      if (hold && memory() === 'v1') {
        emit(windows(), 'knowledge:conversionChanged', conversionOf(db))
      }
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
  const saveFromEditor = (
    db: TreeDb,
    id: string,
    content: TiptapNodeT,
    origin: 'editor' | 'bulk' = 'editor'
  ): SaveResult => {
    // F-10.3: only the editor's saves of manuscript documents count as words written, so the
    // count before the save is read here and not in `documentsWritten` (replace writes too).
    const previous = manuscriptWordCount(db, id)
    const saved = saveDocument(db, id, content)
    if (previous !== null) recordWriting(db, saved.wordCount - previous)
    documentsWritten(db, [id], origin)
    return saved
  }

  // F-16.16: a scene the chat writes without opening it (a new or split scene) is a write
  // outside the editor: the backlog check reads it, as it does after Replace.
  register('document:save', ({ id, content, outsideEditor }) =>
    saveFromEditor(
      manager.require().connection.orm,
      id,
      content,
      outsideEditor === true ? 'bulk' : 'editor'
    )
  )

  register('notes:get', ({ id }) => getNotes(manager.require().connection.orm, id))

  register('notes:save', ({ id, notes }) => {
    const db = manager.require().connection.orm
    const saved = saveNotes(db, id, notes)
    // F-9.16: a name the notes explain is no longer undefined.
    queueTodo(db)
    // F-16.5: a scene's notes are passages of their own (a node that is no scene is skipped).
    if (memory() === 'v2') mentionQueue.touch('passages', id)
    return saved
  })

  /**
   * A record's Pinned or Ideas page written (F-16.6): the sheet's autosave and crash recovery
   * (F-8.3) both end here. No `record:changed`: the page store that saved holds the text, and the
   * roster is as it was.
   */
  const saveRecordPage = (
    db: TreeDb,
    id: string,
    page: RecordPage,
    doc: TiptapNodeT | null
  ): StoryRecord => saveRecordPageWith(db, id, (tx) => savePage(tx, id, page, doc, new Date()))

  /** A record's canon Pinned "Born:" lines (P2b-D15), or none when it is gone. */
  const pinnedBorn = (db: TreeDb, id: string): string[] => {
    const record = getRecord(db, id)
    return record === null ? [] : bornLines(pinnedCanonLines(record))
  }

  /**
   * A record page written by `write`, then indexed like any page save (F-16.5). F-16.23 (review
   * of P2b slice 5): a Pinned "Born: 1792" line is a birth year, so when the record's Born lines
   * moved, its sheet's Age and the Timeline are read again (`memory:changed` naming it).
   */
  const saveRecordPageWith = <T>(db: TreeDb, recordId: string, write: (db: TreeDb) => T): T => {
    const v2 = memory() === 'v2'
    const before = v2 ? pinnedBorn(db, recordId) : []
    const saved = write(db)
    // F-16.5: Pinned and Ideas are passages; one root job indexes every page that changed.
    const root = manuscriptRootId(db)
    if (root !== null) mentionQueue.touch('passages', root)
    if (v2 && JSON.stringify(pinnedBorn(db, recordId)) !== JSON.stringify(before)) {
      memoryChanged({ nodeIds: [], recordIds: [recordId] })
    }
    return saved
  }

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
            : entry.kind === 'notes'
              ? getNotes(db, entry.id).notes
              : requireRecord(db, entry.id)[entry.kind]
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
      title:
        kind === 'pinned' || kind === 'ideas'
          ? (getRecord(db, id)?.name ?? '')
          : (getNode(db, id)?.title ?? '')
    }))
  })

  register('recovery:restore', () => {
    const session = manager.require()
    const db = session.connection.orm
    return liveRecoveryEntries(db, session.localFolder).map(({ kind, id, content }) => {
      let wordCount: number | null = null
      if (kind === 'document') wordCount = saveFromEditor(db, id, content).wordCount
      else if (kind === 'notes') saveNotes(db, id, content)
      else saveRecordPage(db, id, kind, content)
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
    const v2 = memory() === 'v2'
    const wasIdea = v2 && getSceneMeta(db, id).meta.status === 'idea'
    const stored = setSceneMeta(db, id, meta)
    // F-9.16: a scene's point of view and its idea status feed the To do rules.
    queueTodo(db)
    // F-16.5: the Idea status relabels the passages of the node and everything under it; the
    // synopsis, brief and beats autosave here too, and they change no label.
    if (v2 && wasIdea !== (getSceneMeta(db, id).meta.status === 'idea')) {
      queueMemoryIndex(db)
      bookOrderMoved([id])
    }
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
    // F-16.16: a pause the change may have fixed (Use AI, the reading switch, the source) lifts.
    reader.settingsChanged()
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

  // F-16.21: in v2 the links applied automatically after a reading (`plan_link`).
  register('planLinks:get', () => {
    const db = manager.require().connection.orm
    return memory() === 'v2' ? planLinkViewV2(db) : getPlanLinks(db)
  })

  register('planLinks:run', ({ requestId }) => {
    const db = manager.require().connection.orm
    return runPlanLinks(db, requestDeps(db), { requestId })
  })

  register('planLinks:confirm', ({ key }) => confirmPlanLink(manager.require().connection.orm, key))

  register('planLinks:dismiss', ({ key }) => {
    dismissPlanLink(manager.require().connection.orm, key)
    return null
  })

  register('planLinks:unlink', ({ plan }) => {
    const db = manager.require().connection.orm
    return memory() === 'v2' ? unlinkPlanV2(db, plan, new Date()) : unlinkPlan(db, plan)
  })

  register('planLinks:keep', ({ planId }) => keepPlanLink(manager.require().connection.orm, planId))

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
      memory: session.storyMemory,
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

  register('compileState:set', (value) => {
    const db = manager.require().connection.orm
    const before = new Set(getCompileState(db).excluded)
    const stored = setCompileState(db, value)
    // F-16.5: a scene left out of compile is relabelled in the passage index.
    queueMemoryIndex(db)
    const after = new Set(stored.excluded)
    const flipped = [
      ...[...before].filter((id) => !after.has(id)),
      ...[...after].filter((id) => !before.has(id))
    ]
    if (flipped.length > 0) bookOrderMoved(flipped)
    return stored
  })

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
        result.changed.map((each) => each.id),
        'bulk'
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
        result.restored.map((each) => each.id),
        'bulk'
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
      result.changed.map((each) => each.id),
      'bulk'
    )
    // F-16.18: each draft has its own cards, so the passage index takes the new draft's card
    // lines, scenes whose text did not change included (v2 only; by hash, nothing else is read).
    queueMemoryIndex(db)
    // F-16.27: only the active draft's findings are live; the new draft's are found again.
    queueFindings(db)
    return result
  })

  register('drafts:duplicate', ({ id, name }) =>
    duplicateDraft(manager.require().connection.orm, id, name)
  )

  register('drafts:rename', ({ id, name }) =>
    renameDraft(manager.require().connection.orm, id, name)
  )

  register('drafts:delete', ({ id }) => {
    const db = manager.require().connection.orm
    const list = deleteDraft(db, id)
    // P2b-D12: the draft's reveals and claims went with it (cascade); a secret or thread the AI
    // made that only that draft backed goes too.
    if (memory() === 'v2') {
      const pruned = pruneTopics(db)
      if (pruned.length > 0) emit(windows(), 'record:changed', { recordIds: pruned, roster: false })
    }
    return list
  })

  register('drafts:compare', ({ fromId, toId }) =>
    compareDrafts(manager.require().connection.orm, fromId, toId)
  )

  register('drafts:revert', ({ fromId, nodeIds }) => {
    const db = manager.require().connection.orm
    const result = revertDocuments(db, fromId, nodeIds)
    documentsWritten(
      db,
      result.changed.map((each) => each.id),
      'bulk'
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
      result.changed.map((each) => each.id),
      'bulk'
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
      notes: result.notes,
      skipped: result.skipped
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
  register('account:getCredits', async () => {
    const credits = await account.credits()
    // F-16.19 (P2a-D10): the Cloud tally is raised to the server's reading spend, never lowered.
    reader.reconcileCloud(credits)
    return credits
  })

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

  register('backups:now', () => backups.backupNow().state)

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
    reader.settingsChanged()
    return aiStatus()
  })

  register('ai:clearKey', () => {
    keyStore.clearKey(ownKey())
    return aiStatus()
  })

  register('ai:setOwnKeyProvider', ({ provider }) => {
    appState.update((s) => ({ ...s, ownKeyProvider: provider }))
    if (keyStore.hasKey(provider)) {
      backfillSummaries(true)
      reader.settingsChanged()
    }
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
    // F-16.17: another model may lift the health gate's pause.
    reader.settingsChanged()
    return modelChoice()
  })

  // F-5.15: the registry reads the address live and rebuilds the local client when it changes.
  register('ai:setLocalEndpoint', ({ baseUrl }) => {
    appState.update((s) => ({ ...s, localAi: { baseUrl: baseUrl.replace(/\/+$/, '') } }))
    backfillSummaries(true)
    reader.settingsChanged()
    return aiStatus()
  })

  // F-5.11: the registry reads the mapping live, so no provider rebuild follows a change.
  register('ai:setModels', ({ provider, models }) => {
    appState.update((s) => ({ ...s, models: { ...s.models, [provider]: models } }))
    // F-16.17: another model may lift the health gate's pause.
    reader.settingsChanged()
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
        const result = await generateGhostText(db, deps, {
          nodeId,
          before,
          after,
          requestId,
          memory: memory()
        })
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
          { nodeId, mode, paragraphs, message, history, requestId, memory: memory() },
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
          { nodeId, text, before, after, note, regeneratedFrom, requestId, memory: memory() },
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
        const result = await runCritique(db, deps, {
          nodeId,
          note,
          regeneratedFrom,
          requestId,
          memory: memory()
        })
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
      const result = await runProofread(db, deps, {
        nodeId,
        memory: memory(),
        selection,
        requestId
      })
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
    memory,
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

  register('editPass:start', ({ type, instruction, nodeIds, excerpt }) => {
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
    // F-5.26: a selected passage belongs to one scene; a blank one means the whole scene.
    const passage = excerpt?.trim() ? excerpt : null
    if (passage !== null && ids.length !== 1) {
      throw new AppError('VALIDATION', 'A pass on a selection covers one scene')
    }
    return startResult(() =>
      editPasses.start({
        type,
        instruction: type === 'custom' ? text : null,
        nodeIds: ids,
        excerpt: passage
      })
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
      const result = await runWhatNext(db, deps, {
        nodeId,
        before,
        requestId,
        memory: memory()
      })
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
        const { action, instruction, edit, routedBy, usage, costUsd, cached, model } = result
        return {
          ok: true,
          action,
          instruction,
          edit,
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

  // F-16.24, F-16.25 (story memory v2, in place of `ai:route`): Ms Scribe's navigation: Step 0
  // and an instant card with no AI call (reading the latest change first through *Read now*), or
  // `navigator.v1`'s route action or answer turn. Each lookup is announced as `ai:agentStep` for
  // `requestId`; the ledger rows are the cost. The logic is `runNavigate`'s.
  register(
    'ai:navigate',
    async ({ nodeId, message, history, focus, requestId }): Promise<AiNavigateResult> => {
      try {
        const db = manager.require().connection.orm
        const result = await runNavigate(
          db,
          requestDeps(db),
          {
            readNow: (id, readId) => reader.readNow(id, readId),
            checkAnchors: (id) => void checkAnchorsNow(db, id, new Date())
          },
          { nodeId, message, history, focus, requestId },
          (step) => emit(windows(), 'ai:agentStep', { requestId, step })
        )
        const { usage, costUsd, cached, model } = result
        const spend = { usage, costUsd, cached, model, requestId }
        switch (result.kind) {
          case 'instant':
            return { ok: true, kind: 'instant', card: result.card, ...spend }
          case 'route':
            return {
              ok: true,
              kind: 'route',
              action: result.decision.action,
              instruction: result.decision.instruction,
              edit: result.decision.edit,
              routedBy: result.routedBy,
              ...spend
            }
          case 'answer':
            return {
              ok: true,
              kind: 'answer',
              action: result.action,
              navigation: result.navigation,
              steps: result.steps,
              routedBy: result.routedBy,
              readUsd: result.readUsd,
              ...spend
            }
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
        const result = await runSuggestSynopsis(db, requestDeps(db), {
          nodeId,
          requestId,
          memory: memory()
        })
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
          instruction,
          memory: memory()
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
        const result = await runBetaReader(db, deps, {
          nodeId,
          note,
          regeneratedFrom,
          requestId,
          memory: memory()
        })
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
    async ({
      nodeId,
      message,
      history,
      access,
      focus,
      requestId,
      navigation
    }): Promise<AiAgentResult> => {
      try {
        const db = manager.require().connection.orm
        const deps = requestDeps(db)
        const onStep = (step: AgentStep): void =>
          emit(windows(), 'ai:agentStep', { requestId, step })
        const hooks: AgentHooks = {
          answer: (delta) => emit(windows(), 'ai:agentDelta', { requestId, delta, reset: false }),
          reset: () => emit(windows(), 'ai:agentDelta', { requestId, delta: '', reset: true }),
          note: (stepId, note) => devtools.annotate(stepId, note)
        }
        // F-16.25: a story memory v2 project's chat is Ms Scribe's one answer call (`runScribe`).
        const result =
          memory() === 'v2'
            ? await runScribe(
                db,
                deps,
                { nodeId, message, history, access, focus, requestId, navigation },
                onStep,
                hooks
              )
            : {
                ...(await runAgent(
                  db,
                  deps,
                  { nodeId, message, history, access, focus, requestId },
                  onStep,
                  hooks
                )),
                scribe: null
              }
        const {
          answer,
          query,
          steps,
          changes,
          organise,
          scribe,
          dropped,
          usage,
          costUsd,
          cached,
          model
        } = result
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
          scribe,
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
          { nodeId, brief, words, before, after, passage, requestId, memory: memory() },
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
  // F-16.16: in a v2 project the indicator is the reader's queue (no summary runs there).
  register('jobs:status', () => (memory() === 'v2' ? reader.queueStatus() : queue.status()))

  register('jobs:cancel', () => (memory() === 'v2' ? reader.cancelAll() : queue.cancelAll()))

  register('jobs:resume', () => (memory() === 'v2' ? reader.resume() : queue.resume()))

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
    // F-16.4: as in the backfill, a v2 project keeps the held scenes held but never hears about
    // the v1 dialog, whose Update now it could not run.
    if (hold && memory() === 'v1') {
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
    const session = manager.require()
    const db = session.connection.orm
    const controller = registerInflight(requestId)
    try {
      const result = await detectImportStructure(db, requestDeps(db), {
        memory: session.storyMemory,
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
      result.rewritten.map((each) => each.id),
      'bulk'
    )
    if (result.deleted.length > 0)
      emit(windows(), 'continuity:changed', { nodeIds: result.deleted })
    // F-9.13: the deleted scenes' AI facts went with them; the sheets that held them refetch.
    if (result.factEntityIds.length > 0)
      emit(windows(), 'fact:changed', { entityIds: result.factEntityIds })
    mentionQueue.indexAll('mentions', staleMentionNodeIds(db))
    // F-16.5: in v2 the imported scenes are scanned for names and indexed (by hash).
    queueMemoryIndex(db)
    // F-16.16: the imported scenes are unread: the backlog check reads up to 5 or asks.
    if (memory() === 'v2') reader.bulkWritten()
    backfillSummaries(false)
    // A project in a cloud-synced folder gets the import copied back now, not in three minutes.
    cloudSync?.changed()
  }

  register('import:commit', ({ draft }) => {
    const session = manager.require()
    const db = session.connection.orm
    const result = importDraft(db, session.info.format, draft, session.storyMemory)
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
        written.result = importDraft(db, format, draft, manager.newProjectMemory())
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

  // F-7.13: the assistant's name is app-wide; main keeps it (blank is the default) and rebuilds
  // the native menu, whose View item carries it.
  register('view:setAssistantName', ({ name }) => {
    const assistantName = normalizeAssistantName(name)
    const view = appState.update((s) => ({ ...s, view: { ...s.view, assistantName } })).view
    onAssistantNameChanged?.()
    return view
  })

  // F-7.8: the theme is the renderer's to paint; main keeps the choice and the custom themes,
  // refuses a paid theme once the trial has ended unpaid (the extras are cosmetic, so the check
  // lives here; they are on during the trial and with the license, changed by the author
  // 2026-10-10), and gives every window the theme's background.
  const unlocked = (): boolean => extrasUnlocked(access.status())
  const paintWindows = (view: ViewSettings): ViewSettings => {
    const color = themeBackground(view, unlocked())
    for (const w of windows()) if (!w.isDestroyed()) w.setBackgroundColor(color)
    return view
  }

  register('view:setTheme', ({ theme }) => {
    const known =
      (BUILT_IN_THEME_IDS as readonly string[]).includes(theme) ||
      appState.get().view.customThemes.some((t) => t.id === theme)
    if (!known) throw new AppError('VALIDATION', THEME_NOT_FOUND_MESSAGE)
    if (themeNeedsLicense(theme) && !unlocked()) {
      throw new AppError('VALIDATION', THEME_NEEDS_LICENSE_MESSAGE)
    }
    return paintWindows(appState.update((s) => ({ ...s, view: { ...s.view, theme } })).view)
  })

  register('view:saveCustomTheme', ({ theme }) => {
    if (!unlocked()) throw new AppError('VALIDATION', THEME_NEEDS_LICENSE_MESSAGE)
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

  // Story memory v2 (F-16.4, F-16.5, F-16.7, F-16.10, F-16.11; plan P1 §1). The registry has
  // already refused each of these in a v1 project (`CHANNEL_MEMORY`). All of it is local: no AI,
  // no key, nothing sent anywhere; it works with Use AI off.

  /**
   * The roster moved (a record made, renamed, merged, split or deleted, a nickname confirmed):
   * the windows hear which records, every scene's name scan is due again (the roster is part of
   * its hash), the questions and the spellchecker's names follow.
   */
  const rosterChanged = (db: TreeDb, recordIds: readonly string[]): void => {
    emit(windows(), 'record:changed', { recordIds: [...recordIds], roster: true })
    // F-16.17: a name the reader's facts wait on that a record now answers to settles them, by
    // whatever path the name was given (a record made, a nickname added, a rename, a split).
    if (memory() === 'v2') {
      const settled = settleOwnedNames(db, new Date())
      if (settled.nodeIds.length > 0) {
        memoryChanged({ nodeIds: settled.nodeIds, recordIds: [...recordIds] })
      }
      // F-16.27: a record merged, split or deleted moves its findings (a merge re-keys its Not a
      // problem rows; a deleted record's rows went with it): the candidates are found again.
      queueFindings(db)
    }
    queueMemoryIndex(db)
    publishQuestions()
    void syncSpelling()
  }

  /** F-16.22: a secret or thread made, gone or put back: its list, its sheets and the scenes it touched. */
  const topicsChanged = (change: TopicChange): void => {
    emit(windows(), 'record:changed', { recordIds: change.topicIds, roster: true })
    memoryChanged({
      nodeIds: change.nodeIds,
      recordIds: [...change.topicIds, ...change.recordIds]
    })
  }

  register('record:list', () => listRecords(manager.require().connection.orm))

  register('record:get', ({ id }) => requireRecord(manager.require().connection.orm, id))

  register('record:create', ({ name, categoryId, aliases, force }) => {
    const db = manager.require().connection.orm
    // P2b-D2: a secret's or thread's label the name takes yields (" (thread)" added).
    const { result: made, relabeled } = withTopicRelabels(db, () =>
      createRecord(db, { name, categoryId, aliases, force }, new Date())
    )
    if ('record' in made) {
      rosterChanged(db, [made.record.id, ...relabeled])
      // F-16.17: scenes read before it that name it are read back (the lazy back-fill).
      reader.namesAdded(made.record.id, namesOf(made.record))
    }
    return made
  })

  register('record:update', async ({ id, categoryId, image }) => {
    const session = manager.require()
    const db = session.connection.orm
    const previous = requireRecord(db, id).image
    let fileName: string | null | undefined
    if (image === 'choose') {
      const source = await dialogs.chooseEntityImage()
      if (source !== null)
        fileName = addImageAsset(session.folder, ENTITY_IMAGES_DIR, source, 'image')
    } else if (image === 'remove') {
      fileName = null
    }
    let updated: ReturnType<typeof updateRecord>
    try {
      updated = updateRecord(
        db,
        id,
        {
          ...(categoryId === undefined ? {} : { categoryId }),
          ...(fileName === undefined ? {} : { image: fileName })
        },
        new Date()
      )
    } catch (err) {
      if (typeof fileName === 'string')
        removeImageAsset(session.folder, ENTITY_IMAGES_DIR, fileName)
      throw err
    }
    // The record's image is its own file, so the one it replaced goes.
    if (fileName !== undefined && previous !== null && previous !== fileName) {
      removeImageAsset(session.folder, ENTITY_IMAGES_DIR, previous)
    }
    // A category is a kind, which the name scan reads (a group answers plurals).
    if (categoryId !== undefined) rosterChanged(db, [id])
    else emit(windows(), 'record:changed', { recordIds: [id], roster: false })
    return updated
  })

  register('record:setAliases', ({ id, name, aliases }) => {
    const db = manager.require().connection.orm
    const before = new Set(namesOf(requireRecord(db, id)).map(normName))
    const { result: updated, relabeled } = withTopicRelabels(db, () =>
      setAliases(db, id, { name, aliases }, new Date())
    )
    rosterChanged(db, [id, ...relabeled])
    // F-16.17: a nickname added after scenes naming it were read: the lazy back-fill.
    reader.namesAdded(
      id,
      namesOf(updated).filter((text) => !before.has(normName(text)))
    )
    return updated
  })

  register('record:savePage', ({ id, page, doc }) =>
    saveRecordPage(manager.require().connection.orm, id, page, doc)
  )

  register('record:delete', ({ id }) => {
    const session = manager.require()
    const db = session.connection.orm
    const { record: gone, pruned } = deleteRecord(db, id)
    dropOwner(db, 'record', id)
    if (gone.image !== null) removeImageAsset(session.folder, ENTITY_IMAGES_DIR, gone.image)
    // P2b-D12: the AI-made secrets and threads only it backed went too.
    rosterChanged(db, [id, ...pruned])
    return null
  })

  register('record:sameAs', ({ keepId, mergeId }) => {
    const session = manager.require()
    const db = session.connection.orm
    const { record: kept, droppedImage } = sameAs(db, keepId, mergeId, new Date())
    dropOwner(db, 'record', mergeId)
    if (droppedImage !== null) removeImageAsset(session.folder, ENTITY_IMAGES_DIR, droppedImage)
    rosterChanged(db, [keepId, mergeId])
    return kept
  })

  register('record:split', ({ id, aliasIds, intoId }) => {
    const db = manager.require().connection.orm
    const result = splitRecord(db, id, aliasIds, intoId, new Date())
    rosterChanged(db, [result.from.id, result.into.id])
    return result
  })

  // F-16.26 (decision 3 as the author changed it): the lines Ms Scribe puts on a sheet when the
  // author asks, and the chat's Undo. The page's sheet editor reads the record again on
  // `record:changed`; the line is indexed at once (`sheetLines.ts`).
  register('record:addLine', (input) => {
    const db = manager.require().connection.orm
    const added = saveRecordPageWith(db, input.id, (each) => addSheetLine(each, input, new Date()))
    emit(windows(), 'record:changed', { recordIds: [input.id], roster: false })
    // F-16.27: the line is indexed at once; C6 checks the sheet against the book again.
    queueFindings(db)
    return added
  })

  register('record:removeLine', (input) => {
    const db = manager.require().connection.orm
    const removed = saveRecordPageWith(db, input.id, (each) =>
      removeSheetLine(each, input, new Date())
    )
    emit(windows(), 'record:changed', { recordIds: [input.id], roster: false })
    queueFindings(db)
    return removed
  })

  register('record:gate', ({ name, exceptId }) =>
    gateName(manager.require().connection.orm, name, exceptId)
  )

  register('label:list', () => listLabels(manager.require().connection.orm))
  register('label:create', ({ name, kind, colour }) =>
    createLabel(
      manager.require().connection.orm,
      { name, kind, ...(colour === undefined ? {} : { colour }) },
      new Date()
    )
  )
  register('label:update', ({ id, name, kind, colour }) =>
    updateLabel(
      manager.require().connection.orm,
      id,
      {
        ...(name === undefined ? {} : { name }),
        ...(kind === undefined ? {} : { kind }),
        ...(colour === undefined ? {} : { colour })
      },
      new Date()
    )
  )
  register('label:delete', ({ id }) => deleteLabel(manager.require().connection.orm, id))
  register('label:reorder', ({ ids }) => reorderLabels(manager.require().connection.orm, ids))
  register('label:assign', ({ labelId, nodeId }) =>
    assignLabel(manager.require().connection.orm, labelId, nodeId)
  )
  register('label:unassign', ({ labelId, nodeId }) =>
    unassignLabel(manager.require().connection.orm, labelId, nodeId)
  )
  register('label:forNode', ({ nodeId }) => labelsForNode(manager.require().connection.orm, nodeId))
  register('label:links', () => listLabelLinks(manager.require().connection.orm))

  register('dismissed:list', () => listDismissed(manager.require().connection.orm))

  register('dismissed:undo', ({ id }) => {
    const db = manager.require().connection.orm
    // The row goes and what it took away comes back in one transaction: a restore that fails
    // leaves the row on the list, to be undone again.
    const { undone, topic, restored, forgot } = db.transaction((tx) => {
      const row = undoDismissed(tx, id)
      // F-16.28: an answer on an underlined finding undone counts no more (P4 slice 5 review).
      const forgot = forgetAnswer(tx, row)
      if (row.kind !== 'notRight') return { undone: row, topic: null, restored: null, forgot }
      return {
        undone: row,
        // F-16.22: a secret or thread *Not a secret* took away comes back as it was.
        topic: restoreTopicNotRight(tx, row.id),
        restored: restoreNotRight(tx, row.id),
        forgot
      }
    })
    // The precision question may no longer be due.
    if (forgot) reader.noticesMoved()
    // What it kept quiet may come back: a mention (every scan's hash holds the list), a question.
    if (undone.kind === 'notMention') queueMemoryIndex(db)
    // F-16.18: *Undo* on *Not right › Wrong value* brings its lines back as they were; the anchors
    // job then checks them against the text as it is now. A typed-detail *Keep mine* undone may
    // be asked again.
    if (restored !== null) {
      if (topic !== null) {
        if (topic.nodeIds.length > 0) mentionQueue.indexAll('anchors', topic.nodeIds)
        topicsChanged(topic)
      }
      // The anchors job's own `memory:changed` follows once it has checked them.
      if (restored.nodeIds.length > 0) mentionQueue.indexAll('anchors', restored.nodeIds)
      // A card value said to be not right (no lines kept) counts again in Here and the card.
      const nodeIds = [
        ...new Set([...restored.nodeIds, ...(undone.nodeId === null ? [] : [undone.nodeId])])
      ]
      const recordIds = [
        ...new Set([...restored.recordIds, ...(undone.recordId === null ? [] : [undone.recordId])])
      ]
      if (nodeIds.length > 0 || recordIds.length > 0) {
        memoryChanged({ nodeIds, recordIds })
      }
      reader.detailsChanged()
    }
    if (undone.kind === 'notProblem') {
      reader.detailsChanged()
      // F-16.27: a finding the author had said is not a problem is found again (a C7 one too).
      restoreFindings.add(undone.key)
      // F-16.29: a loose end's comes back in Needs a look as marking it took it away
      // (`memory:looseEndAction`): the renderer reads loose ends again on `memory:changed`.
      if (undone.key.startsWith('loose|')) {
        memoryChanged({
          nodeIds: undone.nodeId === null ? [] : [undone.nodeId],
          recordIds: undone.recordId === null ? [] : [undone.recordId]
        })
      } else {
        queueFindings(db)
      }
    }
    // F-16.21: *Undo* of an *Unlink* puts the plan link back as it was (the author's or automatic).
    if (undone.kind === 'unlink') {
      const relinked = restoreUnlinked(db, undone)
      if (relinked.linksChanged || relinked.changedNodeIds.length > 0) {
        emit(windows(), 'planLinks:changed', { changedNodeIds: relinked.changedNodeIds })
      }
    }
    publishQuestions()
    return undone
  })

  register('authorTodo:list', () => listAuthorTodos(manager.require().connection.orm))
  register('authorTodo:create', (input) =>
    createAuthorTodo(manager.require().connection.orm, input, new Date())
  )
  register('authorTodo:update', ({ id, patch }) =>
    updateAuthorTodo(manager.require().connection.orm, id, patch, new Date())
  )
  register('authorTodo:delete', ({ id }) => deleteAuthorTodo(manager.require().connection.orm, id))
  register('authorTodo:reorder', ({ ids }) =>
    reorderAuthorTodos(manager.require().connection.orm, ids)
  )

  register('sceneDetail:get', ({ nodeId }) =>
    getSceneDetails(manager.require().connection.orm, nodeId)
  )

  register('sceneDetail:set', ({ nodeId, details }) => {
    const db = manager.require().connection.orm
    const stored = setSceneDetails(db, nodeId, details, new Date())
    // The typed POV settles shared aliases, so the scene's names are read again.
    if (manuscriptDocuments(db).some((row) => row.id === nodeId)) {
      mentionQueue.touch('names', nodeId)
    }
    // F-16.18 (decision 4): Here and the typed-detail conflicts compare the typed details with
    // the scene's card, so they are looked at again.
    if (memory() === 'v2') {
      memoryChanged({ nodeIds: [nodeId], recordIds: [] })
      reader.detailsChanged()
    }
    return stored
  })

  register('names:forNode', ({ nodeId }) =>
    listNameMentions(manager.require().connection.orm, nodeId)
  )

  register('names:byRecord', () => namedInCounts(manager.require().connection.orm))

  register('names:notAMention', ({ mentionId }) => {
    const db = manager.require().connection.orm
    const tombstone = markNotAMention(db, mentionId, new Date())
    if (tombstone.nodeId !== null) emit(windows(), 'names:changed', { nodeIds: [tombstone.nodeId] })
    // The list is part of every scan's hash: the same phrase elsewhere is read again too.
    queueMemoryIndex(db)
    return tombstone
  })

  register('names:questions', () => listNameQuestions(manager.require().connection.orm))

  register('names:answer', ({ answer }) => {
    const db = manager.require().connection.orm
    // F-16.17: the reader's facts waiting on the name attach on a Yes and go on a No.
    const {
      result: { result, settled },
      relabeled
    } = withTopicRelabels(db, () => answerNameQuestion(db, answer, new Date()))
    if (result.kind === 'record') {
      rosterChanged(db, [result.record.id, ...relabeled])
      // F-16.17: the name (a new record, or a nickname) is read back where it was read before.
      reader.namesAdded(result.record.id, [answer.name])
    } else publishQuestions()
    if (settled !== null && settled.nodeIds.length > 0) {
      memoryChanged({
        nodeIds: settled.nodeIds,
        recordIds: result.kind === 'record' ? [result.record.id] : []
      })
    }
    return result
  })

  // F-16.13: Rename in book. The apply and the undo are bulk document saves like Replace in
  // project's, so each ends in `documentsWritten` for what main wrote (the open scene is saved
  // by its editor), and the renamed name is a roster change.
  register('rename:preview', (request) => previewRename(manager.require().connection.orm, request))

  register('rename:apply', (request) => {
    const db = manager.require().connection.orm
    const { result, relabeled } = withTopicRelabels(db, () => applyRename(db, request, new Date()))
    clearSearchCache()
    documentsWritten(
      db,
      result.written.map((each) => each.id),
      'bulk'
    )
    // P2b: AI-made topics' labels that named the record, and any label the new name took.
    rosterChanged(db, [request.recordId, ...relabeled])
    return result
  })

  register('rename:undo', () => {
    const db = manager.require().connection.orm
    const { result, relabeled } = withTopicRelabels(db, () => undoRename(db, new Date()))
    clearSearchCache()
    documentsWritten(
      db,
      result.restored.map((each) => each.id),
      'bulk'
    )
    if (result.record !== null) rosterChanged(db, [result.record.id, ...relabeled])
    return result
  })

  register('passages:search', ({ query, sources, limit }) =>
    searchMemoryPassages(manager.require().connection.orm, query, {
      limit,
      ...(sources === undefined ? {} : { sources })
    })
  )

  // F-16.8: the Research section. Its documents are saved through `document:save` like any
  // other; these channels make them, switch a page Not canon, and open an upload's original.
  register('research:list', () => listResearchDocs(manager.require().connection.orm))

  /** Uploads these files into Research (F-16.8) and answers the new pages, each queued to index. */
  const uploadResearch = async (
    sources: readonly ContextSource[],
    parentId: string | undefined
  ): Promise<Output<'research:addData'>> => {
    const session = manager.require()
    const db = session.connection.orm
    const result = await addResearchFiles(
      db,
      session.folder,
      session.info.format,
      sources,
      parentId
    )
    const nodes: TreeNode[] = []
    for (const id of result.created) {
      const row = getNode(db, id)
      if (row !== undefined) nodes.push(toTreeNode(row))
      mentionQueue.touch('passages', id)
    }
    return {
      nodes,
      docs: result.created.map((id) => researchDocOf(db, id)),
      skipped: result.skipped
    }
  }

  register('research:add', async ({ paths, parentId }) => {
    manager.require()
    const chosen = paths ?? (await dialogs.chooseContextFiles())
    if (chosen === null) return null
    const sources = chosen.map((file) => ({
      name: path.basename(file),
      read: () => fs.readFileSync(file)
    }))
    return uploadResearch(sources, parentId)
  })

  register('research:addData', ({ files, parentId }) =>
    uploadResearch(
      files.map((file) => ({ name: file.name, read: () => Buffer.from(file.data) })),
      parentId
    )
  )

  register('research:create', ({ parentId, afterId, title }) => {
    const session = manager.require()
    const db = session.connection.orm
    const row = createResearchNote(db, session.info.format, {
      ...(parentId === undefined ? {} : { parentId }),
      ...(afterId === undefined ? {} : { afterId }),
      ...(title === undefined ? {} : { title })
    })
    return { node: toTreeNode(row), doc: researchDocOf(db, row.id) }
  })

  register('research:setNotCanon', ({ nodeId, notCanon }) => {
    const db = manager.require().connection.orm
    const doc = setResearchNotCanon(db, nodeId, notCanon)
    // Every paragraph of the page reads as the switch says now.
    mentionQueue.touch('passages', nodeId)
    return doc
  })

  register('research:openOriginal', async ({ nodeId }) => {
    const session = manager.require()
    const target = researchOriginalPath(session.connection.orm, session.folder, nodeId)
    const failure = await openPath(target)
    if (failure !== '') throw new AppError('IO', failure)
    return null
  })

  // F-16.16, F-16.17, F-16.19: the reader service owns the reading; the handlers only reach it.
  register('memory:readNow', ({ nodeId, requestId }) => reader.readNow(nodeId, requestId))

  register('memory:settle', (input) => reader.settle(input))

  register('memory:status', () => reader.status())

  register('memory:notices', () => reader.notices())

  register('memory:answerNotice', ({ id, action }) => {
    // Decision 4's *Keep mine* (closing the conflict too) writes a Dismissed row: refused after
    // the trial, as its Undo is. The other answers only steer reading.
    if (id.startsWith('detail:') && (action === 'keepMine' || action === 'dismiss')) {
      access.assertWritable()
    }
    return reader.answerNotice(id, action)
  })

  register('memory:health', () => reader.health())

  register('memory:rebuildEstimate', () => reader.rebuildEstimate())

  register('memory:rebuild', () => reader.rebuild())

  register('memory:rebuildSummary', () => reader.rebuildSummary())

  register('memory:rebuildAction', (action) => reader.rebuildAction(action))

  register('cloudCap:get', () => reader.cloudCap())

  register('cloudCap:set', ({ capUsd }) => reader.setCloudCap(capUsd))

  register('memory:scene', ({ nodeId }) => sceneMemory(manager.require().connection.orm, nodeId))

  // F-16.20: the card lines the Outline and the cork board show where a scene has no synopsis.
  register('memory:cardLines', () =>
    Object.fromEntries(cardLines(manager.require().connection.orm))
  )

  register('memory:claim', ({ claimId }) => claimInfo(manager.require().connection.orm, claimId))

  register('memory:sheet', ({ recordId, asOf }) =>
    sheetMemory(manager.require().connection.orm, recordId, asOf)
  )

  // F-16.22: who knows what (the Book's grid), and the author's answers on secrets.
  register('memory:knows', ({ asOf }) => knowsGridMemory(manager.require().connection.orm, asOf))

  // F-16.23: the Book's Threads and Timeline (years and ages), local and free.
  register('memory:threads', ({ asOf }) => threadsMemory(manager.require().connection.orm, asOf))
  register('memory:timeline', ({ recordId }) =>
    timelineMemory(manager.require().connection.orm, recordId)
  )

  // F-16.27: the contradictions found and judged, hidden while the Contradiction check is off.
  register('memory:findings', ({ nodeId }) => {
    const db = manager.require().connection.orm
    return findingsView(db, nodeId, {
      on: getAiSettings(db).features.judge,
      judging: reader.judging()
    })
  })

  /**
   * F-16.27, F-16.29: a finding answered (closed by *Not a problem*, *This one's right* or *Update
   * my note*): its scenes and records read again, and the counts sent at once (the recompute that
   * follows finds nothing to move).
   */
  const findingsAnswered = (
    db: TreeDb,
    touched: { nodeIds: readonly string[]; recordIds: readonly string[] }
  ): void => {
    memoryChanged(touched)
    emit(windows(), 'memory:findingsChanged', findingCounts(db, getAiSettings(db).features.judge))
    // F-16.28: an underlined finding answered moves underline precision (its one question).
    reader.noticesMoved()
  }

  // F-16.28: the editor's contradiction underlines, every region of a stacked view in one call,
  // never in a paragraph with an unread change.
  register('memory:underlines', ({ nodeIds }) => {
    const db = manager.require().connection.orm
    const settings = getAiSettings(db)
    return underlinesOf(db, nodeIds, {
      on: settings.features.judge,
      mode: settings.reading.underlines
    })
  })

  // F-16.28: the editor drew these findings as underlines (their `shown_at`, once).
  register('memory:underlinesShown', ({ findingIds }) => {
    underlinesShown(manager.require().connection.orm, findingIds, new Date())
    return null
  })

  // F-16.30: Check the book, priced first; its report kept until the next check.
  register('memory:checkEstimate', () => reader.checkEstimate())
  register('memory:checkBook', ({ nodeId }) => reader.checkBook(nodeId))
  register('memory:checkReport', () => reader.checkReport())

  // F-16.27, F-16.29: the answers on a finding; Dismissed rows only, never the manuscript.
  register('memory:findingAction', (input) => {
    const db = manager.require().connection.orm
    const now = new Date()
    const touched = findingTouches(requireFinding(db, input.findingId))
    if (input.action === 'notProblem') {
      const dismissed = findingNotProblem(db, input.findingId, now)
      findingsAnswered(db, touched)
      return { dismissed, other: null }
    }
    const result = findingRight(db, input.findingId, input.side, now)
    findingsAnswered(db, touched)
    // A card's Not right moves Here and decision 4's conflicts.
    reader.detailsChanged()
    return result
  })

  // F-16.29: Update my note, a code-made proposal the author edits and saves.
  register('memory:notePatch', ({ findingId }) =>
    notePatch(manager.require().connection.orm, findingId)
  )
  register('memory:applyNotePatch', (input) => {
    const db = manager.require().connection.orm
    const now = new Date()
    const touched = findingTouches(requireFinding(db, input.findingId))
    const result = applyNotePatch(
      db,
      input,
      {
        read: (owner) =>
          owner.kind === 'record'
            ? requireRecord(db, owner.id).pinned
            : getDocumentContent(db, owner.id).content,
        pinned: (recordId, doc) =>
          void saveRecordPageWith(db, recordId, (tx) => savePage(tx, recordId, 'pinned', doc, now)),
        research: (nodeId, doc) => void saveFromEditor(db, nodeId, doc, 'bulk')
      },
      now
    )
    if (result.owner.kind === 'record') {
      emit(windows(), 'record:changed', { recordIds: [result.owner.id], roster: false })
    }
    findingsAnswered(db, touched)
    return result
  })

  // F-16.29: Needs a look's Loose ends, local and free.
  register('memory:looseEnds', () => looseEndsView(manager.require().connection.orm))
  register('memory:looseEndAction', (input) => {
    const db = manager.require().connection.orm
    const row = looseEndNotProblem(db, input, new Date())
    memoryChanged({
      nodeIds: input.lastNodeId === null ? [] : [input.lastNodeId],
      recordIds: input.kind === 'planned' ? [] : [input.id]
    })
    return row
  })

  // F-16.25 (P3-D15): Ms Scribe's search misses, for Settings and F-16.35.
  register('scribe:searchMisses', ({ limit }) =>
    searchMisses(manager.require().connection.orm, limit)
  )

  register('memory:knewBefore', ({ secretId, recordId, knew }) => {
    const db = manager.require().connection.orm
    const changed = setKnewBefore(db, secretId, recordId, knew, new Date())
    if (changed) memoryChanged({ nodeIds: [], recordIds: [secretId, recordId] })
    return { changed }
  })

  register('memory:splitTopic', ({ topicQuoteId }) => {
    const db = manager.require().connection.orm
    const { recordId, dismissed: row, change } = splitReveal(db, topicQuoteId, new Date())
    topicsChanged(change)
    return { recordId, dismissed: row }
  })

  register('memory:topicNotRight', ({ recordId }) => {
    const db = manager.require().connection.orm
    const { dismissed: rows, change } = topicNotRight(db, recordId, new Date())
    topicsChanged(change)
    return { dismissed: rows }
  })

  register('memory:notRight', ({ claimId, choice, requestId }) => {
    // *Wrong value* writes a Dismissed row and runs no model, so the AI path cannot refuse it:
    // after the trial it is refused here, as its Undo (`dismissed:undo`) is.
    if (choice.kind === 'wrongValue') access.assertWritable()
    return reader.notRight(claimId, choice, requestId)
  })

  register('memory:cardNotRight', (input) => {
    const db = manager.require().connection.orm
    const row = cardNotRight(db, input, new Date())
    memoryChanged({
      nodeIds: [input.nodeId],
      recordIds: row.recordId === null ? [] : [row.recordId]
    })
    reader.detailsChanged()
    return row
  })

  // F-16.14: the Story notes block as the v2 prose prompts send it (the 400-token budget).
  register('storyNotes:get', ({ nodeId }) => ({
    text: buildStoryNotes(manager.require().connection.orm, {
      nodeId,
      maxTokens: STORY_BIBLE_TOKEN_BUDGET
    })
  }))

  // F-16.9: filing a Research page into Pinned. The estimate, priced like the library's (the
  // hosted quote on Cloud).
  register('research:fileEstimate', ({ nodeId }) => {
    const db = manager.require().connection.orm
    const source = sourceOf(db)
    const model = ai.get(source)?.resolveModel('strong') ?? ''
    const estimate = estimateFiling(db, nodeId, model)
    if (source !== 'cloud') return estimate
    const pricing = appState.get().cloudPricing?.pricing ?? bundledPricing()
    const quote = hostedQuote(pricing, model, estimate.tokensIn, estimate.tokensOut)
    return { ...estimate, costUsd: quote.costUsd, priced: quote.priced }
  })

  // Like `library:process`: the parent `requestId` is registered so `ai:cancel` stops the pass;
  // expected AI failures come back as data.
  register('research:file', async ({ nodeId, requestId }): Promise<FilingProcessResult> => {
    const db = manager.require().connection.orm
    const controller = registerInflight(requestId)
    try {
      const review = await fileResearch(db, requestDeps(db), {
        nodeId,
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

  register(
    'research:reviewChat',
    async ({ review, message, history, requestId }): Promise<ReviewChatResult> => {
      const db = manager.require().connection.orm
      const controller = registerInflight(requestId)
      try {
        const answer = await runFilingChat(db, requestDeps(db), {
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

  // The roster moved (records made, names added): the scans, the questions and the spellchecker
  // follow, as after any record write.
  register('research:applyFiling', ({ review }) => {
    const session = manager.require()
    const db = session.connection.orm
    // F-16.17: the names each record had before, so the ones filing adds get the lazy back-fill.
    const before = new Map(
      listRecords(db).map((record) => [record.id, new Set(namesOf(record).map(normName))])
    )
    const result = applyFiling(db, session.folder, review, new Date())
    rosterChanged(db, result.recordIds)
    for (const id of result.recordIds) {
      const record = getRecord(db, id)
      if (record === null) continue
      const known = before.get(id)
      reader.namesAdded(
        id,
        namesOf(record).filter((text) => known?.has(normName(text)) !== true)
      )
    }
    return result
  })

  register('research:undoFiling', ({ docId }) => {
    const session = manager.require()
    const db = session.connection.orm
    const result = undoFiling(db, session.folder, docId, new Date())
    for (const id of result.deleted) dropOwner(db, 'record', id)
    rosterChanged(db, [...result.recordIds, ...result.deleted])
    return result
  })

  register('research:filedConflicts', () => filedConflicts(manager.require().connection.orm))

  register('research:keepFiledLine', ({ conflict }) =>
    keepFiledLine(manager.require().connection.orm, conflict, new Date())
  )

  register('research:updateFiledLine', ({ recordId, lineIndex, line, text }) =>
    saveRecordPageWith(manager.require().connection.orm, recordId, (db) =>
      updateFiledLine(db, { recordId, lineIndex, line, text }, new Date())
    )
  )

  // F-16.15, F-16.31 (part A): the story-memory switch-over, on a test copy or on the project
  // itself. The steps live in `memory/switchover/` (`run.ts` holds the safety memo between the
  // channels); these handlers only reach them. `switchover:available` still names the developer
  // item's builds until Switch-over slice 3 gives every build its entry points.
  const switchoverAvailable = !app.isPackaged
  const switchover = new SwitchoverRun({
    session: () => manager.require(),
    backupNow: (options) => backups.backupNow(options).file,
    current: () => manager.current(),
    close: () => manager.close(),
    now: () => new Date()
  })
  register('switchover:available', () => ({ available: switchoverAvailable }))
  register('switchover:trialCopy', () => {
    const session = manager.require()
    const folder = createTrialCopy(
      { folder: session.folder, sqlite: session.connection.sqlite, name: session.info.name },
      new Date()
    )
    return { folder, info: manager.open(folder) }
  })
  register('switchover:safety', () => switchover.safety())
  register('switchover:plan', () => {
    const db = manager.require().connection.orm
    const source = sourceOf(db)
    const provider = ai.get(source)
    return planSwitchover(
      db,
      {
        source,
        fastModel: provider?.resolveModel('fast') ?? '',
        strongModel: provider?.resolveModel('strong') ?? '',
        pricing: appState.get().cloudPricing?.pricing ?? null
      },
      isFeatureAllowed(getAiSettings(db), 'judge') ? sweepCalls : undefined
    )
  })
  register('switchover:consent', () => inlineTagReplacements(manager.require().connection.orm))
  register('switchover:convert', (input) => switchover.convert(input))
  register('switchover:record', () => getSwitchoverRecord(manager.require().connection.orm))

  manager.onChange((info) => {
    // Open, create, and close all land here: a profile built for one project never answers for another.
    resetVoiceProfileCache()
    // F-16.31: the switch-over's safety memo belongs to the project that left.
    switchover.clear()
    // F-5.13: drop every pending job, timer, and status with the project that queued them;
    // the rows stay in that project's database, so opening it again takes the work up where it
    // stopped (`load` on an empty table does nothing, which is what a create lands on).
    queue.clear()
    // F-16.16: the reader's queue, pauses and notices too.
    reader.clear()
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
    // F-16.4: the same for the name questions.
    resetNameQuestionCache()
    lastQuestions = null
    // F-10.1: the cached searchable texts are keyed by node id, which means nothing in
    // another project.
    clearSearchCache()
    // F-10.2: the last replace's undo holds another project's documents.
    clearReplaceUndo()
    // F-16.13: so does the last rename's.
    clearRenameUndo()
    // F-16.9: and the last filing's.
    clearFilingUndo()
    // F-10.3: the session's words and active time start again with every project.
    resetGoalsSession()
    // F-9.14: Later holds for one session of one project.
    conversionDeferred = false
    // F-9.12: the local knowledge index, before anything reads the bank or the scenes: the
    // one-time conversion (every name tag a record, every record a tag) and the passages of
    // documents that left the manuscript. Local and free; a failure never stops the open.
    // F-16.4: a v2 project skips all of it (v1's conversions write v1 tables) and prunes its own
    // passage index instead.
    if (info?.storyMemory === 'v1') {
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
    } else if (info?.storyMemory === 'v2') {
      try {
        // F-16.8: the Research section, made once, before the window reads the tree.
        ensureResearchRoot(manager.require().connection.orm)
        pruneMemoryIndex(manager.require().connection.orm)
      } catch (err) {
        console.warn('Could not update the story memory index', err)
      }
    }
    // F-3.11, F-3.14: the spellchecker accepts the open project's words and story names and no
    // other project's.
    void syncSpelling()
    cancelBackfill()
    if (info) {
      mentionQueue.load()
      const opened = manager.require().connection.orm
      if (info.storyMemory === 'v2') {
        // F-16.4: v2's open: the stale name scans and passages are queued; the tag mentions, the
        // To do sync, the sheet sync and the tag proposals are v1's and do not run.
        queueMemoryIndex(opened)
        voiceQueue.load()
        publishQuestions()
        // F-16.17 (plan P2a §3.7): `summary.v5` is off in v2: the summary jobs P1 left are dropped
        // and the summary queue is not loaded. The reader takes up its own jobs, then the backlog
        // (a scene left unread at the last close is read now, P2a-D4) and the back-fills.
        try {
          dropSummaryJobs(opened)
        } catch (err) {
          console.warn('Could not drop the summary jobs', err)
        }
        reader.opened()
      } else {
        queue.load()
        mentionQueue.indexAll('mentions', staleMentionNodeIds(opened))
        voiceQueue.load()
        // F-9.16: the To do list is brought up to date on every open (local, free).
        todoQueue.load()
        // F-9.18: the sheets left due when the project closed are synced (no new pauses start).
        sheetSync.load()
        const todoRoot = manuscriptRootId(opened)
        if (todoRoot !== null) todoQueue.indexAll('todo', [todoRoot])
      }
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

/** Every name a record answers to, its own first (the lazy back-fill's names, F-16.17). */
function namesOf(record: StoryRecordSummary): string[] {
  return record.aliases.map((alias) => alias.text)
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
