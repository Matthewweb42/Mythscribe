import { z } from 'zod'
import { ClaimMode, ClaimVoice } from './claims'
import type { TopicKind } from './topics'

/**
 * Reading the answers of story memory's reader and checker (F-16.17; plan P2a §2.2, §2.3): the
 * short-key JSON of `reader.v1`/`reader.v2` and `verify.v1`/`verify.v2`, read leniently. An item
 * that does not parse is dropped and counted, never thrown on; a reply cut off at its output cap is
 * read up to its last complete item (`salvageJsonItems`), so a long scene's claims are not all lost
 * to one cut. Pure: the pipeline (`reading/pipeline.ts`) maps the short ids and runs every item
 * through the ladder.
 *
 * P2b (`reader.v2`, plan P2b §2.4 step 1): a `c` item of slot `knows` carries its secret's id in
 * `o`, its `how` and its source in `fr` (its value defaults to the how); a `thread` item's `r` is
 * the thread's id and `how` its step. An `n` item with a `kind` of secret or thread is a topic
 * (`ReaderTopic`): a new one (`x1`, with its label) or a listed one whose reveal is restated. The
 * checker's `how` and `fr` are read as written: an unknown how is no verdict on it.
 */

/** One fact as the reader proposes it, ids still the prompt's short ones ("r12", "c7"). */
export interface ReaderClaim {
  p: number
  /** The roster id; null inside a new name's item, where the name is the subject. */
  r: string | null
  s: string
  v: string
  q: string
  voice: ClaimVoice
  /** The speaker or thinker's roster id. */
  sp: string | null
  mode: ClaimMode
  /** The other record of a kinship or relation fact. */
  o: string | null
  chg: boolean
  /** P2b: a knows line's how, a thread step's step, as written (the pipeline reads them). */
  how: string | null
  /** P2b: a told, overheard or read line's source (a roster id). */
  fr: string | null
}

/**
 * P2b: a secret or thread in `n` (`reader.v2`): a new one (`id` the reader's own, `x1`, and its
 * label), or a listed one whose re-checking reveal the paragraphs still state (`id` its roster id,
 * no label).
 */
export interface ReaderTopic {
  id: string
  kind: TopicKind
  /** The new topic's label as written; null for a listed one's restated reveal. */
  label: string | null
  p: number
  q: string
}

/** A name not on the roster, where the reader saw it, and its facts. */
export interface ReaderName {
  n: string
  p: number
  q: string
  c: ReaderClaim[]
}

/** A card field as the reader answers it: its value, paragraph and quote. */
export interface ReaderCardField {
  value: string
  p: number
  q: string
}

export interface ReaderCard {
  line: string
  gist: string
  where: ReaderCardField | null
  when: ReaderCardField | null
  year: ReaderCardField | null
  elapsed: ReaderCardField | null
  /** The value is a roster id. */
  pov: ReaderCardField | null
  /** The value is `yes` or `no`. */
  flash: ReaderCardField | null
  present: ReaderCardField[]
  mood: string | null
  theme: string | null
}

export interface ReaderAnswer {
  claims: ReaderClaim[]
  names: ReaderName[]
  /** P2b: the secrets and threads in `n`. */
  topics: ReaderTopic[]
  same: string[]
  drop: string[]
  card: ReaderCard | null
  /** Items (claims, names, their claims, card fields) that did not parse. */
  dropped: number
  /** The reply did not parse whole: what is here was salvaged up to the last complete item. */
  salvaged: boolean
}

const Text = z.string().trim().min(1)
const Id = z.string().trim().min(1)
/** An id that may be left out or null, read as null. */
const OptionalId = Id.nullish().transform((value) => value ?? null)

/** A free text that may be left out, null or empty, read as null. */
const OptionalText = z
  .string()
  .nullish()
  .catch(null)
  .transform((value) => {
    const trimmed = value?.trim() ?? ''
    return trimmed === '' ? null : trimmed
  })

const RawClaim = z.object({
  p: z.number().int().nonnegative(),
  r: OptionalId,
  s: Text,
  // A knows line's value is its how (P2b-D6): it may be left out.
  v: OptionalText,
  q: Text,
  // A missing voice or mode reads as narration, now: literal proof still checks the sentence for
  // quotation marks and markers, and the checker confirms both for everything else.
  voice: ClaimVoice.nullish().transform((value) => value ?? 'narration'),
  sp: OptionalId,
  mode: ClaimMode.nullish().transform((value) => value ?? 'now'),
  o: OptionalId,
  chg: z
    .boolean()
    .nullish()
    .transform((value) => value === true),
  how: OptionalText,
  fr: OptionalId.catch(null)
})

/** Reads one claim item; null when it does not parse (a value is needed, but for a knows line). */
function claimOf(raw: unknown): ReaderClaim | null {
  const parsed = RawClaim.safeParse(raw)
  if (!parsed.success) return null
  const { v, ...rest } = parsed.data
  const value = v ?? (rest.s === 'knows' ? rest.how : null)
  return value === null ? null : { ...rest, v: value }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The topic kind an `n` item names, read leniently; null for a name. */
function topicKindOf(raw: Record<string, unknown>): TopicKind | null {
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : ''
  return kind === 'secret' || kind === 'thread' ? kind : null
}

/** Reads one secret or thread item (`reader.v2`); null when it does not parse. */
function topicOf(raw: Record<string, unknown>, kind: TopicKind): ReaderTopic | null {
  const id = Text.safeParse(raw.id)
  const p = z.number().int().nonnegative().safeParse(raw.p)
  const q = Text.safeParse(raw.q)
  if (!id.success || !p.success || !q.success) return null
  const label = Text.safeParse(raw.n)
  return { id: id.data, kind, label: label.success ? label.data : null, p: p.data, q: q.data }
}

/** Reads one new-name item and its claims (each claim's own failures counted in `dropped`). */
function nameOf(raw: unknown): { name: ReaderName | null; dropped: number } {
  if (!isRecord(raw)) return { name: null, dropped: 1 }
  const n = Text.safeParse(raw.n)
  const p = z.number().int().nonnegative().safeParse(raw.p)
  const q = Text.safeParse(raw.q)
  if (!n.success || !p.success || !q.success) return { name: null, dropped: 1 }
  const items = Array.isArray(raw.c) ? raw.c : []
  const claims: ReaderClaim[] = []
  let dropped = 0
  for (const item of items) {
    // A new name's facts are about the name: any "r" is ignored.
    const claim = claimOf(isRecord(item) ? { ...item, r: null } : item)
    if (claim === null) dropped += 1
    else claims.push(claim)
  }
  return { name: { n: n.data, p: p.data, q: q.data, c: claims }, dropped }
}

/** A card field: `[value, p, quote]`; `flash` also takes `[false]` (no quote, nothing to check). */
function fieldOf(raw: unknown): ReaderCardField | null | 'bad' {
  if (raw === null || raw === undefined) return null
  if (!Array.isArray(raw)) return 'bad'
  const [value, p, q] = raw as unknown[]
  const text =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : ''
  if (text === '') return 'bad'
  if (p === undefined && q === undefined) return null
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 0) return 'bad'
  if (typeof q !== 'string' || q.trim() === '') return 'bad'
  return { value: text, p, q: q.trim() }
}

/** Reads the card; its fields that do not parse are left out and counted. */
function cardOf(raw: unknown): { card: ReaderCard | null; dropped: number } {
  if (!isRecord(raw)) return { card: null, dropped: raw === undefined || raw === null ? 0 : 1 }
  const line = Text.safeParse(raw.line)
  const gist = Text.safeParse(raw.gist)
  if (!line.success || !gist.success) return { card: null, dropped: 1 }
  let dropped = 0
  const field = (key: string): ReaderCardField | null => {
    const read = fieldOf(raw[key])
    if (read === 'bad') {
      dropped += 1
      return null
    }
    return read
  }
  const flash = field('flash')
  const present: ReaderCardField[] = []
  for (const entry of Array.isArray(raw.present) ? raw.present : []) {
    const read = fieldOf(entry)
    if (read === null || read === 'bad') dropped += 1
    else present.push(read)
  }
  const short = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : null
  return {
    card: {
      line: line.data,
      gist: gist.data,
      where: field('where'),
      when: field('when'),
      year: field('year'),
      elapsed: field('elapsed'),
      pov: field('pov'),
      flash:
        flash === null
          ? null
          : { ...flash, value: /^(?:true|yes)$/i.test(flash.value) ? 'yes' : 'no' },
      present,
      mood: short(raw.mood),
      theme: short(raw.theme)
    },
    dropped
  }
}

/** Strips a Markdown code fence a model may wrap its JSON in. */
function unfence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
}

/**
 * Where a balanced JSON value starting at `start` ends (the index after it), or -1 when the text
 * ends first. Strings and their escapes are skipped; only `{}` and `[]` nest.
 */
function valueEnd(text: string, start: number): number {
  const open = text[start]
  if (open === '"') {
    for (let i = start + 1; i < text.length; i += 1) {
      if (text[i] === '\\') i += 1
      else if (text[i] === '"') return i + 1
    }
    return -1
  }
  if (open !== '{' && open !== '[') {
    const match = /^[^,\]}\s]+/.exec(text.slice(start))
    return match === null ? -1 : start + match[0].length
  }
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i += 1
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** Where each key of the root object starts its value, for the keys before the text ran out. */
function rootValues(text: string): Map<string, number> {
  const found = new Map<string, number>()
  let i = text.indexOf('{')
  if (i === -1) return found
  i += 1
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i] ?? '')) i += 1
    if (text[i] !== '"') break
    const keyEnd = valueEnd(text, i)
    if (keyEnd === -1) break
    let key: unknown
    try {
      key = JSON.parse(text.slice(i, keyEnd))
    } catch {
      break
    }
    i = keyEnd
    while (i < text.length && /\s/.test(text[i] ?? '')) i += 1
    if (text[i] !== ':') break
    i += 1
    while (i < text.length && /\s/.test(text[i] ?? '')) i += 1
    if (typeof key === 'string') found.set(key, i)
    const end = valueEnd(text, i)
    if (end === -1) break
    i = end
  }
  return found
}

/**
 * The complete items of the root object's array `key` in a reply that does not parse whole (cut
 * off at its output cap): every element up to the last one that closed, each parsed on its own.
 * Elements that do not parse are skipped. Empty when the key never started.
 */
export function salvageJsonItems(text: string, key: string): unknown[] {
  const body = unfence(text)
  const start = rootValues(body).get(key)
  if (start === undefined || body[start] !== '[') return []
  const items: unknown[] = []
  let i = start + 1
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i] ?? '')) i += 1
    if (i >= body.length || body[i] === ']') break
    const end = valueEnd(body, i)
    if (end === -1) break
    try {
      items.push(JSON.parse(body.slice(i, end)))
    } catch {
      // A malformed element is skipped; the next one may still read.
    }
    i = end
  }
  return items
}

/** The root object's value at `key` when it closed, parsed; undefined otherwise. */
function salvageValue(text: string, key: string): unknown {
  const body = unfence(text)
  const start = rootValues(body).get(key)
  if (start === undefined) return undefined
  const end = valueEnd(body, start)
  if (end === -1) return undefined
  try {
    return JSON.parse(body.slice(start, end)) as unknown
  } catch {
    return undefined
  }
}

const ids = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    : []

/**
 * Reads a reader reply. Null when nothing at all could be read (not JSON, and no item salvaged).
 */
export function parseReaderAnswer(text: string): ReaderAnswer | null {
  let root: Record<string, unknown> | null = null
  let salvaged = false
  try {
    const parsed: unknown = JSON.parse(unfence(text))
    if (isRecord(parsed)) root = parsed
  } catch {
    root = null
  }
  if (root === null) {
    salvaged = true
    root = {
      c: salvageJsonItems(text, 'c'),
      n: salvageJsonItems(text, 'n'),
      same: salvageValue(text, 'same'),
      drop: salvageValue(text, 'drop'),
      card: salvageValue(text, 'card')
    }
    const anything =
      (root.c as unknown[]).length > 0 ||
      (root.n as unknown[]).length > 0 ||
      root.same !== undefined ||
      root.card !== undefined
    if (!anything) return null
  }
  const claims: ReaderClaim[] = []
  let dropped = 0
  for (const item of Array.isArray(root.c) ? root.c : []) {
    const claim = claimOf(item)
    if (claim === null) dropped += 1
    else claims.push(claim)
  }
  const names: ReaderName[] = []
  const topics: ReaderTopic[] = []
  for (const item of Array.isArray(root.n) ? root.n : []) {
    const kind = isRecord(item) ? topicKindOf(item) : null
    if (isRecord(item) && kind !== null) {
      const topic = topicOf(item, kind)
      if (topic === null) dropped += 1
      else topics.push(topic)
      continue
    }
    const read = nameOf(item)
    dropped += read.dropped
    if (read.name !== null) names.push(read.name)
  }
  const card = cardOf(root.card)
  dropped += card.dropped
  return {
    claims,
    names,
    topics,
    same: ids(root.same),
    drop: ids(root.drop),
    card: card.card,
    dropped,
    salvaged
  }
}

/** The checker's verdict on one item. */
export interface VerifyVerdict {
  i: number
  ok: boolean
  r: string | null
  voice: ClaimVoice | null
  mode: ClaimMode | null
  /** P2b (`verify.v2`): a knows item's how or a thread item's step, as written. */
  how: string | null
  /** P2b: a knows item's source, an id from its "From". */
  fr: string | null
}

const RawVerdict = z.object({
  i: z.number().int().positive(),
  ok: z.boolean(),
  r: OptionalId.catch(null),
  voice: ClaimVoice.nullish()
    .catch(null)
    .transform((value) => value ?? null),
  mode: ClaimMode.nullish()
    .catch(null)
    .transform((value) => value ?? null),
  how: OptionalText,
  fr: OptionalId.catch(null)
})

/**
 * Reads a checker reply: the verdicts by item number (the first one for a number given twice).
 * An item with no verdict is not supported. Salvaged like the reader's when cut off.
 */
export function parseVerifyAnswer(text: string): Map<number, VerifyVerdict> {
  let items: unknown[]
  try {
    const parsed: unknown = JSON.parse(unfence(text))
    items = isRecord(parsed) && Array.isArray(parsed.v) ? parsed.v : []
  } catch {
    items = salvageJsonItems(text, 'v')
  }
  const verdicts = new Map<number, VerifyVerdict>()
  for (const item of items) {
    const parsed = RawVerdict.safeParse(item)
    if (parsed.success && !verdicts.has(parsed.data.i)) verdicts.set(parsed.data.i, parsed.data)
  }
  return verdicts
}
