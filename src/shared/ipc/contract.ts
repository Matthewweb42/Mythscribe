import { z } from 'zod'
import {
  AI_KEY_MAX,
  AI_KEY_MIN,
  AiErrorCode,
  AiModelMap,
  AiProviderId,
  AiStatus,
  AiTestConnectionResult,
  AiUsage,
  AiUsageSummary,
  DailyCapUsd,
  GHOST_AFTER_CHARS,
  GHOST_BEFORE_CHARS
} from '../ai'
import { AiSettings, AiSource } from '../aiSettings'
import {
  CHAT_HISTORY_TURNS,
  CHAT_MESSAGE_MAX,
  CHAT_PARAGRAPHS_MAX,
  CHAT_PARAGRAPHS_MIN,
  ChatMode,
  ChatRole,
  Conversations
} from '../chat'
import { AccountStatus } from '../account'
import { AuthorRules } from '../authorRules'
import { CheckoutBody, CreditsResult, EMAIL_MAX } from '../cloudApi'
import { BetaReaderItems, BetaReaderScene } from '../betaReader'
import { CritiqueNotes } from '../critique'
import {
  DiagnosticsState,
  RENDERER_ERROR_MESSAGE_MAX,
  RENDERER_ERROR_NAME_MAX,
  RENDERER_ERROR_STACK_MAX
} from '../diagnostics'
import { EditorSettings } from '../editorSettings'
import { Background, FocusSettings } from '../focus'
import { IndexQueueStatus } from '../jobs'
import { HierarchyLevel, NodeKind, SectionType } from '../labels'
import { Layout } from '../layout'
import { AccentId, SupporterStatus } from '../license'
import { MatterTemplateId } from '../matterTemplates'
import { EditRole, MenuItemId } from '../menu'
import { WritingPresets } from '../presets'
import { PROPOSAL_NOTE_MAX, SettledStatus } from '../proposal'
import { QueryCitation, QuerySceneRef } from '../query'
import { REWRITE_CONTEXT_CHARS, REWRITE_TEXT_MAX, REWRITE_TEXT_MIN } from '../rewrite'
import { SceneBrief, SceneMeta } from '../sceneMeta'
import { Stylometrics } from '../stylometry'
import { SceneSummaryState, SummaryStatus } from '../summary'
import { HEX_COLOR, TAG_NAME_MAX, TagCategory } from '../tags'
import { TagTemplateId } from '../tagTemplates'
import { TiptapNode } from '../tiptap'
import { UpdateChannel, UpdateState } from '../updates'
import { VOICE_EXEMPLAR_TEXT_MAX, VOICE_EXEMPLAR_TEXT_MIN, VoiceExemplarKind } from '../voice'

/**
 * The single IPC contract shared by main, preload, and renderer.
 * Every channel declares its input and output schema. Main validates inputs,
 * the renderer validates outputs, and both sides are typed from this file.
 */

export const NovelFormat = z.enum(['novel', 'epic', 'webnovel'])
export type NovelFormat = z.infer<typeof NovelFormat>

export const ProjectInfo = z.object({
  id: z.string(),
  name: z.string(),
  format: NovelFormat,
  path: z.string(),
  created: z.string(),
  modified: z.string(),
  lastOpened: z.string(),
  schemaVersion: z.number().int().nonnegative()
})
export type ProjectInfo = z.infer<typeof ProjectInfo>

/** Longest allowed project name; the create wizard validates against the same limit. */
export const PROJECT_NAME_MAX = 200

/** Maximum number of projects remembered on the welcome screen. */
export const RECENTS_MAX = 10

export const RecentProjectEntry = z.object({
  path: z.string(),
  name: z.string(),
  format: NovelFormat,
  lastOpened: z.string()
})
export type RecentProjectEntry = z.infer<typeof RecentProjectEntry>

/** A recent entry as shown to the renderer; `exists` reflects whether the folder is still a project. */
export const RecentProject = RecentProjectEntry.extend({ exists: z.boolean() })
export type RecentProject = z.infer<typeof RecentProject>

/** One row of the document tree (F-1.3, F-2.1): structure and metadata, never content. */
export const TreeNode = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  sectionType: SectionType.nullable(),
  kind: NodeKind,
  hierarchyLevel: HierarchyLevel.nullable(),
  title: z.string(),
  position: z.number().int(),
  wordCount: z.number().int(),
  matterType: z.string().nullable(),
  preset: z.string().nullable(),
  created: z.string(),
  modified: z.string()
})
export type TreeNode = z.infer<typeof TreeNode>

/** Longest allowed node title (F-2.2). */
export const NODE_TITLE_MAX = 200

/** One tag of the tag bank (F-4.1); `usageCount` is derived from `document_tag`, never stored. */
export const Tag = z.object({
  id: z.string(),
  name: z.string(),
  category: TagCategory,
  color: z.string().regex(HEX_COLOR),
  parentId: z.string().nullable(),
  usageCount: z.number().int().nonnegative(),
  created: z.string(),
  modified: z.string()
})
export type Tag = z.infer<typeof Tag>

/**
 * What `ai:recommendTags` answers (F-4.7): the bank tags the model picked that are not yet on
 * the document, with what the request cost (`cached` when the local cache answered), or an
 * expected AI failure as data with its next step, like `AiTestConnectionResult`. The batch is
 * one proposal (F-14.5); the tag bar settles `proposalId` once the author is done with it.
 */
export const AiRecommendTagsResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    suggestions: z.array(Tag),
    usage: AiUsage,
    costUsd: z.number(),
    cached: z.boolean(),
    model: z.string(),
    promptVersion: z.string(),
    proposalId: z.string()
  }),
  z.object({ ok: z.literal(false), code: AiErrorCode, message: z.string(), nextStep: z.string() })
])
export type AiRecommendTagsResult = z.infer<typeof AiRecommendTagsResult>

/**
 * What `ai:ghostText` answers (F-5.3): the continuation to show at the caret (`''` for "no
 * suggestion"), what it cost, and the caller's `requestId` echoed back so a stale answer is
 * dropped; or an expected AI failure as data with its next step, also carrying the id.
 * `flagged` (F-14.7) is true when the text still fails the local fidelity check after one
 * regenerate, with the first violation in `violation` for the warning badge; `usage` and
 * `costUsd` then cover both calls. `proposalId` (F-14.5) is the row the ghost-text widget
 * settles when the suggestion leaves the screen; null when there is no suggestion.
 */
export const AiGhostTextResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    text: z.string(),
    usage: AiUsage,
    costUsd: z.number(),
    cached: z.boolean(),
    model: z.string(),
    flagged: z.boolean(),
    violation: z.string().nullable(),
    proposalId: z.string().nullable(),
    requestId: z.string()
  }),
  z.object({
    ok: z.literal(false),
    code: AiErrorCode,
    message: z.string(),
    nextStep: z.string(),
    requestId: z.string()
  })
])
export type AiGhostTextResult = z.infer<typeof AiGhostTextResult>

/**
 * What `ai:chat` answers (F-5.4): the full answer (Plan mode streamed it first through
 * `ai:chatDelta` events keyed by `requestId`; Agent mode never streams, the text goes to the
 * editor as ghost text), what it cost, the proposal it became (F-14.5), and the fidelity flag
 * (F-14.7, Agent mode only; Plan answers are never flagged); or an expected AI failure as data.
 */
export const AiChatResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    text: z.string(),
    usage: AiUsage,
    costUsd: z.number(),
    cached: z.boolean(),
    model: z.string(),
    flagged: z.boolean(),
    violation: z.string().nullable(),
    proposalId: z.string(),
    requestId: z.string()
  }),
  z.object({
    ok: z.literal(false),
    code: AiErrorCode,
    message: z.string(),
    nextStep: z.string(),
    requestId: z.string()
  })
])
export type AiChatResult = z.infer<typeof AiChatResult>

/**
 * What `ai:query` answers (F-5.7): the answer text (its `[n]` markers name the surviving
 * citations' scene numbers; dangling ones are stripped), whether the model found an answer in
 * the scenes at all, whether it claimed one that no citation survived (`uncited`, shown
 * flagged), the citations main verified against the text it sent, the ranked candidates the
 * answer did not cite (`also`), how many citations were dropped, what it cost, and the
 * proposal it became (F-14.5); or an expected AI failure as data.
 */
export const AiQueryResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    answer: z.string(),
    found: z.boolean(),
    uncited: z.boolean(),
    citations: z.array(QueryCitation),
    also: z.array(QuerySceneRef),
    dropped: z.number().int().nonnegative(),
    usage: AiUsage,
    costUsd: z.number(),
    cached: z.boolean(),
    model: z.string(),
    proposalId: z.string(),
    requestId: z.string()
  }),
  z.object({
    ok: z.literal(false),
    code: AiErrorCode,
    message: z.string(),
    nextStep: z.string(),
    requestId: z.string()
  })
])
export type AiQueryResult = z.infer<typeof AiQueryResult>

/**
 * What `ai:rewrite` answers (F-14.10): the rewritten passage (streamed first through
 * `ai:rewriteDelta` events keyed by `requestId`), what it cost, the proposal it became
 * (F-14.5, with the target range), and the fidelity flag (F-14.7); or an expected AI failure
 * as data. The same shape as a chat answer, so the renderer's handling is shared.
 */
export const AiRewriteResult = AiChatResult
export type AiRewriteResult = z.infer<typeof AiRewriteResult>

/**
 * What `ai:critique` answers (F-14.8): the editor's notes, every one citing a passage main
 * located in the scene text it sent (`dropped` counts the notes whose quote was not found, so
 * uncited praise never reaches the author), whether the scene was head-truncated, what it
 * cost, and the proposal it became (F-14.5); or an expected AI failure as data.
 */
export const AiCritiqueResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    notes: CritiqueNotes,
    truncated: z.boolean(),
    dropped: z.number().int().nonnegative(),
    usage: AiUsage,
    costUsd: z.number(),
    cached: z.boolean(),
    model: z.string(),
    proposalId: z.string(),
    requestId: z.string()
  }),
  z.object({
    ok: z.literal(false),
    code: AiErrorCode,
    message: z.string(),
    nextStep: z.string(),
    requestId: z.string()
  })
])
export type AiCritiqueResult = z.infer<typeof AiCritiqueResult>

/**
 * What `ai:betaReader` answers (F-14.11): the reader's report, every item citing a passage main
 * found in the scene it names (`dropped` counts the items whose quote or scene number did not
 * hold up), the scenes the reader read in the order sent (the current one last, for the panel's
 * citation labels), whether the scene was cut (`truncated`), how many of the farthest earlier
 * scenes were left out to fit the budget (`skipped`), how many earlier scenes had no stored
 * summary to read (`missing`), what it cost, and the proposal it became (F-14.5); or an
 * expected AI failure as data.
 */
export const AiBetaReaderResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    items: BetaReaderItems,
    scenes: z.array(BetaReaderScene),
    truncated: z.boolean(),
    skipped: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    usage: AiUsage,
    costUsd: z.number(),
    cached: z.boolean(),
    model: z.string(),
    proposalId: z.string(),
    requestId: z.string()
  }),
  z.object({
    ok: z.literal(false),
    code: AiErrorCode,
    message: z.string(),
    nextStep: z.string(),
    requestId: z.string()
  })
])
export type AiBetaReaderResult = z.infer<typeof AiBetaReaderResult>

/**
 * What `ai:draftBrief` answers (F-14.3): the five brief lines the model drafted from the scene
 * (an empty string where the scene does not show one), whether the scene was head-truncated,
 * what it cost, and the proposal it became (F-14.5); or an expected AI failure as data.
 * Nothing is stored: the renderer fills the fields only when the author clicks Use draft.
 */
export const AiDraftBriefResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    brief: SceneBrief,
    truncated: z.boolean(),
    usage: AiUsage,
    costUsd: z.number(),
    cached: z.boolean(),
    model: z.string(),
    proposalId: z.string(),
    requestId: z.string()
  }),
  z.object({
    ok: z.literal(false),
    code: AiErrorCode,
    message: z.string(),
    nextStep: z.string(),
    requestId: z.string()
  })
])
export type AiDraftBriefResult = z.infer<typeof AiDraftBriefResult>

/**
 * What `ai:summarize` answers (F-5.6): the node's summary state after the run (the stored row,
 * fresh or served from the content-hash match), what the run cost; or an expected AI failure
 * as data. A summary is not a proposal: it is derived index data with no accept step.
 */
export const AiSummarizeResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    state: SceneSummaryState,
    usage: AiUsage,
    costUsd: z.number(),
    cached: z.boolean(),
    model: z.string(),
    requestId: z.string()
  }),
  z.object({
    ok: z.literal(false),
    code: AiErrorCode,
    message: z.string(),
    nextStep: z.string(),
    requestId: z.string()
  })
])
export type AiSummarizeResult = z.infer<typeof AiSummarizeResult>

/**
 * What `jobs:indexAll` answers (F-5.13): how many scenes were queued for a summary (0 when
 * every scene is already current) and the queue as it stands right after; or the expected AI
 * failure as data, which is how a turned-off Scene summaries feature comes back.
 */
export const JobsIndexAllResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    queued: z.number().int().nonnegative(),
    status: IndexQueueStatus
  }),
  z.object({
    ok: z.literal(false),
    code: AiErrorCode,
    message: z.string(),
    nextStep: z.string()
  })
])
export type JobsIndexAllResult = z.infer<typeof JobsIndexAllResult>

/** An author-marked voice exemplar (F-14.1): a plain-text passage with the POV and kind it was filed under. */
export const VoiceExemplar = z.object({
  id: z.string(),
  /** The node it was marked in; null once that node is gone. */
  nodeId: z.string().nullable(),
  text: z.string(),
  pov: z.string().nullable(),
  kind: VoiceExemplarKind,
  created: z.string()
})
export type VoiceExemplar = z.infer<typeof VoiceExemplar>

/**
 * The voice profile (F-14.1) as `voice:profile` answers it: the plain-language rules a prompt
 * carries, the stylometrics behind them, every exemplar (POV-matching first when a POV was
 * asked for), the confidence, the words of manuscript the profile was built from, and the
 * author's rules (F-14.2).
 */
export const VoiceProfile = z.object({
  rules: z.array(z.string()),
  stats: Stylometrics,
  exemplars: z.array(VoiceExemplar),
  confidence: z.number().min(0).max(1),
  wordCount: z.number().int().nonnegative(),
  /** The author's rules and banned phrases (F-14.2), the profile's third source. */
  authorRules: AuthorRules
})
export type VoiceProfile = z.infer<typeof VoiceProfile>

/** One manuscript document in the voice consistency report (F-14.7): `short` under 200 words (not scored), `drift` with violations, else `ok`. */
export const VoiceConsistencyStatus = z.enum(['ok', 'drift', 'short'])
export type VoiceConsistencyStatus = z.infer<typeof VoiceConsistencyStatus>

/**
 * The whole-manuscript voice consistency report (F-14.7) as `voice:consistencyReport` answers
 * it: every manuscript document in tree order, scored locally against the profile's
 * stylometrics, with each violation as a report line.
 */
export const VoiceConsistencyReport = z.object({
  /** The words the profile was built from. */
  profileWordCount: z.number().int().nonnegative(),
  documents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      wordCount: z.number().int().nonnegative(),
      status: VoiceConsistencyStatus,
      violations: z.array(z.string())
    })
  )
})
export type VoiceConsistencyReport = z.infer<typeof VoiceConsistencyReport>

/**
 * The provenance ledger (F-14.6) as `provenance:report` answers it: how much of the manuscript
 * carries the `aiOrigin` mark, counted in characters of text (`src/shared/provenance.ts` is the
 * one owner of the counting), per manuscript document in tree order and for the project.
 */
export const ProvenanceReport = z.object({
  /** `aiChars / totalChars` of the whole manuscript as a whole percent; 0 for an empty one. */
  projectPercent: z.number().int().min(0).max(100),
  aiChars: z.number().int().nonnegative(),
  totalChars: z.number().int().nonnegative(),
  documents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      aiChars: z.number().int().nonnegative(),
      totalChars: z.number().int().nonnegative(),
      percent: z.number().int().min(0).max(100),
      /** Distinct proposals with text still marked in this document. */
      proposals: z.number().int().nonnegative()
    })
  )
})
export type ProvenanceReport = z.infer<typeof ProvenanceReport>

export const contract = {
  'app:info': {
    input: z.undefined(),
    output: z.object({ version: z.string(), platform: z.string() })
  },
  'project:create': {
    input: z.object({
      name: z.string().trim().min(1).max(PROJECT_NAME_MAX),
      format: NovelFormat,
      /** When omitted, main shows a native save dialog. */
      directory: z.string().optional(),
      /** Where the new project's AI requests go (F-15.11, the wizard's third step); omitted keeps the `ownKey` default. */
      aiSource: AiSource.optional()
    }),
    output: ProjectInfo.nullable()
  },
  'project:open': {
    input: z.object({
      /** When omitted, main shows a native open dialog. */
      path: z.string().optional()
    }),
    output: ProjectInfo.nullable()
  },
  'project:close': { input: z.undefined(), output: z.null() },
  'project:current': { input: z.undefined(), output: ProjectInfo.nullable() },
  'recents:list': { input: z.undefined(), output: z.array(RecentProject) },
  'recents:remove': { input: z.object({ path: z.string() }), output: z.array(RecentProject) },
  'tree:list': { input: z.undefined(), output: z.array(TreeNode) },
  'tree:create': {
    input: z.object({
      parentId: z.string(),
      kind: NodeKind,
      hierarchyLevel: HierarchyLevel.nullable(),
      /** Omitted → main fills in "Untitled <level|kind>" from the project's format. */
      title: z.string().trim().min(1).max(NODE_TITLE_MAX).optional(),
      /** Omitted → append as the parent's last child. */
      afterId: z.string().optional(),
      /**
       * Fills the document from a front/end matter template (F-2.6): title (unless `title` is
       * given), content, cached word count, and `matterType`. Only for `kind: 'document'` under
       * the template's own section; anything else is refused with VALIDATION.
       */
      template: MatterTemplateId.optional()
    }),
    output: TreeNode
  },
  'tree:rename': {
    input: z.object({ id: z.string(), title: z.string().trim().min(1).max(NODE_TITLE_MAX) }),
    output: TreeNode
  },
  /** Copies a node and its subtree right after the original (F-2.3): the copy's root first, then its descendants. */
  'tree:duplicate': { input: z.object({ id: z.string() }), output: z.array(TreeNode) },
  /** Deletes a node and everything inside it (F-2.3); later siblings close the gap. */
  'tree:delete': { input: z.object({ id: z.string() }), output: z.null() },
  /**
   * Moves a node (with its subtree) under `parentId` within the same section (F-2.4). Old siblings
   * close the gap, new siblings make room. Returns the moved row.
   */
  'tree:move': {
    input: z.object({
      id: z.string(),
      parentId: z.string(),
      /** Omitted → append as the parent's last child; null → insert first; id → after that sibling. */
      afterId: z.string().nullable().optional()
    }),
    output: TreeNode
  },
  /**
   * The Tiptap JSON of one document (F-3.1); `content` is null until something is written to it.
   * Folders and sections are refused with VALIDATION. `document:save` is the write path.
   */
  'document:get': {
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string(), content: TiptapNode.nullable() })
  },
  /**
   * Replaces a document's content (F-3.2) and caches its word count on the row. Folders and
   * sections are refused with VALIDATION. Returns the new count and the row's `modified` stamp.
   */
  'document:save': {
    input: z.object({ id: z.string(), content: TiptapNode }),
    output: z.object({ wordCount: z.number().int().nonnegative(), modified: z.string() })
  },
  /**
   * The Tiptap JSON of a node's notes (F-3.7); `notes` is null until something is written.
   * Documents and folders both have notes; section roots are refused with VALIDATION.
   * `notes:save` is the write path.
   */
  'notes:get': {
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string(), notes: TiptapNode.nullable() })
  },
  /** Replaces a node's notes (F-3.7) and stamps the row's `modified`. Same refusals as `notes:get`. */
  'notes:save': {
    input: z.object({ id: z.string(), notes: TiptapNode }),
    output: z.object({ modified: z.string() })
  },
  /**
   * A node's scene metadata (F-4.5): location, POV, and timeline position; empty strings until
   * something is written. Documents and folders both qualify (scenes, chapters, parts); section
   * roots are refused with VALIDATION. `sceneMeta:set` is the write path.
   */
  'sceneMeta:get': {
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string(), meta: SceneMeta })
  },
  /** Replaces a node's scene metadata (F-4.5) and stamps the row's `modified`. Same refusals as `sceneMeta:get`. */
  'sceneMeta:set': {
    input: z.object({ id: z.string(), meta: SceneMeta }),
    output: z.object({ modified: z.string() })
  },
  /**
   * The project's editor formatting (F-3.6). A missing or unreadable row answers with the
   * format's defaults, so the editor always has something to apply.
   */
  'editorSettings:get': { input: z.undefined(), output: EditorSettings },
  /** Replaces the project's editor formatting (F-3.6); out-of-range values are refused with VALIDATION. */
  'editorSettings:set': { input: EditorSettings, output: EditorSettings },
  /** The project's AI dial and per-feature toggles (F-14.4); a missing or unreadable row answers with the defaults (dial Off). */
  'aiSettings:get': { input: z.undefined(), output: AiSettings },
  /** Replaces the project's AI settings (F-14.4); a value outside the schema is refused with VALIDATION. */
  'aiSettings:set': { input: AiSettings, output: AiSettings },
  /** The project's writing presets (F-5.2); a missing or unreadable row answers with the defaults (General). */
  'presets:get': { input: z.undefined(), output: WritingPresets },
  /** Replaces the project's writing presets (F-5.2); a value outside the schema is refused with VALIDATION. */
  'presets:set': { input: WritingPresets, output: WritingPresets },
  /** The project's focus-mode settings (F-6.2); a missing or unreadable row answers with the defaults (no background). */
  'focusSettings:get': { input: z.undefined(), output: FocusSettings },
  /** Replaces the project's focus-mode settings (F-6.2); a value outside the schema is refused with VALIDATION. */
  'focusSettings:set': { input: FocusSettings, output: FocusSettings },
  /** The author's rules and banned phrases (F-14.2); a missing or unreadable row answers with the defaults (no rules, the seeded phrases). */
  'authorRules:get': { input: z.undefined(), output: AuthorRules },
  /** Replaces the author's rules (F-14.2); phrases are normalised and deduplicated, a value outside the schema is refused with VALIDATION. */
  'authorRules:set': { input: AuthorRules, output: AuthorRules },
  /** Every focus-mode background of the open project (F-6.2): the files in `assets/backgrounds/`, by name. */
  'background:list': { input: z.undefined(), output: z.array(Background) },
  /**
   * Opens the OS file dialog (multi-select) and copies each chosen image into the project's
   * `assets/backgrounds/` under a minted id (F-6.2). A file that is not an allowed image type
   * or is over `BACKGROUND_MAX_BYTES` is skipped and named in `skipped`; null when cancelled.
   */
  'background:add': {
    input: z.undefined(),
    output: z.object({ added: z.array(Background), skipped: z.array(z.string()) }).nullable()
  },
  /** Deletes a background's file (F-6.2) and clears `backgroundId` when it was the current one; NOT_FOUND for an unknown id. */
  'background:remove': { input: z.object({ id: z.string() }), output: z.null() },
  /** Every tag of the open project (F-4.1), ordered by name. */
  'tag:list': { input: z.undefined(), output: z.array(Tag) },
  /**
   * Creates a tag (F-4.1). The name is kebab-cased (`toTagName`); a name that empties or collides
   * after normalization is refused with VALIDATION or ALREADY_EXISTS. A missing parent is NOT_FOUND.
   */
  'tag:create': {
    input: z.object({
      name: z.string().trim().min(1).max(TAG_NAME_MAX),
      category: TagCategory,
      /** Omitted → the category's default color. */
      color: z.string().regex(HEX_COLOR).optional(),
      parentId: z.string().nullable().optional()
    }),
    output: Tag
  },
  /**
   * Patches the given fields of a tag (F-4.1); omitted fields keep their value. Same refusals as
   * `tag:create`, plus VALIDATION for a parent that is the tag itself or one of its descendants.
   */
  'tag:update': {
    input: z.object({
      id: z.string(),
      name: z.string().trim().min(1).max(TAG_NAME_MAX).optional(),
      category: TagCategory.optional(),
      color: z.string().regex(HEX_COLOR).optional(),
      parentId: z.string().nullable().optional()
    }),
    output: Tag
  },
  /** Deletes a tag (F-4.1): its document links go with it, its child tags become top-level. */
  'tag:delete': { input: z.object({ id: z.string() }), output: z.null() },
  /**
   * Loads a tag template (F-4.3): creates every template tag whose normalized name is not already
   * in the bank, using the category's default color; existing names are skipped, not overwritten.
   */
  'tag:loadTemplate': {
    input: z.object({ template: TagTemplateId }),
    output: z.object({ created: z.array(Tag), skipped: z.array(z.string()) })
  },
  /**
   * The tags linked to a node (F-4.4), ordered by name. Documents and folders both carry tags
   * (the bar mounts on a chapter or part in the stacked view, F-4.5); NOT_FOUND for an unknown
   * node id, VALIDATION for a section root.
   */
  'documentTag:list': { input: z.object({ nodeId: z.string() }), output: z.array(Tag) },
  /**
   * Links a tag to a node (F-4.4); linking an already-linked tag is a no-op. Returns the tag
   * with its usage count after the link. Same refusals as `documentTag:list`, plus NOT_FOUND for
   * an unknown tag id.
   */
  'documentTag:add': {
    input: z.object({ nodeId: z.string(), tagId: z.string() }),
    output: Tag
  },
  /**
   * Removes a link (F-4.4); removing a link that is already gone is a no-op. Returns the tag with
   * its usage count after the removal. Same refusals as `documentTag:add`.
   */
  'documentTag:remove': {
    input: z.object({ nodeId: z.string(), tagId: z.string() }),
    output: Tag
  },
  /**
   * Every node ↔ tag link in the project (F-4.10), ordered by node id then tag name: what the
   * tree filter and the Tag Manager's document list read in one request. A project-wide read,
   * so it takes no node and refuses nothing but a closed project.
   */
  'documentTag:listAll': {
    input: z.undefined(),
    output: z.array(z.object({ nodeId: z.string(), tagId: z.string() }))
  },
  /** The app-wide panel layout (F-7.2) from app-state.json; the defaults until one has been saved. */
  'layout:get': { input: z.undefined(), output: Layout },
  /** Replaces the panel layout (F-7.2); sizes outside the panel limits are refused with VALIDATION. */
  'layout:set': { input: Layout, output: Layout },
  /**
   * The MythScribe account (F-15.2): signed out, waiting for a sign-in link to be opened, or
   * signed in. App-wide, no project needed; the session token never crosses IPC.
   */
  'account:getStatus': { input: z.undefined(), output: AccountStatus },
  /**
   * Asks the Cloud Worker to email a sign-in link (F-15.2) and starts polling for its approval;
   * answers the pending status. A malformed address is VALIDATION; no network, a rate limit, or a
   * Worker without a mail transport is IO with the cause and the next step in the message.
   */
  'account:requestLink': {
    input: z.object({ email: z.string().trim().min(1).max(EMAIL_MAX) }),
    output: AccountStatus
  },
  /** Stops waiting for the link (F-15.2); the link itself stays valid until it expires. Signed out afterwards. */
  'account:cancelLink': { input: z.undefined(), output: AccountStatus },
  /** Revokes the session on the Worker when reachable and forgets it locally either way (F-15.2). */
  'account:signOut': { input: z.undefined(), output: AccountStatus },
  /**
   * Re-checks a stored session with the Worker (F-15.2): fills `since`; a revoked or expired
   * session becomes signedOut. Unreachable network leaves the status as it is and is IO.
   */
  'account:refresh': { input: z.undefined(), output: AccountStatus },
  /**
   * The signed-in account's Cloud credits (F-15.3): balance, spend per feature, and the packs on
   * sale. IO when signed out or the Worker is unreachable; a session the Worker no longer
   * accepts signs out (pushed as `account:changed`) and is IO too.
   */
  'account:getCredits': { input: z.undefined(), output: CreditsResult },
  /**
   * Buys a credit pack (F-15.3): asks the Worker for the Lemon Squeezy checkout URL for this
   * account and opens it in the default browser. An unknown pack or a URL off Lemon Squeezy is
   * VALIDATION; signed out or unreachable is IO.
   */
  'account:buyCredits': { input: CheckoutBody, output: z.null() },
  /**
   * The Supporter license (F-15.9) from the local cache: licensed or not, when the Worker last
   * confirmed it, how long the cached token is trusted without the network, the product on sale,
   * and the chosen accent. Never touches the network; app-wide, no project or sign-in needed.
   */
  'account:getSupporter': { input: z.undefined(), output: SupporterStatus },
  /**
   * Asks the Worker for a fresh license token (F-15.9) and answers the updated status. Signed
   * out is IO; an unreachable Worker leaves the cached token in place and is IO too; a session
   * the Worker no longer accepts signs out (pushed as `account:changed`).
   */
  'account:refreshSupporter': { input: z.undefined(), output: SupporterStatus },
  /**
   * Buys the Supporter license (F-15.9): the Lemon Squeezy checkout URL for this account, opened
   * in the default browser. Not on sale is VALIDATION; signed out or unreachable is IO.
   */
  'account:buySupporter': { input: z.undefined(), output: z.null() },
  /** Picks the UI accent (F-15.9). Anything but `default` needs the license: VALIDATION otherwise. */
  'account:setAccent': { input: z.object({ accent: AccentId }), output: SupporterStatus },
  /**
   * Where the app stands on updates (F-15.7): the running version, the channel, whether it
   * checks by itself, what the updater is doing, and the notes of the last download. App-wide,
   * no project needed; a development build answers the `unsupported` status with its reason.
   */
  'updates:getState': { input: z.undefined(), output: UpdateState },
  /**
   * Asks the release feed now (F-15.7). Answers the state the check left behind; a check or a
   * download already running answers the state as it stands rather than starting a second one.
   * An unreachable feed is the `error` status with its next step, not a failed call.
   */
  'updates:check': { input: z.undefined(), output: UpdateState },
  /**
   * Switches between the stable and beta channels (F-15.7), stores it, and checks again, so the
   * answer belongs to the channel just picked. Nothing is downgraded: a beta build stays until a
   * newer stable one ships.
   */
  'updates:setChannel': { input: z.object({ channel: UpdateChannel }), output: UpdateState },
  /** Turns the automatic check on or off (F-15.7); the manual check works either way. */
  'updates:setAutoCheck': { input: z.object({ on: z.boolean() }), output: UpdateState },
  /** The author has read what is new in the running version (F-15.7); it is not offered again. */
  'updates:markSeen': { input: z.undefined(), output: UpdateState },
  /**
   * Restarts into the downloaded update (F-15.7). VALIDATION with nothing downloaded, and with
   * a project still open: the installer starts before this process exits, so the renderer
   * closes the project (flushing its saves) first.
   */
  'updates:install': { input: z.undefined(), output: z.null() },
  /**
   * Where diagnostics stand (F-15.8): whether they are on (off on every install), the next
   * report verbatim so the author can read exactly what would be sent, and the last day one
   * left the machine. App-wide, no project needed.
   */
  'diagnostics:getState': { input: z.undefined(), output: DiagnosticsState },
  /**
   * Turns diagnostics on or off (F-15.8). Off throws away everything recorded so far; on starts
   * from nothing, so a report can never carry something from before the author agreed.
   */
  'diagnostics:setEnabled': { input: z.object({ on: z.boolean() }), output: DiagnosticsState },
  /**
   * A renderer error or unhandled rejection (F-15.8). Queued as a crash report while
   * diagnostics are on and dropped while they are off; main scrubs the message and the stack
   * again, so what the renderer sends is never what is stored.
   */
  'diagnostics:reportRendererError': {
    input: z.object({
      name: z.string().max(RENDERER_ERROR_NAME_MAX),
      message: z.string().max(RENDERER_ERROR_MESSAGE_MAX),
      stack: z.string().max(RENDERER_ERROR_STACK_MAX).nullable()
    }),
    output: z.null()
  },
  /**
   * The AI provider status (F-5.1): whether a key is saved (with a masked hint, never the key)
   * and how the key is protected. App-wide, no project needed.
   */
  'ai:getStatus': { input: z.undefined(), output: AiStatus },
  /**
   * Stores the key with the OS safe storage (F-5.1); the key is accepted once and never returned.
   * A shape outside the length bounds is VALIDATION; a machine that cannot protect the key is IO.
   */
  'ai:setKey': {
    input: z.object({ key: z.string().trim().min(AI_KEY_MIN).max(AI_KEY_MAX) }),
    output: AiStatus
  },
  /** Forgets the stored key (F-5.1); a no-op when none is saved. */
  'ai:clearKey': { input: z.undefined(), output: AiStatus },
  /**
   * Asks the provider a token-free question with the saved key (F-5.1). Expected failures (no
   * key, invalid key, rate limit, quota, network, provider) come back as data with a next step,
   * so the AI tab can show them inline; only an unexpected failure is an error.
   */
  'ai:testConnection': { input: z.undefined(), output: AiTestConnectionResult },
  /**
   * Replaces the tier → model mapping for a provider (F-5.11); the provider reads it live, so
   * the next request uses it. An empty or over-long model id is VALIDATION.
   */
  'ai:setModels': {
    input: z.object({ provider: AiProviderId, models: AiModelMap }),
    output: AiStatus
  },
  /**
   * The AI spend (F-5.14): today's tally and the cap are app-wide, the totals and the
   * per-feature list are the open project's ledger. NO_PROJECT without one.
   */
  'ai:usageSummary': { input: z.undefined(), output: AiUsageSummary },
  /** Replaces the app-wide daily spend cap (F-5.14); outside 0–500 USD is VALIDATION. */
  'ai:setDailyCap': { input: z.object({ dailyCapUsd: DailyCapUsd }), output: AiUsageSummary },
  /**
   * Asks the AI for tags from the bank that fit a document's text (F-4.7); nothing is linked
   * until the author accepts a suggestion. NOT_FOUND for an unknown id, VALIDATION for a folder
   * or a document under `TAGS_MIN_CHARS` of text; the AI failures (no key, dial, budget, ...)
   * come back as data with a next step so the tag bar shows them inline. A regenerate
   * (F-14.5) names the proposal it replaces in `regeneratedFrom` and may carry the author's
   * `note` on what was off; both reach the model through `tagsRegen.v1`.
   */
  'ai:recommendTags': {
    input: z.object({
      nodeId: z.string(),
      note: z.string().max(PROPOSAL_NOTE_MAX).nullable().optional(),
      regeneratedFrom: z.string().nullable().optional(),
      /** F-5.10: lets `ai:cancel` find the request; without one it cannot be stopped. */
      requestId: z.string().optional()
    }),
    output: AiRecommendTagsResult
  },
  /**
   * Stops an in-flight AI request by the `requestId` its caller minted (F-5.10). The request's
   * own reply comes back as the `CANCELLED` failure; `cancelled` is false when nothing by that
   * id is in flight (already finished, or never started).
   */
  'ai:cancel': {
    input: z.object({ requestId: z.string() }),
    output: z.object({ cancelled: z.boolean() })
  },
  /**
   * Asks the AI to continue the passage at the caret (F-5.3, VibeWrite): the text before and
   * after the caret (bounded; over the bound is VALIDATION) plus the document's notes and
   * metadata, read in main. Nothing is inserted: the renderer shows the answer as ghost text
   * until the author accepts it. NOT_FOUND for an unknown id; the AI failures (dial, no key,
   * budget, ...) come back as data with a next step and the echoed `requestId`.
   */
  'ai:ghostText': {
    input: z.object({
      nodeId: z.string(),
      before: z.string().max(GHOST_BEFORE_CHARS),
      after: z.string().max(GHOST_AFTER_CHARS),
      requestId: z.string()
    }),
    output: AiGhostTextResult
  },
  /**
   * One assistant turn (F-5.4). `nodeId` is the active document whose text rides along (null
   * with no document open); `history` is the recent turns the renderer keeps; Plan mode streams
   * `ai:chatDelta` events for `requestId` before resolving, Agent mode resolves with the text
   * the renderer places as ghost text. Expected AI failures come back as data.
   */
  'ai:chat': {
    input: z.object({
      nodeId: z.string().nullable(),
      mode: ChatMode,
      paragraphs: z.number().int().min(CHAT_PARAGRAPHS_MIN).max(CHAT_PARAGRAPHS_MAX),
      message: z.string().trim().min(1).max(CHAT_MESSAGE_MAX),
      history: z
        .array(z.object({ role: ChatRole, content: z.string().max(CHAT_MESSAGE_MAX) }))
        .max(CHAT_HISTORY_TURNS),
      requestId: z.string()
    }),
    output: AiChatResult
  },
  /**
   * One Story Intelligence turn (F-5.7). `nodeId` is the active document (null with none open;
   * it breaks ranking ties and is the fallback candidate); `history` is the recent turns of the
   * conversation; the answer is JSON on the strong tier and is not streamed. Expected AI
   * failures come back as data.
   */
  'ai:query': {
    input: z.object({
      nodeId: z.string().nullable(),
      message: z.string().trim().min(1).max(CHAT_MESSAGE_MAX),
      history: z
        .array(z.object({ role: ChatRole, content: z.string().max(CHAT_MESSAGE_MAX) }))
        .max(CHAT_HISTORY_TURNS),
      requestId: z.string()
    }),
    output: AiQueryResult
  },
  /**
   * Rewrites a selected passage in the author's voice (F-14.10). The renderer sends the
   * selection as plain text (bounded; outside the bounds is VALIDATION) with up to
   * `REWRITE_CONTEXT_CHARS` of manuscript text each side and the ProseMirror range it came
   * from (recorded on the proposal as its target, a snapshot); main adds the scene metadata
   * and the voice profile. The first draft streams as `ai:rewriteDelta` events for
   * `requestId`; the answer resolves once the fidelity check (and its one regenerate) is done.
   * Nothing is replaced: the renderer shows a diff until the author accepts. A regenerate
   * (F-14.5) names the proposal it replaces in `regeneratedFrom` and may carry the author's
   * `note`. NOT_FOUND for an unknown id, VALIDATION for a folder; the AI failures come back as
   * data with the echoed `requestId`.
   */
  'ai:rewrite': {
    input: z.object({
      nodeId: z.string(),
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      text: z.string().min(REWRITE_TEXT_MIN).max(REWRITE_TEXT_MAX),
      before: z.string().max(REWRITE_CONTEXT_CHARS),
      after: z.string().max(REWRITE_CONTEXT_CHARS),
      requestId: z.string(),
      note: z.string().max(PROPOSAL_NOTE_MAX).nullable().optional(),
      regeneratedFrom: z.string().nullable().optional()
    }),
    output: AiRewriteResult
  },
  /**
   * Editor's notes on one scene (F-14.8). The renderer sends only the node; main reads the
   * document (head-truncated to `CRITIQUE_SCENE_CHAR_BUDGET`), its notes and metadata as the
   * brief, the honesty setting, and the voice profile, asks the strong tier for JSON, and
   * drops every note whose quote it cannot find in the text it sent. Nothing is changed: each
   * fix is applied by the renderer only when the author clicks Apply. A regenerate (F-14.5)
   * names the proposal it replaces in `regeneratedFrom` and may carry the author's `note`.
   * NOT_FOUND for an unknown id, VALIDATION for a folder or a document under
   * `CRITIQUE_TEXT_MIN` characters; the AI failures come back as data with the echoed
   * `requestId`.
   */
  'ai:critique': {
    input: z.object({
      nodeId: z.string(),
      requestId: z.string(),
      note: z.string().max(PROPOSAL_NOTE_MAX).nullable().optional(),
      regeneratedFrom: z.string().nullable().optional()
    }),
    output: AiCritiqueResult
  },
  /**
   * The beta-reader read-through up to a scene (F-14.11). The renderer sends only the node;
   * main reads every manuscript document before it in reading order through its stored
   * summary and key points (F-5.6; one without a summary is counted in `missing`), the scene
   * itself head-truncated to `BETA_READER_SCENE_CHAR_BUDGET`, and the honesty setting, asks
   * the strong tier for JSON, and drops every item whose quote it cannot find in the scene the
   * item names. Nothing is changed and nothing is applied: a reader reports. A regenerate
   * (F-14.5) names the proposal it replaces in `regeneratedFrom` and may carry the author's
   * `note`. NOT_FOUND for an unknown id, VALIDATION for a node that is not a manuscript
   * document or holds under `BETA_READER_TEXT_MIN` characters; the AI failures come back as
   * data with the echoed `requestId`.
   */
  'ai:betaReader': {
    input: z.object({
      nodeId: z.string(),
      requestId: z.string(),
      note: z.string().max(PROPOSAL_NOTE_MAX).nullable().optional(),
      regeneratedFrom: z.string().nullable().optional()
    }),
    output: AiBetaReaderResult
  },
  /**
   * Drafts a scene's brief from its text (F-14.3). The renderer sends only the node; main reads
   * the document (head-truncated to `BRIEF_SCENE_CHAR_BUDGET`) and its metadata, asks the fast
   * tier for JSON, and answers the five lines. Nothing is stored: the metadata pane fills the
   * fields only on Use draft, through `sceneMeta:set`. NOT_FOUND for an unknown id, VALIDATION
   * for a folder or a document under `BRIEF_TEXT_MIN` characters; the AI failures come back as
   * data with the echoed `requestId`.
   */
  'ai:draftBrief': {
    input: z.object({ nodeId: z.string(), requestId: z.string() }),
    output: AiDraftBriefResult
  },
  /**
   * A node's scene summary state (F-5.6): the stored row (if any), whether it is stale against
   * the scene's current text, and the background scheduler's status and last error for the
   * node. `available` is false for anything that is not a manuscript document, an unknown id
   * included: to the pane both are "no summary here", never an error.
   */
  'summary:get': {
    input: z.object({ id: z.string() }),
    output: SceneSummaryState
  },
  /**
   * Summarises a manuscript document now (F-5.6): cancels its pending debounce, runs the
   * summary on the fast tier (a content-hash match answers from the stored row without a
   * request), stores the row, and answers the new state. VALIDATION for a node that is not a
   * manuscript document or holds under `SUMMARY_TEXT_MIN` characters; the AI failures come back
   * as data with the echoed `requestId`.
   */
  'ai:summarize': {
    input: z.object({ nodeId: z.string(), requestId: z.string() }),
    output: AiSummarizeResult
  },
  /** The index queue as it stands (F-5.13): what is waiting, running, failed, done, and why it is paused. */
  'jobs:status': { input: z.undefined(), output: IndexQueueStatus },
  /**
   * Stops indexing (F-5.13): aborts the job in flight, drops every queued and failed job with
   * the debounces that would re-queue them, and clears a pause. Answers the empty queue.
   */
  'jobs:cancel': { input: z.undefined(), output: IndexQueueStatus },
  /**
   * Tries again after a pause or a failure (F-5.13): clears the pause, puts every failed job
   * back in the queue with its attempts reset, and starts the worker.
   */
  'jobs:resume': { input: z.undefined(), output: IndexQueueStatus },
  /**
   * "Summarize all scenes" (F-5.13): queues a summary for every manuscript document long
   * enough to have one whose stored summary is missing, stale, or from an older prompt
   * version, and answers how many were queued. Gated like `ai:summarize`: a dial or toggle
   * that refuses comes back as the DISABLED failure, not an error.
   */
  'jobs:indexAll': { input: z.undefined(), output: JobsIndexAllResult },
  /** The project's conversations (F-5.4), stored as JSON under the settings key `conversations`; a fresh project has none. */
  'conversations:get': { input: z.undefined(), output: Conversations },
  /** Replaces the project's conversations (F-5.4); a value outside the schema is refused with VALIDATION. */
  'conversations:set': { input: Conversations, output: Conversations },
  /**
   * Records how the author settled a proposal (F-14.5): accepted, accepted in part, rejected,
   * or regenerated, with an optional note (a blank one is stored as none). Idempotent: only a
   * pending proposal changes; a second settlement or an evicted id is a silent no-op.
   */
  'proposal:settle': {
    input: z.object({
      id: z.string(),
      status: SettledStatus,
      note: z.string().max(PROPOSAL_NOTE_MAX).nullable().optional()
    }),
    output: z.null()
  },
  /** Every voice exemplar of the open project (F-14.1), oldest first. */
  'voice:listExemplars': { input: z.undefined(), output: z.array(VoiceExemplar) },
  /**
   * Marks a passage as a voice exemplar (F-14.1): the text is trimmed and bounded (outside the
   * bounds is VALIDATION), the POV comes from the node's scene metadata, the kind from
   * `classifyKind`. NOT_FOUND for an unknown node, VALIDATION for one that is not a document
   * or once the project holds `VOICE_EXEMPLAR_MAX` exemplars.
   */
  'voice:addExemplar': {
    input: z.object({
      nodeId: z.string(),
      text: z.string().trim().min(VOICE_EXEMPLAR_TEXT_MIN).max(VOICE_EXEMPLAR_TEXT_MAX)
    }),
    output: VoiceExemplar
  },
  /** Removes an exemplar (F-14.1); NOT_FOUND for an unknown id. */
  'voice:removeExemplar': { input: z.object({ id: z.string() }), output: z.null() },
  /**
   * The voice profile (F-14.1), built locally from the manuscript and the exemplars and cached
   * until something is saved. With `pov`, the stylometrics come from the documents whose scene
   * metadata names that POV when they hold at least 2,000 words, else from the whole manuscript.
   */
  'voice:profile': { input: z.object({ pov: z.string().optional() }), output: VoiceProfile },
  /**
   * The voice consistency report (F-14.7): every manuscript document scored locally against the
   * profile (built as `voice:profile` builds it, `pov` included), in tree order. On demand, never
   * cached, no AI call.
   */
  'voice:consistencyReport': {
    input: z.object({ pov: z.string().optional() }),
    output: VoiceConsistencyReport
  },
  /**
   * The provenance report (F-14.6): every manuscript document's AI-origin characters and the
   * project total, read from the saved documents (the renderer flushes first). Local, on
   * demand, no AI call.
   */
  'provenance:report': { input: z.undefined(), output: ProvenanceReport },
  /**
   * Writes the disclosure report (F-14.6) as Markdown where the author picks through a save
   * dialog (default `<Project>-ai-disclosure.md` beside the project folder) and answers the
   * path; null when the dialog is cancelled.
   */
  'provenance:export': { input: z.undefined(), output: z.object({ path: z.string() }).nullable() },
  /** Closes the project and every window once the renderer has flushed its pending saves. */
  'window:close': { input: z.undefined(), output: z.null() },
  /** The renderer could not flush, so the close it was asked for (and any quit behind it) is abandoned. */
  'window:close-cancelled': { input: z.undefined(), output: z.null() },
  /**
   * Focus mode (F-6.1): asks the window to enter or leave OS fullscreen and answers the state
   * the window reports afterwards, which is what the renderer shows (the window manager may
   * refuse or take its time; `window:fullScreenChanged` follows up).
   */
  'window:setFullScreen': {
    input: z.object({ on: z.boolean() }),
    output: z.object({ on: z.boolean() })
  },
  /**
   * Menu bar (F-7.1): an Edit item of the in-app bar runs the same `webContents` edit command
   * the native role does, on the focused window, so both bars edit whatever has the focus.
   */
  'menu:edit': { input: z.object({ role: EditRole }), output: z.null() },
  /**
   * Help › Documentation (F-7.1): opens the page in the default browser. Only `https` URLs on
   * mythscribe.app are accepted (`isAllowedExternalUrl`); anything else is VALIDATION.
   */
  'menu:openExternal': { input: z.object({ url: z.string() }), output: z.null() }
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>

export type Contract = typeof contract
export type Channel = keyof Contract
export type Input<C extends Channel> = z.input<Contract[C]['input']>
/** A channel's input after validation (defaults filled), which is what a main handler receives. */
export type ParsedInput<C extends Channel> = z.output<Contract[C]['input']>
export type Output<C extends Channel> = z.output<Contract[C]['output']>
export const channels = Object.keys(contract) as Channel[]

export type TreeCreateInput = Input<'tree:create'>
export type TreeMoveInput = Input<'tree:move'>
export type TagCreateInput = Input<'tag:create'>
export type TagUpdateInput = Input<'tag:update'>
export type TagLoadTemplateInput = Input<'tag:loadTemplate'>

/** Events pushed from main to the renderer. */
export const events = {
  'project:changed': ProjectInfo.nullable(),
  /** The OS asked to close the window while a project is open; the renderer flushes, then invokes `window:close`. */
  'window:close-requested': z.null(),
  /** A streamed piece of a Plan-mode answer (F-5.4); the renderer appends it to the turn with this `requestId`. */
  'ai:chatDelta': z.object({ requestId: z.string(), delta: z.string() }),
  /** A streamed piece of a rewrite's first draft (F-14.10); the panel appends it to the draft with this `requestId`. */
  'ai:rewriteDelta': z.object({ requestId: z.string(), delta: z.string() }),
  /** A node's background summary run changed status (F-5.6): pending → idle or failed; the pane refetches `summary:get`. */
  'ai:summaryChanged': z.object({ nodeId: z.string(), status: SummaryStatus }),
  /** The index queue changed (F-5.13): a job was queued, started, finished, failed, or the queue paused. */
  'jobs:changed': IndexQueueStatus,
  /** The window entered or left fullscreen (F-6.1), whoever asked: the OS, the window manager, or the app. */
  'window:fullScreenChanged': z.object({ on: z.boolean() }),
  /** A native menu item was clicked or its accelerator pressed (F-7.1); the renderer runs the action. */
  'menu:action': z.object({ id: MenuItemId }),
  /** The account state changed without a renderer call (F-15.2): a pending link was opened or expired. */
  'account:changed': AccountStatus,
  /** A Cloud request was answered and charged (F-15.5): the balance the Worker reported with it. */
  'account:balanceChanged': z.object({ balanceMicros: z.number().int() }),
  /** The Supporter license changed without a renderer call (F-15.9): a background refresh, a sign-in, or a sign-out. */
  'account:supporterChanged': SupporterStatus,
  /** The update state changed without a renderer call (F-15.7): a background check, a download, or a ready build. */
  'updates:changed': UpdateState,
  /** Diagnostics were switched, or a report was sent (F-15.8); the tab shows what is pending now. */
  'diagnostics:changed': DiagnosticsState
} as const satisfies Record<string, z.ZodType>

export type Events = typeof events
export type EventName = keyof Events
export type EventPayload<E extends EventName> = z.output<Events[E]>
export const eventNames = Object.keys(events) as EventName[]

export const IpcErrorCode = z.enum([
  'CANCELLED',
  'VALIDATION',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'NO_PROJECT',
  'IO',
  'INTERNAL'
])
export type IpcErrorCode = z.infer<typeof IpcErrorCode>

export const IpcError = z.object({
  code: IpcErrorCode,
  message: z.string(),
  details: z.unknown().optional()
})
export type IpcError = z.infer<typeof IpcError>

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

/** Shape of the bridge exposed on `window.mythscribe` by the preload script. */
export interface IpcBridge {
  invoke: (channel: Channel, input: unknown) => Promise<IpcResult<unknown>>
  on: (event: EventName, listener: (payload: unknown) => void) => () => void
}
