import { eq } from 'drizzle-orm'
import { AI_SETTINGS_KEY, AiSettings, defaultAiSettings } from '@shared/aiSettings'
import { EDITOR_SETTINGS_KEY, EditorSettings, defaultEditorSettings } from '@shared/editorSettings'
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
export function setEditorSettings(db: TreeDb, value: EditorSettings): EditorSettings {
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

/** Replaces the project's AI settings (upsert on the settings key) and returns what was stored. */
export function setAiSettings(db: TreeDb, value: AiSettings): AiSettings {
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
