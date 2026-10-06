import { docToText } from '@shared/docText'
import {
  IMPORT_TITLE_MAX,
  baseName,
  type ImportChapter,
  type ImportDraft,
  type ImportFormat,
  type ImportPart,
  type ImportPlacement,
  type ImportScene
} from '@shared/import'
import type { NovelFormat } from '@shared/ipc/contract'
import { levelLabel } from '@shared/labels'
import type { TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import { blankRunsToBreaks, paragraphNode, textRun, type ImportBlock } from './blocks'

/**
 * Manuscript import (F-12.2): the structure guess. A manuscript arrives as a flat list of blocks
 * and has to become parts, chapters, and scenes; nothing in a DOCX or a text file says which is
 * which, so this module guesses and the author corrects the guess in the review dialog before a
 * single row is written. It is pure, which is what makes the guess testable.
 *
 * The order of the heuristics matters and is fixed: heading levels decide the roles first,
 * because a file with real Word styles is unambiguous; only then are plain paragraphs that look
 * like "Chapter Seven" or "IV." promoted, because in a file with no styles they are all the
 * author has.
 */

export interface DraftOptions {
  /** The file's base name, extension included; it titles the part when the file has no parts. */
  name: string
  format: ImportFormat
  /** The project's format (F-1.5), which decides whether parts are called Parts or Arcs. */
  novelFormat: NovelFormat
}

/** A paragraph long enough to be prose is never a title, however it starts. */
const TITLE_LINE_MAX = 80

const PART_LINE = /^(part|book|act)\s+\S+/i
const CHAPTER_LINES = [
  /^(chapter|ch\.)\s+\S+/i,
  /^\d+\.?$/,
  /^[ivxlc]+\.?$/i,
  /^(prologue|epilogue|interlude)\b/i
]

/** Chapter titles that belong in front matter rather than the manuscript, if they lead the file. */
const FRONT_TITLE =
  /\b(title|copyright|dedication|contents|epigraph|foreword|preface|also by|praise for)\b/i
/** …and the ones that belong in back matter, if they trail it. A prologue is neither: it is the story. */
const END_TITLE =
  /\b(acknowledg|about the author|afterword|author'?s note|glossary|appendix|bibliography)/i

/** Content ahead of the first chapter heading is front matter only while it stays this short. */
const LEADING_FRONT_WORDS_MAX = 300

/** What a block turned out to be once the heading levels and the title patterns were applied. */
type Marker =
  | { type: 'part'; title: string }
  | { type: 'chapter'; title: string }
  | { type: 'paragraph'; node: TiptapNodeT }
  | { type: 'break' }

interface WorkChapter {
  /** The heading it came from, or null when the importer invented it. */
  title: string | null
  scenes: TiptapNodeT[][]
}

interface WorkPart {
  title: string | null
  chapters: WorkChapter[]
}

export function buildDraft(blocks: readonly ImportBlock[], options: DraftOptions): ImportDraft {
  // Blanks carry structure, not prose: they are resolved into scene breaks first and are gone
  // from here on, so nothing downstream has to wonder what a lone empty line meant.
  const resolved = blankRunsToBreaks(blocks).filter(
    (block): block is Exclude<ImportBlock, { type: 'blank' }> => block.type !== 'blank'
  )
  const parts = assemble(promoteTitleLines(classify(resolved)))
  const hasTitledChapter = parts.some((part) =>
    part.chapters.some((chapter) => chapter.title !== null)
  )
  const hasTitledPart = parts.some((part) => part.title !== null)
  const draftParts = label(parts, options, { hasTitledChapter, hasTitledPart })
  return {
    source: {
      name: options.name,
      format: options.format,
      words: draftParts.reduce(
        (total, part) =>
          total +
          part.chapters.reduce(
            (chapterTotal, chapter) =>
              chapterTotal +
              chapter.scenes.reduce(
                (sceneTotal, scene) =>
                  sceneTotal + countWords({ type: 'doc', content: scene.paragraphs }),
                0
              ),
            0
          ),
        0
      ),
      paragraphs: draftParts.reduce(
        (total, part) =>
          total +
          part.chapters.reduce(
            (chapterTotal, chapter) =>
              chapterTotal +
              chapter.scenes.reduce((sceneTotal, scene) => sceneTotal + scene.paragraphs.length, 0),
            0
          ),
        0
      )
    },
    parts: draftParts,
    nextId: 1
  }
}

/**
 * Decides what every block is. With two or more heading levels in the file, the shallowest is the
 * part and the next one the chapter (deeper headings are prose in bold, because a manuscript does
 * not nest below the chapter); with one level, that level is the chapter. A heading or a short
 * paragraph reading "Part Two" is a part whatever its level says.
 */
function classify(blocks: readonly Exclude<ImportBlock, { type: 'blank' }>[]): Marker[] {
  const levels = [...new Set(blocks.filter((b) => b.type === 'heading').map((b) => b.level))].sort(
    (a, b) => a - b
  )
  const partLevel = levels.length >= 2 ? levels[0] : null
  const chapterLevel = levels.length >= 2 ? levels[1] : levels[0]

  return blocks.map((block): Marker => {
    if (block.type === 'break') return { type: 'break' }
    if (block.type === 'heading') {
      if (PART_LINE.test(block.text)) return { type: 'part', title: block.text }
      if (block.level === partLevel) return { type: 'part', title: block.text }
      if (block.level === chapterLevel) return { type: 'chapter', title: block.text }
      return { type: 'paragraph', node: paragraphNode([textRun(block.text, { bold: true })]) }
    }
    const text = docToText({ type: 'doc', content: [block.node] }).trim()
    if (text.length > 0 && text.length <= TITLE_LINE_MAX) {
      if (PART_LINE.test(text)) return { type: 'part', title: text }
      if (CHAPTER_LINES.some((pattern) => pattern.test(text)))
        return { type: 'chapter', title: text }
    }
    return { type: 'paragraph', node: block.node }
  })
}

/** A title is a line, not a sentence: this many words at most… */
const TITLE_WORDS_MAX = 8
/** …and this many characters. */
const TITLE_CHARS_MAX = 60
/** Words Title Case leaves lower-case ("The Fall of the House"). */
const TITLE_SMALL_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'nor',
  'of',
  'on',
  'or',
  'over',
  'the',
  'to',
  'under',
  'with'
])

/**
 * True for a short line that reads as a title rather than prose: no ending punctuation (a
 * sentence, a line of dialogue, or a dash-cut fragment always has one), an upper-case letter or
 * a digit first, at most `TITLE_WORDS_MAX` words, and either all capitals, Title Case, or three
 * words or fewer ("The long night"). Pure, so the guess is testable line by line.
 */
export function isTitleLine(text: string): boolean {
  const line = text.trim()
  if (line.length === 0 || line.length > TITLE_CHARS_MAX || line.includes('\n')) return false
  if (/[.,;:!?…"”'’)\]\-–—*]$/.test(line)) return false
  if (!/^[\p{Lu}\p{N}]/u.test(line)) return false
  const words = line.split(/\s+/)
  if (words.length > TITLE_WORDS_MAX) return false
  const letters = line.replace(/[^\p{L}]/gu, '')
  if (letters.length > 0 && letters === letters.toUpperCase()) return true
  if (words.length <= 3) return true
  return words.every(
    (word, index) =>
      index === 0 || TITLE_SMALL_WORDS.has(word.toLowerCase()) || /^[\p{Lu}\p{N}]/u.test(word)
  )
}

/**
 * A title at the start of a scene starts a new chapter named after it (the author's rule,
 * 2026-10-06): a title-like line (`isTitleLine`) right after a scene break or a part heading,
 * with prose after it, becomes a chapter marker. The first line of the file counts too, but only
 * when the file marks no chapters of its own — otherwise what precedes the first chapter is the
 * front matter `label` guesses at (a book title, a dedication). A title with nothing after it
 * (a closing "THE END") stays prose, so no text is dropped as an empty chapter.
 */
function promoteTitleLines(markers: readonly Marker[]): Marker[] {
  const explicitChapters = markers.some((marker) => marker.type === 'chapter')
  return markers.map((marker, index): Marker => {
    if (marker.type !== 'paragraph') return marker
    const previous = index === 0 ? null : (markers[index - 1] ?? null)
    const startsScene =
      previous === null ? !explicitChapters : previous.type === 'break' || previous.type === 'part'
    if (!startsScene || markers[index + 1]?.type !== 'paragraph') return marker
    const text = docToText({ type: 'doc', content: [marker.node] })
    return isTitleLine(text) ? { type: 'chapter', title: text.trim() } : marker
  })
}

/** Walks the markers into parts → chapters → scenes, inventing a container whenever one is missing. */
function assemble(markers: readonly Marker[]): WorkPart[] {
  const parts: WorkPart[] = []
  let sceneOpen = false

  const lastPart = (): WorkPart => {
    const last = parts.at(-1)
    if (last !== undefined) return last
    const created: WorkPart = { title: null, chapters: [] }
    parts.push(created)
    return created
  }
  const lastChapter = (): WorkChapter => {
    const part = lastPart()
    const last = part.chapters.at(-1)
    if (last !== undefined) return last
    const created: WorkChapter = { title: null, scenes: [] }
    part.chapters.push(created)
    return created
  }

  for (const marker of markers) {
    switch (marker.type) {
      case 'part':
        parts.push({ title: marker.title, chapters: [] })
        sceneOpen = false
        break
      case 'chapter':
        lastPart().chapters.push({ title: marker.title, scenes: [] })
        sceneOpen = false
        break
      case 'break':
        sceneOpen = false
        break
      case 'paragraph': {
        const chapter = lastChapter()
        let scene = chapter.scenes.at(-1)
        if (!sceneOpen || scene === undefined) {
          scene = []
          chapter.scenes.push(scene)
          sceneOpen = true
        }
        scene.push(marker.node)
        break
      }
    }
  }
  // A heading with nothing under it (a table of contents entry, a part title on its own page)
  // leaves an empty container behind; nothing is imported for it.
  return parts
    .map((part) => ({
      ...part,
      chapters: part.chapters.filter((chapter) => chapter.scenes.length > 0)
    }))
    .filter((part) => part.chapters.length > 0)
}

/** Titles, ids, and placement: the last pass, once the shape is settled and the empties are gone. */
function label(
  parts: readonly WorkPart[],
  options: DraftOptions,
  found: { hasTitledChapter: boolean; hasTitledPart: boolean }
): ImportPart[] {
  const partLabel = levelLabel(options.novelFormat, 'part')
  const chapterLabel = levelLabel(options.novelFormat, 'chapter')
  const sceneLabel = levelLabel(options.novelFormat, 'scene')

  // The file's own name is the best title a manuscript with no parts can have.
  const soleTitle = found.hasTitledPart ? null : baseName(options.name)
  // Whatever sits before the first chapter heading and is short enough is the front matter the
  // author pasted along with the manuscript: a title page, a dedication, an epigraph.
  const leading = parts[0]?.chapters[0]
  const leadingIsFront =
    found.hasTitledChapter &&
    leading?.title === null &&
    chapterWords(leading) < LEADING_FRONT_WORDS_MAX

  const isLeading = (partIndex: number, chapterIndex: number): boolean =>
    leadingIsFront && partIndex === 0 && chapterIndex === 0

  const draft = parts.map((part, partIndex): ImportPart => {
    const partId = `p${partIndex + 1}`
    return {
      id: partId,
      title: cap(part.title ?? soleTitle ?? `${partLabel} ${partIndex + 1}`),
      excluded: false,
      chapters: part.chapters.map((chapter, chapterIndex): ImportChapter => {
        const chapterId = `${partId}c${chapterIndex + 1}`
        return {
          id: chapterId,
          title: cap(
            isLeading(partIndex, chapterIndex)
              ? 'Front matter'
              : (chapter.title ?? `${chapterLabel} ${chapterIndex + 1}`)
          ),
          excluded: false,
          placement: 'manuscript',
          scenes: chapter.scenes.map((paragraphs, sceneIndex): ImportScene => ({
            id: `${chapterId}s${sceneIndex + 1}`,
            title: cap(`${sceneLabel} ${sceneIndex + 1}`),
            excluded: false,
            paragraphs,
            tags: []
          }))
        }
      })
    }
  })

  // The invented leading chapter is front matter by construction and takes no part in the guess:
  // it has no title of the author's to read, and counting it would move the "first real chapter"
  // the front and back sets are measured against.
  const guessed = guessPlacements(
    draft.flatMap((part, partIndex) =>
      part.chapters
        .filter((_chapter, chapterIndex) => !isLeading(partIndex, chapterIndex))
        .map((chapter) => chapter.title)
    )
  )
  let index = 0
  draft.forEach((part, partIndex) => {
    part.chapters.forEach((chapter, chapterIndex) => {
      if (isLeading(partIndex, chapterIndex)) {
        chapter.placement = 'front'
        return
      }
      chapter.placement = guessed[index] ?? 'manuscript'
      index += 1
    })
  })
  return draft
}

/**
 * Front and back matter by title, and only at the edges: "Dedication" ahead of every real chapter
 * is front matter, "Dedication" in the middle of the manuscript is a chapter the author named
 * that.
 */
export function guessPlacements(titles: readonly string[]): ImportPlacement[] {
  const matched = titles.map((title) =>
    FRONT_TITLE.test(title) ? 'front' : END_TITLE.test(title) ? 'end' : null
  )
  const first = matched.indexOf(null)
  const last = matched.lastIndexOf(null)
  // Every chapter matching leaves no manuscript at all, which is never what the author meant.
  if (first < 0) return titles.map(() => 'manuscript')
  return matched.map((match, index) => {
    if (match === 'front' && index < first) return 'front'
    if (match === 'end' && index > last) return 'end'
    return 'manuscript'
  })
}

function chapterWords(chapter: WorkChapter): number {
  return chapter.scenes.reduce(
    (total, scene) => total + countWords({ type: 'doc', content: scene }),
    0
  )
}

function cap(title: string): string {
  const trimmed = title.trim()
  return trimmed.length > IMPORT_TITLE_MAX ? trimmed.slice(0, IMPORT_TITLE_MAX).trim() : trimmed
}
