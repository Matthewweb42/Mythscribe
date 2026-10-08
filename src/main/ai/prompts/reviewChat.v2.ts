import { BUILTIN_CATEGORIES, categoryFieldLabel, categoryOf } from '@shared/categories'
import type { ContextReview, ContextReviewEntity } from '@shared/contextLibrary'
import {
  itemAliases,
  REVIEW_CHAT_HISTORY_TURNS,
  REVIEW_CHAT_ITEMS_CHARS,
  REVIEW_CHAT_MAX_TOKENS,
  REVIEW_CHAT_NOTES_CHARS,
  REVIEW_CHAT_RETRY_MAX_TOKENS,
  REVIEW_CHAT_TURN_CHARS,
  type ReviewChatTurn
} from '@shared/reviewChat'
import type { AiMessage } from '../providers/types'
import { REVIEW_CHAT_RETRY_TURN } from './reviewChat.v1'

/**
 * The review chat prompt (F-9.9), version 2 (F-9.11, story-bible categories): version 1 with the
 * library of categories in place of the three kinds, so "the Weave is a magic system" moves an
 * item into Magic Systems, and the project's own and the proposed categories listed with the
 * review. Prompt files are versioned (F-5.12): a change is a new file.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules with the library lead (the same for every
 * message of every project), then the review with its categories (the same until a change
 * lands), then the turns and the message.
 */
export const REVIEW_CHAT_PROMPT_V2_VERSION = 'reviewChat.v2'

/**
 * The rules. The opening sentence is version 1's, byte for byte: the e2e's fake OpenAI recognises
 * a review-chat request by it.
 */
export const REVIEW_CHAT_RULES_V2 =
  'You are the review assistant inside a novel-writing app. The author uploaded notes; the AI ' +
  'sorted them into a pending review of story-bible sheets, each of a kind (a category), and ' +
  'Project notes for what fits no sheet. Kinds: ' +
  `${BUILTIN_CATEGORIES.map((category) => `${category.id} (${category.hint})`).join(', ')}, ` +
  'and any listed with the review. Nothing is saved yet. Change the review as the author asks, ' +
  'using only these operations, with item ids, note numbers, and kinds exactly as listed:\n' +
  '- {"op":"merge","items":["e1","e2"],"name":"Full Name"}: one sheet; the other names become ' +
  'its aliases. "name" is the main (full) name, optional.\n' +
  '- {"op":"split","item":"e1"}: a merged item back into one per name.\n' +
  '- {"op":"kind","item":"e1","kind":"magic"}: another kind.\n' +
  '- {"op":"toNotes","item":"e1"}: into Project notes instead of a sheet.\n' +
  '- {"op":"fromNotes","notes":[1,2],"kind":"history","name":"Ashfall War"}: notes into a sheet ' +
  '(an item of that name and kind takes them).\n' +
  '- {"op":"rename","item":"e1","name":"…"}: new sheets only.\n' +
  '- {"op":"aliases","item":"e1","aliases":["…"]}: the whole list of its other names and ' +
  'titles.\n' +
  '- {"op":"include","item":"e1" or "notes","include":false}\n' +
  'Titles and nicknames are aliases, not sheets of their own. Never invent facts. When asked ' +
  'to tidy up, merge items that are clearly the same and fix kinds; nothing else. Reply with ' +
  'JSON only: {"reply":"one or two sentences on what you changed, or why you could not",' +
  '"ops":[…]}. "ops" may be empty.'

/** Characters kept of one field value, of one detail, and of one note in the listing. */
const VALUE_CHARS = 60
const DETAIL_CHARS = 100
const DETAILS_SHOWN = 2
const NOTE_CHARS = 160

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** One item as one line: id, kind, name, sheet, other names, files, fields, details, state. */
export function reviewItemLineV2(item: ContextReviewEntity, review: ContextReview): string {
  const parts = [
    item.id,
    item.kind,
    item.name,
    item.existingId === null ? 'new sheet' : 'existing sheet'
  ]
  const aliases = itemAliases(item)
  if (aliases.length > 0) parts.push(`also: ${aliases.join(', ')}`)
  const files = [...new Set(item.records.map((record) => record.fileName))]
  if (files.length > 0) parts.push(`from ${files.join(', ')}`)
  if (item.fields.length > 0) {
    const category = categoryOf(item.kind, review.categories)
    parts.push(
      `fields: ${item.fields
        .map(
          (field) =>
            `${categoryFieldLabel(category, field.field)}=${clip(field.upload, VALUE_CHARS)}${field.existing === null ? '' : ' (conflict)'}`
        )
        .join('; ')}`
    )
  }
  if (item.details.length > 0) {
    const shown = item.details.slice(0, DETAILS_SHOWN).map((d) => clip(d, DETAIL_CHARS))
    const more = item.details.length - shown.length
    parts.push(`details: ${shown.join(' | ')}${more > 0 ? ` (+${more} more)` : ''}`)
  }
  if (item.images.length > 0)
    parts.push(`picture: ${item.images.map((i) => i.fileName).join(', ')}`)
  if (!item.include) parts.push('left out')
  return parts.join(' · ')
}

/** Lines in order until `max` characters, then a count of what was left off. */
function capped(lines: readonly string[], max: number, noun: string): string {
  let budget = max
  const kept: string[] = []
  for (const line of lines) {
    if (line.length + 1 > budget) break
    budget -= line.length + 1
    kept.push(line)
  }
  const left = lines.length - kept.length
  if (left > 0) kept.push(`(${left} more ${noun} not shown)`)
  return kept.length > 0 ? kept.join('\n') : '(none)'
}

/** The project's own and the proposed categories, one line; '' when there are none. */
function categoriesLine(review: ContextReview): string {
  if (review.categories.length === 0) return ''
  const listed = review.categories.map(
    (category) => `${category.id} (${category.name}${category.proposed ? ', proposed' : ''})`
  )
  return `More kinds: ${listed.join(', ')}\n\n`
}

/** The review as the prompt lists it: its categories, the items, then the numbered Project notes. */
export function reviewListingV2(review: ContextReview): string {
  const items = capped(
    review.entities.map((item) => reviewItemLineV2(item, review)),
    REVIEW_CHAT_ITEMS_CHARS,
    'items'
  )
  const notes = capped(
    review.notes.paragraphs.map((p, i) => `${i + 1}. ${clip(p, NOTE_CHARS)}`),
    REVIEW_CHAT_NOTES_CHARS,
    'notes'
  )
  const notesState = review.notes.include ? '' : ' (left out)'
  return `${categoriesLine(review)}Pending review:\n${items}\n\nProject notes${notesState}:\n${notes}`
}

export interface BuildReviewChatPromptV2Input {
  review: ContextReview
  /** Earlier turns, oldest first; the last `REVIEW_CHAT_HISTORY_TURNS` are sent, each clipped. */
  history: readonly ReviewChatTurn[]
  message: string
  /** True for the one retry of an answer that was cut off or did not parse. */
  retry?: boolean
}

export interface BuiltReviewChatPromptV2 {
  version: typeof REVIEW_CHAT_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildReviewChatPromptV2(
  input: BuildReviewChatPromptV2Input
): BuiltReviewChatPromptV2 {
  const messages: AiMessage[] = [
    { role: 'system', content: REVIEW_CHAT_RULES_V2 },
    { role: 'user', content: reviewListingV2(input.review) },
    ...input.history.slice(-REVIEW_CHAT_HISTORY_TURNS).map((turn) => ({
      role: turn.role,
      content: clip(turn.content, REVIEW_CHAT_TURN_CHARS)
    })),
    { role: 'user', content: input.message.trim() }
  ]
  if (input.retry === true) messages.push({ role: 'user', content: REVIEW_CHAT_RETRY_TURN })
  return {
    version: REVIEW_CHAT_PROMPT_V2_VERSION,
    messages,
    maxTokens: input.retry === true ? REVIEW_CHAT_RETRY_MAX_TOKENS : REVIEW_CHAT_MAX_TOKENS
  }
}
