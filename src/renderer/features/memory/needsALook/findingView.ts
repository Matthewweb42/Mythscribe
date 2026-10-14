import { AI_DATA_SHARING } from '@shared/aiSettings'
import type { ContradictionsTurn } from '@shared/chat'
import { CONTRADICTIONS_TURN_MAX } from '@shared/chat'
import type { FindingRule, FindingSideView, FindingView } from '@shared/memory/findings'
import type { FindingsView } from '@shared/memory/views'
import { formatCents } from '@renderer/features/ai/usageFormat'

/**
 * The words of a possible contradiction (F-16.27, F-16.29; plan P4 §3.3 and §4): the record and
 * the slot, then each side's value and where it is, "Mara Vell’s eyes: grey (1.1) · brown (1.2)",
 * each rule worded as it finds ("Hobb dies in 4.3 and is here in 9.1"), a note conflict as "Your
 * note on Orrin says born 1790; the book says 1792 (1.1)", and ⓘ's lines (how it was found, judged
 * and confirmed, and what it cost). Pure; the renderer alone words these lines, and none of them
 * reaches a request except the chat turn's positive lines (`contradictionsText`).
 */

export const possessive = (name: string): string => (/s$/iu.test(name) ? `${name}’` : `${name}’s`)

/**
 * A finding's slot inside a sentence: the base word in lower case, a name in it kept as written
 * ("eyes", "family (to Orrin)" for kinship, "knows: Orrin’s debt").
 */
export function slotWords(slotLabel: string): string {
  const family = /^Family \((.+)\)$/u.exec(slotLabel)
  if (family !== null) return `family (to ${family[1]})`
  const knows = /^Knows: (.+)$/u.exec(slotLabel)
  if (knows !== null) return `knows: ${knows[1]}`
  return slotLabel.toLowerCase()
}

/** One finding as a line of its values: "Mara Vell’s eyes: grey (1.1) · brown (1.2)". */
export function findingLine(view: FindingView): string {
  return `${possessive(view.name)} ${slotWords(view.slotLabel)}: ${view.a.value} (${view.a.label}) · ${view.b.value} (${view.b.label})`
}

/** C4's scene year as the line names it: "year 1810, typed in its details"; null when none. */
function yearWords(view: FindingView): string | null {
  if (view.year === null) return null
  const where = view.year.source === 'typed' ? 'typed in its details' : 'stated in its text'
  return `year ${view.year.value}, ${where}`
}

/** A C3 finding's secret, from its slot label ("Knows: the secret engagement"). */
const secretOf = (view: FindingView): string => view.slotLabel.replace(/^Knows: /u, '')

/**
 * A finding in its rule's words (plan P4 §4): C1, C2's body change and C7 as their values
 * (`findingLine`); C2's death "Hobb dies in 4.3 and is here in 9.1"; C3 "Bel passes on the secret
 * engagement in 5.2 before learning it in 5.3"; C4 "Lottie is 17 in 19.1 (year 1810, typed in its
 * details); born 1795 (Lottie’s Pinned page)" or "Lottie’s stated age falls: 18 (3.1) · 16 (5.2)";
 * C5 "Lottie’s match: resolved in 9.1, advanced again in 19.1"; a note conflict as
 * `noteConflictLine`.
 */
export function findingRuleLine(view: FindingView): string {
  const { a, b, name } = view
  switch (view.rule) {
    case 'C2':
      return view.variant === 'dead'
        ? `${name} dies in ${a.label} and is here in ${b.label}`
        : findingLine(view)
    case 'C3':
      return `${name} passes on ${secretOf(view)} in ${a.label} before learning it in ${b.label}`
    case 'C4': {
      if (view.variant === 'falls') {
        return `${possessive(name)} stated age falls: ${a.value} (${a.label}) · ${b.value} (${b.label})`
      }
      const year = yearWords(view)
      return `${name} is ${a.value} in ${a.label}${year === null ? '' : ` (${year})`}; born ${b.value} (${b.label})`
    }
    case 'C5':
      return `${name}: resolved in ${a.label}, advanced again in ${b.label}`
    case 'C6':
      return noteConflictLine(view) ?? findingLine(view)
    case 'C1':
    case 'C7':
      return findingLine(view)
  }
}

/** A finding's note side and book side (a C6 finding has one of each); null for book against book. */
export function noteSides(
  view: FindingView
): { note: FindingSideView; book: FindingSideView } | null {
  if (view.a.kind === 'note' && view.b.kind !== 'note') return { note: view.a, book: view.b }
  if (view.b.kind === 'note' && view.a.kind !== 'note') return { note: view.b, book: view.a }
  return null
}

/**
 * Where a side is, as a line opens: a book quote by its scene ("1.1"), a note by its page ("Your
 * note on Orrin", "Your Research page “Harbour notes”"). The hover card (F-16.28) and the note
 * conflict's line share it.
 */
export function sideWhere(side: FindingSideView): string {
  if (side.kind !== 'note') return side.label
  return side.open.kind === 'research' ? `Your Research page “${side.ref}”` : `Your note on ${side.ref}`
}

/** Slots whose value reads before the noun ("green eyes", "dark hair"). */
const VALUE_FIRST = new Set(['Eyes', 'Hair', 'Scars'])

/**
 * A value as a note or the book says it: "born 1790", "green eyes", "last seen at the quay",
 * "sister to Orrin" for kinship.
 */
function says(slotLabel: string, value: string): string {
  if (VALUE_FIRST.has(slotLabel)) return `${value} ${slotLabel.toLowerCase()}`
  const family = /^Family \((.+)\)$/u.exec(slotLabel)
  if (family !== null) return `${value} to ${family[1]}`
  if (slotLabel === 'Family') return value
  return `${slotLabel.charAt(0).toLowerCase()}${slotLabel.slice(1)} ${value}`
}

/**
 * A book-against-note finding (design Part 1): "Your note on Orrin says born 1790; the book says
 * 1792 (1.1)". A note not on the subject's own Pinned page (another record's, or a Research page)
 * names the subject: "Your note on Orrin says of Mara Vell: green eyes; …", "Your Research page
 * “Harbour notes” says of Orrin: born 1790; …". Null when it is not one.
 */
export function noteConflictLine(view: FindingView): string | null {
  const sides = noteSides(view)
  if (sides === null) return null
  const { note, book } = sides
  const where = sideWhere(note)
  const own = note.open.kind === 'record' && note.open.id === view.recordId
  const of = own ? '' : `of ${view.name}: `
  return `${where} says ${of}${says(view.slotLabel, note.value)}; the book says ${book.value} (${book.label})`
}

/** Why code paired the two (ⓘ's first line), by rule. */
const FOUND: Record<FindingRule, (view: FindingView) => string> = {
  C1: (view) => `two values for ${slotWords(view.slotLabel)}`,
  C2: (view) =>
    view.variant === 'dead'
      ? 'on the page after a death'
      : `${slotWords(view.slotLabel)} differs between two appearances`,
  C3: () => 'a secret passed on before it is learned',
  C4: (view) => {
    if (view.variant === 'falls') return 'a stated age lower than an earlier one'
    const year = yearWords(view)
    return `a stated age against a birth year and that scene’s year${year === null ? '' : ` (${year})`}`
  },
  C5: () => 'a plot thread advanced after it was resolved',
  C6: (view) => `the book against your note on ${slotWords(view.slotLabel)}`,
  C7: () => 'two history lines about one thing'
}

/** How the AI judged it (ⓘ's second line), by state and verdicts. */
function judgedLine(view: FindingView): string {
  if (view.state !== 'unclear') return 'judged a contradiction both ways by AI'
  // Both fast orders said contradiction; *Check the book*'s stronger read could not settle it.
  if (view.verdictAb === 'c' && view.verdictBa === 'c') {
    return 'judged a contradiction both ways by AI; the stronger check could not settle it'
  }
  return 'the AI judged it twice and the words did not settle it'
}

/**
 * ⓘ on a finding (plan P4 §4): "Found in code: two values for eyes", how the AI judged it ("judged
 * a contradiction both ways by AI", or for an unclear one that the words, or the stronger check,
 * did not settle it), the judge's reason, "confirmed by a stronger AI read" when *Check the book*
 * confirmed it, and what judging it cost.
 */
export function findingInfoLines(view: FindingView): string[] {
  const lines = [`Found in code: ${FOUND[view.rule](view)}`]
  lines.push(judgedLine(view))
  if (view.why !== null && view.why !== '') lines.push(`the AI’s reason: ${view.why}`)
  if (view.confirmed) lines.push('confirmed by a stronger AI read')
  lines.push(`judging it cost ${formatCents(view.costUsd)}`)
  return lines
}

/** Whether a finding touches a scene (either side is there). */
export const touchesScene = (view: FindingView, nodeId: string | null): boolean =>
  nodeId !== null && (view.a.nodeId === nodeId || view.b.nodeId === nodeId)

/** The check's name, as Settings shows its switch. */
const CONTRADICTION_CHECK = AI_DATA_SHARING.judge.label

/** Where *Check the book* lives, as the chat names it. */
export const CHECK_THE_BOOK_HINT = 'Check the book, in the Book tab, looks through the whole book.'

/** What the chat says when the Contradiction check is off (about the app, not the book). */
export const CHECK_OFF_LINE = `The ${CONTRADICTION_CHECK} is off, so nothing in this scene has been checked. Turn it on in Settings, AI tab.`

const plural = (count: number, one: string, many: string): string =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`

/**
 * P4-D23: the chat's consistency turn made locally from the open scene's findings (no request):
 * the findings that touch the scene, and what was not checked.
 */
export function contradictionsTurnOf(
  view: FindingsView,
  nodeId: string | null
): ContradictionsTurn {
  return {
    nodeId,
    on: view.on,
    scene: view.scene,
    waiting: view.waiting,
    judging: view.judging,
    findings: view.open
      .filter((each) => touchesScene(each, nodeId))
      .slice(0, CONTRADICTIONS_TURN_MAX)
  }
}

/**
 * The turn's text (it rides along with later requests as history, so positive lines only, rule 5):
 * the findings as lines, or that the check is off, then where *Check the book* is. The scoped
 * lines ("No possible contradictions found in this scene so far", what was not read) are drawn
 * from the turn's `contradictions` alone (`contradictionsScoped`).
 */
export function contradictionsText(turn: ContradictionsTurn): string {
  if (!turn.on) return CHECK_OFF_LINE
  if (turn.findings.length === 0) return CHECK_THE_BOOK_HINT
  return [
    'Possible contradictions in this scene:',
    ...turn.findings.map((finding) => `- ${findingRuleLine(finding)}`),
    CHECK_THE_BOOK_HINT
  ].join('\n')
}

/**
 * The scoped lines the chat draws under a consistency turn (never stated as fact, never sent): the
 * scene not read yet, or "No possible contradictions found in this scene so far" when none touch
 * it, then what was not checked (its unread sentences, pairs waiting or being judged).
 */
export function contradictionsScoped(turn: ContradictionsTurn): string[] {
  if (!turn.on) return []
  const scene = turn.scene
  if (scene !== null && !scene.read) {
    return ['This scene has not been read yet, so it has not been checked for contradictions.']
  }
  const lines: string[] = []
  if (turn.findings.length === 0)
    lines.push('No possible contradictions found in this scene so far.')
  if (scene !== null && scene.unread > 0) {
    lines.push(
      `${plural(scene.unread, 'sentence', 'sentences')} here ${scene.unread === 1 ? 'is' : 'are'} not read yet, so not checked.`
    )
  }
  if (turn.judging) lines.push('The check is running now, so more may turn up.')
  else if (turn.waiting > 0) {
    lines.push(
      `${plural(turn.waiting, 'pair', 'pairs')} in the book ${turn.waiting === 1 ? 'is' : 'are'} not judged yet.`
    )
  }
  return lines
}
