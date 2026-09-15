import { z } from 'zod'
import type { VoiceExemplarKind } from './voice'

/**
 * Local stylometrics for the voice profile (F-14.1): deterministic, cheap heuristics over plain
 * text (`docToText`), no AI call. The figures feed `renderVoiceRules`, which turns them into
 * the plain-language lines a prompt carries, and `classifyKind`, which sorts an exemplar or the
 * passage at the caret into dialogue / action / interiority / mixed. None of it is a parser or
 * a POS tagger: pronoun and suffix counts with margins, gated by evidence, and honest about
 * "unknown" when there is not enough of it.
 */

export const Tense = z.enum(['past', 'present', 'mixed', 'unknown'])
export type Tense = z.infer<typeof Tense>
export const Person = z.enum(['first', 'third', 'mixed', 'unknown'])
export type Person = z.infer<typeof Person>

export const Stylometrics = z.object({
  /** Words in the text the figures were computed over. */
  wordCount: z.number().int().nonnegative(),
  /** Words per sentence. */
  sentenceLength: z.object({ median: z.number().nonnegative(), p90: z.number().nonnegative() }),
  /** Words per paragraph, and how many paragraphs there were (the evidence gate). */
  paragraphLength: z.object({
    medianWords: z.number().nonnegative(),
    count: z.number().int().nonnegative()
  }),
  /** Share of the text inside quotation marks, 0–1, and the quoted characters behind it. */
  dialogueRatio: z.number().min(0).max(1),
  dialogueChars: z.number().int().nonnegative(),
  tense: Tense,
  person: Person,
  /** `-ly` adverbs per 100 words. */
  adverbRate: z.number().nonnegative(),
  /** Per 1,000 words. */
  punctuation: z.object({
    commasPer1000: z.number().nonnegative(),
    emDashesPer1000: z.number().nonnegative(),
    semicolonsPer1000: z.number().nonnegative(),
    exclamationsPer1000: z.number().nonnegative(),
    questionsPer1000: z.number().nonnegative()
  }),
  /** Share of dialogue tags that are said/asked, over `sampleSize` tags found. */
  tagVerbs: z.object({ saidRatio: z.number().min(0).max(1), sampleSize: z.number().int() }),
  /** The most frequent lexicon verbs, base form, most frequent first, at most ten. */
  topVerbs: z.array(z.string()).max(10)
})
export type Stylometrics = z.infer<typeof Stylometrics>

/** A sentence end: terminal punctuation, optional closing quotes or brackets, then whitespace or the end. */
const SENTENCE_END = /[.!?…]+["”’')\]]*(?=\s|$)/g

/** Quoted spans, straight or curly, for the dialogue ratio. */
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g

/** Words that end in `ly` but are not manner adverbs (or are too common to say anything). */
const NOT_ADVERB = new Set([
  'apply',
  'imply',
  'reply',
  'supply',
  'rely',
  'multiply',
  'comply',
  'ally',
  'family',
  'only',
  'holy',
  'ugly',
  'silly',
  'bully',
  'folly',
  'rally',
  'tally',
  'belly',
  'jelly',
  'lily',
  'chilly',
  'early',
  'fly',
  'july',
  'italy',
  'lonely',
  'friendly',
  'lovely',
  'deadly',
  'likely',
  'unlikely',
  'elderly',
  'orderly',
  'lively',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'sly',
  'ply'
])

const IRREGULAR_PAST = new Set([
  'was',
  'were',
  'had',
  'did',
  'went',
  'said',
  'knew',
  'felt',
  'saw',
  'came',
  'took',
  'got',
  'thought',
  'told',
  'found',
  'gave',
  'looked',
  'seemed'
])
const PRESENT_MARKERS = new Set(['is', 'are', 'am', 'has', 'have', 'does', 'do'])
/** Third-person pronouns before which an `-s` word counts as a present-tense verb. */
const THIRD_SUBJECT = new Set(['he', 'she', 'it'])
/** `-s` words after a pronoun that are not verbs (or are counted elsewhere). */
const NOT_PRESENT_VERB = new Set(['is', 'was', 'has', 'does', 'his', 'hers', 'its', 'this', 'us'])

const FIRST_PERSON = new Set(['i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours'])
const THIRD_PERSON = new Set([
  'he',
  'she',
  'they',
  'him',
  'her',
  'them',
  'his',
  'hers',
  'their',
  'theirs'
])

/** Verbs that tag dialogue; the first two are the "plain" tags the ratio measures. */
const SAID_TAGS = new Set(['said', 'says', 'asked', 'asks'])
const OTHER_TAGS = new Set([
  'replied',
  'replies',
  'whispered',
  'whispers',
  'shouted',
  'shouts',
  'muttered',
  'mutters',
  'murmured',
  'murmurs',
  'answered',
  'answers',
  'called',
  'calls',
  'cried',
  'cries',
  'yelled',
  'yells',
  'snapped',
  'snaps',
  'hissed',
  'hisses',
  'growled',
  'growls',
  'sighed',
  'sighs',
  'laughed',
  'laughs',
  'added',
  'adds',
  'continued',
  'continues',
  'began',
  'begins',
  'demanded',
  'demands',
  'insisted',
  'insists',
  'exclaimed',
  'exclaims',
  'breathed',
  'breathes',
  'offered',
  'offers',
  'agreed',
  'agrees',
  'admitted',
  'admits',
  'warned',
  'warns',
  'suggested',
  'suggests',
  'observed',
  'observes',
  'remarked',
  'remarks',
  'repeated',
  'repeats',
  'spat',
  'spits',
  'barked',
  'barks',
  'screamed',
  'screams',
  'groaned',
  'groans',
  'moaned',
  'moans',
  'mused',
  'muses',
  'drawled',
  'drawls',
  'stammered',
  'stammers',
  'mumbled',
  'mumbles',
  'grumbled',
  'grumbles',
  'pleaded',
  'pleads',
  'urged',
  'urges',
  'echoed',
  'echoes',
  'wondered',
  'wonders',
  'announced',
  'announces',
  'declared',
  'declares',
  'protested',
  'protests',
  'ordered',
  'orders',
  'promised',
  'promises',
  'explained',
  'explains',
  'interrupted',
  'interrupts',
  'went',
  'goes',
  'told',
  'tells'
])

/** The words right after a closing quote (`" she said`) or right before an opening one (`she said, "`). */
const AFTER_QUOTE = /["”]\s+([\p{L}']+)(?:\s+([\p{L}']+))?/gu
const BEFORE_QUOTE = /([\p{L}']+)\s+([\p{L}']+),?\s*["“]/gu

/** Verbs the frequency list ignores: auxiliaries, modals, and the near-meaningless get/go. */
const VERB_STOPLIST = new Set([
  'be',
  'is',
  'was',
  'were',
  'am',
  'are',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'shall',
  'should',
  'can',
  'could',
  'may',
  'might',
  'must',
  'get',
  'got',
  'go',
  'going'
])

/** A curated lexicon of common narrative verbs, base form; inflections are matched by `stemOf`. */
const VERB_LEXICON = new Set([
  'walk',
  'run',
  'move',
  'turn',
  'look',
  'see',
  'watch',
  'stare',
  'glance',
  'gaze',
  'hear',
  'listen',
  'feel',
  'touch',
  'hold',
  'grab',
  'take',
  'give',
  'pull',
  'push',
  'lift',
  'drop',
  'throw',
  'catch',
  'reach',
  'open',
  'close',
  'shut',
  'sit',
  'stand',
  'lie',
  'lean',
  'step',
  'climb',
  'fall',
  'jump',
  'kneel',
  'crouch',
  'stumble',
  'stagger',
  'stride',
  'wander',
  'follow',
  'lead',
  'leave',
  'arrive',
  'enter',
  'wait',
  'stop',
  'start',
  'begin',
  'end',
  'finish',
  'try',
  'want',
  'need',
  'know',
  'think',
  'believe',
  'remember',
  'forget',
  'wonder',
  'realize',
  'understand',
  'decide',
  'notice',
  'sense',
  'imagine',
  'hope',
  'fear',
  'wish',
  'love',
  'hate',
  'like',
  'say',
  'tell',
  'ask',
  'answer',
  'speak',
  'talk',
  'call',
  'shout',
  'whisper',
  'laugh',
  'cry',
  'smile',
  'frown',
  'nod',
  'shake',
  'shrug',
  'sigh',
  'breathe',
  'gasp',
  'swallow',
  'blink',
  'wince',
  'flinch',
  'tremble',
  'shiver',
  'freeze',
  'burn',
  'break',
  'cut',
  'hit',
  'strike',
  'kick',
  'punch',
  'fight',
  'kill',
  'die',
  'live',
  'sleep',
  'wake',
  'dream',
  'eat',
  'drink',
  'cook',
  'read',
  'write',
  'draw',
  'play',
  'work',
  'build',
  'make',
  'find',
  'lose',
  'keep',
  'bring',
  'carry',
  'send',
  'show',
  'hide',
  'search',
  'seek',
  'meet',
  'join',
  'help',
  'save',
  'let',
  'put',
  'set',
  'pass',
  'cross',
  'ride',
  'drive',
  'fly',
  'swim',
  'sail',
  'spin',
  'duck',
  'sprint',
  'raise',
  'lower',
  'wear',
  'buy',
  'sell',
  'pay',
  'count',
  'stay',
  'remain',
  'seem',
  'appear',
  'become',
  'change',
  'grow',
  'rise',
  'sink',
  'spread',
  'fill',
  'pour',
  'wash',
  'clean',
  'press',
  'squeeze',
  'twist',
  'tear',
  'slam',
  'knock',
  'ring',
  'sing',
  'dance',
  'hum',
  'pray',
  'curse',
  'swear',
  'promise',
  'refuse',
  'agree',
  'argue',
  'explain',
  'mean'
])

/** Irregular past and participle forms mapped onto their lexicon base. */
const IRREGULAR_BASE: Record<string, string> = {
  ran: 'run',
  saw: 'see',
  seen: 'see',
  took: 'take',
  taken: 'take',
  gave: 'give',
  given: 'give',
  knew: 'know',
  known: 'know',
  felt: 'feel',
  thought: 'think',
  told: 'tell',
  found: 'find',
  held: 'hold',
  stood: 'stand',
  sat: 'sit',
  fell: 'fall',
  fallen: 'fall',
  drew: 'draw',
  drawn: 'draw',
  threw: 'throw',
  thrown: 'throw',
  spoke: 'speak',
  spoken: 'speak',
  broke: 'break',
  broken: 'break',
  wore: 'wear',
  worn: 'wear',
  caught: 'catch',
  bought: 'buy',
  brought: 'bring',
  fought: 'fight',
  left: 'leave',
  kept: 'keep',
  slept: 'sleep',
  met: 'meet',
  led: 'lead',
  heard: 'hear',
  made: 'make',
  said: 'say',
  shook: 'shake',
  shaken: 'shake',
  rose: 'rise',
  risen: 'rise',
  drove: 'drive',
  driven: 'drive',
  rode: 'ride',
  ridden: 'ride',
  wrote: 'write',
  written: 'write',
  woke: 'wake',
  woken: 'wake',
  struck: 'strike',
  flew: 'fly',
  flown: 'fly',
  lay: 'lie',
  lain: 'lie',
  hid: 'hide',
  hidden: 'hide',
  sang: 'sing',
  sung: 'sing',
  sank: 'sink',
  sunk: 'sink',
  swam: 'swim',
  swum: 'swim',
  began: 'begin',
  begun: 'begin',
  spun: 'spin',
  tore: 'tear',
  torn: 'tear',
  froze: 'freeze',
  frozen: 'freeze',
  forgot: 'forget',
  forgotten: 'forget',
  understood: 'understand',
  became: 'become',
  built: 'build',
  sent: 'send',
  lost: 'lose',
  knelt: 'kneel',
  meant: 'mean',
  grew: 'grow',
  grown: 'grow',
  ate: 'eat',
  eaten: 'eat',
  drank: 'drink',
  drunk: 'drink',
  paid: 'pay',
  put: 'put',
  set: 'set',
  let: 'let',
  cut: 'cut',
  hit: 'hit',
  shut: 'shut',
  read: 'read',
  spread: 'spread',
  rang: 'ring',
  rung: 'ring',
  swore: 'swear',
  sworn: 'swear',
  tried: 'try',
  cried: 'cry',
  carried: 'carry',
  buried: 'bury',
  died: 'die',
  lied: 'lie'
}

/** Physical-action cues for `classifyKind`. */
const ACTION_CUES = new Set([
  'ran',
  'grabbed',
  'turned',
  'walked',
  'threw',
  'hit',
  'jumped',
  'reached',
  'pulled',
  'pushed',
  'spun',
  'ducked',
  'sprinted',
  'punched',
  'drew',
  'raised',
  'runs',
  'grabs',
  'turns',
  'walks',
  'throws',
  'hits',
  'jumps',
  'reaches',
  'pulls',
  'pushes',
  'spins',
  'ducks',
  'sprints',
  'punches',
  'draws',
  'raises'
])
/** Interiority cues for `classifyKind`. */
const INTERIORITY_CUES = new Set([
  'thought',
  'knew',
  'felt',
  'wondered',
  'realized',
  'remembered',
  'believed',
  'understood',
  'wished',
  'hoped',
  'feared',
  'decided',
  'noticed',
  'sensed',
  'thinks',
  'knows',
  'feels',
  'wonders',
  'realizes',
  'remembers',
  'believes',
  'understands',
  'wishes',
  'hopes',
  'fears',
  'decides',
  'notices',
  'senses'
])

/** Under this many words, a passage is always `mixed`: there is not enough signal to say. */
export const KIND_MIN_WORDS = 40
/** Dialogue from this share of quoted text up. */
export const KIND_DIALOGUE_RATIO = 0.4
/** The cue count that must beat the other by this factor to win. */
const KIND_MARGIN = 1.3

/** Evidence margin for tense and person: the winner needs twice the loser's count. */
const MARGIN = 2
/** Fewer markers than this and the classification is `unknown`. */
const MIN_MARKERS = 5

/** The text's words as lowercase letter tokens, apostrophes kept ("didn't"), everything else dropped. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).map((t) => t.replace(/^'+|'+$/g, ''))
}

function countWords(text: string): number {
  let n = 0
  for (const token of text.split(/\s+/)) if (token.length > 0) n += 1
  return n
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index]!
}

/** The word counts of the text's sentences (split on `SENTENCE_END`), empty ones dropped. */
function sentenceLengths(text: string): number[] {
  const lengths: number[] = []
  let last = 0
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length
    const words = countWords(text.slice(last, end))
    if (words > 0) lengths.push(words)
    last = end
  }
  const tail = countWords(text.slice(last))
  if (tail > 0) lengths.push(tail)
  return lengths
}

/** The share of the text inside quotation marks and the quoted characters, exported for `classifyKind` and tests. */
export function dialogueRatio(text: string): { ratio: number; chars: number } {
  if (text.length === 0) return { ratio: 0, chars: 0 }
  let chars = 0
  for (const match of text.matchAll(QUOTED)) chars += match[0].length
  return { ratio: Math.min(1, chars / text.length), chars }
}

function classifyTense(tokens: string[]): Tense {
  let past = 0
  let present = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (IRREGULAR_PAST.has(token) || (token.length >= 4 && token.endsWith('ed'))) past += 1
    else if (PRESENT_MARKERS.has(token)) present += 1
    else if (
      i > 0 &&
      THIRD_SUBJECT.has(tokens[i - 1]!) &&
      token.length >= 3 &&
      token.endsWith('s') &&
      !NOT_PRESENT_VERB.has(token)
    ) {
      present += 1
    }
  }
  return decide(past, present, 'past', 'present')
}

function classifyPerson(tokens: string[]): Person {
  let first = 0
  let third = 0
  for (const token of tokens) {
    if (FIRST_PERSON.has(token)) first += 1
    else if (THIRD_PERSON.has(token)) third += 1
  }
  return decide(first, third, 'first', 'third')
}

function decide<A extends string, B extends string>(
  a: number,
  b: number,
  aLabel: A,
  bLabel: B
): A | B | 'mixed' | 'unknown' {
  if (a + b < MIN_MARKERS) return 'unknown'
  if (a >= MARGIN * b) return aLabel
  if (b >= MARGIN * a) return bLabel
  return 'mixed'
}

function adverbCount(tokens: string[]): number {
  let n = 0
  for (const token of tokens) {
    if (token.length >= 4 && token.endsWith('ly') && !NOT_ADVERB.has(token)) n += 1
  }
  return n
}

function countChar(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length
}

/** Dialogue tags found next to quotes: how many, and how many of them were said/asked. */
function tagVerbs(text: string): { saidRatio: number; sampleSize: number } {
  let plain = 0
  let total = 0
  const consider = (words: (string | undefined)[]): void => {
    for (const raw of words) {
      const word = raw?.toLowerCase()
      if (word === undefined) continue
      if (SAID_TAGS.has(word)) {
        plain += 1
        total += 1
        return
      }
      if (OTHER_TAGS.has(word)) {
        total += 1
        return
      }
    }
  }
  for (const match of text.matchAll(AFTER_QUOTE)) consider([match[1], match[2]])
  for (const match of text.matchAll(BEFORE_QUOTE)) consider([match[1], match[2]])
  return { saidRatio: total === 0 ? 0 : plain / total, sampleSize: total }
}

/** The lexicon base form of a token, or undefined when it is not a lexicon verb. */
function stemOf(token: string): string | undefined {
  const irregular = IRREGULAR_BASE[token]
  if (irregular !== undefined) return VERB_LEXICON.has(irregular) ? irregular : undefined
  if (VERB_LEXICON.has(token)) return token
  const candidates: string[] = []
  const push = (stem: string): void => {
    if (stem.length >= 2) candidates.push(stem)
  }
  for (const suffix of ['ing', 'ed', 'es', 's', 'd']) {
    if (!token.endsWith(suffix)) continue
    const stem = token.slice(0, -suffix.length)
    push(stem)
    push(`${stem}e`)
    if (stem.length >= 3 && stem.at(-1) === stem.at(-2)) push(stem.slice(0, -1))
    if (stem.endsWith('i')) push(`${stem.slice(0, -1)}y`)
  }
  return candidates.find((c) => VERB_LEXICON.has(c))
}

function topVerbs(tokens: string[]): string[] {
  const counts = new Map<string, number>()
  for (const token of tokens) {
    if (VERB_STOPLIST.has(token)) continue
    const base = stemOf(token)
    if (base === undefined || VERB_STOPLIST.has(base)) continue
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([verb]) => verb)
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/** The stylometrics of a plain-text passage; empty text answers zeros and `unknown`s. */
export function computeStylometrics(text: string): Stylometrics {
  const tokens = tokenize(text)
  const wordCount = countWords(text)
  const per1000 = (n: number): number => (wordCount === 0 ? 0 : round1((n / wordCount) * 1000))
  const sentences = sentenceLengths(text)
  const paragraphs = text
    .split(/\n+/)
    .map(countWords)
    .filter((n) => n > 0)
  const dialogue = dialogueRatio(text)
  return {
    wordCount,
    sentenceLength: { median: median(sentences), p90: percentile(sentences, 0.9) },
    paragraphLength: { medianWords: median(paragraphs), count: paragraphs.length },
    dialogueRatio: dialogue.ratio,
    dialogueChars: dialogue.chars,
    tense: classifyTense(tokens),
    person: classifyPerson(tokens),
    adverbRate: wordCount === 0 ? 0 : round1((adverbCount(tokens) / wordCount) * 100),
    punctuation: {
      commasPer1000: per1000(countChar(text, /,/g)),
      emDashesPer1000: per1000(countChar(text, /—|--/g)),
      semicolonsPer1000: per1000(countChar(text, /;/g)),
      exclamationsPer1000: per1000(countChar(text, /!/g)),
      questionsPer1000: per1000(countChar(text, /\?/g))
    },
    tagVerbs: tagVerbs(text),
    topVerbs: topVerbs(tokens)
  }
}

/** Words of evidence most rules need before they say anything. */
export const RULE_MIN_WORDS = 200
/** Quoted characters before the dialogue-ratio line is emitted. */
export const RULE_MIN_DIALOGUE_CHARS = 200
/** Paragraphs before the paragraph-length and semicolon-absence lines are emitted. */
export const RULE_MIN_PARAGRAPHS = 10
/** Words before the top-verbs line is emitted. */
export const RULE_MIN_WORDS_VERBS = 300
/** Dialogue tags before the tag-verb line is emitted. */
export const RULE_MIN_TAGS = 3
/** At most this many lines. */
export const RULE_MAX_LINES = 8

/**
 * The plain-language voice rules a prompt carries: a fixed-priority list of candidates, each
 * gated on its own evidence, the first eight that pass kept. A short manuscript yields fewer
 * lines, possibly none; the confidence indicator is what tells the author why.
 */
export function renderVoiceRules(stats: Stylometrics): string[] {
  const lines: string[] = []
  const enough = stats.wordCount >= RULE_MIN_WORDS

  if (enough) {
    const median = Math.round(stats.sentenceLength.median)
    const p90 = Math.round(stats.sentenceLength.p90)
    let line =
      median < 12
        ? `Short sentences, median ${median} words.`
        : median <= 20
          ? `Sentences run to a median of ${median} words.`
          : `Long, flowing sentences, median ${median} words.`
    if (p90 - median > 15) line += ` Some run much longer, up to ${p90} words.`
    lines.push(line)
  }

  if (stats.dialogueChars >= RULE_MIN_DIALOGUE_CHARS) {
    lines.push(`About ${Math.round(stats.dialogueRatio * 100)}% of the prose is dialogue.`)
  }

  if (stats.tense === 'past' || stats.tense === 'present') {
    lines.push(`Narration is in ${stats.tense} tense.`)
  }

  if (stats.person === 'first' || stats.person === 'third') {
    lines.push(`Narration is in ${stats.person} person.`)
  }

  if (stats.tagVerbs.sampleSize >= RULE_MIN_TAGS) {
    const percent = Math.round(stats.tagVerbs.saidRatio * 100)
    lines.push(`Dialogue tags are 'said' or 'asked' ${percent}% of the time.`)
  }

  const { medianWords, count } = stats.paragraphLength
  if (count >= RULE_MIN_PARAGRAPHS && (medianWords < 40 || medianWords > 90)) {
    const words = Math.round(medianWords)
    lines.push(
      medianWords < 40
        ? `Short paragraphs, typically ${words} words.`
        : `Long paragraphs, typically ${words} words.`
    )
  }

  if (enough && (stats.adverbRate < 1.5 || stats.adverbRate > 4)) {
    lines.push(
      stats.adverbRate < 1.5
        ? `Uses -ly adverbs sparingly (${stats.adverbRate} per 100 words).`
        : `Adverbs are frequent (${stats.adverbRate} per 100 words).`
    )
  }

  if (enough) {
    const p = stats.punctuation
    if (p.semicolonsPer1000 > 3) lines.push('Uses semicolons often.')
    else if (p.semicolonsPer1000 < 0.3 && count >= RULE_MIN_PARAGRAPHS)
      lines.push('Almost never uses semicolons.')
    else if (p.emDashesPer1000 > 5) lines.push('Reaches for em dashes often.')
    else if (p.exclamationsPer1000 > 8) lines.push('Uses exclamation marks freely.')
  }

  if (stats.wordCount >= RULE_MIN_WORDS_VERBS && stats.topVerbs.length >= 5) {
    lines.push(`Frequently used verbs: ${stats.topVerbs.slice(0, 5).join(', ')}.`)
  }

  return lines.slice(0, RULE_MAX_LINES)
}

/**
 * What kind of prose a passage mostly is: dialogue from 40% quoted text up; else the physical
 * cues against the interiority cues, the higher winning by a 1.3× margin; `mixed` under 40
 * words (an exemplar that short, or a caret window that short, carries no usable signal).
 */
export function classifyKind(text: string): VoiceExemplarKind {
  const tokens = tokenize(text)
  if (countWords(text) < KIND_MIN_WORDS) return 'mixed'
  if (dialogueRatio(text).ratio >= KIND_DIALOGUE_RATIO) return 'dialogue'
  let action = 0
  let interiority = 0
  for (const token of tokens) {
    if (ACTION_CUES.has(token)) action += 1
    else if (INTERIORITY_CUES.has(token)) interiority += 1
  }
  if (action > 0 && action >= KIND_MARGIN * interiority) return 'action'
  if (interiority > 0 && interiority >= KIND_MARGIN * action) return 'interiority'
  return 'mixed'
}
