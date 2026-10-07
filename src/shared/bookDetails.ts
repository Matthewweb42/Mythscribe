import { z } from 'zod'

/**
 * Book details (Compile v2, CV1): the project's publishing facts, read by compile for the title
 * page, the Standard Manuscript first page, running headers, the copyright page, the generated
 * back pages, and the EPUB metadata. Stored as JSON in the project's `settings` row
 * `BOOK_DETAILS_KEY` (no migration). Every field is defaulted, so a row written before a later
 * field parses unchanged; a row that no longer fits reads as the defaults (`parseBookDetails`).
 * Free text is stored as typed; compile trims it. The cover is an image file under the project's
 * `assets/covers/`, set through its own channel.
 */

export const BOOK_DETAILS_KEY = 'bookDetails'
/** The asset folder the cover lives in (`assetUrl(BOOK_COVER_DIR, details.cover)`). */
export const BOOK_COVER_DIR = 'covers' as const

export const BOOK_LINE_MAX = 200
export const BOOK_TEXT_MAX = 5000
export const BOOK_LIST_MAX = 50

const line = z.string().max(BOOK_LINE_MAX).default('')
const text = z.string().max(BOOK_TEXT_MAX).default('')

export const BookIsbn = z.object({
  /** Which edition the number is for: "Paperback", "Hardcover", "Ebook", … */
  edition: z.string().max(60),
  isbn: z.string().max(40)
})
export type BookIsbn = z.infer<typeof BookIsbn>

export const BookDetails = z.object({
  /** Empty: compile uses the project's name. */
  title: line,
  subtitle: line,
  series: line,
  /** As printed ("2", "Two", "II"). */
  seriesNumber: z.string().max(20).default(''),
  /** The name on the cover (pen name). */
  author: line,
  /** Standard Manuscript: the legal name on the contact block (empty: `author`). */
  legalName: line,
  /** Standard Manuscript contact block: address, email, phone, agent; one line each. */
  contact: text,
  /** The running-header surname (empty: the last word of `author`). */
  surname: line,
  isbns: z.array(BookIsbn).max(10).default([]),
  publisher: line,
  copyrightYear: z.string().max(20).default(''),
  /** "All rights reserved." or a licence line; printed on the copyright page. */
  rights: text,
  edition: line,
  dedication: text,
  epigraph: text,
  /** Who the epigraph is by, printed after a dash. */
  epigraphSource: line,
  aboutAuthor: text,
  /** Earlier books, one title each, for the "Also by" page. */
  alsoBy: z.array(z.string().max(BOOK_LINE_MAX)).max(BOOK_LIST_MAX).default([]),
  /** File name under `assets/covers/`, or null. */
  cover: z.string().max(200).nullable().default(null),
  /** BCP 47 language tag for EPUB and DOCX ("en", "en-GB", "fr"). */
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
    .default('en'),
  /** The blurb: EPUB description and retailer copy. */
  description: text,
  keywords: z.array(z.string().max(100)).max(BOOK_LIST_MAX).default([])
})
export type BookDetails = z.infer<typeof BookDetails>
export type BookDetailsInput = z.input<typeof BookDetails>

export function defaultBookDetails(): BookDetails {
  return BookDetails.parse({})
}

/** A stored value as `BookDetails`; anything that does not fit reads as the defaults. */
export function parseBookDetails(json: unknown): BookDetails {
  const parsed = BookDetails.safeParse(json)
  return parsed.success ? parsed.data : defaultBookDetails()
}

/** The author's surname for headers: `surname`, else the last word of `author`, else ''. */
export function bookSurname(details: BookDetails): string {
  const explicit = details.surname.trim()
  if (explicit) return explicit
  const words = details.author.trim().split(/\s+/)
  return words[words.length - 1] ?? ''
}

/** The book's title: `title`, else the project's name. */
export function bookTitle(details: BookDetails, projectName: string): string {
  return details.title.trim() || projectName.trim()
}

/** The ISBN for an edition (matched ignoring case and spaces); '' edition = the first one. */
export function isbnFor(details: BookDetails, edition: string): string {
  const key = edition.trim().toLowerCase()
  const match =
    key === ''
      ? details.isbns[0]
      : details.isbns.find((i) => i.edition.trim().toLowerCase() === key)
  return match?.isbn.trim() ?? ''
}
