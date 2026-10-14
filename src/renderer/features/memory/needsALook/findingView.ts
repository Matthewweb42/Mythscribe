import { AI_DATA_SHARING } from '@shared/aiSettings'
import type { FindingView } from '@shared/memory/findings'
import type { FindingsView } from '@shared/memory/views'

/**
 * The words of a possible contradiction (F-16.27, F-16.29; plan P4 §3.3, slice 4's `FindingRow`
 * builds on them): the record and the slot, then each side's value and where it is, "Mara Vell’s
 * eyes: grey (1.1) · brown (1.2)". A note side names the page ("Orrin’s Pinned page").
 */

const possessive = (name: string): string => (/s$/iu.test(name) ? `${name}’` : `${name}’s`)

/** One finding as a line. */
export function findingLine(view: FindingView): string {
  return `${possessive(view.name)} ${view.slotLabel.toLowerCase()}: ${view.a.value} (${view.a.label}) · ${view.b.value} (${view.b.label})`
}

/** The check's name, as Settings shows its switch. */
const CONTRADICTION_CHECK = AI_DATA_SHARING.judge.label

/** Where *Check the book* lives, as the chat names it. */
export const CHECK_THE_BOOK_HINT = 'Check the book, in the Book tab, looks through the whole book.'

const plural = (count: number, one: string, many: string): string =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`

/**
 * P4-D23: the chat's answer to "Check this scene for consistency" in story memory v2, made
 * locally from the open scene's open findings (no request): each as a line, or that none was found
 * in the scene so far; then what was not checked (absence is never shown as fact): the
 * check switched off (nothing was judged, so nothing is claimed), the scene not read yet or its
 * sentences not read yet, pairs still waiting for a verdict or being judged; then where *Check the
 * book* is.
 */
export function sceneContradictionsAnswer(view: FindingsView, nodeId: string | null): string {
  if (!view.on) {
    return `The ${CONTRADICTION_CHECK} is off, so nothing in this scene has been checked. Turn it on in Settings, AI tab.`
  }
  const scene = view.scene
  if (scene !== null && !scene.read) {
    return `This scene has not been read yet, so it has not been checked for contradictions. ${CHECK_THE_BOOK_HINT}`
  }
  const here = view.open.filter(
    (finding) => nodeId !== null && (finding.a.nodeId === nodeId || finding.b.nodeId === nodeId)
  )
  const notChecked: string[] = []
  if (scene !== null && scene.unread > 0) {
    notChecked.push(
      `${plural(scene.unread, 'sentence', 'sentences')} here ${scene.unread === 1 ? 'is' : 'are'} not read yet, so not checked.`
    )
  }
  if (view.judging) notChecked.push('The check is running now, so more may turn up.')
  else if (view.waiting > 0) {
    notChecked.push(
      `${plural(view.waiting, 'pair', 'pairs')} in the book ${view.waiting === 1 ? 'is' : 'are'} not judged yet.`
    )
  }
  const tail = [...notChecked, CHECK_THE_BOOK_HINT].join(' ')
  if (here.length === 0) return `No possible contradictions found in this scene so far. ${tail}`
  return [
    'Possible contradictions in this scene:',
    ...here.map((finding) => `- ${findingLine(finding)}`),
    tail
  ].join('\n')
}
