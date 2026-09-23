import { z } from 'zod'
import { docToText } from './docText'
import { TiptapNode, type TiptapNodeT } from './tiptap'
import { countWords } from './wordCount'

/**
 * Manuscript import (F-12.2): the structure draft main builds from a DOCX, Markdown, or plain-text
 * file and the renderer lets the author correct before anything is written. One owner for the
 * shape so the heuristics (main), the review dialog (renderer), and the commit (main) agree.
 * Strictly three levels: parts hold chapters, chapters hold scenes, scenes hold their paragraphs
 * as Tiptap `paragraph` nodes. Placement (manuscript, front matter, back matter) lives on
 * chapters; excluded nodes are kept in the draft (so the author can change their mind) and
 * skipped at commit.
 */
export const IMPORT_FORMATS = ['docx', 'md', 'txt'] as const
export const ImportFormat = z.enum(IMPORT_FORMATS)
export type ImportFormat = z.infer<typeof ImportFormat>

/** File extensions per format, lower-case, without the dot; the open dialog's filter and `importFormatOf` share it. */
export const IMPORT_EXTENSIONS: Record<ImportFormat, readonly string[]> = {
  docx: ['docx'],
  md: ['md', 'markdown'],
  txt: ['txt']
}

/** The format a file name implies, or null when the extension is not one we read. */
export function importFormatOf(fileName: string): ImportFormat | null {
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return null
  const extension = fileName.slice(dot + 1).toLowerCase()
  for (const format of IMPORT_FORMATS) {
    if (IMPORT_EXTENSIONS[format].includes(extension)) return format
  }
  return null
}

export const IMPORT_PLACEMENTS = ['manuscript', 'front', 'end'] as const
export const ImportPlacement = z.enum(IMPORT_PLACEMENTS)
export type ImportPlacement = z.infer<typeof ImportPlacement>

export const IMPORT_PLACEMENT_LABEL: Record<ImportPlacement, string> = {
  manuscript: 'Manuscript',
  front: 'Front matter',
  end: 'Back matter'
}

/** Equals `NODE_TITLE_MAX` in the contract, which this module cannot import (the contract imports it). */
export const IMPORT_TITLE_MAX = 200

const Title = z.string().max(IMPORT_TITLE_MAX)

/**
 * What the AI pass (F-12.3) did to a node, so the review tree can badge it and offer Reject:
 * `break` when the node exists because the AI added a boundary, `title` when its title came
 * from the AI (only default `Scene N` titles are replaced), `reason` the model's one-line why.
 * Absent on everything the heuristics or the author produced.
 */
export const ImportAiMarks = z.object({
  break: z.boolean(),
  title: z.boolean(),
  reason: z.string().nullable()
})
export type ImportAiMarks = z.infer<typeof ImportAiMarks>

export const ImportScene = z.object({
  id: z.string(),
  title: Title,
  excluded: z.boolean(),
  /** Tiptap `paragraph` nodes, each with `attrs.origin = 'imported'` (F-14.6 style provenance). */
  paragraphs: z.array(TiptapNode),
  /**
   * Tag-bank names the AI pass proposed for the scene (F-12.3); they become one pending
   * proposal on the created node at commit and are never linked without an accept.
   */
  tags: z.array(z.string()).default([]),
  ai: ImportAiMarks.optional()
})
export type ImportScene = z.infer<typeof ImportScene>

export const ImportChapter = z.object({
  id: z.string(),
  title: Title,
  excluded: z.boolean(),
  placement: ImportPlacement,
  scenes: z.array(ImportScene),
  ai: ImportAiMarks.optional()
})
export type ImportChapter = z.infer<typeof ImportChapter>

export const ImportPart = z.object({
  id: z.string(),
  title: Title,
  excluded: z.boolean(),
  chapters: z.array(ImportChapter)
})
export type ImportPart = z.infer<typeof ImportPart>

export const ImportSource = z.object({
  /** The file's base name, extension included. */
  name: z.string(),
  format: ImportFormat,
  /** Words and paragraphs of the whole file, before any exclusion. */
  words: z.number().int().nonnegative(),
  paragraphs: z.number().int().nonnegative()
})
export type ImportSource = z.infer<typeof ImportSource>

export const ImportDraft = z.object({
  source: ImportSource,
  parts: z.array(ImportPart),
  /** The next number the renderer mints an id from when it splits a scene; main starts it at 1. */
  nextId: z.number().int().nonnegative()
})
export type ImportDraft = z.infer<typeof ImportDraft>

export type ImportNode = ImportPart | ImportChapter | ImportScene

/** Longest preview of a scene's opening the review tree shows. */
export const IMPORT_PREVIEW_MAX = 120

/** The first paragraph's text, one line, capped, for the review tree's preview of a scene. */
export function sceneFirstLine(scene: Pick<ImportScene, 'paragraphs'>): string {
  const first = scene.paragraphs[0]
  if (!first) return ''
  const text = docToText({ type: 'doc', content: [first] }).replace(/\s+/g, ' ').trim()
  return text.length > IMPORT_PREVIEW_MAX ? `${text.slice(0, IMPORT_PREVIEW_MAX - 1)}…` : text
}

/** Words in a scene, by the same count the editor caches (`countWords`). */
export function sceneWords(scene: Pick<ImportScene, 'paragraphs'>): number {
  return countWords({ type: 'doc', content: scene.paragraphs })
}

/**
 * True for a title the heuristics minted (`Scene 3`, always the literal `levelLabel` word
 * "Scene", or a `… (split)` of one), the only titles the AI pass (F-12.3) may replace: a heading
 * the author wrote or renamed stays, even one that looks like a label (`Round 2`).
 */
export function isDefaultSceneTitle(title: string): boolean {
  return /^Scene \d+( \(split\))*$/.test(title)
}

/** The document a scene becomes at commit: one Tiptap doc of its paragraphs. */
export function sceneDocument(paragraphs: TiptapNodeT[]): TiptapNodeT {
  return { type: 'doc', content: paragraphs.length > 0 ? paragraphs : [{ type: 'paragraph' }] }
}

export interface ImportSummary {
  parts: number
  chapters: number
  scenes: number
  /** Chapters placed in front or back matter, each becoming one document there. */
  matter: number
  words: number
}

/** What Import would create: excluded nodes are skipped, so are chapters and parts left empty by exclusions. */
export function draftSummary(draft: ImportDraft): ImportSummary {
  const summary: ImportSummary = { parts: 0, chapters: 0, scenes: 0, matter: 0, words: 0 }
  for (const part of draft.parts) {
    if (part.excluded) continue
    let manuscriptChapters = 0
    for (const chapter of part.chapters) {
      if (chapter.excluded) continue
      const scenes = chapter.scenes.filter((scene) => !scene.excluded)
      if (scenes.length === 0) continue
      const words = scenes.reduce((total, scene) => total + sceneWords(scene), 0)
      summary.words += words
      if (chapter.placement === 'manuscript') {
        manuscriptChapters += 1
        summary.chapters += 1
        summary.scenes += scenes.length
      } else {
        summary.matter += 1
      }
    }
    if (manuscriptChapters > 0) summary.parts += 1
  }
  return summary
}
