import type { FiledConflict } from '@shared/filing'
import type { AuthorTodo } from '@shared/memory/authorTodo'
import type { Dismissed, DismissedKind } from '@shared/memory/dismissed'
import type { FindingView } from '@shared/memory/findings'
import type { NameQuestion } from '@shared/memory/nameQuestions'
import type { NameMentionView } from '@shared/memory/nameScan'
import type { StoryRecordSummary } from '@shared/memory/records'
import type { DetailConflictNotice, LooseEnd, MemoryNotice } from '@shared/memory/views'

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
  | {
      id: 'conflicts'
      conflicts: FiledConflict[]
      /** Decision 4 (F-16.18): typed details the text disagrees with, asked once each. */
      details: DetailConflictNotice[]
      /** F-16.27 (P4): the open contradictions, book against book and book against a note. */
      findings: FindingView[]
      /** The unclear ones, under a collapsed line (never counted). */
      unclear: FindingView[]
    }
  | {
      id: 'todos'
      /** The open to-dos, in her order. */
      todos: AuthorTodo[]
      /** The ticked ones, drawn behind a collapsed "n done" line (no upkeep: they never crowd it). */
      done: AuthorTodo[]
    }
  | { id: 'questions'; questions: NameQuestion[] }
  | {
      id: 'looseEnds'
      /** F-16.29: what the book leaves hanging behind the furthest drafted scene. */
      items: LooseEnd[]
      /** How many more there are than shown. */
      more: number
    }
  | {
      id: 'notices'
      notices: string[]
      /** The reading's notices (F-16.16, F-16.19), each with its buttons. */
      memory: MemoryNotice[]
    }

export const NEEDS_A_LOOK_HEADING: Record<NeedsALookGroup['id'], string> = {
  conflicts: 'Conflicts',
  todos: 'My to-dos',
  questions: 'Questions',
  looseEnds: 'Loose ends',
  notices: 'Notices'
}

/**
 * The groups of Needs a look in their order (design §2.7, P4-D20): **My to-dos** on top, then
 * **Conflicts** (F-16.9's filed lines whose source changed, decision 4's typed details the text
 * disagrees with, and F-16.27's open contradictions, with the unclear ones apart), the name
 * **Questions**, **Loose ends** (F-16.29) and **Notices** (the reading's among them); a group with
 * nothing in it is not drawn. Ticked to-dos sit apart from the open ones (`done`). `todosOpen`
 * keeps the to-do group drawn while the author is adding the first one; `conflictsOpen` keeps the
 * Conflicts drawn while a *This one's right* line shows there. `memory` is every reading notice;
 * the typed-detail conflicts among them go under Conflicts.
 */
export function needsALookGroups(input: {
  conflicts?: readonly FiledConflict[]
  todos: readonly AuthorTodo[]
  questions: readonly NameQuestion[]
  notices: readonly string[]
  memory?: readonly MemoryNotice[]
  findings?: readonly FindingView[]
  unclear?: readonly FindingView[]
  looseEnds?: { items: readonly LooseEnd[]; more: number } | null
  todosOpen?: boolean
  conflictsOpen?: boolean
}): NeedsALookGroup[] {
  const groups: NeedsALookGroup[] = []
  const conflicts = input.conflicts ?? []
  const details = detailConflictsOf(input.memory ?? [])
  const findings = input.findings ?? []
  const unclear = input.unclear ?? []
  const reading = (input.memory ?? []).filter((notice) => notice.kind !== 'detailConflict')
  if (input.todos.length > 0 || input.todosOpen === true) {
    groups.push({
      id: 'todos',
      todos: input.todos.filter((todo) => !todo.done),
      done: input.todos.filter((todo) => todo.done)
    })
  }
  if (
    conflicts.length > 0 ||
    details.length > 0 ||
    findings.length > 0 ||
    unclear.length > 0 ||
    input.conflictsOpen === true
  ) {
    groups.push({
      id: 'conflicts',
      conflicts: [...conflicts],
      details,
      findings: [...findings],
      unclear: [...unclear]
    })
  }
  if (input.questions.length > 0) groups.push({ id: 'questions', questions: [...input.questions] })
  const loose = input.looseEnds ?? null
  if (loose !== null && loose.items.length > 0) {
    groups.push({ id: 'looseEnds', items: [...loose.items], more: loose.more })
  }
  if (input.notices.length > 0 || reading.length > 0) {
    groups.push({ id: 'notices', notices: [...input.notices], memory: reading })
  }
  return groups
}

/** The typed-detail conflicts among the reading's notices. */
export function detailConflictsOf(notices: readonly MemoryNotice[]): DetailConflictNotice[] {
  return notices.filter(
    (notice): notice is DetailConflictNotice => notice.kind === 'detailConflict'
  )
}

/**
 * The Needs a look badge (design §2.7, P4-D20): it counts conflicts only (the filed lines whose
 * source changed, F-16.9; the typed details the text disagrees with, decision 4; the open
 * contradictions, F-16.27), never unclear ones, loose ends, questions, to-dos or notices, and shows
 * nothing at zero.
 */
export function needsALookBadge(conflicts: number): string | null {
  return conflicts > 0 ? String(conflicts) : null
}

/** What the badge counts: filed lines, typed details and open findings. */
export function conflictCount(input: { filed: number; details: number; findings: number }): number {
  return input.filed + input.details + input.findings
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

/**
 * A Dismissed row as the list shows it (P4 slice 4): a contradiction's or a loose end's *Not a
 * problem* reads "Not a problem: Mara Vell, eyes grey (1.1) and brown (1.2)" under its own kind
 * ("Contradiction", "Loose end"), from the label main wrote ("Mara Vell: eyes grey (1.1) and brown
 * (1.2): not a problem"); every other row keeps its kind and label.
 */
export function dismissedRow(item: Dismissed): { kind: string; label: string } {
  if (item.kind === 'notProblem') {
    const bare = item.label.replace(/: not a problem$/u, '')
    if (item.key.startsWith('finding|')) {
      const at = bare.indexOf(': ')
      const words = at < 0 ? bare : `${bare.slice(0, at)}, ${bare.slice(at + 2)}`
      return { kind: 'Contradiction', label: `Not a problem: ${words}` }
    }
    if (item.key.startsWith('loose|')) {
      return { kind: 'Loose end', label: `Not a problem: ${bare.replace(/^Loose end: /u, '')}` }
    }
  }
  return { kind: DISMISSED_KIND_LABEL[item.kind], label: item.label }
}

/** A filed-line conflict's line: "Filed from “Bestiary” ¶4, which now reads “…”". */
export function conflictLine(conflict: FiledConflict): string {
  const where = `Filed from “${conflict.docTitle}” ${paragraphLabel(conflict.para)}`
  if (conflict.pageNotCanon) return `${where}, which is now Not canon`
  return conflict.nowReads === null
    ? `${where}, which now has no text there`
    : `${where}, which now reads “${conflict.nowReads}”`
}
