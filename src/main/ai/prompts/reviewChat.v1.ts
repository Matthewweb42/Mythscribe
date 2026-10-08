import type { ContextReview, ContextReviewEntity } from '@shared/contextLibrary'
import { categoryFieldLabel, categoryOf } from '@shared/categories'
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

/**
 * The review chat prompt (F-9.9), version 1: the pending review of an upload (F-9.8) listed
 * compactly, the last few turns, and the author's instruction, answered as JSON operations on
 * the review (`ReviewOp`) and a one-sentence reply, on the strong tier. Prompt files are
 * versioned (F-5.12): a change is a new file, never an edit here.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules lead (the same for every message), then
 * the review (the same for every message until a change lands), then the turns and the message.
 * No voice block and no story bible: nothing here is prose, and the review already carries the
 * names the operations need.
 */
export const REVIEW_CHAT_PROMPT_VERSION = 'reviewChat.v1'

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI
 * recognises a review-chat request by it, so it must not change within this version.
 */
export const REVIEW_CHAT_RULES =
  'You are the review assistant inside a novel-writing app. The author uploaded notes; the AI ' +
  'sorted them into a pending review of story-bible sheets (characters: people and beings; ' +
  'settings: places; world: cultures, magic, history, organisations, objects, rules) and ' +
  'Project notes for what fits no sheet. Nothing is saved yet. Change the review as the author ' +
  'asks, using only these operations, with item ids and note numbers exactly as listed:\n' +
  '- {"op":"merge","items":["e1","e2"],"name":"Full Name"}: one sheet; the other names become ' +
  'its aliases. "name" is the main (full) name, optional.\n' +
  '- {"op":"split","item":"e1"}: a merged item back into one per name.\n' +
  '- {"op":"kind","item":"e1","kind":"setting"}: kind is character, setting, or world.\n' +
  '- {"op":"toNotes","item":"e1"}: into Project notes instead of a sheet.\n' +
  '- {"op":"fromNotes","notes":[1,2],"kind":"world","name":"Ashfall War"}: notes into a sheet ' +
  '(an item of that name and kind takes them).\n' +
  '- {"op":"rename","item":"e1","name":"…"}: new sheets only.\n' +
  '- {"op":"aliases","item":"e1","aliases":["…"]}: the whole list of its other names and ' +
  'titles.\n' +
  '- {"op":"include","item":"e1" or "notes","include":false}\n' +
  'Titles and nicknames are aliases, not sheets of their own. Never invent facts. When asked ' +
  'to tidy up, merge items that are clearly the same and fix kinds; nothing else. Reply with ' +
  'JSON only: {"reply":"one or two sentences on what you changed, or why you could not",' +
  '"ops":[…]}. "ops" may be empty.'

/** The user turn of the one retry after an answer that was cut off or did not parse. */
export const REVIEW_CHAT_RETRY_TURN =
  'Your last reply was cut off or was not one JSON object. Reply again with one short JSON ' +
  'object: the operations and a one-sentence reply.'

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
export function reviewItemLine(item: ContextReviewEntity): string {
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
    const category = categoryOf(item.kind)
    const label = (id: string): string => categoryFieldLabel(category, id)
    parts.push(
      `fields: ${item.fields
        .map(
          (field) =>
            `${label(field.field)}=${clip(field.upload, VALUE_CHARS)}${field.existing === null ? '' : ' (conflict)'}`
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

/** The review as the prompt lists it: the items, then the numbered Project notes. */
export function reviewListing(review: ContextReview): string {
  const items = capped(review.entities.map(reviewItemLine), REVIEW_CHAT_ITEMS_CHARS, 'items')
  const notes = capped(
    review.notes.paragraphs.map((p, i) => `${i + 1}. ${clip(p, NOTE_CHARS)}`),
    REVIEW_CHAT_NOTES_CHARS,
    'notes'
  )
  const notesState = review.notes.include ? '' : ' (left out)'
  return `Pending review:\n${items}\n\nProject notes${notesState}:\n${notes}`
}

export interface BuildReviewChatPromptInput {
  review: ContextReview
  /** Earlier turns, oldest first; the last `REVIEW_CHAT_HISTORY_TURNS` are sent, each clipped. */
  history: readonly ReviewChatTurn[]
  message: string
  /** True for the one retry of an answer that was cut off or did not parse. */
  retry?: boolean
}

export interface BuiltReviewChatPrompt {
  version: typeof REVIEW_CHAT_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildReviewChatPrompt(input: BuildReviewChatPromptInput): BuiltReviewChatPrompt {
  const messages: AiMessage[] = [
    { role: 'system', content: REVIEW_CHAT_RULES },
    { role: 'user', content: reviewListing(input.review) },
    ...input.history.slice(-REVIEW_CHAT_HISTORY_TURNS).map((turn) => ({
      role: turn.role,
      content: clip(turn.content, REVIEW_CHAT_TURN_CHARS)
    })),
    { role: 'user', content: input.message.trim() }
  ]
  if (input.retry === true) messages.push({ role: 'user', content: REVIEW_CHAT_RETRY_TURN })
  return {
    version: REVIEW_CHAT_PROMPT_VERSION,
    messages,
    maxTokens: input.retry === true ? REVIEW_CHAT_RETRY_MAX_TOKENS : REVIEW_CHAT_MAX_TOKENS
  }
}
