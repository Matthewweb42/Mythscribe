import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import type { RouteDecision } from '@shared/assistantRoute'
import { unfence } from '@shared/memory/readerAnswer'
import {
  EVIDENCE_LABEL_WORDS,
  NAVIGATION_TERM_MAX,
  NAVIGATION_TERMS_MAX,
  NAVIGATOR_CALLS_PER_STEP,
  NAVIGATOR_STEPS,
  SCRIBE_TURNS,
  type EvidenceLabel,
  type ScribeTurnKind
} from '@shared/scribe'
import type { AiMessage } from '../providers/types'
import { matchId, readRouteFields } from '../routeFields'
import { scribeRoster, type ScribeRosterRecord } from './agent.v9'
import type { ChatTurn } from './chat.v1'
import { ROUTE_V2_ACTION_LINES, ROUTE_V2_EDIT_FIELDS, routeV2InstructionRule } from './route.v2'

/**
 * Ms Scribe's navigator (F-16.25; plan P3 §4.2, design §2.6), version 1: fast tier, JSON, reasoning
 * off, story memory v2 only. It replaces `route.v2` there: step 1 picks route.v2's action (its
 * action list, instruction rule and edit-pass fields word for word, so F-5.26's edit passes and
 * every other route action stay as they were) and the turn's kind (never lookup: that is Step 0's
 * own handover); for a chat or a question about the book it then
 * calls local tools (search with its own synonyms, cards, read, state, knows, timeline, ideas,
 * outline, to-dos), at most three per step and three steps, and ends with the evidence ids the
 * answer needs. It never writes prose: `agent.v9` answers from what it picked.
 *
 * Order (CLAUDE.md, token rule 3): the system turn is the cached prefix, the rules and tools, the
 * roster of names, secrets and threads, the first line of each record's Ideas and the story map
 * (≤ 3,000 tokens, the same for every message while now stays in one chapter); then one user turn
 * with Now, the open document, the selection's opening, the last two turns, the message and the
 * evidence menu; steps 2 and 3 add the step's reply and what its tools found.
 */
export const NAVIGATOR_PROMPT_VERSION = 'navigator.v1'

/** The opening sentence; the e2e's fake provider keys on it. */
export const NAVIGATOR_SENTINEL = "You are the navigator inside a novel-writing app's assistant."

/** The rules and tools (the golden holds them at 700 tokens or under). */
export const NAVIGATOR_RULES =
  `${NAVIGATOR_SENTINEL} You pick what answers the author's message and find the evidence in her ` +
  'book; another model answers. Reply with JSON only.\n' +
  'Step 1: {"a":"query","t":"answer","i":"","call":[{"search":["oath","vow"]}]}. "a", the action:\n' +
  ROUTE_V2_ACTION_LINES +
  'For editPass also set "pass", "target" and "chapter": ' +
  ROUTE_V2_EDIT_FIELDS +
  '\n"i" is "instruction". ' +
  routeV2InstructionRule('i') +
  '"t", the turn: answer, idea (her ideas), todo (her to-dos), edit (change the book or a ' +
  'sheet), draft (new prose), whatIf. For any action but chat and query, stop there.\n' +
  'Tools, at most 3 calls a step: {"search":["distrust","suspicion","lied"]} (your own ' +
  'synonyms and word forms, 8 at most); {"cards":"7.1-7.6"} or {"cards":"Mara"}; {"read":"7.4"}, ' +
  '{"read":"7.4 ¶3-8"} or {"read":"Mara\'s Pinned"} (2 reads a message); {"state":"Mara"}; ' +
  '{"knows":"the sold map"} or {"knows":"Orrin"}; {"timeline":"Mara"}; {"ideas":"the Bell"}; ' +
  '{"outline":{}}; {"todos":{}}. Each call adds numbered items to the menu.\n' +
  'End with {"use":["E3","E7"]} (12 at most) once the menu holds what the answer needs, at step ' +
  '1 too; steps 2 and 3 carry "call" or "use", and step 3 must use.\n' +
  'First, last, ever, never, how many and knows questions: search every earlier scene.\n' +
  'Never write prose: ids, names and search words only.'

/** The parts of the cached prefix, each within its cap (P3 §4.2). */
export const NAVIGATOR_RULES_TOKENS = 700
export const NAVIGATOR_ROSTER_TOKENS = 800
/** Of the roster's 800, what the secrets' and threads' labels may take at most. */
export const NAVIGATOR_TOPICS_TOKENS = 200
export const NAVIGATOR_IDEAS_TOKENS = 400
export const NAVIGATOR_MAP_TOKENS = 1_100
export const NAVIGATOR_PREFIX_TOKENS = 3_000
/** The tail's parts: Now, the open document, the selection's opening and the last two turns. */
export const NAVIGATOR_CONTEXT_TOKENS = 300
/** The evidence menu as step 1 sends it. */
export const NAVIGATOR_MENU_TOKENS = 1_000
/** Each of steps 2 and 3: the earlier reply and what its tools found (1,400 for both). */
export const NAVIGATOR_STEP_TOKENS = 700
/** The most evidence ids one `use` names, and the reads one message may make. */
export const NAVIGATOR_USE_MAX = 12
export const NAVIGATOR_READS_MAX = 2
/** A menu line's snippet, an Ideas line's words, and a tool argument, at most. */
export const NAVIGATOR_SNIPPET_CHARS = 200
export const NAVIGATOR_IDEA_WORDS = 15
export const NAVIGATOR_ARG_CHARS = 120

/** The roster's headings in the system turn. */
export const NAVIGATOR_ROSTER_HEADING = 'Records (names and nicknames):'
export const NAVIGATOR_IDEAS_HEADING = "The author's ideas (never in the book):"
export const NAVIGATOR_MAP_HEADING = 'Story map (scene cards: maps, not citable):'

/** The navigator's tools (design §2.6, P3-D6: `outline` and `todos` beside the design's seven). */
export const NAVIGATOR_TOOLS = [
  'search',
  'cards',
  'read',
  'state',
  'knows',
  'timeline',
  'ideas',
  'outline',
  'todos'
] as const
export type NavigatorTool = (typeof NAVIGATOR_TOOLS)[number]

/** One tool call as step parsing reads it: search words, or the one argument, or none. */
export type NavigatorCall =
  | { tool: 'search'; terms: string[] }
  | { tool: 'cards' | 'read' | 'state' | 'knows' | 'timeline' | 'ideas'; arg: string }
  | { tool: 'outline' | 'todos' }

/** One menu item as the prompt lists it: `E3 happened 9.3 ¶4: …snippet…`. */
export interface NavigatorMenuLine {
  id: string
  label: EvidenceLabel
  ref: string
  snippet: string
}

/** A menu line, its snippet flattened and cut to `NAVIGATOR_SNIPPET_CHARS`. */
export function navigatorMenuLine(item: NavigatorMenuLine): string {
  const flat = item.snippet.replace(/\s+/gu, ' ').trim()
  const snippet =
    flat.length > NAVIGATOR_SNIPPET_CHARS
      ? `${flat.slice(0, NAVIGATOR_SNIPPET_CHARS - 1).trimEnd()}…`
      : flat
  const where = item.ref.trim() === '' ? '' : ` ${item.ref}`
  return `${item.id} ${EVIDENCE_LABEL_WORDS[item.label]}${where}: ${snippet}`
}

/**
 * The menu lines within `budget` tokens, in rank order: a line that does not fit is left out (the
 * far items go first), and the rest still go in.
 */
export function renderNavigatorMenu(
  items: readonly NavigatorMenuLine[],
  budget: number
): { lines: string[]; kept: string[] } {
  const lines: string[] = []
  const kept: string[] = []
  let used = 0
  for (const item of items) {
    const line = navigatorMenuLine(item)
    const cost = estimateTokens(`${line}\n`)
    if (used + cost > budget) continue
    lines.push(line)
    kept.push(item.id)
    used += cost
  }
  return { lines, kept }
}

/** What the roster names: the records (NAMED_KINDS), and the secrets' and threads' labels. */
export interface NavigatorRosterInput {
  records: readonly ScribeRosterRecord[]
  /** How often the book names each record: past the cap the least-named go first. */
  named: ReadonlyMap<string, number>
  secrets: readonly string[]
  threads: readonly string[]
}

/** A list of labels within `budget` tokens, the later ones left out first. */
function labelsWithin(heading: string, labels: readonly string[], budget: number): string | null {
  const kept: string[] = []
  for (const label of labels) {
    if (estimateTokens(`${heading} ${[...kept, label].join('; ')}`) > budget) break
    kept.push(label)
  }
  return kept.length === 0 ? null : `${heading} ${kept.join('; ')}`
}

/**
 * The roster within `NAVIGATOR_ROSTER_TOKENS`: the records, one line each in creation order
 * (`scribeRoster`: the least-named left out past the cap), then "Secrets:" and "Threads:" with
 * their labels (at most `NAVIGATOR_TOPICS_TOKENS` together, the later ones left out). Never what
 * anyone knows: only names and labels.
 */
export function navigatorRoster(input: NavigatorRosterInput): string {
  const secrets = labelsWithin('Secrets:', input.secrets, NAVIGATOR_TOPICS_TOKENS / 2)
  const threads = labelsWithin('Threads:', input.threads, NAVIGATOR_TOPICS_TOKENS / 2)
  const topics = [secrets, threads].filter((line): line is string => line !== null)
  const topicCost = topics.reduce((sum, line) => sum + estimateTokens(`${line}\n`), 0)
  const budget =
    NAVIGATOR_ROSTER_TOKENS - topicCost - estimateTokens(`${NAVIGATOR_ROSTER_HEADING}\n`)
  const records = scribeRoster(input.records, input.named, budget)
  return [NAVIGATOR_ROSTER_HEADING, ...records, ...topics].join('\n')
}

/** One record's Ideas as the prefix lists it: the record's name and its first line. */
export interface NavigatorIdea {
  recordId: string
  name: string
  /** The first non-blank paragraph of its Ideas page. */
  first: string
  /** Creation order key: the list keeps it, so the prefix stays stable. */
  created: string
}

/** A line cut to its first `NAVIGATOR_IDEA_WORDS` words. */
function firstWords(text: string): string {
  const words = text.replace(/\s+/gu, ' ').trim().split(' ')
  return words.length <= NAVIGATOR_IDEA_WORDS
    ? words.join(' ')
    : `${words.slice(0, NAVIGATOR_IDEA_WORDS).join(' ')}…`
}

/**
 * The first line of each record's Ideas, at most `NAVIGATOR_IDEA_WORDS` words each, within
 * `NAVIGATOR_IDEAS_TOKENS`, in creation order; past the cap the least-named records go first. Null
 * with no Ideas anywhere. Labelled as the author's ideas, never the book.
 */
export function navigatorIdeas(
  ideas: readonly NavigatorIdea[],
  named: ReadonlyMap<string, number>
): string | null {
  const ordered = [...ideas]
    .filter((idea) => idea.first.trim() !== '')
    .sort((a, b) => a.created.localeCompare(b.created) || a.recordId.localeCompare(b.recordId))
  if (ordered.length === 0) return null
  const kept = new Set(ordered.map((idea) => idea.recordId))
  const render = (): string =>
    [
      NAVIGATOR_IDEAS_HEADING,
      ...ordered
        .filter((idea) => kept.has(idea.recordId))
        .map((idea) => `${idea.name}: ${firstWords(idea.first)}`)
    ].join('\n')
  const dropOrder = [...ordered].sort(
    (a, b) =>
      (named.get(a.recordId) ?? 0) - (named.get(b.recordId) ?? 0) ||
      b.created.localeCompare(a.created)
  )
  for (const idea of dropOrder) {
    if (estimateTokens(render()) <= NAVIGATOR_IDEAS_TOKENS) break
    kept.delete(idea.recordId)
  }
  return kept.size === 0 ? null : render()
}

/** One chapter of the story map: its number as the scene refs show it, its title, its scenes. */
export interface NavigatorMapChapter {
  number: string
  title: string
  scenes: readonly { ref: string; title: string; line: string | null }[]
}

/** A chapter as one line: "Ch 7 'The Ball' (7.1–7.6)". */
function chapterLine(chapter: NavigatorMapChapter, now: boolean): string {
  const first = chapter.scenes[0]?.ref ?? ''
  const last = chapter.scenes.at(-1)?.ref ?? ''
  const span = first === '' ? '' : first === last ? first : `${first}–${last}`
  const parts = [span, now ? 'now' : ''].filter((part) => part !== '').join(', ')
  return `Ch ${chapter.number} '${chapter.title}'${parts === '' ? '' : ` (${parts})`}`
}

/** A scene's map line: "  7.4 The Ball: Mara dances with the Captain." (no card: the title). */
function sceneLine(scene: NavigatorMapChapter['scenes'][number], card: boolean): string {
  const line = card && scene.line !== null ? scene.line.replace(/\s+/gu, ' ').trim() : ''
  return `  ${scene.ref} ${scene.title}${line === '' ? '' : `: ${line}`}`
}

/**
 * The story map (P3 §4.2) within `budget` tokens: the chapters within one chapter of now's
 * (`nowChapter`, an index into `chapters`) with a line per scene and its card line; every other
 * chapter as one line ("Ch 3 'The Crossing' (3.1–3.6)"); now's chapter marked. Only the chapter
 * is marked, so the map, and with it the cached prefix, stays the same for every scene in it.
 * When it does not fit: now's chapter alone in full, then its scenes without card lines, then the
 * farthest chapter lines left out ("… 4 more chapters"). Null with no chapter.
 */
export function renderNavigatorMap(
  chapters: readonly NavigatorMapChapter[],
  nowChapter: number | null,
  budget: number = NAVIGATOR_MAP_TOKENS
): string | null {
  if (chapters.length === 0) return null
  const centre = nowChapter ?? chapters.length - 1
  const attempt = (radius: number, cards: boolean, far: number): string => {
    const lines: string[] = [NAVIGATOR_MAP_HEADING]
    let cut = 0
    chapters.forEach((chapter, index) => {
      const distance = Math.abs(index - centre)
      if (distance > far) {
        cut += 1
        return
      }
      const now = nowChapter === index
      if (distance <= radius) {
        lines.push(`${chapterLine(chapter, now)}:`)
        for (const scene of chapter.scenes) lines.push(sceneLine(scene, cards))
      } else {
        lines.push(chapterLine(chapter, now))
      }
    })
    if (cut > 0) lines.push(`… ${cut} more ${cut === 1 ? 'chapter' : 'chapters'}`)
    return lines.join('\n')
  }
  const fits = (text: string): boolean => estimateTokens(text) <= budget
  for (const [radius, cards] of [
    [1, true],
    [0, true],
    [0, false]
  ] as const) {
    const text = attempt(radius, cards, Infinity)
    if (fits(text)) return text
  }
  for (let far = chapters.length; far >= 0; far--) {
    const text = attempt(0, false, far)
    if (fits(text)) return text
  }
  return attempt(-1, false, 0)
}

/** The cached prefix's parts, each already within its cap. */
export interface NavigatorPrefix {
  roster: string
  ideas: string | null
  map: string | null
}

/** The system turn: rules and tools, roster, Ideas, story map (the cached prefix). */
export function navigatorSystem(prefix: NavigatorPrefix): string {
  return [NAVIGATOR_RULES, prefix.roster, prefix.ideas, prefix.map]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join('\n\n')
}

/** The tail of step 1: what changes with every message, each part already cut to its cap. */
export interface NavigatorTail {
  /** Now: the open scene's ref ("14.2"), or null when nothing is written. */
  now: string | null
  /** The open document as `scene "Title"`, or null with none open. */
  active: string | null
  /** The opening of the selection, or null. */
  selection: string | null
  /** The last two turns, oldest first, each cut short. */
  history: readonly ChatTurn[]
  message: string
}

/** What one earlier step sends back: the model's reply as it wrote it, and what its tools found. */
export interface NavigatorStepTurn {
  reply: string
  /** The menu lines its calls added, rendered. */
  found: readonly string[]
  /** What a call could not do ("No record is called "Marra"."). */
  notes: readonly string[]
}

export interface BuildNavigatorPromptInput {
  prefix: NavigatorPrefix
  tail: NavigatorTail
  /** Step 0's menu, in rank order. */
  menu: readonly NavigatorMenuLine[]
  /** The steps before this one (none at step 1, at most two). */
  steps: readonly NavigatorStepTurn[]
}

export interface BuiltNavigatorPrompt {
  version: typeof NAVIGATOR_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
  /** The menu ids the step-1 turn listed (the rest did not fit). */
  menu: string[]
}

/** The step-1 user turn. */
function tailText(tail: NavigatorTail, menu: readonly string[]): string {
  const parts: string[] = [`Now: ${tail.now ?? 'nothing written yet'}`]
  parts.push(tail.active === null ? 'No document is open.' : `Open document: ${tail.active}`)
  parts.push(
    tail.selection === null
      ? 'No passage is selected.'
      : `Selected passage (opening):\n"""\n${tail.selection}\n"""`
  )
  if (tail.history.length > 0) {
    const turns = tail.history.map(
      (turn) => `${turn.role === 'user' ? 'Author' : 'Assistant'}: ${turn.content}`
    )
    parts.push(`Recent turns:\n${turns.join('\n')}`)
  }
  parts.push(`Message:\n"""\n${tail.message}\n"""`)
  parts.push(menu.length === 0 ? 'Menu: empty (search to fill it).' : `Menu:\n${menu.join('\n')}`)
  return parts.join('\n\n')
}

/** What a later step's user turn says: what the calls found, and what the step must do. */
function stepText(turn: NavigatorStepTurn, step: number): string {
  const found = turn.found.length === 0 ? 'Found nothing new.' : `Found:\n${turn.found.join('\n')}`
  const notes = turn.notes.length === 0 ? '' : `\n${turn.notes.join('\n')}`
  const ask =
    step >= NAVIGATOR_STEPS
      ? `Step ${step} of ${NAVIGATOR_STEPS}: end with {"use":[…]}.`
      : `Step ${step} of ${NAVIGATOR_STEPS}: {"call":[…]} or {"use":[…]}.`
  return `${found}${notes}\n\n${ask}`
}

/**
 * One step's request. Step 1 is the system turn and the tail with the menu; step n adds, per
 * earlier step, its reply and what its tools found. Fit (token rule 8): the menu's far items go
 * first until the request is within the feature's input cap; a later step's found lines were cut
 * to `NAVIGATOR_STEP_TOKENS` when they were made.
 */
export function buildNavigatorPrompt(input: BuildNavigatorPromptInput): BuiltNavigatorPrompt {
  const system = navigatorSystem(input.prefix)
  const later = input.steps.flatMap((turn, i): AiMessage[] => [
    { role: 'assistant', content: turn.reply },
    { role: 'user', content: stepText(turn, i + 2) }
  ])
  const fixed =
    estimateTokens(system) +
    later.reduce((sum, message) => sum + estimateTokens(message.content), 0) +
    estimateTokens(tailText(input.tail, []))
  const room = Math.max(
    0,
    Math.min(NAVIGATOR_MENU_TOKENS, inputBudget('navigator') - fixed - NAVIGATOR_FIT_MARGIN)
  )
  const menu = renderNavigatorMenu(input.menu, room)
  return {
    version: NAVIGATOR_PROMPT_VERSION,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: tailText(input.tail, menu.lines) },
      ...later
    ],
    maxTokens: outputBudget('navigator'),
    menu: menu.kept
  }
}

/** What the fit keeps back for the joins between the parts. */
const NAVIGATOR_FIT_MARGIN = 20

/**
 * The found lines of one step within `NAVIGATOR_STEP_TOKENS` (with the reply it follows): the
 * later lines go first.
 */
export function stepFound(reply: string, lines: readonly string[]): string[] {
  const kept: string[] = []
  let used = estimateTokens(reply) + 40
  for (const line of lines) {
    const cost = estimateTokens(`${line}\n`)
    if (used + cost > NAVIGATOR_STEP_TOKENS) continue
    kept.push(line)
    used += cost
  }
  return kept
}

/** One step as read (P3 §4.2). */
export interface NavigatorStep {
  /** The reply was one JSON object. */
  readable: boolean
  /** Step 1 only: the action and its fields, as route.v2's readers read them (else null). */
  route: RouteDecision | null
  /** Step 1 only: the turn's kind, when it named a known one. */
  turn: ScribeTurnKind | null
  /** The calls to run, at most `NAVIGATOR_CALLS_PER_STEP`. */
  calls: NavigatorCall[]
  /** The evidence ids to use ("E3"), at most `NAVIGATOR_USE_MAX`; null when it named none. */
  use: string[] | null
  /** Calls left out: an unknown tool, a call with nothing to call it with, past the cap. */
  skipped: number
}

/** A tool argument: a string (a number too), trimmed and cut; an object or blank is ''. */
function argOf(value: unknown): string {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
  return text.replace(/\s+/gu, ' ').trim().slice(0, NAVIGATOR_ARG_CHARS)
}

/** Search words: a list, or one string split at commas; each trimmed, cut and kept once. */
function termsOf(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;]/u) : []
  const terms = raw.flatMap((term) =>
    typeof term === 'string'
      ? [term.replace(/\s+/gu, ' ').trim().slice(0, NAVIGATION_TERM_MAX)]
      : []
  )
  return [...new Set(terms.filter((term) => term !== ''))].slice(0, NAVIGATION_TERMS_MAX)
}

/** One call object (`{"search":[…]}`), or null for an unknown tool or nothing to call it with. */
function callOf(value: unknown): NavigatorCall | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  for (const [key, arg] of Object.entries(value)) {
    const tool = matchId(NAVIGATOR_TOOLS, key)
    if (tool === undefined) continue
    switch (tool) {
      case 'search': {
        const terms = termsOf(arg)
        return terms.length === 0 ? null : { tool, terms }
      }
      case 'outline':
      case 'todos':
        return { tool }
      case 'timeline':
      case 'ideas':
        // No name: the story's years, or every record's Ideas.
        return { tool, arg: argOf(arg) }
      default: {
        const text = argOf(arg)
        return text === '' ? null : { tool, arg: text }
      }
    }
  }
  return null
}

/** A reply's JSON object (a fence taken off), or null when it is not one. */
function objectOf(text: string): Record<string, unknown> | null {
  let json: unknown
  try {
    json = JSON.parse(unfence(text))
  } catch {
    return null
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null
  return Object.fromEntries(Object.entries(json))
}

/** An evidence id as a step names it ("E3", "e3", "3"), or null. */
function useId(value: unknown): string | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''
  const match = /^\s*E?(\d{1,3})\s*$/iu.exec(text)
  return match === null ? null : `E${Number(match[1])}`
}

/**
 * One step's reply, leniently (P3 §4.2), with route.v2's field readers (`readRouteFields`,
 * `matchId`, `cleanText`): step 1's action, turn and request (an unknown action is `chat`, as the
 * router's), the calls (an unknown tool is skipped and counted; past `NAVIGATOR_CALLS_PER_STEP`
 * too), and the ids to use. A reply that is not one JSON object is unreadable: the caller answers
 * from Step 0's evidence, so the author never loses the turn. Prose fields are never read.
 */
export function parseNavigatorStep(text: string, step: number): NavigatorStep {
  const json = objectOf(text)
  if (json === null) {
    return { readable: false, route: null, turn: null, calls: [], use: null, skipped: 0 }
  }
  const route =
    step === 1
      ? readRouteFields({
          action: json.a ?? json.action,
          instruction: json.i ?? json.instruction,
          pass: json.pass,
          target: json.target,
          chapter: json.chapter
        })
      : null
  const turn = step === 1 ? (matchId(SCRIBE_TURNS, json.t) ?? null) : null
  const rawCalls = Array.isArray(json.call) ? json.call : json.call !== undefined ? [json.call] : []
  const read = rawCalls.map(callOf)
  const known = read.filter((call): call is NavigatorCall => call !== null)
  const calls = known.slice(0, NAVIGATOR_CALLS_PER_STEP)
  const skipped = read.length - calls.length
  const rawUse = Array.isArray(json.use) ? json.use : json.use !== undefined ? [json.use] : null
  const use =
    rawUse === null
      ? null
      : [...new Set(rawUse.map(useId).filter((id): id is string => id !== null))].slice(
          0,
          NAVIGATOR_USE_MAX
        )
  return {
    readable: true,
    route,
    turn,
    calls,
    use,
    skipped
  }
}
