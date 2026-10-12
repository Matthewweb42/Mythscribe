import { straightenQuotes } from '../critique'

/**
 * Marker words (F-16.17; design §2.3, the verification ladder's step 3 and the free re-proof): the
 * words that make a sentence say less than it seems to. Literal proof in code (`literal.ts`) fails
 * when one sits anywhere in the quote's sentence, and the free re-proof (`reproof.ts`) fails when a changed
 * neighbouring sentence brings one. Matching is on whole words, case-insensitively, over straight
 * quotes. The lists are deliberately wide: a miss here only sends a claim to the verifier.
 *
 * Kinds:
 * - `negation`: not, never, no, nor, neither, without, cannot, and any "n't";
 * - `modal`: might, may, could, would, should, must, can, shall, ought, perhaps, maybe, probably,
 *   possibly, likely, seemed, appeared …;
 * - `conditional`: if, unless, whether, suppose, provided, lest, otherwise;
 * - `comparative`: than, more, less, rather, so, such, and "as … as";
 * - `simile`: like, resembled, "as if", "as though";
 * - `pluperfect`: "had" before a past participle ("had fought", "had once been"); a pattern's own
 *   "had <value> <cue>" is excluded by the caller (`ignore`);
 * - `reported`: words that report rather than narrate (said, told, heard, rumoured, believed,
 *   thought, remembered, dreamt, imagined, pretended, wished, lied, according …). Not in the
 *   plan's list: added because a narrated report ("She heard Mara was dead") is not a fact about
 *   Mara (decided by Claude, unconfirmed);
 * - `question`: a question mark ("Mara was dead?" is free indirect wondering, not a statement).
 */

export const MARKER_KINDS = [
  'negation',
  'modal',
  'conditional',
  'comparative',
  'simile',
  'pluperfect',
  'reported',
  'question'
] as const
export type MarkerKind = (typeof MARKER_KINDS)[number]

export interface MarkerHit {
  kind: MarkerKind
  /** The words as written. */
  text: string
  start: number
  end: number
}

const WORDS: Readonly<Record<Exclude<MarkerKind, 'pluperfect' | 'question'>, readonly string[]>> = {
  negation: ['not', 'never', 'no', 'nor', 'neither', 'without', 'cannot'],
  modal: [
    'might',
    'may',
    'could',
    'would',
    'should',
    'must',
    'can',
    'shall',
    'ought',
    'perhaps',
    'maybe',
    'probably',
    'possibly',
    'likely',
    'unlikely',
    'seem',
    'seems',
    'seemed',
    'seeming',
    'appear',
    'appears',
    'appeared'
  ],
  conditional: ['if', 'unless', 'whether', 'suppose', 'supposing', 'provided', 'lest', 'otherwise'],
  comparative: ['than', 'more', 'less', 'rather', 'so', 'such'],
  simile: ['like', 'resembled', 'resembling', 'resembles'],
  reported: [
    'say',
    'says',
    'said',
    'tell',
    'tells',
    'told',
    'claim',
    'claims',
    'claimed',
    'rumour',
    'rumours',
    'rumoured',
    'rumor',
    'rumors',
    'rumored',
    'heard',
    'believe',
    'believes',
    'believed',
    'thought',
    'supposed',
    'supposedly',
    'apparently',
    'imagine',
    'imagined',
    'pretend',
    'pretended',
    'wish',
    'wished',
    'remember',
    'remembered',
    'remembers',
    'recalled',
    'dream',
    'dreams',
    'dreamt',
    'dreamed',
    'dreaming',
    'lie',
    'lied',
    'reported',
    'whispered',
    'swore',
    'insisted',
    'according',
    'fancied',
    'guessed',
    'hoped',
    'feared'
  ]
}

/** Phrases matched as a whole, by kind. */
const PHRASES: readonly { kind: MarkerKind; pattern: RegExp }[] = [
  { kind: 'simile', pattern: /(?<![\p{L}\p{N}])as\s+(?:if|though)(?![\p{L}\p{N}])/giu },
  // "as tall as", "as much as": a comparison of degree.
  { kind: 'comparative', pattern: /(?<![\p{L}\p{N}])as\s+[\p{L}-]+\s+as(?![\p{L}\p{N}])/giu },
  { kind: 'negation', pattern: /[\p{L}]n't(?![\p{L}\p{N}])/giu },
  { kind: 'question', pattern: /\?/gu }
]

/** Past participles that do not end in -ed or -en. */
const IRREGULAR_PARTICIPLES = [
  'been',
  'done',
  'gone',
  'seen',
  'known',
  'fought',
  'thought',
  'brought',
  'bought',
  'taught',
  'caught',
  'sought',
  'learnt',
  'made',
  'said',
  'told',
  'sold',
  'held',
  'left',
  'lost',
  'met',
  'kept',
  'felt',
  'found',
  'heard',
  'come',
  'become',
  'run',
  'begun',
  'won',
  'sat',
  'stood',
  'understood',
  'put',
  'set',
  'let',
  'cut',
  'hit',
  'shut',
  'read',
  'led',
  'fed',
  'fled',
  'bled',
  'slept',
  'wept',
  'swept',
  'spent',
  'sent',
  'lent',
  'bent',
  'built',
  'meant',
  'dealt',
  'dreamt',
  'burnt',
  'spelt',
  'spilt',
  'knelt',
  'got',
  'forgot',
  'sung',
  'rung',
  'drunk',
  'swum',
  'struck',
  'stuck',
  'hung',
  'dug',
  'spun',
  'shot',
  'lit',
  'worn',
  'torn',
  'sworn',
  'born',
  'borne',
  'drawn',
  'grown',
  'thrown',
  'flown',
  'blown',
  'shown',
  'slain',
  'lain',
  'paid',
  'laid',
  'quit',
  'wound',
  'ground',
  'bound'
]

/** Words that end in -ed or -en without being a participle ("had red hair", "had ten thousand"). */
const NOT_PARTICIPLES = [
  'red',
  'bed',
  'shed',
  'sled',
  'need',
  'seed',
  'speed',
  'steed',
  'creed',
  'breed',
  'deed',
  'weed',
  'reed',
  'feed',
  'greed',
  'hundred',
  'sacred',
  'naked',
  'wicked',
  'rugged',
  'ragged',
  'crooked',
  'jagged',
  'beloved',
  'green',
  'golden',
  'wooden',
  'woollen',
  'woolen',
  'ten',
  'seven',
  'eleven',
  'open',
  'even',
  'often',
  'children',
  'garden',
  'heaven',
  'linen',
  'women',
  'men',
  'oxen',
  'chicken',
  'kitchen',
  'sudden',
  'silken',
  'leaden',
  'ashen',
  'olden',
  'oaken',
  'barren',
  'raven',
  'dozen',
  'token',
  'omen',
  'queen',
  'screen',
  'between',
  'siren',
  'citizen',
  'heathen',
  'maiden',
  'burden',
  'warden'
]

/** Adverbs that may sit between "had" and its participle ("had once fought"). */
const PLUPERFECT_ADVERBS = [
  'once',
  'already',
  'long',
  'never',
  'just',
  'always',
  'ever',
  'since',
  'recently',
  'lately',
  'not',
  'also',
  'only',
  'all',
  'often',
  'still',
  'twice',
  'scarcely',
  'hardly',
  'barely',
  'by',
  'then',
  'now',
  'ago'
]

const wordAlternation = (words: readonly string[]): string =>
  [...words].sort((a, b) => b.length - a.length).join('|')

const PLUPERFECT = new RegExp(
  `(?<![\\p{L}\\p{N}])had\\s+(?:(?:${wordAlternation(PLUPERFECT_ADVERBS)})\\s+){0,2}` +
    `(?!(?:${wordAlternation(NOT_PARTICIPLES)})(?![\\p{L}\\p{N}]))` +
    `(?:\\p{L}+(?:ed|en)|${wordAlternation(IRREGULAR_PARTICIPLES)})(?![\\p{L}\\p{N}])`,
  'giu'
)

const WORD_PATTERNS = (Object.keys(WORDS) as (keyof typeof WORDS)[]).map((kind) => ({
  kind,
  pattern: new RegExp(
    `(?<![\\p{L}\\p{N}'])(?:${wordAlternation(WORDS[kind])})(?![\\p{L}\\p{N}])`,
    'giu'
  )
}))

function collect(pattern: RegExp, kind: MarkerKind, text: string, hits: MarkerHit[]): void {
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    hits.push({ kind, text: match[0], start: match.index, end: match.index + match[0].length })
    if (match[0].length === 0) pattern.lastIndex += 1
  }
}

/**
 * Every marker in `text`, by position. `ignore` lists ranges whose hits are dropped (a literal
 * pattern's own "had": `had` starting inside one is not a pluperfect marker).
 */
export function findMarkers(
  text: string,
  options: { ignore?: readonly (readonly [number, number])[] } = {}
): MarkerHit[] {
  const straight = straightenQuotes(text)
  const hits: MarkerHit[] = []
  for (const { kind, pattern } of WORD_PATTERNS) collect(pattern, kind, straight, hits)
  for (const { kind, pattern } of PHRASES) collect(pattern, kind, straight, hits)
  collect(PLUPERFECT, 'pluperfect', straight, hits)
  const ignore = options.ignore ?? []
  return hits
    .filter((hit) => !ignore.some(([from, to]) => hit.start >= from && hit.start < to))
    .sort((a, b) => a.start - b.start || a.end - b.end)
}

/**
 * The marker words of the free re-proof (design §2.3 Invalidation): a literal claim whose quote is
 * still word for word in the text stays live only if the changed neighbouring sentences brought
 * none of these.
 */
export const REPROOF_MARKERS: readonly string[] = [
  'dream',
  'dreams',
  'dreamt',
  'dreamed',
  'dreaming',
  'nightmare',
  'nightmares',
  'woke',
  'awoke',
  'remember',
  'remembered',
  'rumour',
  'rumoured',
  'rumor',
  'rumored',
  'said',
  'if',
  'imagine',
  'imagined',
  'perhaps',
  'maybe',
  'lied',
  'not',
  'never',
  'pretend',
  'pretended',
  'wish',
  'wished',
  'supposed'
]

const REPROOF = new RegExp(
  `(?:(?<![\\p{L}\\p{N}'])(?:${wordAlternation(REPROOF_MARKERS)})(?![\\p{L}\\p{N}]))|[\\p{L}]n't(?![\\p{L}\\p{N}])`,
  'iu'
)

/** Whether `text` holds a re-proof marker word (or any "n't"). */
export function hasReproofMarker(text: string): boolean {
  return REPROOF.test(straightenQuotes(text))
}
