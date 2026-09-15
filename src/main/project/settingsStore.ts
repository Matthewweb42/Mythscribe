import { eq } from 'drizzle-orm'
import {
  AI_SETTINGS_KEY,
  AiSettings,
  defaultAiSettings,
  type AiSettingsInput
} from '@shared/aiSettings'
import { CONVERSATIONS_KEY, Conversations, parseStoredConversations } from '@shared/chat'
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
import type { NovelFormat } from '@shared/ipc/contract'
import { WRITING_PRESETS_KEY, WritingPresets, defaultWritingPresets } from '@shared/presets'
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
