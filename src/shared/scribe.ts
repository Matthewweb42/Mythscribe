import { z } from 'zod'
import type { ReasoningMode } from './ai'
import { KnowsHow } from './memory/knows'
import { PassageSource } from './memory/passages'
import { RecordPage, StoryRecord } from './memory/records'
import { SlotSchema } from './memory/slots'
import type { MemoryMeaning, MemorySource } from './memory/sources'
import { AgeYearView, BornView, KnowsCellView, SceneRefView } from './memory/views'

/**
 * Ms Scribe on story memory v2 (F-16.24, F-16.25, F-16.26; plan P3, design §2.6): the shapes the
 * chat's answer path shares between main and the renderer. A chat turn has a **kind**, which sets
 * its reasoning and its output cap; its **evidence** is named by stable keys (`EvidenceKey`) the
 * renderer carries from `ai:navigate` to `ai:agent`, so main keeps no per-turn state (P3-D1); an
 * evidence item has a **label** that says what its text is (design §2.2 "Meaning by place"); a
 * question the memory already answers gets an **instant card** with no AI call; an answer keeps
 * its checked **citations**. Pure: no store, no prompt.
 */

/** What a chat turn is (design §2.6): it sets the turn's reasoning and its output cap. */
export const SCRIBE_TURNS = ['answer', 'lookup', 'idea', 'todo', 'edit', 'draft', 'whatIf'] as const
export const ScribeTurnKind = z.enum(SCRIBE_TURNS)
export type ScribeTurnKind = z.infer<typeof ScribeTurnKind>

/** The reasoning a Ms Scribe request asks for: only ever lowered (`AiRequestInput.reasoning`). */
export type ScribeReasoning = Extract<ReasoningMode, 'off' | 'low'>

/**
 * P3-D11 (design §2.6): reasoning off for answer, lookup, idea and to-do turns; low for edit,
 * draft and what-if turns.
 */
export const SCRIBE_REASONING: Readonly<Record<ScribeTurnKind, ScribeReasoning>> = {
  answer: 'off',
  lookup: 'off',
  idea: 'off',
  todo: 'off',
  edit: 'low',
  draft: 'low',
  whatIf: 'low'
}

/** Each turn's visible output cap (reasoning off). */
const SCRIBE_MAX_TOKENS: Readonly<Record<ScribeTurnKind, number>> = {
  lookup: 300,
  answer: 700,
  idea: 700,
  todo: 700,
  whatIf: 1_000,
  edit: 1_500,
  draft: 1_500
}

/** What a turn with reasoning low adds to its cap: the thinking counts against the same cap. */
export const SCRIBE_REASONING_TOKENS = 1_000

/** A turn's `max_tokens`: its own cap, raised by `SCRIBE_REASONING_TOKENS` with reasoning low. */
export function scribeMaxTokens(
  turn: ScribeTurnKind,
  reasoning: ScribeReasoning = SCRIBE_REASONING[turn]
): number {
  return SCRIBE_MAX_TOKENS[turn] + (reasoning === 'low' ? SCRIBE_REASONING_TOKENS : 0)
}

/** E0, the whole open scene: past this many tokens, the stretch around the caret (P3-D10). */
export const SCRIBE_SCENE_MAX_TOKENS = 12_000
/** The labelled evidence an answer is sent. */
export const SCRIBE_EVIDENCE_TOKENS = 3_000
/** The labelled evidence a lookup turn is sent (design Part 5's lookup row). */
export const SCRIBE_LOOKUP_EVIDENCE_TOKENS = 1_200
/** The earlier turns of the conversation an answer is sent (P3-D12). */
export const SCRIBE_HISTORY_TOKENS = 1_500
/** A Self-Route widening: one chapter or range of whole scenes (P3-D15). */
export const SCRIBE_WIDEN_TOKENS = 8_000
/** The roster in an answer's cached prefix: names and nicknames only. */
export const SCRIBE_ROSTER_TOKENS = 600
/** The navigator's steps per message, its tool calls per step, and Step 0's best hits. */
export const NAVIGATOR_STEPS = 3
export const NAVIGATOR_CALLS_PER_STEP = 3
/** The most lookups one navigation shows in the chat (every call of every step). */
export const NAVIGATOR_TOOL_STEPS_MAX = NAVIGATOR_STEPS * NAVIGATOR_CALLS_PER_STEP
export const NAVIGATOR_MENU_HITS = 12
/** A first/last/ever/never question's hits, in reading order (P3-D8). */
export const ORDINAL_HITS_MAX = 20

/** The most evidence keys, search terms and search hits a navigation carries. */
export const NAVIGATION_EVIDENCE_MAX = 24
export const NAVIGATION_TERMS_MAX = 8
export const NAVIGATION_HITS_MAX = 50
/** The longest search term kept. */
export const NAVIGATION_TERM_MAX = 60

const Para = z.number().int().nonnegative()

/**
 * What a piece of evidence is, by a key that still names it after the book moves on (P3-D1): a
 * read of a scene's paragraphs; one indexed paragraph (scene, notes, Pinned, Ideas, Research); a
 * claim; a scene's card (a map, never citable, P3-D9); who knows a secret; the story years and a
 * record's age; a record's Ideas; the outline; the author's to-dos. `ai:agent` resolves each
 * against the book as it is then (`evidence.ts`).
 */
export const EvidenceKey = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scene'), nodeId: z.string(), from: Para, to: Para }),
  z.object({ kind: z.literal('passage'), source: PassageSource, ownerId: z.string(), para: Para }),
  z.object({ kind: z.literal('claim'), claimId: z.string() }),
  z.object({ kind: z.literal('card'), nodeId: z.string() }),
  z.object({ kind: z.literal('knows'), secretId: z.string() }),
  z.object({ kind: z.literal('timeline'), recordId: z.string().nullable() }),
  z.object({ kind: z.literal('ideas'), recordId: z.string() }),
  z.object({ kind: z.literal('outline') }),
  z.object({ kind: z.literal('todos') })
])
export type EvidenceKey = z.infer<typeof EvidenceKey>

/** Two keys name the same evidence. */
export function sameEvidence(a: EvidenceKey, b: EvidenceKey): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * What an evidence item's text is, as the prompts and the chat word it (design §2.6): the
 * manuscript up to now (`happened`) or after it (`later`); the author's notes and Pinned lines
 * (`notes`); Not canon text; a Pinned line filed from a document (`filed`); the author's Ideas
 * (`idea`); a Research source document (`research`); synopses, briefs, scene notes and planned
 * cards (`planned`); an Idea scene; a scene left out of the book (`cutScene`); a card (`map`);
 * years and ages (`computed`); a to-do.
 */
export const EVIDENCE_LABELS = [
  'happened',
  'later',
  'notes',
  'notCanon',
  'filed',
  'idea',
  'research',
  'planned',
  'ideaScene',
  'cutScene',
  'map',
  'computed',
  'todo'
] as const
export const EvidenceLabel = z.enum(EVIDENCE_LABELS)
export type EvidenceLabel = z.infer<typeof EvidenceLabel>

/** Each label's words in a prompt's evidence tag and in the chat's Sources list. */
export const EVIDENCE_LABEL_WORDS: Readonly<Record<EvidenceLabel, string>> = {
  happened: 'happened',
  later: 'later in the book',
  notes: 'your notes',
  notCanon: 'not canon',
  filed: 'filed from',
  idea: 'your idea',
  research: 'source document',
  planned: 'planned',
  ideaScene: 'idea scene',
  cutScene: 'cut from the book',
  map: 'map, not citable',
  computed: 'computed from your book',
  todo: 'your to-do'
}

/**
 * A label's words in the chat's Sources list (F-16.25, plan P3 §5): the prompt's words, but an Idea
 * says it is not in the book ("your idea, not in the book", design §2.6) and a filed line names its
 * document ("filed from Harbour notes").
 */
export function sourceLabelWords(label: EvidenceLabel, doc: string | null = null): string {
  if (label === 'idea') return 'your idea, not in the book'
  if (label === 'filed') return `${EVIDENCE_LABEL_WORDS.filed} ${doc ?? 'a document'}`
  return EVIDENCE_LABEL_WORDS[label]
}

/** Whether an item with this label may be cited: everything but a map (P3-D9). */
export const citableLabel = (label: EvidenceLabel): boolean => label !== 'map'

/**
 * An evidence item's tag as a prompt shows it: the label's words, then where it is ("happened,
 * 9.3 ¶4"; "filed from Harbour notes, Mara's Pinned ¶3"; "map, not citable, 7.4").
 */
export function evidenceTag(
  label: EvidenceLabel,
  where: string,
  doc: string | null = null
): string {
  const words =
    label === 'filed'
      ? `${EVIDENCE_LABEL_WORDS.filed} ${doc ?? 'a document'}`
      : EVIDENCE_LABEL_WORDS[label]
  return where.trim() === '' ? words : `${words}, ${where}`
}

/** What a paragraph's page says of it beyond its source (`labelOf`). */
export interface LabelMarks {
  /** A Pinned paragraph filed from a document. */
  filed?: boolean
  /** The author marked it, or its page, Not canon. */
  notCanon?: boolean
  /** A Research page that is an uploaded source document (the default for `research`). */
  upload?: boolean
}

/**
 * The one labelling rule (design §2.2 "Meaning by place"; `evidence.ts` labels every item with
 * it): text from `source` (P0's taxonomy) whose meaning from the open scene is `meaning`
 * (`meaningOf`). A manuscript scene by where it sits; a Not canon mark wins over the rest on notes,
 * Pinned, Research and plans; a Pinned paragraph filed from a document is `filed`; a Research page
 * is a source document when uploaded, else the author's notes; anything never real keeps its own
 * place (Ideas, an Idea scene, a cut scene) or reads `notCanon`; plans are `planned`; a card is a
 * map.
 */
export function labelOf(
  source: MemorySource,
  meaning: MemoryMeaning,
  marks: LabelMarks = {}
): EvidenceLabel {
  switch (source) {
    case 'scene':
      return meaning === 'later' ? 'later' : 'happened'
    case 'pinned':
      return marks.notCanon === true ? 'notCanon' : marks.filed === true ? 'filed' : 'notes'
    case 'note':
    case 'research':
      if (marks.notCanon === true) return 'notCanon'
      return (marks.upload ?? source === 'research') ? 'research' : 'notes'
    case 'synopsis':
    case 'brief':
    case 'sceneNote':
    case 'plannedCard':
      return marks.notCanon === true ? 'notCanon' : 'planned'
    case 'idea':
      return 'idea'
    case 'ideaScene':
      return 'ideaScene'
    case 'excludedScene':
      return 'cutScene'
    case 'card':
      return 'map'
    case 'notCanon':
    case 'try':
    case 'chat':
    case 'inactiveDraft':
      return 'notCanon'
  }
}

/** What a search covered (P3-D8): from and to as scene references, with its words. */
export const SearchScope = z.object({
  from: z.string(),
  to: z.string(),
  /** Every scene from the first up to now was searched. */
  allEarlier: z.boolean(),
  /** The whole book was searched (the question asked about the book, not up to now). */
  wholeBook: z.boolean(),
  terms: z.array(z.string().max(NAVIGATION_TERM_MAX)).max(NAVIGATION_TERMS_MAX)
})
export type SearchScope = z.infer<typeof SearchScope>

/** A paragraph a turn's searches returned: the search-miss baseline (P3-D15). */
export const SearchHit = z.object({ nodeId: z.string(), para: Para })
export type SearchHit = z.infer<typeof SearchHit>

/**
 * What `ai:navigate` hands the renderer for an answer turn and the renderer hands `ai:agent`
 * (P3-D1): the turn's kind, the evidence keys, what was searched, and every paragraph the searches
 * returned. Bounded, so a forged one cannot make a request larger.
 */
export const Navigation = z.object({
  turn: ScribeTurnKind,
  evidence: z.array(EvidenceKey).max(NAVIGATION_EVIDENCE_MAX),
  scope: SearchScope.nullable(),
  terms: z.array(z.string().max(NAVIGATION_TERM_MAX)).max(NAVIGATION_TERMS_MAX),
  hits: z.array(SearchHit).max(NAVIGATION_HITS_MAX)
})
export type Navigation = z.infer<typeof Navigation>

/**
 * An instant card (F-16.24): a question the memory answers with no AI call, from a live and
 * uncontested claim (design §2.6). `slot`: a record's value as of now (a lasting one "since 12.1",
 * a transient one "last stated in 13.4"; a stated age only with no time passed since), with
 * `readFirst` when the latest change was read first. `age`: a character's age as of now computed
 * from a birth year and the scene's story year (decision 5, P2b-D15), labelled "computed from your
 * book". `knows`: "does A know X", only ever yes (`source` `author` for her *Knew before the
 * book*). `whoKnows`: the counted holders as of now, readers-since, and `checkedUpTo`, from which
 * the renderer alone words the scoped absence line (P2b rule 9).
 */
export const InstantCard = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('slot'),
    recordId: z.string(),
    name: z.string(),
    slot: SlotSchema,
    label: z.string(),
    value: z.string(),
    claimId: z.string(),
    quote: z.string(),
    ref: z.string(),
    nodeId: z.string(),
    para: Para,
    since: z.string().nullable(),
    lastStated: z.boolean(),
    asOfRef: z.string().nullable(),
    readFirst: z.object({ costUsd: z.number().nonnegative() }).nullable()
  }),
  z.object({
    kind: z.literal('age'),
    recordId: z.string(),
    name: z.string(),
    age: z.number().int().nonnegative(),
    born: BornView,
    year: AgeYearView,
    asOfRef: z.string().nullable(),
    readFirst: z.object({ costUsd: z.number().nonnegative() }).nullable()
  }),
  z.object({
    kind: z.literal('knows'),
    secretId: z.string(),
    secretLabel: z.string(),
    knowerId: z.string(),
    knowerName: z.string(),
    how: KnowsHow,
    source: z.enum(['claim', 'author']),
    fromName: z.string().nullable(),
    claimId: z.string().nullable(),
    quote: z.string().nullable(),
    ref: z.string().nullable(),
    nodeId: z.string().nullable(),
    para: Para.nullable(),
    asOfRef: z.string().nullable(),
    readFirst: z.object({ costUsd: z.number().nonnegative() }).nullable()
  }),
  z.object({
    kind: z.literal('whoKnows'),
    secretId: z.string(),
    label: z.string(),
    readersSince: SceneRefView.nullable(),
    holders: z.array(KnowsCellView),
    checkedUpTo: SceneRefView.nullable(),
    asOfRef: z.string().nullable(),
    readFirst: z.object({ costUsd: z.number().nonnegative() }).nullable()
  })
])
export type InstantCard = z.infer<typeof InstantCard>

/** The most citations one answer keeps. */
export const SCRIBE_CITATIONS_MAX = 8

/** An evidence id as an answer cites it: `E0` the open scene, `E7` an item, `W2` a widened one. */
export const EVIDENCE_ID = /^[EW]\d{1,3}$/

/** Where a citation opens: a scene at its paragraph, a record's Pinned or Ideas, a Research page. */
export const CitationTarget = z.object({
  kind: z.enum(['scene', 'record', 'research']),
  id: z.string(),
  page: RecordPage.optional(),
  para: Para.nullable()
})
export type CitationTarget = z.infer<typeof CitationTarget>

/** One kept citation of an answer: its marker, the item, and how far it was checked. */
export const ScribeCitation = z.object({
  n: z.number().int().positive(),
  evidence: z.string().regex(EVIDENCE_ID),
  label: EvidenceLabel,
  ref: z.string(),
  title: z.string(),
  open: CitationTarget.nullable(),
  quote: z.string(),
  /** `quote`: the quote is in the item as sent; `cite`: the checker also found the sentence supported. */
  checked: z.enum(['quote', 'cite']),
  /** The document a filed Pinned line came from ("filed from <doc>"); null for every other item. */
  doc: z.string().nullable().catch(null).default(null)
})
export type ScribeCitation = z.infer<typeof ScribeCitation>

/** A character range of the answer's text: [start, end). */
export const TextSpan = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
export type TextSpan = z.infer<typeof TextSpan>

/**
 * What a Ms Scribe answer kept (F-16.25): its kind, the citations behind its `[n]` markers, the
 * sentences naming a record or a scene with no kept citation (`notChecked`), the ones the checker
 * found unsupported, the scope line, whether it ended "Not found", whether it was asked again,
 * the chapter a Self-Route widened to, and how many search misses it logged.
 */
export const ScribeTurn = z.object({
  turn: ScribeTurnKind,
  citations: z.array(ScribeCitation).max(SCRIBE_CITATIONS_MAX),
  notChecked: z.array(TextSpan),
  unsupported: z.array(TextSpan),
  scope: z.string().nullable(),
  notFound: z.boolean(),
  retried: z.boolean(),
  widened: z.object({ ref: z.string() }).nullable(),
  misses: z.number().int().nonnegative(),
  /**
   * What the quote checks (`cite.v1`) cost of the turn's total (P3-D23): the chat's cost line lists
   * the navigator's, the answer's and the check's parts. Read leniently: older turns read 0.
   */
  checkUsd: z.number().nonnegative().catch(0).default(0)
})
export type ScribeTurn = z.infer<typeof ScribeTurn>

/** The newest search misses kept (P3-D15); an insert prunes the oldest. */
export const SEARCH_MISS_MAX = 500
/** A miss keeps the author's message cut to this many characters (never sent anywhere). */
export const SEARCH_MISS_QUESTION_MAX = 300
/** A miss keeps the cited quote cut to this many characters. */
export const SEARCH_MISS_QUOTE_MAX = 240
/** The most misses `scribe:searchMisses` lists. */
export const SEARCH_MISSES_LIST_MAX = 50

/** One logged search miss as Settings lists it. */
export const SearchMissView = z.object({
  id: z.string(),
  created: z.string(),
  question: z.string(),
  terms: z.array(z.string()),
  nodeId: z.string(),
  para: Para,
  quote: z.string(),
  promptVersion: z.string()
})
export type SearchMissView = z.infer<typeof SearchMissView>

/** How many misses are kept, and the newest first. */
export const SearchMisses = z.object({
  count: z.number().int().nonnegative(),
  recent: z.array(SearchMissView)
})
export type SearchMisses = z.infer<typeof SearchMisses>

/** The longest line Ms Scribe puts on a sheet (F-16.26), as long as a filed line (`FILING_LINE_MAX`). */
export const SHEET_LINE_MAX = 600
/** A chat turn's id as a sheet line's `aiWritten` mark keeps it. */
export const SheetLineTurn = z.string().min(1).max(100)

/**
 * `record:addLine` (F-16.26, decision 3 as the author changed it): one line the author asked Ms
 * Scribe to put on a record's sheet, at the end of its Pinned or Ideas page, marked `aiWritten`.
 */
export const SheetLineAdd = z.object({
  id: z.string(),
  page: RecordPage,
  text: z.string().trim().min(1).max(SHEET_LINE_MAX),
  turn: SheetLineTurn
})
export type SheetLineAdd = z.infer<typeof SheetLineAdd>

/**
 * What `record:addLine` wrote: the record as it is now, the line's paragraph and words, and the
 * Pinned line it contradicts (the same label, another value), so the chat's confirmation names it.
 */
export const SheetLineResult = z.object({
  record: StoryRecord,
  index: z.number().int().nonnegative(),
  text: z.string(),
  conflict: z.object({ index: z.number().int().nonnegative(), text: z.string() }).nullable()
})
export type SheetLineResult = z.infer<typeof SheetLineResult>

/** `record:removeLine` (the chat's Undo): the line as `record:addLine` answered it. */
export const SheetLineRemove = z.object({
  id: z.string(),
  page: RecordPage,
  index: z.number().int().nonnegative(),
  text: z.string().max(SHEET_LINE_MAX),
  turn: SheetLineTurn
})
export type SheetLineRemove = z.infer<typeof SheetLineRemove>
