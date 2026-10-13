import { isNamedKind } from '@shared/memory/topics'
import type { EvidenceKey, EvidenceLabel } from '@shared/scribe'
import { scopeLine, scribeHistory, type HistoryTurn } from '@shared/scribeAnswer'
import { testBookScene } from '../../memory/testBook/book'
import { TEST_BOOK_LABELS } from '../../memory/testBook/labels'
import type { EvidenceItem } from '../../scribe/evidence'
import { fitScribePrompt, type ScribeFitInput } from '../../scribe/runScribe'
import {
  buildAgentPromptV9,
  renderScribeScene,
  scribeRoster,
  type BuildAgentPromptV9Input
} from '../prompts/agent.v9'
import type { EvalCase, ScribeExpect } from './fixtures'

/**
 * Ms Scribe's answer cases (F-16.25, F-16.26; plan P3 §2.5), from the test book (`memory/testBook`)
 * with an Ideas line and Pinned lines added for the cases that need them, each prompt fitted as
 * `runScribe` fits it (`fitScribePrompt`), so the token report measures what the chat sends. Live
 * (`MYTHSCRIBE_EVAL_LIVE=1`, owed by the author), they score as kind `scribe`: the reply parses,
 * every citation names an item that was sent and its quote is in that item as sent (the code
 * check), never a map; `found` or a `need` as expected; the expected edit and place; no absence
 * stated as fact; the phrases a case requires ("your idea").
 *
 * The voice block of the edit cases is the fixture profile's (`fixtures.ts` passes it in, so this
 * module does not import the fixtures it is part of).
 */

/** A scene's reference in the test book: its chapter, one scene each (`h09` → 14.1). */
const refOf = (sceneId: string): string => `${testBookScene(sceneId).chapter}.1`

/**
 * The test book's records as the roster lists them (names and nicknames, named kinds only; P4's
 * left out so these token rows stay as P3 wrote them).
 */
const ROSTER = scribeRoster(
  TEST_BOOK_LABELS.records
    .filter((record) => isNamedKind(record.kind) && record.addedFor !== 'P4')
    .map((record, i) => ({
      id: record.id,
      name: record.name,
      nicknames: record.aliases.map((alias) => alias.text).filter((text) => text !== record.name),
      created: `2026-10-01T00:00:00.${String(i).padStart(3, '0')}Z`
    })),
  new Map()
)

/**
 * E0: a test-book scene open, its caret on its last paragraph; a write run carries ids.
 * `paragraphs`: the book's words as sent, what the code quote check reads.
 */
function openScene(
  sceneId: string,
  write = false
): { text: string; paragraphs: readonly string[] } {
  const scene = testBookScene(sceneId)
  const rendered = renderScribeScene({
    ref: refOf(sceneId),
    label: 'happened',
    title: scene.title,
    paragraphs: scene.paragraphs,
    caretPara: scene.paragraphs.length - 1,
    selection: null,
    ...(write ? { id: 'n31', parentId: 'n30' } : {})
  })
  return { text: rendered.text, paragraphs: rendered.sent.flatMap((line) => line.parts) }
}

/** One paragraph of a test-book scene as an evidence item. */
function passage(
  id: string,
  sceneId: string,
  para: number,
  label: EvidenceLabel = 'happened'
): EvidenceItem {
  const scene = testBookScene(sceneId)
  const key: EvidenceKey = { kind: 'passage', source: 'scene', ownerId: sceneId, para }
  return {
    id,
    key,
    label,
    ref: `${refOf(sceneId)} ¶${para}`,
    title: scene.title,
    text: scene.paragraphs[para] ?? '',
    quotable: [scene.paragraphs[para] ?? ''],
    citable: label !== 'map',
    open: { kind: 'scene', id: sceneId, para },
    doc: null
  }
}

/** A whole test-book scene as a widened `W` item, its paragraphs numbered. */
function wholeScene(id: string, sceneId: string): EvidenceItem {
  const scene = testBookScene(sceneId)
  const last = scene.paragraphs.length - 1
  return {
    id,
    key: { kind: 'scene', nodeId: sceneId, from: 0, to: last },
    label: 'happened',
    ref: `${refOf(sceneId)} ¶0–${last}`,
    title: scene.title,
    text: scene.paragraphs.map((text, i) => `¶${i} ${text}`).join('\n'),
    quotable: [...scene.paragraphs],
    citable: true,
    open: { kind: 'scene', id: sceneId, para: 0 },
    doc: null
  }
}

/**
 * An item that is not a scene paragraph: a claim, who knows what, Ideas, Pinned, the outline,
 * with the book's words in it as `evidence.ts` keeps them (`quotable`).
 */
function item(
  id: string,
  over: Pick<EvidenceItem, 'key' | 'label' | 'ref' | 'title' | 'text' | 'quotable'>
): EvidenceItem {
  return { id, ...over, citable: over.label !== 'map', open: null, doc: null }
}

/**
 * The case's prompt, fitted as `runScribe` fits it, and what was sent for the quote check; with
 * `unsupported`, the main-claim retry of that prompt (P3-D14).
 */
function scribeCase(
  name: string,
  note: string,
  input: ScribeFitInput,
  e0: readonly string[] | null,
  expect: ScribeExpect,
  unsupported: BuildAgentPromptV9Input['unsupported'] = null
): EvalCase {
  const fitted = fitScribePrompt(input)
  const built =
    unsupported === null ? fitted.built : buildAgentPromptV9({ ...fitted.input, unsupported })
  const sent: Record<string, string[]> = {}
  if (e0 !== null) sent.E0 = [...e0]
  for (const each of fitted.sent) sent[each.id] = each.quotable
  return {
    version: built.version,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    reasoning: built.reasoning,
    scoring: {
      kind: 'scribe',
      sent,
      maps: fitted.sent.filter((each) => each.label === 'map').map((each) => each.id),
      expect
    }
  }
}

/** A read run's or write run's fit input around one open scene. */
function base(
  sceneId: string,
  question: string,
  over: Partial<ScribeFitInput['base']> = {}
): ScribeFitInput['base'] {
  return {
    access: 'read',
    turn: 'answer',
    roster: ROSTER,
    scene: openScene(sceneId, over.access === 'write').text,
    searched: null,
    question,
    ...over
  }
}

/** The fields every fit input shares. */
const fit = (
  baseInput: ScribeFitInput['base'],
  evidence: EvidenceItem[],
  over: Partial<Omit<ScribeFitInput, 'base' | 'evidence'>> = {}
): ScribeFitInput => ({
  base: baseInput,
  evidence,
  evidenceBudget: baseInput.turn === 'lookup' ? 1_200 : 3_000,
  history: [],
  widened: null,
  voice: null,
  ...over
})

/**
 * The stale case's paragraph as it reads now: the test book's h08 ¶1 edited after it was read, so
 * its age differs from the stale fact line's.
 */
const STALE_AGE_NOW = (testBookScene('h08').paragraphs[1] ?? '').replace(
  'two-and-twenty',
  'three-and-twenty'
)

/** The Ideas line the idea case recalls (design §6.1's test-book Ideas). */
export const SCRIBE_IDEA_LINE = 'Perhaps the Captain was married once before, in Ireland.'

/** Seven earlier questions and answers of one conversation: the turn-8 fixture. */
const SEVEN_TURNS: HistoryTurn[] = [
  'Who overheard Lottie and Bel?',
  'Where was Lise standing?',
  'What was she carrying?',
  'What did she think of?',
  'Where did she put the linen?',
  'When did she notice?',
  'How did Bel look at dinner?'
].flatMap((question, i): HistoryTurn[] => [
  { role: 'user', content: question },
  {
    role: 'assistant',
    content:
      `Answer ${i + 1}: Lise heard it on the landing. [E0 "She had overheard every word"] ` +
      'She stood very still with the linen growing heavy in her arms, and wished she had not heard.'
  }
])

/** The maxed case's evidence: every paragraph of the earlier scenes, far over the 3,000 budget. */
const MAXED_WIDENED = ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08', 'h09', 'h13']
const MAXED_PASSAGES: [string, number][] = MAXED_WIDENED.flatMap((sceneId) =>
  testBookScene(sceneId).paragraphs.map((_, para): [string, number] => [sceneId, para])
)

/** Twenty long earlier turns: the history at its 1,500-token cap. */
const LONG_TURNS: HistoryTurn[] = Array.from({ length: 20 }, (_, i): HistoryTurn[] => [
  { role: 'user', content: `Question ${i + 1}: ${testBookScene('h14').paragraphs[5] ?? ''}` },
  { role: 'assistant', content: testBookScene('h14').paragraphs[7] ?? '' }
]).flat()

/** A scene at E0's 12,000-token cap, for the maxed case. */
function longScene(): { text: string; paragraphs: readonly string[] } {
  const scene = testBookScene('h14')
  const paragraphs = Array.from({ length: 30 }, () => scene.paragraphs).flat()
  const rendered = renderScribeScene({
    ref: '18.1',
    label: 'happened',
    title: scene.title,
    paragraphs,
    caretPara: paragraphs.length - 1,
    selection: null,
    id: 'n31',
    parentId: 'n30'
  })
  return { text: rendered.text, paragraphs: rendered.sent.flatMap((line) => line.parts) }
}

/** Ms Scribe's eval cases; `voice` is the fixture profile's voice block for the edit turns. */
export function scribeEvalCases(voice: string): EvalCase[] {
  const lottieWrite = (question: string): ScribeFitInput['base'] =>
    base('h14', question, { access: 'write', turn: 'edit' })
  const captainOpen = [passage('E1', 'h02', 7), passage('E2', 'h02', 2), passage('E3', 'h07', 9)]
  const maxed = longScene()
  return [
    scribeCase(
      'lookup-stale',
      'a stale claim handed over: the fact line says two-and-twenty, the paragraph now three-and-twenty; answers from the paragraph, never cites the fact line',
      fit(base('h09', 'How old is Johanna?', { turn: 'lookup' }), [
        item('E1', {
          key: { kind: 'claim', claimId: 'c-johanna-age' },
          label: 'happened',
          ref: '13.1 ¶1',
          title: 'The letter',
          text: `Johanna Harrow · age: two-and-twenty · re-checking: the sentence changed since it was read\n${STALE_AGE_NOW}`,
          quotable: [STALE_AGE_NOW]
        }),
        passage('E2', 'h08', 0)
      ]),
      openScene('h09').paragraphs,
      { found: true, required: ['three-and-twenty'] }
    ),
    scribeCase(
      'open',
      'an open question with the navigator’s evidence in reading order and the scope it searched',
      fit(
        base('h14', 'When does Lise first suspect the Captain?', {
          searched: scopeLine({
            from: '6.1',
            to: '18.1',
            allEarlier: true,
            wholeBook: false,
            terms: ['suspect', 'captain', 'distrust']
          })
        }),
        captainOpen
      ),
      openScene('h14').paragraphs,
      { found: true }
    ),
    scribeCase(
      'retry-unsupported',
      'the open question asked again (P3-D14): its first sentence named 12.1 and the scope check found an earlier passage; answers from the evidence or sets found false',
      fit(
        base('h14', 'When does Lise first suspect the Captain?', {
          searched: scopeLine({
            from: '6.1',
            to: '18.1',
            allEarlier: true,
            wholeBook: false,
            terms: ['suspect', 'captain', 'distrust']
          })
        }),
        captainOpen
      ),
      openScene('h14').paragraphs,
      {},
      {
        sentence:
          'Lise first suspects the Captain on the bridge in 12.1, searching every scene up to 18.1.',
        reason: 'earlier'
      }
    ),
    scribeCase(
      'knows-absence',
      'does Mr. Harrow know of the debts: never says he does not know, states its scope',
      fit(
        base('h14', 'Does Mr. Harrow know about the Captain’s debts?', {
          searched: scopeLine({
            from: '6.1',
            to: '18.1',
            allEarlier: true,
            wholeBook: false,
            terms: ['debts', 'owed', 'money']
          })
        }),
        [
          item('E1', {
            key: { kind: 'knows', secretId: 'captain-debt' },
            label: 'happened',
            ref: '18.1',
            title: 'the Captain’s debt to Varrow',
            text:
              'Liesel Harrow: deduced (18.1): “The Captain owed Mr. Varrow money, and a great deal of it.”\n' +
              'Johanna Harrow: suspects (18.1): “She had begun to suspect something of the kind herself”',
            quotable: [
              'The Captain owed Mr. Varrow money, and a great deal of it.',
              'She had begun to suspect something of the kind herself'
            ]
          })
        ]
      ),
      openScene('h14').paragraphs,
      { found: true, required: ['searched'] }
    ),
    scribeCase(
      'idea',
      'an idea recalled from the Captain’s Ideas: cited and called the author’s idea',
      fit(base('h07', 'What was my idea about the Captain’s past?'), [
        item('E1', {
          key: { kind: 'ideas', recordId: 'captain' },
          label: 'idea',
          ref: 'The Captain’s Ideas',
          title: 'The Captain',
          text: `¶0 ${SCRIBE_IDEA_LINE}`,
          quotable: [SCRIBE_IDEA_LINE]
        }),
        passage('E2', 'h11', 2, 'ideaScene')
      ]),
      openScene('h07').paragraphs,
      { found: true, required: ['your idea'] }
    ),
    scribeCase(
      'not-found',
      'a question the evidence does not answer: found false, never a guess',
      fit(base('h04', 'What colour is Clara Pell’s hair?'), [passage('E1', 'h01', 6)]),
      openScene('h04').paragraphs,
      { found: false }
    ),
    scribeCase(
      'need',
      'the evidence lacks chapter 18, which the outline names: asks for it once',
      fit(base('h13', 'What happens when the Captain dines at Wexley?'), [
        passage('E1', 'h07', 9),
        item('E2', {
          key: { kind: 'outline' },
          label: 'computed',
          ref: '',
          title: 'Outline',
          text: 'Chapter 17\n  17.1 The regiment hears\nChapter 18\n  18.1 The Captain’s debts',
          quotable: [
            'Chapter 17',
            '17.1 The regiment hears',
            'Chapter 18',
            '18.1 The Captain’s debts'
          ]
        })
      ]),
      openScene('h13').paragraphs,
      { need: true }
    ),
    scribeCase(
      'widened',
      'the same question with chapter 18 sent whole as W items: answers from them',
      fit(
        base('h13', 'What happens when the Captain dines at Wexley?'),
        [passage('E1', 'h07', 9)],
        { widened: { what: 'chapter 18 (18.1)', items: [wholeScene('W1', 'h14')] } }
      ),
      openScene('h13').paragraphs,
      { found: true }
    ),
    scribeCase(
      'edit-insert',
      'an edit turn: a brief for the app to draft, never prose, with the voice block and ids',
      fit(
        base(
          'h05',
          'Add a short beat after Lise puts the linen away where she hesitates on the stairs.',
          {
            access: 'write',
            turn: 'edit'
          }
        ),
        [],
        { voice: { full: voice, bare: null } }
      ),
      openScene('h05').paragraphs,
      { edit: { kind: 'insert' } }
    ),
    scribeCase(
      'pin-explicit',
      'an explicit sheet write: a pin to Lottie’s Pinned',
      fit(lottieWrite('Add to Lottie’s sheet that she hates the sea.'), [], {
        voice: { full: voice, bare: null }
      }),
      openScene('h14').paragraphs,
      { edit: { kind: 'pin', place: 'pinned' } }
    ),
    scribeCase(
      'pin-ask',
      'a save Ms Scribe cannot place: a pin with place ask (the chat asks idea or canon)',
      fit(lottieWrite('Save this for Lottie: a scar from the fire.'), [], {
        voice: { full: voice, bare: null }
      }),
      openScene('h14').paragraphs,
      { edit: { kind: 'pin', place: 'ask' } }
    ),
    scribeCase(
      'pin-idea',
      'a brainstorm to save: a pin to Lottie’s Ideas, never asked',
      fit(lottieWrite('Brainstorm: Lottie had a twin; save it.'), [], {
        voice: { full: voice, bare: null }
      }),
      openScene('h14').paragraphs,
      { edit: { kind: 'pin', place: 'ideas' } }
    ),
    scribeCase(
      'plan-pin',
      'a read run (Plan) asked to pin: no edits, says Ask or Auto can',
      fit(base('h14', 'Add to Lottie’s sheet that she hates the sea.'), []),
      openScene('h14').paragraphs,
      { noEdits: true, required: ['Ask or Auto'] }
    ),
    scribeCase(
      'turn-8',
      'the eighth question of a conversation: seven earlier turns, older ones one line',
      fit(base('h05', 'And who else knew by then?'), [passage('E1', 'h04', 2)], {
        history: scribeHistory(SEVEN_TURNS)
      }),
      openScene('h05').paragraphs,
      { found: true }
    ),
    scribeCase(
      'maxed',
      'the worst input after the fit: E0 at its 12,000 cap, widened, history and voice (≤ 24,000)',
      fit(
        {
          ...base('h14', 'Rewrite the dinner so the Captain says more. '.repeat(20).trim(), {
            access: 'write',
            turn: 'edit'
          }),
          scene: maxed.text
        },
        MAXED_PASSAGES.map(([sceneId, para], i) => passage(`E${i + 1}`, sceneId, para)),
        {
          history: scribeHistory(LONG_TURNS),
          widened: {
            what: 'chapters 6-17',
            items: [...MAXED_WIDENED, ...MAXED_WIDENED, ...MAXED_WIDENED].map((sceneId, i) =>
              wholeScene(`W${i + 1}`, sceneId)
            )
          },
          voice: { full: voice, bare: null }
        }
      ),
      maxed.paragraphs,
      {}
    )
  ]
}
