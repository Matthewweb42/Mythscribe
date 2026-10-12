import { BUILTIN_CATEGORIES } from '@shared/categories'
import { type FilingItem, type FilingReview } from '@shared/filing'
import {
  REVIEW_CHAT_HISTORY_TURNS,
  REVIEW_CHAT_ITEMS_CHARS,
  REVIEW_CHAT_MAX_TOKENS,
  REVIEW_CHAT_RETRY_MAX_TOKENS,
  REVIEW_CHAT_TURN_CHARS,
  type ReviewChatTurn
} from '@shared/reviewChat'
import type { AiMessage } from '../providers/types'
import { REVIEW_CHAT_RETRY_TURN } from './reviewChat.v1'

/**
 * The review chat prompt (F-9.9) over a filing review, version 3 (F-16.9; story memory v2 only):
 * the same contract as version 2 (`{"reply","ops"}`, the same operation shapes and caps) over the
 * new review shape: records new or added to, each with its lines for Pinned and its new
 * nicknames. The operations that fed Project notes and split a merged sheet are left out (filing
 * leaves what fits no record in the document). Strong tier, JSON, reasoning off
 * (`NO_REASONING_PROMPTS`); a v1 project keeps sending `reviewChat.v2` with its old reasoning.
 * Prompt files are versioned (F-5.12): a change is a new file.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules lead, then the review, then the turns and
 * the message.
 */
export const REVIEW_CHAT_PROMPT_V3_VERSION = 'reviewChat.v3'

/**
 * The rules. The opening sentence is version 1's, byte for byte: the e2e's fake OpenAI recognises
 * a review-chat request by it.
 */
export const REVIEW_CHAT_RULES_V3 =
  'You are the review assistant inside a novel-writing app. The AI filed the author’s research ' +
  'document into a pending review of story records, new ones and additions to existing ones, each ' +
  'of a kind (a category), with lines for its pinned notes and its new nicknames. Kinds: ' +
  `${BUILTIN_CATEGORIES.map((category) => `${category.id} (${category.hint})`).join(', ')}, ` +
  'and any listed with the review. Nothing is saved yet. Change the review as the author asks, ' +
  'using only these operations, with item ids and kinds exactly as listed:\n' +
  '- {"op":"merge","items":["f1","f2"],"name":"Full Name"}: one record; the other names become ' +
  'its nicknames. At most one of them may be an existing record, which keeps its name.\n' +
  '- {"op":"kind","item":"f1","kind":"creature"}: another kind; new records only.\n' +
  '- {"op":"rename","item":"f1","name":"…"}: new records only.\n' +
  '- {"op":"aliases","item":"f1","aliases":["…"]}: the whole list of its new nicknames and ' +
  'titles.\n' +
  '- {"op":"include","item":"f1","include":false}\n' +
  'Titles and nicknames are aliases, not records of their own. Never invent facts or lines. When ' +
  'asked to tidy up, merge items that are clearly the same and fix kinds; nothing else. Reply ' +
  'with JSON only: {"reply":"one or two sentences on what you changed, or why you could not",' +
  '"ops":[…]}. "ops" may be empty.'

/** Characters kept of one line in the listing, and how many lines are shown per item. */
const LINE_CHARS = 80
const LINES_SHOWN = 3

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** One item as one line: id, kind, name, new or adding, nicknames, lines, same-as, picture, state. */
export function filingItemLineV3(item: FilingItem): string {
  const parts = [
    item.id,
    item.categoryId,
    item.name,
    item.recordId === null ? 'new record' : 'adds to the record'
  ]
  if (item.aliases.length > 0) parts.push(`new nicknames: ${item.aliases.join(', ')}`)
  if (item.lines.length > 0) {
    const shown = item.lines
      .slice(0, LINES_SHOWN)
      .map(
        (line) => `${clip(line.text, LINE_CHARS)}${line.kind === 'conflict' ? ' (conflict)' : ''}`
      )
    const more = item.lines.length - shown.length
    parts.push(`lines: ${shown.join(' | ')}${more > 0 ? ` (+${more} more)` : ''}`)
  }
  if (item.sameAs !== null) parts.push(`filed as “${item.sameAs.given}”: same as ${item.name}?`)
  if (item.image !== null) parts.push(`picture: ${item.image.name}`)
  if (!item.include) parts.push('left out')
  return parts.join(' · ')
}

/** The review as the prompt lists it: its proposed categories, then the items. */
export function filingListingV3(review: FilingReview): string {
  const listed = review.categories.map(
    (category) => `${category.id} (${category.name}${category.proposed ? ', proposed' : ''})`
  )
  const kinds = listed.length > 0 ? `More kinds: ${listed.join(', ')}\n\n` : ''
  let budget = REVIEW_CHAT_ITEMS_CHARS
  const kept: string[] = []
  for (const item of review.items) {
    const line = filingItemLineV3(item)
    if (line.length + 1 > budget) break
    budget -= line.length + 1
    kept.push(line)
  }
  const left = review.items.length - kept.length
  if (left > 0) kept.push(`(${left} more items not shown)`)
  return `${kinds}Pending filing of "${review.docTitle}":\n${kept.length > 0 ? kept.join('\n') : '(none)'}`
}

export interface BuildReviewChatPromptV3Input {
  review: FilingReview
  history: readonly ReviewChatTurn[]
  message: string
  retry?: boolean
}

export interface BuiltReviewChatPromptV3 {
  version: typeof REVIEW_CHAT_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildReviewChatPromptV3(
  input: BuildReviewChatPromptV3Input
): BuiltReviewChatPromptV3 {
  const messages: AiMessage[] = [
    { role: 'system', content: REVIEW_CHAT_RULES_V3 },
    { role: 'user', content: filingListingV3(input.review) },
    ...input.history.slice(-REVIEW_CHAT_HISTORY_TURNS).map((turn) => ({
      role: turn.role,
      content: clip(turn.content, REVIEW_CHAT_TURN_CHARS)
    })),
    { role: 'user', content: input.message.trim() }
  ]
  if (input.retry === true) messages.push({ role: 'user', content: REVIEW_CHAT_RETRY_TURN })
  return {
    version: REVIEW_CHAT_PROMPT_V3_VERSION,
    messages,
    maxTokens: input.retry === true ? REVIEW_CHAT_RETRY_MAX_TOKENS : REVIEW_CHAT_MAX_TOKENS
  }
}
