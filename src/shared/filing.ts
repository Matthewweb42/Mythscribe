import { z } from 'zod'
import { AiErrorCode, AiUsage } from './ai'
import { chunkParagraphs, ContextReviewCategory, relateValues } from './contextLibrary'
import { normalizeForMatch } from './critique'
import { normName } from './memory/names'
import { RECORD_ALIASES_MAX, RECORD_ALIAS_MAX, RECORD_NAME_MAX } from './memory/records'
import { twinGate, TwinRule, type TwinRosterRecord } from './memory/twinGate'
import { resolveKind, type ReviewChange, type ReviewOp } from './reviewChat'

/**
 * Filing an upload into Pinned (F-16.9, decision 6; story memory v2): the AI reads one Research
 * document once (`contextImport.v3`) and proposes lines for the records it describes, each with
 * the words of the document it came from. Code checks every quote against the document, runs new
 * names through the twin gate, drops what Pinned already says, and marks a "Label: value" line
 * whose label Pinned holds with another value as a conflict. The author reviews it on the deck
 * (everything starts accepted; Skip leaves a card out), the review chat can change it
 * (`reviewChat.v3`, the same operations as v1's minus the Project notes ones), and Apply writes it
 * in one transaction: records, names, categories, pictures and Pinned paragraphs marked `aiFiled`.
 * Text that fits no record stays in the Research document. The pure half lives here; main reads
 * the document and runs the requests.
 */

/** A filed line's quote: at least this many words, at most this many (decision 6). */
export const FILING_QUOTE_MIN_WORDS = 3
export const FILING_QUOTE_MAX_WORDS = 40
/** The longest line filed into Pinned, in characters; longer is cut at a word. */
export const FILING_LINE_MAX = 600
/** Most lines one record takes from one filing. */
export const FILING_LINES_MAX = 60

/** One line for a record's Pinned page. */
export const FilingLine = z.object({
  id: z.string(),
  /** The line as it would be filed ("Eyes: grey"). */
  text: z.string(),
  /** The document's words it came from, checked to be in paragraph `para`. */
  quote: z.string(),
  /** The paragraph of the document (its `markedParagraphs` index) the quote is in. */
  para: z.number().int().nonnegative(),
  /**
   * `add`: a new paragraph. `update`: Pinned's paragraph with the same label is empty or a
   * placeholder, or the line says all it says and more; it is replaced. `conflict`: the two
   * disagree; Pinned's is kept unless the author picks the upload's (`use`).
   */
  kind: z.enum(['add', 'update', 'conflict']),
  /** The Pinned paragraph an update or conflict would replace: its index and its text. */
  replaces: z.object({ index: z.number().int().nonnegative(), text: z.string() }).nullable(),
  /** Whether Apply writes the line: always for add and update; for a conflict, the author's pick. */
  use: z.boolean()
})
export type FilingLine = z.infer<typeof FilingLine>

/** One record of the review: a new one, or an existing one the filing adds to. */
export const FilingItem = z.object({
  id: z.string(),
  /** The existing record, or null for a new one. */
  recordId: z.string().nullable(),
  name: z.string(),
  categoryId: z.string(),
  /** The record's names already (an existing record), so the chat's alias edits never repeat one. */
  known: z.array(z.string()),
  /** New names to add (origin `filed`). */
  aliases: z.array(z.string()),
  lines: z.array(FilingLine),
  /**
   * A name the model gave as new that the twin gate found close to an existing record ("same as
   * Mara Vell?"): filed as an addition to that record, its name as a nickname, with this note.
   */
  sameAs: z.object({ given: z.string(), rule: TwinRule }).nullable(),
  /** A Research image page that shows the record, when the record has no picture yet. */
  image: z.object({ nodeId: z.string(), name: z.string() }).nullable(),
  include: z.boolean()
})
export type FilingItem = z.infer<typeof FilingItem>

/** What the checks dropped, for the review's header ("2 lines dropped: quote not in the document"). */
export const FilingDropped = z.object({
  quote: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  dismissed: z.number().int().nonnegative(),
  alias: z.number().int().nonnegative()
})
export type FilingDropped = z.infer<typeof FilingDropped>

/** The filing the author reviews; nothing is written while it exists. */
export const FilingReview = z.object({
  /** The Research document filed. */
  docId: z.string(),
  docTitle: z.string(),
  /** The hash of the document's text as filed (`research_doc.filed_hash`). */
  docHash: z.string(),
  items: z.array(FilingItem),
  /** The project's own categories and the AI's proposed ones (as the upload review keeps them). */
  categories: z.array(ContextReviewCategory),
  dropped: FilingDropped,
  /** One proposal per request (F-14.5), settled at Apply or Cancel. */
  proposalIds: z.array(z.string()),
  chunks: z.number().int().nonnegative(),
  usage: AiUsage,
  costUsd: z.number().nonnegative(),
  model: z.string(),
  promptVersion: z.string()
})
export type FilingReview = z.infer<typeof FilingReview>

export const FilingProcessResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), review: FilingReview }),
  z.object({ ok: z.literal(false), code: AiErrorCode, message: z.string(), nextStep: z.string() })
])
export type FilingProcessResult = z.infer<typeof FilingProcessResult>

/** What Apply wrote. */
export const FilingApplyResult = z.object({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
  /** Every record Apply wrote to, for the renderer's reload of their Pinned pages. */
  recordIds: z.array(z.string()),
  /** When the document was filed (ISO). */
  filedAt: z.string()
})
export type FilingApplyResult = z.infer<typeof FilingApplyResult>

/** What *Undo filing* did: the records it touched, and what it left because it was edited since. */
export const FilingUndoResult = z.object({
  /** The records the undo changed (their Pinned pages are read again). */
  recordIds: z.array(z.string()),
  /** The records filing had made, removed again. */
  deleted: z.array(z.string()),
  /** Paragraphs and records left in place because the author changed them after the filing. */
  kept: z.number().int().nonnegative()
})
export type FilingUndoResult = z.infer<typeof FilingUndoResult>

/**
 * A filed line whose source changed (F-16.9): a Pinned paragraph marked `aiFiled` whose quote is
 * no longer in its Research document. A Needs a look conflict: *Go there* · *Update line* ·
 * *Keep line* (a `notProblem` dismissal under `key`).
 */
export const FiledConflict = z.object({
  /** The dismissal reference: the record, the paragraph's hash and the source's hash. */
  key: z.string(),
  recordId: z.string(),
  recordName: z.string(),
  docId: z.string(),
  docTitle: z.string(),
  /** The paragraph of the document it was filed from (0-based). */
  para: z.number().int().nonnegative(),
  /** The Pinned paragraph's text, and its index among the page's text blocks. */
  line: z.string(),
  lineIndex: z.number().int().nonnegative(),
  quote: z.string(),
  /** The document's paragraph closest to the quote now, or null when the document has no text. */
  nowReads: z.string().nullable()
})
export type FiledConflict = z.infer<typeof FiledConflict>

// ---------------------------------------------------------------------------------------------
// What the model answers (contextImport.v3), and what it is sent

/** The model's answer, read leniently: missing lists are empty; a bad shape is no answer. */
export const FilingModelAnswer = z.object({
  records: z
    .array(
      z.object({
        name: z.string(),
        category: z.string(),
        aliases: z.array(z.string()).nullish(),
        lines: z.array(z.object({ text: z.string(), q: z.string() })).nullish()
      })
    )
    .nullish(),
  categories: z
    .array(z.object({ kind: z.string(), name: z.string(), noun: z.string().nullish() }))
    .nullish(),
  images: z.array(z.object({ file: z.string(), name: z.string() })).nullish()
})
export type FilingModelAnswer = z.infer<typeof FilingModelAnswer>

/** The answer as JSON (a code fence around it is allowed), or null when it is not that shape. */
export function parseFilingAnswer(text: string): FilingModelAnswer | null {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
  let json: unknown
  try {
    json = JSON.parse(unfenced)
  } catch {
    return null
  }
  const parsed = FilingModelAnswer.safeParse(json)
  return parsed.success ? parsed.data : null
}

/**
 * The pieces of a Research document sent for filing: its canon paragraphs only (a Not canon one is
 * never filed into Pinned), packed into chunks at paragraph boundaries (`chunkParagraphs`).
 */
export function filingChunks(paragraphs: readonly { text: string; notCanon: boolean }[]): string[] {
  return chunkParagraphs(
    paragraphs.filter((paragraph) => !paragraph.notCanon).map((paragraph) => flat(paragraph.text))
  )
}

// ---------------------------------------------------------------------------------------------
// The plan

/** One record as the model filed it, its category already resolved. */
export interface FiledRecord {
  name: string
  categoryId: string
  aliases: readonly string[]
  lines: readonly { text: string; q: string }[]
}

/** One existing record as the plan reads it. */
export interface FilingRosterRecord {
  id: string
  name: string
  categoryId: string
  /** Every name, the main one first, with whether it is shared. */
  names: readonly { text: string; shared: boolean }[]
  /** The Pinned page's canon paragraphs, by their index among its text blocks. */
  pinned: readonly { index: number; text: string }[]
  hasImage: boolean
}

export interface PlanFilingInput {
  records: readonly FiledRecord[]
  /** The document's paragraphs (`markedParagraphs`); Not canon ones are never filed from. */
  paragraphs: readonly { index: number; text: string; notCanon: boolean }[]
  roster: readonly FilingRosterRecord[]
  /** The `name` dismissals' keys (blocked silently). */
  dismissedNames: readonly string[]
  /** The `alias` dismissals' keys (`recordId|norm`). */
  dismissedAliases: ReadonlySet<string>
  /** The Research image pages, and the model's hints of whom each shows. */
  images: readonly { nodeId: string; name: string }[]
  imageHints: readonly { file: string; name: string }[]
}

export interface FilingPlan {
  items: FilingItem[]
  dropped: FilingDropped
}

const words = (text: string): number => text.trim().split(/\s+/u).filter(Boolean).length

const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim()

/** A line within `FILING_LINE_MAX`, cut at a word. */
function lineText(text: string): string {
  const one = flat(text)
  if (one.length <= FILING_LINE_MAX) return one
  const cut = one.slice(0, FILING_LINE_MAX)
  const at = cut.lastIndexOf(' ')
  return `${(at > FILING_LINE_MAX / 2 ? cut.slice(0, at) : cut).trimEnd()}…`
}

/** "Eyes: grey" → { label: 'eyes', value: 'grey' }; null for a line with no short label. */
export function splitLabel(text: string): { label: string; value: string } | null {
  const match = /^([^:\n]{1,40}):\s*(\S.*)$/su.exec(flat(text))
  if (match === null) return null
  return { label: (match[1] ?? '').trim().toLocaleLowerCase(), value: (match[2] ?? '').trim() }
}

/** The canon paragraph of the document that holds `quote`, or null (a word count out of range too). */
export function quoteParagraph(
  quote: string,
  paragraphs: PlanFilingInput['paragraphs']
): number | null {
  const count = words(quote)
  if (count < FILING_QUOTE_MIN_WORDS || count > FILING_QUOTE_MAX_WORDS) return null
  const needle = normalizeForMatch(quote).toLocaleLowerCase()
  if (needle === '') return null
  const hit = paragraphs.find(
    (paragraph) =>
      !paragraph.notCanon && normalizeForMatch(paragraph.text).toLocaleLowerCase().includes(needle)
  )
  return hit?.index ?? null
}

/** How a line relates to a record's Pinned paragraphs: dropped, added, an update, or a conflict. */
function relateLine(
  text: string,
  pinned: FilingRosterRecord['pinned']
): { kind: FilingLine['kind']; replaces: FilingLine['replaces'] } | 'duplicate' {
  const labelled = splitLabel(text)
  if (labelled !== null) {
    for (const paragraph of pinned) {
      const theirs = splitLabel(paragraph.text)
      if (theirs?.label !== labelled.label) continue
      const relation = relateValues(theirs.value, labelled.value)
      if (relation === 'same' || relation === 'covered') return 'duplicate'
      const replaces = { index: paragraph.index, text: paragraph.text }
      if (relation === 'empty' || relation === 'extends') return { kind: 'update', replaces }
      return { kind: 'conflict', replaces }
    }
  }
  for (const paragraph of pinned) {
    const relation = relateValues(paragraph.text, text)
    if (relation === 'same' || relation === 'covered') return 'duplicate'
  }
  return { kind: 'add', replaces: null }
}

/** The twin gate's roster: every record's names, the main one first. */
function gateRoster(roster: readonly FilingRosterRecord[]): TwinRosterRecord[] {
  return roster.map((record) => ({ id: record.id, names: record.names.map((name) => name.text) }))
}

/**
 * The review's items from what every chunk filed (F-16.9). In order: a name equal to a record's
 * name or nickname files into that record; any other name goes through the twin gate (a blocked
 * name files into the record it matched, as a nickname with a "same as?" note; a dismissed name is
 * dropped with its lines); a new name filed twice becomes one item. Each line's quote must be in a
 * canon paragraph of the document (3–40 words, `normalizeForMatch`); a line Pinned already says
 * is dropped; a "Label: value" line whose label Pinned holds is an update (Pinned's is empty or
 * the line extends it) or a conflict (they differ; Pinned's is kept by default). A nickname
 * another record owns, or one dismissed for this record, is dropped. A record with nothing left to
 * add is left out. New records come first, then the additions, each in the order first filed.
 */
export function planFiling(input: PlanFilingInput): FilingPlan {
  const dropped: FilingDropped = { quote: 0, duplicate: 0, dismissed: 0, alias: 0 }
  const byNorm = new Map<string, FilingRosterRecord>()
  const owners = new Map<string, { id: string; shared: boolean }[]>()
  for (const record of input.roster) {
    for (const name of record.names) {
      const norm = normName(name.text)
      if (!byNorm.has(norm)) byNorm.set(norm, record)
      owners.set(norm, [...(owners.get(norm) ?? []), { id: record.id, shared: name.shared }])
    }
  }
  const roster = gateRoster(input.roster)
  const rosterById = new Map(input.roster.map((record) => [record.id, record]))

  interface Draft {
    item: FilingItem
    norms: Set<string>
    lineKeys: Set<string>
    pinned: FilingRosterRecord['pinned']
  }
  const drafts: Draft[] = []
  const draftFor = (key: (draft: Draft) => boolean): Draft | undefined => drafts.find(key)
  let lineCounter = 0

  for (const filed of input.records) {
    const name = flat(filed.name).slice(0, RECORD_NAME_MAX).trim()
    if (name === '') continue
    const norm = normName(name)
    let existing = byNorm.get(norm) ?? null
    let sameAs: FilingItem['sameAs'] = null
    if (existing === null) {
      const verdict = twinGate(name, roster, input.dismissedNames)
      if (verdict.outcome === 'blocked') {
        if (verdict.recordId === null) {
          dropped.dismissed += filed.lines.length
          continue
        }
        existing = rosterById.get(verdict.recordId) ?? null
        sameAs = existing === null ? null : { given: name, rule: verdict.rule }
      }
    }

    let draft: Draft | undefined =
      existing === null
        ? draftFor((each) => each.item.recordId === null && each.norms.has(norm))
        : draftFor((each) => each.item.recordId === existing.id)
    if (draft === undefined) {
      draft = {
        item: {
          id: `f${drafts.length + 1}`,
          recordId: existing?.id ?? null,
          name: existing?.name ?? name,
          categoryId: existing?.categoryId ?? filed.categoryId,
          known: existing?.names.map((each) => each.text) ?? [],
          aliases: [],
          lines: [],
          sameAs,
          image: null,
          include: true
        },
        norms: new Set(
          existing === null ? [norm] : existing.names.map((each) => normName(each.text))
        ),
        lineKeys: new Set(),
        pinned: existing?.pinned ?? []
      }
      drafts.push(draft)
    } else if (draft.item.sameAs === null && sameAs !== null) {
      draft.item.sameAs = sameAs
    }
    const item = draft.item

    // Names: the given one (when the gate filed it under another record) and the model's others.
    const candidates = [...(sameAs === null ? [] : [name]), ...filed.aliases]
    for (const raw of candidates) {
      const alias = flat(raw).slice(0, RECORD_ALIAS_MAX).trim()
      const aliasNorm = normName(alias)
      if (alias === '' || draft.norms.has(aliasNorm)) continue
      const taken = (owners.get(aliasNorm) ?? []).some(
        (owner) => owner.id !== item.recordId && !owner.shared
      )
      const dismissed =
        item.recordId !== null && input.dismissedAliases.has(`${item.recordId}|${aliasNorm}`)
      const others = Math.max(0, item.known.length - 1) + item.aliases.length
      if (taken || dismissed || others >= RECORD_ALIASES_MAX) {
        dropped.alias += 1
        continue
      }
      draft.norms.add(aliasNorm)
      item.aliases.push(alias)
    }

    for (const line of filed.lines) {
      const text = lineText(line.text)
      if (text === '') continue
      const para = quoteParagraph(line.q, input.paragraphs)
      if (para === null) {
        dropped.quote += 1
        continue
      }
      const key = normalizeForMatch(text).toLocaleLowerCase()
      if (draft.lineKeys.has(key) || item.lines.length >= FILING_LINES_MAX) {
        dropped.duplicate += 1
        continue
      }
      const related = relateLine(text, draft.pinned)
      if (related === 'duplicate') {
        dropped.duplicate += 1
        continue
      }
      draft.lineKeys.add(key)
      lineCounter += 1
      item.lines.push({
        id: `l${lineCounter}`,
        text,
        quote: flat(line.q),
        para,
        kind: related.kind,
        replaces: related.replaces,
        use: related.kind !== 'conflict'
      })
    }
  }

  // Pictures: a hinted image page goes to the record it names, when that record has none.
  for (const hint of input.imageHints) {
    const page = input.images.find((image) => image.name === hint.file)
    if (page === undefined) continue
    const norm = normName(hint.name)
    const draft = drafts.find((each) => each.norms.has(norm))
    if (draft?.item.image !== null) continue
    const record = draft.item.recordId === null ? null : rosterById.get(draft.item.recordId)
    if (record?.hasImage === true) continue
    draft.item.image = { nodeId: page.nodeId, name: page.name }
  }

  const kept = drafts
    .map((draft) => draft.item)
    .filter((item) =>
      item.recordId === null
        ? item.lines.length > 0
        : item.lines.length > 0 || item.aliases.length > 0 || item.image !== null
    )
  return {
    items: [
      ...kept.filter((item) => item.recordId === null),
      ...kept.filter((item) => item.recordId !== null)
    ],
    dropped
  }
}

/** The dropped counts as the review's header line, or null when nothing was dropped. */
export function droppedLine(dropped: FilingDropped): string | null {
  const parts: string[] = []
  const lines = (n: number): string => `${n} line${n === 1 ? '' : 's'}`
  if (dropped.quote > 0) parts.push(`${lines(dropped.quote)} dropped: quote not in the document`)
  if (dropped.duplicate > 0) parts.push(`${lines(dropped.duplicate)} Pinned already says`)
  if (dropped.dismissed > 0) parts.push(`${lines(dropped.dismissed)} about a name you dismissed`)
  if (dropped.alias > 0) {
    parts.push(`${dropped.alias} nickname${dropped.alias === 1 ? '' : 's'} another record has`)
  }
  return parts.length === 0 ? null : parts.join(' · ')
}

/** Whether an item holds a conflict (the deck's Conflicts group). */
export const hasFilingConflict = (item: FilingItem): boolean =>
  item.lines.some((line) => line.kind === 'conflict')

/** The lines Apply writes for an item: every add and update, and the conflicts the author picked. */
export const writtenLines = (item: FilingItem): FilingLine[] =>
  item.lines.filter((line) => line.use)

/**
 * The review as Apply writes it: an item is included only when its card is accepted, and a
 * proposed category not accepted is declined (its new records go to World, as the upload review
 * does). `accepted(id)` reads the deck's decision for a card.
 */
export function decidedFiling(
  review: FilingReview,
  accepted: (cardId: string) => boolean,
  categoryCardId: (categoryId: string) => string
): FilingReview {
  const declined = new Set(
    review.categories
      .filter((category) => category.proposed && !accepted(categoryCardId(category.id)))
      .map((category) => category.id)
  )
  return {
    ...review,
    categories: review.categories.filter((category) => !declined.has(category.id)),
    items: review.items.map((item) => ({
      ...item,
      categoryId:
        item.recordId === null && declined.has(item.categoryId) ? 'world' : item.categoryId,
      include: accepted(item.id)
    }))
  }
}

// ---------------------------------------------------------------------------------------------
// The review chat's operations (reviewChat.v3)

const SKIP_NOT_FILING = 'not available when filing: text that fits no record stays in the document'

/**
 * The review chat's operations on a pending filing (`reviewChat.v3`), applied in the renderer as
 * v1's are: `merge` (new records into one, or new ones into an existing record; two existing
 * records are merged on their sheets with Same as), `kind` and `rename` (new records only),
 * `aliases` (the new names, minus the ones the record has), `include`. `split`, `toNotes` and
 * `fromNotes` are skipped with why. Pure.
 */
export function applyFilingOps(
  review: FilingReview,
  ops: readonly ReviewOp[]
): { review: FilingReview; changes: ReviewChange[] } {
  let items = review.items.map((item) => ({ ...item, lines: [...item.lines] }))
  const changes: ReviewChange[] = []
  const skip = (text: string): void => void changes.push({ text, itemIds: [], skipped: true })
  const find = (id: string): FilingItem | undefined => items.find((item) => item.id === id)

  for (const op of ops) {
    switch (op.op) {
      case 'merge': {
        const picked = op.items.map(find).filter((item): item is FilingItem => item !== undefined)
        if (picked.length < 2) {
          skip(`Merge: fewer than two of ${op.items.join(', ')} are in the review`)
          break
        }
        const existing = picked.filter((item) => item.recordId !== null)
        if (existing.length > 1) {
          skip(
            `Merge: ${existing.map((i) => i.name).join(' and ')} are both records already; use Same as on a sheet`
          )
          break
        }
        const target = existing[0] ?? picked[0]
        if (target === undefined) break
        const merged: FilingItem = {
          ...target,
          name: target.recordId === null && op.name !== undefined ? op.name : target.name,
          aliases: [...target.aliases],
          lines: [...target.lines]
        }
        const names = new Set([merged.name, ...merged.known, ...merged.aliases].map(normName))
        for (const other of picked) {
          if (other === target) continue
          for (const alias of [other.name, ...other.aliases]) {
            if (names.has(normName(alias))) continue
            names.add(normName(alias))
            merged.aliases.push(alias)
          }
          const keys = new Set(merged.lines.map((line) => normalizeForMatch(line.text)))
          for (const line of other.lines) {
            if (keys.has(normalizeForMatch(line.text))) continue
            keys.add(normalizeForMatch(line.text))
            merged.lines.push(line)
          }
          merged.image ??= other.image
        }
        const gone = new Set(picked.filter((item) => item !== target).map((item) => item.id))
        items = items.flatMap((item) =>
          gone.has(item.id) ? [] : item.id === target.id ? [merged] : [item]
        )
        changes.push({
          text: `Merged ${picked.map((item) => item.name).join(', ')} into ${merged.name}`,
          itemIds: [target.id],
          skipped: false
        })
        break
      }
      case 'kind': {
        const item = find(op.item)
        if (item === undefined) {
          skip(`Category: ${op.item} is not in the review`)
          break
        }
        if (item.recordId !== null) {
          skip(`Category: ${item.name} is a record already; change its category on its sheet`)
          break
        }
        const kind = resolveKind(review, op.kind)
        if (kind === null) {
          skip(`Category: no category called “${op.kind}”`)
          break
        }
        items = items.map((each) => (each.id === item.id ? { ...each, categoryId: kind } : each))
        changes.push({ text: `${item.name} is now ${kind}`, itemIds: [item.id], skipped: false })
        break
      }
      case 'rename': {
        const item = find(op.item)
        if (item?.recordId !== null) {
          skip(`Rename: only a new record can be renamed here (${op.item})`)
          break
        }
        items = items.map((each) => (each.id === item.id ? { ...each, name: op.name } : each))
        changes.push({
          text: `Renamed ${item.name} to ${op.name}`,
          itemIds: [item.id],
          skipped: false
        })
        break
      }
      case 'aliases': {
        const item = find(op.item)
        if (item === undefined) {
          skip(`Nicknames: ${op.item} is not in the review`)
          break
        }
        const own = new Set([item.name, ...item.known].map(normName))
        const seen = new Set<string>()
        const aliases = op.aliases
          .map((alias) => flat(alias).slice(0, RECORD_ALIAS_MAX).trim())
          .filter((alias) => {
            const norm = normName(alias)
            if (alias === '' || own.has(norm) || seen.has(norm)) return false
            seen.add(norm)
            return true
          })
        items = items.map((each) => (each.id === item.id ? { ...each, aliases } : each))
        changes.push({
          text: `${item.name}: new nicknames ${aliases.length > 0 ? aliases.join(', ') : 'none'}`,
          itemIds: [item.id],
          skipped: false
        })
        break
      }
      case 'include': {
        const item = find(op.item)
        if (item === undefined) {
          skip(`Include: ${op.item} is not in the review`)
          break
        }
        items = items.map((each) => (each.id === item.id ? { ...each, include: op.include } : each))
        changes.push({
          text: `${op.include ? 'Included' : 'Left out'} ${item.name}`,
          itemIds: [item.id],
          skipped: false
        })
        break
      }
      case 'split':
      case 'toNotes':
      case 'fromNotes':
        skip(`${op.op}: ${SKIP_NOT_FILING}`)
        break
    }
  }
  return { review: { ...review, items }, changes }
}
