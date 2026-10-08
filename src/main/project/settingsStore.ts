import { eq } from 'drizzle-orm'
import {
  AI_SETTINGS_KEY,
  AiSettings,
  defaultAiSettings,
  type AiSettingsInput
} from '@shared/aiSettings'
import {
  AUTHOR_RULES_KEY,
  AuthorRules,
  defaultAuthorRules,
  type AuthorRulesInput
} from '@shared/authorRules'
import {
  BOOK_DETAILS_KEY,
  BookDetails,
  parseBookDetails,
  type BookDetailsInput
} from '@shared/bookDetails'
import {
  COMPILE_STATE_KEY,
  CompileProjectState,
  defaultCompileProjectState
} from '@shared/compileFormat'
import { CONVERSATIONS_KEY, Conversations, parseStoredConversations } from '@shared/chat'
import { DICTIONARY_KEY, ProjectDictionary, defaultProjectDictionary } from '@shared/dictionary'
import {
  EDITOR_SETTINGS_KEY,
  EditorSettings,
  defaultEditorSettings,
  type EditorSettingsInput
} from '@shared/editorSettings'
import {
  FOCUS_SETTINGS_KEY,
  FocusSettings,
  defaultFocusSettings,
  type FocusSettingsInput
} from '@shared/focus'
import { GOALS_KEY, Goals, defaultGoals } from '@shared/goals'
import { PLAN_LINKS_KEY, PlanLinkState, emptyPlanLinkState } from '@shared/planLinks'
import type { NovelFormat } from '@shared/ipc/contract'
import {
  OBSERVED_DISMISSED_KEY,
  ObservedDismissed,
  defaultObservedDismissed
} from '@shared/observedFacts'
import { WRITING_PRESETS_KEY, WritingPresets, defaultWritingPresets } from '@shared/presets'
import { DISMISSED_NAMES_KEY, DismissedNames, defaultDismissedNames } from '@shared/proposedTags'
import { KEPT_SPELLINGS_KEY, KEPT_SPELLINGS_MAX, KeptSpellings } from '@shared/misspellings'
import { REFERENCE_PINS_KEY, ReferencePins, defaultReferencePins } from '@shared/references'
import {
  SESSION_KEY,
  ProjectSession,
  parseStoredSession,
  type ProjectSessionInput
} from '@shared/session'
import { STRUCTURE_KEY, ProjectStructure, defaultProjectStructure } from '@shared/structure'
import { TAG_ALIASES_KEY, TagAliases } from '@shared/tagExchange'
import { TIMELINE_KEY, ProjectTimeline, defaultProjectTimeline } from '@shared/timeline'
import {
  VOICE_AUTO_KEY,
  VOICE_NOTES_KEY,
  VoiceAutoState,
  VoiceNotes,
  defaultVoiceAutoState
} from '@shared/voice'
import { settings } from '../db/schema'
import type { TreeDb } from '../tree/treeStore'

/**
 * Reads the project's editor formatting (F-3.6) from the `settings` row under
 * `EDITOR_SETTINGS_KEY`. A missing row, unparsable JSON, or a value that no longer fits the
 * schema all fall back to the format's defaults: formatting is never a reason the editor cannot
 * open. `seedSettings` writes the same defaults into a new project.
 */
export function getEditorSettings(db: TreeDb, format: NovelFormat): EditorSettings {
  const row = db.select().from(settings).where(eq(settings.key, EDITOR_SETTINGS_KEY)).get()
  if (!row) return defaultEditorSettings(format)
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultEditorSettings(format)
  }
  const parsed = EditorSettings.safeParse(json)
  return parsed.success ? parsed.data : defaultEditorSettings(format)
}

/** Replaces the project's editor formatting (upsert on the settings key) and returns what was stored. */
export function setEditorSettings(db: TreeDb, value: EditorSettingsInput): EditorSettings {
  const stored = EditorSettings.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: EDITOR_SETTINGS_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the project's AI dial and per-feature toggles (F-14.4) from the `settings` row under
 * `AI_SETTINGS_KEY`. A missing row, unparsable JSON, or a value that no longer fits the schema
 * all answer with `defaultAiSettings()` (dial Off): nothing is seeded at creation because the
 * defaults do not vary by format, and a refused row can never turn a feature on.
 */
export function getAiSettings(db: TreeDb): AiSettings {
  const row = db.select().from(settings).where(eq(settings.key, AI_SETTINGS_KEY)).get()
  if (!row) return defaultAiSettings()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultAiSettings()
  }
  const parsed = AiSettings.safeParse(json)
  return parsed.success ? parsed.data : defaultAiSettings()
}

/**
 * Replaces the project's AI settings (upsert on the settings key) and returns what was stored.
 * Takes the pre-parse shape so a caller without the F-5.3 `ghostText` block gets the default.
 */
export function setAiSettings(db: TreeDb, value: AiSettingsInput): AiSettings {
  const stored = AiSettings.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: AI_SETTINGS_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the project's writing presets (F-5.2) from the `settings` row under
 * `WRITING_PRESETS_KEY`. A missing row, unparsable JSON, or a value that no longer fits the
 * schema all answer with `defaultWritingPresets()` (General active, Custom a copy of General):
 * nothing is seeded at creation because the defaults do not vary by format.
 */
export function getWritingPresets(db: TreeDb): WritingPresets {
  const row = db.select().from(settings).where(eq(settings.key, WRITING_PRESETS_KEY)).get()
  if (!row) return defaultWritingPresets()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultWritingPresets()
  }
  const parsed = WritingPresets.safeParse(json)
  return parsed.success ? parsed.data : defaultWritingPresets()
}

/** Replaces the project's writing presets (upsert on the settings key) and returns what was stored. */
export function setWritingPresets(db: TreeDb, value: WritingPresets): WritingPresets {
  const stored = WritingPresets.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: WRITING_PRESETS_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the project's structure template choice (F-11.1b) from the `settings` row under
 * `STRUCTURE_KEY`. A missing row, unparsable JSON, or a value that no longer fits the schema all
 * answer with `defaultProjectStructure()` (no template); the beats themselves live in each node's
 * scene metadata, so a refused row loses no assignment.
 */
export function getProjectStructure(db: TreeDb): ProjectStructure {
  const row = db.select().from(settings).where(eq(settings.key, STRUCTURE_KEY)).get()
  if (!row) return defaultProjectStructure()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultProjectStructure()
  }
  const parsed = ProjectStructure.safeParse(json)
  return parsed.success ? parsed.data : defaultProjectStructure()
}

/** Replaces the project's structure template choice (upsert on the settings key) and returns what was stored. */
export function setProjectStructure(db: TreeDb, value: ProjectStructure): ProjectStructure {
  const stored = ProjectStructure.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: STRUCTURE_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the project's timeline events (F-11.2) from the `settings` row under `TIMELINE_KEY`. A
 * missing row, unparsable JSON, or a value that no longer fits the schema all answer with
 * `defaultProjectTimeline()` (no events): a linked scene then reads as unlinked and keeps its
 * text. `setProjectTimeline` (`timelineStore.ts`) is the write path, since it rewrites the
 * linked scenes too.
 */
export function getProjectTimeline(db: TreeDb): ProjectTimeline {
  const row = db.select().from(settings).where(eq(settings.key, TIMELINE_KEY)).get()
  if (!row) return defaultProjectTimeline()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultProjectTimeline()
  }
  const parsed = ProjectTimeline.safeParse(json)
  return parsed.success ? parsed.data : defaultProjectTimeline()
}

/**
 * Reads the project's assistant conversations (F-5.4) from the `settings` row under
 * `CONVERSATIONS_KEY`. A missing row, unparsable JSON, or a value that no longer fits the
 * schema all answer with `defaultConversations()` (no conversations): nothing is seeded at
 * creation, and a refused row can never resurrect a conversation the author did not keep.
 */
export function getConversations(db: TreeDb): Conversations {
  const row = db.select().from(settings).where(eq(settings.key, CONVERSATIONS_KEY)).get()
  if (!row) return parseStoredConversations(undefined)
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return parseStoredConversations(undefined)
  }
  return parseStoredConversations(json)
}

/** Replaces the project's conversations (upsert on the settings key) and returns what was stored. */
export function setConversations(db: TreeDb, value: Conversations): Conversations {
  const stored = Conversations.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: CONVERSATIONS_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the project's focus-mode settings (F-6.2) from the `settings` row under
 * `FOCUS_SETTINGS_KEY`. A missing row, unparsable JSON, or a value that no longer fits the
 * schema all answer with `defaultFocusSettings()` (no background): nothing is seeded at
 * creation, and a refused row only ever means a plain focus mode.
 */
export function getFocusSettings(db: TreeDb): FocusSettings {
  const row = db.select().from(settings).where(eq(settings.key, FOCUS_SETTINGS_KEY)).get()
  if (!row) return defaultFocusSettings()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultFocusSettings()
  }
  const parsed = FocusSettings.safeParse(json)
  return parsed.success ? parsed.data : defaultFocusSettings()
}

/**
 * Replaces the project's focus-mode settings (upsert on the settings key) and returns what was
 * stored. Takes the pre-parse shape so later fields default for an older caller.
 */
export function setFocusSettings(db: TreeDb, value: FocusSettingsInput): FocusSettings {
  const stored = FocusSettings.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: FOCUS_SETTINGS_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the project's session (F-1.7) from the `settings` row under `SESSION_KEY`. A missing
 * row or unparsable JSON answers with the defaults (nothing selected, nothing restored); a row
 * that no longer fits the schema is read leniently by `parseStoredSession`. Nothing is seeded:
 * a new project starts with no session.
 */
export function getProjectSession(db: TreeDb): ProjectSession {
  const row = db.select().from(settings).where(eq(settings.key, SESSION_KEY)).get()
  let json: unknown = null
  if (row) {
    try {
      json = JSON.parse(row.value)
    } catch {
      json = null
    }
  }
  return parseStoredSession(json)
}

/** Replaces the project's session (upsert on the settings key) and returns what was stored. */
export function setProjectSession(db: TreeDb, value: ProjectSessionInput): ProjectSession {
  const stored = ProjectSession.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: SESSION_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the project's author rules (F-14.2) from the `settings` row under `AUTHOR_RULES_KEY`.
 * A missing row, unparsable JSON, or a value that no longer fits the schema all answer with
 * `defaultAuthorRules()` (no rules text, the seeded AI-isms): nothing is written at creation,
 * so a fresh project carries the seeded banned phrases without a row, and removing a seeded
 * phrase is what stores the list.
 */
export function getAuthorRules(db: TreeDb): AuthorRules {
  const row = db.select().from(settings).where(eq(settings.key, AUTHOR_RULES_KEY)).get()
  if (!row) return defaultAuthorRules()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultAuthorRules()
  }
  const parsed = AuthorRules.safeParse(json)
  return parsed.success ? parsed.data : defaultAuthorRules()
}

/**
 * Replaces the project's author rules (upsert on the settings key) and returns what was
 * stored: the phrases normalised by the schema (trimmed, deduplicated, capped). Takes the
 * pre-parse shape, so a caller that sends only one of the two fields gets the other's default.
 */
export function setAuthorRules(db: TreeDb, value: AuthorRulesInput): AuthorRules {
  const stored = AuthorRules.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: AUTHOR_RULES_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the names the author dismissed as proposals (F-4.12b) from the `settings` row under
 * `DISMISSED_NAMES_KEY`. A missing row, unparsable JSON, or a value outside the schema all
 * answer with the empty list: a refused row can only ever propose a name again, never hide one
 * the author never dismissed.
 */
export function getDismissedNames(db: TreeDb): DismissedNames {
  const row = db.select().from(settings).where(eq(settings.key, DISMISSED_NAMES_KEY)).get()
  if (!row) return defaultDismissedNames()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultDismissedNames()
  }
  const parsed = DismissedNames.safeParse(json)
  return parsed.success ? parsed.data : defaultDismissedNames()
}

/** Replaces the dismissed proposals (F-4.12b; upsert on the settings key) and returns what was stored. */
export function setDismissedNames(db: TreeDb, value: DismissedNames): DismissedNames {
  const stored = DismissedNames.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: DISMISSED_NAMES_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the spellings the author kept (F-4.14, "Not a typo") from the `settings` row under
 * `KEPT_SPELLINGS_KEY`. A missing or unreadable row answers with none: the worst case is that a
 * spelling is offered for a fix again.
 */
export function getKeptSpellings(db: TreeDb): string[] {
  const row = db.select().from(settings).where(eq(settings.key, KEPT_SPELLINGS_KEY)).get()
  if (!row) return []
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return []
  }
  const parsed = KeptSpellings.safeParse(json)
  return parsed.success ? parsed.data.keys : []
}

/** Replaces the kept spellings (F-4.14), the newest `KEPT_SPELLINGS_MAX` kept, and returns them. */
export function setKeptSpellings(db: TreeDb, keys: readonly string[]): string[] {
  const kept = [...new Set(keys)].slice(-KEPT_SPELLINGS_MAX)
  const serialized = JSON.stringify({ keys: kept })
  db.insert(settings)
    .values({ key: KEPT_SPELLINGS_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return kept
}

/**
 * Reads the tag merge aliases (F-4.9) from the `settings` row under `TAG_ALIASES_KEY`. A missing
 * row, unparsable JSON, or a value outside the schema all answer with no aliases: a token of a
 * merged tag then falls back to its stored name, as for a deleted tag.
 */
export function getTagAliases(db: TreeDb): TagAliases {
  const row = db.select().from(settings).where(eq(settings.key, TAG_ALIASES_KEY)).get()
  if (!row) return {}
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return {}
  }
  const parsed = TagAliases.safeParse(json)
  return parsed.success ? parsed.data : {}
}

/** Replaces the tag merge aliases (F-4.9; upsert on the settings key) and returns what was stored. */
export function setTagAliases(db: TreeDb, value: TagAliases): TagAliases {
  const stored = TagAliases.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: TAG_ALIASES_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the quick reference panel's pins (F-9.6) from the `settings` row under
 * `REFERENCE_PINS_KEY`. A missing row, unparsable JSON, or a value outside the schema all answer
 * with no pins: an unreadable row can only ever empty the panel, never block the project.
 */
export function getReferencePins(db: TreeDb): ReferencePins {
  const row = db.select().from(settings).where(eq(settings.key, REFERENCE_PINS_KEY)).get()
  if (!row) return defaultReferencePins()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultReferencePins()
  }
  const parsed = ReferencePins.safeParse(json)
  return parsed.success ? parsed.data : defaultReferencePins()
}

/** Replaces the pins (F-9.6; upsert on the settings key) and returns what was stored. */
export function setReferencePins(db: TreeDb, value: ReferencePins): ReferencePins {
  const stored = ReferencePins.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: REFERENCE_PINS_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the entities the author deleted while the manuscript had facts about them (F-5.16) from
 * the `settings` row under `OBSERVED_DISMISSED_KEY`. A missing row, unparsable JSON, or a value
 * outside the schema all answer with the empty list: an unreadable row can only ever let the
 * story-bible job create an entity again, never keep one out the author did not delete.
 */
export function getObservedDismissed(db: TreeDb): ObservedDismissed {
  const row = db.select().from(settings).where(eq(settings.key, OBSERVED_DISMISSED_KEY)).get()
  if (!row) return defaultObservedDismissed()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultObservedDismissed()
  }
  const parsed = ObservedDismissed.safeParse(json)
  return parsed.success ? parsed.data : defaultObservedDismissed()
}

/** Replaces the deleted-entity names (F-5.16; upsert on the settings key) and returns what was stored. */
export function setObservedDismissed(db: TreeDb, value: ObservedDismissed): ObservedDismissed {
  const stored = ObservedDismissed.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: OBSERVED_DISMISSED_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the project's spelling dictionary (F-3.11) from the `settings` row under
 * `DICTIONARY_KEY`. A missing row, unparsable JSON, or a value outside the schema all answer
 * with no words: an unreadable row can only ever underline a word again, never block the project.
 */
export function getProjectDictionary(db: TreeDb): ProjectDictionary {
  const row = db.select().from(settings).where(eq(settings.key, DICTIONARY_KEY)).get()
  if (!row) return defaultProjectDictionary()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultProjectDictionary()
  }
  const parsed = ProjectDictionary.safeParse(json)
  return parsed.success ? parsed.data : defaultProjectDictionary()
}

/** Replaces the project's dictionary (F-3.11; upsert on the settings key) and returns what was stored. */
export function setProjectDictionary(db: TreeDb, value: ProjectDictionary): ProjectDictionary {
  const stored = ProjectDictionary.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: DICTIONARY_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the project's writing goals (F-10.3) from the `settings` row under `GOALS_KEY`. A
 * missing row, unparsable JSON, or a value outside the schema all answer with no targets: an
 * unreadable row can only ever hide a goal, never block the project.
 */
export function getGoals(db: TreeDb): Goals {
  const row = db.select().from(settings).where(eq(settings.key, GOALS_KEY)).get()
  if (!row) return defaultGoals()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultGoals()
  }
  const parsed = Goals.safeParse(json)
  return parsed.success ? parsed.data : defaultGoals()
}

/** Replaces the project's goals (F-10.3; upsert on the settings key) and returns what was stored. */
export function setGoals(db: TreeDb, value: Goals): Goals {
  const stored = Goals.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: GOALS_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the voice job's state (F-14.14) from the `settings` row under `VOICE_AUTO_KEY`. A
 * missing row, unparsable JSON, or a value outside the schema all answer with "never picked,
 * nothing removed": the next run then picks again, which is all an unreadable row can cost.
 */
export function getVoiceAutoState(db: TreeDb): VoiceAutoState {
  const row = db.select().from(settings).where(eq(settings.key, VOICE_AUTO_KEY)).get()
  if (!row) return defaultVoiceAutoState()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultVoiceAutoState()
  }
  const parsed = VoiceAutoState.safeParse(json)
  return parsed.success ? parsed.data : defaultVoiceAutoState()
}

/** Replaces the voice job's state (F-14.14; upsert on the settings key) and returns what was stored. */
export function setVoiceAutoState(db: TreeDb, value: VoiceAutoState): VoiceAutoState {
  const stored = VoiceAutoState.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: VOICE_AUTO_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the learned style notes (F-14.14) from the `settings` row under `VOICE_NOTES_KEY`; null
 * when there is no row or it cannot be read (the job then writes it afresh when due).
 */
export function getVoiceNotes(db: TreeDb): VoiceNotes | null {
  const row = db.select().from(settings).where(eq(settings.key, VOICE_NOTES_KEY)).get()
  if (!row) return null
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return null
  }
  const parsed = VoiceNotes.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** Replaces the learned style notes (F-14.14; upsert on the settings key) and returns what was stored. */
export function setVoiceNotes(db: TreeDb, value: VoiceNotes): VoiceNotes {
  const stored = VoiceNotes.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: VOICE_NOTES_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the project's Book details (Compile v2) from the `settings` row under `BOOK_DETAILS_KEY`.
 * A missing row, unparsable JSON, or a value outside the schema all answer with the defaults
 * (every field empty, language `en`): the book then compiles under the project's name.
 */
export function getBookDetails(db: TreeDb): BookDetails {
  const row = db.select().from(settings).where(eq(settings.key, BOOK_DETAILS_KEY)).get()
  if (!row) return parseBookDetails(undefined)
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return parseBookDetails(undefined)
  }
  return parseBookDetails(json)
}

/**
 * Replaces the project's Book details (upsert on the settings key) and returns what was stored.
 * Takes the pre-parse shape, so a caller that omits a field stores its default.
 */
export function setBookDetails(db: TreeDb, value: BookDetailsInput): BookDetails {
  const stored = BookDetails.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: BOOK_DETAILS_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the project's compile state (Compile v2: last format and output, the quick pick, the
 * "Include in compile" exclusions) from the `settings` row under `COMPILE_STATE_KEY`. A missing
 * row, unparsable JSON, or a value outside the schema all answer with the defaults (Standard
 * Manuscript, whole manuscript, everything included).
 */
export function getCompileState(db: TreeDb): CompileProjectState {
  const row = db.select().from(settings).where(eq(settings.key, COMPILE_STATE_KEY)).get()
  if (!row) return defaultCompileProjectState()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return defaultCompileProjectState()
  }
  const parsed = CompileProjectState.safeParse(json)
  return parsed.success ? parsed.data : defaultCompileProjectState()
}

/** Replaces the project's compile state (upsert on the settings key) and returns what was stored. */
export function setCompileState(db: TreeDb, value: CompileProjectState): CompileProjectState {
  const stored = CompileProjectState.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: COMPILE_STATE_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}

/**
 * Reads the plan-link suggestions and dismissed links (F-11.1d) from the `settings` row under
 * `PLAN_LINKS_KEY`. A missing row, unparsable JSON, or a value that no longer fits the schema
 * answer with `emptyPlanLinkState()`: suggestions are derived and the job proposes them again.
 */
export function getPlanLinkState(db: TreeDb): PlanLinkState {
  const row = db.select().from(settings).where(eq(settings.key, PLAN_LINKS_KEY)).get()
  if (!row) return emptyPlanLinkState()
  let json: unknown
  try {
    json = JSON.parse(row.value)
  } catch {
    return emptyPlanLinkState()
  }
  const parsed = PlanLinkState.safeParse(json)
  return parsed.success ? parsed.data : emptyPlanLinkState()
}

/** Replaces the plan-link state (upsert on the settings key) and returns what was stored. */
export function setPlanLinkState(db: TreeDb, value: PlanLinkState): PlanLinkState {
  const stored = PlanLinkState.parse(value)
  const serialized = JSON.stringify(stored)
  db.insert(settings)
    .values({ key: PLAN_LINKS_KEY, value: serialized })
    .onConflictDoUpdate({ target: settings.key, set: { value: serialized } })
    .run()
  return stored
}
