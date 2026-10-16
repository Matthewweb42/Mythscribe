import type { EditFlowCategory, EditFlowFamily } from '@shared/editFlow'
import { buildBookMap, buildNotesBlock, type ScribePage, type ScribeScene } from '../../scribe2/context'
import { sliceScenes, type FlowScene, type FlowSliceItem } from '../../editFlow/plan'
import { buildEditFlowPrompt } from '../prompts/editFlow.v1'
import { buildEditNotesPrompt } from '../prompts/editNotes.v1'
import { buildEditNotesV2Prompt } from '../prompts/editNotes.v2'
import type { EvalCase } from './fixtures'

/**
 * `editFlow.v1` and `editNotes.v1` cases (notes redesign phase 2): a Quick copyedit of one scene
 * with a style guide page, a Quick line edit and proofread of a chapter, the focused checks
 * together against the notes, a Deep developmental edit of a whole fixture book (on strong), and
 * Update notes on a chapter. Each is scored live by the feature's own parser: every issue must
 * quote its scene and every fix pass the tracked-change rule; nothing dropped. `editNotes.v2` (the
 * notes binder, 2026-10-16) adds three Update notes cases on the Story timeline page: an event
 * inserted in story order before a later chapter's line, a flashback's event placed before the
 * first chapter's, and the page made from a chapter's events when there is none yet.
 */

const MARA = [
  'The ferry landing smelled of tar. Mara waited with the ledger under her coat, her brown eyes on the water.',
  'Tomas came down the bank at dusk, hat in hand, and asked for the ledger back. "Its mine by rights," he said.',
  'She told him her brother had only copied it, and watched his face for the lie.'
].join('\n\n')

const ROOK = [
  'Rook watched from the mill as the two of them argued on the landing.',
  'He had burned the first ledger himself, the winter the river froze, and nobody alive knew it but him.',
  'When Tomas turned away, Rook went down to the water and spoke to Mara for the first time.'
].join('\n\n')

const PAGES: ScribePage[] = [
  {
    ref: 'p1',
    id: 'pg-mara',
    kind: 'note',
    title: 'Mara',
    folder: 'Characters',
    text: 'Eyes: grey. Fears the sea since her father drowned. Wants the mill back.'
  },
  {
    ref: 'p2',
    id: 'pg-tomas',
    kind: 'note',
    title: 'Tomas',
    folder: 'Characters',
    text: 'The miller. Speaks plainly, never swears. Burned the first ledger (secret).'
  },
  {
    ref: 'p3',
    id: 'pg-style',
    kind: 'note',
    title: 'Style guide',
    folder: '',
    text: 'British spelling. Serial comma. Numbers under a hundred in words.'
  },
  {
    ref: 'p4',
    id: 'pg-timeline',
    kind: 'note',
    title: 'Timeline',
    folder: '',
    text: 'Year 1, winter: the river freezes. Year 3, spring: the ledger dispute.'
  }
]

function bookScene(n: number, chapter: number, text: string): ScribeScene {
  return {
    ref: `n${n + 2}`,
    nodeId: `sc-${n}`,
    title: `Chapter ${chapter} › Scene ${n}`,
    synopsis: n === 1 ? 'Mara confronts Tomas over the mill ledger.' : '',
    notes: n === 1 ? 'Ends with the reveal about the elm.' : '',
    summary: n === 2 ? 'Rook watches from the mill.' : '',
    text
  }
}

const flowScene = (scene: ScribeScene, chapter: string): FlowScene => ({
  nodeId: scene.nodeId,
  ref: scene.ref,
  title: scene.title,
  chapterId: chapter,
  chapterTitle: chapter,
  text: scene.text
})

const item = (scene: ScribeScene): FlowSliceItem => ({
  nodeId: scene.nodeId,
  ref: scene.ref,
  title: scene.title,
  text: scene.text,
  part: { index: 0, count: 1 }
})

/** A fixture book of `count` scenes, alternating the two passages, three scenes a chapter. */
function book(count: number): ScribeScene[] {
  return Array.from({ length: count }, (_, i) =>
    bookScene(i + 1, Math.floor(i / 3) + 1, i % 2 === 0 ? MARA : ROOK)
  )
}

const SHORT = book(2)
const NOTES = buildNotesBlock(PAGES, new Set()).text

function flowCase(
  name: string,
  note: string,
  family: Exclude<EditFlowFamily, 'notes'>,
  checks: EditFlowCategory[],
  scenes: ScribeScene[],
  items: FlowSliceItem[],
  label: string,
  tier: 'fast' | 'strong' = 'fast'
): EvalCase {
  const built = buildEditFlowPrompt({
    family,
    checks,
    styleGuide: family === 'copy' ? { ref: 'p3', title: 'Style guide' } : null,
    notes: NOTES,
    map: buildBookMap(scenes),
    reference: null,
    slice: { index: 0, count: 1, label },
    items
  })
  return {
    version: built.version,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    ...(tier === 'strong' ? { tier } : {}),
    scoring: {
      kind: 'editFlow',
      family,
      checks,
      items: items.map((entry) => ({ nodeId: entry.nodeId, ref: entry.ref, text: entry.text }))
    }
  }
}

/** A whole fixture book in one Deep slice. */
function deepCase(): EvalCase {
  const scenes = book(120)
  const slice = sliceScenes(
    scenes.map((scene) => flowScene(scene, scene.title.split(' › ')[0] ?? '')),
    'deep'
  )[0]
  return flowCase(
    'deepDevelopmental',
    'Deep, on strong: a developmental review of a 120-scene fixture book in one slice, overview and cited issues, no fixes',
    'developmental',
    [],
    scenes,
    slice?.items ?? [],
    'the whole book',
    'strong'
  )
}

/** The notes as the binder files them (Documents › …), with the Story timeline page or without. */
function binderPages(timeline: string[] | null): ScribePage[] {
  const pages: ScribePage[] = PAGES.filter((page) => page.title !== 'Timeline').map((page) => ({
    ...page,
    folder: page.folder === '' ? 'Documents' : `Documents › ${page.folder}`
  }))
  if (timeline !== null) {
    pages.push({
      ref: `p${pages.length + 1}`,
      id: 'pg-story-timeline',
      kind: 'note',
      title: 'Story timeline',
      folder: 'Timeline',
      text: timeline.join('\n')
    })
  }
  return pages
}

const TIMELINE = [
  'Ch 1 · Mara confronts Tomas over the ledger at the ferry landing.',
  'Ch 3 · Mara leaves the valley with the ledger.'
]

const MILL = [
  'Rook found Mara at the mill the morning after the argument and spoke to her for the first time.',
  'He gave her the iron key to the sluice house and told her to keep it from Tomas.'
].join('\n\n')

/** An `editNotes.v2` case on one chapter, scored on where its events land on the page. */
function timelineCase(
  name: string,
  note: string,
  page: string[] | null,
  scenes: ScribeScene[],
  label: string,
  order: { first: string; then: string }
): EvalCase {
  const built = buildEditNotesV2Prompt({
    notes: buildNotesBlock(binderPages(page), new Set()).text,
    map: buildBookMap(scenes),
    reference: null,
    slice: { index: 0, count: 1, label },
    items: scenes.map(item)
  })
  return {
    version: built.version,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'editNotes', timeline: { page: page ?? [], ...order } }
  }
}

function timelineCases(): EvalCase[] {
  const [one, two] = SHORT
  if (one === undefined || two === undefined) return []
  const mill = bookScene(4, 2, MILL)
  const told = bookScene(5, 2, ROOK)
  return [
    timelineCase(
      'updateNotesStoryOrder',
      'Chapter 2: Rook meets Mara and gives her the key; the events go between Ch 1 and Ch 3 on the Story timeline',
      TIMELINE,
      [mill],
      'Chapter 2',
      { first: 'rook', then: 'leaves the valley' }
    ),
    timelineCase(
      'updateNotesFlashback',
      'Chapter 2 tells of the ledger burned the winter the river froze: that event goes before Ch 1 on the Story timeline',
      TIMELINE,
      [told],
      'Chapter 2',
      { first: 'burn', then: 'confronts' }
    ),
    timelineCase(
      'updateNotesTimelineMade',
      'No Story timeline page yet: Chapter 1’s events make it, the burned ledger (years before) first',
      null,
      [one, two],
      'Chapter 1',
      { first: 'burn', then: 'tomas' }
    )
  ]
}

export function editFlowEvalCases(): EvalCase[] {
  const [one, two] = SHORT
  if (one === undefined || two === undefined) return []
  const chapter = [item(one), item(two)]
  const notes = buildEditNotesPrompt({
    notes: NOTES,
    map: buildBookMap(SHORT),
    reference: null,
    slice: { index: 0, count: 1, label: 'Chapter 1' },
    items: chapter
  })
  return [
    flowCase(
      'quickCopy',
      'Quick copyedit of one scene with a Style guide page: the "Its" and the swear-free miller',
      'copy',
      [],
      SHORT,
      [item(one)],
      one.title
    ),
    flowCase(
      'quickLine',
      'Quick line edit of a two-scene chapter',
      'line',
      [],
      SHORT,
      chapter,
      'Chapter 1'
    ),
    flowCase(
      'quickProof',
      'Quick proofread of a two-scene chapter: residual typos only',
      'proof',
      [],
      SHORT,
      chapter,
      'Chapter 1'
    ),
    flowCase(
      'quickChecks',
      'The four focused checks together: brown eyes against grey on p1, Rook’s secret against p2',
      'checks',
      ['continuity', 'plotHoles', 'voice', 'lineSpelling'],
      SHORT,
      chapter,
      'Chapter 1'
    ),
    deepCase(),
    {
      version: notes.version,
      name: 'updateNotes',
      note: 'Update notes from a two-scene chapter: Rook has no page; the frozen river is on the timeline',
      messages: notes.messages,
      maxTokens: notes.maxTokens,
      scoring: { kind: 'editNotes' }
    },
    ...timelineCases()
  ]
}
