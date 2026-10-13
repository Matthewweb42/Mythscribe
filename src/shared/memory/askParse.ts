import { queryTerms } from '../searchTerms'
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
  /**
   * Secrets and threads named by a name or by at least half their label's words; `whole` when by
   * a name or by every one of its label's words (only those may get an instant card).
   */
  topics: { recordId: string; kind: TopicKind; by: 'name' | 'terms'; whole: boolean }[]
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
  const addTopic = (topic: AskTopic, by: 'name' | 'terms', whole: boolean): void => {
    if (!topics.some((each) => each.recordId === topic.recordId)) {
      topics.push({ recordId: topic.recordId, kind: topic.kind, by, whole })
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
        addTopic(topic, 'name', true)
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
    if (content && shared.length * 2 >= topic.terms.length) {
      addTopic(topic, 'terms', shared.length === topic.terms.length)
    }
  }
  return { records, ambiguous, topics }
}

/** A scene or chapter reference a question or an answer names: "14.2", "chapter 9", "scene 3", "ch 9". */
export const SCENE_REF = /\b\d{1,3}\.\d{1,3}\b|\b(?:chapter|ch|scene)\.?\s+(?:\d+|[ivxlc]+)\b/iu

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

/**
 * The words prose uses when it bears on a slot (read-first, P3-D4; a Pinned line a lookup hands
 * over): the question's cues and their word forms ("died", "rode", "wore"). A transient slot's
 * read-first takes any unread sentence naming the record (`instant.ts`); these words still find
 * its Pinned lines ("Home: Vell").
 */
const SLOT_PROSE_WORDS: Readonly<Partial<Record<Slot, readonly string[]>>> = {
  eyes: ['eyed', 'gaze'],
  hair: [
    'haired',
    'curls',
    'braid',
    'braided',
    'braids',
    'plait',
    'plaits',
    'bald',
    'shaved',
    'shorn',
    'dyed'
  ],
  age: ['aged', 'year old', 'turned', 'older', 'younger'],
  born: ['birth'],
  alive: [
    'die',
    'died',
    'dies',
    'dying',
    'death',
    'killed',
    'kills',
    'murdered',
    'slain',
    'buried',
    'grave',
    'corpse',
    'drowned',
    'hanged',
    'perished',
    'lifeless',
    'survived',
    'revived',
    'living'
  ],
  role: [
    'post',
    'office',
    'trade',
    'work',
    'works',
    'worked',
    'employed',
    'appointed',
    'promoted',
    'hired',
    'fired',
    'dismissed',
    'resigned',
    'retired',
    'became',
    'becomes',
    'apprentice'
  ],
  scars: ['scarred'],
  location: [
    'where',
    'home',
    'lives',
    'lived',
    'living',
    'stays',
    'stayed',
    'went',
    'goes',
    'gone',
    'rode',
    'rides',
    'walked',
    'walks',
    'ran',
    'arrived',
    'arrives',
    'left',
    'leaves',
    'reached',
    'returned',
    'returns',
    'moved',
    'moves',
    'entered',
    'enters',
    'travelled',
    'traveled',
    'sailed',
    'fled',
    'came',
    'comes',
    'seen',
    'location'
  ],
  injuries: [
    'injure',
    'wounds',
    'bled',
    'bleeding',
    'blood',
    'broke',
    'broken',
    'bruise',
    'bruised',
    'limp',
    'limped',
    'bandage',
    'bandaged',
    'stabbed',
    'shot',
    'burned',
    'burnt'
  ],
  clothing: [
    'wore',
    'wears',
    'worn',
    'dress',
    'dresses',
    'coat',
    'cloak',
    'gown',
    'boots',
    'hat',
    'shirt',
    'clothes',
    'clothing'
  ],
  objects: ['carried', 'carries', 'held', 'holds', 'clutched', 'gripped', 'pocket', 'satchel'],
  'detail:height': ['tall', 'short'],
  'detail:build': ['thin', 'stout', 'broad', 'slight'],
  'detail:handedness': ['handed'],
  'detail:birthplace': ['born'],
  'detail:mark': ['birthmark', 'tattoo'],
  'detail:home': ['lives', 'lived', 'moved'],
  'detail:occupation': ['job', 'work', 'works', 'trade'],
  'detail:rank': ['promoted'],
  'detail:faith': ['prayed', 'church', 'temple'],
  'detail:allegiance': ['sworn', 'swore', 'joined'],
  'detail:income': ['a year', 'wages'],
  'detail:wealth': ['rich', 'poor', 'fortune'],
  'detail:language': ['speaks', 'spoke', 'tongue'],
  'detail:weapon': ['sword', 'knife', 'blade', 'pistol', 'bow'],
  'detail:illness': ['ill', 'sick', 'fever', 'disease']
}

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

/** `asked` with every one of `phrases` taken out. */
const without = (asked: string, phrases: readonly string[]): string =>
  phrases.reduce((rest, phrase) => rest.split(` ${phrase} `).join(' '), asked)

/** The slots a question's words ask about, each once, in the table's order. */
export function slotCues(text: string): Slot[] {
  const asked = plain(text)
  return SLOT_QUESTION_CUES.filter((row) => any(asked, row.cues)).map((row) => row.slot)
}

/**
 * Whether a sentence's words bear on `slot` (read-first, P3-D4; a Pinned line a lookup hands
 * over): one of its question cues or its prose words.
 */
export function holdsSlotCue(text: string, slot: Slot): boolean {
  const row = SLOT_QUESTION_CUES.find((each) => each.slot === slot)
  const asked = plain(text)
  return (row !== undefined && any(asked, row.cues)) || any(asked, SLOT_PROSE_WORDS[slot] ?? [])
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
/** Phrases holding a scope word that ask about now, not over the book. */
const NOT_SCOPE = ['first name', 'first names', 'last name', 'last names', 'last seen', 'at last']
/** Someone comes to know: learn, find out, hear (P3-D8 searches every earlier scene for it). */
const LEARNS = [
  'learn',
  'learns',
  'learned',
  'learnt',
  'find out',
  'finds out',
  'found out',
  'hear',
  'hears',
  'heard'
]
const KNOWS = ['know', 'knows', 'knew', 'known', 'aware', ...LEARNS]
const IDEA = ['idea', 'ideas', 'brainstorm', 'what did i want']
/** Verbs that ask to put something on a sheet, when the request opens with one. */
const SHEET_VERBS = ['add', 'put', 'pin', 'save', 'note', 'write', 'keep', 'jot', 'file', 'log']
/** Of those, the ones whose "for Mara" names a sheet ("save this for Mara"). */
const KEEP_VERBS = ['pin', 'save', 'note', 'keep', 'jot', 'file', 'log']
const SHEET_WORDS = ['sheet', 'sheets', 'pinned', 'ideas']
/** Verbs that ask for an edit, when the request opens with one (F-5.26's passes among them). */
const CHANGE = [
  'add',
  'change',
  'clean',
  'cut',
  'delete',
  'edit',
  'expand',
  'fix',
  'give',
  'improve',
  'insert',
  'lengthen',
  'make',
  'move',
  'polish',
  'proofread',
  'put',
  'redo',
  'remove',
  'rename',
  'rephrase',
  'replace',
  'revise',
  'reword',
  'rewrite',
  'set',
  'shorten',
  'swap',
  'tighten',
  'trim',
  'update',
  'write'
]
const WHOLE_BOOK = ['in the book', 'by the end', 'ever', 'whole book', 'end of the book']
/** What may open a request before its verb: "please", "can you", "now", "let's". */
const OPENERS = [
  'please',
  'pls',
  'can you',
  'could you',
  'would you',
  'will you',
  'can we',
  'could we',
  "let's",
  'lets',
  'let us',
  'i want you to',
  "i'd like you to",
  'i would like you to',
  'i need you to',
  'go ahead and',
  'now',
  'ok',
  'okay',
  'so',
  'and',
  'also',
  'then',
  'just',
  'next'
]

/**
 * The verbs the request's clauses open with, after any opener ("Great, now fix it" → fix): a
 * clause is what lies between sentence or clause marks. A question opens with no verb of these.
 */
function openingVerbs(text: string): string[] {
  return text
    .split(/[.!?;:,\n]+|\s[-–—]\s/u)
    .map((clause) => plain(clause))
    .flatMap((clause) => {
      let rest = clause
      for (let stripped = true; stripped;) {
        stripped = false
        for (const opener of OPENERS) {
          if (rest.startsWith(` ${opener} `)) {
            rest = rest.slice(opener.length + 1)
            stripped = true
          }
        }
      }
      const first = rest.trim().split(' ')[0] ?? ''
      return first === '' ? [] : [first]
    })
}

/** What kind of question it is (plan P3 §1.2). */
export interface QuestionCues {
  /**
   * first, last, earliest, latest, ever, never, how many, how often, every time (P3-D8); not
   * "first name", "last name", "last seen" or "at last".
   */
  scopeAll: boolean
  /** know, aware, and the `learns` words. */
  knows: boolean
  /** Someone comes to know it: learn, find out, hear. */
  learns: boolean
  /** idea, ideas, brainstorm, "what did I want". */
  idea: boolean
  /**
   * A request to put something on a sheet: it opens with add, put, pin, save, note, write, keep,
   * jot, file or log, and names a sheet (sheet, Pinned, Ideas, an idea) or a record: "to/on Mara",
   * "Mara's", "Mara's sheet", or "for Mara" after pin, save, note, keep, jot, file or log. A
   * chapter or scene is never a sheet.
   */
  sheetWrite: boolean
  /** A request for an edit: it opens with an edit verb (add, change, fix, polish, rewrite, …). */
  change: boolean
  /** It asks about the whole book: "in the book", "by the end", "ever". */
  wholeBook: boolean
}

/**
 * Whether a record the question names is a sheet's target (`questionCues`): written right after
 * to, onto or on (any sheet verb), or for or under (`keep`), or followed by a possessive or
 * "sheet".
 */
function namesSheet(text: string, name: AskName, keep: boolean): boolean {
  const before = text.slice(0, name.start)
  const after = plain(text.slice(name.end))
  if (/['’]s?$/u.test(name.text) || after.startsWith(' sheet ')) return true
  const prepositions = keep ? 'to|onto|on|for|under' : 'to|onto|on'
  return new RegExp(`\\b(?:${prepositions})\\s+$`, 'iu').test(before)
}

/**
 * The question's cues, read from its words; `names` (`namesInQuestion`) lets a record be a sheet
 * write's target.
 */
export function questionCues(text: string, names: AskNames | null = null): QuestionCues {
  const asked = plain(text)
  const verbs = openingVerbs(text)
  const sheetVerb = verbs.some((verb) => SHEET_VERBS.includes(verb))
  const keep = verbs.some((verb) => KEEP_VERBS.includes(verb))
  const idea = any(asked, IDEA)
  const toRecord = (names?.records ?? []).some((name) => namesSheet(text, name, keep))
  const learns = any(asked, LEARNS)
  return {
    scopeAll: any(without(asked, NOT_SCOPE), SCOPE_ALL),
    knows: any(asked, KNOWS),
    learns,
    idea,
    sheetWrite: sheetVerb && (any(asked, SHEET_WORDS) || idea || toRecord),
    change: verbs.some((verb) => CHANGE.includes(verb)),
    wholeBook: any(asked, WHOLE_BOOK)
  }
}

/** Words that ask where something is in the book, not what happens there: never searched for. */
const MENTION = [
  'appear',
  'appears',
  'appeared',
  'appearance',
  'mention',
  'mentions',
  'mentioned',
  'introduce',
  'introduces',
  'introduced',
  'named',
  'show',
  'shows',
  'showed',
  'shown',
  'see',
  'sees',
  'saw',
  'seen',
  'meet',
  'meets',
  'met',
  'meeting',
  'happen',
  'happens',
  'happened',
  'say',
  'says',
  'said',
  'tell',
  'tells',
  'told',
  'time',
  'times',
  'many',
  'often'
]

/** A name's words as the search index holds them ("Mara’s" → mara). */
export const nameWords = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/['’]s?(?![\p{L}\p{N}])/gu, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')

/**
 * What a first / last / ever / never / how-many / knows question searches every earlier scene for
 * (P3-D8): its content words, without the scope and knows cue words, the words that only ask
 * where something is (appear, mentioned, first seen, meet …) and the names it writes (Step 0
 * ranks by those apart); `latest` when it asks for the last time, not the first.
 */
export function ordinalSearch(text: string, names: AskNames): { terms: string[]; latest: boolean } {
  const asked = without(plain(text), NOT_SCOPE)
  const named = new Set(
    [...names.records, ...names.ambiguous].flatMap((name) => nameWords(name.text))
  )
  const rest = without(asked, [...SCOPE_ALL, ...KNOWS, ...MENTION])
  return {
    terms: queryTerms(rest).filter((term) => !named.has(term) && !MENTION.includes(term)),
    latest: any(asked, ['last', 'latest']) && !any(asked, ['first', 'earliest'])
  }
}

/** The most words a question may have for an instant card (P3-D2). */
export const INSTANT_MAX_WORDS = 12

/**
 * Words that ask for more than a value: an opinion, a what-if, or a change (P3-D2), the edit verbs
 * anywhere ("Who cut Mara's hair?" asks about an event, not her hair).
 */
const NOT_INSTANT = [
  'why',
  'how come',
  'should',
  'could',
  'would',
  'what if',
  'suggest',
  'pin',
  'save',
  ...CHANGE
]

/** Words that ask about another time than now: a card is as of now only. */
const ANOTHER_TIME = [
  'before',
  'after',
  'until',
  'till',
  'during',
  'since',
  'then',
  'while',
  'earlier',
  'later',
  'previously',
  'originally',
  'formerly',
  'once',
  'ago',
  'yesterday',
  'used to',
  'at first',
  'at the start',
  'at the beginning',
  'at the end',
  'by the end',
  'at that point',
  'at that time',
  'in chapter',
  'in scene',
  'in part',
  'in the prologue',
  'in the epilogue'
]

/** Words that turn a question round: a card never answers "who does not know". */
const NEGATION = [
  'not',
  'no',
  'no one',
  'nobody',
  'none',
  'noone',
  'nothing',
  'nowhere',
  'neither',
  'nor',
  'dont',
  'doesnt',
  'didnt',
  'isnt',
  'wasnt',
  'arent',
  'werent',
  'hasnt',
  'hadnt',
  'havent',
  'cant',
  'wont'
]

const negated = (asked: string): boolean => any(asked, NEGATION) || asked.includes("n't ")

/** Words that may stand between a slot's cue and the record it asks about ("how old is Mara now"). */
const GLUE = new Set([
  'is',
  'was',
  'are',
  'were',
  'be',
  'been',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'the',
  'a',
  'an',
  'of',
  'now',
  'still',
  'currently',
  'right',
  'today',
  'at',
  'present'
])

const wordsIn = (text: string): string[] => {
  const trimmed = plain(text).trim()
  return trimmed === '' ? [] : trimmed.split(' ')
}

/**
 * Whether one of `slot`'s cues asks about the record named at `name` (not about another thing of
 * it): a possessive name is followed by the cue ("Mara's eyes", never "Mara's mother's eyes" or
 * "Mara's sword"); otherwise the cue stands next to the name with only `GLUE` words between
 * ("How old is Mara now", "Is Mara still alive", "the age of Orrin"; not "the daughter of Orrin").
 */
function cueBinds(text: string, name: AskName, slot: Slot): boolean {
  const cues = (SLOT_QUESTION_CUES.find((row) => row.slot === slot)?.cues ?? []).map((cue) =>
    cue.split(' ')
  )
  const after = wordsIn(text.slice(name.end))
  const starts = (words: string[]): boolean =>
    cues.some((cue) => cue.every((word, i) => words[i] === word))
  if (/['’]s?$/u.test(name.text)) return starts(after)
  for (let rest = after; ; rest = rest.slice(1)) {
    if (starts(rest)) return true
    if (rest.length === 0 || !GLUE.has(rest[0] ?? '')) break
  }
  const before = wordsIn(text.slice(0, name.start))
  const ends = (words: string[]): boolean =>
    cues.some((cue) => cue.every((word, i) => words[words.length - cue.length + i] === word))
  for (let rest = before; ; rest = rest.slice(0, -1)) {
    if (ends(rest)) return true
    if (rest.length === 0 || !GLUE.has(rest.at(-1) ?? '')) return false
  }
}

/** A question an instant card may answer, by its shape (P3-D2). */
export type InstantShape =
  | { kind: 'slot'; recordId: string; slot: Slot }
  | { kind: 'knows'; knowerId: string; secretId: string }
  | { kind: 'whoKnows'; secretId: string }

/**
 * The instant shape of a question (P3-D2), or null. Only a question about now, in at most 12
 * words, may have one: none of why, how come, should, could, would, what if, suggest, pin, save
 * or an edit verb; no request for an edit or a sheet line; no first, last, ever, never or how many
 * (P3-D8 searches every earlier scene for those); no scene or chapter, and no other time (before,
 * after, then, in chapter …; "when" only asks when someone was born); no negation. Then either
 * "who … know" of one secret named whole (the records it names are the secret's own), or "… know
 * …" of one record (never a possessive: "Orrin's sister") and one secret named whole, or one
 * record and exactly one slot cue bound to it (`cueBinds`). A shared name, or two records, is never
 * instant.
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
  const cues = questionCues(text, names)
  if (cues.change || cues.sheetWrite || cues.scopeAll || negated(asked)) return null
  if (SCENE_REF.test(text) || any(asked, ANOTHER_TIME)) return null
  const secrets = names.topics.filter((topic) => topic.kind === 'secret')
  if (cues.knows) {
    const [secret] = secrets
    if (has(asked, 'when') || secrets.length !== 1 || secret?.whole !== true) return null
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
    return others.length === 1 && knower !== undefined && !/['’]s?$/u.test(knower.text)
      ? { kind: 'knows', knowerId: knower.recordId, secretId: secret.recordId }
      : null
  }
  const [record] = names.records
  if (names.records.length !== 1 || record === undefined || names.topics.length > 0) return null
  // The record's own name never counts as a cue ("Hope's age" when a detail is called hope).
  const rest = `${text.slice(0, record.start)} ${text.slice(record.end)}`
  const slots = slotCues(rest)
  const [slot] = slots
  if (slots.length !== 1 || slot === undefined) return null
  if (has(asked, 'when') && slot !== 'born') return null
  return cueBinds(text, record, slot) ? { kind: 'slot', recordId: record.recordId, slot } : null
}
