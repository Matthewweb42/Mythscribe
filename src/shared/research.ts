import { z } from 'zod'
import { ContextFileType, ContextSkipped } from './contextLibrary'

/**
 * The Research section (F-16.8, story memory v2; plan P1 §2): the author's uploaded and written
 * research, kept as documents under a fourth root that is never part of the book (compile,
 * statistics, goals, drafts, snapshots and the reader leave it out). One owner for what a
 * Research document is beside its node: where it came from, the original it was made from, and
 * whether the whole page is Not canon. Paragraphs carry their own Not canon mark (`pageMarks.ts`).
 */

/** How a Research document began: typed in MythScribe, or made from an uploaded file. */
export const RESEARCH_ORIGINS = ['written', 'upload'] as const
export const ResearchOrigin = z.enum(RESEARCH_ORIGINS)
export type ResearchOrigin = z.infer<typeof ResearchOrigin>

/** A Research title, as the tree's titles are capped. */
export const RESEARCH_TITLE_MAX = 200

/**
 * One Research document's meta (`research_doc`, migration 0032), keyed by its node. A document
 * the tree made without a row (an older build, a plain create) reads as written and canon.
 */
export const ResearchDoc = z.object({
  nodeId: z.string(),
  origin: ResearchOrigin,
  /** The uploaded original in the library, or null (written, or the original was removed). */
  contextFileId: z.string().nullable(),
  /** The original's file name, for the page header; null without one. */
  fileName: z.string().nullable(),
  /** The original's type; null for a written document. */
  fileType: ContextFileType.nullable(),
  /** A PDF's text read out of it: the page says "Converted from PDF". */
  converted: z.boolean(),
  /** The whole page is Not canon: ideas and maybes, never treated as true. */
  notCanon: z.boolean()
})
export type ResearchDoc = z.infer<typeof ResearchDoc>

/** What a document without a `research_doc` row reads as. */
export function writtenResearchDoc(nodeId: string): ResearchDoc {
  return {
    nodeId,
    origin: 'written',
    contextFileId: null,
    fileName: null,
    fileType: null,
    converted: false,
    notCanon: false
  }
}

/** What `research:add` answers: the documents it made, and the files it left out with the reason. */
export const ResearchAddResult = z.object({
  /** The new documents' node ids, in the order the files were given. */
  created: z.array(z.string()),
  skipped: z.array(ContextSkipped)
})
export type ResearchAddResult = z.infer<typeof ResearchAddResult>

/** Why a file already in Research is not added again. */
export function alreadyInResearch(title: string): string {
  return `Already in Research as "${title}".`
}

/** The line under a Research page's title that says where its text came from. */
export function researchSourceLine(doc: ResearchDoc): string | null {
  if (doc.origin !== 'upload') return null
  const name = doc.fileName ?? 'the original'
  if (doc.fileType === 'image') return `Image: ${name}`
  if (doc.converted) return `Converted from PDF: ${name}`
  return `Uploaded from ${name}`
}
