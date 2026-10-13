import type { ClaimMode, ClaimVoice } from '@shared/memory/claims'
import type { JudgeVerdict } from '@shared/memory/findings'
import { quoteContext } from '@shared/scribeAnswer'
import { TEST_BOOK, testBookScene } from '../../memory/testBook/book'
import {
  JUDGE_PAIRS_MAX,
  buildJudgeConfirmPrompt,
  buildJudgePrompt,
  judgeItem,
  type JudgeOrder,
  type JudgePair,
  type JudgeQuestion,
  type JudgeSide
} from '../prompts/judge.v1'
import type { EvalCase } from './fixtures'

/**
 * The contradiction judge's cases (F-16.27; plan P4 §2.5), from the test book (`memory/testBook`):
 * each pair rendered as `judge.ts` renders it (its quote's sentence ±1, the scene's place in the
 * book, voice, mode, flashback and typed story year), in batches as the background sends them,
 * and the stronger check's one-pair render (*Check the book*, strong tier). Live
 * (`MYTHSCRIBE_EVAL_LIVE=1`, owed by the author), they score as kind `judge`: the reply parses
 * (`parseJudgeAnswer`, `parseJudgeConfirm`), each verdict is one the case accepts (a planted
 * contradiction `c`; a trap `ok` or `u`), each reason within its word cap, nothing but the schema.
 */

/** A test-book scene's place in reading order, and its reference (`h02` → 7.1). */
const orderOf = (sceneId: string): number => TEST_BOOK.findIndex((each) => each.id === sceneId)
const refOf = (sceneId: string): string => `${testBookScene(sceneId).chapter}.1`

/** A book side: the quote in its paragraph, the sentence ±`around`, as `resolveSide` reads it. */
function book(
  sceneId: string,
  p: number,
  quote: string,
  says: string,
  options: {
    voice?: ClaimVoice | null
    mode?: ClaimMode | null
    flashback?: boolean
    around?: number
  } = {}
): JudgeSide {
  const scene = testBookScene(sceneId)
  const paragraph = scene.paragraphs[p] ?? ''
  const text = quoteContext([paragraph], quote, options.around ?? 1)
  if (text === null) throw new Error(`“${quote}” is not in ${sceneId} ¶${p}`)
  return {
    place: `${refOf(sceneId)} ¶${p}`,
    at: { order: orderOf(sceneId), para: p },
    says,
    voice: options.voice === undefined ? 'narration' : options.voice,
    mode: options.mode === undefined ? 'now' : options.mode,
    flashback: options.flashback ?? false,
    year: scene.details?.year ?? null,
    quote,
    text
  }
}

/** A note side: a line of a record's Pinned page. */
function note(owner: string, line: string, says: string): JudgeSide {
  return {
    place: `${owner}’s Pinned page`,
    at: null,
    says,
    voice: null,
    mode: null,
    flashback: false,
    year: null,
    quote: line,
    text: line
  }
}

const pair = (
  question: JudgeQuestion,
  a: JudgeSide,
  b: JudgeSide,
  between: string[] = []
): JudgePair => ({ question, a, b, between })

/** What a case accepts per item: a planted contradiction `c`; a trap `ok` or `u`; null: any. */
const C: JudgeVerdict[] = ['c']
const NOT_C: JudgeVerdict[] = ['ok', 'u']

/** The planted contradictions, one per rule (and variant), as the book's labels hold them. */
const VARROW = pair(
  { rule: 'C1', name: 'Mr. Varrow', slot: 'eyes' },
  book('s03', 4, "Mr. Varrow's eyes were a cold, clear grey", 'a cold, clear grey'),
  book('h09', 2, "Varrow's brown eyes followed her", 'brown')
)
const HOBB = pair(
  { rule: 'C2', variant: 'dead', name: 'Hobb' },
  book('h03', 3, 'He died in the night, in his chair by the lodge fire', 'died'),
  book('h09', 1, 'Hobb opened the lodge gate for them', 'here', { voice: null, mode: null })
)
const ANNE_HAIR = pair(
  { rule: 'C2', variant: 'body', name: 'Anne', slot: 'hair' },
  book('h15', 2, "Anne's hair was dark under the painter's lamp", 'dark'),
  book('h15', 14, "Anne's fair hair was pinned up for the evening", 'fair')
)
const BEL = pair(
  { rule: 'C3', name: 'Bel', secret: 'the secret engagement' },
  book('h04', 2, 'Lottie is to marry Mr. Dunmore', 'passes it on', { voice: 'dialogue' }),
  book('h05', 2, 'Mr. Dunmore and I are engaged', 'learns it (told)', { voice: 'dialogue' })
)
const ANNE_BORN = pair(
  {
    rule: 'C4',
    variant: 'birth',
    name: 'Anne Fenwick',
    age: 'eighteen',
    born: '1795',
    year: 1815,
    source: 'typed'
  },
  book('h15', 4, 'Anne Fenwick was eighteen', 'age eighteen'),
  book('h15', 3, 'Anne Fenwick was born in 1795', 'born 1795')
)
const LOTTIE_AGE = pair(
  { rule: 'C4', variant: 'falls', name: 'Lottie' },
  book('h14', 11, 'Lottie, who was nineteen', 'age nineteen'),
  book('h15', 9, 'Lottie was seventeen that June', 'age seventeen')
)
const LOTTIE_MATCH = pair(
  { rule: 'C5', thread: 'Lottie’s match' },
  book('h09', 3, 'Lottie was eighteen now, and married', 'resolves: married'),
  book('h15', 13, "the lawyers met again over Lottie's match", 'advances: the settlement moved')
)
const ANNE_EYES = pair(
  { rule: 'C6', name: 'Anne', slot: 'eyes' },
  book('h15', 2, "Anne's eyes were grey", 'grey'),
  note('Anne Fenwick', 'Eyes: blue', 'blue')
)
const CAPTAIN = pair(
  { rule: 'C7', name: 'The Captain', slot: 'history' },
  book('h15', 15, "The Captain's father was a merchant in Vellmouth", 'father a merchant'),
  book('h15', 16, "The Captain's father was a clergyman in Vellmouth", 'father a clergyman')
)

/** The judge's traps: code makes the pair, and both can be true. */
const DUNMORE_LIE = pair(
  { rule: 'C1', name: 'Mr. Dunmore', slot: 'family' },
  book(
    's05',
    1,
    'Mr. Dunmore was the son of the late steward at Greyhallow',
    'son of the late steward'
  ),
  book('h02', 5, 'My father was a clergyman in Elsdale', 'son of a clergyman', {
    voice: 'dialogue'
  })
)
const FUTURE_NOTE = pair(
  { rule: 'C6', name: 'Mr. Fenwick', slot: 'alive' },
  book('h16', 2, 'In those days Mr. Fenwick was alive', 'alive', { flashback: true }),
  note('Mr. Fenwick', 'Dies at Waterloo, 1815.', 'dies at Waterloo, 1815')
)
const REMEMBERED = pair(
  { rule: 'C6', name: 'Mr. Fenwick', slot: 'eyes' },
  book('h15', 6, "Anne remembered Mr. Fenwick's blue eyes", 'blue', { mode: 'memory' }),
  note('Mr. Fenwick', 'Eyes: brown', 'brown')
)
const CUT_SHORT = pair(
  { rule: 'C2', variant: 'body', name: 'Lottie', slot: 'hair' },
  book('h15', 8, "Lottie's hair was long that morning", 'long'),
  book('h15', 12, 'By dinner Lottie had cut her hair short', 'short')
)
const RUMOUR = pair(
  { rule: 'C2', variant: 'dead', name: 'Mr. Fenwick' },
  book('h15', 7, 'It was said in the village that Mr. Fenwick had drowned', 'drowned', {
    voice: 'rumour'
  }),
  book('h16', 2, 'In those days Mr. Fenwick was alive', 'here', {
    voice: null,
    mode: null,
    flashback: true
  })
)
/** A flashback: Hobb at the gate years before his death. */
const FLASHBACK = pair(
  { rule: 'C2', variant: 'dead', name: 'Hobb' },
  book('h03', 3, 'He died in the night, in his chair by the lodge fire', 'died'),
  book('h16', 1, 'Hobb stood at the lodge gate in the rain', 'here', {
    voice: null,
    mode: null,
    flashback: true
  })
)

function batchCase(
  name: string,
  note: string,
  pairs: readonly { pair: JudgePair; accept: JudgeVerdict[] | null }[],
  order: JudgeOrder = 'ab'
): EvalCase {
  const built = buildJudgePrompt(
    pairs.map((each) => judgeItem(each.pair)),
    order
  )
  return {
    version: built.version,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: {
      kind: 'judge',
      accept: pairs.slice(0, built.sent).map((each) => each.accept),
      confirm: false
    }
  }
}

function confirmCase(
  name: string,
  note: string,
  judged: JudgePair,
  accept: JudgeVerdict[] | null
): EvalCase {
  const built = buildJudgeConfirmPrompt(judged)
  return {
    version: built.version,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    tier: 'strong',
    scoring: { kind: 'judge', accept: [accept], confirm: true }
  }
}

/** A side at ±3 sentences, for the stronger check. */
const wide = (side: JudgeSide, sceneId: string, p: number): JudgeSide => {
  const text = quoteContext([testBookScene(sceneId).paragraphs[p] ?? ''], side.quote, 3)
  return text === null ? side : { ...side, text }
}

/** Ten pairs at the item cap: long paragraphs on both sides, two hints, long names. */
function maxedPairs(): JudgePair[] {
  const long = TEST_BOOK.flatMap((scene) => scene.paragraphs).filter((text) => text.length > 300)
  return Array.from({ length: JUDGE_PAIRS_MAX + 2 }, (_, i) => {
    const first = long[i % long.length] ?? ''
    const second = long[(i + 3) % long.length] ?? ''
    const quoteOf = (text: string): string => text.split(/(?<=[.!?”])\s+/u)[1] ?? text.slice(0, 80)
    return pair(
      { rule: 'C1', name: `Mrs. Harriet Pocock-Varrow of Thornmere Hall ${i + 1}`, slot: 'eyes' },
      {
        place: `12.${i + 1} ¶${10 + i}`,
        at: { order: i, para: 10 + i },
        says: 'grey as the sea at Vellmouth in the winter',
        voice: 'narration',
        mode: 'now',
        flashback: false,
        year: 1811,
        quote: quoteOf(first),
        text: first
      },
      {
        place: `13.${i + 1} ¶${11 + i}`,
        at: { order: i + 20, para: 11 + i },
        says: 'brown as the river under the bridge at Elsdale',
        voice: 'thought',
        mode: 'memory',
        flashback: true,
        year: 1815,
        quote: quoteOf(second),
        text: second
      },
      ['Three winters later, when the house had changed hands twice', 'Years passed']
    )
  })
}

/** The stronger check's worst pair: each side's context a whole long scene, the names long. */
function maxedConfirm(): JudgePair {
  const scene = (id: string): string => testBookScene(id).paragraphs.join(' ')
  const [first] = maxedPairs()
  if (first === undefined) return VARROW
  return {
    ...first,
    a: { ...VARROW.a, text: scene('s03') },
    b: { ...VARROW.b, text: scene('h09') }
  }
}

export function judgeEvalCases(): EvalCase[] {
  const planted = [VARROW, BEL, ANNE_EYES]
  return [
    batchCase(
      'typical',
      'three planted pairs as the background sends them (Varrow’s eyes C1, Bel’s secret C3, Anne’s eyes against her note C6): c, c, c',
      planted.map((each) => ({ pair: each, accept: C }))
    ),
    batchCase(
      'typical-swapped',
      'the same three pairs in the second call, the passages swapped (the question unchanged): c, c, c',
      planted.map((each) => ({ pair: each, accept: C })),
      'ba'
    ),
    batchCase(
      'rules',
      'one planted pair per rule and variant (C1, C2 dead and body, C3, C4 birth and falls, C5, C6, C7): all c',
      [VARROW, HOBB, ANNE_HAIR, BEL, ANNE_BORN, LOTTIE_AGE, LOTTIE_MATCH, ANNE_EYES, CAPTAIN].map(
        (each) => ({ pair: each, accept: C })
      )
    ),
    batchCase(
      'traps',
      'pairs code makes that can both be true: a lie in speech, a note about the future, a remembered colour against a note, a haircut the scene shows, a rumoured death: ok or u each',
      [DUNMORE_LIE, FUTURE_NOTE, REMEMBERED, CUT_SHORT, RUMOUR].map((each) => ({
        pair: each,
        accept: NOT_C
      }))
    ),
    batchCase('flashback', 'Hobb alive at the gate in a flashback, years before his death: ok', [
      { pair: FLASHBACK, accept: ['ok'] }
    ]),
    batchCase(
      'maxed',
      'twelve long pairs offered: the batch sends 10 at the item cap (2,500 tokens of pairs, 3,000 in all)',
      maxedPairs().map((each) => ({ pair: each, accept: null }))
    ),
    confirmCase(
      'confirm',
      'the stronger check of Check the book (strong tier): Varrow’s eyes at ±3 sentences: c with a reason',
      pair(VARROW.question, wide(VARROW.a, 's03', 4), wide(VARROW.b, 'h09', 2)),
      C
    ),
    confirmCase(
      'confirm-maxed',
      'the stronger check at its cap: two whole scenes as context, cut around their quotes to fit 1,000 tokens',
      maxedConfirm(),
      null
    )
  ]
}
