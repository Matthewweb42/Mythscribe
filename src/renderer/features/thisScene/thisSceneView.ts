import type { AuthorTodo } from '@shared/memory/authorTodo'
import type { DismissedKind } from '@shared/memory/dismissed'
import type { NameQuestion } from '@shared/memory/nameQuestions'
import type { NameMentionView } from '@shared/memory/nameScan'
import type { StoryRecordSummary } from '@shared/memory/records'

/**
 * The pure rules of the This scene panel (F-16.12; story memory v2): how a scene's mentions
 * become chips, which Needs a look groups are drawn, and what the badge counts.
 */

/** One record the scene names for certain, with every place it does. */
export interface NamedChip {
  recordId: string
  name: string
  /** The scene's certain mentions of the record, in document order. */
  mentions: NameMentionView[]
}

/** One span the scan could not settle between several records ("Rynna or Tomas?"). */
export interface AmbiguousChip {
  spanKey: string
  /** The words as the scene writes them. */
  text: string
  /** The candidates' names, in roster order; a gone record is left out. */
  names: string[]
  mention: NameMentionView
}

/**
 * The chips of *Named in this scene*: the records named for certain, most named first (then by
 * where the scene first names them), and the ambiguous spans in document order, one each.
 */
export function namedChips(
  mentions: readonly NameMentionView[],
  byId: Readonly<Record<string, StoryRecordSummary>>
): { named: NamedChip[]; ambiguous: AmbiguousChip[] } {
  const named = new Map<string, NamedChip>()
  const spans = new Map<string, AmbiguousChip>()
  for (const mention of mentions) {
    const record = byId[mention.recordId]
    if (record === undefined) continue
    if (mention.ambiguous) {
      const span = spans.get(mention.spanKey)
      if (span === undefined) {
        spans.set(mention.spanKey, {
          spanKey: mention.spanKey,
          text: mention.text,
          names: [record.name],
          mention
        })
      } else if (!span.names.includes(record.name)) {
        span.names.push(record.name)
      }
      continue
    }
    const chip = named.get(mention.recordId)
    if (chip === undefined) {
      named.set(mention.recordId, { recordId: record.id, name: record.name, mentions: [mention] })
    } else {
      chip.mentions.push(mention)
    }
  }
  const first = (chip: NamedChip): number => chip.mentions[0]?.from ?? 0
  return {
    named: [...named.values()].sort(
      (a, b) => b.mentions.length - a.mentions.length || first(a) - first(b)
    ),
    ambiguous: [...spans.values()]
  }
}

/** The paragraph as the author counts it (the scan counts from 0). */
export const paragraphLabel = (para: number): string => `¶${para + 1}`

/** Why a chip is there: "named 3 times: ¶2, ¶5, ¶9". */
export function namedWhy(chip: NamedChip): string {
  const count = chip.mentions.length
  const paras = [...new Set(chip.mentions.map((mention) => mention.para))].map(paragraphLabel)
  return `named ${count === 1 ? 'once' : `${count} times`}: ${paras.join(', ')}`
}

/** An ambiguous span's question: "Rynna or Tomas?". */
export function ambiguousLabel(chip: AmbiguousChip): string {
  if (chip.names.length <= 2) return `${chip.names.join(' or ')}?`
  return `${chip.names.slice(0, -1).join(', ')} or ${chip.names.at(-1) ?? ''}?`
}

/** Why an ambiguous span is dimmed. */
export function ambiguousWhy(chip: AmbiguousChip): string {
  return `“${chip.text}” could be ${ambiguousLabel(chip).slice(0, -1)} (${paragraphLabel(chip.mention.para)})`
}

/** The notice an open scene with inline tags carries until the switch-over (P1-D11). */
export const INLINE_TAGS_NOTICE = 'Inline tags show as plain text until you switch over.'

/** One group of Needs a look, as drawn. */
export type NeedsALookGroup =
  | { id: 'todos'; todos: AuthorTodo[] }
  | { id: 'questions'; questions: NameQuestion[] }
  | { id: 'notices'; notices: string[] }

export const NEEDS_A_LOOK_HEADING: Record<NeedsALookGroup['id'], string> = {
  todos: 'My to-dos',
  questions: 'Questions',
  notices: 'Notices'
}

/**
 * The groups of Needs a look in their order (My to-dos on top, then the name Questions, then
 * Notices); a group with nothing in it is not drawn. `todosOpen` keeps the to-do group drawn while
 * the author is adding the first one.
 */
export function needsALookGroups(input: {
  todos: readonly AuthorTodo[]
  questions: readonly NameQuestion[]
  notices: readonly string[]
  todosOpen?: boolean
}): NeedsALookGroup[] {
  const groups: NeedsALookGroup[] = []
  if (input.todos.length > 0 || input.todosOpen === true) {
    groups.push({ id: 'todos', todos: [...input.todos] })
  }
  if (input.questions.length > 0) groups.push({ id: 'questions', questions: [...input.questions] })
  if (input.notices.length > 0) groups.push({ id: 'notices', notices: [...input.notices] })
  return groups
}

/**
 * The Needs a look badge (design §2.7): it counts conflicts only, never questions, to-dos or
 * notices, and shows nothing at zero. P1 has no conflict yet (slice 5's filed-line checks are the
 * first), so the panel passes 0 until then.
 */
export function needsALookBadge(conflicts: number): string | null {
  return conflicts > 0 ? String(conflicts) : null
}

/** A name question's line: "Hesk: named in 2 scenes" or "Is “Ry” Rynna Falsire?". */
export function questionLine(question: NameQuestion): string {
  if (question.kind === 'nickname') {
    return `Is “${question.name}” ${question.recordName ?? 'that record'}?`
  }
  const scenes = question.nodeIds.length
  return `${question.name}: named in ${scenes} scene${scenes === 1 ? '' : 's'}`
}

/** The Cast of the Book tab: the Characters records, most-named first, then by name. */
export function castOf(
  records: readonly StoryRecordSummary[],
  scenes: Readonly<Record<string, number>>
): StoryRecordSummary[] {
  return records
    .filter((record) => record.kind === 'character')
    .sort((a, b) => (scenes[b.id] ?? 0) - (scenes[a.id] ?? 0) || a.name.localeCompare(b.name))
}

/** What each kind of row reads as in the list. */
export const DISMISSED_KIND_LABEL: Record<DismissedKind, string> = {
  name: 'Not a name',
  alias: 'Not this nickname',
  notMention: 'Not a mention',
  split: 'Split',
  notSame: 'Not the same',
  unlink: 'Unlinked',
  notRight: 'Not right',
  notProblem: 'Not a problem'
}
