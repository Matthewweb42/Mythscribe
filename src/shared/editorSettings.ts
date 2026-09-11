import { z } from 'zod'
import type { NovelFormat } from './ipc/contract'

/** Settings-table key under which a project's editor formatting (F-3.6) is stored as JSON. */
export const EDITOR_SETTINGS_KEY = 'editor'

/** Scene-break styles offered as presets; custom text is also allowed. */
export const SCENE_BREAK_PRESETS = ['* * *', '***', '###', '~~~', '---'] as const

export const EditorSettings = z.object({
  /** px */
  fontSize: z.number().min(12).max(24),
  lineHeight: z.number().min(1).max(2.5),
  /** em */
  paragraphSpacing: z.number().min(0).max(2),
  /** em, first line */
  paragraphIndent: z.number().min(0).max(3),
  /** px, editor column (F-3.4) */
  maxWidth: z.number().min(500).max(1000),
  sceneBreak: z.string().trim().min(1).max(20)
})
export type EditorSettings = z.infer<typeof EditorSettings>

/** Format-specific defaults seeded into a new project (F-1.3, F-3.6). */
export function defaultEditorSettings(format: NovelFormat): EditorSettings {
  if (format === 'webnovel') {
    return {
      fontSize: 16,
      lineHeight: 1.6,
      paragraphSpacing: 1,
      paragraphIndent: 0,
      maxWidth: 700,
      sceneBreak: '~~~'
    }
  }
  return {
    fontSize: 16,
    lineHeight: 2,
    paragraphSpacing: 0,
    paragraphIndent: 1.5,
    maxWidth: 700,
    sceneBreak: '* * *'
  }
}
