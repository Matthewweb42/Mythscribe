import { z } from 'zod'
import { HEX_COLOR, TAG_NAME_MAX, TagCategory, toTagName } from './tags'

/**
 * Tag bank exchange and merge bookkeeping (F-4.9). The JSON file is the tag bank out of one
 * project and into another: how a series written as separate projects shares one bank until
 * F-13.1 links projects for real. Ids, dates, usage, and links stay behind; only what defines a
 * tag travels, and a parent travels by name.
 */

/** The `format` field every tag bank file carries, so a file of another kind is refused. */
export const TAG_EXCHANGE_FORMAT_ID = 'mythscribe-tags'
export const TAG_EXCHANGE_VERSION = 1
export const TAG_EXCHANGE_EXTENSION = 'json'

/** One tag as the file holds it. `parent` is the parent's name, null at the top level. */
export const TagExchangeRecord = z.object({
  name: z.string().trim().min(1).max(TAG_NAME_MAX),
  category: TagCategory,
  color: z.string().regex(HEX_COLOR),
  parent: z.string().max(TAG_NAME_MAX).nullable().default(null),
  trackMentions: z.boolean().default(true)
})
export type TagExchangeRecord = z.infer<typeof TagExchangeRecord>

export const TagExchangeFile = z.object({
  format: z.literal(TAG_EXCHANGE_FORMAT_ID),
  version: z.literal(TAG_EXCHANGE_VERSION),
  tags: z.array(TagExchangeRecord)
})
export type TagExchangeFile = z.infer<typeof TagExchangeFile>

/** A file the reader refuses: not JSON, not a tag bank, or a record outside the limits. */
export class TagExchangeError extends Error {
  constructor(
    message: string,
    /** 1-based index of the offending tag in the file's `tags`, when one is to blame. */
    readonly row?: number
  ) {
    super(message)
    this.name = 'TagExchangeError'
  }
}

/** The file text for a bank, pretty-printed so it diffs and reads by hand. */
export function serializeTagBank(records: TagExchangeRecord[]): string {
  const file: TagExchangeFile = {
    format: TAG_EXCHANGE_FORMAT_ID,
    version: TAG_EXCHANGE_VERSION,
    tags: records
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/**
 * Reads a tag bank file. Names (and parent names) come back kebab-cased by `toTagName`; a later
 * record whose name repeats an earlier one is dropped. A record whose name empties after
 * normalization, or any record outside the schema, throws `TagExchangeError` naming the row.
 */
export function parseTagBank(text: string): TagExchangeRecord[] {
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new TagExchangeError('The file is not valid JSON')
  }
  if (typeof json !== 'object' || json === null || !('format' in json)) {
    throw new TagExchangeError('The file is not a MythScribe tag bank')
  }
  if (json.format !== TAG_EXCHANGE_FORMAT_ID) {
    throw new TagExchangeError('The file is not a MythScribe tag bank')
  }
  if (!('version' in json) || json.version !== TAG_EXCHANGE_VERSION) {
    throw new TagExchangeError('The tag bank file is from an unsupported version')
  }
  if (!('tags' in json) || !Array.isArray(json.tags)) {
    throw new TagExchangeError('The tag bank file has no tags list')
  }
  const seen = new Set<string>()
  const records: TagExchangeRecord[] = []
  json.tags.forEach((raw: unknown, index: number) => {
    const row = index + 1
    const parsed = TagExchangeRecord.safeParse(raw)
    if (!parsed.success) throw new TagExchangeError(`Tag ${row} is not valid`, row)
    const name = toTagName(parsed.data.name)
    if (name.length === 0) {
      throw new TagExchangeError(`Tag ${row} has no letters or digits in its name`, row)
    }
    if (seen.has(name)) return
    seen.add(name)
    const parent = parsed.data.parent === null ? null : toTagName(parsed.data.parent)
    records.push({ ...parsed.data, name, parent: parent === '' || parent === name ? null : parent })
  })
  return records
}

/** The default file name for an export: `<project> tags.json`. */
export function tagExportFileName(project: string): string {
  return `${project} tags.${TAG_EXCHANGE_EXTENSION}`
}

/**
 * Settings-table key of the merge aliases: the id of every tag merged away, mapped to the tag it
 * was merged into. Inline tokens (F-4.6) keep the id they were inserted with, so a token of a
 * merged tag resolves through this map instead of falling back to its stored name.
 */
export const TAG_ALIASES_KEY = 'tagAliases'

export const TagAliases = z.record(z.string(), z.string())
export type TagAliases = z.infer<typeof TagAliases>

/**
 * The tag id a token's id stands for now: the id itself when it is in the bank, else where the
 * aliases lead (followed until a live tag, at most as many steps as there are aliases), else the
 * id unchanged, which the caller treats as a deleted tag.
 */
export function resolveTagId(
  id: string,
  aliases: TagAliases,
  exists: (id: string) => boolean
): string {
  let current = id
  for (let step = 0; step <= Object.keys(aliases).length && !exists(current); step++) {
    const next = aliases[current]
    if (next === undefined) return id
    current = next
  }
  return exists(current) ? current : id
}

/**
 * The aliases after merging `sourceIds` into `targetId`: each source points at the target, an
 * alias that pointed at a source is redirected, and the target never aliases anything.
 */
export function mergeAliases(
  aliases: TagAliases,
  sourceIds: string[],
  targetId: string
): TagAliases {
  const sources = new Set(sourceIds)
  const next: TagAliases = {}
  for (const [from, to] of Object.entries(aliases)) {
    if (from === targetId) continue
    next[from] = sources.has(to) ? targetId : to
  }
  for (const id of sourceIds) if (id !== targetId) next[id] = targetId
  return next
}

/** The aliases without any that lead to one of `deletedIds` (the merged tags go with their target). */
export function dropAliasesTo(aliases: TagAliases, deletedIds: string[]): TagAliases {
  const deleted = new Set(deletedIds)
  return Object.fromEntries(Object.entries(aliases).filter(([, to]) => !deleted.has(to)))
}
