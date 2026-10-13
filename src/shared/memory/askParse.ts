import { caseForm, normName } from './names'
import type { NameIndex } from './nameScan'
import { DETAIL_LABEL_NAMES, type Slot } from './slots'
import type { RecordKind } from './records'
import { isNamedKind, isTopicKind, topicTerms, type TopicKind, type TopicName } from './topics'

/**
 * How Ms Scribe reads a chat question before any AI is asked (F-16.24; plan P3 §1.2): which
 * records, secrets and threads it names, which slot it asks about, and what kind of question it
 * is. Pure and local: Step 0 and the instant rules call it in main; nothing here is sent.
 */

/** A secret or thread as a question may name it: by one of its names, or by its label's words. */
export interface AskTopic {
  recordId: string
  kind: TopicKind
  /** Its names' norms (`normName`): the label and any the author added. */
  norms: readonly string[]
  /** `topicTerms` of its label: content words, with records' names folded to `@<recordId>`. */
  terms: readonly string[]
}

/** What a question is read against: the name scan's index, the topics, and the roster's names. */
export interface AskIndex {
  names: NameIndex
  topics: readonly AskTopic[]
  /** The named records' names, for `topicTerms` (`NAMED_KINDS` only). */
  roster: readonly TopicName[]
}

/** A record as `buildAskIndex` reads it (a `StoryRecordSummary`). */
export interface AskRecord {
  id: string
  kind: RecordKind
  name: string
  aliases: readonly { text: string; norm: string }[]
}

/**
 * The index a question is read against: the name scan's index (`nameScanShared`), the secrets
 * and threads with their names' norms and their label's words, and the named records' names.
 */
export function buildAskIndex(names: NameIndex, records: readonly AskRecord[]): AskIndex {
  const roster: TopicName[] = records
    .filter((record) => isNamedKind(record.kind))
    .flatMap((record) => record.aliases.map((alias) => ({ recordId: record.id, text: alias.text })))
  const topics: AskTopic[] = records.flatMap((record) =>
    isTopicKind(record.kind)
      ? [
          {
            recordId: record.id,
            kind: record.kind,
            norms: record.aliases.map((alias) => alias.norm).filter((norm) => norm !== ''),
            terms: topicTerms(record.name, '', roster)
          }
        ]
      : []
  )
  return { names, topics, roster }
}

/** One name the question writes: the record it names, and where. */
export interface AskName {
  recordId: string
  text: string
  start: number
  end: number
}

/** What a question names. */
export interface AskNames {
  /** Records named for certain, once each, in the question's order. */
  records: AskName[]
  /** Names several records share ("Harrow"): never counted as naming one. */
  ambiguous: { recordIds: string[]; text: string }[]
  /** Secrets and threads named by a name or by at least half their label's words. */
  topics: { recordId: string; kind: TopicKind; by: 'name' | 'terms' }[]
}

interface Word {
  start: number
  end: number
}

/** The question's words with their offsets: letters and digits, with inner apostrophes, dots and hyphens. */
function wordsOf(text: string): Word[] {
  return [...text.matchAll(/[\p{L}\p{N}](?:[\p{L}\p{N}'’.-]*[\p{L}\p{N}])?(?:['’]s?)?\.?/gu)].map(
    (match) => ({ start: match.index, end: match.index + match[0].length })
  )
}

/** The most words a norm in `norms` has. */
const mostWords = (norms: Iterable<string>): number => {
  let most = 1
  for (const norm of norms) most = Math.max(most, norm.split(' ').length)
  return most
}

const foldFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

/**
 * The records, secrets and threads a question names (identity rules over a question): records'
 * names and nicknames matched over word n-grams, the longest first, possessives counted, in any
 * case except a name the author keeps in its exact case (`exact`: "Will" is not "will"; the
 * question's first word may differ in its first letter only); a name several records share is
 * `ambiguous`; only `NAMED_KINDS` (the index holds no others). Secrets and threads are named by one
 * of their names, or by at least half their label's words, one of them a content word.
 */
export function namesInQuestion(text: string, index: AskIndex): AskNames {
  const words = wordsOf(text)
  const records: AskName[] = []
  const ambiguous: AskNames['ambiguous'] = []
  const topicNorms = new Map<string, AskTopic>()
  for (const topic of index.topics) for (const norm of topic.norms) topicNorms.set(norm, topic)
  const most = Math.max(mostWords(index.names.byNorm.keys()), mostWords(topicNorms.keys()))
  const topics: AskNames['topics'] = []
  const addTopic = (topic: AskTopic, by: 'name' | 'terms'): void => {
    if (!topics.some((each) => each.recordId === topic.recordId)) {
      topics.push({ recordId: topic.recordId, kind: topic.kind, by })
    }
  }
  let i = 0
  while (i < words.length) {
    let matched = 0
    for (let n = Math.min(most, words.length - i); n >= 1 && matched === 0; n -= 1) {
      const first = words[i]
      const last = words[i + n - 1]
      if (first === undefined || last === undefined) continue
      const span = text.slice(first.start, last.end)
      const norm = normName(span)
      const topic = topicNorms.get(norm)
      if (topic !== undefined) {
        addTopic(topic, 'name')
        matched = n
        continue
      }
      const entries = index.names.byNorm.get(norm)
      if (entries === undefined) continue
      const form = caseForm(span)
      const ids = [
        ...new Set(
          entries
            .filter(
              (alias) =>
                alias.rule !== 'exact' ||
                form === alias.form ||
                (i === 0 && foldFirst(form) === foldFirst(alias.form))
            )
            .map((alias) => alias.recordId)
        )
      ]
      if (ids.length === 0) continue
      matched = n
      const written = span.replace(/[.]$/, '')
      if (ids.length > 1) {
        ambiguous.push({ recordIds: ids, text: written })
        continue
      }
      const [recordId] = ids
      if (recordId !== undefined && !records.some((each) => each.recordId === recordId)) {
        records.push({ recordId, text: written, start: first.start, end: last.end })
      }
    }
    i += matched === 0 ? 1 : matched
  }
  // Secrets and threads by their label's words: half of them at least, a content word among them.
  const asked = new Set(topicTerms(text, '', index.roster))
  for (const topic of index.topics) {
    if (topic.terms.length === 0) continue
    const shared = topic.terms.filter((term) => asked.has(term))
    const content = shared.some((term) => !term.startsWith('@'))
    if (content && shared.length * 2 >= topic.terms.length) addTopic(topic, 'terms')
  }
  return { records, ambiguous, topics }
}

/**
 * The words that ask about a slot (P3-D2): a closed table, each `detail:` label by its own name.
 * Accumulating slots (traits, history, relation) and kinship are never asked here: they go to
 * Ms Scribe.
 */
export const SLOT_QUESTION_CUES: readonly { slot: Slot; cues: readonly string[] }[] = [
  { slot: 'eyes', cues: ['eye', 'eyes', 'eye colour', 'eye color'] },
  { slot: 'hair', cues: ['hair'] },
  { slot: 'age', cues: ['age', 'how old', 'years old'] },
  { slot: 'born', cues: ['born', 'birthday', 'birth year'] },
  { slot: 'location', cues: ['where is', "where's", 'where was', 'last seen'] },
  { slot: 'alive', cues: ['alive', 'dead', 'still living'] },
  { slot: 'role', cues: ['role', 'job', 'position'] },
  { slot: 'scars', cues: ['scar', 'scars'] },
  { slot: 'injuries', cues: ['hurt', 'injured', 'wound', 'wounded', 'injury', 'injuries'] },
  { slot: 'clothing', cues: ['wearing', 'dressed'] },
  { slot: 'objects', cues: ['carrying', 'holding'] },
  ...DETAIL_LABEL_NAMES.map((label) => ({ slot: `detail:${label}` as const, cues: [label] }))
]

/** The question as the cue tables read it: lower case, straight apostrophes, single spaces. */
const plain = (text: string): string =>
  ` ${text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim()} `

/** Whether `phrase` (lower case, words separated by single spaces) is in `asked` as whole words. */
const has = (asked: string, phrase: string): boolean => asked.includes(` ${phrase} `)

const any = (asked: string, phrases: readonly string[]): boolean =>
  phrases.some((phrase) => has(asked, phrase))

/** The slots a question's words ask about, each once, in the table's order. */
export function slotCues(text: string): Slot[] {
  const asked = plain(text)
  return SLOT_QUESTION_CUES.filter((row) => any(asked, row.cues)).map((row) => row.slot)
}

/** Whether a sentence's words hold one of `slot`'s cues (read-first, P3-D4). */
export function holdsSlotCue(text: string, slot: Slot): boolean {
  const row = SLOT_QUESTION_CUES.find((each) => each.slot === slot)
  return row !== undefined && any(plain(text), row.cues)
}

const SCOPE_ALL = [
  'first',
  'last',
  'earliest',
  'latest',
  'ever',
  'never',
  'how many',
  'how often',
  'every time'
]
const KNOWS = [
  'know',
  'knows',
  'knew',
  'known',
  'learn',
  'learns',
  'learned',
  'learnt',
  'find out',
  'finds out',
  'found out',
  'hear',
  'hears',
  'heard',
  'aware'
]
const IDEA = ['idea', 'ideas', 'brainstorm', 'what did i want']
const SHEET_VERBS = ['add', 'put', 'pin', 'save', 'note down', 'write down']
const SHEET_WORDS = ['sheet', 'sheets', 'pinned', 'ideas']
const CHANGE = ['add', 'change', 'cut', 'fix', 'insert', 'move', 'rename', 'rewrite', 'write']
const WHOLE_BOOK = ['in the book', 'by the end', 'ever', 'whole book', 'end of the book']

/** What kind of question it is (plan P3 §1.2). */
export interface QuestionCues {
  /** first, last, earliest, latest, ever, never, how many, how often, every time (P3-D8). */
  scopeAll: boolean
  /** know, learn, find out, heard, aware. */
  knows: boolean
  /** idea, ideas, brainstorm, "what did I want". */
  idea: boolean
  /**
   * A request to put something on a sheet: pin; or add, put, save … sheet, Pinned, Ideas, an idea,
   * or to/on/for a name.
   */
  sheetWrite: boolean
  /** A request for an edit: add, change, cut, fix, insert, move, rename, rewrite, write. */
  change: boolean
  /** It asks about the whole book: "in the book", "by the end", "ever". */
  wholeBook: boolean
}

/** The question's cues, read from its words. */
export function questionCues(text: string): QuestionCues {
  const asked = plain(text)
  const verb = any(asked, SHEET_VERBS)
  // "to Mara", "on the Bell", "for Mara": a capitalised word after it, as the author wrote it.
  const toName = /\b(?:to|on|for|onto|in)\s+(?:the\s+)?[\p{Lu}\p{Lt}]/u.test(text)
  const idea = any(asked, IDEA)
  return {
    scopeAll: any(asked, SCOPE_ALL),
    knows: any(asked, KNOWS),
    idea,
    // "Save this idea", "brainstorm: …; save it": a line for Ideas.
    sheetWrite: has(asked, 'pin') || (verb && (any(asked, SHEET_WORDS) || toName || idea)),
    change: any(asked, CHANGE),
    wholeBook: any(asked, WHOLE_BOOK)
  }
}

/** The most words a question may have for an instant card (P3-D2). */
export const INSTANT_MAX_WORDS = 12

/** Words that ask for more than a value: an opinion, a what-if, or a change (P3-D2). */
const NOT_INSTANT = [
  'why',
  'how come',
  'should',
  'could',
  'would',
  'what if',
  'suggest',
  'write',
  'make',
  'change',
  'edit',
  'add',
  'save',
  'pin'
]

/** A question an instant card may answer, by its shape (P3-D2). */
export type InstantShape =
  | { kind: 'slot'; recordId: string; slot: Slot }
  | { kind: 'knows'; knowerId: string; secretId: string }
  | { kind: 'whoKnows'; secretId: string }

/**
 * The instant shape of a question (P3-D2), or null: at most 12 words; none of why, how come,
 * should, could, would, what if, suggest, write, make, change, edit, add, save, pin; and either
 * "who … know" of one secret (the records it names are the secret's own), or "… know …" of one
 * record and one secret, or one record and exactly one slot cue. A shared name, or two records,
 * is never instant.
 */
export function instantShape(
  text: string,
  names: AskNames,
  topics: readonly AskTopic[] = []
): InstantShape | null {
  const asked = plain(text)
  const count = asked.trim() === '' ? 0 : asked.trim().split(' ').length
  if (count === 0 || count > INSTANT_MAX_WORDS) return null
  if (any(asked, NOT_INSTANT) || names.ambiguous.length > 0) return null
  const secrets = names.topics.filter((topic) => topic.kind === 'secret')
  if (any(asked, KNOWS)) {
    const [secret] = secrets
    if (secrets.length !== 1 || secret === undefined) return null
    const own = new Set(
      (topics.find((topic) => topic.recordId === secret.recordId)?.terms ?? [])
        .filter((term) => term.startsWith('@'))
        .map((term) => term.slice(1))
    )
    const others = names.records.filter((name) => !own.has(name.recordId))
    if (has(asked, 'who')) {
      return others.length === 0 ? { kind: 'whoKnows', secretId: secret.recordId } : null
    }
    const [knower] = others
    return others.length === 1 && knower !== undefined
      ? { kind: 'knows', knowerId: knower.recordId, secretId: secret.recordId }
      : null
  }
  const [record] = names.records
  if (names.records.length !== 1 || record === undefined || names.topics.length > 0) return null
  // The record's own name never counts as a cue ("Hope's age" when a detail is called hope).
  const rest = `${text.slice(0, record.start)} ${text.slice(record.end)}`
  const slots = slotCues(rest)
  const [slot] = slots
  return slots.length === 1 && slot !== undefined
    ? { kind: 'slot', recordId: record.recordId, slot }
    : null
}
