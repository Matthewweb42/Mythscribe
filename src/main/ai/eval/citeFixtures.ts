import { quoteContext } from '@shared/scribeAnswer'
import { testBookScene } from '../../memory/testBook/book'
import { EVIDENCE_LABEL_WORDS, evidenceTag } from '@shared/scribe'
import {
  buildCitePrompt,
  CITE_CONTEXT_CHARS,
  CITE_QUESTION_CHARS,
  CITE_QUOTE_CHARS,
  CITE_SCOPE_HITS_MAX,
  CITE_SENTENCES_MAX,
  type CitePromptQuote,
  type CitePromptScope,
  type CitePromptSentence,
  type CiteScope,
  type CiteVerdict
} from '../prompts/cite.v1'
import type { EvalCase } from './fixtures'

/**
 * Ms Scribe's quote check cases (F-16.25; plan P3 §3.4), from the test book (`memory/testBook`):
 * each cited sentence with its quotes in their sentences ±1, as `runScribe` sends them, and, for
 * a first/last answer, the scope item with the earlier passages a search found. Live
 * (`MYTHSCRIBE_EVAL_LIVE=1`, owed by the author), they score as kind `cite`: the reply parses
 * (`parseCiteReply`), each sentence's verdict is the labelled one (null: any verdict, but one),
 * and the scope verdict too when labelled.
 */

/** A scene's reference in the test book: its chapter, one scene each (`h02` → 7.1). */
const refOf = (sceneId: string): string => `${testBookScene(sceneId).chapter}.1`

/** A paragraph of a test-book scene. */
const para = (sceneId: string, n: number): string => testBookScene(sceneId).paragraphs[n] ?? ''

/**
 * One quote of a test-book paragraph as `runScribe` sends it: tag (its label's words, "happened"
 * unless said), quote, sentence ±1.
 */
function quote(
  evidence: string,
  sceneId: string,
  n: number,
  words: string,
  label: string = EVIDENCE_LABEL_WORDS.happened
): CitePromptQuote {
  const text = para(sceneId, n)
  const context = quoteContext([text], words)
  if (context === null) throw new Error(`“${words}” is not in ${sceneId} ¶${n}`)
  return { evidence, tag: `${label}, ${refOf(sceneId)} ¶${n}`, quote: words, context }
}

/** A scope passage: the paragraph's place and its words as the search found them. */
const hit = (sceneId: string, n: number): CitePromptScope['hits'][number] => ({
  ref: `${refOf(sceneId)} ¶${n}`,
  text: para(sceneId, n)
})

function citeCase(
  name: string,
  note: string,
  question: string,
  now: string,
  sentences: CitePromptSentence[],
  scope: CitePromptScope | null,
  expected: (CiteVerdict | null)[],
  expectedScope: CiteScope | null
): EvalCase {
  const built = buildCitePrompt({ question, now, sentences, scope })
  return {
    version: built.version,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: {
      kind: 'cite',
      expected: expected.slice(0, built.sent),
      scope: built.scope ? expectedScope : null
    }
  }
}

const FIRST_SEE = 'When does Lise first see the Captain?'

/** The maxed case's sentences: eight, each with every quote at its context cap. */
function maxedSentences(): CitePromptSentence[] {
  const long = testBookScene('h14').paragraphs.join(' ')
  return Array.from({ length: CITE_SENTENCES_MAX + 2 }, (_, i) => ({
    text: `${para('h14', i % 13)} ${para('h14', (i + 1) % 13)}`.slice(0, 600),
    quotes: Array.from({ length: 2 }, (__, j) => ({
      evidence: `E${i + j + 1}`,
      tag: `happened, 18.1 ¶${(i + j) % 13}`,
      quote: para('h14', (i + j) % 13)
        .split(' ')
        .slice(0, 25)
        .join(' '),
      context: long.slice(0, CITE_CONTEXT_CHARS + 200)
    }))
  }))
}

export function citeEvalCases(): EvalCase[] {
  return [
    citeCase(
      'supported',
      'two cited sentences whose quotes say them: yes, yes',
      'What does the Captain look like?',
      '12.1',
      [
        {
          text: 'The Captain has a long white scar across his jaw.',
          quotes: [quote('E1', 'h02', 2, 'the Captain had a long white scar across his jaw')]
        },
        {
          text: 'His eyes are the colour of wet slate.',
          quotes: [quote('E2', 'h02', 3, 'They were the colour of wet slate')]
        }
      ],
      null,
      ['yes', 'yes'],
      null
    ),
    citeCase(
      'unsupported',
      'the quote names the inheritance, the sentence says the opposite: no',
      'What did Mr. Dunmore inherit from his father?',
      '12.1',
      [
        {
          text: 'Mr. Dunmore’s father left him a large fortune.',
          quotes: [quote('E1', 'h02', 5, 'he left me nothing but his good name')]
        }
      ],
      null,
      ['no'],
      null
    ),
    citeCase(
      'partly',
      'one half of the sentence is in its quotes, the other is not: partly',
      'What does Lise make of the man by the fire?',
      '12.1',
      [
        {
          text: 'Lise watched the Captain by the fire and decided he was a thief.',
          quotes: [
            quote('E1', 'h02', 7, 'She watched the man by the fire instead'),
            quote(
              'E2',
              'h02',
              2,
              'Nobody there called the man by the fire anything but the Captain'
            )
          ]
        }
      ],
      null,
      ['partly'],
      null
    ),
    citeCase(
      'scope-earlier',
      'a "first" answer citing 12.1 while the search found her watching him in 7.1: earlier',
      FIRST_SEE,
      '12.1',
      [
        {
          text: 'Lise first sees the Captain on the bridge in 12.1.',
          quotes: [quote('E1', 'h07', 9, 'On the way home they passed the Captain on the bridge')]
        }
      ],
      {
        searched: 'every scene up to 12.1 for captain, see, watch',
        claim: 'Lise first sees the Captain on the bridge in 12.1.',
        cited: '12.1',
        latest: false,
        hits: [hit('h02', 2), hit('h02', 7), hit('h02', 8)]
      },
      ['yes'],
      'earlier'
    ),
    citeCase(
      'scope-ok',
      'a "first" answer citing 7.1 with only earlier passages that do not show it: ok',
      FIRST_SEE,
      '12.1',
      [
        {
          text: 'Lise first sees the Captain in 7.1.',
          quotes: [
            quote('E1', 'h02', 7, 'She watched the man by the fire instead'),
            quote(
              'E2',
              'h02',
              2,
              'Nobody there called the man by the fire anything but the Captain'
            )
          ]
        }
      ],
      {
        searched: 'every scene up to 12.1 for captain, see, watch',
        claim: 'Lise first sees the Captain in 7.1.',
        cited: '7.1',
        latest: false,
        hits: [hit('h01', 0), hit('h01', 10)]
      },
      ['yes'],
      'ok'
    ),
    citeCase(
      'maxed',
      'the worst check after the fit: a long question, ten long cited sentences of two quotes at the context cap, five long scope passages (≤ 2,500)',
      `${para('h14', 7)} ${para('h14', 5)} ${para('h14', 9)}`,
      '18.1',
      maxedSentences(),
      {
        searched: `every scene up to 18.1 for ${'captain, debts, varrow, money, owed, coat, glass, horse'}`,
        claim: para('h14', 7),
        cited: '18.1',
        latest: false,
        hits: Array.from({ length: CITE_SCOPE_HITS_MAX + 2 }, (_, i) => hit('h14', i))
      },
      Array.from({ length: CITE_SENTENCES_MAX }, () => null),
      null
    ),
    citeCase(
      'notes-as-event',
      'an event said to have happened, resting on the author’s notes: no (notes say who or what, never that an event happened)',
      'Did Lise expose the Captain at the ball?',
      '12.1',
      [
        {
          text: 'Yes, Lise exposes the Captain at the ball.',
          quotes: [
            {
              evidence: 'E3',
              tag: evidenceTag('notes', 'Lise’s Pinned ¶2'),
              quote: 'Lise exposes the Captain at the ball',
              context: 'Ending: Lise exposes the Captain at the ball, in front of the whole county.'
            }
          ]
        }
      ],
      null,
      ['no'],
      null
    ),
    citeCase(
      'later-as-now',
      'Lise said to know it now (12.1), resting on a passage later in the book (18.1): no',
      'Has Lise worked out why the Captain avoids Mr. Varrow?',
      '12.1',
      [
        {
          text: 'Yes: she has worked out that the Captain owes Mr. Varrow money.',
          quotes: [
            quote(
              'E4',
              'h14',
              7,
              'The Captain owed Mr. Varrow money, and a great deal of it',
              EVIDENCE_LABEL_WORDS.later
            )
          ]
        }
      ],
      null,
      ['no'],
      null
    ),
    citeCase(
      'absence-scope',
      'an answer that found nothing and cites nothing, on its scope alone: the search found her watching him in 7.1, so earlier',
      'Does Lise ever see the Captain before the bridge in 12.1?',
      '12.1',
      [],
      {
        searched: 'every scene up to 12.1 for captain, see, watch',
        claim:
          'I found no scene where Lise sees the Captain before 12.1 (searched every scene up to 12.1).',
        cited: null,
        latest: false,
        hits: [hit('h02', 2), hit('h02', 7)]
      },
      [],
      'earlier'
    ),
    citeCase(
      'maxed-first',
      'the worst first sentence: a 1,000-character question, a full scope item, eight quotes with long filed-from tags and contexts (contexts cut to fit; ≤ 2,500)',
      `${para('h14', 7)} ${para('h14', 5)} ${para('h14', 9)} ${para('h14', 2)}`.slice(
        0,
        CITE_QUESTION_CHARS + 100
      ),
      '18.1',
      [
        {
          text: `${para('h14', 7)} ${para('h14', 5)}`,
          quotes: Array.from({ length: CITE_SENTENCES_MAX }, (_, j) => ({
            evidence: `E${j + 1}`,
            tag: evidenceTag(
              'filed',
              `Lise’s Pinned ¶${j}`,
              `${'Harbour and debts notes '.repeat(10)}`.slice(0, CITE_QUOTE_CHARS)
            ),
            quote: para('h14', j % 13)
              .split(' ')
              .slice(0, 14)
              .join(' '),
            context: `${para('h14', (j + 12) % 13)} ${para('h14', j % 13)} ${para('h14', (j + 1) % 13)}`
          }))
        }
      ],
      {
        searched: `every scene up to 18.1 for ${'captain, debts, varrow, money, owed, coat, glass, horse'}`,
        claim: para('h14', 7),
        cited: '18.1',
        latest: false,
        hits: Array.from({ length: CITE_SCOPE_HITS_MAX }, (_, i) => hit('h14', i))
      },
      [null],
      null
    )
  ]
}
