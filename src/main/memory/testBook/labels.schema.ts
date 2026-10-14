import { z } from 'zod'
import { ROUTE_ACTIONS, ROUTE_EDIT_PASSES, ROUTE_EDIT_TARGETS } from '@shared/assistantRoute'
import { KNOWS_HOWS } from '@shared/memory/knows'
import { RECORD_PAGES } from '@shared/memory/records'
import { THREAD_STEPS } from '@shared/memory/topics'

/**
 * The shape of the test book's labels (F-16.3): what a correct reading of `TEST_BOOK` yields,
 * scene by scene, for the P2a reader and verifier scoring (claims), P1's name matching and twin
 * gate (records, mentions, twin cases), P2b's who-knows-what (knows lines, thread steps, years and
 * ages), P4's contradiction rules (planted contradictions, the "must not produce" negatives, who
 * is on the page, the author's notes and the loose ends), and P3's Ms Scribe (record pages and the
 * questions she is asked). Test data only:
 * nothing in the app imports it.
 */

const Id = z.string().regex(/^[a-z][a-z0-9-]*$/)
const SceneId = z.string().regex(/^[sh]\d{2}$/)
/** A slot from the design's closed list (§2.2), or `detail:<label>` / `relation:<record>`. */
const Slot = z
  .string()
  .regex(
    /^(eyes|born|species|kinship|hair|alive|role|age|scars|location|injuries|clothing|objects|traits|history|knows|thread|detail:[a-z]+|relation:[a-z][a-z0-9-]*)$/
  )

export const RECORD_KINDS = [
  'character',
  'place',
  'thing',
  'group',
  'term',
  'secret',
  'thread'
] as const

export const LabelAlias = z.object({
  text: z.string().min(1),
  /** Several records may own the alias's norm only when every one marks it shared (§2.2 rule 4). */
  shared: z.boolean().default(false)
})

export const LabelRecord = z.object({
  id: Id,
  name: z.string().min(1),
  kind: z.enum(RECORD_KINDS),
  aliases: z.array(LabelAlias).min(1),
  /** For a secret: who it started with and the sentence that reveals it (§2.5). */
  originator: Id.optional(),
  /** For a secret or thread: the sentence that reveals it or opens it (P2b-D3). */
  defining: z.object({ scene: SceneId, p: z.number().int().min(0), quote: z.string() }).optional(),
  /**
   * A record added with P2b's scenes (h13, h14) or P4's (h15, h16): left out of the `reader.v1`
   * eval cases' roster, so their token rows stay as P2a wrote them.
   */
  addedFor: z.enum(['P2b', 'P4']).optional()
})

export const CLAIM_VOICES = ['narration', 'dialogue', 'thought', 'rumour'] as const
export const CLAIM_MODES = ['now', 'memory', 'hypothetical', 'dream'] as const
export const CLAIM_EXPECTS = ['literal', 'verified', 'reject'] as const

export const LabelClaim = z.object({
  id: Id,
  scene: SceneId,
  /** The paragraph the quote is in. */
  p: z.number().int().min(0),
  record: Id,
  slot: Slot,
  value: z.string().min(1),
  quote: z.string().min(1),
  voice: z.enum(CLAIM_VOICES),
  /** The speaker or thinker for `dialogue` and `thought`. */
  speaker: Id.optional(),
  mode: z.enum(CLAIM_MODES),
  /** How a correct pipeline ends: proved in code, proved by the verifier, or not stored. */
  expect: z.enum(CLAIM_EXPECTS),
  /** P4: the second record of a kinship claim (a relation names it in its slot). */
  object: Id.optional(),
  /** P4: the sentence states a change ("had cut her hair short"). */
  change: z.boolean().optional(),
  reason: z.string().min(1)
})

export const LabelMentions = z.object({ scene: SceneId, records: z.array(Id).min(1) })

export const TWIN_RULES = ['alias', 'wordSubset', 'prefix', 'edit', 'dismissed'] as const

export const LabelTwinCase = z.object({
  name: z.string().min(1),
  outcome: z.enum(['blocked', 'new']),
  /** The record that blocks it, absent for `new` and for a Dismissed name. */
  blockedBy: Id.optional(),
  rule: z.enum(TWIN_RULES).optional(),
  reason: z.string().min(1)
})

/** The knows vocabulary, as the app spells it (`@shared/memory/knows`). */
export const KNOWS_HOW = KNOWS_HOWS

export const LabelKnows = z.object({
  secret: Id,
  learner: Id,
  how: z.enum(KNOWS_HOW),
  from: Id.nullable(),
  scene: SceneId,
  p: z.number().int().min(0),
  quote: z.string().min(1),
  /**
   * How the text gives it (P2b-D7; added for the slice 3 replays): narration, or dialogue with its
   * `speaker` (the learner's own words for tells and refers, the source's for told and read).
   */
  voice: z.enum(['narration', 'dialogue', 'thought']).default('narration'),
  speaker: Id.optional()
})

/**
 * A thread step (P2b): the thread, the step, where, and its mode; only a step in mode `now` and
 * not a rumour moves the thread's status (P2b-D22), the rest are listed muted.
 */
export const LabelThreadStep = z.object({
  thread: Id,
  how: z.enum(THREAD_STEPS),
  scene: SceneId,
  p: z.number().int().min(0),
  quote: z.string().min(1),
  voice: z.enum(['narration', 'dialogue', 'thought', 'rumour']).default('narration'),
  mode: z.enum(['now', 'memory', 'hypothetical', 'dream']).default('now')
})

const SceneQuote = z.object({ p: z.number().int().min(0), quote: z.string().min(1) })

/**
 * Each readable scene's story year as decision 5 computes it from the typed details and the
 * card's labelled fields (`elapsed`: the hint the card quotes; `quotedYear`: a year the text
 * states; `flashback`): the year and where it came from, or not known with the hint that ended
 * the carry.
 */
export const LabelYear = z.object({
  scene: SceneId,
  year: z.number().int().nullable(),
  source: z.enum(['typed', 'quoted', 'carried', 'unknown']),
  /** The scene a carried year comes from. */
  from: SceneId.optional(),
  /** The scene whose hint ended the carry, for an unknown year. */
  hint: SceneId.optional(),
  elapsed: SceneQuote.optional(),
  quotedYear: SceneQuote.extend({ value: z.string().min(1) }).optional(),
  flashback: z.boolean().default(false),
  /** P4: the sentence that shows the scene is a flashback (the card's verified `flashback`). */
  flashbackQuote: SceneQuote.optional()
})

/**
 * A character's age as of a scene (decision 5): computed from a birth year, or the last stated
 * age (the claim label) with what changed since, listed, never added: the scenes of the
 * year-crossing hints and of the typed or quoted years that differ from the year before (each
 * scene once).
 */
export const LabelAge = z.object({
  record: Id,
  scene: SceneId,
  expect: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('computed'), age: z.number().int(), from: SceneId }),
    z.object({
      kind: z.literal('stated'),
      claim: Id,
      since: z.array(SceneId)
    })
  ])
})

const QuoteRef = z.object({ scene: SceneId, p: z.number().int().min(0), quote: z.string().min(1) })

export const CONTRADICTION_RULES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'] as const

/** P4: a line of the author's notes (a record's Pinned page, or a Research page by its title). */
const NoteRef = z.object({
  record: Id.optional(),
  research: z.string().min(1).optional(),
  quote: z.string().min(1)
})

export const LabelContradiction = z.object({
  rule: z.enum(CONTRADICTION_RULES),
  /** P4: C2's `dead` or `body`, C4's `birth` or `falls`. */
  variant: z.enum(['dead', 'body', 'birth', 'falls']).optional(),
  record: Id,
  a: QuoteRef,
  /** The book's other side; absent when the other side is a note (C6). */
  b: QuoteRef.optional(),
  /** P4: the note side of a C6 pair. */
  note: NoteRef.optional(),
  /**
   * P4: a pair that needs a scene not to be a flashback, in a scene that is one: a candidate code
   * makes and hides (Check the book lists it with *Not a flashback?*), never a finding as it is.
   */
  hidden: z.boolean().default(false),
  reason: z.string().min(1)
})

export const LabelNegative = z.object({
  scene: SceneId,
  /**
   * What must not come out of it: a stored claim, a finding, a new record, a state change, or
   * (P2b) a counted knows line (`record` the learner it must not name, `secret` the secret).
   */
  kind: z.enum(['claim', 'finding', 'record', 'state', 'knows']),
  record: Id.optional(),
  secret: Id.optional(),
  slot: Slot.optional(),
  rule: z.enum(CONTRADICTION_RULES).optional(),
  /**
   * P4, a finding negative only: code makes the candidate and the judge must rule it fine (a lie
   * in speech against the narration, a remembered colour against a note); without it, code makes
   * no candidate at all.
   */
  candidate: z.boolean().default(false),
  reason: z.string().min(1)
})

/** P4: a record on the page in a scene, by the quote that shows it (the card's `present`). */
export const LabelPresence = z.object({
  scene: SceneId,
  record: Id,
  p: z.number().int().min(0),
  quote: z.string().min(1)
})

/**
 * P4: a line of the author's notes the contradictions read: a record's Pinned page, or a Research
 * page (written in MythScribe, canon) by its title.
 */
export const LabelNote = z.object({
  record: Id.optional(),
  research: z.string().min(1).optional(),
  lines: z.array(z.string().min(1)).min(1)
})

/** P4: a loose end as of the end of the book (F-16.29): a thread, a character or a planned card. */
export const LabelLooseEnd = z.object({
  kind: z.enum(['thread', 'character', 'planned']),
  /** The thread's or character's record, or the planned card's scene. */
  id: z.string().min(1),
  /** Where it was last touched (none for a planned card). */
  last: SceneId.optional(),
  reason: z.string().min(1)
})

/**
 * P3 (F-16.24–F-16.26): a line the author wrote on a record's Pinned or Ideas page, so Ms Scribe
 * has canon notes and ideas to recall ("your idea, not in the book").
 */
export const LabelPage = z.object({
  record: Id,
  page: z.enum(RECORD_PAGES),
  lines: z.array(z.string().min(1)).min(1)
})

/** What a question asks of Ms Scribe (plan P3 §6.1). */
export const QUESTION_KINDS = [
  /** A record's value the memory holds: an instant card, no request. */
  'slot',
  /** Does A know X, when A does: an instant card. */
  'knows',
  /** Who knows X: an instant card. */
  'whoKnows',
  /** A stale or contested value: a lookup turn, no navigator request. */
  'lookupStale',
  /** An open question the navigator searches for. */
  'open',
  /** First, last, ever, never, how many: the answer says it searched every earlier scene. */
  'ordinal',
  /** Someone who never learns a secret: a scoped answer, never "does not know" as fact. */
  'absence',
  /** The author's idea recalled, labelled "your idea, not in the book". */
  'idea',
  /** A question the book does not answer: "Not found in the manuscript (I looked in …)". */
  'notFound',
  /** A request the navigator routes to an action (F-5.26's edit passes among them). */
  'route',
  /** A line the author asks Ms Scribe to put on a sheet (decision 3 as the author changed it). */
  'pin',
  /**
   * A question only a source that is not the book answers (an Idea scene, a cut scene, an Ideas
   * page; design §2.2 "never real, and never read"): not found, or that source named for what it
   * is, never its words as a fact of the book.
   */
  'trap'
] as const

export const LabelQuestion = z.object({
  id: Id,
  question: z.string().min(1).max(300),
  /** The open scene: Now. */
  asOf: SceneId,
  kind: z.enum(QUESTION_KINDS),
  /** Asked in Plan mode (a read run, which writes nothing); otherwise in Ask (write access). */
  plan: z.boolean().default(false),
  /** The words a good navigator searches for (its own synonyms), for a question that searches. */
  terms: z.array(z.string().min(1)).max(8).optional(),
  /** The record an idea or a sheet line is about, or the one an absence question asks after. */
  record: Id.optional(),
  /** The passage selected when it is asked (the chat's focus), for a route on the selection. */
  selection: z.string().min(1).optional(),
  /**
   * The author's change after the book was read, made before any question is asked: this
   * paragraph's `from` became `to`, so the fact read from it goes stale (a lookup turn).
   */
  edit: z
    .object({ scene: SceneId, p: z.number().int().min(0), from: z.string(), to: z.string() })
    .optional(),
  expected: z.object({
    /** Answered by an instant card with no request. */
    instant: z.boolean().default(false),
    /** Handed to Ms Scribe as a lookup turn with no navigator request (P3-D5). */
    lookup: z.boolean().default(false),
    /** The route action, as `settleRoute` settles it, and the edit pass's fields. */
    action: z.enum(ROUTE_ACTIONS).optional(),
    pass: z.enum(ROUTE_EDIT_PASSES).optional(),
    target: z.enum(ROUTE_EDIT_TARGETS).optional(),
    chapter: z.string().optional(),
    /** The scene the answer (or the card) must cite. */
    scene: SceneId.optional(),
    /** Words the cited quote holds, once in that scene (or on the record's page). */
    quoteHas: z.string().min(1).optional(),
    /** Other passages that say the same thing (the honest checker's yes), never the answer. */
    also: z.array(z.string().min(1)).optional(),
    /**
     * The other side of a contested value (two passages that disagree, so no card): a right
     * answer cites both, this one as well as `scene`'s, and states neither alone as the fact.
     */
    contested: z.object({ scene: SceneId, quoteHas: z.string().min(1) }).optional(),
    /**
     * A who-knows card's scoped absence line: every scene up to this one is settled (a scene
     * edited after reading is not, so the line stops before it).
     */
    checkedUpTo: SceneId.optional(),
    /**
     * Words only a source that is not the book holds (a trap): a sentence of the answer that holds
     * them must name that source for what it is ("your idea", "idea scene", "cut") or hedge.
     */
    trap: z.string().min(1).optional(),
    /** Ends "Not found in the manuscript (I looked in …)". */
    notFound: z.boolean().default(false),
    /** The cited source's label: the author's idea or her Pinned notes. */
    label: z.enum(['idea', 'notes']).optional(),
    /** Where the sheet line goes: Pinned, Ideas, or "Is this an idea or canon?" (ask). */
    place: z.enum(['pinned', 'ideas', 'ask']).optional(),
    /** The words the sheet line holds. */
    pinText: z.string().min(1).optional()
  })
})

/** A question as the labels write it (defaults unapplied, as `TestBookLabels` is). */
export type LabelQuestion = z.input<typeof LabelQuestion>
export type QuestionKind = (typeof QUESTION_KINDS)[number]

export const TestBookLabels = z.object({
  records: z.array(LabelRecord).min(1),
  /** Names on the Dismissed list before reading (the twin gate blocks them silently). */
  dismissed: z.array(z.string().min(1)),
  claims: z.array(LabelClaim).min(1),
  mentions: z.array(LabelMentions),
  twinCases: z.array(LabelTwinCase).min(1),
  knows: z.array(LabelKnows).min(1),
  threads: z.array(LabelThreadStep).min(1),
  years: z.array(LabelYear).min(1),
  ages: z.array(LabelAge).min(1),
  contradictions: z.array(LabelContradiction).min(1),
  negatives: z.array(LabelNegative).min(1),
  pages: z.array(LabelPage).min(1),
  questions: z.array(LabelQuestion).min(1),
  /** P4: who the cards put on the page, beyond the knows lines' learners. */
  presence: z.array(LabelPresence).min(1),
  /** P4: the author's notes the contradictions read (on P4 records and a Research page). */
  notes: z.array(LabelNote).min(1),
  /** P4: what the book leaves hanging as of its end. */
  looseEnds: z.array(LabelLooseEnd).min(1),
  /**
   * P4 (F-16.29, F-16.30): the secrets readers know by the book's end that no counted learning line
   * gives anyone, as *Check the book* lists them; every other secret has a learner.
   */
  secretsNobodyLearns: z.array(Id)
})
export type TestBookLabels = z.input<typeof TestBookLabels>
