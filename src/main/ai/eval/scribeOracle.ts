import { normalizeForMatch } from '@shared/critique'
import { EVIDENCE_LABEL_WORDS, type EvidenceLabel } from '@shared/scribe'
import {
  bareAnswer,
  isAbsence,
  isHedged,
  mainClaimAt,
  parseCitedAnswer,
  quoteWords,
  statesAbsenceAsFact
} from '@shared/scribeAnswer'
import { requestKind } from '../../memory/reading/readingFixture'
import { testBookScene } from '../../memory/testBook/book'
import { TEST_BOOK_LABELS } from '../../memory/testBook/labels'
import type { LabelQuestion } from '../../memory/testBook/labels.schema'
import {
  AGENT_V9_EDIT_TOOLS,
  AGENT_V9_SENTINEL,
  AGENT_V9_WIDENED_HEADING
} from '../prompts/agent.v9'
import { CITE_SENTINEL } from '../prompts/cite.v1'
import { NAVIGATOR_SENTINEL } from '../prompts/navigator.v1'
import type { AiMessage } from '../providers/types'
import { fakeChatServer, type ChatServer, type ChatServerReply } from './fakeChatServer'
import { nameOf, oracleRead, oracleVerify } from './memoryOracle'

/**
 * Ms Scribe's oracle over the test book (F-16.24–F-16.26; plan P3 §6.2): the navigator, the answer
 * and the quote checker as a model that knows the labelled answers would play them, behind
 * `fakeChatServer` so the offline replays and the live run's end-to-end test drive the real path
 * (`liveProviderFromEnv` from `OPENROUTER_API_KEY` alone, the SDK, streaming, the request path).
 * Each prompt is read only as it was sent: the oracle finds the question by its words
 * (`TEST_BOOK_LABELS.questions`) and answers from what the request holds, never from the
 * database, so a pipeline that sends the wrong evidence gets an honest "not found".
 *
 * - **Navigator** (`navigator.v1`): step 1 names the labelled route (F-5.26's edit passes among
 *   them), or the turn and a search for the label's own words (`ideas` for an idea question);
 *   step 2 uses the menu items in the label's scene (the line holding the label's words first), a
 *   "your idea" or "your notes" item for a page, else everything it found.
 * - **Answer** (`agent.v9`): cites the label's words where the evidence holds them, in the label's
 *   scene (or page), as `[E7 "…"]`, and both sides of a contested value; an ordinal answer says
 *   what was searched from the Searched line; an absence answer is the scoped "I found no scene
 *   where …"; a not-found question (and a trap only a source that is not the book answers) is
 *   `found: false`; a sheet request is a `pin` edit with the label's place (none in Plan). When
 *   the evidence lacks the scene, it asks once for it (`{"need":"13.1"}`), then says not found.
 * - **Checker** (`cite.v1`): a sentence is supported when its quotes hold the label's words (or
 *   another passage the label says says the same, or the other side of a contested value), never
 *   when it states an Idea, an Idea scene, a cut scene or Not canon text without naming it so,
 *   nor when an absence answer's sentence says the person knows; the scope is "earlier" when a
 *   listed passage is in the label's scene and the answer cites another.
 * - **Reader** and **checker** of the memory (`reader.v2`, `verify.v2`): `memoryOracle.ts`'s.
 *
 * `ScribePlants` replace a question's honest reply for the adversarial replay. Test support
 * only: nothing in the app imports it.
 */

/** Every labelled question (plan P3 §6.1). */
export const SCRIBE_QUESTIONS: readonly LabelQuestion[] = TEST_BOOK_LABELS.questions

/** The question with exactly these words, or null. */
export function questionNamed(text: string): LabelQuestion | null {
  const wanted = text.trim()
  return SCRIBE_QUESTIONS.find((question) => question.question === wanted) ?? null
}

/** The reference the test book project gives a scene: its chapter, one scene each (h09 → 14.1). */
export const sceneRef = (sceneId: string): string => `${testBookScene(sceneId).chapter}.1`

/** The display name of a labelled record ("Lottie Harrow"). */
export const recordName = (recordId: string | undefined): string =>
  recordId === undefined ? '' : (nameOf.get(recordId) ?? '')

/** Which prompt a request is, by its opening sentence. */
export type ScribeRequestKind = 'navigator' | 'answer' | 'cite' | 'reader' | 'verify' | 'other'

export function scribeRequestKind(messages: readonly AiMessage[]): ScribeRequestKind {
  const system = messages[0]?.content ?? ''
  if (system.startsWith(NAVIGATOR_SENTINEL)) return 'navigator'
  if (system.startsWith(AGENT_V9_SENTINEL)) return 'answer'
  if (system.startsWith(CITE_SENTINEL)) return 'cite'
  return requestKind({ messages: [...messages] }) ?? 'other'
}

const norm = (text: string): string => normalizeForMatch(text).toLowerCase()

/** Whether two quotes overlap once normalised, either way round. */
const holds = (text: string, quote: string): boolean => {
  const a = norm(text)
  const b = norm(quote)
  return b !== '' && (a.includes(b) || (a !== '' && b.includes(a)))
}

/** Whether a tag or a menu line's head names the scene's reference as a whole token. */
export function namesRef(text: string, ref: string): boolean {
  const escaped = ref.replace(/\./g, '\\.')
  return new RegExp(`(?:^|[\\s,(])${escaped}(?=$|[\\s,)¶–:-])`, 'u').test(text)
}

// ---- The navigator -------------------------------------------------------------------------

/** One menu line as the navigator was sent it: `E7 happened 13.1 ¶3: …snippet…`. */
export interface OracleMenuLine {
  id: string
  head: string
  snippet: string
}

/** Every menu line of the request: step 1's menu and the later steps' finds, in order. */
export function navigatorMenu(messages: readonly AiMessage[]): OracleMenuLine[] {
  const lines: OracleMenuLine[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const line of message.content.split('\n')) {
      const match = /^(E\d+) (.*?): (.*)$/u.exec(line)
      if (match === null) continue
      lines.push({ id: match[1] ?? '', head: match[2] ?? '', snippet: match[3] ?? '' })
    }
  }
  return lines
}

/** The author's message the navigator was sent. */
export function navigatorMessage(messages: readonly AiMessage[]): string {
  const first = messages.find((message) => message.role === 'user')?.content ?? ''
  return /Message:\n"""\n([\s\S]*?)\n"""/u.exec(first)?.[1]?.trim() ?? ''
}

/** Step 1 as a navigator that knows the label would write it. */
export function oracleFirstStep(question: LabelQuestion | null): Record<string, unknown> {
  if (question === null) return { a: 'chat', t: 'answer', i: '' }
  const { expected } = question
  switch (question.kind) {
    case 'route':
      return {
        a: expected.action ?? 'chat',
        t: expected.action === 'editPass' ? 'edit' : 'answer',
        i: '',
        ...(expected.pass === undefined ? {} : { pass: expected.pass }),
        ...(expected.target === undefined ? {} : { target: expected.target }),
        ...(expected.chapter === undefined ? {} : { chapter: expected.chapter })
      }
    case 'pin':
      return { a: 'chat', t: 'edit', i: '' }
    case 'idea':
      return { a: 'query', t: 'idea', i: '', call: [{ ideas: recordName(question.record) }] }
    default:
      return { a: 'query', t: 'answer', i: '', call: [{ search: question.terms ?? [] }] }
  }
}

/** The ids step 2 uses: the label's scene or page first, else everything found. */
export function oracleUse(
  question: LabelQuestion | null,
  menu: readonly OracleMenuLine[]
): string[] {
  const all = menu.map((line) => line.id)
  if (question === null) return all.slice(0, 12)
  const { expected } = question
  const has = (line: OracleMenuLine): boolean =>
    expected.quoteHas !== undefined && holds(line.snippet, expected.quoteHas)
  const first = (lines: OracleMenuLine[]): string[] =>
    [...lines.filter(has), ...lines.filter((line) => !has(line))].map((line) => line.id)
  let picked: string[] = []
  if (expected.label === 'idea') {
    picked = first(menu.filter((line) => line.head.startsWith('your idea')))
  } else if (expected.label === 'notes') {
    picked = first(menu.filter((line) => line.head.startsWith('your notes')))
  } else if (expected.scene !== undefined) {
    const ref = sceneRef(expected.scene)
    picked = first(menu.filter((line) => namesRef(line.head, ref)))
  }
  return (picked.length > 0 ? picked : all).slice(0, 12)
}

/** The navigator's reply to one step. */
export function oracleNavigate(messages: readonly AiMessage[]): string {
  const question = questionNamed(navigatorMessage(messages))
  const step = messages.filter((message) => message.role === 'user').length
  if (step === 1) return JSON.stringify(oracleFirstStep(question))
  return JSON.stringify({ use: oracleUse(question, navigatorMenu(messages)) })
}

// ---- The answer ----------------------------------------------------------------------------

/** One evidence item as `agent.v9` was sent it: its id, its tag, and the book's lines in it. */
export interface OracleEvidence {
  id: string
  tag: string
  /** Its text lines, `¶n ` taken off and the app's fact lines (`Mara · eyes: grey`) left out. */
  lines: string[]
}

const ITEM_HEAD = /^([EW]\d+) \[([^\]]*)\]/u

/** The user turn that holds the evidence and the question (the last one with `Question:`). */
export function answerTail(messages: readonly AiMessage[]): string {
  return (
    [...messages]
      .reverse()
      .find((message) => message.role === 'user' && message.content.includes('\nQuestion: '))
      ?.content ?? ''
  )
}

/** The author's question in an `agent.v9` request. */
export const answerQuestion = (messages: readonly AiMessage[]): string =>
  /\nQuestion: ([^\n]*)\s*$/u.exec(answerTail(messages))?.[1]?.trim() ?? ''

/** E0, the labelled evidence and the widened `W` items of an `agent.v9` request. */
export function answerEvidence(tail: string): OracleEvidence[] {
  const items: OracleEvidence[] = []
  for (const chunk of tail.split('\n\n')) {
    const lines = chunk.split('\n')
    const start = lines.findIndex((line) => ITEM_HEAD.test(line))
    if (start === -1) continue
    const match = ITEM_HEAD.exec(lines[start] ?? '')
    if (match === null) continue
    items.push({
      id: match[1] ?? '',
      tag: match[2] ?? '',
      lines: lines
        .slice(start + 1)
        .map((line) => line.replace(/^¶\d+ /u, ''))
        .filter((line) => line.trim() !== '' && !line.includes(' · '))
    })
  }
  return items
}

/** What the request's Searched line says was searched ("every scene up to 18.1 for …"), or null. */
export function searchedPhrase(tail: string): string | null {
  const line = tail.split('\n').find((each) => each.startsWith('Searched '))
  return line === undefined ? null : line.slice('Searched '.length).replace(/\.$/u, '')
}

const SENTENCE_END = /(?<!\b(?:Mr|Mrs|Ms|Dr|St)\.)(?<=[.!?][”"’]?)\s+/u

/**
 * A quote that holds `has`, copied from `line`: its sentence when that is 3 to 25 words, else
 * about 18 words of the line around it.
 */
export function quoteAround(line: string, has: string): string | null {
  const sentences = line.split(SENTENCE_END)
  const sentence = sentences.find((each) => holds(each, has)) ?? line
  const words = quoteWords(sentence)
  if (words >= 3 && words <= 25 && holds(sentence, has)) return sentence.trim()
  const tokens = line.split(' ')
  const bare = (text: string): string => norm(text).replace(/^[^\p{L}\p{N}]+/u, '')
  const wanted = bare(has)
  const at = tokens.findIndex((_, i) => bare(tokens.slice(i).join(' ')).startsWith(wanted))
  if (at === -1) return null
  const from = Math.max(0, at - 3)
  return tokens.slice(from, from + 18).join(' ')
}

/** A citation marker for a quote, its own double quotes escaped. */
export const citeMarker = (id: string, quote: string): string =>
  `[${id} "${quote.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"]`

/** The evidence item and quote that hold `has`, among the items `where` admits. */
export function findQuoted(
  items: readonly OracleEvidence[],
  has: string,
  where: (item: OracleEvidence) => boolean
): { item: OracleEvidence; quote: string } | null {
  for (const item of items) {
    if (!where(item)) continue
    for (const line of item.lines) {
      if (!holds(line, has)) continue
      const quote = quoteAround(line, has)
      if (quote !== null) return { item, quote }
    }
  }
  return null
}

/** The reference an item's tag gives ("13.1" of "happened, 13.1 ¶1"), or the open scene's. */
const tagRef = (tag: string): string => /(\d+\.\d+)/u.exec(tag)?.[1] ?? ''

interface Reply {
  answer?: string
  found?: boolean
  edits?: unknown[]
  need?: string
}

/** The honest answer to one `agent.v9` request. */
export function oracleAnswerReply(messages: readonly AiMessage[]): Reply {
  const write = (messages[0]?.content ?? '').includes(AGENT_V9_EDIT_TOOLS)
  const tail = answerTail(messages)
  const question = questionNamed(answerQuestion(messages))
  if (question === null) return { answer: 'I cannot tell from the evidence.', found: false }
  const { expected } = question
  const name = recordName(question.record)
  switch (question.kind) {
    case 'pin': {
      const text = expected.pinText ?? ''
      if (!write) {
        return {
          answer: `I would put on ${name}’s sheet that ${text}; switch to Ask or Auto and I can add it.`,
          found: true,
          edits: []
        }
      }
      const line = `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
      return {
        answer: `I’ll put that on ${name}’s sheet.`,
        found: true,
        edits: [{ edit: 'pin', name, text: line, place: expected.place ?? 'ask' }]
      }
    }
    case 'notFound':
      return { answer: 'The evidence does not say.', found: false, edits: [] }
    case 'trap':
      if (expected.notFound)
        return { answer: 'The evidence does not say.', found: false, edits: [] }
      break
    case 'absence': {
      const searched = searchedPhrase(tail)
      return {
        answer: `I found no scene where ${name} learns it${searched === null ? '' : ` (searched ${searched})`}.`,
        found: true,
        edits: []
      }
    }
    default:
      break
  }
  const items = answerEvidence(tail)
  const has = expected.quoteHas ?? ''
  const where = (item: OracleEvidence): boolean => {
    if (expected.label === 'idea') return item.tag.startsWith('your idea')
    if (expected.label === 'notes') return item.tag.startsWith('your notes')
    return expected.scene !== undefined && namesRef(item.tag, sceneRef(expected.scene))
  }
  const found = has === '' ? null : findQuoted(items, has, where)
  if (found === null) {
    const widened = tail.includes(AGENT_V9_WIDENED_HEADING)
    if (!widened && expected.scene !== undefined) return { need: sceneRef(expected.scene) }
    return { answer: 'The evidence does not say.', found: false, edits: [] }
  }
  const marker = citeMarker(found.item.id, found.quote)
  const ref = tagRef(found.item.tag)
  const searched = searchedPhrase(tail)
  const other =
    expected.contested === undefined
      ? null
      : findQuoted(items, expected.contested.quoteHas, (item) =>
          namesRef(item.tag, sceneRef(expected.contested?.scene ?? ''))
        )
  let answer: string
  if (other !== null) {
    const otherRef = tagRef(other.item.tag)
    answer =
      `The book says two things. In ${otherRef}: ${citeMarker(other.item.id, other.quote)} ` +
      `In ${ref}: ${marker}`
  } else if (expected.label === 'idea') {
    answer = `That is your idea, not in the book, from ${name}’s Ideas. ${marker}`
  } else if (expected.label === 'notes') {
    answer = `Your notes on ${name} say so. ${marker}`
  } else if (question.kind === 'ordinal') {
    answer =
      searched === null
        ? `The earliest I found is ${ref}. ${marker}`
        : `The earliest I found, searching ${searched}, is ${ref}. ${marker}`
  } else {
    answer = `The book answers it in ${ref}. ${marker}`
  }
  return { answer, found: true, edits: [] }
}

// ---- The quote checker ---------------------------------------------------------------------

/** One cited sentence as `cite.v1` was sent it, with its quotes and their items' tags. */
export interface OracleCiteSentence {
  n: number
  text: string
  quotes: string[]
  tags: string[]
}

/** The scope item of a `cite.v1` request: the scene the answer cites and the passages listed. */
export interface OracleCiteScope {
  cited: string | null
  hits: { ref: string; text: string }[]
}

export function citeRequest(messages: readonly AiMessage[]): {
  question: string
  sentences: OracleCiteSentence[]
  scope: OracleCiteScope | null
} {
  const user = messages.at(-1)?.content ?? ''
  const question = /^Question: (.*)$/mu.exec(user)?.[1]?.trim() ?? ''
  const sentences: OracleCiteSentence[] = []
  let scope: OracleCiteScope | null = null
  let inScope = false
  for (const line of user.split('\n')) {
    const sentence = /^(\d+)\. (.*)$/u.exec(line)
    if (sentence !== null && !inScope) {
      sentences.push({ n: Number(sentence[1]), text: sentence[2] ?? '', quotes: [], tags: [] })
      continue
    }
    const quote = /^[EW]\d+ \[([^\]]*)\] “(.*?)” in: /u.exec(line)
    if (quote !== null && !inScope) {
      sentences.at(-1)?.quotes.push(quote[2] ?? '')
      sentences.at(-1)?.tags.push(quote[1] ?? '')
      continue
    }
    if (line.startsWith('Scope: searched ')) {
      inScope = true
      scope = { cited: /It cites (\d+\.\d+)\./u.exec(line)?.[1] ?? null, hits: [] }
      continue
    }
    const hit = /^- (\d+\.\d+)(?: ¶\d+)?: (.*)$/u.exec(line)
    if (hit !== null && scope !== null) scope.hits.push({ ref: hit[1] ?? '', text: hit[2] ?? '' })
  }
  return { question, sentences, scope }
}

/** The labels of what is never the book (design §2.2): cited, a sentence must name them so. */
export const NOT_THE_BOOK: readonly EvidenceLabel[] = ['idea', 'ideaScene', 'cutScene', 'notCanon']
const NOT_THE_BOOK_TAGS = NOT_THE_BOOK.map((label) => EVIDENCE_LABEL_WORDS[label])

/** Words that name a source as not the book: "your idea", "idea scene", "cut", a draft, a dream. */
const NAMES_NOT_THE_BOOK =
  /\b(?:ideas?|cut|draft|dream(?:s|ed|t)?|not\s+canon|not\s+in\s+the\s+book|left\s+out)\b/iu

/**
 * Whether a sentence offers what it says as something other than the book's fact: it names the
 * source as an idea, a cut scene, a draft or a dream, or it hedges (`isHedged`).
 */
export const namesNotTheBook = (sentence: string): boolean =>
  NAMES_NOT_THE_BOOK.test(sentence) || isHedged(sentence)

/** Someone knowing, learning or being told something, as a claim (the knows verbs). */
const KNOWS_VERB =
  /\b(?:knows?|knew|learn(?:s|ed|t)|(?:is|was|were|has\s+been|had\s+been)\s+told|finds?\s+out|found\s+out|hears?|heard|(?:is|was)\s+aware|discover(?:s|ed))\b/iu
const NEGATED = /\b(?:no|not|never|nothing|nobody|none|n['’]t)\b/iu

/** A sentence that is, or opens with, a yes ("Yes.", "Yes, Mara knows…"). */
const saysYes = (sentence: string): boolean =>
  bareAnswer(sentence) === 'yes' || /^(?:yes|yeah|yep)\b/iu.test(sentence.trim())

/** Whether one sentence says someone knows, learned or was told (with no negation in it). */
export function claimsKnows(sentence: string): boolean {
  const text = sentence.trim()
  if (saysYes(text)) return true
  return (
    KNOWS_VERB.test(text) &&
    !NEGATED.test(text) &&
    !isAbsence(text) &&
    !statesAbsenceAsFact(text) &&
    !isHedged(text)
  )
}

/**
 * Whether an answer's main claim says the person knows (an absence question's wrong answer:
 * the person never learns it): a bare or leading "yes", or a knows claim (`mainClaimAt`).
 */
export function affirmsKnowing(answer: string): boolean {
  const sentences = parseCitedAnswer(answer).sentences
  return (
    saysYes(sentences[0]?.text ?? '') || claimsKnows(sentences[mainClaimAt(sentences)]?.text ?? '')
  )
}

/** The honest checker's verdicts on one `cite.v1` request. */
export function oracleCiteReply(messages: readonly AiMessage[]): {
  v: { i: number; ok: 'yes' | 'no' }[]
  scope: 'ok' | 'earlier' | 'none'
} {
  const request = citeRequest(messages)
  const question = questionNamed(request.question)
  const wanted = [
    question?.expected.quoteHas,
    question?.expected.contested?.quoteHas,
    ...(question?.expected.also ?? [])
  ].filter((quote): quote is string => quote !== undefined)
  const supported = (sentence: OracleCiteSentence): boolean => {
    if (question?.kind === 'absence' && claimsKnows(sentence.text)) return false
    const notTheBook = sentence.tags.some((tag) =>
      NOT_THE_BOOK_TAGS.some((words) => tag.startsWith(words))
    )
    if (notTheBook && !namesNotTheBook(sentence.text)) return false
    return (
      wanted.length === 0 ||
      sentence.quotes.some((quote) => wanted.some((each) => holds(quote, each)))
    )
  }
  const v = request.sentences.map((sentence) => ({
    i: sentence.n,
    ok: supported(sentence) ? ('yes' as const) : ('no' as const)
  }))
  if (request.scope === null) return { v, scope: 'none' }
  const scene = question?.expected.scene
  const target = scene === undefined ? null : sceneRef(scene)
  const has = question?.expected.quoteHas
  const shown = request.scope.hits.some(
    (hit) => hit.ref === target || (has !== undefined && holds(hit.text, has))
  )
  const earlier = target !== null && request.scope.cited !== target && shown
  return { v, scope: earlier ? 'earlier' : 'ok' }
}

// ---- The server ----------------------------------------------------------------------------

/**
 * A question's planted replies (the adversarial replay): each takes the request and the honest
 * reply and returns what the "model" says instead; `attempt` counts that kind's requests for the
 * question (1 for the first answer, 2 for its retry or widening).
 */
export interface ScribePlant {
  navigator?: (messages: readonly AiMessage[], honest: string, step: number) => string
  answer?: (messages: readonly AiMessage[], honest: Reply, attempt: number) => string
  /** A checker that errs (a live `cite.v1` fooled), so the scoring is what must catch it. */
  cite?: (messages: readonly AiMessage[], honest: ReturnType<typeof oracleCiteReply>) => string
}
export type ScribePlants = Readonly<Partial<Record<string, ScribePlant>>>

/** The question a request is about, by its words. */
function requestQuestion(messages: readonly AiMessage[], kind: ScribeRequestKind): string {
  if (kind === 'navigator') return navigatorMessage(messages)
  if (kind === 'answer') return answerQuestion(messages)
  if (kind === 'cite') return citeRequest(messages).question
  return ''
}

/** The oracle's reply to any request of the scribe run (and the memory's reader and checker). */
export function scribeOracleReply(
  messages: readonly AiMessage[],
  plants: ScribePlants = {},
  attempts = new Map<string, number>()
): string {
  const kind = scribeRequestKind(messages)
  if (kind === 'reader') return oracleRead({ messages: [...messages] })
  if (kind === 'verify') return oracleVerify({ messages: [...messages] })
  const question = questionNamed(requestQuestion(messages, kind))
  const plant = question === null ? undefined : plants[question.id]
  if (kind === 'navigator') {
    const honest = oracleNavigate(messages)
    const step = messages.filter((message) => message.role === 'user').length
    return plant?.navigator?.(messages, honest, step) ?? honest
  }
  if (kind === 'answer') {
    const honest = oracleAnswerReply(messages)
    const key = `${question?.id ?? ''}:answer`
    const attempt = (attempts.get(key) ?? 0) + 1
    attempts.set(key, attempt)
    return plant?.answer?.(messages, honest, attempt) ?? JSON.stringify(honest)
  }
  if (kind === 'cite') {
    const honest = oracleCiteReply(messages)
    return plant?.cite?.(messages, honest) ?? JSON.stringify(honest)
  }
  return JSON.stringify({ answer: 'I cannot tell.', found: false })
}

/**
 * The oracle behind a fake OpenRouter (`fakeChatServer`): every reply `scribeOracleReply`'s, at
 * `costUsd` a request (the fake's default when omitted), so a run's cost stop can be tested.
 */
export function scribeOracleServer(
  options: { plants?: ScribePlants; costUsd?: number; reply?: Partial<ChatServerReply> } = {}
): ChatServer {
  const attempts = new Map<string, number>()
  return fakeChatServer((messages) => ({
    text: scribeOracleReply(messages, options.plants, attempts),
    ...(options.costUsd === undefined ? {} : { costUsd: options.costUsd }),
    ...options.reply
  }))
}
