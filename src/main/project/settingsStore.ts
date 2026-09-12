import { eq } from 'drizzle-orm'
import { EDITOR_SETTINGS_KEY, EditorSettings, defaultEditorSettings } from '@shared/editorSettings'
import type { NovelFormat } from '@shared/ipc/contract'
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
