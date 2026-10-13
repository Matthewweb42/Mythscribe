import {
  ROUTE_MESSAGE_CHARS,
  ROUTE_SELECTION_PREVIEW_CHARS,
  ROUTE_TITLE_CHARS,
  ROUTE_TURN_CHARS
} from '@shared/assistantRoute'
import { isNamedKind } from '@shared/memory/topics'
import { TEST_BOOK, testBookScene } from '../../memory/testBook/book'
import { TEST_BOOK_LABELS } from '../../memory/testBook/labels'
import {
  buildNavigatorPrompt,
  navigatorIdeas,
  navigatorMenuLine,
  navigatorRoster,
  renderNavigatorMap,
  stepFound,
  type NavigatorMapChapter,
  type NavigatorMenuLine,
  type NavigatorPrefix,
  type NavigatorStepTurn,
  type NavigatorTail
} from '../prompts/navigator.v1'
import type { ChatTurn } from '../prompts/chat.v1'
import type { EvalCase, NavigatorExpected } from './fixtures'

/**
 * Ms Scribe's navigator cases (F-16.25; plan P3 §4.4), from the test book (`memory/testBook`): the
 * roster of its records, secrets and threads, two Ideas, the story map of its chapters, and the
 * message as `ai:navigate` sends it. **Route parity**: route.v2's eight cases replayed through
 * the navigator's tail (the same messages, open document and selection), plus Editor's notes,
 * What next and a synopsis, and a vague and a specific rewrite with nothing selected (scored as
 * `settleRoute` settles them: the quick picks, or a custom pass), so F-5.26's edit passes and
 * every other route action keep routing. **Search**: a first question (a search with synonyms), a
 * knows question (the `knows` tool), an idea recall (`ideas`), a structure edit (`outline`), a
 * follow-up ("do it again" after an edit pass), a menu that already answers (`use` at step 1),
 * step 3 (must end with `use`), and every cap at once. **Sheet requests** (decision 3): an
 * explicit "add this to X's sheet" and "save this idea for X" are edit turns. Live
 * (`MYTHSCRIBE_EVAL_LIVE=1`, owed by the author), they score as kind `navigator`: the reply parses
 * through `parseNavigatorStep`, the expected action, pass, target, chapter, turn kind, "i" and
 * settled decision, the expected first tool or `use`, at most 150 output tokens, and no prose
 * field.
 */

/** Now: chapter 9's scene, "Bel's news". */
const NOW_SCENE = testBookScene('h04')
const NOW_REF = `${NOW_SCENE.chapter}.1`
const ACTIVE = `scene "${NOW_SCENE.title}"`
/** The opening of a selected passage (route.v2's cases select one too). */
const SELECTION = (testBookScene('h04').paragraphs[0] ?? '').slice(0, ROUTE_SELECTION_PREVIEW_CHARS)

/** A scene's first sentence, as a stand-in for its card line. */
const firstSentence = (text: string): string => /^.*?[.!?](?=\s|$)/u.exec(text)?.[0] ?? text

/** The test book's manuscript scenes as the map's chapters (one or two scenes each). */
function bookChapters(): NavigatorMapChapter[] {
  const chapters: NavigatorMapChapter[] = []
  for (const scene of TEST_BOOK.filter((each) => each.source === 'scene')) {
    const last = chapters.at(-1)
    const number = String(scene.chapter)
    const line = firstSentence(scene.paragraphs[0] ?? '').slice(0, 160)
    if (last?.number === number) {
      last.scenes = [
        ...last.scenes,
        { ref: `${number}.${last.scenes.length + 1}`, title: scene.title, line }
      ]
    } else {
      chapters.push({
        number,
        title: scene.title,
        scenes: [{ ref: `${number}.1`, title: scene.title, line }]
      })
    }
  }
  return chapters
}

const RECORDS = TEST_BOOK_LABELS.records
const NAMED = new Map(RECORDS.map((record, i) => [record.id, RECORDS.length - i]))

function prefixOf(): NavigatorPrefix {
  const chapters = bookChapters()
  return {
    roster: navigatorRoster({
      records: RECORDS.filter((record) => isNamedKind(record.kind)).map((record, i) => ({
        id: record.id,
        name: record.name,
        nicknames: record.aliases.map((alias) => alias.text).filter((text) => text !== record.name),
        created: String(i).padStart(3, '0')
      })),
      named: NAMED,
      secrets: RECORDS.filter((record) => record.kind === 'secret').map((record) => record.name),
      threads: RECORDS.filter((record) => record.kind === 'thread').map((record) => record.name)
    }),
    ideas: navigatorIdeas(
      [
        {
          recordId: 'captain',
          name: 'the Captain',
          first: 'Perhaps the Captain was married once before, in Ireland.',
          created: '018'
        },
        {
          recordId: 'lottie',
          name: 'Lottie Harrow',
          first: 'Maybe Lottie keeps a diary she hides in the piano.',
          created: '005'
        }
      ],
      NAMED
    ),
    map: renderNavigatorMap(
      chapters,
      chapters.findIndex((chapter) => chapter.number === String(NOW_SCENE.chapter))
    )
  }
}

const PREFIX = prefixOf()

/** A menu line of a test-book paragraph, labelled "happened" (before now) or "later". */
function bookLine(id: string, sceneId: string, p: number): NavigatorMenuLine {
  const scene = testBookScene(sceneId)
  return {
    id,
    label: scene.chapter <= NOW_SCENE.chapter ? 'happened' : 'later',
    ref: `${scene.chapter}.1 ¶${p}`,
    snippet: scene.paragraphs[p] ?? ''
  }
}

/** Step 0's menu for a question about Liesel and Mr. Varrow: digests, then hits. */
const MENU: NavigatorMenuLine[] = [
  { id: 'E1', label: 'happened', ref: 'Mr. Varrow', snippet: 'Mr. Varrow · Eyes: grey (6.1)' },
  {
    id: 'E2',
    label: 'happened',
    ref: 'Liesel Harrow',
    snippet: "Liesel Harrow · Knows the Captain's debts (overheard from Mrs. Harrow, 13.1)"
  },
  bookLine('E3', 'h02', 1),
  bookLine('E4', 'h03', 0)
]

/** A scene open and nothing selected, as `settleRoute` reads the cases' tail. */
const OPEN = { hasNode: true, hasSelection: false }

function tail(message: string, over: Partial<NavigatorTail> = {}): NavigatorTail {
  return { now: NOW_REF, active: ACTIVE, selection: null, history: [], message, ...over }
}

function navigatorCase(
  name: string,
  note: string,
  input: {
    tail: NavigatorTail
    menu?: NavigatorMenuLine[]
    steps?: NavigatorStepTurn[]
    prefix?: NavigatorPrefix
  },
  expected: NavigatorExpected
): EvalCase {
  const steps = input.steps ?? []
  const built = buildNavigatorPrompt({
    prefix: input.prefix ?? PREFIX,
    tail: input.tail,
    menu: input.menu ?? [],
    steps
  })
  return {
    version: built.version,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'navigator', step: steps.length + 1, expected }
  }
}

const HISTORY: ChatTurn[] = [
  { role: 'user', content: 'Who is Mr. Varrow?' },
  { role: 'assistant', content: 'Mr. Varrow is the steward’s son who calls at Pell House.' }
]

/** Every cap at once: a long book, a full roster, a full menu, two full earlier steps. */
function maxedCase(): EvalCase {
  const long = 'Mara waits at the quay for the boat that never comes, and the tide turns. '
  const chapters: NavigatorMapChapter[] = Array.from({ length: 120 }, (_, c) => ({
    number: String(c + 1),
    title: `Chapter ${c + 1}`,
    scenes: Array.from({ length: 5 }, (__, s) => ({
      ref: `${c + 1}.${s + 1}`,
      title: `Scene ${s + 1}`,
      line: long.repeat(2)
    }))
  }))
  const records = Array.from({ length: 300 }, (_, i) => ({
    id: `r${i}`,
    name: `Character Number ${i}`,
    nicknames: [`Nick ${i}`],
    created: String(i).padStart(4, '0')
  }))
  const named = new Map(records.map((record, i) => [record.id, i]))
  const prefix: NavigatorPrefix = {
    roster: navigatorRoster({
      records,
      named,
      secrets: Array.from({ length: 40 }, (_, i) => `secret number ${i}`),
      threads: Array.from({ length: 40 }, (_, i) => `thread number ${i}`)
    }),
    ideas: navigatorIdeas(
      records.map((record) => ({
        recordId: record.id,
        name: record.name,
        first: long.repeat(3),
        created: record.created
      })),
      named
    ),
    map: renderNavigatorMap(chapters, 60)
  }
  const menu: NavigatorMenuLine[] = Array.from({ length: 60 }, (_, i) => ({
    id: `E${i + 1}`,
    label: 'happened',
    ref: `${i + 1}.1 ¶2`,
    snippet: long.repeat(4)
  }))
  const found = stepFound(
    '{"call":[{"search":["one","two","three"]}]}',
    menu.map((item) => navigatorMenuLine({ ...item, id: `E${Number(item.id.slice(1)) + 60}` }))
  )
  return navigatorCase(
    'maxed',
    'every cap at its limit: a long book, a full roster and Ideas, the message, two turns, a full menu, two full earlier steps (step 3: must use)',
    {
      prefix,
      tail: {
        now: '61.2',
        active: `scene "${'T'.repeat(ROUTE_TITLE_CHARS)}"`,
        selection: 'S'.repeat(ROUTE_SELECTION_PREVIEW_CHARS),
        history: [
          { role: 'user', content: 'U'.repeat(ROUTE_TURN_CHARS) },
          { role: 'assistant', content: 'A'.repeat(ROUTE_TURN_CHARS) }
        ],
        message: long.repeat(20).slice(0, ROUTE_MESSAGE_CHARS)
      },
      menu,
      steps: [
        {
          reply: '{"a":"query","t":"answer","call":[{"search":["one","two","three"]}]}',
          found,
          notes: []
        },
        { reply: '{"call":[{"read":"61.2"}]}', found, notes: [] }
      ]
    },
    { use: true }
  )
}

export function navigatorEvalCases(): EvalCase[] {
  return [
    // Route parity: route.v2's cases, through the navigator's tail.
    navigatorCase(
      'vague-scene',
      '"make this scene better" with the scene open and nothing selected: ask which edit',
      { tail: tail('Make this scene better.') },
      {
        action: 'editPass',
        pass: 'ask',
        target: 'scene',
        turn: 'edit',
        settled: { situation: OPEN, action: 'editPass', pass: 'ask' }
      }
    ),
    navigatorCase(
      'vague-selection',
      '"polish this" over a selection: ask which edit, on the selection',
      { tail: tail('Polish this.', { selection: SELECTION }) },
      { action: 'editPass', pass: 'ask', target: 'selection' }
    ),
    navigatorCase(
      'tighten',
      '"tighten the prose" with the scene open: a line pass on the scene',
      { tail: tail('Tighten the prose.') },
      { action: 'editPass', pass: 'line', target: 'scene' }
    ),
    navigatorCase(
      'pacing',
      '"the pacing drags" with the scene open: a developmental pass on the scene',
      { tail: tail('The pacing drags in this scene.') },
      { action: 'editPass', pass: 'developmental', target: 'scene' }
    ),
    navigatorCase(
      'proofread-chapter',
      '"proofread chapter 3": a proofread pass on the chapter it names',
      { tail: tail('Proofread chapter 3.') },
      { action: 'editPass', pass: 'proofread', target: 'chapter', chapter: '3' }
    ),
    navigatorCase(
      'rewrite-voice',
      '"rewrite this in my voice" over a selection: still Rewrite in my voice',
      { tail: tail('Rewrite this in my voice.', { selection: SELECTION, history: HISTORY }) },
      { action: 'rewrite' }
    ),
    navigatorCase(
      'question',
      'a plain question about craft with the scene open: chat',
      { tail: tail('Should Liesel trust Mr. Varrow yet, or is it too early?') },
      { action: 'chat' }
    ),
    navigatorCase(
      'route-maxed',
      'route.v2’s maxed case: the message, two turns, the title and the selection opening at their caps',
      {
        tail: tail(
          'Mara climbed the ridge as the storm broke over the valley behind her. '
            .repeat(20)
            .slice(0, ROUTE_MESSAGE_CHARS),
          {
            active: `scene "${'T'.repeat(ROUTE_TITLE_CHARS)}"`,
            selection: SELECTION,
            history: [
              { role: 'user', content: 'U'.repeat(ROUTE_TURN_CHARS) },
              { role: 'assistant', content: 'A'.repeat(ROUTE_TURN_CHARS) }
            ]
          }
        )
      },
      { action: 'chat' }
    ),
    navigatorCase(
      'critique',
      "editor's notes on the open scene",
      { tail: tail("Give me editor's notes on this scene.") },
      { action: 'critique' }
    ),
    navigatorCase(
      'whatNext',
      'ideas for what happens next',
      { tail: tail('What could happen next?') },
      { action: 'whatNext' }
    ),
    navigatorCase(
      'synopsis',
      'a synopsis for the open scene',
      { tail: tail("Write this scene's synopsis.") },
      { action: 'synopsis' }
    ),
    navigatorCase(
      'rewrite-vague',
      '"rewrite this scene" with nothing selected: "i" empty, so it settles to the quick picks',
      { tail: tail('Rewrite this scene.') },
      { instruction: 'empty', settled: { situation: OPEN, action: 'editPass', pass: 'ask' } }
    ),
    navigatorCase(
      'rewrite-specific',
      'a specific rewrite with nothing selected: "i" holds it, so it settles to a custom pass',
      { tail: tail('Rewrite this scene so Liesel sounds angrier with Mr. Varrow.') },
      { instruction: 'given', settled: { situation: OPEN, action: 'editPass', pass: 'custom' } }
    ),
    // Search.
    navigatorCase(
      'first-distrust',
      'a first question: search every earlier scene with its own synonyms',
      { tail: tail('When does Liesel first distrust Mr. Varrow?'), menu: MENU },
      { action: 'query', turn: 'answer', tool: 'search' }
    ),
    navigatorCase(
      'knows',
      'a knows question: the knows tool on the secret',
      { tail: tail("Does Mr. Harrow know about the Captain's debts?"), menu: MENU.slice(2) },
      { action: 'query', turn: 'answer', tool: 'knows' }
    ),
    navigatorCase(
      'idea-recall',
      "the author's idea about a record: the ideas tool",
      { tail: tail("What was my idea about the Captain's past?") },
      { turn: 'idea', tool: 'ideas' }
    ),
    navigatorCase(
      'structure',
      'a structure edit: the outline first',
      { tail: tail('Move 7.1 after 8.1.') },
      { action: 'chat', turn: 'edit', tool: 'outline' }
    ),
    // Sheet requests (decision 3 as the author changed it): written there, so never read-only.
    navigatorCase(
      'pin-explicit',
      'an explicit "add this to X\'s sheet": an edit turn',
      { tail: tail("Add to Mr. Varrow's sheet that he limps after the fall."), menu: MENU },
      { action: 'chat', turn: 'edit' }
    ),
    navigatorCase(
      'save-idea',
      '"save this idea for X": an edit turn',
      { tail: tail('Save this idea for Liesel: she was a smuggler once.') },
      { action: 'chat', turn: 'edit' }
    ),
    navigatorCase(
      'follow-up',
      '"do it again" after an edit pass turn: the edit pass again',
      {
        tail: tail('Do it again for this scene.', {
          history: [
            { role: 'user', content: 'Tighten the prose.' },
            { role: 'assistant', content: `Line edit started on “${NOW_SCENE.title}”.` }
          ]
        })
      },
      { action: 'editPass' }
    ),
    navigatorCase(
      'enough',
      'the menu already answers: use at step 1, no search',
      { tail: tail("What colour are Mr. Varrow's eyes?"), menu: MENU },
      { action: 'query', use: true }
    ),
    navigatorCase(
      'step3',
      'the third step after a search and a read: it must end with use',
      {
        tail: tail('When does Liesel first distrust Mr. Varrow?'),
        menu: MENU,
        steps: [
          {
            reply:
              '{"a":"query","t":"answer","call":[{"search":["distrust","suspicion","doubt"]}]}',
            found: [navigatorMenuLine(bookLine('E5', 'h03', 2))],
            notes: []
          },
          {
            reply: '{"call":[{"read":"8.1 ¶2-4"}]}',
            found: [navigatorMenuLine(bookLine('E6', 'h03', 3))],
            notes: []
          }
        ]
      },
      { use: true }
    ),
    maxedCase()
  ]
}
