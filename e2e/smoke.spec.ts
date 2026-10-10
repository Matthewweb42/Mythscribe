import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import type { AiStatus, AiUsageSummary } from '../src/shared/ai'
import type { AiSettings } from '../src/shared/aiSettings'
import type { AuthorRules } from '../src/shared/authorRules'
import { LOGIN_ATTEMPT_TTL_MS } from '../src/shared/cloudApi'
import { MICROS_PER_USD } from '../src/shared/cloudBilling'
import { bundledPricing, hostedPriceFor } from '../src/shared/hostedPricing'
import { USAGE_PERIOD_DAYS } from '../src/shared/cloudUsage'
import type { FocusSettings } from '../src/shared/focus'
import { localDay } from '../src/shared/goals'
import { MENTION_DEBOUNCE_MS } from '../src/shared/mentions'
import { encodeLicensePayload, formatLicenseToken, LICENSE_GRACE_MS } from '../src/shared/license'
import type { Entity, IpcResult, ProjectInfo, Tag, TreeNode } from '../src/shared/ipc/contract'
import type { Layout } from '../src/shared/layout'
import { TODO_DEBOUNCE_MS, type TodoView } from '../src/shared/todo'
import type { Fact } from '../src/shared/facts'
import { PRESETS, type WritingPresets } from '../src/shared/presets'
import type { ReferencePin, ReferencePins } from '../src/shared/references'
import { matterTemplate } from '../src/shared/matterTemplates'
import type { SceneMeta } from '../src/shared/sceneMeta'
import type { ProjectSession } from '../src/shared/session'
import { STORY_BIBLE_HEADING, STORY_BIBLE_PLANS_HEADING } from '../src/shared/storyBible'
import { STORY_MAP_HEADING } from '../src/shared/storyTime'
import type { TiptapNodeT } from '../src/shared/tiptap'
import { countWords } from '../src/shared/wordCount'

/**
 * Smoke test (CLAUDE.md quality gates): create a project → write text → close it → reopen it →
 * the structure and the text are still there.
 *
 * F-5.1: the AI steps never reach OpenAI. `OPENAI_BASE_URL` points the SDK in the main process
 * at the fake server below, which rejects `REJECTED_KEY` with a 401 and answers any other key
 * with a model, so both the failure and the success path are driven for real without a live
 * key. Do not "complete" this with a real call.
 */

/** The key the fake OpenAI server rejects; any other key is accepted. */
const REJECTED_KEY = 'sk-test-1234abcd'
const ACCEPTED_KEY = 'sk-live-5678wxyz'

/** The continuation the fake server answers every plain-text (ghost text, F-5.3) chat request with. */
const GHOST_CONTINUATION = 'The wind picked up before anyone spoke.'
/**
 * F-14.5: the clause `tagsRegen.v1` appends to the system turn (`TAGS_REGEN_CLAUSE_PREFIX` in
 * `src/main/ai/prompts/tagsRegen.v1.ts`; main is outside the e2e tsconfig, so it is repeated
 * here). A tags request carrying it is a Regenerate… and gets a different canned set.
 */
const TAGS_REGEN_SENTINEL = 'The writer asked for a different set'
/** The note typed into the Regenerate… dialog; the fake server's regenerate request must quote it. */
const REGEN_NOTE = 'Too generic; the scene is about the crossing.'
/**
 * F-14.7: a ghost-text request whose passage carries this line is answered off-voice (present
 * tense and first person against a past-tense third-person manuscript, with five markers of
 * each so the classifier resolves both; tense is checked first, so it is the one named), for
 * both the first try and the regenerate, so the badge shows.
 */
/** F-5.4: the fake server streams this Plan answer in two deltas and answers Author (stored `agent`) requests with two paragraphs. */
const CHAT_ANSWER = 'Mara is on the ridge to watch the storm come in before the others wake.'
const AGENT_FIRST = 'The rain came sideways over the ridge.'
const AGENT_SECOND = 'Mara pulled her hood down and waited for the others.'
/** The opening of the Agent-mode rules in `chat.v1`; the fake server tells Agent requests apart by it. */
const AGENT_SENTINEL = 'You are drafting inside a novel-writing app'
/** F-14.10: the opening of the rewrite prompt's system turn; the fake server streams the rewrite for it. */
const REWRITE_SENTINEL = 'You are the rewrite feature inside a novel-writing app.'
/** What the fake server answers a rewrite with: past tense, third person, so the local voice check passes. */
const REWRITE_ANSWER = 'The storm came down at dusk. Rain followed it, and then the quiet held.'
/**
 * F-14.8: the opening of the critique prompt's system turn (`CRITIQUE_RULES` in
 * `src/main/ai/prompts/critique.v1.ts`; main is outside the e2e tsconfig, so it is repeated
 * here). A JSON request carrying it gets canned editor's notes.
 */
const CRITIQUE_SENTINEL = 'You are the editor feature inside a novel-writing app.'
/** The passage the canned issue note cites: the tail of the accepted rewrite, so it is in Scene 1. */
const CRITIQUE_QUOTE = 'Rain followed it, and then the quiet held.'
/** What Applying that note puts in its place. */
const CRITIQUE_FIX = 'Rain followed it, and the quiet held after.'
/** The passage the canned praise cites: one of the typed voice paragraphs. */
const CRITIQUE_PRAISE_QUOTE = 'She turned from the window and looked at the ridge'
/** A passage that is nowhere in the scene: main must drop this note, so no uncited praise shows. */
const CRITIQUE_FABRICATED_QUOTE = 'The lighthouse blinked twice and went dark.'
const CRITIQUE_ANSWER = JSON.stringify({
  notes: [
    {
      kind: 'issue',
      category: 'pacing',
      quote: CRITIQUE_QUOTE,
      why: 'The beat stalls on a second clause.',
      fix: CRITIQUE_FIX
    },
    {
      kind: 'praise',
      category: 'clarity',
      quote: CRITIQUE_PRAISE_QUOTE,
      why: 'The look outward carries the mood without naming it.',
      fix: null
    },
    {
      kind: 'praise',
      category: 'pov',
      quote: CRITIQUE_FABRICATED_QUOTE,
      why: 'Never written; the app must drop this one.',
      fix: null
    }
  ]
})
/**
 * F-14.12: the opening of the proofread prompt's system turn (`PROOFREAD_RULES` in
 * `src/main/ai/prompts/proofread.v1.ts`, repeated here for the same reason; its golden test pins
 * the two together). A JSON request carrying it gets the canned fixes below: two for the errors
 * the proofread step types into Scene 1, and one quoting a passage that is nowhere in it, which
 * main must drop.
 */
const PROOFREAD_SENTINEL = 'You are the proofreading feature inside a novel-writing app.'
/**
 * F-14.15: the opening of the edit-pass prompt's system turn (`EDIT_PASS_SENTINEL` in
 * `src/main/ai/prompts/editPass.v1.ts`; its golden test pins the two together). A JSON request
 * carrying it gets one change to the sentence the edit-pass step types, and one quoting a
 * passage that is nowhere in the scene, which main must drop.
 */
const EDIT_PASS_SENTINEL = 'You are the edit-pass feature inside a novel-writing app.'
/** What the edit-pass step types at the end of Scene 1. */
const EDIT_PASS_TYPED = ' The Harbour Bell rang very very slowly over the water.'
const EDIT_PASS_QUOTE = 'rang very very slowly'
const EDIT_PASS_REPLACEMENT = 'rang slowly'
const EDIT_PASS_ANSWER = JSON.stringify({
  changes: [
    { quote: EDIT_PASS_QUOTE, replacement: EDIT_PASS_REPLACEMENT, why: 'Cut the doubled word.' },
    { quote: 'a passage nowhere in the scene', replacement: 'x', why: 'Dropped by main.' }
  ]
})
/** What the proofread step types at the end of Scene 1: one misspelling and one doubled word. */
const PROOFREAD_TYPED = ' The ferryman was laet that night, and and the river rose under the dock.'
const PROOFREAD_TYPO_QUOTE = 'was laet that'
const PROOFREAD_TYPO_FIX = 'was late that'
const PROOFREAD_DOUBLED_QUOTE = 'and and the river'
const PROOFREAD_DOUBLED_FIX = 'and the river'
/** What the typed sentence reads once both fixes are in. */
const PROOFREAD_CORRECTED = 'The ferryman was late that night, and the river rose under the dock.'
const PROOFREAD_ANSWER = JSON.stringify({
  fixes: [
    { kind: 'spelling', quote: PROOFREAD_TYPO_QUOTE, fix: PROOFREAD_TYPO_FIX },
    { kind: 'doubledWord', quote: PROOFREAD_DOUBLED_QUOTE, fix: PROOFREAD_DOUBLED_FIX },
    {
      kind: 'punctuation',
      quote: CRITIQUE_FABRICATED_QUOTE,
      fix: 'The lighthouse blinked twice, and went dark.'
    }
  ]
})
/**
 * F-14.3: the opening of the brief prompt's system turn (`BRIEF_RULES` in
 * `src/main/ai/prompts/brief.v1.ts`; main is outside the e2e tsconfig, so it is repeated here).
 * A JSON request carrying it gets the canned brief below.
 */
/**
 * F-5.6: the opening of the summary prompt's system turn (`SUMMARY_RULES` in
 * `src/main/ai/prompts/summary.v1.ts`, repeated here for the same reason). A JSON request
 * carrying it gets the canned summary below. The Scene summaries toggle is off from the moment
 * the dial leaves Off until the summary step, so the background run after each save never
 * disturbs the exact request counts the steps between assert.
 */
const SUMMARY_SENTINEL = 'You are the scene-summary feature inside a novel-writing app.'
const SUMMARY_TEXT = 'Mara tries to cross the rising river at night and gives up until dawn.'
const SUMMARY_KEY_POINTS = ['The river is too high to cross.', 'Tomas refuses to row.']
const SUMMARY_CHARACTERS = ['Mara', 'Tomas']
/**
 * F-5.16: the observed facts the canned summary carries (`summary.v2` keeps the sentinel above).
 * Both quotes are sentences Scene 1 holds verbatim by the summary step, so main keeps both. No
 * entity is left in the project by then: "Mara" attaches to a character of that name when a step
 * has created one, and is created as AI-made otherwise; "Kael" was only ever a proposed tag, so
 * it is always a new AI-made character with a new `kael` tag.
 */
const SUMMARY_FACTS = [
  {
    entity: 'Mara',
    kind: 'character',
    attribute: 'personality',
    value: 'Waits out the storm',
    quote: 'Mara waited on the ridge.'
  },
  {
    entity: 'Kael',
    kind: 'character',
    attribute: 'personality',
    value: 'Watchful',
    quote: 'But Kael saw Kael, then Kael.'
  }
]
/**
 * F-4.13: the tags the canned summary carries (`summary.v3` keeps the sentinel too). "Harbour
 * Bell" is a name Scene 1 capitalises (the edit-pass sentence), new to the bank, so main creates
 * it as AI-made and links it to the scene; by the author's tag rule (2026-10-08) the tone
 * "stormbound", which the text never holds, is not a tag, and "Zephyr" is a character name
 * Scene 1 never holds: main drops both.
 */
const SUMMARY_TAGS = [
  { name: 'stormbound', category: 'tone' },
  { name: 'Harbour Bell', category: 'custom' },
  { name: 'Zephyr', category: 'character' }
]
/**
 * F-9.14: the scene card, one relationship, and one thread event the canned summary carries
 * (`summary.v4` keeps the sentinel too). Both quotes are Scene 1's own sentences, and both ends of
 * the relationship are the characters the facts above create, so main keeps both; the thread is
 * new, so main makes it an AI-made thread record (no tag: its name is nowhere in the text).
 */
const SUMMARY_CARD = {
  where: 'The ridge',
  when: 'Night',
  pov: 'Mara',
  changed: 'Mara keeps watch alone while the river rises.'
}
const SUMMARY_THREAD = 'The Lantern Oath'
const SUMMARY_THREAD_QUESTION = 'Will Mara keep watch until dawn?'
const SUMMARY_ANSWER = JSON.stringify({
  summary: SUMMARY_TEXT,
  keyPoints: SUMMARY_KEY_POINTS,
  characters: SUMMARY_CHARACTERS,
  facts: SUMMARY_FACTS,
  tags: SUMMARY_TAGS,
  card: SUMMARY_CARD,
  relations: [{ from: 'Kael', type: 'rival', to: 'Mara', quote: 'But Kael saw Kael, then Kael.' }],
  threads: [
    {
      name: SUMMARY_THREAD,
      event: 'opened',
      question: SUMMARY_THREAD_QUESTION,
      quote: 'Mara waited on the ridge.'
    }
  ]
})
const BRIEF_SENTINEL = 'You are the scene-brief feature inside a novel-writing app.'
/**
 * F-5.19: the opening of the router's system turn (`route.v1`). The fake router sends a request
 * whose last turn carries `ROUTE_CRITIQUE_MESSAGE` to editor's notes and everything else to chat.
 */
const ROUTE_SENTINEL = "You are the router inside a novel-writing app's assistant."
const ROUTE_CRITIQUE_MESSAGE = "Give me editor's notes on this scene."
/** F-5.20: the openings of the synopsis and notes-suggestion system turns, and their answers. */
const SYNOPSIS_SENTINEL = 'You are the synopsis feature inside a novel-writing app.'
const NOTES_SUGGEST_SENTINEL = 'You are the scene-notes feature inside a novel-writing app.'
const SUGGESTED_SYNOPSIS = 'Mara climbs the ridge to watch the storm before the others wake.'
const SUGGESTED_POINTS = ['Mara keeps watch alone.', 'The storm cuts off the ridge path.']
/**
 * F-13.4: the opening of the consistency-checker prompt's system turn (`CONTINUITY_RULES` in
 * `src/main/ai/prompts/continuity.v1.ts`, repeated here for the same reason). A JSON request
 * carrying it is answered from what it carries, so the same server serves `Check consistency`
 * and the background run: when the user turn holds `CONTINUITY_QUOTE`, one finding against
 * reference 1 quoting it, with `CONTINUITY_FIX`; when it also holds `CONTINUITY_SECOND_QUOTE`, a
 * second finding against reference 1 with no fix (the one a step dismisses); and always one
 * finding quoting a passage that is nowhere in the scene plus one naming reference 99, which
 * main must drop. Without `CONTINUITY_QUOTE` in the request only the two droppable ones come
 * back, so the panel shows nothing.
 */
const CONTINUITY_SENTINEL = 'You are the continuity feature inside a novel-writing app.'
/** The passage the canned finding cites; a step types it into the scene. */
const CONTINUITY_QUOTE = 'Mara was twenty-nine that winter.'
/** What Applying that finding puts in its place. */
const CONTINUITY_FIX = 'Mara was thirty-four that winter.'
const CONTINUITY_WHY = 'The sheet gives her age as 34.'
/** The passage the canned second finding cites, when a step has typed it. */
const CONTINUITY_SECOND_QUOTE = 'She had turned twenty-nine in the spring.'
const CONTINUITY_SECOND_WHY =
  'The sheet gives her age as 34, so she cannot have turned twenty-nine.'
/** The canned answer for one request: built from its user turn, so it is the same every time for the same scene. */
function continuityAnswer(messages: { role: string; content: string }[]): string {
  const user = messages.find((m) => m.role === 'user')?.content ?? ''
  const findings: { ref: number; quote: string; why: string; fix: string | null }[] = []
  if (user.includes(CONTINUITY_QUOTE)) {
    findings.push({ ref: 1, quote: CONTINUITY_QUOTE, why: CONTINUITY_WHY, fix: CONTINUITY_FIX })
    if (user.includes(CONTINUITY_SECOND_QUOTE)) {
      findings.push({
        ref: 1,
        quote: CONTINUITY_SECOND_QUOTE,
        why: CONTINUITY_SECOND_WHY,
        fix: null
      })
    }
  }
  findings.push(
    {
      ref: 1,
      quote: CRITIQUE_FABRICATED_QUOTE,
      why: 'Never written; the app must drop this one.',
      fix: null
    },
    {
      ref: 99,
      quote: CONTINUITY_QUOTE,
      why: 'Reference 99 was never sent; the app must drop this one too.',
      fix: null
    }
  )
  return JSON.stringify({ findings })
}
/**
 * F-12.3: the opening of the import structure prompt's system turn (`IMPORT_STRUCTURE_RULES` in
 * `src/main/ai/prompts/importStructure.v1.ts`, repeated here for the same reason). A JSON
 * request carrying it gets one scene break inside the imported Chapter One, a title for the
 * scene before it, and one bank tag for it, so the badge, the reject offer, and the pending tag
 * proposal all show.
 */
const IMPORT_STRUCTURE_SENTINEL =
  'You are the structure-detection feature inside a novel-writing app'
const IMPORT_STRUCTURE_ANSWER = JSON.stringify({
  breaks: [{ before: 1, kind: 'scene', reason: 'The wait until dusk is a time skip.' }],
  scenes: [
    { start: 0, title: 'The Empty Ridge', tags: ['antagonist'] },
    { start: 1, title: null, tags: [] }
  ]
})
/**
 * F-14.11: the opening of the beta-reader prompt's system turn (`BETA_READER_RULES` in
 * `src/main/ai/prompts/betaReader.v1.ts`, repeated here for the same reason). A JSON request
 * carrying it gets the canned report below: one item citing Scene 1, one quoting a passage that
 * is nowhere in it, and one naming a scene the reader was never sent, so both drop rules show.
 */
const BETA_READER_SENTINEL = 'You are the beta-reader feature inside a novel-writing app.'
/**
 * F-9.8: the opening of the context-library prompt's system turn (`CONTEXT_IMPORT_RULES` in
 * `src/main/ai/prompts/contextImport.v1.ts`, kept by v2, repeated here for the same reason). The
 * answer depends on the document named in the user turn: people.md describes Mara twice (once by
 * her full name, with her nickname) and carries a theme; places.txt describes Tomas Reed, a
 * place, a magic system (F-9.11: filed under Magic Systems), and a ship under a category the
 * model proposes (Ships).
 */
const CONTEXT_IMPORT_SENTINEL = 'You are the context-library feature inside a novel-writing app'
function contextImportAnswer(messages: { role: string; content: string }[]): string {
  const user = messages.at(-1)?.content ?? ''
  if (user.includes('Document "people.md"')) {
    return JSON.stringify({
      entities: [
        { kind: 'character', name: 'Mara', aliases: [], fields: { age: '35' }, details: [] },
        {
          kind: 'character',
          name: 'Mara Vell',
          aliases: ['Mara'],
          fields: { goals: 'Keep the ferry running.' },
          details: ['History: She runs the ferry her father built.']
        }
      ],
      notes: ['Theme: The book is about debts that outlive the people who made them.'],
      images: []
    })
  }
  return JSON.stringify({
    entities: [
      {
        kind: 'character',
        name: 'Tomas Reed',
        fields: { age: '29' },
        details: ['Debts: owes the mill money.']
      },
      {
        kind: 'setting',
        name: 'The Landing',
        fields: { description: 'A jetty of black planks on the north bank.' }
      },
      { kind: 'magic', name: 'The Weave', fields: { costs: 'A memory for every knot.' } },
      { kind: 'ships', name: 'The Gull', fields: { Crew: 'twelve' } }
    ],
    categories: [{ kind: 'ships', name: 'Ships', noun: 'ship', fields: ['Crew'] }],
    notes: [],
    images: []
  })
}
/**
 * F-9.9: the opening of the review chat prompt's system turn (`REVIEW_CHAT_RULES` in
 * `src/main/ai/prompts/reviewChat.v1.ts`, repeated here for the same reason). The answer reads
 * the item ids from the listed review: Tomas Reed gets the alias "Tom", and a rename of Mara's
 * existing sheet comes back too, which the review skips with its reason.
 */
const REVIEW_CHAT_SENTINEL = 'You are the review assistant inside a novel-writing app.'
function reviewChatAnswer(messages: { role: string; content: string }[]): string {
  const listing = messages[1]?.content ?? ''
  const idOf = (name: string): string =>
    listing
      .split('\n')
      .find((line) => line.includes(` · ${name} · `))
      ?.split(' · ')[0] ?? ''
  return JSON.stringify({
    reply: 'Tomas Reed also goes by Tom.',
    ops: [
      { op: 'aliases', item: idOf('Tomas Reed'), aliases: ['Tom'] },
      { op: 'rename', item: idOf('Mara'), name: 'Mara Vell' }
    ]
  })
}
/**
 * F-9.10: the opening of the organise prompt's system turn (`ORGANISE_V2_RULES` in
 * `src/main/ai/prompts/organise.v2.ts`, version 1's sentence, repeated here for the same reason).
 * The answer reads the refs from the index: the stray tag #reed merges into #tomas-reed (while it
 * exists), and The Landing's atmosphere is filled.
 */
const ORGANISE_SENTINEL = "You organise a novelist's project notes inside a writing app."
const ORGANISE_ATMOSPHERE = 'Tar and river fog.'
function organiseAnswer(messages: { role: string; content: string }[]): string {
  const index = (messages[1]?.content ?? '').split('\n')
  const ref = (pattern: RegExp): string =>
    index.find((line) => pattern.test(line))?.split(' ')[0] ?? ''
  const tomasReed = ref(/^t\d+ #tomas-reed · /)
  const stray = ref(/^t\d+ #reed · /)
  const landing = ref(/^s\d+ setting · The Landing/)
  const ops: object[] = []
  if (stray !== '' && tomasReed !== '') {
    ops.push({ op: 'mergeTags', keep: tomasReed, merge: [stray], why: 'one person' })
  }
  if (landing !== '') {
    ops.push({
      op: 'sheet',
      sheet: landing,
      set: { Atmosphere: ORGANISE_ATMOSPHERE },
      why: 'notes'
    })
  }
  return JSON.stringify({ reply: 'One Tomas, and the Landing filled in.', ops })
}
const BETA_READER_NOTE = 'I expect the ridge to matter: she keeps looking at it.'
const BETA_READER_ANSWER = JSON.stringify({
  items: [
    { category: 'expects', scene: 1, quote: CRITIQUE_PRAISE_QUOTE, note: BETA_READER_NOTE },
    {
      category: 'confusion',
      scene: 1,
      quote: CRITIQUE_FABRICATED_QUOTE,
      note: 'Never written; the app must drop this one.'
    },
    {
      category: 'knows',
      scene: 9,
      quote: CRITIQUE_PRAISE_QUOTE,
      note: 'Scene 9 was never sent; the app must drop this one too.'
    }
  ]
})
/**
 * F-5.17: the opening of the What should come next? prompt's system turn (`WHAT_NEXT_RULES` in
 * `src/main/ai/prompts/whatNext.v1.ts`, repeated here for the same reason). A JSON request
 * carrying it gets three canned directions; Write this on the first sends an Author-mode turn.
 */
const WHAT_NEXT_SENTINEL = 'You are the what-comes-next feature inside a novel-writing app.'
const WHAT_NEXT_TITLES = ['Mara turns back', 'The bell rings twice', 'A stranger on the road']
const WHAT_NEXT_ANSWER = JSON.stringify({
  directions: [
    { title: WHAT_NEXT_TITLES[0], text: 'She doubts the crossing and heads back to the camp.' },
    { title: WHAT_NEXT_TITLES[1], text: 'A signal from the valley forces her decision.' },
    { title: WHAT_NEXT_TITLES[2], text: 'Someone she does not know waits at the gate.' }
  ]
})
/**
 * F-5.7: the opening of the Story Intelligence prompt's system turn (`QUERY_RULES` in
 * `src/main/ai/prompts/query.v1.ts`, repeated here for the same reason). The panel asks the chat
 * agent since F-5.22, but `ai:query` still answers; a JSON request carrying it gets the canned
 * answer below: one citation quoting a passage of the scene that ranks first, one quoting a
 * passage that is nowhere in it, and one naming a scene that was never sent.
 */
const QUERY_SENTINEL = 'You are the Story Intelligence feature inside a novel-writing app.'
/**
 * F-5.22: the opening of the chat agent's rules (`AGENT_RULES` in
 * `src/main/ai/prompts/agent.v1.ts`, repeated here for the same reason). Query questions and
 * Auto chat turns run on the agent; the fake answers its protocol through `chatAgentReply`.
 */
const CHAT_AGENT_SENTINEL =
  "You are the assistant inside a novel-writing app, working for the book's author."
/**
 * F-11.1d: the opening of the plan-link rules (`PLAN_LINKS_RULES` in
 * `src/main/ai/prompts/planLinks.v1.ts`); the fake links the first plan sent to the first
 * written scene sent.
 */
const PLAN_LINKS_SENTINEL = 'You are the plan-link feature inside a novel-writing app.'
const PLAN_LINK_WHY = 'The storm scene carries this plan.'
const PLAN_LINKS_ANSWER = JSON.stringify({
  links: [{ plan: 'P1', scene: 'S1', why: PLAN_LINK_WHY }]
})
/**
 * F-9.16: the openings of the To do check's and suggestions' rules (`TODO_RULES` in
 * `src/main/ai/prompts/todo.v1.ts`, `TODO_SUGGEST_RULES` in `todoSuggest.v1.ts`). The fake check
 * flags one open question in the first scene line sent; the fake suggestions offer three options.
 */
const TODO_SENTINEL = 'You are the To do check inside a novel-writing app.'
const TODO_SUGGEST_SENTINEL = 'You are the To do suggestions inside a novel-writing app.'
const TODO_SUBJECT = 'the lighthouse bell'
const TODO_OPTIONS = [
  'The bell rings for the drowned, once a year.',
  'Mara rang it as a girl and never told anyone.',
  'Nobody knows who rings it.'
]
function todoAnswer(messages: { role: string; content: string }[]): string {
  const scene = /^Scenes:\n(S\d+) /mu.exec(messages[1]?.content ?? '')?.[1] ?? 'S1'
  return JSON.stringify({
    items: [
      {
        type: 'question',
        about: TODO_SUBJECT,
        scene,
        why: 'The scene promises an answer about the bell that no thread holds.',
        suggestions: []
      },
      {
        type: 'term',
        about: 'the Saltmarch',
        scene,
        why: 'The card leans on it, but nothing says what it is.',
        suggestions: ['A tidal marsh the ferry crosses at low water.']
      },
      {
        type: 'timeline',
        about: 'the winter crossing',
        scene,
        why: 'Months pass between the cards with no word of when.',
        suggestions: []
      }
    ],
    resolved: []
  })
}
/** An Auto message the router sends to chat; the agent answers it with one edit to Scene 1. */
const AGENT_EDIT_MESSAGE = 'Make the opening line plainer.'
const AGENT_EDIT_ANSWER = 'Here is a plainer line.'
/** What the agent says with the insert a Write this direction asks for (2026-10-07). */
const AGENT_INSERT_ANSWER = 'Here is the next beat.'
/**
 * 2026-10-07: a message the agent answers with an insertion after a sentence Scene 1 holds once
 * (`insertAnchor`, recorded by the fake when it picks it); the app drafts the prose and lands it
 * there as ghost text.
 */
const AGENT_INSERT_MESSAGE = 'Add the rain after the opening line.'
const AGENT_INSERT_HERE_ANSWER = 'I will add the rain there.'
/** The sentence the fake agent last anchored an insertion after. */
let insertAnchor = ''
/** The opening of `AGENT_EDIT_RULES`, which only a run with the edit tools (Ask, Auto) carries. */
const AGENT_EDIT_RULES_OPENING = 'To change the project, add "edits"'
/** What the edit puts in place of a sentence Scene 1 holds once. */
const AGENT_EDIT_REPLACEMENT = 'The storm came in at dusk.'
const QUERY_QUESTION = 'Where does the storm reach the ridge?'
/** A recap asked in Query mode; its words rank Scene 1 first, as the question above does. */
const RECAP_QUESTION = 'What happened on the ridge in the storm?'
const QUERY_ANSWER_TEXT = 'She waits out the storm on the ridge [1], then crosses at dawn [3].'
/** What the answer reads once main drops the uncited scene and strips its marker. */
const QUERY_ANSWER_KEPT = 'She waits out the storm on the ridge [1], then crosses at dawn.'
/**
 * F-5.24: a question the fake agent answers down the lookup ladder: `lookup` Wren, then
 * `find_passages`, then an answer citing the longest stretch of the first passage's snippet
 * (recorded in `lookupQuote`), which the citation must select in the editor.
 */
const LOOKUP_QUESTION = 'Where was Wren when the storm reached the ridge?'
const LOOKUP_ANSWER = 'Wren watched the storm from the window [1].'
/** The quote the fake agent last cited from a `find_passages` snippet. */
let lookupQuote = ''
/**
 * F-5.22: one step of the chat agent. Without a lookup made yet it finds passages (agent.v6,
 * F-5.24; or reads Wren's sheet for the sheet question); with one made it answers: the sheet question from the sheet,
 * the edit message (after reading Scene 1) with one text edit replacing the first sentence of
 * at least 15 characters the scene holds exactly once, anything else with the Query answer's three
 * citations (one real, one fabricated, one naming no document) so both drop rules show.
 */
function chatAgentReply(messages: { role: string; content: string }[]): string {
  const looked = messages.filter((m) => m.role === 'user' && m.content.startsWith('Result of '))
  const asked =
    [...messages].reverse().find((m) => m.role === 'user' && !m.content.startsWith('Result of '))
      ?.content ?? ''
  if (asked === LOOKUP_QUESTION) {
    if (looked.length === 0) return JSON.stringify({ tool: 'lookup', args: { name: 'Wren' } })
    if (looked.length === 1) {
      return JSON.stringify({ tool: 'find_passages', args: { query: 'window ridge storm' } })
    }
    const hit = /^(n\d+) ¶\d+ \([^)]*\): (.+)$/mu.exec(looked.at(-1)?.content ?? '')
    lookupQuote =
      (hit?.[2] ?? '')
        .split('…')
        .map((piece) => piece.trim())
        .sort((a, b) => b.length - a.length)[0] ?? ''
    return JSON.stringify({
      found: true,
      answer: LOOKUP_ANSWER,
      citations: [{ id: hit?.[1] ?? 'n1', quote: lookupQuote }]
    })
  }
  if (looked.length === 0) {
    return asked === SHEET_QUESTION
      ? JSON.stringify({ tool: 'read_sheet', args: { name: 'Wren' } })
      : JSON.stringify({ tool: 'find_passages', args: { query: 'storm ridge window' } })
  }
  if (asked === SHEET_QUESTION) return SHEET_ANSWER
  const seen = [...messages.map((m) => m.content)].join('\n')
  // The open document's line (`Open document n3: Chapter 1 › Scene 1`) or a read's head.
  const ref = /(n\d+):? Chapter 1 › Scene 1\b/.exec(seen)?.[1] ?? 'n1'
  // 2026-10-07: Write this sends a direction to the agent, which answers with one insertion at
  // the caret of Scene 1: a brief (agent.v2), whose prose the app drafts and lands as ghost text.
  if (asked.startsWith('Continue the scene in this direction:')) {
    return JSON.stringify({
      answer: AGENT_INSERT_ANSWER,
      found: true,
      citations: [],
      edits: [{ edit: 'insert', id: ref, after: '', brief: 'She turns back.', words: 60 }]
    })
  }
  if (asked === AGENT_EDIT_MESSAGE || asked === AGENT_INSERT_MESSAGE) {
    if (looked.length === 1) return JSON.stringify({ tool: 'read_scene', args: { id: ref } })
    const text = (looked.at(-1)?.content ?? '').split('\n').slice(2).join('\n')
    const find =
      text
        .split(/(?<=[.!?])\s+/)
        .map((sentence) => sentence.trim())
        .find((sentence) => sentence.length >= 15 && text.split(sentence).length === 2) ?? ''
    // 2026-10-07: an insertion after a sentence the scene holds once, by brief.
    if (asked === AGENT_INSERT_MESSAGE) {
      insertAnchor = find
      return JSON.stringify({
        answer: AGENT_INSERT_HERE_ANSWER,
        found: true,
        citations: [],
        edits: [{ edit: 'insert', id: ref, after: find, brief: 'The rain arrives.', words: 60 }]
      })
    }
    return JSON.stringify({
      answer: AGENT_EDIT_ANSWER,
      found: true,
      citations: [],
      edits: [{ edit: 'text', id: ref, find, replace: AGENT_EDIT_REPLACEMENT }]
    })
  }
  return JSON.stringify({
    found: true,
    answer: QUERY_ANSWER_TEXT,
    citations: [
      { id: ref, quote: CRITIQUE_PRAISE_QUOTE },
      { id: ref, quote: CRITIQUE_FABRICATED_QUOTE },
      { id: 'n9999', quote: CRITIQUE_PRAISE_QUOTE }
    ]
  })
}

/** query.v3: a question about a character answered from the author's sheet alone. */
const SHEET_QUESTION = 'What does Wren look like?'
const SHEET_APPEARANCE = 'Grey eyes, a burn scar across the left hand.'
const SHEET_ANSWER = JSON.stringify({
  found: true,
  answer: 'Wren has grey eyes and a burn scar across the left hand.',
  citations: [{ sheet: 'Wren' }, { sheet: 'Nobody' }]
})
const QUERY_ANSWER = JSON.stringify({
  found: true,
  answer: QUERY_ANSWER_TEXT,
  citations: [
    { scene: 1, quote: CRITIQUE_PRAISE_QUOTE },
    { scene: 1, quote: CRITIQUE_FABRICATED_QUOTE },
    { scene: 9, quote: CRITIQUE_PRAISE_QUOTE }
  ]
})
const BRIEF_GOAL = 'Mara wants to cross the river tonight.'
const BRIEF_ANSWER = JSON.stringify({
  goal: BRIEF_GOAL,
  conflict: 'The river is up and Tomas will not row.',
  turn: 'She decides to wait for morning.',
  beat: 'Dread giving way to resolve.',
  after: 'The crossing is off until dawn.'
})
/** F-14.2: the rule the author writes and the phrase they ban; the canned continuation uses the phrase. */
const AUTHOR_RULE = 'Mara never swears.'
const BANNED_PHRASE = 'picked up'
/**
 * F-5.10: a request whose last message carries this waits before answering, so a Stop can land.
 * Only the last message counts: the chat agent (F-5.22) sends the conversation history, which
 * keeps the stopped turn, and every later step would wait too.
 */
const SLOW_SENTINEL = 'SLOW'
const SLOW_DELAY_MS = 3_000
const OFF_VOICE_SENTINEL = 'She counted the lanterns on the far bank.'
/** Developer tools (2026-10-07): a request carrying this is answered with a 500, a failing request. */
const DEVTOOLS_FAIL_SENTINEL = 'The devtools probe fails here.'
const OFF_VOICE_CONTINUATION =
  'I am running now, and I know we are lost, and my hands are cold, and I am tired.'
/** Third-person past narration typed into Scene 1 five times, so the profile resolves tense and person and crosses 200 words. */
const VOICE_PARAGRAPH =
  ' She turned from the window and looked at the ridge, where the storm had settled for the ' +
  'night. He knew she was tired, and he was tired too. They walked to the door and she pulled it open.'

/** What Scene 1 reads after the F-3.1/F-3.2 steps; nine words, so the cached count is checked too. */
const SENTENCE = 'The storm broke at dusk. Rain followed. Then silence.'
/** What Scene 1 carries while the story bible's character is built and shown (F-9.4). */
const MARA_SENTENCE = ' Mara waited.'
const SENTENCE_WORDS = 9

/** The notes typed into the panel (F-3.7): one on Scene 1, one on Chapter 1 (a folder). */
const SCENE_NOTE = 'Ends on the cliff.'
const CHAPTER_NOTE = 'Get them to the coast.'

/** The Title Page template's word count (F-2.6), as the tree row and the persisted row must show it. */
const TITLE_PAGE_WORDS = countWords(matterTemplate('title-page').content)

let app: ElectronApplication
let page: Page
let tmp: string
let exited = false
/** The environment every launch gets, set once the fake servers are listening. */
let launchEnv: Record<string, string>
let fakeOpenAi: http.Server
/** The fake provider's address; F-5.15 points the local source at it, as it would at Ollama. */
let fakeOpenAiUrl = ''
/** Every request the fake OpenAI server saw: the path and the Authorization header. */
const openAiRequests: { url: string; auth: string | undefined }[] = []
/** The parsed body of every chat request, so a step can assert on what a prompt carried. */
const openAiChatBodies: { messages: { role: string; content: string }[] }[] = []

function startFakeOpenAi(): Promise<string> {
  fakeOpenAi = http.createServer((req, res) => {
    openAiRequests.push({ url: req.url ?? '', auth: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization === `Bearer ${REJECTED_KEY}`) {
      res.statusCode = 401
      res.end(
        JSON.stringify({
          error: {
            message: 'Incorrect API key provided',
            type: 'invalid_request_error',
            code: 'invalid_api_key'
          }
        })
      )
      return
    }
    // `POST /v1/chat/completions` answers by mode: a JSON-mode request (F-4.7 tags) gets the
    // same two bank tags every time (dark-forest is already linked to Scene 1 by then, so only
    // protagonist becomes a chip), or a different pair when its system turn carries the
    // regenerate clause (F-14.5); a plain request (F-5.3 ghost text) gets one fixed sentence.
    if (req.method === 'POST' && (req.url ?? '').endsWith('/chat/completions')) {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () => {
        const request = JSON.parse(body) as {
          response_format?: { type?: string }
          stream?: boolean
          messages: { role: string; content: string }[]
        }
        openAiChatBodies.push({ messages: request.messages })
        // Recorded on arrival: a stopped request still left the app. The answer may wait.
        if (request.messages.some((m) => m.content.includes(DEVTOOLS_FAIL_SENTINEL))) {
          res.statusCode = 500
          res.end(
            JSON.stringify({ error: { message: 'The fake server failed', type: 'server_error' } })
          )
          return
        }
        const respond = (): void => {
          const json = request.response_format?.type === 'json_object'
          const agent = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(AGENT_SENTINEL)
          )
          // F-14.10: a rewrite streams its first draft and, should the local voice check send
          // it back, gets the same answer again as a plain completion.
          const rewrite = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(REWRITE_SENTINEL)
          )
          // F-14.8: editor's notes come back as JSON with three cited notes, one of them
          // quoting a passage that is not in the scene, so the drop rule is exercised.
          const critique = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(CRITIQUE_SENTINEL)
          )
          // F-14.12: a proofread comes back as three JSON fixes, one of them quoting a passage
          // that is not in the scene.
          const proofread = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(PROOFREAD_SENTINEL)
          )
          // F-14.15: an edit pass comes back as two JSON changes, one of them uncitable.
          const editPass = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(EDIT_PASS_SENTINEL)
          )
          // F-13.4: a consistency check comes back as findings built from the request itself.
          const continuity = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(CONTINUITY_SENTINEL)
          )
          // F-14.11: a beta read comes back as three JSON items, two of them uncitable.
          const betaReader = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(BETA_READER_SENTINEL)
          )
          // F-5.7: a Story Intelligence answer comes back with three JSON citations, two of
          // them uncitable.
          const query = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(QUERY_SENTINEL)
          )
          // F-5.22: the chat agent's protocol: a lookup first, then the answer.
          const chatAgent = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(CHAT_AGENT_SENTINEL)
          )
          // F-5.17: What should come next? comes back as three JSON directions.
          const whatNext = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(WHAT_NEXT_SENTINEL)
          )
          // F-14.3: a brief draft comes back as the five JSON lines.
          const brief = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(BRIEF_SENTINEL)
          )
          // F-5.6: a scene summary comes back as the summary, key points, and characters.
          const summary = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(SUMMARY_SENTINEL)
          )
          // F-12.3: an import chunk comes back as one break, one title, and one tag candidate.
          const importStructure = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(IMPORT_STRUCTURE_SENTINEL)
          )
          // F-9.8: a context-library chunk comes back as the people and places of its file.
          const contextImport = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(CONTEXT_IMPORT_SENTINEL)
          )
          // F-9.9: a review chat message comes back as operations on the listed review.
          const reviewChat = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(REVIEW_CHAT_SENTINEL)
          )
          // F-9.10: an organise request comes back as a plan over the listed refs.
          const organise = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(ORGANISE_SENTINEL)
          )
          // F-5.19: the router picks editor's notes for the routed step's message, else chat.
          const route = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(ROUTE_SENTINEL)
          )
          // F-5.20: a suggested synopsis, and suggested key points for the notes.
          const synopsis = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(SYNOPSIS_SENTINEL)
          )
          const notesSuggest = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(NOTES_SUGGEST_SENTINEL)
          )
          // F-9.16: the To do check flags one question; an item's suggestions are three options.
          const todoCheck = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(TODO_SENTINEL)
          )
          const todoSuggest = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(TODO_SUGGEST_SENTINEL)
          )
          // F-11.1d: plan links come back as one link of the first plan to the first scene.
          const planLinks = request.messages.some(
            (m) => m.role === 'system' && m.content.startsWith(PLAN_LINKS_SENTINEL)
          )
          // F-5.4: a Plan turn streams (server-sent events in the shape the SDK parses: content
          // deltas, one usage-only chunk, then [DONE]); an Agent turn is a plain completion.
          if (request.stream) {
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/event-stream')
            const chunk = (payload: object): string =>
              `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'gpt-5.4-mini', ...payload })}\n\n`
            // 2026-10-07: every chat agent step streams (its answer shows as it arrives), and so
            // does the draft behind an agent insertion (the Author-mode prompt, `AGENT_SENTINEL`).
            const answer = chatAgent
              ? chatAgentReply(request.messages)
              : agent
                ? `${AGENT_FIRST}\n\n${AGENT_SECOND}`
                : rewrite
                  ? REWRITE_ANSWER
                  : CHAT_ANSWER
            const cut =
              chatAgent || agent
                ? Math.floor(answer.length / 2)
                : rewrite
                  ? REWRITE_ANSWER.indexOf(' Rain')
                  : CHAT_ANSWER.indexOf(' ridge') + 6
            res.write(
              chunk({
                choices: [
                  { index: 0, delta: { content: answer.slice(0, cut) }, finish_reason: null }
                ]
              })
            )
            res.write(
              chunk({
                choices: [
                  { index: 0, delta: { content: answer.slice(cut) }, finish_reason: 'stop' }
                ]
              })
            )
            res.write(
              chunk({
                choices: [],
                usage: { prompt_tokens: 500, completion_tokens: 16, total_tokens: 516 }
              })
            )
            res.end('data: [DONE]\n\n')
            return
          }
          const regen = request.messages.some(
            (m) => m.role === 'system' && m.content.includes(TAGS_REGEN_SENTINEL)
          )
          const offVoice = request.messages.some(
            (m) => m.role === 'user' && m.content.includes(OFF_VOICE_SENTINEL)
          )
          res.statusCode = 200
          res.end(
            JSON.stringify({
              id: 'chatcmpl-fake',
              object: 'chat.completion',
              created: 0,
              model: 'gpt-5.4-mini',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: json
                      ? todoSuggest
                        ? JSON.stringify({ suggestions: TODO_OPTIONS })
                        : todoCheck
                          ? todoAnswer(request.messages)
                          : planLinks
                            ? PLAN_LINKS_ANSWER
                            : contextImport
                              ? contextImportAnswer(request.messages)
                              : reviewChat
                                ? reviewChatAnswer(request.messages)
                                : organise
                                  ? organiseAnswer(request.messages)
                                  : chatAgent
                                    ? chatAgentReply(request.messages)
                                    : route
                                      ? JSON.stringify({
                                          action: (request.messages.at(-1)?.content ?? '').includes(
                                            ROUTE_CRITIQUE_MESSAGE
                                          )
                                            ? 'critique'
                                            : 'chat',
                                          instruction: null
                                        })
                                      : synopsis
                                        ? JSON.stringify({ synopsis: SUGGESTED_SYNOPSIS })
                                        : notesSuggest
                                          ? JSON.stringify({ points: SUGGESTED_POINTS })
                                          : whatNext
                                            ? WHAT_NEXT_ANSWER
                                            : editPass
                                              ? EDIT_PASS_ANSWER
                                              : proofread
                                                ? PROOFREAD_ANSWER
                                                : continuity
                                                  ? continuityAnswer(request.messages)
                                                  : importStructure
                                                    ? IMPORT_STRUCTURE_ANSWER
                                                    : critique
                                                      ? CRITIQUE_ANSWER
                                                      : betaReader
                                                        ? BETA_READER_ANSWER
                                                        : query
                                                          ? QUERY_ANSWER
                                                          : brief
                                                            ? BRIEF_ANSWER
                                                            : summary
                                                              ? SUMMARY_ANSWER
                                                              : regen
                                                                ? '{"tags":["antagonist","protagonist"]}'
                                                                : '{"tags":["dark-forest","protagonist"]}'
                      : rewrite
                        ? REWRITE_ANSWER
                        : agent
                          ? `${AGENT_FIRST}\n\n${AGENT_SECOND}`
                          : offVoice
                            ? OFF_VOICE_CONTINUATION
                            : GHOST_CONTINUATION
                  },
                  finish_reason: 'stop'
                }
              ],
              usage: json
                ? { prompt_tokens: 400, completion_tokens: 12, total_tokens: 412 }
                : { prompt_tokens: 300, completion_tokens: 9, total_tokens: 309 }
            })
          )
        }
        const slow = request.messages.at(-1)?.content.includes(SLOW_SENTINEL) === true
        setTimeout(respond, slow ? SLOW_DELAY_MS : 0)
      })
      return
    }
    // `GET /v1/models/<id>` echoes the requested id, so the AI tab's "answered" line names the
    // model the fast tier is configured with (F-5.11).
    const id = (req.url ?? '').split('/').pop() ?? ''
    res.statusCode = 200
    res.end(JSON.stringify({ id, object: 'model', created: 0, owned_by: 'system' }))
  })
  return new Promise((resolve) => {
    fakeOpenAi.listen(0, '127.0.0.1', () => {
      const address = fakeOpenAi.address()
      if (!address || typeof address === 'string') throw new Error('fake OpenAI server has no port')
      resolve(`http://127.0.0.1:${address.port}/v1`)
    })
  })
}

let fakeCloudApi: http.Server
/** Every address the fake Cloud Worker was asked to email a sign-in link to (F-15.2). */
const cloudSignInEmails: string[] = []
/** The link is only "opened" when the test says so; until then every poll answers pending. */
let cloudApproved = false
/** The Worker hands a session over exactly once, so a second poll for the same attempt expires. */
let cloudSessionTaken = false
let cloudSessionRevoked = false
const CLOUD_SESSION_TOKEN = 'e2e-session-token'
/**
 * AI-BILLING-SPEC A5, S6: the short-lived access token `/auth/refresh` mints from the session
 * (the refresh token). Every bearer the fake sees is recorded, so the test can check that the
 * app sends the access token and never the session token once the Worker can mint one.
 */
const CLOUD_ACCESS_TOKEN = 'e2e-access-token'
const cloudBearers: string[] = []
const CLOUD_USER_ID = 'e2e-user-1'
const CLOUD_SINCE = '2026-09-19T12:00:00.000Z'
/**
 * F-15.3: a little over $2.00 of balance, one pack on sale, and one feature that has spent
 * something. F-15.5: the period rows the meter shows, and a balance close enough to the
 * low-balance line ($2.00, AI-BILLING-SPEC E6) that one charged Cloud request takes it under.
 * The fake keeps the balance: `/ai/complete` charges it and `/credits` answers it, so what the
 * app shows after a charge is what the Worker said.
 */
const CLOUD_BALANCE_MICROS = 2_003_000
let cloudBalanceMicros = CLOUD_BALANCE_MICROS
const CLOUD_PACK = { variantId: 'pack-10', priceCents: 1000 }
/**
 * 2026-10-08: the $5 starter pack on offer, and one purchase whose unused $1.00 can be refunded.
 * The fake records each refund asked for and leaves the balance alone, so the later steps that
 * follow the balance are unaffected.
 */
const CLOUD_STARTER = { variantId: 'starter-5', priceCents: 500 }
const CLOUD_REFUNDABLE = {
  orderId: 'order-e2e',
  paidMicros: 10_000_000,
  purchasedAt: Date.now() - 24 * 60 * 60_000,
  refundUntil: Date.now() + 29 * 24 * 60 * 60_000,
  refundableMicros: 1_000_000,
  pending: false
}
const cloudRefunds: string[] = []
const CLOUD_SPEND = { feature: 'ghostText', micros: 1200, requests: 3, tokens: 900 }
/** The rolling period's own breakdown: $0.20 spent, the oldest of it three days ago. */
const CLOUD_PERIOD_SPEND = { feature: 'chat', micros: 200_000, requests: 2, tokens: 5_000 }
const CLOUD_PERIOD_FIRST_CHARGE_AT = Date.now() - 3 * 24 * 60 * 60_000
/** The balance, as the app formats it (`formatUsd` in `usageFormat.ts`). */
const balanceText = (micros: number): string => `$${(micros / MICROS_PER_USD).toFixed(2)}`
const CLOUD_CHECKOUT_URL =
  'https://mythscribe.lemonsqueezy.com/buy/test?checkout[custom][user_id]=user-1'
/**
 * F-15.9: the Supporter license. The fake Worker signs a real token with the throwaway keypair in
 * `e2e/fixtures/license-test-key.json`, and the app is launched with that pair's public half in
 * `MYTHSCRIBE_LICENSE_PUBLIC_KEY`, so the verification in main runs for real. The private half is
 * test-only and is never the key the released Worker signs with.
 */
const LICENSE_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'license-test-key.json'), 'utf8')
) as { privateKey: JsonWebKey; publicKey: JsonWebKey }
const CLOUD_SUPPORTER_PRODUCT = { variantId: 'supporter', priceCents: 3900 }
let licenseSigningKey: CryptoKey

/** One freshly signed license token for the fake Worker's signed-in account. */
async function signLicenseToken(): Promise<string> {
  const iat = Date.now()
  const payload = encodeLicensePayload({
    v: 1,
    sub: CLOUD_USER_ID,
    iat,
    exp: iat + LICENSE_GRACE_MS
  })
  // Copied into its own buffer: Web Crypto takes a `BufferSource` backed by a plain ArrayBuffer.
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    licenseSigningKey,
    new Uint8Array(payload)
  )
  return formatLicenseToken(payload, new Uint8Array(signature))
}

/**
 * F-15.4: what the fake Cloud Worker answers `POST /ai/complete` with, and what it saw. The
 * token counts are large enough that the Cloud rate (2x the provider's) shows in the cost line
 * as a different number from the OpenAI one. While `CLOUD_AI_AVAILABLE` is false nothing calls
 * it (the test asserts `cloudAiRequests` stays empty); the steps that drove it return when it flips.
 */
const CLOUD_AI_USAGE = { inputTokens: 10_000, outputTokens: 2_000 }
const CLOUD_AI_ANSWER = 'MythScribe Cloud answered this one.'
const CLOUD_AI_DELTAS = ['MythScribe Cloud ', 'answered this one.']
const cloudAiRequests: {
  feature: string
  model: string
  stream: boolean
  auth: string | undefined
}[] = []

/** Stands in for the author opening the sign-in link in their browser. */
function approveSignIn(): void {
  cloudApproved = true
}

/**
 * F-15.2: the account steps never reach api.mythscribe.app. `MYTHSCRIBE_CLOUD_API_URL` points
 * main at this server, which speaks the four auth routes of `src/shared/cloudApi.ts`: it records
 * the address a link was asked for, answers polls pending until `approveSignIn()`, then hands
 * over one session, and authorises `/auth/me` and `/auth/signout` with that session's token
 * or the access token `/auth/refresh` mints from it (AI-BILLING-SPEC A5). It also answers the
 * two credit routes (F-15.3), `/pricing` and `/usage` (B3b) behind the same bearer, and `/license`
 * (F-15.9) with a token it signs itself. No mail is sent, no link is ever pasted back into the
 * app, and no checkout is ever opened (the test does not click Buy, which would hand a URL to the
 * real browser).
 */
async function startFakeCloudApi(): Promise<string> {
  licenseSigningKey = await crypto.subtle.importKey(
    'jwk',
    LICENSE_FIXTURE.privateKey,
    { name: 'Ed25519' },
    false,
    ['sign']
  )
  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
  const authorized = (req: http.IncomingMessage): boolean => {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    cloudBearers.push(bearer)
    return !cloudSessionRevoked && (bearer === CLOUD_SESSION_TOKEN || bearer === CLOUD_ACCESS_TOKEN)
  }

  fakeCloudApi = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0]
    if (req.method === 'POST' && url === '/auth/start') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () => {
        const { email } = JSON.parse(body) as { email: string }
        cloudSignInEmails.push(email)
        cloudApproved = false
        cloudSessionTaken = false
        cloudSessionRevoked = false
        json(res, 200, {
          attemptId: 'e2e-attempt-1',
          pollSecret: 'e2e-poll-secret',
          expiresAt: new Date(Date.now() + LOGIN_ATTEMPT_TTL_MS).toISOString()
        })
      })
      return
    }
    if (req.method === 'POST' && url === '/auth/poll') {
      req.resume()
      if (!cloudApproved) {
        json(res, 200, { status: 'pending' })
        return
      }
      if (cloudSessionTaken) {
        json(res, 200, { status: 'expired' })
        return
      }
      cloudSessionTaken = true
      json(res, 200, {
        status: 'ready',
        session: {
          token: CLOUD_SESSION_TOKEN,
          email: cloudSignInEmails[cloudSignInEmails.length - 1] ?? '',
          userId: CLOUD_USER_ID
        }
      })
      return
    }
    if (req.method === 'POST' && url === '/auth/refresh') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () => {
        const { refreshToken } = JSON.parse(body) as { refreshToken: string }
        if (cloudSessionRevoked || refreshToken !== CLOUD_SESSION_TOKEN) {
          json(res, 401, { code: 'UNAUTHORIZED', message: 'Sign in again.' })
          return
        }
        json(res, 200, {
          access: {
            token: CLOUD_ACCESS_TOKEN,
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
          }
        })
      })
      return
    }
    // AI-BILLING-SPEC P5: the price table, no bearer; the Worker's own defaults.
    if (req.method === 'GET' && url === '/pricing') {
      req.resume()
      json(res, 200, { ...bundledPricing(), packs: [CLOUD_PACK] })
      return
    }
    // E7: one page of the ledger.
    if (req.method === 'GET' && url === '/usage') {
      req.resume()
      if (!authorized(req)) {
        json(res, 401, { code: 'UNAUTHORIZED', message: 'Sign in again.' })
        return
      }
      json(res, 200, {
        entries: [
          {
            id: 'e2e-topup',
            type: 'topup',
            amountMicros: 10_000_000,
            at: Date.now() - 60_000,
            feature: null,
            model: null,
            tokensIn: null,
            tokensOut: null,
            tokensCached: null,
            requestId: null
          }
        ],
        nextCursor: null
      })
      return
    }
    if (req.method === 'GET' && url === '/auth/me') {
      if (!authorized(req)) {
        json(res, 401, { code: 'UNAUTHORIZED', message: 'Sign in again.' })
        return
      }
      json(res, 200, {
        email: cloudSignInEmails[cloudSignInEmails.length - 1] ?? '',
        userId: CLOUD_USER_ID,
        since: CLOUD_SINCE
      })
      return
    }
    if (req.method === 'GET' && url === '/credits') {
      req.resume()
      if (!authorized(req)) {
        json(res, 401, { code: 'UNAUTHORIZED', message: 'Sign in again.' })
        return
      }
      json(res, 200, {
        balanceMicros: cloudBalanceMicros,
        spend: [CLOUD_SPEND],
        periodDays: USAGE_PERIOD_DAYS,
        periodSpend: [CLOUD_PERIOD_SPEND],
        periodFirstChargeAt: CLOUD_PERIOD_FIRST_CHARGE_AT,
        packs: [CLOUD_PACK],
        starter: CLOUD_STARTER,
        refunds: [CLOUD_REFUNDABLE]
      })
      return
    }
    if (req.method === 'POST' && url === '/billing/refund') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () => {
        if (!authorized(req)) {
          json(res, 401, { code: 'UNAUTHORIZED', message: 'Sign in again.' })
          return
        }
        cloudRefunds.push((JSON.parse(body) as { orderId: string }).orderId)
        json(res, 200, {
          refundedMicros: CLOUD_REFUNDABLE.refundableMicros,
          balanceMicros: cloudBalanceMicros
        })
      })
      return
    }
    if (req.method === 'GET' && url === '/license') {
      req.resume()
      if (!authorized(req)) {
        json(res, 401, { code: 'UNAUTHORIZED', message: 'Sign in again.' })
        return
      }
      // A fresh token per call, exactly as the Worker signs one (F-15.9).
      void signLicenseToken().then(
        (token) => json(res, 200, { token, product: CLOUD_SUPPORTER_PRODUCT }),
        (err: unknown) => json(res, 500, { code: 'INTERNAL', message: String(err) })
      )
      return
    }
    if (req.method === 'POST' && url === '/billing/checkout') {
      req.resume()
      if (!authorized(req)) {
        json(res, 401, { code: 'UNAUTHORIZED', message: 'Sign in again.' })
        return
      }
      json(res, 200, { url: CLOUD_CHECKOUT_URL })
      return
    }
    if (req.method === 'POST' && url === '/ai/complete') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () => {
        if (!authorized(req)) {
          json(res, 401, { code: 'UNAUTHORIZED', message: 'Sign in again.' })
          return
        }
        const request = JSON.parse(body) as { feature: string; model: string; stream: boolean }
        cloudAiRequests.push({
          feature: request.feature,
          model: request.model,
          stream: request.stream,
          auth: req.headers.authorization
        })
        const chargeMicros = Math.round(
          hostedPriceFor(
            bundledPricing(),
            request.model,
            CLOUD_AI_USAGE.inputTokens,
            CLOUD_AI_USAGE.outputTokens
          ).costUsd * MICROS_PER_USD
        )
        // The Worker charges after it has answered (F-15.3), so every later `/credits` and the
        // balance in this answer agree, and the app's meter follows without asking again.
        cloudBalanceMicros -= chargeMicros
        const done = {
          model: request.model,
          usage: CLOUD_AI_USAGE,
          chargeMicros,
          balanceMicros: cloudBalanceMicros
        }
        if (!request.stream) {
          json(res, 200, { text: CLOUD_AI_ANSWER, ...done })
          return
        }
        // The streamed shape: NDJSON, the deltas as they arrive, then exactly one `done`.
        res.statusCode = 200
        res.setHeader('content-type', 'application/x-ndjson')
        for (const delta of CLOUD_AI_DELTAS) {
          res.write(`${JSON.stringify({ type: 'delta', delta })}\n`)
        }
        res.end(`${JSON.stringify({ type: 'done', ...done })}\n`)
      })
      return
    }
    if (req.method === 'POST' && url === '/auth/signout') {
      req.resume()
      if (!authorized(req)) {
        json(res, 401, { code: 'UNAUTHORIZED', message: 'Sign in again.' })
        return
      }
      cloudSessionRevoked = true
      res.statusCode = 204
      res.end()
      return
    }
    req.resume()
    json(res, 404, { code: 'NOT_FOUND', message: `no route for ${req.method ?? ''} ${url}` })
  })
  return new Promise((resolve) => {
    fakeCloudApi.listen(0, '127.0.0.1', () => {
      const address = fakeCloudApi.address()
      if (!address || typeof address === 'string') throw new Error('fake Cloud API has no port')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-e2e-'))
  const openAiBaseUrl = await startFakeOpenAi()
  fakeOpenAiUrl = openAiBaseUrl
  const cloudApiUrl = await startFakeCloudApi()
  // Point app-level state (recents, the AI key, the Cloud session) at the temp dir so the
  // developer's real userData is untouched, the OpenAI SDK at the fake provider, and the account
  // routes (F-15.2) at the fake Worker, so nothing leaves the machine.
  launchEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
    ),
    NODE_ENV: 'test',
    MYTHSCRIBE_USER_DATA: path.join(tmp, 'userData'),
    OPENAI_BASE_URL: openAiBaseUrl,
    // AI-BILLING-SPEC S2 refuses a provider key without a keyring; xvfb has none.
    MYTHSCRIBE_E2E_PLAINTEXT_KEYS: '1',
    MYTHSCRIBE_CLOUD_API_URL: cloudApiUrl,
    // F-15.9: verify licenses against the fixture keypair, not the key the release ships with.
    MYTHSCRIBE_LICENSE_PUBLIC_KEY: JSON.stringify(LICENSE_FIXTURE.publicKey)
  }
  await launch()
})

/** Starts the app on the e2e's userData; F-7.9 starts it a second time to see what it remembers. */
async function launch(): Promise<void> {
  exited = false
  app = await electron.launch({ args: ['.'], env: launchEnv })
  app.on('close', () => {
    exited = true
  })
  page = await app.firstWindow()
}

test.afterAll(async () => {
  // The last step closes the window, which quits the app on Linux; only close it if still up.
  if (!exited) await app?.close()
  await new Promise<void>((resolve) => fakeOpenAi.close(() => resolve()))
  await new Promise<void>((resolve) => fakeCloudApi.close(() => resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('create, close, reopen a project on disk', async () => {
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()

  // The native save dialog cannot be driven, so stub it in the main process. `createDialogs`
  // looks up `dialog.showSaveDialog` at call time, so the patch takes effect for the wizard.
  const projectPath = path.join(tmp, 'Smoke Novel.mythscribe')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, projectPath)

  // F-1.2: the wizard — name, then format cards. Back keeps the name. F-15.11 adds a third
  // step: where AI requests go; F-5.18 a fourth: how much AI helps.
  await page.getByRole('button', { name: 'New project' }).click()
  const wizard = page.getByRole('dialog')
  // The name field takes focus as the wizard opens, so a key the author happens to press on the
  // real keyboard lands in it (WSLg gives the window focus): empty it before testing the refusal.
  await wizard.getByRole('textbox', { name: 'Project name' }).fill('')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await expect(wizard.getByRole('alert')).toHaveText('A name is required')
  await wizard.getByRole('textbox', { name: 'Project name' }).fill('Smoke Novel')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await expect(wizard.getByRole('radio', { name: /^novel/i })).toBeChecked()
  // The radio is visually hidden; the card label is what the author clicks.
  await wizard.getByText('Web novel', { exact: true }).click()
  await expect(wizard.getByRole('radio', { name: /^web novel/i })).toBeChecked()
  await wizard.getByRole('button', { name: 'Back' }).click()
  await expect(wizard.getByRole('textbox', { name: 'Project name' })).toHaveValue('Smoke Novel')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  // F-15.11: own key is the default. Until Cloud serves AI (`CLOUD_AI_AVAILABLE`, decided by the
  // author 2026-10-07) its card is shown disabled with "Coming soon", and clicking it changes
  // nothing; a local model can still be picked, and the test goes back to the own key.
  await expect(wizard).toContainText('Step 3 of 5')
  await expect(wizard.getByRole('radio', { name: /^my own key/i })).toBeChecked()
  await expect(wizard.getByRole('radio', { name: /^mythscribe cloud/i })).toBeDisabled()
  await expect(wizard.getByTestId('wizard-cloud-coming-soon')).toHaveText('Coming soon')
  await wizard.getByTestId('wizard-cloud-coming-soon').click({ force: true })
  await expect(wizard.getByRole('radio', { name: /^my own key/i })).toBeChecked()
  await wizard.getByText('Local model', { exact: true }).click()
  await expect(wizard.getByTestId('wizard-source-hint')).toContainText('Start Ollama or LM Studio')
  await wizard.getByText('My own key', { exact: true }).click()
  await expect(wizard.getByRole('radio', { name: /^my own key/i })).toBeChecked()
  // F-5.18 (Use AI since 2026-10-07): the last step explains the background work and recommends
  // Use AI on, the chat in Ask; Off is one click. The rest of this test turns AI on itself, so
  // it starts off.
  await wizard.getByRole('button', { name: 'Next' }).click()
  await expect(wizard).toContainText('Step 4 of 5')
  await expect(wizard.getByTestId('wizard-dial-explainer')).toContainText('flags contradictions')
  await expect(wizard.getByRole('group', { name: 'Use AI' })).toBeVisible()
  await expect(wizard.getByRole('radio', { name: /^on/i })).toBeChecked()
  await wizard.getByText('Off', { exact: true }).click()
  await expect(wizard.getByRole('radio', { name: /^off/i })).toBeChecked()
  // F-9.8: the optional worldbuilding step; skipped here (the Library step below adds files).
  await wizard.getByRole('button', { name: 'Next' }).click()
  await expect(wizard).toContainText('Step 5 of 5')
  await expect(wizard.getByTestId('wizard-context-add')).toBeVisible()
  await wizard.getByRole('button', { name: 'Create' }).click()

  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
  // F-15.11: the choice was stored with the project and the AI tab opens on it; the Cloud option
  // is disabled with "Coming soon", so no Cloud rate shows beside the models.
  expect((await aiSettings()).source).toBe('ownKey')
  expect((await aiSettings()).dial).toBe(0)
  await expect(page.getByRole('complementary', { name: 'Assistant' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings' }).click()
  const firstSettings = page.getByRole('dialog', { name: 'Settings' })
  await firstSettings.getByRole('tab', { name: 'AI' }).click()
  await expect(firstSettings.getByTestId('ai-source-ownKey')).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(firstSettings.getByTestId('ai-source-cloud')).toBeDisabled()
  await expect(firstSettings.getByTestId('ai-source-cloud-coming-soon')).toHaveText('Coming soon')
  await expect(firstSettings.getByTestId('ai-model-rate-fast')).toHaveCount(0)
  await firstSettings.getByRole('button', { name: 'Close settings' }).click()
  await expect(firstSettings).toHaveCount(0)
  // F-1.5: the shell header and window title carry the project name and format.
  await expect(page).toHaveTitle(`MythScribe — ${projectPath}`)
  await expect(page.locator('header')).toContainText('Web novel')
  expect(fs.existsSync(path.join(projectPath, 'project.db'))).toBe(true)
  expect(fs.existsSync(path.join(projectPath, 'assets'))).toBe(true)

  const created = await page.evaluate<IpcResult<ProjectInfo | null>>(
    () =>
      window.mythscribe.invoke('project:current', undefined) as Promise<
        IpcResult<ProjectInfo | null>
      >
  )
  expect(created.ok).toBe(true)
  if (!created.ok || !created.data) throw new Error('project was not created')
  expect(created.data.path).toBe(projectPath)

  // F-1.3: the new project is seeded with the three sections and Arc 1 → Chapter 1 → Scene 1.
  const seeded = await listTree()
  expect(seeded).toHaveLength(6)
  expect(seeded.filter((n) => n.sectionType !== null)).toHaveLength(3)
  expect(
    seeded
      .filter((n) => n.sectionType === null)
      .map((n) => n.title)
      .sort()
  ).toEqual(['Arc 1', 'Chapter 1', 'Scene 1'])
  // The steps below were written against the older starter (Arc 1–2 → Chapter 1–3 → Scene 1), so
  // grow it through the bridge, in the old row order, and reload so the renderer shows it.
  await growLegacyStarter(seeded)
  await page.reload()
  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
  expect(await listTree()).toHaveLength(17)

  // F-4.1: the tag bank works through the bridge (the Tags tab arrives with F-4.2): a created
  // tag comes back kebab-cased with its category's default color and no usage yet.
  const tagCreated = await page.evaluate<IpcResult<Tag>>(
    () =>
      window.mythscribe.invoke('tag:create', {
        name: 'Dark Forest',
        category: 'setting'
      }) as Promise<IpcResult<Tag>>
  )
  expect(tagCreated.ok).toBe(true)
  if (!tagCreated.ok) throw new Error(`tag:create failed: ${tagCreated.error.message}`)
  expect(tagCreated.data).toMatchObject({
    name: 'dark-forest',
    category: 'setting',
    color: '#ea580c',
    parentId: null,
    usageCount: 0
  })
  const tagList = await page.evaluate<IpcResult<Tag[]>>(
    () => window.mythscribe.invoke('tag:list', undefined) as Promise<IpcResult<Tag[]>>
  )
  expect(tagList.ok).toBe(true)
  if (tagList.ok) expect(tagList.data).toEqual([tagCreated.data])

  // F-2.1: the document tree shows the sections by format, collapses and expands a folder, and
  // selecting a scene highlights it and shows it in the main pane.
  const tree = page.getByRole('tree', { name: 'Document tree' })
  // F-3.5: nothing is selected yet, so the main pane shows the empty state.
  await expect(page.getByTestId('empty-state')).toHaveText('Select a document to start writing.')
  await expect(tree.getByRole('treeitem', { name: 'Volume 1', exact: true })).toBeVisible()
  const arc1 = tree.getByRole('treeitem', { name: 'Arc 1', exact: true })
  await expect(arc1).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'Arc 2', exact: true })).toBeVisible()
  const chapter1 = arc1.getByRole('treeitem', { name: 'Chapter 1', exact: true })
  await expect(chapter1).toBeVisible()
  await tree.getByRole('button', { name: 'Collapse Arc 1' }).click()
  await expect(chapter1).toBeHidden()
  await expect(arc1).toHaveAttribute('aria-expanded', 'false')
  await tree.getByRole('button', { name: 'Expand Arc 1' }).click()
  await expect(chapter1).toBeVisible()
  const scene1 = chapter1.getByRole('treeitem', { name: 'Scene 1', exact: true })
  await scene1.click()
  await expect(scene1).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')

  // F-7.2: the arrow keys on the sidebar handle widen it; the new fraction is written to
  // app-state.json (so it survives a restart), and the header button hides and shows the tree.
  const sidebarHandle = page.getByRole('separator', { name: 'Resize sidebar' })
  const sidebarBefore = (await getLayout()).sidebar.size
  await sidebarHandle.focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  // The renderer resizes at once; main learns of it after the 150 ms debounce.
  await expect
    .poll(async () => (await getLayout()).sidebar.size, { timeout: 3000 })
    .toBeGreaterThan(sidebarBefore)
  const sidebarAfter = (await getLayout()).sidebar.size
  await expect(sidebarHandle).toHaveAttribute(
    'aria-valuenow',
    String(Math.round(sidebarAfter * 100))
  )
  // Back the other way, so the later column-width checks (F-3.4/F-3.6) keep the room they assume.
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft')
  await expect
    .poll(async () => (await getLayout()).sidebar.size, { timeout: 3000 })
    .toBeLessThan(sidebarAfter)
  const sidebarFinal = (await getLayout()).sidebar.size
  expect(sidebarFinal).toBeCloseTo(sidebarBefore)
  const appStateFile = path.join(tmp, 'userData', 'app-state.json')
  await expect
    .poll(() => (fs.existsSync(appStateFile) ? fs.readFileSync(appStateFile, 'utf8') : ''), {
      timeout: 3000
    })
    .toContain('"layout"')
  expect((JSON.parse(fs.readFileSync(appStateFile, 'utf8')) as { layout: Layout }).layout).toEqual(
    await getLayout()
  )

  // F-7.10: Ctrl+= scales the writing surface only — one step up is 110 % of the project's font
  // size and column width (16 px and 700 px here, the web-novel defaults) — and leaves the
  // window's zoom factor at 100 %, which is where the interface size lives. Ctrl+wheel steps it
  // the same way, Settings › Appearance sets the interface size, and Ctrl+0 puts the document
  // back. Both are app-wide, so they land in app-state.json beside the layout — and every later
  // step assumes 100 % and Medium.
  const windowZoom = (): Promise<number> =>
    app.evaluate(({ BrowserWindow }) =>
      Math.round((BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor() ?? 0) * 100)
    )
  /** The editing surface's font size and column width in CSS px, as the browser resolved them. */
  const documentSize = (): Promise<{ font: number; column: number }> =>
    page.getByRole('textbox', { name: 'Document' }).evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        font: parseFloat(style.fontSize),
        column: parseFloat(style.getPropertyValue('--ms-editor-max-width'))
      }
    })
  expect(await windowZoom()).toBe(100)
  expect(await documentSize()).toEqual({ font: 16, column: 700 })
  await page.keyboard.press('Control+=')
  await expect.poll(async () => (await documentSize()).font, { timeout: 3000 }).toBeCloseTo(17.6, 1)
  expect((await documentSize()).column).toBeCloseTo(770, 0)
  await expect(page.getByRole('status').filter({ hasText: 'Document zoom' })).toContainText(
    'Document zoom 110 %'
  )
  // The document zoom is not the window's: Chromium's own Ctrl+zoom never runs.
  expect(await windowZoom()).toBe(100)
  // One wheel notch with Ctrl held is one more step (125 %); the deltas of the notch coalesce.
  const editorBox = await page.getByRole('textbox', { name: 'Document' }).boundingBox()
  if (!editorBox) throw new Error('editor not laid out')
  await page.mouse.move(editorBox.x + editorBox.width / 2, editorBox.y + 20)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await documentSize()).font, { timeout: 3000 }).toBeCloseTo(20, 1)
  expect(await windowZoom()).toBe(100)

  // Settings › Appearance is app-wide (it is there without a project too): Large scales the
  // chrome through the window's zoom factor, and the document zoom above is untouched.
  const appearance = page.getByRole('dialog', { name: 'Settings' })
  await page.getByRole('button', { name: 'Settings' }).click()
  await appearance.getByRole('tab', { name: 'Appearance' }).click()
  await expect(appearance.getByTestId('appearance-document-zoom')).toHaveText('125 %')
  await appearance.getByTestId('appearance-ui-scale-large').click()
  await expect.poll(windowZoom, { timeout: 3000 }).toBe(115)
  await expect(appearance.getByTestId('appearance-ui-scale-large')).toHaveAttribute(
    'aria-checked',
    'true'
  )
  expect((await documentSize()).font).toBeCloseTo(20, 1)
  // Back to Medium, so the rest of the test measures an unscaled window.
  await appearance.getByTestId('appearance-ui-scale-medium').click()
  await expect.poll(windowZoom, { timeout: 3000 }).toBe(100)
  await appearance.getByRole('button', { name: 'Close settings' }).click()
  await expect(appearance).toHaveCount(0)

  await page.keyboard.press('Control+0')
  await expect.poll(async () => (await documentSize()).font, { timeout: 3000 }).toBe(16)
  const storedView = (): unknown =>
    (JSON.parse(fs.readFileSync(appStateFile, 'utf8')) as { view: unknown }).view
  await expect.poll(storedView, { timeout: 3000 }).toEqual({
    editorZoom: 1,
    uiScale: 'medium',
    pageEdges: true,
    theme: 'dark',
    customThemes: []
  })

  // F-7.11: the column is a sheet on the desk by default (the edge is the column element's own
  // border); View › Page edges turns it into the borderless column and announces it, the
  // choice lands in app-state.json, and the Appearance checkbox turns it back on.
  const sheet = page.getByRole('textbox', { name: 'Document' }).locator('..')
  await expect(sheet).toHaveClass(/ms-sheet/)
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'View' })
    .click()
  await page
    .getByRole('menu', { name: 'View' })
    .getByRole('menuitem', { name: 'Page edges' })
    .click()
  await expect(sheet).not.toHaveClass(/ms-sheet/)
  await expect(page.getByRole('status').filter({ hasText: 'Page edges' })).toContainText(
    'Page edges hidden'
  )
  await expect.poll(storedView, { timeout: 3000 }).toMatchObject({ pageEdges: false })
  await page.getByRole('button', { name: 'Settings' }).click()
  await appearance.getByRole('tab', { name: 'Appearance' }).click()
  const pageEdges = appearance.getByTestId('appearance-page-edges')
  await expect(pageEdges).not.toBeChecked()
  await pageEdges.click()
  await expect(pageEdges).toBeChecked()
  await appearance.getByRole('button', { name: 'Close settings' }).click()
  await expect(appearance).toHaveCount(0)
  await expect(sheet).toHaveClass(/ms-sheet/)
  await expect.poll(storedView, { timeout: 3000 }).toMatchObject({ pageEdges: true })

  // F-7.8: View › Switch theme steps from Dark to Light, names it, and main keeps it; the
  // Appearance tab picks High contrast, and Dark again so the rest of the test looks as before.
  const html = page.locator('html')
  await expect(html).not.toHaveAttribute('data-theme')
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'View' })
    .click()
  await page
    .getByRole('menu', { name: 'View' })
    .getByRole('menuitem', { name: 'Switch theme' })
    .click()
  await expect(html).toHaveAttribute('data-theme', 'light')
  await expect(html).toHaveAttribute('data-scheme', 'light')
  await expect(page.getByRole('status').filter({ hasText: 'Theme:' })).toContainText('Theme: Light')
  await expect.poll(storedView, { timeout: 3000 }).toMatchObject({ theme: 'light' })
  await page.getByRole('button', { name: 'Settings' }).click()
  await appearance.getByRole('tab', { name: 'Appearance' }).click()
  await expect(appearance.getByTestId('appearance-theme-light')).toHaveAttribute(
    'aria-checked',
    'true'
  )
  // Sepia is a Supporter extra; nothing is licensed yet.
  await expect(appearance.getByTestId('appearance-theme-sepia')).toBeDisabled()
  await appearance.getByTestId('appearance-theme-high-contrast').click()
  await expect(html).toHaveAttribute('data-theme', 'high-contrast')
  await expect(html).toHaveAttribute('data-scheme', 'dark')
  await expect.poll(storedView, { timeout: 3000 }).toMatchObject({ theme: 'high-contrast' })
  await appearance.getByTestId('appearance-theme-dark').click()
  await expect(html).not.toHaveAttribute('data-theme')
  await expect.poll(storedView, { timeout: 3000 }).toMatchObject({ theme: 'dark' })
  await appearance.getByRole('button', { name: 'Close settings' }).click()
  await expect(appearance).toHaveCount(0)

  const sidebarToggle = page.getByRole('button', { name: 'Sidebar', exact: true })
  await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'true')
  await sidebarToggle.click()
  await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(tree).toBeHidden()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await sidebarToggle.click()
  await expect(sidebarToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(tree).toBeVisible()
  await expect(scene1).toHaveAttribute('aria-selected', 'true')
  await expect
    .poll(async () => (await getLayout()).sidebar, { timeout: 3000 })
    .toEqual({ open: true, size: sidebarFinal, tab: 'manuscript' })

  // F-9.11: the sidebar's sections are one labelled picker, not a row of tabs. It shows the
  // current section by name; opened, it lists the sections in use by name — Manuscript, the
  // story-bible categories with sheets (Characters and Places always) closed by the Index (the
  // tags, always; F-9.15), then the tools (Outline once the manuscript has a document) — with
  // every empty category and tool behind "Show unused sections", and "New category…" last. Its
  // panel holds the tree.
  const sectionPicker = page.getByRole('button', { name: /^Section: / })
  await expect(sectionPicker).toHaveAccessibleName('Section: Manuscript')
  await sectionPicker.click()
  const sectionList = page.getByRole('listbox', { name: 'Sections' })
  await expect(sectionOptions()).toHaveText([
    /^Manuscript\d*$/,
    /^Characters\d*$/,
    /^Places\d*$/,
    /^Index\d*$/,
    /^Outline\d*$/,
    // F-9.16: To do is always shown.
    /^To do\d*$/,
    /^Show unused sections \(\d+\)$/,
    'New category…'
  ])
  await expect(sectionList.getByRole('option', { name: 'Magic Systems' })).toHaveCount(0)
  await sectionList.getByRole('option', { name: /^Show unused sections/ }).click()
  await expect(sectionList.getByRole('option', { name: 'Magic Systems' })).toBeVisible()
  await expect(sectionList.getByRole('option', { name: 'Library' })).toBeVisible()
  await sectionList.getByRole('option', { name: 'Hide unused sections' }).click()
  await page.keyboard.press('Escape')
  await expect(sectionList).toHaveCount(0)
  await expect(sectionPicker).toBeFocused()
  await expect(sectionPicker).toHaveAccessibleName('Section: Manuscript')
  await expect(
    page.getByRole('region', { name: 'Manuscript section', exact: true }).getByRole('tree')
  ).toBeVisible()

  // F-2.2: "New scene" from the bar inserts after the selected scene and opens inline rename;
  // Enter commits the title and the row keeps its place right after Scene 1.
  await page.getByRole('button', { name: 'New scene' }).click()
  const untitled = chapter1.getByRole('treeitem', { name: 'Untitled Scene', exact: true })
  await expect(untitled).toBeVisible()
  const renameBox = page.getByRole('textbox', { name: 'Rename' })
  await expect(renameBox).toBeFocused()
  await renameBox.fill('Opening')
  await renameBox.press('Enter')
  await expect(renameBox).toBeHidden()
  await expect(chapter1.getByRole('treeitem', { name: 'Opening', exact: true })).toBeVisible()
  await expect(chapter1.getByRole('treeitem')).toHaveText([/^Scene 1/, /^Opening/])

  // F-2.2: the right-click menu on a chapter offers a new scene under it; Escape cancels the
  // rename and keeps the default title.
  const chapter2 = arc1.getByRole('treeitem', { name: 'Chapter 2', exact: true })
  await chapter2.click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitem', { name: 'New Scene' }).click()
  await expect(menu).toBeHidden()
  const untitled2 = chapter2.getByRole('treeitem', { name: 'Untitled Scene', exact: true })
  await expect(untitled2).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Rename' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('textbox', { name: 'Rename' })).toBeHidden()
  await expect(untitled2).toBeVisible()
  await expect(chapter2.getByRole('treeitem')).toHaveText([/^Scene 1/, /^Untitled Scene/])

  // 2026-10-07: double-clicking a chapter's row renames it inline (it stays expanded); a second
  // double-click puts the name back for the steps below.
  await chapter2.locator(':scope > div').dblclick()
  const chapterRename = page.getByRole('textbox', { name: 'Rename' })
  await expect(chapterRename).toBeFocused()
  await expect(chapterRename).toHaveValue('Chapter 2')
  await chapterRename.fill('The Storm')
  await chapterRename.press('Enter')
  const storm = arc1.getByRole('treeitem', { name: 'The Storm', exact: true })
  await expect(storm).toBeVisible()
  await expect(storm).toHaveAttribute('aria-expanded', 'true')
  await expect(arc1.getByRole('treeitem', { name: 'Chapter 2', exact: true })).toHaveCount(0)
  await storm.locator(':scope > div').dblclick()
  await expect(chapterRename).toBeFocused()
  await chapterRename.fill('Chapter 2')
  await chapterRename.press('Enter')
  await expect(chapter2).toBeVisible()

  // F-2.3: Rename from the right-click menu opens the inline editor prefilled with the title;
  // Escape keeps it.
  const opening = chapter1.getByRole('treeitem', { name: 'Opening', exact: true })
  await opening.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Rename' }).click()
  await expect(menu).toBeHidden()
  const renameAgain = page.getByRole('textbox', { name: 'Rename' })
  await expect(renameAgain).toBeFocused()
  await expect(renameAgain).toHaveValue('Opening')
  await page.keyboard.press('Escape')
  await expect(renameAgain).toBeHidden()
  await expect(opening).toBeVisible()

  // F-2.3: Duplicate puts "<title> (Copy)" right after the original and selects it.
  await opening.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(menu).toBeHidden()
  const openingCopy = chapter1.getByRole('treeitem', { name: 'Opening (Copy)', exact: true })
  await expect(openingCopy).toBeVisible()
  await expect(openingCopy).toHaveAttribute('aria-selected', 'true')
  await expect(chapter1.getByRole('treeitem')).toHaveText([
    /^Scene 1/,
    /^Opening/,
    /^Opening \(Copy\)/
  ])

  // F-2.3: Delete asks first; confirming removes the row and selects the previous sibling.
  await openingCopy.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(menu).toBeHidden()
  const deleteDialog = page.getByRole('dialog', { name: "Delete 'Opening (Copy)'?" })
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: 'Delete' }).click()
  await expect(deleteDialog).toBeHidden()
  await expect(openingCopy).toBeHidden()
  await expect(chapter1.getByRole('treeitem')).toHaveText([/^Scene 1/, /^Opening/])
  await expect(opening).toHaveAttribute('aria-selected', 'true')

  // F-2.4: dragging Opening onto the top edge of Scene 1 (the "before" zone of a 28px row)
  // reorders it ahead of Scene 1; the selection stays on the moved row.
  await opening.dragTo(scene1, { targetPosition: { x: 60, y: 4 } })
  await expect(chapter1.getByRole('treeitem')).toHaveText([/^Opening/, /^Scene 1/])
  await expect(opening).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-drop]')).toHaveCount(0)

  // F-2.6: "New Title Page" from the Front Matter menu adds a gold, selected document filled from
  // the template (no rename box); the row shows the template's words and the editor opens on it.
  const frontMatter = tree.getByRole('treeitem', { name: 'Front Matter', exact: true })
  await frontMatter.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'New Title Page' }).click()
  await expect(menu).toBeHidden()
  const titlePage = frontMatter.getByRole('treeitem', { name: 'Title Page', exact: true })
  await expect(titlePage).toBeVisible()
  await expect(titlePage).toHaveAttribute('data-matter', 'true')
  await expect(titlePage).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('textbox', { name: 'Rename' })).toHaveCount(0)
  expect(TITLE_PAGE_WORDS).toBeGreaterThan(0)
  await expect(titlePage).toHaveText(`Title Page${TITLE_PAGE_WORDS}`)
  await expect(page.getByTestId('selected-title')).toHaveText('Title Page')
  const editor = page.getByRole('textbox', { name: 'Document' })
  await expect(editor.locator('h1')).toHaveText('[Book Title]')
  await expect(editor.locator('p', { hasText: '[Author Name]' })).toBeVisible()

  // F-3.1: selecting a scene shows the editor; typing, Bold from the toolbar and Ctrl+B, the
  // scene break in the web-novel style (F-3.6 default "~~~"), and undo.
  await scene1.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  await expect(page.getByTestId('empty-state')).toHaveCount(0)
  // F-3.4: the text sits in a centered column no wider than the 700 px default. Centering is
  // measured inside the scroll container's client box, so a vertical scrollbar (the editor's
  // 60 vh minimum height under the F-4.4 tag bar overflows a 900 px window) does not skew it.
  const column = await editor.locator('..').boundingBox()
  if (!column) throw new Error('editor column not laid out')
  expect(column.width).toBeLessThanOrEqual(700)
  const offCenter = await editor.locator('..').evaluate((el) => {
    const parent = el.parentElement
    if (!parent) throw new Error('editor column has no scroll container')
    const rect = el.getBoundingClientRect()
    const left = rect.left - parent.getBoundingClientRect().left - parent.clientLeft
    return Math.abs(left - (parent.clientWidth - left - rect.width))
  })
  expect(offCenter).toBeLessThan(2)
  // F-7.5: Ctrl+, opens the Settings dialog on its Editor tab; F-3.6: its controls apply a wider
  // column and a larger font live, and the preview follows; Escape closes the dialog.
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(settingsDialog).toHaveCount(0)
  await page.keyboard.press('Control+,')
  await expect(settingsDialog).toBeVisible()
  await expect(settingsDialog.getByRole('tab', { name: 'Editor' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await settingsDialog.getByRole('spinbutton', { name: 'Max width' }).fill('900')
  await settingsDialog.getByRole('spinbutton', { name: 'Font size' }).fill('20')
  await expect(settingsDialog.getByTestId('editor-preview').locator('p').nth(1)).toHaveCSS(
    'font-size',
    '20px'
  )
  await page.keyboard.press('Escape')
  await expect(settingsDialog).toHaveCount(0)
  // The header button opens the same dialog; its close button dismisses it.
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(settingsDialog).toBeVisible()
  await expect(settingsDialog.getByRole('spinbutton', { name: 'Font size' })).toHaveValue('20')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await expect(editor).toHaveCSS('font-size', '20px')
  // F-5.1: the AI tab stores a key with safe storage (only ciphertext lands in userData, the
  // renderer only ever sees a mask) and tests the connection against the fake OpenAI server.
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(settingsDialog).toBeVisible()
  // 2026-10-07: the dialog keeps one size on every tab, so its header and tabs never move.
  const editorTabBox = await settingsDialog.boundingBox()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await expect(settingsDialog.getByRole('tab', { name: 'AI' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  expect(await settingsDialog.boundingBox()).toEqual(editorTabBox)
  // F-14.4, Use AI (2026-10-07): the project's AI installs off, so every feature toggle is
  // locked; turning Use AI on unlocks them all, lands in the project's settings table, and
  // survives closing the dialog. Back off before the key steps so nothing below depends on it.
  const useAi = settingsDialog.getByRole('switch', { name: 'Use AI' })
  const ghostTextToggle = settingsDialog.getByRole('checkbox', { name: /^Ghost text/ })
  await expect(useAi).not.toBeChecked()
  await expect(ghostTextToggle).toBeDisabled()
  await expect(ghostTextToggle).toHaveAccessibleName('Ghost text')
  expect((await aiSettings()).dial).toBe(0)
  await useAi.check()
  await expect(useAi).toBeChecked()
  await expect(ghostTextToggle).toBeEnabled()
  await expect.poll(async () => (await aiSettings()).dial).toBe(1)
  // A fresh install's own key is for OpenRouter (2026-10-07); the table names it.
  await expect(
    settingsDialog.getByRole('table', { name: 'What each AI feature sends' }).getByRole('row', {
      name: /^Ghost text /
    })
  ).toContainText('OpenRouter')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await expect(useAi).toBeChecked()
  await expect(ghostTextToggle).toBeEnabled()
  await useAi.uncheck()
  await expect(ghostTextToggle).toBeDisabled()
  await expect.poll(async () => (await aiSettings()).dial).toBe(0)
  // F-5.2: the writing presets start on General; Suspense/Mystery lands in the settings table
  // and survives closing the dialog, with its parameters shown read-only; Custom exposes the
  // fields and a new instruction persists; back to General so nothing below depends on it.
  const presets = settingsDialog.getByRole('radiogroup', { name: 'Writing preset' })
  await expect(presets.getByRole('radio', { name: 'General' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  expect((await writingPresets()).active).toBe('general')
  await presets.getByRole('radio', { name: 'Suspense/Mystery' }).click()
  await expect(presets.getByRole('radio', { name: 'Suspense/Mystery' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect.poll(async () => (await writingPresets()).active).toBe('suspense')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await expect(presets.getByRole('radio', { name: 'Suspense/Mystery' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(settingsDialog.getByTestId('preset-params')).toContainText(
    PRESETS.suspense.styleInstruction
  )
  await presets.getByRole('radio', { name: 'Custom' }).click()
  const instructionField = settingsDialog.getByRole('textbox', { name: 'Style instruction' })
  await expect(instructionField).toHaveValue(PRESETS.general.styleInstruction)
  await instructionField.fill('Keep every sentence under ten words.')
  await instructionField.blur()
  await expect
    .poll(async () => await writingPresets())
    .toEqual({
      active: 'custom',
      custom: {
        temperature: PRESETS.general.temperature,
        maxSuggestionTokens: PRESETS.general.maxSuggestionTokens,
        allowNewElements: PRESETS.general.allowNewElements,
        styleInstruction: 'Keep every sentence under ten words.'
      }
    })
  await presets.getByRole('radio', { name: 'General' }).click()
  await expect.poll(async () => (await writingPresets()).active).toBe('general')
  // 2026-10-07: a fresh install's own key is for OpenRouter; the fake provider speaks OpenAI's
  // API at OPENAI_BASE_URL, so the steps below pick OpenAI, and the choice persists.
  const keyProviders = settingsDialog.getByRole('radiogroup', { name: 'Key provider' })
  await expect(keyProviders.getByTestId('own-key-provider-openrouter')).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(settingsDialog.getByRole('form', { name: 'OpenRouter API key' })).toBeVisible()
  await keyProviders.getByTestId('own-key-provider-openai').click()
  await expect(settingsDialog.getByRole('form', { name: 'OpenAI API key' })).toBeVisible()
  expect(await aiStatus()).toMatchObject({ provider: 'openai', hasKey: false })
  const keyHint = settingsDialog.getByTestId('ai-key-hint')
  const keyField = settingsDialog.getByLabel('API key', { exact: true })
  const testResult = settingsDialog.getByTestId('ai-test-result')
  await expect(keyHint).toHaveText('No key')
  await expect(settingsDialog.getByRole('button', { name: 'Test connection' })).toBeDisabled()
  await keyField.fill(REJECTED_KEY)
  await settingsDialog.getByRole('button', { name: 'Save' }).click()
  await expect(keyHint).toHaveText('Key saved: sk-…abcd')
  await expect(keyField).toHaveValue('')
  expect(await aiStatus()).toMatchObject({ hasKey: true, hint: 'sk-…abcd' })
  const keyFile = path.join(tmp, 'userData', 'ai-keys.json')
  expect(fs.existsSync(keyFile)).toBe(true)
  expect(fs.readFileSync(keyFile, 'utf8')).not.toContain(REJECTED_KEY)
  // The fake server rejects this key: the cause and the next step show inline.
  await settingsDialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(testResult).toHaveText('OpenAI rejected the API key. Check the key and try again.')
  // A key the server accepts: the answering model shows, and the old result was dropped.
  await keyField.fill(ACCEPTED_KEY)
  await settingsDialog.getByRole('button', { name: 'Save' }).click()
  await expect(keyHint).toHaveText('Key saved: sk-…wxyz')
  await expect(testResult).toHaveCount(0)
  await settingsDialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(testResult).toHaveText('Connected. gpt-5.4-mini answered.')
  expect(openAiRequests).toEqual([
    { url: '/v1/models/gpt-5.4-mini', auth: `Bearer ${REJECTED_KEY}` },
    { url: '/v1/models/gpt-5.4-mini', auth: `Bearer ${ACCEPTED_KEY}` }
  ])
  // F-5.11: the fast tier's model is a setting; the provider reads it live, so the next test
  // connection asks for the new model, and it persists in app-state.json across the dialog.
  const fastTier = settingsDialog.getByLabel('Fast tier', { exact: true })
  const resetModels = settingsDialog.getByRole('button', { name: 'Reset to defaults' })
  await expect(fastTier).toHaveValue('gpt-5.4-mini')
  await expect(settingsDialog.getByLabel('Strong tier', { exact: true })).toHaveValue('gpt-5.4')
  await expect(resetModels).toBeDisabled()
  await fastTier.fill('gpt-5.4-nano')
  await fastTier.blur()
  await expect(resetModels).toBeEnabled()
  await expect(testResult).toHaveCount(0)
  await settingsDialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(testResult).toHaveText('Connected. gpt-5.4-nano answered.')
  expect(openAiRequests[2]).toEqual({
    url: '/v1/models/gpt-5.4-nano',
    auth: `Bearer ${ACCEPTED_KEY}`
  })
  // F-15.4: one map per provider; a write to the key path leaves the Cloud one at its defaults.
  expect((await aiStatus()).models).toEqual({
    openai: { fast: 'gpt-5.4-nano', strong: 'gpt-5.4' },
    cloud: { fast: 'deepseek/deepseek-v4-flash', strong: 'deepseek/deepseek-v4-pro' },
    local: { fast: 'llama3.1', strong: 'llama3.1' },
    openrouter: { fast: 'deepseek/deepseek-v4-flash', strong: 'deepseek/deepseek-v4-pro' }
  })
  expect(
    (JSON.parse(fs.readFileSync(appStateFile, 'utf8')) as { models: AiStatus['models'] }).models
  ).toEqual({
    openai: { fast: 'gpt-5.4-nano', strong: 'gpt-5.4' },
    cloud: { fast: 'deepseek/deepseek-v4-flash', strong: 'deepseek/deepseek-v4-pro' },
    local: { fast: 'llama3.1', strong: 'llama3.1' },
    openrouter: { fast: 'deepseek/deepseek-v4-flash', strong: 'deepseek/deepseek-v4-pro' }
  })
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await expect(fastTier).toHaveValue('gpt-5.4-nano')
  await resetModels.click()
  await expect(fastTier).toHaveValue('gpt-5.4-mini')
  await expect(resetModels).toBeDisabled()
  expect((await aiStatus()).models.openai).toEqual({ fast: 'gpt-5.4-mini', strong: 'gpt-5.4' })
  // F-5.14: the Usage block shows nothing spent (no feature can spend yet) and the default
  // daily cap; a new cap lands in app-state.json and survives closing the dialog.
  const usageToday = settingsDialog.getByTestId('ai-usage-today')
  const usageTotal = settingsDialog.getByTestId('ai-usage-total')
  const dailyCap = settingsDialog.getByLabel('Daily cap (USD)', { exact: true })
  await expect(usageToday).toHaveText('$0.00')
  await expect(usageTotal).toHaveText('$0.00 · 0 requests · 0 tokens')
  await expect(settingsDialog.getByText('No AI requests in this project yet.')).toBeVisible()
  await expect(dailyCap).toHaveValue('2.00')
  await dailyCap.fill('5')
  await dailyCap.blur()
  await expect(dailyCap).toHaveValue('5.00')
  await expect(settingsDialog.getByTestId('ai-usage-session')).toHaveText(
    '$0.00 · 0 requests · 0 tokens'
  )
  await expect(settingsDialog.getByTestId('ai-usage-recent')).toHaveCount(0)
  expect(await usageSummary()).toEqual({
    today: { requests: 0, tokens: 0, costUsd: 0 },
    session: { requests: 0, tokens: 0, costUsd: 0 },
    total: { requests: 0, tokens: 0, costUsd: 0 },
    byFeature: [],
    recent: [],
    dailyCapUsd: 5
  })
  expect(
    (JSON.parse(fs.readFileSync(appStateFile, 'utf8')) as { aiUsage: { dailyCapUsd: number } })
      .aiUsage.dailyCapUsd
  ).toBe(5)
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await expect(dailyCap).toHaveValue('5.00')
  await settingsDialog.getByRole('button', { name: 'Clear' }).click()
  await expect(keyHint).toHaveText('No key')
  expect(await aiStatus()).toMatchObject({ hasKey: false, hint: null })
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  // F-15.2: the Account tab. It says the account is optional before it asks for anything, sends
  // a sign-in link through the fake Cloud Worker, and then waits: when the test stands in for
  // the author opening the link, main's poll picks the session up and this window signs itself
  // in (nothing is pasted back). Signing out returns the field. The fields are filled, not
  // typed, so the WSLg focus gotcha in docs/ARCHITECTURE.md cannot put stray letters in them.
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(settingsDialog).toBeVisible()
  await settingsDialog.getByRole('tab', { name: 'Account' }).click()
  await expect(settingsDialog.getByRole('tab', { name: 'Account' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(
    settingsDialog.getByText('Optional. You never need an account to write.')
  ).toBeVisible()
  await settingsDialog.getByLabel('Email').fill('author@example.com')
  await settingsDialog.getByRole('button', { name: 'Send sign-in link' }).click()
  await expect(
    settingsDialog.getByText('We sent a sign-in link to author@example.com.')
  ).toBeVisible()
  expect(cloudSignInEmails).toEqual(['author@example.com'])
  approveSignIn()
  // The poll runs every 3 s (`POLL_INTERVAL_MS`), so give it a few rounds.
  await expect(settingsDialog.getByTestId('account-signed-in')).toHaveText(
    'Signed in as author@example.com',
    { timeout: 15_000 }
  )
  // F-15.3: the balance section loads with the signed-in state. Add is only checked for being
  // there; clicking it would hand a Lemon Squeezy URL to the machine's real browser.
  await expect(settingsDialog.getByTestId('account-balance')).toHaveText(
    balanceText(cloudBalanceMicros)
  )
  await expect(settingsDialog.getByRole('button', { name: 'Add $10.00' })).toBeVisible()
  // 2026-10-08: the starter pack offer, and a refund of a purchase's unused balance, which asks
  // once more before it is sent to the Worker.
  await expect(settingsDialog.getByTestId('account-starter')).toContainText(
    'Try the AI for $5. Any unused balance is refundable for 30 days.'
  )
  await settingsDialog.getByText('Refund unused balance').click()
  await settingsDialog.getByRole('button', { name: 'Refund $1.00', exact: true }).click()
  await settingsDialog.getByRole('button', { name: 'Refund $1.00 now' }).click()
  await expect.poll(() => cloudRefunds, { timeout: 5000 }).toEqual(['order-e2e'])
  // AI-BILLING-SPEC A5, S6: the balance was asked for with a short-lived access token, never the
  // session (refresh) token. C3: the privacy rule beside the packs. E7: the usage history.
  expect(cloudBearers).toContain(CLOUD_ACCESS_TOKEN)
  expect(cloudBearers).not.toContain(CLOUD_SESSION_TOKEN)
  await expect(settingsDialog.getByTestId('account-privacy')).toContainText(
    'never stores or logs your manuscript'
  )
  await settingsDialog.getByText('Usage history').click()
  await expect(
    settingsDialog.getByRole('table', { name: 'Usage history' }).getByText('Added to balance')
  ).toBeVisible()
  // F-15.5: the meter over the rolling period, and no warning while the balance is above $1.00.
  await expect(settingsDialog.getByTestId('account-period-spent')).toHaveText(
    balanceText(CLOUD_PERIOD_SPEND.micros)
  )
  await expect(settingsDialog.getByTestId('account-run-out')).toContainText('left at this pace')
  await expect(settingsDialog.getByTestId('account-balance-warning')).toHaveCount(0)
  await expect(page.getByTestId('balance-notice')).toHaveCount(0)
  // F-15.4: the AI tab's source picker. Signed in or not, MythScribe Cloud stays disabled with
  // "Coming soon" until Cloud serves AI (`CLOUD_AI_AVAILABLE`); the account itself still works.
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await expect(settingsDialog.getByTestId('ai-source-cloud')).toBeDisabled()
  await expect(settingsDialog.getByTestId('ai-source-cloud-coming-soon')).toHaveText('Coming soon')
  await expect(settingsDialog.getByTestId('ai-source-ownKey')).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await settingsDialog.getByRole('tab', { name: 'Account' }).click()
  // F-15.9: the Supporter license. The fake Worker signs a token for this account, main verifies
  // it against the fixture public key and caches it, and the background refresh that follows the
  // sign-in is what puts the badge on the tab — nothing here clicks Refresh. The extras the
  // license unlocks are on the Appearance tab (F-7.8): the accent lands on <html> and is written
  // to app-state.json; Sepia unlocks; a custom theme (its Background changed) is saved, selected,
  // and laid over its base as inline variables. Both are still there after the window is
  // reloaded from main's state alone.
  await expect(settingsDialog.getByTestId('account-supporter-badge')).toBeVisible({
    timeout: 15_000
  })
  await settingsDialog.getByRole('tab', { name: 'Appearance' }).click()
  await settingsDialog.getByTestId('account-accent-ember').click()
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'ember')
  await expect
    .poll(
      () =>
        (JSON.parse(fs.readFileSync(appStateFile, 'utf8')) as { supporter: { accent: string } })
          .supporter.accent,
      { timeout: 3000 }
    )
    .toBe('ember')
  await expect(settingsDialog.getByTestId('appearance-theme-sepia')).toBeEnabled()
  await settingsDialog.getByTestId('appearance-theme-new').click()
  const themeEditor = settingsDialog.getByTestId('theme-editor')
  await themeEditor.getByLabel('Name').fill('Midnight')
  await themeEditor.getByLabel('Background').fill('#102030')
  await themeEditor.getByRole('button', { name: 'Save' }).click()
  await expect(themeEditor).toHaveCount(0)
  const inlineBg = (): Promise<string> =>
    page.evaluate(() => document.documentElement.style.getPropertyValue('--ms-bg'))
  await expect.poll(inlineBg, { timeout: 3000 }).toBe('#102030')
  const storedTheme = (): { theme: string; customThemes: { id: string; name: string }[] } =>
    (
      JSON.parse(fs.readFileSync(appStateFile, 'utf8')) as {
        view: { theme: string; customThemes: { id: string; name: string }[] }
      }
    ).view
  await expect
    .poll(() => storedTheme().customThemes.map((t) => t.name), { timeout: 3000 })
    .toEqual(['Midnight'])
  const midnightId = storedTheme().customThemes[0]?.id ?? ''
  expect(storedTheme().theme).toBe(midnightId)
  await expect(settingsDialog.getByTestId(`appearance-theme-${midnightId}`)).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'ember')
  await expect.poll(inlineBg, { timeout: 5000 }).toBe('#102030')
  // The reload dropped the renderer's selection (main keeps the project open, not the caret), so
  // put the scene and the dialog back for the steps that follow.
  await scene1.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(settingsDialog).toBeVisible()
  await settingsDialog.getByRole('tab', { name: 'Account' }).click()
  await settingsDialog.getByRole('button', { name: 'Sign out' }).click()
  await expect(settingsDialog.getByLabel('Email')).toBeVisible()
  // F-7.8: signed out, the license is gone, so the custom theme paints Dark while main keeps the
  // choice; the Appearance tab then picks Dark for the rest of the test.
  await expect.poll(inlineBg, { timeout: 5000 }).toBe('')
  await expect(page.locator('html')).not.toHaveAttribute('data-theme')
  expect(storedTheme().theme).toBe(midnightId)
  await settingsDialog.getByRole('tab', { name: 'Appearance' }).click()
  await expect(settingsDialog.getByTestId(`appearance-theme-${midnightId}`)).toBeDisabled()
  await settingsDialog.getByTestId('appearance-theme-dark').click()
  await expect.poll(() => storedTheme().theme, { timeout: 3000 }).toBe('dark')
  expect(cloudAiRequests).toEqual([])
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  const widened = await editor.locator('..').boundingBox()
  if (!widened) throw new Error('editor column not laid out')
  expect(widened.width).toBeGreaterThan(700)
  expect(widened.width).toBeLessThanOrEqual(900)
  await editor.click()
  await page.keyboard.type('The storm broke at dusk.')
  await expect(editor.locator('p')).toHaveText('The storm broke at dusk.')
  const bold = page
    .getByRole('toolbar', { name: 'Formatting' })
    .getByRole('button', { name: 'Bold' })
  await expect(bold).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Control+a')
  await bold.click()
  await expect(bold).toHaveAttribute('aria-pressed', 'true')
  await expect(editor.locator('strong')).toHaveText('The storm broke at dusk.')
  await page.keyboard.press('Control+b')
  await expect(bold).toHaveAttribute('aria-pressed', 'false')
  await expect(editor.locator('strong')).toHaveCount(0)
  await page.keyboard.press('End')
  await page.getByRole('button', { name: 'Scene break' }).click()
  const sceneBreak = editor.locator('[data-scene-break]')
  await expect(sceneBreak).toHaveText('~~~')
  await expect(editor.locator('p')).toHaveCount(2)
  await page.keyboard.press('Control+z')
  await expect(sceneBreak).toHaveCount(0)
  await expect(editor.locator('p')).toHaveCount(1)

  // F-3.2: the debounced autosave writes the text about a second after the last keystroke, and
  // Ctrl+S writes it at once. Both are read back through `document:get`.
  const rowsNow = await listTree()
  const openingParent = rowsNow.find((n) => n.title === 'Opening')?.parentId
  const scene1Row = rowsNow.find((n) => n.title === 'Scene 1' && n.parentId === openingParent)
  if (!scene1Row) throw new Error('Scene 1 row not found')
  await page.keyboard.press('End')
  await page.keyboard.type(' Rain followed.')
  await expect(editor.locator('p')).toHaveText('The storm broke at dusk. Rain followed.')
  await expect
    .poll(() => documentText(scene1Row.id), { timeout: 3000 })
    .toBe('The storm broke at dusk. Rain followed.')
  await page.keyboard.type(' Then silence.')
  // F-3.3: the status bar counts the editor live, before the save lands.
  await expect(page.getByTestId('status-words')).toHaveText(`${SENTENCE_WORDS} words`)
  await expect(page.getByTestId('status-delta')).toHaveText(`+${SENTENCE_WORDS} this session`)
  await page.keyboard.press('Control+s')
  await expect.poll(() => documentText(scene1Row.id), { timeout: 3000 }).toBe(SENTENCE)

  // F-10.3: goals. Every word saved into Scene 1 counts as written today, so the status strip
  // reads the sentence's words; Tools › Goals… sets a daily target of 5, and the strip then
  // shows today against it with a one-day streak. A word target set on Scene 1 from the tree's
  // menu shows on its row as count / target, and Clear word target takes it off again.
  const goalsToday = page.getByTestId('status-goals-today')
  await expect(goalsToday).toHaveText(`Today ${SENTENCE_WORDS}`, { timeout: 5000 })
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'Tools' })
    .click()
  await page.getByRole('menu', { name: 'Tools' }).getByRole('menuitem', { name: 'Goals…' }).click()
  const goalsDialog = page.getByRole('dialog', { name: 'Goals' })
  await expect(goalsDialog.getByTestId('goals-today-words')).toHaveText(
    `${SENTENCE_WORDS} words today`
  )
  await goalsDialog.getByLabel('Daily target (words)').fill('5')
  await goalsDialog.getByRole('button', { name: 'Save' }).click()
  await expect(goalsDialog).toHaveCount(0)
  await expect(goalsToday).toHaveText(`Today ${SENTENCE_WORDS} / 5`)
  await expect(page.getByTestId('status-goals-streak')).toHaveText('1-day streak')
  const scene1Item = page.locator(`[data-node-id="${scene1Row.id}"]`)
  await scene1Item.click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Set word target…' }).click()
  const targetPrompt = page.getByRole('dialog', { name: "Word target for 'Scene 1'" })
  await targetPrompt.getByRole('textbox').fill('2,000')
  await targetPrompt.getByRole('button', { name: 'Set target' }).click()
  await expect(targetPrompt).toHaveCount(0)
  await expect(scene1Item.getByTestId('node-target')).toContainText(
    `${SENTENCE_WORDS} / ${(2000).toLocaleString()}`
  )
  await scene1Item.click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Clear word target' }).click()
  await expect(scene1Item.getByTestId('node-target')).toHaveCount(0)

  // F-10.4: Tools › Word count… counts Scene 1 from the live editor and its chapter and the
  // manuscript from main; Escape closes it.
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'Tools' })
    .click()
  await page
    .getByRole('menu', { name: 'Tools' })
    .getByRole('menuitem', { name: 'Word count…' })
    .click()
  const wordCount = page.getByRole('dialog', { name: 'Word count' })
  await expect(wordCount.getByTestId('word-count-document').getByTestId('words')).toHaveText(
    String(SENTENCE_WORDS)
  )
  await expect(wordCount.getByTestId('word-count-chapter')).toContainText('Chapter 1')
  await expect(wordCount.getByTestId('word-count-manuscript').getByTestId('words')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(wordCount).toHaveCount(0)

  // F-10.5: Tools › Statistics… shows today's words on the writing calendar (Scene 1 was saved
  // with the sentence above) and the manuscript's scenes; Escape closes it.
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'Tools' })
    .click()
  await page
    .getByRole('menu', { name: 'Tools' })
    .getByRole('menuitem', { name: 'Statistics…' })
    .click()
  const statistics = page.getByRole('dialog', { name: 'Statistics' })
  const todayCell = statistics.locator(
    `[data-testid="heat-cell"][data-day="${localDay(new Date())}"]`
  )
  await expect(todayCell).not.toHaveAttribute('data-level', '0')
  await expect(statistics.getByTestId('scene-count')).toContainText(/\d+ scenes?/)
  await page.keyboard.press('Escape')
  await expect(statistics).toHaveCount(0)

  // F-3.12: View › Compiled preview reads the manuscript top to bottom, read-only: chapter
  // headings above their scenes and Scene 1's saved sentence; Scene details hides the scene
  // headers; Escape closes it.
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'View' })
    .click()
  await page
    .getByRole('menu', { name: 'View' })
    .getByRole('menuitem', { name: 'Compiled preview' })
    .click()
  const compiled = page.getByRole('dialog', { name: 'Compiled preview' })
  const compiledText = compiled.getByTestId('compile-preview')
  await expect(compiledText).toContainText(SENTENCE)
  await expect(
    compiledText.locator('[data-testid="compile-heading"][data-level="chapter"]', {
      hasText: 'Chapter 1'
    })
  ).not.toHaveCount(0)
  await expect(compiledText.locator('[contenteditable]')).toHaveCount(0)
  const sceneDetails = compiled.getByRole('checkbox', { name: 'Scene details' })
  await expect(sceneDetails).toBeChecked()
  await sceneDetails.click()
  await expect(sceneDetails).not.toBeChecked()
  await expect(compiledText.getByTestId('compile-scene-meta')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(compiled).toHaveCount(0)

  // F-12.4 (Compile v2, CV3): File › Book details… stores the author the compile prints.
  const menuFile = async (label: string): Promise<void> => {
    await page
      .getByRole('menubar', { name: 'Application menu' })
      .getByRole('menuitem', { name: 'File' })
      .click()
    await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: label }).click()
  }
  await menuFile('Book details…')
  const bookDetails = page.getByRole('dialog', { name: 'Book details' })
  await bookDetails.getByRole('textbox', { name: 'Author (pen name)' }).fill('Ada Marlowe')
  await bookDetails.getByRole('button', { name: 'Save' }).click()
  await expect(bookDetails).toHaveCount(0)

  // F-12.4: File › Compile… opens the compile window (File › Export… is its alias): the built-in
  // formats on the left, the settings tabs, and the live page preview, which lays the smoke
  // novel out in Paged.js pages. Each built-in compiles from the window into the file the
  // (stubbed) save dialog answers; the window closes and a toast names the file.
  const compileWindow = page.getByRole('dialog', { name: 'Compile' })
  const compileFrom = async (
    formatName: string,
    output: 'pdf' | 'docx' | 'epub',
    menu: 'Compile…' | 'Export…' = 'Compile…'
  ): Promise<Buffer> => {
    const file = path.join(tmp, `compile-${output}.${output}`)
    await stubSaveDialog(file)
    await menuFile(menu)
    await expect(compileWindow).toBeVisible()
    await compileWindow
      .getByRole('navigation', { name: 'Formats' })
      .getByRole('button', { name: formatName, exact: true })
      .click()
    await expect(compileWindow.getByTestId('compile-format-name')).toHaveText(formatName)
    await expect(compileWindow.getByRole('combobox', { name: 'Compile for' })).toHaveValue(output)
    await compileWindow.getByRole('button', { name: 'Compile', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: file })).toContainText(
      `Compiled to ${file}`,
      { timeout: 60_000 }
    )
    await expect(compileWindow).toHaveCount(0)
    return fs.readFileSync(file)
  }
  // The preview: the Paperback lays out in pages, the Contents tab lists the include ticks.
  await menuFile('Compile…')
  await compileWindow
    .getByRole('navigation', { name: 'Formats' })
    .getByRole('button', { name: 'Paperback 6 × 9', exact: true })
    .click()
  const preview = compileWindow.getByTestId('compile-window-preview')
  await expect(preview).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  expect(Number(await preview.getAttribute('data-pages'))).toBeGreaterThan(0)
  await expect(preview.contentFrame().locator('body')).toContainText(SENTENCE)
  const includeScene1 = compileWindow.getByRole('checkbox', {
    name: 'Include Scene 1',
    exact: true
  })
  await expect(includeScene1.first()).toBeChecked()
  await expect(compileWindow.getByRole('checkbox', { name: 'Include Front Matter' })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(compileWindow).toHaveCount(0)

  const manuscript = (await compileFrom('Standard Manuscript', 'docx', 'Export…')).toString(
    'latin1'
  )
  expect(manuscript.startsWith('PK')).toBe(true)
  expect(manuscript).toContain('word/document.xml')
  expect(manuscript).toContain('word/header1.xml')
  // The Paperback PDF is laid out by Paged.js: 6 × 9 in pages (432 × 648 pt) with the bundled
  // EB Garamond embedded.
  const paperback = (await compileFrom('Paperback 6 × 9', 'pdf')).toString('latin1')
  expect(paperback.startsWith('%PDF')).toBe(true)
  expect(paperback).toContain('/MediaBox [0 0 432 648]')
  expect(paperback).toMatch(/\/FontName \/[A-Z]{6}\+EBGaramond-Regular/)
  const ebook = (await compileFrom('Ebook', 'epub')).toString('latin1')
  expect(ebook.startsWith('PK')).toBe(true)
  expect(ebook).toContain('mimetypeapplication/epub+zip')
  expect(ebook).toContain('OEBPS/nav.xhtml')
  // The project remembers the last format.
  const compileState = await page.evaluate(() =>
    window.mythscribe.invoke('compileState:get', undefined)
  )
  expect(compileState).toMatchObject({ ok: true, data: { formatId: 'builtin:ebook' } })
  // Put back the stub the project was created with; no step in between relied on another.
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, projectPath)

  // F-3.7: Notes from the toolbar opens a side panel beside the editor with the scene's notes;
  // selecting Chapter 1 swaps in the chapter's own notes and saves the scene's at once. The
  // chapter note is still pending when the project closes, so the close flushes it.
  const chapter1Row = rowsNow.find((n) => n.id === openingParent)
  if (!chapter1Row) throw new Error('Chapter 1 row not found')
  const notesToggle = page.getByRole('button', { name: 'Notes', exact: true })
  await expect(page.getByTestId('notes-panel')).toHaveCount(0)
  await expect(notesToggle).toHaveAttribute('aria-pressed', 'false')
  await notesToggle.click()
  await expect(notesToggle).toHaveAttribute('aria-pressed', 'true')
  const notes = page.getByTestId('notes-panel').getByRole('textbox', { name: 'Notes' })
  await expect(notes).toHaveAttribute('contenteditable', 'true')
  await expect(notes.locator('p')).toHaveText('')
  await notes.click()
  await page.keyboard.type(SCENE_NOTE)
  await expect(notes.locator('p')).toHaveText(SCENE_NOTE)
  await expect(editor.locator('p')).toHaveText(SENTENCE)
  await chapter1.getByText('Chapter 1', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Chapter 1')
  await expect(notes.locator('p')).toHaveText('')
  await expect(notes).toHaveAttribute('contenteditable', 'true')
  await expect.poll(() => notesText(scene1Row.id), { timeout: 3000 }).toBe(SCENE_NOTE)
  await notes.click()
  await page.keyboard.type(CHAPTER_NOTE)
  await expect(notes.locator('p')).toHaveText(CHAPTER_NOTE)
  expect(await notesText(chapter1Row.id)).toBeNull()

  // F-3.11: the project dictionary. Settings → Editor adds a word the spellchecker should accept
  // in this project; it is listed at once and, below, still there after the project is reopened.
  // (No assertion on the red underline: the Hunspell dictionary is downloaded, not bundled.)
  const dictionary = settingsDialog.getByRole('region', { name: 'Project dictionary' })
  const dictionaryWords = dictionary.getByRole('list', { name: 'Dictionary words' })
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(dictionary.getByText('Right-click an underlined word')).toBeVisible()
  await dictionary.getByRole('textbox', { name: 'Word to add' }).fill('Zorvath')
  await dictionary.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dictionaryWords.getByRole('listitem')).toHaveText(['ZorvathRemove'])
  await expect(dictionary.getByRole('textbox', { name: 'Word to add' })).toHaveValue('')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  await page.getByRole('button', { name: 'Close project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()
  await expect(page).toHaveTitle('MythScribe')

  // F-1.1: the welcome screen lists the project; clicking the row reopens it.
  const recents = page.getByRole('list', { name: 'Recent projects' })
  await recents.getByRole('button', { name: 'Smoke Novel', exact: true }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
  const reopened = await page.evaluate<IpcResult<ProjectInfo | null>>(
    () =>
      window.mythscribe.invoke('project:current', undefined) as Promise<
        IpcResult<ProjectInfo | null>
      >
  )
  expect(reopened.ok).toBe(true)
  if (reopened.ok && reopened.data) expect(reopened.data.id).toBe(created.data.id)
  expect(fs.existsSync(path.join(tmp, 'userData', 'app-state.json'))).toBe(true)
  // F-3.11: the dictionary came back with the project; removing the word empties it again.
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(dictionaryWords.getByRole('listitem')).toHaveText(['ZorvathRemove'])
  await dictionary.getByRole('button', { name: 'Remove Zorvath' }).click()
  await expect(dictionaryWords).toHaveCount(0)
  await expect(dictionary.getByText('Right-click an underlined word')).toBeVisible()
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  // F-2.2/F-2.3/F-2.6: the two created scenes, the rename, and the Title Page survived the
  // close; the duplicate was deleted again, so the count is 17 + 3.
  const persisted = await listTree()
  expect(persisted).toHaveLength(20)
  expect(persisted.map((n) => n.title)).toContain('Opening')
  expect(persisted.map((n) => n.title)).not.toContain('Opening (Copy)')
  expect(persisted.filter((n) => n.title === 'Untitled Scene')).toHaveLength(1)
  // F-2.6: the templated document keeps its matter type, title, and cached word count.
  const titlePageRow = persisted.find((n) => n.matterType === 'title-page')
  expect(titlePageRow).toMatchObject({
    title: 'Title Page',
    kind: 'document',
    wordCount: TITLE_PAGE_WORDS,
    parentId: persisted.find((n) => n.sectionType === 'front')?.id
  })
  // F-2.4: the drag survived the close: Opening sits before Scene 1 in Chapter 1.
  const openingRow = persisted.find((n) => n.title === 'Opening')
  if (!openingRow) throw new Error('Opening was not persisted')
  const chapter1Children = persisted
    .filter((n) => n.parentId === openingRow.parentId)
    .sort((a, b) => a.position - b.position)
  expect(chapter1Children.map((n) => n.title)).toEqual(['Opening', 'Scene 1'])
  expect(chapter1Children.map((n) => n.position)).toEqual([0, 1])
  // F-3.2: the text survived the close and the cached word count matches it.
  expect(chapter1Children.map((n) => n.wordCount)).toEqual([0, SENTENCE_WORDS])
  // F-3.7: both notes survived the close: the scene's through the switch away from it, the
  // chapter's through the flush on closing the project.
  expect(await notesText(scene1Row.id)).toBe(SCENE_NOTE)
  expect(await notesText(chapter1Row.id)).toBe(CHAPTER_NOTE)
  await scene1.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  await expect(editor.locator('p')).toHaveText(SENTENCE)
  // F-3.7: the panel stayed open across the reopen and shows the scene's note again.
  await expect(notesToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(notes.locator('p')).toHaveText(SCENE_NOTE)
  // F-3.6: the formatting settings survived the close too.
  await expect(editor).toHaveCSS('font-size', '20px')
  // (The pane binds before 900 px does; F-7.11's desk takes 16 px a side of it, so a wider
  // sidebar or desk gap would leave less than the 700 px this asserts.)
  const persistedColumn = await editor.locator('..').boundingBox()
  if (!persistedColumn) throw new Error('editor column not laid out')
  expect(persistedColumn.width).toBeGreaterThan(700)
  expect(persistedColumn.width).toBeLessThanOrEqual(900)

  // F-4.2: the Tags tab lists the tag created through the bridge (it survived the close and the
  // store loaded it on reopen) under All and under its category, creates one through the form
  // (the color pre-fills from the chosen category), opens its detail view, renames it inline,
  // and deletes it after a confirmation.
  await showSection('Index')
  const tagsPanel = page.getByRole('region', { name: 'Index section', exact: true })
  const categories = tagsPanel.getByRole('tablist', { name: 'Tag categories' })
  await expect(categories.getByRole('tab')).toHaveText([
    'All',
    'Characters',
    'Settings',
    'World Building',
    'Tone',
    'Content',
    'Plot Threads',
    'Custom'
  ])
  const tagRows = tagsPanel.getByRole('list', { name: 'Tags' })
  // F-9.15: a tag with a record also carries "Open record" beside its row; the rows are these.
  const tagRowButtons = tagRows.getByRole('button', { name: / \d+ uses?$/ })
  await expect(tagRowButtons).toHaveText(['dark-forest 0 uses'])
  await expect(
    tagRows.getByRole('button', { name: /^dark-forest/ }).locator('span[aria-hidden]')
  ).toHaveCSS('background-color', 'rgb(234, 88, 12)')
  await categories.getByRole('tab', { name: 'Settings' }).click()
  await expect(tagRowButtons).toHaveText(['dark-forest 0 uses'])
  await categories.getByRole('tab', { name: 'Tone' }).click()
  await expect(tagsPanel.getByText('No tags match.')).toBeVisible()
  const tagForm = tagsPanel.getByRole('form', { name: 'New tag' })
  await expect(tagForm.getByRole('combobox', { name: 'Category' })).toHaveValue('tone')
  await expect(tagForm.getByLabel('Color')).toHaveValue('#2563eb')
  await tagForm.getByRole('textbox', { name: 'Tag name' }).fill('Moody')
  await tagForm.getByRole('button', { name: 'Create tag' }).click()
  await expect(tagRowButtons).toHaveText(['moody 0 uses'])
  await expect(tagForm.getByRole('textbox', { name: 'Tag name' })).toHaveValue('')
  await tagRows.getByRole('button', { name: /^moody/ }).click()
  const tagName = tagsPanel.getByRole('textbox', { name: 'Tag name' })
  await expect(tagName).toHaveValue('moody')
  await expect(tagsPanel.getByLabel('Color')).toHaveValue('#2563eb')
  await expect(tagsPanel.getByText('Used in 0 documents')).toBeVisible()
  await tagName.fill('Melancholy')
  await tagName.press('Enter')
  await expect(tagName).toHaveValue('melancholy')
  await tagsPanel.getByRole('button', { name: 'Delete tag' }).click()
  const deleteTagDialog = page.getByRole('dialog', { name: 'Delete "melancholy"?' })
  await expect(deleteTagDialog).toBeVisible()
  await deleteTagDialog.getByRole('button', { name: 'Delete' }).click()
  await expect(deleteTagDialog).toBeHidden()
  await expect(tagsPanel.getByText('No tags match.')).toBeVisible()
  await categories.getByRole('tab', { name: 'All' }).click()
  await expect(tagRowButtons).toHaveText(['dark-forest 0 uses'])
  // F-4.3: loading a template after the confirm adds its tags (28 for Standard Fiction) and toasts.
  const templates = tagsPanel.getByRole('form', { name: 'Tag templates' })
  await templates
    .getByRole('combobox', { name: 'Template' })
    .selectOption({ label: 'Standard Fiction' })
  await templates.getByRole('button', { name: 'Load' }).click()
  const loadDialog = page.getByRole('dialog', { name: 'Load the Standard Fiction template?' })
  await expect(loadDialog).toBeVisible()
  await loadDialog.getByRole('button', { name: 'Load' }).click()
  await expect(loadDialog).toBeHidden()
  await expect(page.getByRole('status')).toContainText('Added 28 tags')
  await expect(tagRowButtons).toHaveCount(29)
  await expect(tagRows.getByRole('button', { name: /^protagonist/ })).toBeVisible()
  // F-4.11: the bank saved as a custom template joins the list under "Your templates" (app-wide),
  // and the manager deletes it again after a confirm.
  await tagsPanel.getByRole('button', { name: 'Save bank as template…' }).click()
  const saveTemplatePrompt = page.getByRole('dialog', { name: 'Save as tag template' })
  await saveTemplatePrompt.getByRole('textbox').fill('Series bank')
  await saveTemplatePrompt.getByRole('button', { name: 'Save' }).click()
  await expect(saveTemplatePrompt).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toContainText(
    'Saved "Series bank" with 29 tags'
  )
  await expect(templates.getByRole('combobox', { name: 'Template' })).toHaveValue(/^custom:/)
  await tagsPanel.getByRole('button', { name: 'Manage…' }).click()
  const templateManager = page.getByRole('dialog', { name: 'Tag templates' })
  await expect(templateManager.getByRole('listitem', { name: 'Series bank' })).toContainText(
    '29 tags'
  )
  await templateManager.getByRole('button', { name: 'Delete' }).click()
  const deleteTemplateDialog = page.getByRole('dialog', { name: 'Delete "Series bank"?' })
  await deleteTemplateDialog.getByRole('button', { name: 'Delete' }).click()
  await expect(templateManager.getByText('No saved templates.')).toBeVisible()
  await templateManager.getByRole('button', { name: 'Close tag templates' }).click()
  await expect(templateManager).toHaveCount(0)
  await expect(templates.getByRole('combobox', { name: 'Template' })).toHaveValue(
    'builtin:standard-fiction'
  )
  // F-4.9: the bank goes out as a JSON file (all 29 tags) and a hand-written one comes in: the new
  // tag is created, the name already in the bank is skipped. Under Custom, select mode then
  // recolors the imported tag and one made in the form, merges them, and deletes what is left, so
  // the bank is back to the 29 the later steps expect.
  const tagBank = tagsPanel.getByRole('group', { name: 'Tag bank' })
  const bankPath = path.join(tmp, 'tags.json')
  await stubSaveDialog(bankPath)
  await tagBank.getByRole('button', { name: 'Export…' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Exported' })).toContainText(
    'Exported 29 tags to tags.json'
  )
  const bankFile: unknown = JSON.parse(fs.readFileSync(bankPath, 'utf8'))
  expect(bankFile).toMatchObject({ format: 'mythscribe-tags', version: 1 })
  expect(bankFile).toHaveProperty('tags.length', 29)
  const incomingTagsPath = path.join(tmp, 'incoming-tags.json')
  fs.writeFileSync(
    incomingTagsPath,
    JSON.stringify({
      format: 'mythscribe-tags',
      version: 1,
      tags: [
        { name: 'Gloomy', category: 'custom', color: '#123456' },
        { name: 'protagonist', category: 'character', color: '#dc2626' }
      ]
    })
  )
  await stubOpenDialog(incomingTagsPath)
  await tagBank.getByRole('button', { name: 'Import…' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Imported' })).toContainText(
    'Imported 1 tag, skipped 1 already in the bank'
  )
  await categories.getByRole('tab', { name: 'Custom' }).click()
  await expect(tagRowButtons).toHaveText(['gloomy 0 uses'])
  await tagForm.getByRole('textbox', { name: 'Tag name' }).fill('gloom')
  await tagForm.getByRole('button', { name: 'Create tag' }).click()
  await expect(tagRowButtons).toHaveText(['gloom 0 uses', 'gloomy 0 uses'])
  await tagBank.getByRole('button', { name: 'Select' }).click()
  const bulkBar = tagsPanel.getByRole('group', { name: 'Selected tags' })
  await tagRows.getByRole('checkbox', { name: /^gloom 0/ }).check()
  await tagRows.getByRole('checkbox', { name: /^gloomy/ }).check()
  await expect(bulkBar).toContainText('2 selected')
  await bulkBar.getByLabel('Color for selected tags').fill('#ff0000')
  for (const row of await tagRows.getByRole('listitem').all()) {
    await expect(row.locator('span[aria-hidden]')).toHaveCSS('background-color', 'rgb(255, 0, 0)')
  }
  await bulkBar.getByRole('combobox', { name: 'Merge into' }).selectOption({ label: 'gloom' })
  await bulkBar.getByRole('button', { name: 'Merge' }).click()
  const mergeDialog = page.getByRole('dialog', { name: 'Merge 1 tag into "gloom"?' })
  await mergeDialog.getByRole('button', { name: 'Merge' }).click()
  await expect(mergeDialog).toBeHidden()
  await expect(tagRows.getByRole('checkbox')).toHaveCount(1)
  await expect(tagRows.getByRole('checkbox', { name: /^gloom 0/ })).toBeChecked()
  await bulkBar.getByRole('button', { name: 'Delete' }).click()
  const bulkDeleteDialog = page.getByRole('dialog', { name: 'Delete 1 tag?' })
  await bulkDeleteDialog.getByRole('button', { name: 'Delete' }).click()
  await expect(bulkDeleteDialog).toBeHidden()
  await expect(tagsPanel.getByText('No tags match.')).toBeVisible()
  await bulkBar.getByRole('button', { name: 'Done' }).click()
  await categories.getByRole('tab', { name: 'All' }).click()
  await expect(tagRowButtons).toHaveCount(29)

  // F-9.4: Scene 1 gains a sentence naming Mara, so the character created next has somewhere to
  // appear; it is taken out again once her page has shown it, so the text the later steps assert
  // is the one they were written for.
  await caretToEnd(editor)
  await page.keyboard.type(MARA_SENTENCE)
  await expect
    .poll(() => documentText(scene1Row.id), { timeout: 5000 })
    .toBe(`${SENTENCE}${MARA_SENTENCE}`)

  // F-9.2: the Characters tab starts empty; quick-add creates a character (structured template)
  // that appears as a card and is selected, the search hides and shows it, the list view drops
  // the card border, and Delete asks first and then removes it, so the tab says the kind is
  // empty again (the empty-kind message wins over the search's "no match").
  await showSection('Characters')
  const charactersPanel = page.getByRole('region', { name: 'Characters section', exact: true })
  await expect(charactersPanel.getByText('No characters yet.')).toBeVisible()
  const characterForm = charactersPanel.getByRole('form', { name: 'New character' })
  await characterForm.getByRole('textbox', { name: 'Character name' }).fill('Mara')
  await characterForm.getByRole('button', { name: 'Add' }).click()
  const characterRows = charactersPanel.getByRole('list', { name: 'Characters' })
  const maraRow = characterRows.getByRole('button', { name: 'Mara', exact: true })
  await expect(maraRow).toHaveAttribute('aria-current', 'true')
  await expect(characterForm.getByRole('textbox', { name: 'Character name' })).toHaveValue('')
  // F-3.14: her name is a word the spellchecker accepts from now on, without the author adding
  // it to the project dictionary. (As with F-3.11, no assertion on the underline itself: the
  // Hunspell dictionary is downloaded, not bundled.)
  await expect.poll(spellcheckerWords).toContain('Mara')
  const characterSearch = charactersPanel.getByRole('searchbox', { name: 'Search characters' })
  await characterSearch.fill('zed')
  await expect(charactersPanel.getByText('No characters match.')).toBeVisible()
  await characterSearch.fill('mar')
  await expect(maraRow).toBeVisible()
  await charactersPanel.getByRole('button', { name: 'List' }).click()
  await expect(charactersPanel.getByRole('button', { name: 'List' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  // F-9.3: the selected character is open as a full page in the main pane (the scene's title
  // block is gone): the structured fields autosave, the stubbed open dialog uploads a 1×1 PNG
  // into `assets/entities/` and the page shows it through the asset scheme, Blank page switches
  // the template and keeps the fields, a rename follows in the list, and the stored entity
  // carries all of it. Close brings Scene 1 back; a tree click does the same. "New character…"
  // opens the creation dialog, whose Blank page choice opens the new character on its page.
  const entityEditor = page.getByTestId('entity-editor')
  await expect(entityEditor).toBeVisible()
  await expect(page.getByTestId('selected-title')).toHaveCount(0)
  const entityName = entityEditor.getByRole('textbox', { name: 'Name' })
  await expect(entityName).toHaveValue('Mara')
  await entityEditor.getByRole('textbox', { name: 'Age' }).fill('31')
  await entityEditor
    .getByRole('textbox', { name: 'Appearance' })
    .fill('Tall, with a scar over one eye.')
  await expect(entityEditor.getByRole('status')).toHaveText('Saved')
  const entityImageSource = path.join(tmp, 'portrait.png')
  fs.writeFileSync(entityImageSource, Buffer.from(PNG_1X1_BASE64, 'base64'))
  await stubOpenDialog(entityImageSource)
  const entityImagesDir = path.join(projectPath, 'assets', 'entities')
  await entityEditor.getByRole('button', { name: 'Add image…' }).click()
  const entityImage = entityEditor.locator('img')
  await expect(entityImage).toHaveAttribute('src', /^mythscribe-asset:\/\/entities\/portrait\./)
  const [entityImageFile, ...otherEntityFiles] = fs.readdirSync(entityImagesDir)
  expect(otherEntityFiles).toEqual([])
  expect(entityImageFile).toMatch(/^portrait\.[0-9a-f]{8}\.png$/)
  const entityImageWidth = await page.evaluate(async (src) => {
    const img = new Image()
    img.src = src
    await img.decode()
    return img.naturalWidth
  }, `mythscribe-asset://entities/${entityImageFile}`)
  expect(entityImageWidth).toBe(1)
  await expect(entityEditor.getByRole('button', { name: 'Replace image…' })).toBeVisible()
  const templateGroup = entityEditor.getByRole('group', { name: 'Template' })
  await templateGroup.getByRole('button', { name: 'Blank page' }).click()
  await expect(templateGroup.getByRole('button', { name: 'Blank page' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await entityEditor.getByRole('textbox', { name: 'Page' }).fill('She keeps the lighthouse.')
  await expect(entityEditor.getByRole('status')).toHaveText('Saved')
  await templateGroup.getByRole('button', { name: 'Structured' }).click()
  await expect(entityEditor.getByRole('textbox', { name: 'Age' })).toHaveValue('31')

  // F-9.4: creating the character created her tag (a character tag of her kebab-cased name), and
  // her page lists where it appears: Scene 1 mentions her once. The row jumps into the scene with
  // her name selected, which closes the page; the sentence has done its work and is removed, so
  // Scene 1 reads as it did before. Reopening her row brings the page back for the rename.
  const entityTag = entityEditor.getByRole('group', { name: 'Tag' })
  await expect(entityTag).toContainText('#mara')
  await expect(entityTag.locator('span[aria-hidden]').first()).toHaveCSS(
    'background-color',
    'rgb(220, 38, 38)'
  )
  expect((await listTags()).find((tag) => tag.name === 'mara')).toMatchObject({
    category: 'character'
  })
  // F-11.2c: a character's page lists them in its Appearances log (the F-9.4 rows, POV added).
  const entityScenes = entityEditor.getByRole('list', { name: 'Appearances' })
  await expect(entityScenes.getByRole('button')).toHaveText([/^Scene 1.*×1$/], { timeout: 15_000 })
  await entityScenes.getByRole('button', { name: /^Scene 1/ }).click()
  await expect(entityEditor).toHaveCount(0)
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('Mara')
  // The click puts the caret back in the editor's one paragraph, so End lands after the sentence
  // the step added (a jump alone leaves the selection on the name).
  // Retried until the selection is really collapsed: a click that lands while the jump is still
  // settling leaves the name selected, and the Backspaces would then eat the wrong text.
  await expect(async () => {
    await editor.click()
    await page.keyboard.press('End')
    // Held for a moment before it is trusted: the jump can select the name once more after a
    // check that passed, and the caret must sit at the very end of the paragraph's text.
    await page.waitForTimeout(300)
    expect(
      await page.evaluate(() => {
        const selection = window.getSelection()
        const node = selection?.anchorNode
        return (
          selection?.isCollapsed === true &&
          node?.nodeType === Node.TEXT_NODE &&
          selection.anchorOffset === (node.textContent ?? '').length &&
          node.nextSibling === null
        )
      })
    ).toBe(true)
  }).toPass({ timeout: 10_000 })
  for (const _character of MARA_SENTENCE) await page.keyboard.press('Backspace')
  await expect.poll(() => documentText(scene1Row.id), { timeout: 5000 }).toBe(SENTENCE)
  await maraRow.click()
  await expect(entityEditor).toBeVisible()

  await entityName.fill('Mara Vell')
  await entityName.press('Tab')
  const maraVellRow = characterRows.getByRole('button', { name: 'Mara Vell', exact: true })
  await expect(maraVellRow).toHaveAttribute('aria-current', 'true')
  await expect(entityEditor.getByRole('status')).toHaveText('Saved')
  // F-9.4: the rename carried her tag with it, in the bank and on the page.
  await expect(entityTag).toContainText('#mara-vell')
  await expect.poll(async () => (await listTags()).map((tag) => tag.name)).toContain('mara-vell')
  // F-3.14: the rename taught the spellchecker the new word of her name.
  await expect.poll(spellcheckerWords).toEqual(expect.arrayContaining(['Mara', 'Vell']))
  const storedMara = (await listEntities()).find((entity) => entity.name === 'Mara Vell')
  expect(storedMara).toMatchObject({
    kind: 'character',
    template: 'structured',
    fields: { age: '31', appearance: 'Tall, with a scar over one eye.' },
    body: 'She keeps the lighthouse.',
    image: entityImageFile
  })
  await entityEditor.getByRole('button', { name: 'Close Mara Vell' }).click()
  await expect(entityEditor).toHaveCount(0)
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect(maraVellRow).not.toHaveAttribute('aria-current', 'true')
  await charactersPanel.getByRole('button', { name: 'New character…' }).click()
  const newCharacterDialog = page.getByRole('dialog', { name: 'New character' })
  await expect(newCharacterDialog).toBeVisible()
  await expect(newCharacterDialog.getByRole('textbox', { name: 'Name' })).toBeFocused()
  await newCharacterDialog.getByRole('textbox', { name: 'Name' }).fill('Tomas')
  // The radio is visually hidden, like the wizard's format cards; the tile label is what the
  // author clicks.
  await newCharacterDialog.getByText('Blank page', { exact: true }).click()
  await expect(newCharacterDialog.getByRole('radio', { name: 'Blank page' })).toBeChecked()
  await newCharacterDialog.getByRole('button', { name: 'Create' }).click()
  await expect(newCharacterDialog).toHaveCount(0)
  await expect(entityEditor).toBeVisible()
  await expect(entityName).toHaveValue('Tomas')
  await expect(entityEditor.getByRole('textbox', { name: 'Page' })).toBeVisible()
  // Unqualified, "Age" matches "Page" too (a case-insensitive substring of the accessible name).
  await expect(entityEditor.getByRole('textbox', { name: 'Age', exact: true })).toHaveCount(0)
  await characterSearch.fill('')
  const tomasRow = characterRows.getByRole('button', { name: 'Tomas', exact: true })
  await expect(tomasRow).toHaveAttribute('aria-current', 'true')
  await showSection('Manuscript')
  await scene1.click()
  await expect(entityEditor).toHaveCount(0)
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await showSection('Characters')
  await expect(tomasRow).not.toHaveAttribute('aria-current', 'true')

  // F-9.6: the quick reference panel. Pinning Tomas from his page opens the panel with his card;
  // Mara Vell's card joins below it with her filled fields, Move up puts her first, and the
  // project's stored pins follow. The order and the open panel survive a close and reopen. Both
  // are then unpinned and the panel closed, so the steps below run on the layout they expect
  // (the reopen dropped the selection and the list view, which are put back).
  const referencesPanel = page.getByTestId('references-panel')
  // Scoped to the pins: since F-9.7 the panel also lists the open scene's entities above them.
  const referenceTitles = referencesPanel
    .getByRole('list', { name: 'Pinned references' })
    .getByRole('heading', { level: 3 })
  await expect(referencesPanel).toHaveCount(0)
  await tomasRow.click()
  await expect(entityName).toHaveValue('Tomas')
  await entityEditor.getByRole('button', { name: 'Pin to References' }).click()
  await expect(referencesPanel).toBeVisible()
  await expect(referenceTitles).toHaveText(['Tomas'])
  await expect(entityEditor.getByRole('button', { name: 'Unpin from References' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await maraVellRow.click()
  await expect(entityName).toHaveValue('Mara Vell')
  await entityEditor.getByRole('button', { name: 'Pin to References' }).click()
  await expect(referenceTitles).toHaveText(['Tomas', 'Mara Vell'])
  const maraCard = referencesPanel.getByRole('listitem').filter({ hasText: 'Mara Vell' })
  await expect(maraCard).toContainText('Tall, with a scar over one eye.')
  await maraCard.getByRole('button', { name: 'Move up' }).click()
  await expect(referenceTitles).toHaveText(['Mara Vell', 'Tomas'])
  const tomasId = (await listEntities()).find((entity) => entity.name === 'Tomas')?.id
  const pinnedOrder = [
    { type: 'entity', id: storedMara?.id },
    { type: 'entity', id: tomasId }
  ]
  await expect.poll(referencePins).toEqual(pinnedOrder)
  await closeProject()
  await recents.getByRole('button', { name: 'Smoke Novel', exact: true }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
  await expect(referencesPanel).toBeVisible()
  await expect(referenceTitles).toHaveText(['Mara Vell', 'Tomas'])
  expect(await referencePins()).toEqual(pinnedOrder)
  await referencesPanel.getByRole('button', { name: 'Unpin Tomas' }).click()
  await referencesPanel.getByRole('button', { name: 'Unpin Mara Vell' }).click()
  await expect(referencesPanel.getByText('Nothing pinned yet.')).toBeVisible()
  await expect.poll(referencePins).toEqual([])
  await page.getByRole('button', { name: 'References', exact: true }).click()
  await expect(referencesPanel).toHaveCount(0)
  await expect.poll(async () => (await getLayout()).references.open).toBe(false)
  await showSection('Manuscript')
  await scene1.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await showSection('Characters')
  await charactersPanel.getByRole('button', { name: 'List' }).click()
  await expect(tomasRow).toBeVisible()
  await expect(tomasRow).not.toHaveAttribute('aria-current', 'true')

  // F-10.1: global search. Ctrl+Shift+F opens the dialog on its query box; a phrase of Scene 1,
  // typed in another case, lists the scene with the phrase marked, and Enter opens it with the
  // phrase selected. With the Documents chip off, the character's name lists her entity row,
  // and a click opens her page. Her page is then closed, so Scene 1 is back for the steps below.
  const searchDialog = page.getByRole('dialog', { name: 'Search project' })
  const searchBox = searchDialog.getByRole('searchbox', { name: 'Search the project' })
  await expect(searchDialog).toHaveCount(0)
  await page.keyboard.press('Control+Shift+F')
  await expect(searchDialog).toBeVisible()
  await expect(searchBox).toBeFocused()
  await expect(searchDialog.getByRole('status')).toHaveText('Type at least 2 characters.')
  await searchBox.fill('STORM BROKE')
  const documentHits = searchDialog.getByTestId('search-result-document')
  await expect(documentHits).toHaveCount(1)
  await expect(documentHits).toContainText('Scene 1')
  await expect(documentHits.locator('mark')).toHaveText(['storm broke'])
  await expect(documentHits).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(searchDialog).toHaveCount(0)
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe('storm broke')
  // The jump leaves the phrase selected; the caret goes back to the end before anything types
  // (retried until the selection is really collapsed, see Known gotchas).
  await expect(async () => {
    await editor.click()
    await page.keyboard.press('Control+End')
    expect(await page.evaluate(() => window.getSelection()?.isCollapsed ?? false)).toBe(true)
  }).toPass({ timeout: 10_000 })
  await page.keyboard.press('Control+Shift+F')
  await expect(searchBox).toBeFocused()
  await expect(searchBox).toHaveValue('STORM BROKE')
  await searchBox.fill('mara vell')
  const documentsChip = searchDialog.getByRole('button', { name: 'Documents', exact: true })
  await documentsChip.click()
  await expect(documentsChip).toHaveAttribute('aria-pressed', 'false')
  await expect(documentHits).toHaveCount(0)
  const characterHit = searchDialog.getByTestId('search-result-character')
  await expect(characterHit).toHaveCount(1)
  await expect(characterHit.locator('mark').first()).toHaveText('Mara Vell')
  await characterHit.click()
  await expect(searchDialog).toHaveCount(0)
  await expect(entityEditor).toBeVisible()
  await expect(entityName).toHaveValue('Mara Vell')
  await entityEditor.getByRole('button', { name: 'Close Mara Vell' }).click()
  await expect(entityEditor).toHaveCount(0)
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect(maraVellRow).not.toHaveAttribute('aria-current', 'true')
  expect(await documentText(scene1Row.id)).toBe(SENTENCE)

  // F-10.2: project-wide find and replace. Ctrl+Shift+H opens the dialog on its Find box;
  // narrowed to the selected Scene 1, "storm" → "squall" previews one document with the change
  // struck through and inserted; after the confirm the open editor and the stored document both
  // read the new word, and Undo last replace puts the original back in both, so Scene 1 is
  // exactly as the steps below expect.
  const replaceDialog = page.getByRole('dialog', { name: 'Replace in project' })
  await expect(replaceDialog).toHaveCount(0)
  await page.keyboard.press('Control+Shift+H')
  await expect(replaceDialog).toBeVisible()
  const findBox = replaceDialog.getByRole('textbox', { name: 'Find' })
  await expect(findBox).toBeFocused()
  await findBox.fill('storm')
  await replaceDialog.getByRole('textbox', { name: 'Replace with' }).fill('squall')
  await replaceDialog.getByRole('radio', { name: 'Only Scene 1' }).check()
  const replaceGroups = replaceDialog.getByTestId('replace-document')
  await expect(replaceGroups).toHaveCount(1)
  await expect(replaceGroups).toContainText('Scene 1')
  await expect(replaceGroups).toContainText('1 occurrence')
  await expect(replaceGroups.locator('del')).toHaveText(['storm'])
  await expect(replaceGroups.locator('ins')).toHaveText(['squall'])
  expect(await documentText(scene1Row.id)).toBe(SENTENCE)
  await replaceDialog.getByRole('button', { name: 'Replace 1 occurrence in 1 document' }).click()
  await page
    .getByRole('dialog', { name: 'Replace across documents' })
    .getByRole('button', { name: 'Replace', exact: true })
    .click()
  const REPLACED_SENTENCE = SENTENCE.replace('storm', 'squall')
  await expect(editor).toContainText('The squall broke at dusk.')
  await expect.poll(() => documentText(scene1Row.id), { timeout: 5000 }).toBe(REPLACED_SENTENCE)
  await replaceDialog.getByRole('button', { name: 'Undo last replace' }).click()
  await expect(editor).toContainText('The storm broke at dusk.')
  await expect.poll(() => documentText(scene1Row.id), { timeout: 5000 }).toBe(SENTENCE)
  await expect(replaceDialog.getByRole('button', { name: 'Undo last replace' })).toHaveCount(0)
  await replaceDialog.getByRole('button', { name: 'Close replace' }).click()
  await expect(replaceDialog).toHaveCount(0)
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')

  // F-3.10: find and replace in the open document. Ctrl+F opens the bar on its Find box; "the"
  // highlights "The" and the start of "Then" in Scene 1, and Enter moves to the other match
  // (which one is first depends on where the caret was, so only the change is asserted). Ctrl+H
  // adds the replace row; Replace all rewrites both in the editor, Escape closes the bar and gives
  // the editor the focus back, and one Ctrl+Z undoes the whole replace, so Scene 1 is exactly as
  // the steps below expect.
  const findBar = page.getByRole('search', { name: 'Find in document' })
  await expect(findBar).toHaveCount(0)
  await page.keyboard.press('Control+F')
  await expect(findBar).toBeVisible()
  const findInput = findBar.getByRole('textbox', { name: 'Find' })
  await expect(findInput).toBeFocused()
  await findInput.fill('the')
  const findStatus = findBar.getByTestId('find-status')
  await expect(findStatus).toHaveText(/^[12] of 2$/)
  await expect(editor.locator('.find-match')).toHaveCount(2)
  await expect(editor.locator('.find-match-current')).toHaveCount(1)
  const firstStatus = await findStatus.textContent()
  await page.keyboard.press('Enter')
  await expect(findStatus).toHaveText(firstStatus === '1 of 2' ? '2 of 2' : '1 of 2')
  await page.keyboard.press('Control+H')
  const replaceInput = findBar.getByRole('textbox', { name: 'Replace with' })
  await expect(replaceInput).toBeVisible()
  await replaceInput.fill('Thy')
  await findBar.getByRole('button', { name: 'Replace all' }).click()
  await expect(findStatus).toHaveText('Replaced 2')
  await expect(editor).toContainText('Thy storm broke at dusk. Rain followed. Thyn silence.')
  await expect(editor.locator('.find-match')).toHaveCount(0)
  await replaceInput.press('Escape')
  await expect(findBar).toHaveCount(0)
  await expect(editor).toBeFocused()
  await page.keyboard.press('Control+Z')
  await expect(editor).toContainText(SENTENCE)
  await expect.poll(() => documentText(scene1Row.id), { timeout: 5000 }).toBe(SENTENCE)

  await tomasRow.hover()
  await characterRows.getByRole('button', { name: 'Delete Tomas' }).click()
  await page
    .getByRole('dialog', { name: 'Delete "Tomas"?' })
    .getByRole('button', { name: 'Delete' })
    .click()
  await expect(tomasRow).toHaveCount(0)

  // F-9.5: export and import. The tab's More menu writes the Characters as a JSON library where
  // the (stubbed) save dialog points — Mara Vell as she stands, with no image and no tag id in the
  // file. A hand-written library of one new character and one Mara Vell with a field she does not
  // have is then imported: the review dialog offers the new one as Add and Mara as Fill in blanks,
  // and after Import her background is filled while the age she already had is untouched.
  const libraryPath = path.join(tmp, 'characters.json')
  await stubSaveDialog(libraryPath)
  await charactersPanel.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Export as JSON…' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Exported' })).toContainText(
    'Exported 1 character to characters.json'
  )
  const exported: unknown = JSON.parse(fs.readFileSync(libraryPath, 'utf8'))
  expect(exported).toEqual({
    format: 'mythscribe-entities',
    version: 1,
    entities: [
      {
        kind: 'character',
        name: 'Mara Vell',
        template: 'structured',
        fields: { age: '31', appearance: 'Tall, with a scar over one eye.' },
        body: 'She keeps the lighthouse.'
      }
    ]
  })
  const incomingPath = path.join(tmp, 'incoming.json')
  fs.writeFileSync(
    incomingPath,
    JSON.stringify({
      format: 'mythscribe-entities',
      version: 1,
      entities: [
        { kind: 'character', name: 'Ilse', fields: { age: '30' } },
        { kind: 'character', name: 'mara vell', fields: { age: '99', background: 'Born at sea.' } }
      ]
    })
  )
  await stubOpenDialog(incomingPath)
  await charactersPanel.getByRole('button', { name: 'More' }).click()
  await page.getByRole('menuitem', { name: 'Import…' }).click()
  const entityImport = page.getByTestId('entity-import-dialog')
  await expect(entityImport).toBeVisible()
  await expect(entityImport).toContainText('Import “incoming.json”')
  await expect(entityImport.getByTestId('entity-import-item')).toHaveCount(2)
  await expect(entityImport.getByRole('combobox', { name: 'Action for Ilse' })).toHaveValue('add')
  const maraAction = entityImport.getByRole('combobox', { name: 'Action for mara vell' })
  await expect(maraAction).toHaveValue('merge')
  await expect(entityImport).toContainText('Existing: Mara Vell')
  await entityImport.getByTestId('entity-import-commit').click()
  await expect(entityImport).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Imported' })).toContainText(
    'Imported 2 entities (1 added, 1 merged, 0 replaced)'
  )
  const ilseRow = characterRows.getByRole('button', { name: 'Ilse', exact: true })
  await expect(ilseRow).toBeVisible()
  const importedMara = (await listEntities()).find((entity) => entity.name === 'Mara Vell')
  // Fill in blanks filled the empty field and left the one she already had alone.
  expect(importedMara?.fields).toMatchObject({ age: '31', background: 'Born at sea.' })
  await ilseRow.hover()
  await characterRows.getByRole('button', { name: 'Delete Ilse' }).click()
  await page
    .getByRole('dialog', { name: 'Delete "Ilse"?' })
    .getByRole('button', { name: 'Delete' })
    .click()
  await expect(ilseRow).toHaveCount(0)

  await maraVellRow.hover()
  await characterRows.getByRole('button', { name: 'Delete Mara Vell' }).click()
  const deleteCharacterDialog = page.getByRole('dialog', { name: 'Delete "Mara Vell"?' })
  await expect(deleteCharacterDialog).toBeVisible()
  await deleteCharacterDialog.getByRole('button', { name: 'Delete' }).click()
  await expect(deleteCharacterDialog).toBeHidden()
  await expect(charactersPanel.getByText('No characters yet.')).toBeVisible()
  // F-9.3: deleting the character deleted its image file too.
  expect(fs.readdirSync(entityImagesDir)).toEqual([])
  // F-9.4: their tags are tags of the bank like any other, so they outlive the entities.
  const tagsAfterEntities = (await listTags()).map((tag) => tag.name)
  expect(tagsAfterEntities).toContain('mara-vell')
  expect(tagsAfterEntities).toContain('tomas')
  // F-3.14: the deleted characters' names left the spellchecker with them; what it still accepts
  // is the tags that outlived them, spelled the way a tag is.
  await expect
    .poll(async () => {
      const words = await spellcheckerWords()
      return ['Mara', 'Vell', 'Tomas', 'Ilse'].filter((word) => words.includes(word))
    })
    .toEqual([])
  expect(await spellcheckerWords()).toEqual(expect.arrayContaining(['mara', 'vell', 'tomas']))
  await showSection('Manuscript')
  await expect(sectionPicker).toHaveAccessibleName('Section: Manuscript')
  await expect(tree).toBeVisible()

  // F-4.4: the tags column (it replaced the tag bar above the editor on 2026-10-06) opens from
  // the header's Tags button and starts without chips for Scene 1; "Add tag" opens a picker of
  // the unassigned tags, searching "forest" narrows it to dark-forest (the template's plain
  // "dark" tone tag would also match "dark"), Enter links it as a chip, and the Tags tab shows
  // the usage at once; removing the chip returns it to 0. Closing the column hides it and the
  // state persists in the layout.
  await expect(scene1).toHaveAttribute('aria-selected', 'true')
  const tagsToggle = page.getByRole('banner').getByRole('button', { name: 'Tags', exact: true })
  const tagBar = page.getByRole('region', { name: 'Tags', exact: true })
  /**
   * Opens the tags column unless it is open: another panel opening beside four open ones closes
   * it first, so the editor keeps its 30 % (`normalizeLayout`).
   */
  const showTags = async (): Promise<void> => {
    if ((await tagsToggle.getAttribute('aria-pressed')) !== 'true') await tagsToggle.click()
    await expect(tagBar).toBeVisible()
  }
  await expect(tagsToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(tagBar).toHaveCount(0)
  await tagsToggle.click()
  await expect(tagsToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(tagBar).toBeVisible()
  await expect(tagBar.getByRole('listitem')).toHaveCount(0)
  await tagBar.getByRole('button', { name: 'Add tag' }).click()
  const tagSearch = page.getByRole('searchbox', { name: 'Search tags' })
  await expect(tagSearch).toBeFocused()
  await tagSearch.fill('forest')
  await expect(
    page.getByRole('listbox', { name: 'Unassigned tags' }).getByRole('option')
  ).toHaveText(['dark-forest'])
  await tagSearch.press('Enter')
  await expect(tagBar.getByRole('listitem')).toHaveText(['dark-forest'])
  await expect(tagSearch).toHaveCount(0)

  // F-4.10: the tag's detail view lists the documents carrying it (Scene 1, under Chapter 1) and
  // "Show in tree" hands the Manuscript tab the same filter: the select shows dark-forest, the
  // count line reads one, and only Scene 1 and its ancestors remain in the tree. Clear filter
  // brings the whole tree back. (The Tags tab remounts on its list view when it is next shown.)
  await showSection('Index')
  await tagRows.getByRole('button', { name: /^dark-forest/ }).click()
  const taggedDocuments = tagsPanel.getByRole('list', { name: 'Documents with this tag' })
  await expect(taggedDocuments.getByRole('button')).toHaveText(['Scene 1Chapter 1'])
  await tagsPanel.getByRole('button', { name: 'Show in tree' }).click()
  await expect(sectionPicker).toHaveAccessibleName('Section: Manuscript')
  const tagFilter = page.getByRole('combobox', { name: 'Filter by tag' })
  await expect(tagFilter.locator('option:checked')).toHaveText('dark-forest')
  await expect(page.getByText('1 document carries #dark-forest')).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'Scene 1', exact: true })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'Opening', exact: true })).toHaveCount(0)
  await expect(tree.getByRole('treeitem', { name: 'Arc 2', exact: true })).toHaveCount(0)
  await expect(tree.getByRole('treeitem', { name: 'Front Matter', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear filter' }).click()
  await expect(tagFilter.locator('option:checked')).toHaveText('All documents')
  await expect(tree.getByRole('treeitem', { name: 'Arc 2', exact: true })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'Front Matter', exact: true })).toBeVisible()
  await showSection('Index')
  await expect(tagRows.getByRole('button', { name: /^dark-forest/ })).toHaveText(
    'dark-forest 1 use'
  )
  await showSection('Manuscript')
  await tagBar.getByRole('button', { name: 'Remove dark-forest' }).click()
  await expect(tagBar.getByRole('listitem')).toHaveCount(0)
  await showSection('Index')
  await expect(tagRows.getByRole('button', { name: /^dark-forest/ })).toHaveText(
    'dark-forest 0 uses'
  )
  await showSection('Manuscript')
  await tagsToggle.click()
  await expect(tagsToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(tagBar).toHaveCount(0)
  await expect.poll(async () => (await getLayout()).tags.open, { timeout: 3000 }).toBe(false)
  await tagsToggle.click()
  await expect(tagBar.getByRole('button', { name: 'Add tag' })).toBeVisible()
  await expect.poll(async () => (await getLayout()).tags.open, { timeout: 3000 }).toBe(true)

  // F-4.5: the scene's details sit in the notes column, collapsed under the notes; the synopsis
  // is the box at its top. Location autocompletes from the setting tags (typing "dark" offers
  // dark-forest, Enter fills it in), POV and the timeline position are free text. Showing
  // another scene flushes the edits and coming back reloads them from disk.
  const notesColumn = page.getByTestId('notes-panel')
  const detailsToggle = notesColumn.getByRole('button', { name: 'Scene details' })
  /** Opens the Scene details disclosure unless it is open (since F-1.7 the project remembers it). */
  const showSceneDetails = async (): Promise<void> => {
    if ((await detailsToggle.getAttribute('aria-expanded')) !== 'true') await detailsToggle.click()
    await expect(detailsToggle).toHaveAttribute('aria-expanded', 'true')
  }
  await expect(detailsToggle).toHaveAttribute('aria-expanded', 'false')
  await showSceneDetails()
  const metadata = notesColumn.getByRole('group', { name: 'Scene metadata' })
  await expect(metadata.getByRole('textbox', { name: 'Synopsis' })).toHaveCount(0)
  const location = metadata.getByRole('combobox', { name: 'Location' })
  await expect(location).toBeEnabled()
  await location.fill('dark')
  await expect(
    metadata.getByRole('listbox', { name: 'Location suggestions' }).getByRole('option')
  ).toHaveText(['dark-forest'])
  await location.press('Enter')
  await expect(location).toHaveValue('dark-forest')
  await metadata.getByRole('combobox', { name: 'POV' }).fill('Mara')
  await metadata.getByRole('combobox', { name: 'Timeline' }).fill('Day 3, after the storm')
  await opening.getByText('Opening', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Opening')
  await expect(metadata.getByRole('combobox', { name: 'Location' })).toHaveValue('')
  await scene1.getByText('Scene 1', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect(metadata.getByRole('combobox', { name: 'Location' })).toHaveValue('dark-forest')
  await expect(metadata.getByRole('combobox', { name: 'POV' })).toHaveValue('Mara')
  await expect(metadata.getByRole('combobox', { name: 'Timeline' })).toHaveValue(
    'Day 3, after the storm'
  )
  // The synopsis box at the top of the notes column saves to the scene's metadata.
  const synopsisBox = notesColumn.getByRole('textbox', { name: 'Synopsis' })
  await expect(synopsisBox).toBeEnabled()
  await synopsisBox.fill('Mara reaches the forest.')
  await expect
    .poll(async () => (await sceneMetaOf(scene1Row.id)).synopsis, { timeout: 3000 })
    .toBe('Mara reaches the forest.')
  await synopsisBox.fill('')
  await expect
    .poll(async () => (await sceneMetaOf(scene1Row.id)).synopsis, { timeout: 3000 })
    .toBe('')

  // F-2.5/F-3.8: selecting Chapter 1 stacks Opening and Scene 1 in tree order, each as its own
  // region with the web-novel scene break between them; typing into Opening leaves Scene 1
  // untouched and autosaves under Opening's own id.
  await chapter1.getByText('Chapter 1', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Chapter 1')
  // The tags column is a region too; the document regions are the sections.
  const regions = page.locator('section[aria-label]')
  await expect(regions).toHaveCount(2)
  await expect(regions.nth(0)).toHaveAttribute('aria-label', 'Opening')
  await expect(regions.nth(1)).toHaveAttribute('aria-label', 'Scene 1')
  await expect(page.getByRole('separator', { name: 'Scene break' })).toHaveText('~~~')
  const openingBox = regions.nth(0).getByRole('textbox', { name: 'Document' })
  const scene1Box = regions.nth(1).getByRole('textbox', { name: 'Document' })
  await expect(scene1Box.locator('p')).toHaveText(SENTENCE)
  await expect(openingBox).toHaveAttribute('contenteditable', 'true')
  await openingBox.click()
  await page.keyboard.type('Before the storm.')
  await expect(openingBox.locator('p')).toHaveText('Before the storm.')
  await expect(scene1Box.locator('p')).toHaveText(SENTENCE)
  await expect.poll(() => documentText(openingRow.id), { timeout: 3000 }).toBe('Before the storm.')
  expect(await documentText(scene1Row.id)).toBe(SENTENCE)
  // F-3.3: the folder's status bar shows the combined saved count and no session delta.
  await expect(page.getByTestId('status-words')).toHaveText(`${SENTENCE_WORDS + 3} words`)
  await expect(page.getByTestId('status-delta')).toHaveCount(0)

  // F-11.1: the cork board. The folder view switch turns Chapter 1 into index cards of its
  // scenes in tree order; a synopsis typed on Opening's card and its status save to Opening's
  // own metadata. Dragging Scene 1's card onto the left half of Opening's reorders the
  // Manuscript tree at once, and Alt+ArrowLeft on Opening's card (focused title) moves it back.
  // The synopsis is still there after a round trip through the stacked view.
  const folderView = page.getByRole('group', { name: 'Folder view' })
  await folderView.getByRole('button', { name: 'Cork board' }).click()
  const corkBoard = page.getByRole('list', { name: 'Cork board' })
  const cards = corkBoard.getByRole('listitem')
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0)).toHaveAttribute('aria-label', 'Opening')
  await expect(cards.nth(1)).toHaveAttribute('aria-label', 'Scene 1')
  const openingCard = corkBoard.getByRole('listitem', { name: 'Opening', exact: true })
  const scene1Card = corkBoard.getByRole('listitem', { name: 'Scene 1', exact: true })
  await expect(openingCard.getByTestId('card-words')).toHaveText('3 words')
  const cardSynopsis = openingCard.getByRole('textbox', { name: 'Synopsis' })
  await expect(cardSynopsis).toBeEnabled()
  await cardSynopsis.fill('Kael watches the sky darken.')
  await openingCard.getByRole('combobox', { name: 'Status' }).selectOption('draft')
  await expect(openingCard.getByTestId('card-status-stripe')).toHaveClass(/bg-status-draft/)
  await expect
    .poll(
      async () => {
        const meta = await sceneMetaOf(openingRow.id)
        return { synopsis: meta.synopsis, status: meta.status }
      },
      { timeout: 3000 }
    )
    .toEqual({ synopsis: 'Kael watches the sky darken.', status: 'draft' })
  const openingCardBox = await openingCard.boundingBox()
  if (!openingCardBox) throw new Error('the Opening card has no box')
  await scene1Card
    .getByRole('button', { name: 'Scene 1', exact: true })
    .dragTo(openingCard, { targetPosition: { x: 8, y: openingCardBox.height / 2 } })
  await expect(chapter1.getByRole('treeitem')).toHaveText([/^Scene 1/, /^Opening/])
  await expect(cards.nth(0)).toHaveAttribute('aria-label', 'Scene 1')
  await expect(corkBoard.locator('[data-drop]')).toHaveCount(0)
  await openingCard.getByRole('button', { name: 'Opening', exact: true }).focus()
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(chapter1.getByRole('treeitem')).toHaveText([/^Opening/, /^Scene 1/])
  await expect(cards.nth(0)).toHaveAttribute('aria-label', 'Opening')
  await folderView.getByRole('button', { name: 'Stacked' }).click()
  await expect(corkBoard).toHaveCount(0)
  await expect(regions).toHaveCount(2)
  await folderView.getByRole('button', { name: 'Cork board' }).click()
  await expect(cardSynopsis).toHaveValue('Kael watches the sky darken.')
  await expect(openingCard.getByRole('combobox', { name: 'Status' })).toHaveValue('draft')
  await folderView.getByRole('button', { name: 'Stacked' }).click()
  await expect(regions).toHaveCount(2)

  // F-11.1b: structure templates. In the Outline tab, choosing Save the Cat adds a Beat picker to
  // the metadata pane; Opening (opened from its outline row) goes on Catalyst, which saves to its
  // own metadata under the template's id. The Beats view lists Opening under Catalyst, marks the
  // empty beats, and counts one of fifteen filled. Back to the outline, no template, and the
  // Manuscript tab so the later steps find the tree as they left it.
  await showSection('Outline')
  const outlinePanel = page.getByRole('region', { name: 'Outline section', exact: true })
  const structureSelect = outlinePanel.getByRole('combobox', { name: 'Structure' })
  await expect(structureSelect).toBeEnabled()
  await structureSelect.selectOption({ label: 'Save the Cat' })
  const outlineView = outlinePanel.getByRole('group', { name: 'Outline view' })
  await expect(outlineView.getByRole('button', { name: 'Outline' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await outlinePanel.getByRole('button', { name: 'Opening', exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Opening')
  await showSceneDetails()
  const beatSelect = metadata.getByRole('combobox', { name: 'Beat' })
  await expect(beatSelect).toBeEnabled()
  await beatSelect.selectOption({ label: 'Catalyst' })
  await expect
    .poll(async () => (await sceneMetaOf(openingRow.id)).beats, { timeout: 3000 })
    .toEqual({ saveTheCat: 'catalyst' })
  await outlineView.getByRole('button', { name: 'Beats' }).click()
  await expect(outlinePanel.getByTestId('beat-counts')).toHaveText('1 of 15 beats filled')
  const catalystBeat = outlinePanel.locator('[data-testid="beat"][data-beat="catalyst"]')
  await expect(catalystBeat.getByRole('button')).toHaveText(['Opening'])
  await expect(catalystBeat).toHaveAttribute('data-empty', 'false')
  const openingImageBeat = outlinePanel.locator('[data-testid="beat"][data-beat="opening-image"]')
  await expect(openingImageBeat).toHaveAttribute('data-empty', 'true')
  await expect(openingImageBeat.getByText('Empty beat')).toBeVisible()
  await outlineView.getByRole('button', { name: 'Outline' }).click()
  await expect(outlinePanel.getByTestId('beat')).toHaveCount(0)

  // F-11.1c: plot threads. Opening gets the template's main-plot from its tag bar; the Threads
  // view lists main-plot as the one used thread column, Opening's cell filled and Scene 1's
  // empty, the other plot threads named as unused. Removing the chip empties the grid again.
  await tagBar.getByRole('button', { name: 'Add tag' }).click()
  await tagSearch.fill('main-plot')
  await expect(
    page.getByRole('listbox', { name: 'Unassigned tags' }).getByRole('option')
  ).toHaveText(['main-plot'])
  await tagSearch.press('Enter')
  await expect(tagBar.getByRole('listitem')).toContainText(['main-plot'])
  await outlineView.getByRole('button', { name: 'Threads' }).click()
  const threadTable = outlinePanel.getByRole('table', { name: 'Plot threads' })
  await expect(threadTable.getByRole('columnheader')).toHaveText(['Scene', 'main-plot'])
  const threadRow = (title: string): Locator =>
    threadTable
      .getByTestId('thread-row')
      .filter({ has: page.getByRole('button', { name: title, exact: true }) })
  await expect(threadRow('Opening').locator('td')).toHaveAttribute('data-state', 'on')
  await expect(threadRow('Scene 1').first().locator('td')).toHaveAttribute('data-state', 'off')
  await expect(outlinePanel.getByTestId('thread-summary')).toHaveText([
    '#main-plot 1 scene, 0 gaps'
  ])
  await expect(outlinePanel.getByTestId('thread-unused')).toContainText('#subplot')
  await tagBar.getByRole('button', { name: 'Remove main-plot' }).click()
  await expect(outlinePanel.getByTestId('thread-counts')).toHaveText(
    'No scene carries a plot thread yet.'
  )
  await outlineView.getByRole('button', { name: 'Outline' }).click()

  await structureSelect.selectOption({ label: 'None' })
  await expect(outlineView.getByRole('button', { name: 'Beats' })).toHaveCount(0)
  await expect(beatSelect).toHaveCount(0)

  // F-11.2: the timeline. The Timeline tab adds two events; Opening (still selected) goes on
  // "Spring: The siege begins" from the metadata pane's Timeline picker, which links it. Renaming
  // the event in the tab rewrites Opening's text in the open pane and on disk; the Reading order
  // view lists Opening on the event. Deleting both events keeps Opening's text and drops the
  // link; clearing the field leaves the scene as it was, and the Manuscript tab comes back.
  await showSection('Timeline')
  const timelinePanel = page.getByRole('region', { name: 'Timeline section', exact: true })
  await expect(timelinePanel.getByText('No events yet.')).toBeVisible()
  const addEventForm = timelinePanel.getByRole('form', { name: 'Add event' })
  const timelineEvents = timelinePanel.getByTestId('timeline-event')
  await addEventForm.getByLabel('Event', { exact: true }).fill('The siege begins')
  await addEventForm.getByLabel('When', { exact: true }).fill('Spring')
  await addEventForm.getByLabel('Year', { exact: true }).fill('1200')
  await addEventForm.getByRole('button', { name: 'Add event' }).click()
  await expect(timelineEvents).toHaveCount(1)
  await addEventForm.getByLabel('Event', { exact: true }).fill('The fall')
  await addEventForm.getByRole('button', { name: 'Add event' }).click()
  await expect(timelineEvents).toHaveCount(2)
  await expect(timelineEvents.nth(0)).toHaveAttribute('aria-label', 'The siege begins')
  await expect(timelineEvents.nth(1)).toHaveAttribute('aria-label', 'The fall')
  await showSceneDetails()
  const timelineField = metadata.getByRole('combobox', { name: 'Timeline' })
  await expect(timelineField).toBeEnabled()
  await timelineField.fill('Spr')
  await metadata
    .getByRole('listbox', { name: 'Timeline suggestions' })
    .getByRole('option', { name: 'Spring: The siege begins' })
    .click()
  await expect(timelineField).toHaveValue('Spring: The siege begins')
  await expect
    .poll(
      async () => {
        const meta = await sceneMetaOf(openingRow.id)
        return { timeline: meta.timeline, linked: typeof meta.eventId === 'string' }
      },
      { timeout: 3000 }
    )
    .toEqual({ timeline: 'Spring: The siege begins', linked: true })
  const siegeEvent = timelineEvents.filter({ hasText: 'The siege begins' })
  await expect(siegeEvent.getByRole('button', { name: 'Opening', exact: true })).toBeVisible()
  await expect(timelinePanel.getByTestId('timeline-unplaced')).toContainText('Not on the timeline:')
  await timelinePanel.getByRole('button', { name: 'Edit The siege begins' }).click()
  const editEventForm = timelinePanel.getByRole('form', { name: 'Edit event' })
  await editEventForm.getByLabel('Event', { exact: true }).fill('The siege')
  await editEventForm.getByRole('button', { name: 'Save' }).click()
  await expect(editEventForm).toHaveCount(0)
  await expect(timelineField).toHaveValue('Spring: The siege')
  await expect
    .poll(async () => (await sceneMetaOf(openingRow.id)).timeline, { timeout: 3000 })
    .toBe('Spring: The siege')
  const timelineView = timelinePanel.getByRole('group', { name: 'Timeline view' })
  await timelineView.getByRole('button', { name: 'Reading order' }).click()
  const openingTimelineRow = timelinePanel
    .getByTestId('timeline-row')
    .filter({ has: page.getByRole('button', { name: 'Opening', exact: true }) })
  await expect(openingTimelineRow).toContainText('The siege')
  await timelineView.getByRole('button', { name: 'Events' }).click()

  // F-11.2b: character ages. Rowan, born 1170, is 30 at the siege (year 1200): her page's "Age on
  // the timeline" says so. Named as Opening's POV, she is listed on the siege's card with her age.
  // The POV is cleared and Rowan deleted again, so the later steps see the characters they expect.
  await showSection('Characters')
  await charactersPanel.getByRole('button', { name: 'New character…' }).click()
  const rowanDialog = page.getByRole('dialog', { name: 'New character' })
  await rowanDialog.getByRole('textbox', { name: 'Name' }).fill('Rowan')
  await rowanDialog.getByRole('button', { name: 'Create' }).click()
  await expect(rowanDialog).toHaveCount(0)
  await expect(entityName).toHaveValue('Rowan')
  await entityEditor.getByRole('textbox', { name: 'Born (story year)' }).fill('1170')
  const ageOnTimeline = entityEditor.getByRole('region', { name: 'Age on the timeline' })
  await expect(ageOnTimeline.getByRole('listitem')).toHaveText([/The siege.*Year 1200.*age 30/])
  await entityEditor.getByRole('button', { name: 'Close Rowan' }).click()
  await expect(entityEditor).toHaveCount(0)
  await expect(page.getByTestId('selected-title')).toHaveText('Opening')
  await showSceneDetails()
  const openingPov = metadata.getByRole('combobox', { name: 'POV' })
  await openingPov.fill('Rowan')
  await showSection('Timeline')
  await expect(
    timelineEvents.filter({ hasText: 'The siege' }).getByTestId('event-ages')
  ).toHaveText('Ages: Rowan 30')
  // F-11.2c: as Opening's POV, Rowan appears in Opening; her page's Appearances log says so, and
  // in story order lists it under the siege. (The location conflict is covered by unit tests.)
  await showSection('Characters')
  await characterRows.getByRole('button', { name: 'Rowan', exact: true }).click()
  await expect(entityName).toHaveValue('Rowan')
  const appearances = entityEditor.getByRole('region', { name: 'Appearances' })
  await expect(appearances.getByRole('listitem')).toHaveText([/Opening.*POV/])
  await entityEditor.getByRole('button', { name: 'Story order' }).click()
  await expect(
    appearances.getByRole('list', { name: 'Appearances: The siege' }).getByRole('listitem')
  ).toHaveText([/Opening/])
  await entityEditor.getByRole('button', { name: 'Close Rowan' }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Opening')
  await openingPov.fill('')
  await expect.poll(async () => (await sceneMetaOf(openingRow.id)).pov, { timeout: 3000 }).toBe('')
  await showSection('Characters')
  const rowanRow = characterRows.getByRole('button', { name: 'Rowan', exact: true })
  await rowanRow.hover()
  await characterRows.getByRole('button', { name: 'Delete Rowan' }).click()
  const deleteRowanDialog = page.getByRole('dialog', { name: 'Delete "Rowan"?' })
  await deleteRowanDialog.getByRole('button', { name: 'Delete' }).click()
  await expect(deleteRowanDialog).toBeHidden()
  await expect(charactersPanel.getByText('No characters yet.')).toBeVisible()
  await showSection('Timeline')
  for (const label of ['The siege', 'The fall']) {
    await timelinePanel.getByRole('button', { name: `Delete ${label}` }).click()
    const deleteEventDialog = page.getByRole('dialog', { name: `Delete "${label}"?` })
    await deleteEventDialog.getByRole('button', { name: 'Delete' }).click()
    await expect(deleteEventDialog).toBeHidden()
  }
  await expect(timelinePanel.getByText('No events yet.')).toBeVisible()
  await expect(timelineField).toHaveValue('Spring: The siege')
  await expect
    .poll(async () => (await sceneMetaOf(openingRow.id)).eventId, { timeout: 3000 })
    .toBeUndefined()
  await timelineField.fill('')
  await expect
    .poll(async () => (await sceneMetaOf(openingRow.id)).timeline, { timeout: 3000 })
    .toBe('')
  await showSection('Manuscript')

  // F-4.6: inline tags. Back in Scene 1, `#` at the end of the text opens a suggestion list at
  // the caret, filtered by what follows it (the template's "dark" tone tag and dark-forest);
  // ArrowDown and Tab insert the highlighted tag as a token colored from the bank, followed by
  // a plain space, and link it, so its chip returns and the Inline tags list counts it. Text
  // that names no tag offers to create one: `#stormfront` becomes a custom tag, listed under
  // Custom with its one use. Each token counts as one word (F-3.3). Right-click on a token
  // opens that tag in the Tag Manager, or removes the token alone: its chip stays.
  await scene1.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect(editor.locator('p')).toHaveText(SENTENCE)
  await clickIntoEditor(editor)
  await page.keyboard.press('End')
  await page.keyboard.type(' #dark')
  const suggestions = page.getByRole('listbox', { name: 'Tag suggestions' })
  await expect(suggestions.getByRole('option')).toHaveText(['dark', 'dark-forest'])
  await page.keyboard.press('ArrowDown')
  await expect(suggestions.getByRole('option', { selected: true })).toHaveText('dark-forest')
  await page.keyboard.press('Tab')
  await expect(suggestions).toHaveCount(0)
  const tokens = editor.locator('[data-inline-tag]')
  await expect(tokens).toHaveText(['#dark-forest'])
  expect(await tokens.first().evaluate((el) => el.style.getPropertyValue('--tag-color'))).toBe(
    '#ea580c'
  )
  const chipList = tagBar.getByRole('list', { name: 'Document tags' })
  const inlineList = tagBar.getByRole('list', { name: 'Inline tags' })
  await expect(chipList.getByRole('listitem')).toHaveText(['dark-forest'])
  await expect(inlineList.getByRole('listitem')).toHaveText(['dark-forest ×1'])
  await page.keyboard.type('and #stormfront')
  await expect(suggestions.getByRole('option')).toHaveText(['Create #stormfront'])
  await page.keyboard.press('Tab')
  await expect(tokens).toHaveText(['#dark-forest', '#stormfront'])
  await expect(inlineList.getByRole('listitem')).toHaveText(['dark-forest ×1', 'stormfront ×1'])
  await expect(chipList.getByRole('listitem')).toHaveText(['dark-forest', 'stormfront'])
  await expect(page.getByTestId('status-words')).toHaveText(`${SENTENCE_WORDS + 3} words`)
  await showSection('Index')
  await categories.getByRole('tab', { name: 'Custom' }).click()
  await expect(tagRowButtons).toHaveText(['stormfront 1 use'])
  await showSection('Manuscript')
  await tokens.first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open in Tag Manager' }).click()
  await expect(sectionPicker).toHaveAccessibleName('Section: Index')
  await expect(tagsPanel.getByRole('textbox', { name: 'Tag name' })).toHaveValue('dark-forest')
  await showSection('Manuscript')
  await tokens.last().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Remove' }).click()
  await expect(tokens).toHaveText(['#dark-forest'])
  await expect(inlineList.getByRole('listitem')).toHaveText(['dark-forest ×1'])
  await expect(chipList.getByRole('listitem')).toHaveText(['dark-forest', 'stormfront'])
  await expect(page.getByTestId('status-words')).toHaveText(`${SENTENCE_WORDS + 2} words`)

  // F-4.8: granular tags. "storm" selected in Scene 1 and right-clicked offers Tag selection…,
  // whose picker puts dark-forest on just that word: a range span under the word with the
  // tag's colour as a line, and a gutter bar on its paragraph. It is stored in the document, so
  // it survives a save and a switch to Opening and back; Clear tags in selection takes it off
  // again and leaves the link (the chips are unchanged).
  const tagRanges = editor.locator('[data-tag-range]')
  // The selection is set on the DOM (ProseMirror reads it back): arrow keys stepping across the
  // range's spans after the reload lost presses once. Focus, not a click: ProseMirror writes its
  // own selection back to the DOM shortly after a click's mouseup.
  const selectStorm = async (): Promise<void> => {
    await editor.focus()
    await page.evaluate(() => {
      const root = document.querySelector('[role="textbox"][aria-label="Document"]')
      if (!root) throw new Error('no editor')
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf('storm') ?? -1
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + 'storm'.length)
        window.getSelection()?.removeAllRanges()
        window.getSelection()?.addRange(range)
        return
      }
      throw new Error('no "storm" in the editor')
    })
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toBe('storm')
  }
  const rightClickSelection = async (): Promise<void> => {
    const box = await page.evaluate(() => {
      const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect()
      return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null
    })
    if (!box) throw new Error('no selection to right-click')
    await page.mouse.click(box.x, box.y, { button: 'right' })
  }
  await selectStorm()
  await rightClickSelection()
  await page.getByRole('menuitem', { name: 'Tag selection…' }).click()
  const rangePicker = page.getByRole('group', { name: 'Tag selection' })
  await rangePicker.getByRole('option', { name: 'dark-forest' }).click()
  await expect(rangePicker).toHaveCount(0)
  await expect(tagRanges).toHaveText(['storm'])
  await expect(editor.locator('p').first()).toHaveClass(/tag-range-block/)
  expect(
    await editor
      .locator('.tag-range-run')
      .first()
      .evaluate((el) => el.style.backgroundImage)
  ).toContain('rgb(234, 88, 12)')
  await page.keyboard.press('Control+s')
  await expect.poll(() => savedTagRanges(scene1Row.id), { timeout: 3000 }).toHaveLength(1)
  await opening.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Opening')
  await scene1.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect(tagRanges).toHaveText(['storm'])
  await selectStorm()
  await rightClickSelection()
  await page.getByRole('menuitem', { name: 'Clear tags in selection' }).click()
  await expect(tagRanges).toHaveCount(0)
  await expect(editor.locator('p').first()).not.toHaveClass(/tag-range-block/)
  await page.keyboard.press('Control+s')
  await expect.poll(() => savedTagRanges(scene1Row.id), { timeout: 3000 }).toEqual([])
  await expect(chipList.getByRole('listitem')).toHaveText(['dark-forest', 'stormfront'])

  // F-4.12: automatic mentions. A character tag created through the bridge is found in the
  // text once the save and the scan's debounce have run: the tag bar's Mentions list counts it
  // apart from the chips (nothing is linked, nothing is inserted), Jump selects the word, the
  // Tag Manager's detail shows the document with a jump of its own, and Track mentions off
  // drops the rows at once (on again rescans). None of the template's tag names appear in
  // Scene 1 as plain words, so the list holds exactly the one row.
  await showSection('Index')
  await categories.getByRole('tab', { name: 'Characters' }).click()
  const roseForm = tagsPanel.getByRole('form', { name: 'New tag' })
  await roseForm.getByRole('textbox', { name: 'Tag name' }).fill('Rose')
  await roseForm.getByRole('button', { name: 'Create tag' }).click()
  await expect(tagRows.getByRole('button', { name: /^rose/ })).toHaveText('rose 0 uses')
  await showSection('Manuscript')
  await clickIntoEditor(editor)
  await page.keyboard.press('End')
  await page.keyboard.type(' Rose waited.')
  const mentionList = tagBar.getByRole('list', { name: 'Mentions' })
  await expect(mentionList.getByRole('listitem')).toHaveText(['rose ×1'], { timeout: 15_000 })
  await expect(chipList.getByRole('listitem')).toHaveText(['dark-forest', 'stormfront'])
  await expect(tokens).toHaveText(['#dark-forest'])
  await tagBar.getByRole('button', { name: 'Jump to first mention of rose' }).click()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('Rose')
  // A click collapses the selection, so the detail view's jump is seen to select it again.
  await editor.click()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
  await showSection('Index')
  await categories.getByRole('tab', { name: 'Characters' }).click()
  await tagRows.getByRole('button', { name: /^rose/ }).click()
  await expect(tagsPanel.getByRole('textbox', { name: 'Tag name' })).toHaveValue('rose')
  // F-9.12: the new character tag arrived with its record, a Characters sheet named Rose.
  await expect(tagsPanel.getByRole('button', { name: 'Open record' })).toBeVisible()
  const roseRecord = (await listEntities()).find((entity) => entity.name === 'Rose')
  expect(roseRecord).toMatchObject({ kind: 'character', origin: 'author' })
  await expect(tagsPanel.getByText('Used in 0 documents')).toBeVisible()
  await expect(tagsPanel.getByText('Mentioned in 1 document')).toBeVisible()
  const mentionDocs = tagsPanel.getByRole('list', { name: 'Documents mentioning this tag' })
  await expect(mentionDocs.getByRole('button')).toHaveText(['Scene 1 ×1'])
  await mentionDocs.getByRole('button', { name: /^Scene 1/ }).click()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('Rose')
  const trackMentions = tagsPanel.getByRole('checkbox', { name: 'Track mentions' })
  await trackMentions.uncheck()
  await expect(tagsPanel.getByText('Not mentioned')).toBeVisible()
  await expect(mentionDocs).toHaveCount(0)
  await expect(mentionList).toHaveCount(0)
  await trackMentions.check()
  await expect(tagsPanel.getByText('Mentioned in 1 document')).toBeVisible({ timeout: 15_000 })
  await expect(mentionList.getByRole('listitem')).toHaveText(['rose ×1'])
  await showSection('Manuscript')

  // F-4.12b: proposed tags. A capitalised name the manuscript keeps using mid-sentence that no
  // tag stands for is proposed in the bar of the document that carries it, with its count.
  // Create tag makes it a character tag — which is what the F-4.12 scan then finds — and
  // Dismiss keeps the name out for good, though the text still holds it and every later save
  // scans it again. Nothing is created or hidden until one of the two is clicked.
  await caretToEnd(editor)
  await page.keyboard.type(' But Tash saw Tash, then Tash.')
  const proposedList = tagBar.getByRole('list', { name: 'Proposed tags' })
  await expect(proposedList.getByRole('listitem')).toHaveText(['Tash ×3'], { timeout: 15_000 })
  await proposedList.getByRole('button', { name: 'Create tag Tash' }).click()
  await expect(proposedList).toHaveCount(0)
  await expect(mentionList.getByRole('listitem')).toHaveText(['rose ×1', 'tash ×3'], {
    timeout: 15_000
  })
  await showSection('Index')
  await categories.getByRole('tab', { name: 'Characters' }).click()
  await expect(tagRows.getByRole('button', { name: /^tash/ })).toHaveText('tash 0 uses')
  await showSection('Manuscript')
  await caretToEnd(editor)
  await page.keyboard.type(' But Bren saw Bren, then Bren.')
  await expect(proposedList.getByRole('listitem')).toHaveText(['Bren ×3'], { timeout: 15_000 })
  await proposedList.getByRole('button', { name: 'Dismiss Bren' }).click()
  await expect(proposedList).toHaveCount(0)
  // A third name proposed after the dismissal is what proves the scan ran again and still
  // leaves Bren out; a plain "the list is empty" could have passed before the scan.
  await caretToEnd(editor)
  await page.keyboard.type(' But Kael saw Kael, then Kael.')
  await expect(proposedList.getByRole('listitem')).toHaveText(['Kael ×3'], { timeout: 15_000 })

  // F-4.14: aliases and misspellings. An alias added on the tag's detail counts as a mention
  // of the tag in the prose; a close misspelling of the name is offered as a fix in the tags
  // column, and only the author's Fix changes the text.
  await showSection('Index')
  await categories.getByRole('tab', { name: 'Characters' }).click()
  await tagRows.getByRole('button', { name: /^tash/ }).click()
  const aliasGroup = tagsPanel.getByRole('group', { name: 'Aliases' })
  await aliasGroup.getByRole('textbox', { name: 'Add alias' }).fill('The Smith')
  await aliasGroup.getByRole('textbox', { name: 'Add alias' }).press('Enter')
  await expect(aliasGroup.getByRole('listitem')).toHaveText(['The Smith'])
  await showSection('Manuscript')
  await caretToEnd(editor)
  await page.keyboard.type(' The Smith nodded. Then Taash left.')
  await expect(mentionList.getByRole('listitem')).toHaveText(['tash ×4', 'rose ×1'], {
    timeout: 15_000
  })
  const misspellings = tagBar.getByRole('list', { name: 'Possible misspellings' })
  const taash = misspellings.getByRole('listitem').filter({ hasText: 'Taash → Tash' })
  await expect(taash).toHaveCount(1, { timeout: 15_000 })
  await expect(editor).toContainText('Then Taash left.')
  await taash.getByRole('button', { name: 'Fix Taash to Tash' }).click()
  await expect(editor).toContainText('Then Tash left.')
  await expect(taash).toHaveCount(0)
  await page.keyboard.press('Control+s')
  await expect(mentionList.getByRole('listitem')).toHaveText(['tash ×5', 'rose ×1'], {
    timeout: 15_000
  })

  // F-9.12: Dark Forest (F-4.1), Rose, and Tash arrived with records when their tags were made.
  // The steps below count the story bible and the scene's cast as they stood before records
  // existed, so the three records are deleted here (their tags stay); the reopen below reloads
  // every store.
  for (const [name, kind] of [
    ['Dark Forest', 'setting'],
    ['Rose', 'character'],
    ['Tash', 'character']
  ] as const) {
    const record = (await listEntities()).find((entity) => entity.name === name)
    expect(record).toMatchObject({ kind, origin: 'author' })
    const removed = await page.evaluate(
      (id) => window.mythscribe.invoke('entity:delete', { id }) as Promise<IpcResult<null>>,
      record?.id ?? ''
    )
    expect(removed.ok).toBe(true)
  }

  // F-1.4: the native open dialog (stubbed like the save dialog) opens project.db.
  await closeProject()
  await stubOpenDialog(path.join(projectPath, 'project.db'))
  await page.getByRole('button', { name: 'Open project' }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
  // F-4.6: the token survived the close as stored JSON and is counted again from it.
  await scene1.click()
  await expect(tokens).toHaveText(['#dark-forest'])
  await expect(inlineList.getByRole('listitem')).toHaveText(['dark-forest ×1'])

  // F-4.7: Recommend. Scene 1 already carries more than 50 characters; a sentence typed now
  // is flushed by the click, so the request sends the live text. With the dial at Off the
  // request is refused before anything leaves and the reason and next step show inline. At
  // Ask, with the key saved again, the fake server names dark-forest (linked, so filtered)
  // and protagonist; accepting the one chip links it, and the Usage block shows one request.
  const recommend = tagBar.getByRole('button', { name: 'Recommend' })
  await clickIntoEditor(editor)
  await page.keyboard.press('End')
  await page.keyboard.type(' The river she had to cross was rising fast.')
  await expect(recommend).toBeEnabled()
  const requestsBefore = openAiRequests.length
  await recommend.click()
  const recommendResult = tagBar.getByTestId('tag-recommend-result')
  await expect(recommendResult).toHaveText(
    'Tag suggestions needs Use AI turned on (it is off). Turn on Use AI in Settings › AI, or enable the feature there.'
  )
  expect(openAiRequests).toHaveLength(requestsBefore)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await useAi.check()
  await expect.poll(async () => (await aiSettings()).dial).toBe(1)
  // F-5.6: summaries would otherwise run in the background after every save from here on
  // and disturb the exact request counts below; the summary step turns them back on.
  const summaryToggle = settingsDialog.getByRole('checkbox', { name: /^Scene summaries/ })
  await expect(summaryToggle).toBeEnabled()
  await summaryToggle.uncheck()
  await expect.poll(async () => (await aiSettings()).features.summary).toBe(false)
  // F-11.1d: the plan-link job runs after summaries; its own step turns it on for a moment.
  const planLinksToggle = settingsDialog.getByRole('checkbox', { name: /^Plan links/ })
  await planLinksToggle.uncheck()
  await expect.poll(async () => (await aiSettings()).features.planLinks).toBe(false)
  await keyField.fill(ACCEPTED_KEY)
  await settingsDialog.getByRole('button', { name: 'Save' }).click()
  await expect(keyHint).toHaveText('Key saved: sk-…wxyz')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await recommend.click()
  const suggestedList = tagBar.getByRole('list', { name: 'Suggested tags' })
  await expect(suggestedList.getByRole('listitem')).toHaveText(['protagonist'])
  await expect(recommendResult).toHaveCount(0)
  // F-5.9: the line names the model, the cost, and the tokens the request spent.
  await expect(tagBar.getByTestId('tag-recommend-cost')).toHaveText(
    'gpt-5.4-mini · $0.0004 · 400 in · 12 out'
  )
  expect(openAiRequests.at(-1)).toEqual({
    url: '/v1/chat/completions',
    auth: `Bearer ${ACCEPTED_KEY}`
  })
  await expect(chipList.getByRole('listitem')).toHaveText(['dark-forest', 'stormfront'])
  // F-14.5: Regenerate… asks what was off; the note reaches the model in the system turn of
  // a second request (the fake server answers it with a different set), the chips follow, and
  // nothing was linked by asking. Accepting one chip and dismissing the rest settles that
  // second proposal as accepted in part (one click, no note).
  await tagBar.getByRole('button', { name: 'Regenerate…' }).click()
  const regenDialog = page.getByRole('dialog', { name: "What's off about these?" })
  await regenDialog.getByRole('textbox', { name: "What's off about these?" }).fill(REGEN_NOTE)
  await regenDialog.getByRole('button', { name: 'Regenerate' }).click()
  await expect(regenDialog).toHaveCount(0)
  await expect(suggestedList.getByRole('listitem')).toHaveText(['antagonist', 'protagonist'])
  const regenSystem = openAiChatBodies.at(-1)?.messages.find((m) => m.role === 'system')
  expect(regenSystem?.content).toContain(TAGS_REGEN_SENTINEL)
  expect(regenSystem?.content).toContain(`"${REGEN_NOTE}"`)
  await expect(chipList.getByRole('listitem')).toHaveText(['dark-forest', 'stormfront'])
  await tagBar.getByRole('button', { name: 'Accept protagonist' }).click()
  await expect(chipList.getByRole('listitem')).toHaveText([
    'dark-forest',
    'stormfront',
    'protagonist'
  ])
  await expect(suggestedList.getByRole('listitem')).toHaveText(['antagonist'])
  // Exactly "Dismiss": a proposed tag's row (F-4.12b) carries a "Dismiss <name>" button too.
  await tagBar.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(suggestedList).toHaveCount(0)
  await showSection('Index')
  await categories.getByRole('tab', { name: 'All' }).click()
  await expect(tagRows.getByRole('button', { name: /^protagonist/ })).toHaveText(
    'protagonist 1 use'
  )
  await showSection('Manuscript')
  const spent = await usageSummary()
  expect(spent.total).toMatchObject({ requests: 2, tokens: 824 })
  expect(spent.total.costUsd).toBeGreaterThan(0)
  expect(spent.byFeature).toEqual([{ feature: 'tags', ...spent.total }])
  // F-5.9: this run of the app counted the same requests, and the newest is the tag one.
  expect(spent.session.requests).toBeGreaterThanOrEqual(1)
  expect(spent.recent[0]).toMatchObject({ feature: 'tags', cached: false })
  expect(
    (spent.recent[0]?.promptTokens ?? 0) + (spent.recent[0]?.completionTokens ?? 0)
  ).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await expect(usageTotal).toHaveText('<$0.01 · 2 requests · 824 tokens')

  // F-14.1: the voice profile. The AI tab's Voice section starts with no exemplars. Back in
  // Scene 1, selecting the whole text and marking it stores a plain-text snapshot with Scene
  // 1's POV and toasts the count; the section then lists it and reports the words the profile
  // was built from. The ghost-text request below carries the profile in its system turn.
  const voiceSection = settingsDialog.getByTestId('voice-section')
  await expect(voiceSection.getByTestId('voice-words')).toContainText('0 of 12 marked exemplars')
  // F-14.14: what was learned automatically has its own block; this short manuscript is under
  // the 2,000 words the style notes wait for, so it says when they will come.
  await expect(voiceSection.getByTestId('voice-notes')).toContainText(
    'What MythScribe has learned about your style'
  )
  await expect(voiceSection.getByTestId('voice-notes')).toContainText('Nothing yet.')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  // 2026-10-06: the toolbar's Mark voice exemplar button is gone (all AI lives in the assistant;
  // the voice job picks exemplars, F-14.14); the channel still takes a hand-marked passage.
  await expect(page.getByRole('button', { name: 'Mark voice exemplar' })).toHaveCount(0)
  const marked = await page.evaluate(
    ({ nodeId, text }) =>
      window.mythscribe.invoke('voice:addExemplar', { nodeId, text }) as Promise<
        IpcResult<{ id: string }>
      >,
    { nodeId: scene1Row.id, text: (await documentText(scene1Row.id)) ?? '' }
  )
  expect(marked.ok).toBe(true)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  // The voice job's automatic picks (F-14.14), if any, are listed too; the hand-marked one is
  // the only row without "Picked automatically".
  const exemplarRows = voiceSection
    .getByRole('list', { name: 'Voice exemplars' })
    .getByRole('listitem')
    .filter({ hasNotText: 'Picked automatically' })
  await expect(exemplarRows).toHaveCount(1)
  await expect(exemplarRows.first()).toContainText('Mixed · POV Mara')
  await expect(exemplarRows.first()).toContainText('The storm broke at dusk. Rain followed.')
  await expect(voiceSection.getByTestId('voice-words')).toContainText(
    /Built from [1-9]\d* words of manuscript, 1 of 12 marked exemplars/
  )

  // F-5.3: VibeWrite. Ask allows ghost text; the idle delay drops to 0.5 s in the AI tab
  // and lands in the settings table. The toolbar toggle arms the mode (persisted per project).
  // Typing into Scene 1 and pausing brings the fake server's continuation as ghost text at the
  // caret (a widget, not document text); Tab accepts it into the document and the ledger gains
  // a ghostText request. A second suggestion is dismissed with Escape and inserts nothing.
  // The mode is turned off again before the dial and the key are restored below.
  await useAi.check()
  await expect.poll(async () => (await aiSettings()).dial).toBe(1)
  const idleDelay = settingsDialog.getByLabel('Ghost text idle delay (s)', { exact: true })
  await expect(idleDelay).toHaveValue('1.5')
  await idleDelay.fill('0.5')
  await idleDelay.blur()
  await expect(idleDelay).toHaveValue('0.5')
  await expect.poll(async () => (await aiSettings()).ghostText.idleMs).toBe(500)
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  // F-14.7: enough third-person past narration for the profile to resolve tense and person
  // (five markers each) and cross the 200-word gate; saved before any ghost-text request
  // leaves, since main builds the profile from the stored rows.
  await caretToEnd(editor)
  for (let i = 0; i < 5; i++) await page.keyboard.type(VOICE_PARAGRAPH)
  await expect
    .poll(async () => ((await documentText(scene1Row.id)) ?? '').split('pulled it open').length, {
      timeout: 3000
    })
    .toBe(6)
  // F-14.3: the scene brief. The metadata pane's Brief disclosure holds the five lines; Draft
  // beside it drafts them (2026-10-06, after the assistant's Actions menu went; the dial is at
  // Suggest and the key is set by now, and Scene 1 is well past the 200-character floor). The
  // draft is a proposal shown in the assistant, which Draft opens: Use draft fills the fields,
  // which autosave like the rest of the metadata, so the ghost-text request below carries the
  // brief. The panel is closed again so the assistant step below opens it with Ctrl+K.
  const briefRequestsBefore = openAiRequests.length
  await showSceneDetails()
  await metadata.getByRole('button', { name: 'Brief', exact: true }).click()
  await metadata.getByTestId('draft-brief').click()
  const briefDraft = page.getByTestId('assistant-panel').getByRole('group', { name: 'Brief draft' })
  await expect(briefDraft).toContainText(`Goal: ${BRIEF_GOAL}`)
  expect(openAiRequests).toHaveLength(briefRequestsBefore + 1)
  await briefDraft.getByRole('button', { name: 'Use draft' }).click()
  await expect(briefDraft).toHaveCount(0)
  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('assistant-panel')).toHaveCount(0)
  await expect(metadata.getByRole('textbox', { name: 'Goal' })).toHaveValue(BRIEF_GOAL)
  await expect
    .poll(async () => (await sceneMetaOf(scene1Row.id)).brief.goal, { timeout: 3000 })
    .toBe(BRIEF_GOAL)

  const vibeWrite = page.getByRole('button', { name: 'VibeWrite' })
  await expect(vibeWrite).toBeEnabled()
  await expect(vibeWrite).toHaveAttribute('aria-pressed', 'false')
  await vibeWrite.click()
  await expect(vibeWrite).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await aiSettings()).ghostText.enabled).toBe(true)
  const ghost = editor.locator('.ghost-text')
  const beforeGhost = openAiRequests.length
  await caretToEnd(editor)
  await page.keyboard.type(' Mara waited on the ridge.')
  await expect(ghost).toHaveText(GHOST_CONTINUATION)
  expect(openAiRequests).toHaveLength(beforeGhost + 1)
  expect(openAiRequests.at(-1)).toEqual({
    url: '/v1/chat/completions',
    auth: `Bearer ${ACCEPTED_KEY}`
  })
  // F-14.1: the system turn carries the voice block with the marked exemplar.
  const ghostSystem = openAiChatBodies.at(-1)?.messages[0]
  expect(ghostSystem?.role).toBe('system')
  expect(ghostSystem?.content).toContain("Match the author's voice:")
  expect(ghostSystem?.content).toContain('Example in this voice:\n"""\nThe storm broke at dusk.')
  // F-14.3: and the user turn carries the brief the author just accepted.
  const ghostUser = openAiChatBodies.at(-1)?.messages.at(-1)
  expect(ghostUser?.content).toContain('Scene brief:')
  expect(ghostUser?.content).toContain(`- Goal: ${BRIEF_GOAL}`)
  // F-14.9: after the voice block, the story bible: the bank's story tags by category, Scene
  // 1's place in Chapter 1 with the tags linked to it, and the scene after it as a neighbour.
  expect(ghostSystem?.content.indexOf(STORY_BIBLE_HEADING)).toBeGreaterThan(
    ghostSystem?.content.indexOf("Match the author's voice:") ?? -1
  )
  expect(ghostSystem?.content).toMatch(/\nCharacters: [^\n]*protagonist/)
  expect(ghostSystem?.content).toMatch(/\nSettings: [^\n]*dark-forest/)
  // Scene 1 follows the "Opening" scene inserted after it and renamed (F-2.2), so it is the
  // second of two in Chapter 1, with "Opening" before it and Chapter 2's scene after it.
  expect(ghostSystem?.content).toContain(
    '\nThis scene: "Scene 1", in "Chapter 1", in "Arc 1", scene 2 of 2; tagged dark-forest, protagonist, stormfront.\n' +
      'Previous scene: "Opening".\nNext scene: "Scene 1".'
  )
  // A widget only: the editor's text without the ghost span does not carry the continuation.
  expect(await documentTextWithoutGhost()).not.toContain(GHOST_CONTINUATION)
  await page.keyboard.press('Tab')
  await expect(ghost).toHaveCount(0)
  await expect(editor).toContainText(`Mara waited on the ridge. ${GHOST_CONTINUATION}`)
  // F-14.6: the accepted text carries the proposal it came from and the status bar shows the
  // scene's AI share.
  const aiSpan = editor.locator('.ai-origin[data-proposal-id]')
  await expect(aiSpan).toHaveText(GHOST_CONTINUATION)
  await expect(page.getByTestId('status-ai')).toHaveText(/^[1-9]\d*% AI$/)
  const afterGhost = await usageSummary()
  // Two tags requests (F-4.7), the brief draft (F-14.3), and this ghost text.
  expect(afterGhost.total.requests).toBe(4)
  expect(afterGhost.byFeature.find((f) => f.feature === 'ghostText')).toMatchObject({
    requests: 1,
    tokens: 309
  })
  await page.keyboard.type(' Nobody answered him.')
  await expect(ghost).toHaveText(GHOST_CONTINUATION)
  await page.keyboard.press('Escape')
  await expect(ghost).toHaveCount(0)
  await expect(editor).toContainText('Nobody answered him.')
  expect(((await editor.textContent()) ?? '').split(GHOST_CONTINUATION)).toHaveLength(2)
  // F-14.6: text typed at the span's edge is the author's; the span is unchanged.
  await expect(aiSpan).toHaveText(GHOST_CONTINUATION)

  // F-14.7: the fidelity check. The passage now ends with the sentinel the fake server answers
  // in present tense, first person; the manuscript is past, third, so the answer is scored off-voice locally,
  // sent back once with the violation named in the system turn, and shown with the warning
  // badge when the second try is off-voice too. Both calls reach the ledger. Escape drops it
  // like any suggestion; nothing entered the document.
  const bodiesBefore = openAiChatBodies.length
  const ghostRequestsBefore =
    (await usageSummary()).byFeature.find((f) => f.feature === 'ghostText')?.requests ?? 0
  await page.keyboard.type(` ${OFF_VOICE_SENTINEL}`)
  const flaggedGhost = editor.locator('.ghost-text[data-flagged="true"]')
  await expect(flaggedGhost).toContainText(OFF_VOICE_CONTINUATION)
  await expect(flaggedGhost.locator('.ghost-text-flag')).toHaveAttribute(
    'title',
    'switches to present tense'
  )
  await expect(flaggedGhost.locator('.ghost-text-flag')).toHaveAttribute(
    'aria-label',
    'Voice warning: switches to present tense'
  )
  expect(openAiChatBodies).toHaveLength(bodiesBefore + 2)
  expect(openAiChatBodies.at(-2)?.messages[0]?.content).not.toContain('Your last attempt')
  expect(openAiChatBodies.at(-1)?.messages[0]?.content).toContain(
    'Your last attempt switches to present tense.'
  )
  expect(openAiChatBodies.at(-1)?.messages[1]?.content).toBe(
    openAiChatBodies.at(-2)?.messages[1]?.content
  )
  await expect
    .poll(
      async () =>
        (await usageSummary()).byFeature.find((f) => f.feature === 'ghostText')?.requests ?? 0
    )
    .toBe(ghostRequestsBefore + 2)
  await page.keyboard.press('Escape')
  await expect(flaggedGhost).toHaveCount(0)
  expect(await documentTextWithoutGhost()).not.toContain('I am running')
  await vibeWrite.click()
  await expect(vibeWrite).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await aiSettings()).ghostText.enabled).toBe(false)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  // F-14.7: the consistency report scores every scene locally against the profile. Scene 1 is
  // the only scene over 200 words and it is most of the manuscript, so it matches; the rest
  // are summarised as skipped. No request leaves.
  const requestsBeforeReport = openAiRequests.length
  await voiceSection.getByRole('button', { name: 'Check voice consistency' }).click()
  const consistency = voiceSection.getByRole('list', { name: 'Voice consistency' })
  await expect(consistency.getByRole('listitem')).toHaveCount(1)
  await expect(consistency.getByRole('listitem')).toContainText('Scene 1')
  await expect(consistency.getByRole('listitem')).toContainText('Matches')
  await expect(voiceSection.getByTestId('voice-consistency-skipped')).toContainText(
    /[1-9]\d* scenes under 200 words were skipped\./
  )
  expect(openAiRequests).toHaveLength(requestsBeforeReport)
  // F-14.6: the Provenance section counts the accepted continuation in Scene 1 and nothing
  // else; the disclosure report is written where the (stubbed) save dialog points. No request
  // leaves for either.
  const provenance = settingsDialog.getByTestId('provenance-section')
  await expect(provenance.getByTestId('provenance-percent')).toContainText(
    /[1-9]\d*% of the manuscript is AI-origin/
  )
  const aiScenes = provenance
    .getByRole('list', { name: 'AI origin by scene' })
    .getByRole('listitem')
  await expect(aiScenes).toHaveCount(1)
  await expect(aiScenes.first()).toContainText('Scene 1')
  await expect(aiScenes.first()).toContainText('1 proposal')
  const disclosurePath = path.join(tmp, 'disclosure.md')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, disclosurePath)
  await provenance.getByRole('button', { name: 'Export disclosure report' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved to' })).toContainText(
    `Saved to ${disclosurePath}`
  )
  const disclosure = fs.readFileSync(disclosurePath, 'utf8')
  expect(disclosure).toContain('# AI disclosure: Smoke Novel')
  // The accepted text is the continuation plus the one space the join at the caret added
  // before it (the caret was at the document end, so nothing followed it).
  expect(disclosure).toMatch(
    new RegExp(`\\| Scene 1 \\| ${GHOST_CONTINUATION.length + 1} \\| [\\d,]+ \\| [1-9]\\d*% \\|`)
  )
  expect(openAiRequests).toHaveLength(requestsBeforeReport)
  // F-14.2: the author's rules. The section starts with the seeded phrases and no rules text;
  // the author writes a rule and bans a phrase the fake server's canned continuation uses.
  // Both persist through the debounced write. No request leaves.
  const authorRulesSection = settingsDialog.getByTestId('author-rules-section')
  const bannedList = authorRulesSection.getByRole('list', { name: 'Banned phrases' })
  await expect(bannedList).toContainText('a testament to')
  const seededCount = await bannedList.getByRole('listitem').count()
  expect(seededCount).toBeGreaterThan(10)
  await authorRulesSection.getByLabel('Style rules').fill(AUTHOR_RULE)
  const newPhrase = authorRulesSection.getByLabel('New banned phrase')
  await newPhrase.fill(BANNED_PHRASE)
  await newPhrase.press('Enter')
  await expect(bannedList.getByRole('listitem')).toHaveCount(seededCount + 1)
  await expect(bannedList).toContainText(BANNED_PHRASE)
  await expect.poll(async () => (await authorRules()).rules).toBe(AUTHOR_RULE)
  await expect.poll(async () => (await authorRules()).bannedPhrases).toContain(BANNED_PHRASE)
  expect(openAiRequests).toHaveLength(requestsBeforeReport)
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  // F-14.2: the canned continuation uses the banned phrase, so it is scored off-rules locally,
  // sent back once with the phrase named in the system turn, and shown flagged when the second
  // try uses it too. The system turn carries the rules block with the author's rule and the
  // phrase. Escape drops it; nothing entered the document.
  const bodiesBeforeRules = openAiChatBodies.length
  await vibeWrite.click()
  await expect(vibeWrite).toHaveAttribute('aria-pressed', 'true')
  await clickIntoEditor(editor)
  await page.keyboard.press('End')
  await page.keyboard.type(' The lamp burned low.')
  const bannedGhost = editor.locator('.ghost-text[data-flagged="true"]')
  await expect(bannedGhost).toContainText(GHOST_CONTINUATION)
  await expect(bannedGhost.locator('.ghost-text-flag')).toHaveAttribute(
    'title',
    `uses the phrase “${BANNED_PHRASE}”, which the author has banned`
  )
  expect(openAiChatBodies).toHaveLength(bodiesBeforeRules + 2)
  const rulesSystem = openAiChatBodies.at(-2)?.messages[0]?.content ?? ''
  expect(rulesSystem).toContain("The author's rules (hard constraints):")
  expect(rulesSystem).toContain(AUTHOR_RULE)
  expect(rulesSystem).toContain(BANNED_PHRASE)
  expect(rulesSystem).not.toContain('Your last attempt')
  expect(openAiChatBodies.at(-1)?.messages[0]?.content).toContain(
    `Your last attempt uses the phrase “${BANNED_PHRASE}”, which the author has banned.`
  )
  await page.keyboard.press('Escape')
  await expect(bannedGhost).toHaveCount(0)
  await vibeWrite.click()
  await expect(vibeWrite).toHaveAttribute('aria-pressed', 'false')
  expect(((await editor.textContent()) ?? '').split(GHOST_CONTINUATION)).toHaveLength(2)
  // Removing the phrase persists too, and leaves the seeded list as it was.
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await authorRulesSection.getByRole('button', { name: `Remove phrase ${BANNED_PHRASE}` }).click()
  await expect(bannedList.getByRole('listitem')).toHaveCount(seededCount)
  await expect.poll(async () => (await authorRules()).bannedPhrases).not.toContain(BANNED_PHRASE)
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  // F-14.6: once the author has rewritten more than half of what they accepted, what is left
  // is theirs: the mark goes and the status bar share with it. The span may wrap across lines,
  // so the selection is set on its text node directly (ProseMirror reads the DOM selection on
  // `selectionchange`), and one Delete removes 25 of the 40 accepted characters.
  await clickIntoEditor(editor)
  await aiSpan.evaluate((el) => {
    const text = el.firstChild
    if (!(text instanceof Text)) throw new Error('expected the span to hold a text node')
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 25)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe(` ${GHOST_CONTINUATION}`.slice(0, 25))
  await page.keyboard.press('Delete')
  await expect(aiSpan).toHaveCount(0)
  await expect(page.getByTestId('status-ai')).toHaveCount(0)
  await expect(editor).toContainText(GHOST_CONTINUATION.slice(25))

  // F-2.7: Insert shortcuts. With Scene 1 selected and the caret in its editor, Ctrl+Shift+S
  // adds a scene right after it (inline rename opens; Escape keeps the default title) and the
  // editor did not strike anything through; Ctrl+Shift+C adds a chapter after Chapter 1. Both
  // land through the same placement rule as the create bar.
  await editor.click()
  await page.keyboard.press('Control+Shift+s')
  const insertedScene = chapter1.getByRole('treeitem', { name: 'Untitled Scene', exact: true })
  await expect(insertedScene).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(chapter1.getByRole('treeitem', { name: /^(Scene 1|Untitled Scene)$/ })).toHaveCount(
    2
  )
  expect(await editor.locator('s').count()).toBe(0)
  await page.keyboard.press('Control+Shift+c')
  const insertedChapter = arc1.getByRole('treeitem', { name: 'Untitled Chapter', exact: true })
  await expect(insertedChapter).toBeVisible()
  await page.keyboard.press('Escape')

  // F-2.8: a scene the author names offers its title as a tag. The inserted scene keeps its
  // placeholder title and offers nothing; renamed "Fallen Creator", its bar offers
  // #fallen-creator "From the title", and Create makes the custom tag and links it here. The
  // chip is removed again so later steps see the bar as before (the 0-use tag stays in the bank).
  await insertedScene.getByText('Untitled Scene', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Untitled Scene')
  const titleTag = tagBar.getByTestId('title-tag')
  await expect(titleTag).toHaveCount(0)
  await insertedScene.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Rename' }).click()
  const renameInserted = page.getByRole('textbox', { name: 'Rename' })
  await renameInserted.fill('Fallen Creator')
  await renameInserted.press('Enter')
  await expect(renameInserted).toBeHidden()
  await expect(titleTag).toHaveText('#fallen-creator')
  await tagBar.getByRole('button', { name: 'Create tag fallen-creator' }).click()
  await expect(chipList.getByRole('listitem')).toHaveText(['fallen-creator'])
  await expect(titleTag).toHaveCount(0)
  await chipList.getByRole('button', { name: 'Remove fallen-creator' }).click()
  await expect(chipList).toHaveCount(0)
  await expect(titleTag).toHaveCount(0)

  await scene1.getByText('Scene 1', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')

  // F-3.9: typewriter scrolling. Off by default; once on in Settings → Editor, typing at the
  // end of Scene 1 keeps the caret near the middle of the scroll container (the column gains
  // room below so the last line can sit there too). Off again afterwards.
  const caretOffset = async (): Promise<number | null> =>
    page.evaluate(() => {
      const range = document.getSelection()?.getRangeAt(0)
      const scroller = document.querySelector('.ProseMirror')?.closest('.overflow-y-auto')
      const caret = range?.getBoundingClientRect()
      const box = scroller?.getBoundingClientRect()
      if (!caret || !box || box.height === 0) return null
      return Math.abs(caret.top + caret.height / 2 - (box.top + box.height / 2)) / box.height
    })
  await page.getByRole('button', { name: 'Settings' }).click()
  const typewriterBox = settingsDialog.getByRole('checkbox', { name: /Typewriter scrolling/ })
  await expect(typewriterBox).not.toBeChecked()
  await typewriterBox.check()
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  // The caret must really be at the end before typing (see `clickIntoEditor`: the lines landed
  // at the top of the scene four times on 2026-10-06, surfacing only at the rewrite step).
  await caretToEnd(editor)
  // Line by line, each checked to have landed at the end, so a lost caret fails here rather
  // than steps later.
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.type('\nThe typewriter line rolls on.')
    await expect.poll(() => caretAtEnd(editor)).toBe(true)
  }
  await expect.poll(caretOffset).toBeLessThan(0.34)
  await page.getByRole('button', { name: 'Settings' }).click()
  await typewriterBox.uncheck()
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  // F-6.1: focus mode. F11 puts the window in OS fullscreen (the flag Electron tracks, read
  // from main) and hides the chrome: the header, the sidebar, the toolbar, and the tag bar; the
  // editor stays editable and keeps its status bar. Escape leaves it and everything comes back
  // as it was (the layout store never moved). The toolbar button enters it too.
  const isFullScreen = (): Promise<boolean> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false)
  const focusButton = page.getByRole('button', { name: 'Focus mode' })

  const formatting = page.getByRole('toolbar', { name: 'Formatting' })
  expect(await isFullScreen()).toBe(false)
  await expect(focusButton).toHaveAttribute('aria-pressed', 'false')
  await expect(tagBar).toBeVisible()
  const asidesBefore = await page.locator('aside').count()
  expect(asidesBefore).toBeGreaterThan(0)
  await editor.click()
  await page.keyboard.press('F11')
  await expect.poll(isFullScreen).toBe(true)
  await expect(formatting).toHaveCount(0)
  await expect(page.locator('header')).toHaveCount(0)
  await expect(page.locator('aside')).toHaveCount(0)
  await expect(tagBar).toHaveCount(0)
  await expect(tree).toHaveCount(0)
  await expect(page.getByTestId('status-words')).toBeVisible()
  await clickIntoEditor(editor)
  await page.keyboard.press('End')
  await page.keyboard.type(' In focus.')
  await expect(editor).toContainText('In focus.')
  await page.keyboard.press('Escape')
  await expect.poll(isFullScreen).toBe(false)
  await expect(formatting).toBeVisible()
  await expect(page.locator('header')).toHaveCount(1)
  await expect(page.locator('aside')).toHaveCount(asidesBefore)
  await expect(tree).toBeVisible()
  await expect(scene1).toHaveAttribute('aria-selected', 'true')
  await expect(tagBar).toBeVisible()
  await expect(editor).toContainText('In focus.')
  const notesPanelsBefore = await page.getByTestId('notes-panel').count()
  await focusButton.click()
  await expect.poll(isFullScreen).toBe(true)
  await expect(formatting).toHaveCount(0)

  // F-6.5: the control bar. It shows on entry (the intro, 2 s, checked in the unit tests: the
  // fullscreen transition can outlast it here) and hides once the pointer is away from the
  // bottom edge; near the edge it comes back. Its word count is the document's live count;
  // Notes opens the notes window in focus mode (the persisted open flag never moves) and closes
  // it again; moving away hides the bar after the delay; Exit leaves focus mode.
  const controlBar = page.getByTestId('focus-control-bar')
  await expect(controlBar).toHaveCount(1)
  const screenSize = await fullscreenViewport()
  await page.mouse.move(screenSize.w / 2, screenSize.h / 2)
  await expect(controlBar).toHaveAttribute('data-visible', 'false', { timeout: 10_000 })
  await page.mouse.move(screenSize.w / 2, screenSize.h - 8)
  await expect(controlBar).toHaveAttribute('data-visible', 'true')
  await expect(page.getByTestId('focus-words')).toHaveText(
    await page.getByTestId('status-words').innerText()
  )
  expect(await page.getByTestId('focus-words').innerText()).toMatch(/^\d[\d,]* words?$/)
  await expect(page.getByTestId('notes-panel')).toHaveCount(0)
  const focusNotes = controlBar.getByRole('button', { name: 'Notes' })
  await focusNotes.click()
  await expect(focusNotes).toHaveAttribute('aria-pressed', 'true')
  // F-6.6: the notes float as a window (never the docked panel), placed from the layout's
  // rect, clamped into the screen. Dragging the title bar 120 px right moves it, dragging the
  // grip resizes it; both persist through the layout after the debounce. Its Close clears the
  // bar's flag, and reopening brings the same geometry back.
  const notesWindow = page.getByRole('dialog', { name: 'Notes' })
  await expect(notesWindow).toBeVisible()
  await expect(page.getByTestId('notes-panel')).toHaveCount(0)
  await expect(notesWindow.getByRole('textbox', { name: 'Notes' })).toBeVisible()
  const notesRectBefore = (await getLayout()).floating.notes
  const windowBox = async (): Promise<{ x: number; y: number; width: number; height: number }> => {
    const box = await notesWindow.boundingBox()
    if (!box) throw new Error('the notes window has no box')
    return box
  }
  expect(await windowBox()).toEqual(notesRectBefore)
  expect(notesRectBefore.x + notesRectBefore.width).toBeLessThanOrEqual(screenSize.w)
  const titleBar = notesWindow.getByRole('group', { name: 'Notes window' })
  const titleBox = await titleBar.boundingBox()
  if (!titleBox) throw new Error('the notes title bar has no box')
  await page.mouse.move(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(titleBox.x + titleBox.width / 2 + 120, titleBox.y + titleBox.height / 2, {
    steps: 6
  })
  await page.mouse.up()
  const movedX = Math.min(notesRectBefore.x + 120, screenSize.w - notesRectBefore.width)
  const moved = { ...notesRectBefore, x: movedX }
  await expect.poll(windowBox).toEqual(moved)
  await expect
    .poll(async () => (await getLayout()).floating.notes, { timeout: 3000 })
    .toEqual(moved)
  const gripBox = await notesWindow.getByTestId('floating-notes-grip').boundingBox()
  if (!gripBox) throw new Error('the notes grip has no box')
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(gripBox.x + gripBox.width / 2 - 40, gripBox.y + gripBox.height / 2 + 30, {
    steps: 6
  })
  await page.mouse.up()
  const gripResized = { ...moved, width: moved.width - 40, height: moved.height + 30 }
  await expect.poll(windowBox).toEqual(gripResized)
  await expect
    .poll(async () => (await getLayout()).floating.notes, { timeout: 3000 })
    .toEqual(gripResized)
  // 2026-10-07: every edge and corner resizes, like a desktop window. The left edge dragged 50 px
  // left widens it with the right edge kept; the top-left corner dragged up and left grows both
  // ways with the bottom-right corner kept. The size persists through the layout.
  const dragHandle = async (testId: string, dx: number, dy: number): Promise<void> => {
    const box = await notesWindow.getByTestId(testId).boundingBox()
    if (!box) throw new Error(`${testId} has no box`)
    const startX = box.x + box.width / 2
    const startY = box.y + box.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX + dx, startY + dy, { steps: 5 })
    await page.mouse.up()
  }
  await dragHandle('floating-notes-resize-w', -50, 0)
  const leftResized = { ...gripResized, x: gripResized.x - 50, width: gripResized.width + 50 }
  await expect.poll(windowBox).toEqual(leftResized)
  await dragHandle('floating-notes-resize-nw', -30, -20)
  const resized = {
    x: leftResized.x - 30,
    y: leftResized.y - 20,
    width: leftResized.width + 30,
    height: leftResized.height + 20
  }
  await expect.poll(windowBox).toEqual(resized)
  await expect
    .poll(async () => (await getLayout()).floating.notes, { timeout: 3000 })
    .toEqual(resized)
  await notesWindow.getByRole('button', { name: 'Close Notes' }).click()
  await expect(notesWindow).toHaveCount(0)
  await page.mouse.move(screenSize.w / 2, screenSize.h - 8)
  await expect(controlBar).toHaveAttribute('data-visible', 'true')
  await expect(focusNotes).toHaveAttribute('aria-pressed', 'false')
  await focusNotes.click()
  await expect(notesWindow).toBeVisible()
  expect(await windowBox()).toEqual(resized)
  expect((await getLayout()).floating.notes).toEqual(resized)
  // The references (pins and the scene's story bible sheets) and the assistant float beside it.
  const focusReferences = controlBar.getByRole('button', { name: 'References' })
  await focusReferences.click()
  const referencesWindow = page.getByRole('dialog', { name: 'References' })
  await expect(referencesWindow).toBeVisible()
  await expect(page.getByTestId('references-panel')).toHaveCount(0)
  const focusAssistant = controlBar.getByRole('button', { name: 'AI assistant' })
  await focusAssistant.click()
  await expect(page.getByRole('dialog', { name: 'Assistant' })).toBeVisible()
  await focusReferences.click()
  await focusAssistant.click()
  await expect(referencesWindow).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Assistant' })).toHaveCount(0)
  await focusNotes.click()
  await expect(notesWindow).toHaveCount(0)
  await page.mouse.move(screenSize.w / 2, screenSize.h / 2)
  await expect(controlBar).toHaveAttribute('data-visible', 'false', { timeout: 10_000 })
  await page.mouse.move(screenSize.w / 2, screenSize.h - 8)
  await expect(controlBar).toHaveAttribute('data-visible', 'true')
  await controlBar.getByRole('button', { name: 'Exit focus mode' }).click()
  await expect.poll(isFullScreen).toBe(false)
  await expect(controlBar).toHaveCount(0)
  await expect(formatting).toBeVisible()
  await expect(focusButton).toHaveAttribute('aria-pressed', 'false')
  // The normal screen follows the persisted layout again (the F-3.7 step left the panel open).
  await expect(page.getByTestId('notes-panel')).toHaveCount(notesPanelsBefore)

  // F-6.2: background images. The stubbed open dialog answers a 1×1 PNG written into the temp
  // dir; "Add images…" copies it into the project's `assets/backgrounds/`, the tile appears and
  // is selected, and in focus mode the backdrop shows it through the `mythscribe-asset://`
  // scheme (the image really loads: `naturalWidth` is 1). Delete removes the tile, the file,
  // and the backdrop.
  const backgroundSource = path.join(tmp, 'backdrop.png')
  fs.writeFileSync(backgroundSource, Buffer.from(PNG_1X1_BASE64, 'base64'))
  await stubOpenDialog(backgroundSource)
  const backgroundsDir = path.join(projectPath, 'assets', 'backgrounds')
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(settingsDialog.getByTestId('focus-background-name')).toHaveText('None')
  await settingsDialog.getByRole('button', { name: 'Backgrounds…' }).click()
  const manager = page.getByRole('dialog', { name: 'Backgrounds' })
  await expect(manager).toBeVisible()
  const noBackground = manager.getByRole('button', { name: 'No background' })
  await expect(noBackground).toHaveAttribute('aria-pressed', 'true')
  await expect(manager.getByText('No images yet.')).toBeVisible()
  await manager.getByRole('button', { name: 'Add images…' }).click()
  const backgroundTile = manager.getByRole('button', { name: /^(?!Delete ).*\.png$/ })
  await expect(backgroundTile).toHaveCount(1)
  const backgroundName = await backgroundTile.getAttribute('aria-label')
  if (!backgroundName) throw new Error('background tile has no name')
  // Stored as `<stem>.<short id>.png`; the tile shows the name without the id.
  const [storedFile, ...otherFiles] = fs.readdirSync(backgroundsDir)
  expect(otherFiles).toEqual([])
  expect(storedFile?.replace(/\.[0-9a-f]{8}\.png$/, '.png')).toBe(backgroundName)
  expect(fs.readFileSync(path.join(backgroundsDir, storedFile ?? '')).toString('base64')).toBe(
    PNG_1X1_BASE64
  )
  await expect(backgroundTile).toHaveAttribute('aria-pressed', 'false')
  await backgroundTile.click()
  await expect(backgroundTile).toHaveAttribute('aria-pressed', 'true')
  await expect(noBackground).toHaveAttribute('aria-pressed', 'false')
  await manager.getByRole('button', { name: 'Close backgrounds' }).click()
  await expect(manager).toHaveCount(0)
  await expect(settingsDialog).toBeVisible()
  await expect(settingsDialog.getByTestId('focus-background-name')).toHaveText(backgroundName)
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await expect
    .poll(async () => (await focusSettings()).backgroundId)
    .toBe(storedFile?.replace(/\.png$/, ''))
  const backdrop = page.getByTestId('focus-backdrop')
  await expect(backdrop).toHaveCount(0)
  await editor.click()
  await page.keyboard.press('F11')
  await expect.poll(isFullScreen).toBe(true)
  await expect(backdrop).toBeVisible()
  const backgroundUrl = `mythscribe-asset://backgrounds/${storedFile}`
  await expect(backdrop).toHaveCSS('background-image', `url("${backgroundUrl}")`)
  const naturalWidth = await page.evaluate(async (src) => {
    const img = new Image()
    img.src = src
    await img.decode()
    return img.naturalWidth
  }, backgroundUrl)
  expect(naturalWidth).toBe(1)
  await expect(page.locator('.focus-surface')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect.poll(isFullScreen).toBe(false)
  await expect(backdrop).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('button', { name: 'Backgrounds…' }).click()
  await manager.getByRole('button', { name: `Delete ${backgroundName}` }).click()
  const deleteConfirm = page.getByRole('dialog', { name: `Delete "${backgroundName}"?` })
  await deleteConfirm.getByRole('button', { name: 'Delete' }).click()
  await expect(deleteConfirm).toHaveCount(0)
  await expect(backgroundTile).toHaveCount(0)
  await expect(noBackground).toHaveAttribute('aria-pressed', 'true')
  expect(fs.readdirSync(backgroundsDir)).toEqual([])
  await manager.getByRole('button', { name: 'Close backgrounds' }).click()
  await expect(settingsDialog.getByTestId('focus-background-name')).toHaveText('None')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await expect.poll(async () => (await focusSettings()).backgroundId).toBeNull()
  await editor.click()
  await page.keyboard.press('F11')
  await expect.poll(isFullScreen).toBe(true)
  await expect(backdrop).toHaveCount(0)
  await expect(page.locator('.focus-surface')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect.poll(isFullScreen).toBe(false)
  await expect(formatting).toBeVisible()

  // F-6.3 / F-6.4: rotation and the writing overlay persist under the focus settings; the
  // overlay width sizes the focus-mode column as a share of the pane (no background is
  // selected here, so darkness has nothing to dim). Rotation's timer is unit-tested.
  await page.getByRole('button', { name: 'Settings' }).click()
  const focusGroup = settingsDialog.getByRole('region', { name: 'Focus mode' })
  await focusGroup.getByRole('checkbox', { name: /Rotate backgrounds/ }).check()
  await focusGroup.getByRole('spinbutton', { name: 'Every (minutes)' }).fill('3')
  await focusGroup.getByRole('slider', { name: /^Darkness/ }).fill('30')
  await focusGroup.getByRole('slider', { name: /^Width/ }).fill('50')
  await expect
    .poll(async () => (await focusSettings()).rotation)
    .toEqual({
      enabled: true,
      intervalMinutes: 3
    })
  expect((await focusSettings()).overlay).toEqual({ darkness: 30, width: 50 })
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await page.keyboard.press('F11')
  await expect
    .poll(() =>
      page.evaluate(() => {
        const box = document.querySelector('.ProseMirror')
        const pane = box?.closest<HTMLElement>('[style*="--ms-editor-max-width"]')
        return pane?.style.getPropertyValue('--ms-editor-max-width').trim() ?? null
      })
    )
    .toBe('50%')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible()
  await page.getByRole('button', { name: 'Settings' }).click()
  await focusGroup.getByRole('checkbox', { name: /Rotate backgrounds/ }).uncheck()
  await focusGroup.getByRole('slider', { name: /^Darkness/ }).fill('60')
  await focusGroup.getByRole('slider', { name: /^Width/ }).fill('70')
  await expect.poll(async () => (await focusSettings()).rotation.enabled).toBe(false)
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  // F-5.4: the assistant panel. Ctrl+K opens it (AI is still on with the key saved). Since
  // 2026-10-07 (decided by the author) the chat's modes are Auto, Ask, and Plan: one project
  // setting under the message box, Ask by default, with no Off there. Every message goes to the
  // router (F-5.19), then to the feature it picked, the chat agent (F-5.22) answering the rest.
  // A Plan question runs the agent with its read-only tools: the router's request, then a
  // lookup and the cited answer with the cost line; the tab takes the question as its title.
  const chatRequestsBefore = openAiChatBodies.length
  // Toasts stack over the panel's composer (bottom right); dismiss what the steps above left.
  await dismissToasts()
  await page.keyboard.press('Control+k')
  const assistant = page.getByTestId('assistant-panel')
  await expect(assistant).toBeVisible()
  await expect(page.getByRole('button', { name: 'Assistant', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  const messageBox = assistant.getByRole('textbox', { name: 'Message' })
  const turns = assistant.locator('[data-testid="chat-turn"]')
  const modeRadios = assistant.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio')
  await expect(modeRadios).toHaveText(['Auto', 'Ask', 'Plan'])
  await expect(modeRadios.nth(1)).toHaveAttribute('aria-checked', 'true')
  await expect(assistant.getByRole('radiogroup', { name: 'AI switch' })).toHaveCount(0)
  expect((await aiSettings()).chatMode).toBe('ask')
  // 2026-10-06 polish: the header holds no actions; a scene action is a chat turn. A message
  // that is exactly an action's name ("Proofread", "Beta reader") is routed locally, with no
  // router request, so the request counts below see only the feature's own request.
  await expect(assistant.getByTestId('ai-actions')).toHaveCount(0)
  await expect(assistant.getByRole('button', { name: 'Clear conversation' })).toHaveCount(0)
  /** Sends `message` in Ask, where the router may pick any feature, edits included. */
  const sendRouted = async (message: string): Promise<void> => {
    await assistant.getByRole('radio', { name: 'Ask', exact: true }).click()
    await messageBox.fill(message)
    await messageBox.press('Enter')
  }
  await assistant.getByRole('radio', { name: 'Plan' }).click()
  await expect.poll(async () => (await aiSettings()).chatMode).toBe('plan')
  await messageBox.fill('Why is Mara on the ridge?')
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(2)
  await expect(turns.nth(0)).toHaveAttribute('data-role', 'user')
  await expect(turns.nth(1)).toHaveAttribute('data-role', 'assistant')
  await expect(turns.nth(1)).toContainText(QUERY_ANSWER_KEPT)
  await expect(turns.nth(1).getByTestId('chat-turn-cost')).toContainText('gpt-5.4 ·')
  // F-5.9: the cost line carries the tokens the turn spent, not the model and the cost alone.
  await expect(turns.nth(1).getByTestId('chat-turn-cost')).toContainText(' in · ')
  // The router's request, then the agent's lookup and its answer, all without the edit rules.
  expect(openAiChatBodies).toHaveLength(chatRequestsBefore + 3)
  expect(openAiChatBodies.at(-3)?.messages[0]?.content.startsWith(ROUTE_SENTINEL)).toBe(true)
  expect(openAiChatBodies.at(-2)?.messages[0]?.content.startsWith(CHAT_AGENT_SENTINEL)).toBe(true)
  expect(openAiChatBodies.at(-2)?.messages.at(-1)?.content).toBe('Why is Mara on the ridge?')
  for (const body of openAiChatBodies.slice(-2)) {
    expect(body.messages[0]?.content).not.toContain(AGENT_EDIT_RULES_OPENING)
  }
  await expect(assistant.getByRole('tab', { name: 'Why is Mara on the ridge?' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  // F-5.10: a slow answer shows the header activity indicator and Stop in place of Send; Stop
  // drops the pending turn, keeps the question so it can be resent, and toasts nothing. The
  // request left (the fake server answers after its delay to a client that is gone).
  await messageBox.fill(`${SLOW_SENTINEL}: what happens next?`)
  await messageBox.press('Enter')
  await expect(assistant.getByTestId('chat-pending')).toBeVisible()
  await expect(page.getByTestId('ai-activity')).toContainText('Assistant routing')
  await assistant.getByTestId('assistant-stop').click()
  await expect(assistant.getByTestId('chat-pending')).toHaveCount(0)
  await expect(turns).toHaveCount(3)
  await expect(turns.nth(2)).toHaveAttribute('data-role', 'user')
  await expect(page.getByTestId('ai-activity')).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'stopped' })).toHaveCount(0)
  expect(openAiChatBodies).toHaveLength(chatRequestsBefore + 4)
  await expect(assistant.getByTestId('assistant-send')).toBeVisible()
  // F-5.17: What should come next?, asked in the chat. The rotating suggestion above the box
  // (2026-10-06) fills the box on a click and sends nothing. "What next?" routes locally to the
  // action, which asks the fast tier once (the scene's tail, its brief, and the story bible) and
  // lands three directions in the conversation as chat; Write this on the first sends it to the
  // agent with its edit tools (2026-10-07: Author mode is gone), so in Ask the new paragraphs
  // come back as an insert waiting for Apply, which adds them to Scene 1 as AI-origin text.
  const whatNextBodies = (): { role: string; content: string }[][] =>
    openAiChatBodies
      .filter((body) => body.messages[0]?.content.startsWith(WHAT_NEXT_SENTINEL))
      .map((body) => body.messages)
  const whatNextBefore = whatNextBodies().length
  await assistant.getByRole('radio', { name: 'Ask', exact: true }).click()
  const suggestion = assistant.getByTestId('assistant-suggestion')
  await suggestion.hover()
  const suggested = (await suggestion.textContent()) ?? ''
  expect(suggested.length).toBeGreaterThan(0)
  await suggestion.click()
  await expect(messageBox).toHaveValue(suggested)
  await expect(turns).toHaveCount(3)
  await sendRouted('What next?')
  const directions = assistant.getByTestId('what-next-direction')
  await expect(directions).toHaveCount(3)
  await expect(directions.first()).toContainText(WHAT_NEXT_TITLES[0] ?? '')
  await expect(turns).toHaveCount(5)
  await expect(turns.nth(3)).toContainText('What next?')
  await expect(turns.nth(4).getByTestId('chat-turn-action')).toHaveText('What should come next?')
  expect(whatNextBodies()).toHaveLength(whatNextBefore + 1)
  // F-5.23 (whatNext.v3): the bible as the author's notes and plans, and the story map.
  expect(whatNextBodies().at(-1)?.[0]?.content).toContain(STORY_BIBLE_PLANS_HEADING)
  expect(whatNextBodies().at(-1)?.[0]?.content).toContain(STORY_MAP_HEADING)
  await directions.first().getByTestId('what-next-write').click()
  await expect(turns).toHaveCount(7)
  const insertTurn = turns.nth(6)
  await expect(insertTurn).toContainText(AGENT_INSERT_ANSWER)
  // The agent's last step, not the draft request that follows it (2026-10-07).
  const lastAgentBody = [...openAiChatBodies]
    .reverse()
    .find((body) => body.messages[0]?.content.startsWith(CHAT_AGENT_SENTINEL))
  expect(lastAgentBody?.messages[0]?.content).toContain(AGENT_EDIT_RULES_OPENING)
  expect(
    lastAgentBody?.messages.some(
      (m) =>
        m.content ===
        `Continue the scene in this direction: ${WHAT_NEXT_TITLES[0]}. She doubts the crossing and heads back to the camp.`
    )
  ).toBe(true)
  // 2026-10-07: the insertion lands in the editor as ghost text (the draft streams in at the
  // caret); the card mirrors it, and Tab in the editor accepts it.
  const insertCard = insertTurn.getByTestId('agent-change')
  await expect(insertCard).toHaveAttribute('data-status', 'shown')
  await expect(editor.locator('.ghost-text')).toContainText(AGENT_SECOND)
  expect(await documentTextWithoutGhost()).not.toContain(AGENT_SECOND)
  await editor.focus()
  await page.keyboard.press('Tab')
  await expect(insertCard).toHaveAttribute('data-status', 'applied')
  await expect(editor.locator('.ghost-text')).toHaveCount(0)
  await expect(editor).toContainText(AGENT_SECOND)
  await expect(editor.locator('.ai-origin', { hasText: AGENT_FIRST })).toHaveCount(1)
  await expect(page.getByTestId('status-ai')).toHaveText(/^[1-9]\d*% AI$/)
  const afterWhatNext = await usageSummary()
  expect(afterWhatNext.byFeature.find((f) => f.feature === 'whatNext')).toMatchObject({
    requests: 1
  })
  await assistant.getByRole('button', { name: 'New conversation', exact: true }).click()
  await expect(turns).toHaveCount(0)
  // The mode is the project's, not the conversation's: a new tab keeps Ask.
  await expect(assistant.getByRole('radio', { name: 'Ask', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await assistant.getByRole('radio', { name: 'Plan' }).click()
  await messageBox.fill('A second question.')
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(2)
  // No clearing (2026-10-06): a fresh conversation is New conversation, and a conversation
  // leaves only by its tab's close button (shown on hover), after confirming when it has turns.
  await assistant.getByRole('button', { name: 'New conversation', exact: true }).click()
  await expect(turns).toHaveCount(0)
  await expect(assistant.getByRole('tab')).toHaveCount(3)
  await assistant.getByRole('tab', { name: 'A second question.' }).hover()
  await assistant.getByRole('button', { name: 'Close A second question.' }).click()
  await page
    .getByRole('dialog', { name: 'Close conversation' })
    .getByRole('button', { name: 'Close' })
    .click()
  await expect(assistant.getByRole('tab')).toHaveCount(2)
  await expect(turns).toHaveCount(0)

  // F-14.10: rewrite in my voice. With Scene 1's opening sentence selected (set on the DOM, as
  // the provenance step does, since the paragraph wraps), the selection bubble's Rewrite
  // (2026-10-06; the toolbar button is gone) sends the passage with the voice block in the
  // system turn; the fake server streams the rewrite and the assistant panel shows it as a word
  // diff against the selection. Accept replaces the passage as AI-origin text through the
  // editor (so it autosaves), and the ledger gains a rewrite request.
  await dismissToasts()
  await expect(page.getByRole('button', { name: 'Rewrite in my voice' })).toHaveCount(0)
  const rewriteButton = page.getByTestId('selection-rewrite')
  const rewriteBodiesBefore = openAiChatBodies.length
  await clickIntoEditor(editor)
  // The author selects what is on screen: the opening is scrolled back into view first.
  await editor.locator('p').first().scrollIntoViewIfNeeded()
  await editor
    .locator('p')
    .first()
    .evaluate((paragraph, length) => {
      // The first `length` characters of the paragraph, whichever text nodes hold them.
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      const first = walker.nextNode()
      if (!(first instanceof Text)) throw new Error('expected the paragraph to open with text')
      let node: Node | null = first
      let offset = length
      while (node instanceof Text && offset > node.length) {
        offset -= node.length
        node = walker.nextNode()
      }
      if (!(node instanceof Text)) throw new Error('the paragraph is shorter than the sentence')
      const range = document.createRange()
      range.setStart(first, 0)
      range.setEnd(node, offset)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }, SENTENCE.length)
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe(SENTENCE)
  await expect(rewriteButton).toBeEnabled()
  await rewriteButton.click()
  const rewritePanel = page.getByTestId('rewrite-panel')
  await expect(rewritePanel).toBeVisible()
  await expect(editor.locator('.rewrite-target')).toHaveText(SENTENCE)
  const rewriteDiff = rewritePanel.getByTestId('rewrite-diff')
  await expect(rewriteDiff).toBeVisible()
  await expect(rewriteDiff.locator('ins').filter({ hasText: 'quiet' })).toHaveCount(1)
  await expect(rewriteDiff.locator('del').filter({ hasText: 'broke' })).toHaveCount(1)
  await expect(page.getByTestId('ai-activity')).toHaveCount(0)
  expect(openAiChatBodies).toHaveLength(rewriteBodiesBefore + 1)
  const rewriteSystem = openAiChatBodies.at(-1)?.messages[0]
  expect(rewriteSystem?.role).toBe('system')
  expect(rewriteSystem?.content.startsWith(REWRITE_SENTINEL)).toBe(true)
  expect(rewriteSystem?.content).toContain("Match the author's voice:")
  expect(rewriteSystem?.content).toContain(STORY_BIBLE_HEADING)
  expect(openAiChatBodies.at(-1)?.messages.at(-1)?.content).toContain(SENTENCE)
  await rewritePanel.getByTestId('rewrite-accept').click()
  await expect(rewritePanel).toHaveCount(0)
  await expect(editor.locator('.rewrite-target')).toHaveCount(0)
  await expect(editor.locator('p').first()).toContainText(REWRITE_ANSWER)
  await expect(editor.locator('p').first()).not.toContainText('Then silence.')
  await expect(
    editor.locator('.ai-origin[data-proposal-id]').filter({ hasText: REWRITE_ANSWER })
  ).toHaveCount(1)
  await expect
    .poll(async () => ((await documentText(scene1Row.id)) ?? '').includes(REWRITE_ANSWER), {
      timeout: 3000
    })
    .toBe(true)
  const afterRewrite = await usageSummary()
  expect(afterRewrite.byFeature.find((f) => f.feature === 'rewrite')).toMatchObject({
    requests: 1
  })

  // F-14.8: editor's notes, asked for in the chat (F-5.19, 2026-10-06). In Ask the router
  // (fast tier) reads the message and picks editor's notes; the turn names the action and says
  // where the notes are. Main is asked for a critique of Scene 1; the fake server answers three
  // notes, one of them citing a passage that was never written, and main drops it, so only the
  // two cited notes reach the panel (no uncited praise). Apply replaces exactly the quoted
  // passage with the fix through the editor, as AI-origin text that autosaves, and the ledger
  // gains a critique request. Close settles the proposal.
  await expect(page.getByRole('button', { name: "Editor's notes" })).toHaveCount(0)
  const critiqueBodiesBefore = openAiChatBodies.length
  await assistant.getByRole('radio', { name: 'Ask', exact: true }).click()
  await messageBox.fill(ROUTE_CRITIQUE_MESSAGE)
  await messageBox.press('Enter')
  const critiquePanel = page.getByTestId('critique-panel')
  await expect(critiquePanel).toBeVisible()
  await expect(turns).toHaveCount(2)
  await expect(turns.nth(1).getByTestId('chat-turn-action')).toHaveText("Editor's notes")
  await expect(turns.nth(1)).toContainText("Editor's notes are above the chat.")
  await expect(turns.nth(1).getByTestId('chat-turn-cost')).toContainText('gpt-5.4-mini')
  await expect(critiquePanel.getByTestId('critique-note')).toHaveCount(2)
  await expect(critiquePanel.getByTestId('critique-quote').first()).toHaveText(CRITIQUE_QUOTE)
  await expect(critiquePanel.getByTestId('critique-quote').nth(1)).toHaveText(CRITIQUE_PRAISE_QUOTE)
  await expect(critiquePanel).not.toContainText(CRITIQUE_FABRICATED_QUOTE)
  // The router's request, then the critique's.
  expect(openAiChatBodies).toHaveLength(critiqueBodiesBefore + 2)
  expect(openAiChatBodies.at(-2)?.messages[0]?.content.startsWith(ROUTE_SENTINEL)).toBe(true)
  const critiqueSystem = openAiChatBodies.at(-1)?.messages[0]
  expect(critiqueSystem?.role).toBe('system')
  expect(critiqueSystem?.content.startsWith(CRITIQUE_SENTINEL)).toBe(true)
  // The honesty setting is at its default, "specific and direct".
  expect(critiqueSystem?.content).toContain('Be specific and direct')
  expect(critiqueSystem?.content).toContain(STORY_BIBLE_HEADING)
  // F-14.3: the scene brief accepted above is the intent block `critique.v2` carries.
  expect(openAiChatBodies.at(-1)?.messages.at(-1)?.content).toContain(
    "Scene brief (the author's intent):"
  )
  expect(openAiChatBodies.at(-1)?.messages.at(-1)?.content).toContain(`- Goal: ${BRIEF_GOAL}`)
  await critiquePanel.getByTestId('critique-apply').first().click()
  await expect(critiquePanel.getByTestId('critique-apply').first()).toHaveText('Applied')
  await expect(editor.locator('p').first()).toContainText(CRITIQUE_FIX)
  await expect(
    editor.locator('.ai-origin[data-proposal-id]').filter({ hasText: CRITIQUE_FIX })
  ).toHaveCount(1)
  await expect
    .poll(async () => ((await documentText(scene1Row.id)) ?? '').includes(CRITIQUE_FIX), {
      timeout: 3000
    })
    .toBe(true)
  const afterCritique = await usageSummary()
  expect(afterCritique.byFeature.find((f) => f.feature === 'critique')).toMatchObject({
    requests: 1
  })
  await critiquePanel.getByTestId('critique-close').click()
  await expect(critiquePanel).toHaveCount(0)
  const afterRoute = await usageSummary()
  // Every message goes to the router since 2026-10-07: the two Plan questions and this one (the
  // stopped request was never answered, so it is not in the ledger).
  expect(afterRoute.byFeature.find((f) => f.feature === 'route')).toMatchObject({ requests: 3 })
  await assistant.getByRole('button', { name: 'New conversation', exact: true }).click()
  await expect(turns).toHaveCount(0)

  // F-5.20: suggestions in the notes column. Suggest beside Synopsis asks the fast tier for a
  // synopsis of Scene 1, shown under the box as AI-made until accepted; Accept writes it to the
  // scene's metadata. Suggest beside the Notes heading asks for key points; Add to notes appends
  // the ticked ones to the notes, one "• " line each.
  await notesColumn.getByTestId('suggest-synopsis').click()
  const synopsisCard = notesColumn.getByRole('group', { name: 'Suggested synopsis' })
  await expect(synopsisCard).toContainText(SUGGESTED_SYNOPSIS)
  await synopsisCard.getByRole('button', { name: 'Accept' }).click()
  await expect(synopsisCard).toHaveCount(0)
  await expect(notesColumn.getByRole('textbox', { name: 'Synopsis' })).toHaveValue(
    SUGGESTED_SYNOPSIS
  )
  await expect
    .poll(async () => (await sceneMetaOf(scene1Row.id)).synopsis, { timeout: 3000 })
    .toBe(SUGGESTED_SYNOPSIS)
  await notesColumn.getByTestId('suggest-notes').click()
  const notesCard = notesColumn.getByRole('group', { name: 'Suggested notes' })
  await expect(notesCard.getByTestId('suggested-note')).toHaveCount(2)
  await notesCard.getByRole('button', { name: 'Add to notes' }).click()
  await expect(notesCard).toHaveCount(0)
  const notesBox = notesColumn.getByRole('textbox', { name: 'Notes' })
  for (const point of SUGGESTED_POINTS) await expect(notesBox).toContainText(`• ${point}`)

  // F-14.12: proofread. A sentence with a misspelling and a doubled word is typed at the end of
  // Scene 1; with the caret collapsed, "Proofread" sent in Auto (2026-10-06, routed locally)
  // proofreads the whole scene. The fake
  // server answers three fixes, one quoting a passage that was never written, and main drops it,
  // so two cards show. Accept takes the first, Accept all the other, each replacing exactly its
  // quoted passage as AI-origin text from the one proposal (how it settles is a store test).
  await dismissToasts()
  await caretToEnd(editor)
  await page.keyboard.type(PROOFREAD_TYPED)
  await expect
    .poll(async () => ((await documentText(scene1Row.id)) ?? '').includes(PROOFREAD_TYPED.trim()), {
      timeout: 3000
    })
    .toBe(true)
  const proofreadBodies = (): number =>
    openAiChatBodies.filter((body) => body.messages[0]?.content.startsWith(PROOFREAD_SENTINEL))
      .length
  const proofreadRequestsBefore = proofreadBodies()
  if (!(await assistant.isVisible())) await page.keyboard.press('Control+k')
  await expect(assistant).toBeVisible()
  await sendRouted('Proofread')
  const proofreadPanel = page.getByTestId('proofread-panel')
  await expect(proofreadPanel).toBeVisible()
  const proofreadFixes = proofreadPanel.getByTestId('proofread-fix')
  await expect(proofreadFixes).toHaveCount(2)
  expect(proofreadBodies()).toBe(proofreadRequestsBefore + 1)
  await expect(proofreadPanel.getByTestId('proofread-scope')).toHaveText('Scene')
  await expect(proofreadPanel.getByTestId('proofread-quote')).toHaveText([
    PROOFREAD_TYPO_QUOTE,
    PROOFREAD_DOUBLED_QUOTE
  ])
  await expect(proofreadFixes.first()).toHaveAttribute('data-kind', 'spelling')
  await expect(proofreadFixes.nth(1)).toHaveAttribute('data-kind', 'doubledWord')
  await expect(proofreadPanel).not.toContainText(CRITIQUE_FABRICATED_QUOTE)
  await expect(proofreadPanel.getByTestId('proofread-cost')).toContainText('gpt-5.4-mini')
  await proofreadFixes.first().getByTestId('proofread-accept').click()
  await expect(proofreadFixes.first()).toHaveAttribute('data-state', 'applied')
  await expect(proofreadFixes.nth(1)).toHaveAttribute('data-state', 'open')
  await proofreadPanel.getByTestId('proofread-accept-all').click()
  await expect(proofreadFixes.nth(1)).toHaveAttribute('data-state', 'applied')
  await expect(
    proofreadPanel.locator('[data-testid="proofread-fix"][data-state="open"]')
  ).toHaveCount(0)
  await expect(proofreadPanel.getByTestId('proofread-accept-all')).toBeDisabled()
  await expect(editor).toContainText(PROOFREAD_CORRECTED)
  await expect(editor).not.toContainText(PROOFREAD_TYPO_QUOTE)
  await expect(editor).not.toContainText(PROOFREAD_DOUBLED_QUOTE)
  const typoSpan = editor
    .locator('.ai-origin[data-proposal-id]')
    .filter({ hasText: PROOFREAD_TYPO_FIX })
  await expect(typoSpan).toHaveCount(1)
  const proofreadProposalId = await typoSpan.getAttribute('data-proposal-id')
  expect(proofreadProposalId).toBeTruthy()
  await expect(editor.locator(`.ai-origin[data-proposal-id="${proofreadProposalId}"]`)).toHaveText([
    PROOFREAD_TYPO_FIX,
    PROOFREAD_DOUBLED_FIX
  ])
  await expect
    .poll(async () => ((await documentText(scene1Row.id)) ?? '').includes(PROOFREAD_CORRECTED), {
      timeout: 3000
    })
    .toBe(true)
  const afterProofread = await usageSummary()
  expect(afterProofread.byFeature.find((f) => f.feature === 'proofread')).toMatchObject({
    requests: 1
  })
  await proofreadPanel.getByTestId('proofread-close').click()
  await expect(proofreadPanel).toHaveCount(0)

  // F-14.15: edit passes. A sentence with a doubled word is typed at the end of Scene 1. The
  // Edits tab's New edit pass opens the workspace with the open scene ticked; a Proofread pass
  // sends it once (the fake server answers two changes, one quoting a passage that is not in the
  // scene, which main drops) and its report opens in the main pane. Back in the scene the kept
  // change is a tracked change: the passage struck through, the replacement after it. A Custom
  // pass with its own instruction sends the instruction; Accept in its report applies the change
  // with the scene closed, as AI-origin text; the proofread change, whose passage is gone, no
  // longer shows. Both reports are listed under Edit reports.
  await dismissToasts()
  await caretToEnd(editor)
  await page.keyboard.type(EDIT_PASS_TYPED)
  await expect
    .poll(async () => ((await documentText(scene1Row.id)) ?? '').includes(EDIT_PASS_TYPED.trim()), {
      timeout: 3000
    })
    .toBe(true)
  const editPassBodies = (): (typeof openAiChatBodies)[number][] =>
    openAiChatBodies.filter((body) => body.messages[0]?.content.startsWith(EDIT_PASS_SENTINEL))
  const editPassRequestsBefore = editPassBodies().length
  await showSection('Edits')
  await page.getByTestId('edit-pass-new').click()
  const workspace = page.getByTestId('edit-pass-workspace')
  await expect(workspace).toBeVisible()
  await workspace.getByRole('radio', { name: 'Proofread' }).check()
  await expect(workspace.getByTestId('edit-pass-estimate')).toContainText('1 scene')
  await expect(workspace.getByTestId('edit-pass-estimate-ai')).toContainText('With MythScribe')
  await workspace.getByTestId('edit-pass-start').click()
  const report = page.getByTestId('edit-report')
  await expect(report).toBeVisible()
  await expect(report.getByTestId('edit-report-title')).toHaveText('Proofread')
  expect(editPassBodies().length).toBe(editPassRequestsBefore + 1)
  expect(editPassBodies().at(-1)?.messages[1]?.content).toContain(EDIT_PASS_TYPED.trim())
  await expect(report.getByTestId('edit-report-counts')).toContainText('1 to review')
  await expect(report.getByTestId('edit-report-counts')).toContainText('1 discarded')
  await expect(report.getByTestId('edit-report-diff')).toHaveCount(1)
  await expect(report.getByTestId('edit-report-cost')).toContainText('gpt-5.4-mini')

  await showSection('Manuscript')
  await scene1.click()
  await expect(report).toHaveCount(0)
  await expect(editor.locator('.tracked-del')).toHaveText(EDIT_PASS_QUOTE)
  await expect(editor.locator('.tracked-ins')).toHaveText(EDIT_PASS_REPLACEMENT)
  await expect(page.getByTestId('tracked-changes-count')).toHaveText(
    '1 tracked change from an edit pass'
  )
  // One change at a time (2026-10-08, the review deck): "Review one by one" opens the deck as a
  // strip above the scene, the change on its card; S keeps it for later, the end offers it
  // again, and Stop reviewing puts the bar back with the change still there.
  await page.getByTestId('tracked-changes-review').click()
  const editReview = page.getByTestId('edit-review')
  await expect(editReview.getByTestId('review-position')).toHaveText('Change 1 of 1')
  await expect(editReview.getByTestId('edit-review-diff')).toContainText(EDIT_PASS_QUOTE)
  // The editor jumped to the change: it is on screen, highlighted, while the keys stay on the deck.
  await expect(editor.locator('.tracked-del')).toBeInViewport()
  await page.keyboard.press('s')
  await expect(editReview.getByTestId('review-done')).toContainText('0 accepted · 1 skipped')
  await editReview.getByTestId('edit-review-close').click()
  await expect(editReview).toHaveCount(0)
  await expect(page.getByTestId('tracked-changes-count')).toHaveText(
    '1 tracked change from an edit pass'
  )
  await expect(editor.locator('.tracked-del')).toHaveText(EDIT_PASS_QUOTE)

  await showSection('Edits')
  await page.getByTestId('edit-pass-new').click()
  await workspace.getByRole('radio', { name: 'Custom pass' }).check()
  await workspace.getByTestId('edit-pass-instruction').fill('Cut every doubled word.')
  await workspace.getByTestId('edit-pass-start').click()
  await expect(report.getByTestId('edit-report-title')).toHaveText(
    'Custom pass: Cut every doubled word.'
  )
  expect(editPassBodies().length).toBe(editPassRequestsBefore + 2)
  expect(editPassBodies().at(-1)?.messages[1]?.content).toContain('Cut every doubled word.')
  await report.getByTestId('edit-report-accept').click()
  await expect(report.getByTestId('edit-report-change')).toHaveAttribute('data-status', 'accepted')
  await expect
    .poll(
      async () =>
        ((await documentText(scene1Row.id)) ?? '').includes(
          EDIT_PASS_TYPED.trim().replace(EDIT_PASS_QUOTE, EDIT_PASS_REPLACEMENT)
        ),
      { timeout: 3000 }
    )
    .toBe(true)
  await expect(page.getByTestId('edit-report-row')).toHaveCount(2)
  await showSection('Manuscript')
  await scene1.click()
  await expect(editor.locator('.ai-origin').filter({ hasText: EDIT_PASS_REPLACEMENT })).toHaveCount(
    1
  )
  await expect(editor.locator('.tracked-del')).toHaveCount(0)
  await expect(page.getByTestId('tracked-changes-bar')).toHaveCount(0)
  const afterEditPasses = await usageSummary()
  expect(afterEditPasses.byFeature.find((f) => f.feature === 'editPass')).toMatchObject({
    requests: 2
  })

  // F-5.6: scene summaries. With the toggle back on, the metadata pane's Summary disclosure
  // shows Scene 1 has none yet (out of date: the text is long past the floor). Summarize now
  // asks the fast tier once and shows the summary, key points, and characters; a sentence
  // typed afterwards is saved, and main's debounce summarises again in the background without
  // a click, clearing the out-of-date hint. Both runs land in the ledger under `summary`.
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await summaryToggle.check()
  await expect.poll(async () => (await aiSettings()).features.summary).toBe(true)
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  const summaryRequestsBefore = openAiRequests.length
  await showSceneDetails()
  await metadata.getByRole('button', { name: 'Summary' }).click()
  await expect(metadata.getByTestId('summary-empty')).toBeVisible()
  await expect(metadata.getByTestId('summary-status')).toHaveText('Out of date')
  await metadata.getByTestId('summary-refresh').click()
  await expect(metadata.getByTestId('summary-text')).toHaveText(SUMMARY_TEXT)
  await expect(metadata.getByTestId('summary-key-points').getByRole('listitem')).toHaveText(
    SUMMARY_KEY_POINTS
  )
  await expect(metadata.getByTestId('summary-characters').getByRole('listitem')).toHaveText(
    SUMMARY_CHARACTERS
  )
  await expect(metadata.getByTestId('summary-status')).toHaveText('')
  // F-9.14: the scene card heads the summary: what the AI read (where, when, POV, what changed,
  // the thread it opened), each AI value marked, unless the author's own scene metadata says.
  const sceneCard = metadata.getByTestId('scene-card')
  await expect(sceneCard).toContainText(SUMMARY_CARD.changed)
  await expect(sceneCard.getByRole('list', { name: 'Threads in this scene' })).toHaveText(
    `${SUMMARY_THREAD} · opened`
  )
  expect(openAiRequests).toHaveLength(summaryRequestsBefore + 1)
  const summarySystem = openAiChatBodies.at(-1)?.messages[0]
  expect(summarySystem?.role).toBe('system')
  expect(summarySystem?.content.startsWith(SUMMARY_SENTINEL)).toBe(true)
  // F-4.13: the same request tagged the scene. The new name is in the tag bar with the "Added
  // by AI" mark, without a click; the character the scene never names and the tone the text
  // never holds (the author's tag rule) were not created. One click takes the tag off, and it
  // stays in the bank.
  const aiChip = tagBar.locator('li[data-ai="true"]').filter({ hasText: 'harbour-bell' })
  await expect(aiChip).toBeVisible()
  await expect(aiChip.getByTestId('tag-ai-mark')).toHaveText('Added by AI')
  expect((await listTags()).some((tag) => tag.name === 'zephyr')).toBe(false)
  expect((await listTags()).some((tag) => tag.name === 'stormbound')).toBe(false)
  await aiChip.getByRole('button', { name: 'Remove harbour-bell' }).click()
  await expect(aiChip).toHaveCount(0)
  await caretToEnd(editor)
  await page.keyboard.type(' She counted the boats twice.')
  await expect(metadata.getByTestId('summary-status')).toHaveText('Updating…')
  await expect
    .poll(() => openAiRequests.length, { timeout: 15_000 })
    .toBe(summaryRequestsBefore + 2)
  await expect(metadata.getByTestId('summary-status')).toHaveText('')
  await expect(metadata.getByTestId('summary-text')).toHaveText(SUMMARY_TEXT)
  // F-4.13: the background run answered the same tag again; a tag the author took off this
  // scene is never re-applied to it, and nothing of it is in the manuscript.
  // (The Mentions list still names it: the scene says "Harbour Bell".)
  await expect(
    tagBar
      .getByRole('list', { name: 'Document tags' })
      .getByRole('listitem')
      .filter({ hasText: 'harbour-bell' })
  ).toHaveCount(0)
  expect((await listTags()).find((tag) => tag.name === 'harbour-bell')).toMatchObject({
    usageCount: 0
  })
  await expect(editor).not.toContainText('harbour-bell')
  const afterSummary = await usageSummary()
  expect(afterSummary.byFeature.find((f) => f.feature === 'summary')).toMatchObject({
    requests: 2
  })

  // F-5.16, F-9.13: the automatic story bible. The summary answer carried two facts, and no
  // entity was left in the project, so main created both characters as AI-made blank pages with
  // their tags. Kael is listed in the Characters tab marked "Added by AI"; his page shows the
  // dated fact under "From the scenes" with the AI mark, and its passage button opens Scene 1
  // with the quoted sentence selected (nothing is typed, so the scene reads as it did). Back on
  // his page, the author writes on the page themselves (the AI never does, D1), which makes the
  // sheet theirs. Then the Changes section lists the fact the reading added, and Undo hides it
  // for good. No request is made by any of it.
  const factRequestsBefore = openAiRequests.length
  await expect
    .poll(async () =>
      (await listEntities())
        .filter((entity) => entity.kind === 'character')
        .map((entity) => `${entity.name}:${entity.origin}:${entity.template}`)
    )
    .toEqual(['Kael:ai:blank', 'Mara:ai:blank'])
  const kaelEntity = (await listEntities()).find((entity) => entity.name === 'Kael')
  if (!kaelEntity) throw new Error('Kael was not created')
  expect((await listTags()).find((tag) => tag.name === 'kael')).toMatchObject({
    category: 'character'
  })
  await showSection('Characters')
  const kaelRow = characterRows.getByRole('button', { name: /^Kael/ })
  await expect(kaelRow).toContainText('Added by AI')
  await kaelRow.click()
  await expect(entityEditor).toBeVisible()
  await expect(entityEditor).toContainText('Character · Blank page · Added by AI')
  const observedFacts = entityEditor.getByRole('region', { name: 'From the scenes' })
  const watchfulRow = observedFacts.getByRole('listitem', { name: 'Personality: Watchful' })
  await expect(watchfulRow).toBeVisible()
  await expect(watchfulRow.getByTestId('fact-ai-mark')).toHaveText('AI')
  await expect(watchfulRow).toContainText('From Scene 1')
  await watchfulRow.getByRole('button', { name: 'Go to passage in Scene 1' }).click()
  await expect(entityEditor).toHaveCount(0)
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''), { timeout: 5_000 })
    .toBe(SUMMARY_FACTS[1]?.quote)
  await kaelRow.click()
  await expect(entityEditor).toBeVisible()
  await entityEditor.getByRole('textbox', { name: 'Page' }).fill('Personality: Watchful')
  await expect(entityEditor).not.toContainText('Added by AI')
  await expect(kaelRow).not.toContainText('Added by AI')
  await expect
    .poll(async () => (await listEntities()).find((entity) => entity.id === kaelEntity.id))
    .toMatchObject({ origin: 'author', body: 'Personality: Watchful' })
  // The AI's fact is still there beside the author's words, not merged into them.
  await expect(watchfulRow).toBeVisible()
  await showSection('Changes')
  const changesTab = page.getByTestId('changes-tab')
  const watchfulChange = changesTab.getByRole('listitem', {
    name: 'Fact: Kael · Personality: Watchful'
  })
  await expect(watchfulChange).toContainText(SUMMARY_FACTS[1]?.quote ?? '')
  await expect(changesTab.getByRole('listitem', { name: 'New sheet: Kael' })).toBeVisible()
  await watchfulChange.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(watchfulChange).toContainText('Undone')
  await expect(watchfulRow).toHaveCount(0)
  await expect(entityEditor.getByRole('button', { name: 'Show hidden (1)' })).toBeVisible()
  await expect
    .poll(async () => (await fieldFactsOf(kaelEntity.id)).map((fact) => fact.hidden))
    .toEqual([true])
  // F-9.14: the same reading stated that Kael is Mara's rival. His sheet lists it from his side,
  // marked as the AI's with the scene; Changes lists it, and Undo hides it for good.
  const relationships = entityEditor.getByRole('region', { name: 'Relationships' })
  const rivalRow = relationships.getByRole('listitem', { name: 'Rival of Mara' })
  await expect(rivalRow.getByTestId('relation-ai-mark')).toHaveText('AI')
  await expect(rivalRow).toContainText('From Scene 1')
  const rivalChange = changesTab.getByRole('listitem', { name: 'Fact: Kael · Rival of Mara' })
  await rivalChange.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(rivalChange).toContainText('Undone')
  await expect(rivalRow).toHaveCount(0)
  await expect(relationships).toContainText('None yet.')
  // And the Threads section lists the thread the reading opened, with its open question.
  await expect(
    changesTab.getByRole('listitem', { name: `New sheet: ${SUMMARY_THREAD}` })
  ).toBeVisible()
  await entityEditor.getByRole('button', { name: 'Close Kael' }).click()
  await expect(entityEditor).toHaveCount(0)
  await showSection('Threads')
  const openThreads = page.getByTestId('threads-tab').getByRole('region', { name: 'Open threads' })
  const lanternThread = openThreads.getByRole('listitem', { name: SUMMARY_THREAD })
  await expect(lanternThread.getByTestId('thread-question')).toHaveText(SUMMARY_THREAD_QUESTION)
  await expect(lanternThread).toContainText('Set up in Scene 1')
  await expect(page.getByTestId('threads-counts')).toHaveText('1 open')
  await showSection('Characters')
  await kaelRow.click()
  await expect(entityEditor).toBeVisible()
  expect(openAiRequests).toHaveLength(factRequestsBefore)
  // Back to Scene 1 for the steps below; the entity page replaced the scene's panes, so the
  // Summary disclosure is closed again and is reopened here.
  await entityEditor.getByRole('button', { name: 'Close Kael' }).click()
  await expect(entityEditor).toHaveCount(0)
  await showSection('Manuscript')
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await showSceneDetails()
  await metadata.getByRole('button', { name: 'Summary' }).click()
  await expect(metadata.getByTestId('summary-text')).toHaveText(SUMMARY_TEXT)

  // F-5.13: the background index queue. "Summarize all scenes" queues every scene whose summary
  // is missing or out of date and works through them one at a time, at most one request at a
  // time. With the toggle off for a moment, Scene 1 is edited without a background run, so
  // exactly one scene is stale when the button is clicked; its request lands in the ledger
  // under `summary` like any other. A second click has nothing to do: a scene whose content
  // hash still matches costs nothing.
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await summaryToggle.uncheck()
  await expect.poll(async () => (await aiSettings()).features.summary).toBe(false)
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  const indexRequestsBefore = openAiRequests.length
  await caretToEnd(editor)
  await page.keyboard.type(' The ferryman kept his lamp lit.')
  await expect
    .poll(() => documentText(scene1Row.id), { timeout: 5_000 })
    .toContain('The ferryman kept his lamp lit.')
  // Summaries are off, so the save queued nothing.
  expect(openAiRequests).toHaveLength(indexRequestsBefore)

  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await summaryToggle.check()
  await expect.poll(async () => (await aiSettings()).features.summary).toBe(true)
  const summarizeAll = settingsDialog.getByTestId('summarize-all')
  await expect(summarizeAll).toBeEnabled()
  await summarizeAll.click()
  await expect(page.getByRole('status').filter({ hasText: 'Queued 1 scene' })).toBeVisible()
  await expect.poll(() => openAiRequests.length, { timeout: 15_000 }).toBe(indexRequestsBefore + 1)
  // The queue is empty again, so the header indicator says nothing at all.
  await expect(page.getByTestId('indexing')).toHaveCount(0)
  await summarizeAll.click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Every scene is up to date' })
  ).toBeVisible()
  expect(openAiRequests).toHaveLength(indexRequestsBefore + 1)
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await expect(metadata.getByTestId('summary-status')).toHaveText('')
  // The two toasts this step raised would otherwise stack over the panels the steps below use.
  await dismissToasts()
  const afterIndexAll = await usageSummary()
  expect(afterIndexAll.byFeature.find((f) => f.feature === 'summary')).toMatchObject({
    requests: 3
  })
  // F-5.16, F-9.13: that run read Scene 1 again and its answer carried the same two facts. The
  // one undone in Changes is a tombstone, so it was not logged a second time; Mara's stayed
  // (sticky), and no third character appeared. F-9.14: the undone relationship stays hidden too.
  await expect
    .poll(async () => (await fieldFactsOf(kaelEntity.id)).map((fact) => fact.hidden))
    .toEqual([true])
  expect(
    (await factsOf(kaelEntity.id))
      .filter((fact) => fact.objectEntityId !== null)
      .map((fact) => fact.hidden)
  ).toEqual([true])
  expect(
    (await listEntities())
      .filter((entity) => entity.kind === 'character')
      .map((entity) => entity.name)
  ).toEqual(['Kael', 'Mara'])
  await showSection('Characters')
  await kaelRow.click()
  await expect(entityEditor.getByRole('button', { name: 'Show hidden (1)' })).toBeVisible()
  await expect(observedFacts).toHaveCount(0)
  await entityEditor.getByRole('button', { name: 'Close Kael' }).click()
  await expect(entityEditor).toHaveCount(0)
  await showSection('Manuscript')
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')

  // F-9.7: in this scene. Scene 1 names Kael and Mara, so the References panel opens with a card
  // for each above the pins, with no pin and no click; Kael's shows what his page holds. Pin
  // moves his card to the pins, where it stays when Opening (which names no one) is opened.
  // No request is made by any of it. The pin and the panel are then put back.
  const sceneRequestsBefore = openAiRequests.length
  await page.getByRole('button', { name: 'References', exact: true }).click()
  const inThisScene = referencesPanel.getByRole('list', { name: 'In this scene' })
  // The cards by their labels: a card's observed facts carry a heading and list items of their own.
  const sceneTitles = (): Promise<(string | null)[]> =>
    inThisScene
      .locator(':scope > li')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('aria-label')))
  await expect.poll(sceneTitles).toEqual(['Kael', 'Mara'])
  await expect(inThisScene.getByRole('listitem', { name: 'Kael', exact: true })).toContainText(
    'Personality: Watchful'
  )
  await expect(inThisScene.getByRole('listitem', { name: 'Mara', exact: true })).toContainText(
    'Waits out the storm'
  )
  await expect(referencesPanel.getByText('Nothing pinned yet.')).toBeVisible()
  await inThisScene.getByRole('button', { name: 'Pin Kael' }).click()
  await expect.poll(sceneTitles).toEqual(['Mara'])
  await expect(referenceTitles).toHaveText(['Kael'])
  await opening.getByText('Opening', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Opening')
  await expect(inThisScene).toHaveCount(0)
  await expect(
    referencesPanel.getByText('No one from your story bible is named in this scene yet.')
  ).toBeVisible()
  await expect(referenceTitles).toHaveText(['Kael'])
  await scene1.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect.poll(sceneTitles).toEqual(['Mara'])
  await referencesPanel.getByRole('button', { name: 'Unpin Kael' }).click()
  await expect.poll(sceneTitles).toEqual(['Kael', 'Mara'])
  await expect.poll(referencePins).toEqual([])
  expect(openAiRequests).toHaveLength(sceneRequestsBefore)
  await page.getByRole('button', { name: 'References', exact: true }).click()
  await expect(referencesPanel).toHaveCount(0)
  await expect.poll(async () => (await getLayout()).references.open).toBe(false)

  // F-14.11: the beta reader. Reading up to Scene 1 sends the strong tier the scene in full
  // and the stored summaries of the manuscript documents before it: Opening has none (it is
  // under the summary floor), so the reader is told nothing about it and the panel counts it
  // as missing. The fake server's three items shrink to the one whose quote is in Scene 1; the
  // fabricated quote and the item naming an unsent scene are dropped and counted. No voice
  // block and no story bible go out: the reader knows only what is on the page.
  const betaReaderBodiesBefore = openAiChatBodies.length
  if (!(await assistant.isVisible())) await page.keyboard.press('Control+k')
  await sendRouted('Beta reader')
  const betaReaderPanel = page.getByTestId('beta-reader-panel')
  await expect(betaReaderPanel).toBeVisible()
  await expect(betaReaderPanel.getByTestId('beta-reader-item')).toHaveCount(1)
  await expect(betaReaderPanel.getByTestId('beta-reader-item')).toHaveAttribute(
    'data-category',
    'expects'
  )
  await expect(betaReaderPanel.getByTestId('beta-reader-quote')).toHaveText(CRITIQUE_PRAISE_QUOTE)
  await expect(betaReaderPanel).toContainText(BETA_READER_NOTE)
  await expect(betaReaderPanel).not.toContainText(CRITIQUE_FABRICATED_QUOTE)
  await expect(betaReaderPanel.getByTestId('beta-reader-dropped')).toHaveText(
    '2 uncited items dropped'
  )
  await expect(betaReaderPanel.getByTestId('beta-reader-missing')).toContainText(
    '1 earlier scene has no summary yet'
  )
  expect(openAiChatBodies).toHaveLength(betaReaderBodiesBefore + 1)
  const betaReaderSystem = openAiChatBodies.at(-1)?.messages[0]
  expect(betaReaderSystem?.role).toBe('system')
  expect(betaReaderSystem?.content.startsWith(BETA_READER_SENTINEL)).toBe(true)
  expect(betaReaderSystem?.content).toContain('Be specific and direct')
  expect(betaReaderSystem?.content).not.toContain(STORY_BIBLE_HEADING)
  const betaReaderUser = openAiChatBodies.at(-1)?.messages[1]
  expect(betaReaderUser?.content).toContain('No earlier scenes.')
  expect(betaReaderUser?.content).toContain('[1] Chapter 1 › Scene 1 (this scene, full text)')
  expect(betaReaderUser?.content).toContain(CRITIQUE_PRAISE_QUOTE)
  const afterBetaReader = await usageSummary()
  expect(afterBetaReader.byFeature.find((f) => f.feature === 'betaReader')).toMatchObject({
    requests: 1
  })
  await betaReaderPanel.getByTestId('beta-reader-close').click()
  await expect(betaReaderPanel).toHaveCount(0)

  // F-5.7, F-5.22: Story Intelligence on the chat agent. A question in Plan (2026-10-07: Query
  // mode is gone) runs the read-only agent about the whole project: it looks first (a search, shown live as a step on the waiting turn), then
  // answers, and its citations are checked against the documents. The fabricated quote and the
  // one naming no document are dropped, and the `[3]` marker they left behind is stripped.
  // Clicking the surviving citation opens the scene and selects the passage in the editor.
  await dismissToasts()
  await expect(assistant).toBeVisible()
  // The proofread and beta-reader turns above are in the current conversation: start a fresh one.
  await assistant.getByRole('button', { name: 'New conversation', exact: true }).click()
  await expect(turns).toHaveCount(0)
  const queryBodiesBefore = openAiChatBodies.length
  // Every chat message runs the agent since 2026-10-07, so count from here.
  const agentRequestsBefore =
    (await usageSummary()).byFeature.find((f) => f.feature === 'agent')?.requests ?? 0
  const planRadio = assistant.getByRole('radio', { name: 'Plan' })
  await planRadio.click()
  await expect(planRadio).toHaveAttribute('aria-checked', 'true')
  await messageBox.fill(QUERY_QUESTION)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(2)
  const queryTurn = turns.nth(1)
  await expect(queryTurn).toContainText(QUERY_ANSWER_KEPT)
  await expect(queryTurn).not.toContainText('[3]')
  await expect(queryTurn.getByTestId('query-not-found')).toHaveCount(0)
  await expect(queryTurn.getByTestId('query-uncited')).toHaveCount(0)
  const citation = queryTurn.getByTestId('query-citation')
  await expect(citation).toHaveCount(1)
  await expect(citation).toContainText(CRITIQUE_PRAISE_QUOTE)
  await expect(citation).toContainText('Chapter 1 › Scene 1')
  await expect(queryTurn).not.toContainText(CRITIQUE_FABRICATED_QUOTE)
  await expect(queryTurn.getByTestId('chat-turn-cost')).toContainText('gpt-5.4 ·')
  // The lookup it made folds away under the answer.
  await expect(queryTurn.getByText('Looked up one thing')).toBeVisible()
  // The router's request, then the agent's two steps.
  expect(openAiChatBodies).toHaveLength(queryBodiesBefore + 3)
  const querySystem = openAiChatBodies.at(-2)?.messages[0]
  expect(querySystem?.role).toBe('system')
  expect(querySystem?.content.startsWith(CHAT_AGENT_SENTINEL)).toBe(true)
  // F-5.23: the story map, with now on the open scene, and the search result's position.
  expect(querySystem?.content).toContain(STORY_MAP_HEADING)
  expect(querySystem?.content).toMatch(/n\d+ Scene 1 \[(drafted|revised)\] ▶ NOW/)
  expect(openAiChatBodies.at(-2)?.messages.at(-1)?.content).toBe(QUERY_QUESTION)
  expect(openAiChatBodies.at(-1)?.messages.at(-1)?.content).toMatch(
    /^Result of find_passages:\nn\d+ ¶\d+ \((now|before now|after now)[^)]*\): /
  )
  const afterQuery = await usageSummary()
  expect(afterQuery.byFeature.find((f) => f.feature === 'agent')).toMatchObject({
    requests: agentRequestsBefore + 2
  })
  // The citation opens its scene and selects the cited passage there.
  await citation.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''), { timeout: 5_000 })
    .toBe(CRITIQUE_PRAISE_QUOTE)
  // A recap is a question in the chat (2026-10-06: the What happened here? action left with
  // the Actions menu). The open scene rides along; the canned answer's citation survives.
  const recapBodiesBefore = openAiChatBodies.length
  await messageBox.fill(RECAP_QUESTION)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(4)
  await expect(turns.nth(2)).toContainText(RECAP_QUESTION)
  await expect(turns.nth(3)).toContainText(QUERY_ANSWER_KEPT)
  await expect(turns.nth(3).getByTestId('query-citation')).toContainText('Chapter 1 › Scene 1')
  expect(openAiChatBodies).toHaveLength(recapBodiesBefore + 3)
  expect(openAiChatBodies.at(-2)?.messages.at(-1)?.content).toBe(RECAP_QUESTION)
  expect(openAiChatBodies.at(-2)?.messages[0]?.content).toMatch(
    /Open document n\d+: Chapter 1 › Scene 1 \(scene\)/
  )
  // A question the author's own sheet answers. Wren's appearance is only on her sheet; the agent
  // reads it, cites it, and the panel lists it under "From your notes" instead of flagging the
  // answer as uncited. A sheet the model invents is ignored.
  const wren = await page.evaluate(
    (appearance) =>
      window.mythscribe.invoke('entity:create', {
        kind: 'character',
        name: 'Wren',
        fields: { appearance }
      }) as Promise<IpcResult<Entity>>,
    SHEET_APPEARANCE
  )
  if (!wren.ok) throw new Error(`entity:create failed: ${wren.error.message}`)
  await messageBox.fill(SHEET_QUESTION)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(6)
  const sheetTurn = turns.nth(5)
  await expect(sheetTurn).toContainText('Wren has grey eyes')
  await expect(sheetTurn.getByTestId('query-uncited')).toHaveCount(0)
  await expect(sheetTurn.getByText('From your notes')).toBeVisible()
  await expect(sheetTurn.getByTestId('query-sheet')).toHaveText(['Wren'])
  expect(openAiChatBodies.at(-1)?.messages.at(-1)?.content).toContain(
    `appearance (Appearance): ${SHEET_APPEARANCE}`
  )
  // F-5.24: the lookup ladder. The agent looks Wren up (her record at now, ≤ 1,200 characters),
  // then finds passages in the local index, then answers citing a snippet's words; the step
  // labels show live, and the citation selects the passage in its scene.
  const ladderBodiesBefore = openAiChatBodies.length
  await messageBox.fill(LOOKUP_QUESTION)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(8)
  const ladderTurn = turns.nth(7)
  await expect(ladderTurn).toContainText('Wren watched the storm from the window')
  // The router's request, then the agent's three steps.
  expect(openAiChatBodies).toHaveLength(ladderBodiesBefore + 4)
  expect(openAiChatBodies.at(-2)?.messages.at(-1)?.content).toMatch(
    /^Result of lookup:\nWren \(character\) \[canon\]; as of /
  )
  expect(openAiChatBodies.at(-1)?.messages.at(-1)?.content).toMatch(
    /^Result of find_passages:\nn\d+ ¶\d+ \(/
  )
  expect(lookupQuote.length).toBeGreaterThan(10)
  await ladderTurn.getByText('Looked up 2 things').click()
  await expect(ladderTurn.getByTestId('agent-step')).toHaveText([
    'Looking up Wren…',
    'Finding passages…'
  ])
  const ladderCitation = ladderTurn.getByTestId('query-citation')
  await expect(ladderCitation).toHaveCount(1)
  await ladderCitation.click()
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''), { timeout: 5_000 })
    .toBe(lookupQuote)
  const removed = await page.evaluate(
    (id) => window.mythscribe.invoke('entity:delete', { id }) as Promise<IpcResult<null>>,
    wren.data.id
  )
  if (!removed.ok) throw new Error(`entity:delete failed: ${removed.error.message}`)

  // F-5.22 under the chat modes (2026-10-07): the chat edits the book. In Ask a message the
  // router sends to chat comes back with its edit waiting: the current text struck through, the
  // new text marked, Apply and Skip. Apply changes Scene 1 in the editor (AI-origin marked) and
  // leaves a log line with Undo, which puts it back. In Auto the same message applies its edit
  // at once. Back to Ask, the text restored, for the steps below.
  await assistant.getByRole('button', { name: 'New conversation', exact: true }).click()
  await expect(turns).toHaveCount(0)
  await assistant.getByRole('radio', { name: 'Ask', exact: true }).click()
  await expect.poll(async () => (await aiSettings()).chatMode).toBe('ask')
  await messageBox.fill(AGENT_EDIT_MESSAGE)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(2)
  const editTurn = turns.nth(1)
  await expect(editTurn).toContainText(AGENT_EDIT_ANSWER)
  const editCard = editTurn.getByTestId('agent-change')
  await expect(editCard).toHaveAttribute('data-status', 'pending')
  await expect(editCard.locator('del').first()).toBeVisible()
  await expect(editCard.locator('ins').first()).toBeVisible()
  const sceneBefore = await documentTextWithoutGhost()
  expect(sceneBefore).not.toContain(AGENT_EDIT_REPLACEMENT)
  // The lookups it made fold away under the answer and open on a click.
  await editTurn.getByText('Looked up 2 things').click()
  await expect(editTurn.getByTestId('agent-step')).toHaveText([
    'Finding passages…',
    'Reading Chapter 1 › Scene 1…'
  ])
  await editCard.getByTestId('agent-change-apply').click()
  await expect(editCard).toHaveAttribute('data-status', 'applied')
  await expect(editCard).toContainText(`Changed Chapter 1 › Scene 1: “${AGENT_EDIT_REPLACEMENT}”`)
  await expect(editor).toContainText(AGENT_EDIT_REPLACEMENT)
  await expect(editor.locator('.ai-origin', { hasText: AGENT_EDIT_REPLACEMENT })).toHaveCount(1)
  await editCard.getByTestId('agent-change-undo').click()
  await expect(editCard).toHaveAttribute('data-status', 'undone')
  await expect.poll(() => documentTextWithoutGhost()).toBe(sceneBefore)
  await assistant.getByRole('radio', { name: 'Auto', exact: true }).click()
  await expect.poll(async () => (await aiSettings()).chatMode).toBe('auto')
  await messageBox.fill(AGENT_EDIT_MESSAGE)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(4)
  const autoCard = turns.nth(3).getByTestId('agent-change')
  await expect(autoCard).toHaveAttribute('data-status', 'applied')
  await expect(editor).toContainText(AGENT_EDIT_REPLACEMENT)
  await autoCard.getByTestId('agent-change-undo').click()
  await expect(autoCard).toHaveAttribute('data-status', 'undone')
  await expect.poll(() => documentTextWithoutGhost()).toBe(sceneBefore)
  await assistant.getByRole('radio', { name: 'Ask', exact: true }).click()
  await expect.poll(async () => (await aiSettings()).chatMode).toBe('ask')

  // F-11.1d: the outline marks each row Planned, Drafted, or Revised (Scene 1 has text, the
  // empty scenes of the other chapters are plans). With Plan links on, Find links asks the fast
  // tier once; at Ask its link waits on the planned scene's row as a suggestion, Confirm links
  // it ("Fulfilled by Scene 1"), and Unlink takes it off again. Then the toggle goes back off.
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await planLinksToggle.check()
  await expect.poll(async () => (await aiSettings()).features.planLinks).toBe(true)
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await showSection('Outline')
  const planPanel = page.getByRole('region', { name: 'Outline section', exact: true })
  const outlineRows = planPanel.getByTestId('outline-row')
  await expect(outlineRows.filter({ hasText: 'Scene 1' }).first()).toHaveAttribute(
    'data-progress',
    /drafted|revised/
  )
  await expect(
    planPanel.locator('[data-testid="outline-row"][data-progress="planned"]').first()
  ).toBeVisible()
  await expect(planPanel.getByTestId('outline-progress')).toContainText('planned')
  const planRequestsBefore = openAiChatBodies.length
  await planPanel.getByTestId('outline-find-links').click()
  const planSuggestion = planPanel.getByTestId('plan-suggestion')
  await expect(planSuggestion).toHaveCount(1)
  await expect(planSuggestion).toContainText(PLAN_LINK_WHY)
  expect(openAiChatBodies).toHaveLength(planRequestsBefore + 1)
  expect(openAiChatBodies.at(-1)?.messages[0]?.content.startsWith(PLAN_LINKS_SENTINEL)).toBe(true)
  await planSuggestion.getByRole('button', { name: 'Confirm' }).click()
  const fulfilledLine = planPanel.getByTestId('outline-fulfilled')
  await expect(fulfilledLine).toHaveCount(1)
  await expect(fulfilledLine).toContainText('Fulfilled by')
  await expect(planSuggestion).toHaveCount(0)
  await expect(planPanel.getByTestId('outline-fulfils')).toHaveCount(1)
  await fulfilledLine.getByRole('button', { name: 'Unlink' }).click()
  await expect(fulfilledLine).toHaveCount(0)
  await showSection('Manuscript')
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await planLinksToggle.uncheck()
  await expect.poll(async () => (await aiSettings()).features.planLinks).toBe(false)
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await dismissToasts()

  // 2026-10-07 (the author's report: chat insertions never reached the editor): the agent
  // answers an insertion as a brief (agent.v2) and its answer streams into the turn; the app
  // drafts the prose and it lands as ghost text right after the sentence the agent named (the
  // fake picks one Scene 1 holds once), with the card mirroring it. Tab accepts it into the
  // document, AI-origin marked; the card's Undo takes it out again. The same in focus mode,
  // from the floating assistant.
  await assistant.getByRole('button', { name: 'New conversation', exact: true }).click()
  await expect(turns).toHaveCount(0)
  const beforeInsert = await documentTextWithoutGhost()
  await messageBox.fill(AGENT_INSERT_MESSAGE)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(2)
  const insertHereTurn = turns.nth(1)
  await expect(insertHereTurn).toContainText(AGENT_INSERT_HERE_ANSWER)
  const insertHereCard = insertHereTurn.getByTestId('agent-change')
  await expect(insertHereCard).toHaveAttribute('data-status', 'shown')
  expect(insertAnchor.length).toBeGreaterThan(0)
  const ghostParagraph = editor.locator('p', { has: page.locator('.ghost-text') })
  await expect(ghostParagraph).toHaveCount(1)
  await expect(ghostParagraph).toContainText(insertAnchor)
  await expect(editor.locator('.ghost-text')).toContainText(AGENT_FIRST)
  await editor.focus()
  await page.keyboard.press('Tab')
  await expect(insertHereCard).toHaveAttribute('data-status', 'applied')
  const afterInsert = await documentTextWithoutGhost()
  expect(afterInsert).toContain(AGENT_SECOND)
  expect(afterInsert.indexOf(insertAnchor)).toBeLessThan(afterInsert.indexOf(AGENT_FIRST))
  await insertHereCard.getByTestId('agent-change-undo').click()
  await expect(insertHereCard).toHaveAttribute('data-status', 'undone')
  await expect.poll(() => documentTextWithoutGhost()).toBe(beforeInsert)
  // Focus mode: the same editor, the assistant floating beside it.
  await editor.click()
  await page.keyboard.press('F11')
  await expect.poll(isFullScreen).toBe(true)
  const focusBar = page.getByTestId('focus-control-bar')
  const focusSize = await fullscreenViewport()
  await page.mouse.move(focusSize.w / 2, focusSize.h - 8)
  await expect(focusBar).toHaveAttribute('data-visible', 'true')
  await focusBar.getByRole('button', { name: 'AI assistant' }).click()
  const floatingAssistant = page.getByRole('dialog', { name: 'Assistant' })
  await expect(floatingAssistant).toBeVisible()
  const floatingTurns = floatingAssistant.locator('[data-testid="chat-turn"]')
  const turnsBeforeFocus = await floatingTurns.count()
  const floatingBox = floatingAssistant.getByRole('textbox', { name: 'Message' })
  await floatingBox.fill(AGENT_INSERT_MESSAGE)
  await floatingBox.press('Enter')
  await expect(floatingTurns).toHaveCount(turnsBeforeFocus + 2)
  const focusCard = floatingTurns.last().getByTestId('agent-change')
  await expect(focusCard).toHaveAttribute('data-status', 'shown')
  await expect(editor.locator('p', { has: page.locator('.ghost-text') })).toContainText(
    insertAnchor
  )
  await editor.focus()
  await page.keyboard.press('Tab')
  await expect(focusCard).toHaveAttribute('data-status', 'applied')
  await expect(editor).toContainText(AGENT_SECOND)
  await focusCard.getByTestId('agent-change-undo').click()
  await expect(focusCard).toHaveAttribute('data-status', 'undone')
  await expect.poll(() => documentTextWithoutGhost()).toBe(beforeInsert)
  await page.mouse.move(focusSize.w / 2, focusSize.h - 8)
  await expect(focusBar).toHaveAttribute('data-visible', 'true')
  await focusBar.getByRole('button', { name: 'AI assistant' }).click()
  await focusBar.getByRole('button', { name: 'Exit focus mode' }).click()
  await expect.poll(isFullScreen).toBe(false)
  await expect(assistant).toBeVisible()
  // Back to the Query conversation the steps below continue.
  await assistant.getByRole('tab', { name: QUERY_QUESTION }).click()
  // Eight turns: the question, the recap, the sheet question, and the lookup-ladder question (F-5.24).
  await expect(turns).toHaveCount(8)

  // F-15.4: MythScribe Cloud does not serve AI yet (`CLOUD_AI_AVAILABLE`, decided by the author
  // 2026-10-07), so no request goes through the fake Worker; the adapter's refusal, the NOT_FOUND
  // message, and the notice for a project still stored on Cloud are unit-tested
  // (`cloud.test.ts`, `AiSettingsTab.test.tsx`). The next question is a Plan one.
  await dismissToasts()
  await assistant.getByRole('radio', { name: 'Plan' }).click()
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(settingsDialog).toBeVisible()

  // F-5.15: a local model. The source switches to Local model, the server address points at an
  // OpenAI-compatible server (the fake provider stands in for Ollama), Test connection reaches
  // it, and a Plan question is answered from it at no cost, logged under the local provider.
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await settingsDialog.getByTestId('ai-source-local').click()
  await expect.poll(async () => (await aiSettings()).source).toBe('local')
  await expect(settingsDialog.getByTestId('ai-local-warning')).toBeVisible()
  const serverAddress = settingsDialog.getByLabel('Server address')
  await serverAddress.fill(fakeOpenAiUrl)
  await settingsDialog
    .getByRole('form', { name: 'Local model server' })
    .getByRole('button', { name: 'Save' })
    .click()
  await expect(settingsDialog.getByText(/Nothing leaves this computer/)).toContainText(
    fakeOpenAiUrl
  )
  await settingsDialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(settingsDialog.getByTestId('ai-test-result')).toContainText('Connected.')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  const localBodiesBefore = openAiChatBodies.length
  await messageBox.fill('What is the storm doing?')
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(10)
  await expect(turns.nth(9)).toContainText(QUERY_ANSWER_KEPT)
  await expect(turns.nth(9).getByTestId('chat-turn-cost')).toContainText('$0.0000')
  // The router's request, then the agent's two steps, all to the local server.
  expect(openAiChatBodies).toHaveLength(localBodiesBefore + 3)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await settingsDialog.getByTestId('ai-source-ownKey').click()
  await expect.poll(async () => (await aiSettings()).source).toBe('ownKey')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  // Back to Off and no key, as the steps above left them.
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await useAi.uncheck()
  await expect.poll(async () => (await aiSettings()).dial).toBe(0)
  await settingsDialog.getByRole('button', { name: 'Clear' }).click()
  await expect(keyHint).toHaveText('No key')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  // F-7.1: the menu bar. The in-app bar is rendered from the same definition as the native
  // menu: Insert › Scene adds a scene after the selection (with inline rename, like the F-2.7
  // chord), View › Notes toggles the panel, Tools › Settings opens the dialog; Help › Keyboard
  // shortcuts (F-7.7) lists every chord and Help › About shows the package version. A menu
  // item's name is its label alone; the chord is decoration. The native menu cannot be clicked
  // from here, so it is checked through Electron: the six top-level labels, File › Save
  // enabled with its accelerator while a project is open, and a native click arriving as a
  // `menu:action` that opens the same dialog.
  const menuBar = page.getByRole('menubar', { name: 'Application menu' })
  await expect(menuBar.getByRole('menuitem')).toHaveText([
    'File',
    'Edit',
    'Insert',
    'View',
    'Tools',
    'Help'
  ])
  await scene1.getByText('Scene 1', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  const scenesBefore = (await listTree()).filter((n) => n.hierarchyLevel === 'scene').length
  await menuBar.getByRole('menuitem', { name: 'Insert' }).click()
  const insertMenu = page.getByRole('menu', { name: 'Insert' })
  // A web novel calls its parts arcs; the chord text rides along in the text, not the name.
  // F-9.3 adds the three story-bible items after the levels.
  await expect(insertMenu.getByRole('menuitem')).toHaveText([
    'SceneCtrl+Shift+S',
    'ChapterCtrl+Shift+C',
    'ArcCtrl+Shift+P',
    'Character',
    'Setting',
    'World-building note',
    'Scene break'
  ])
  await expect(insertMenu.getByRole('menuitem', { name: 'Scene', exact: true })).toHaveAttribute(
    'aria-keyshortcuts',
    'Ctrl+Shift+S'
  )
  await insertMenu.getByRole('menuitem', { name: 'Scene', exact: true }).click()
  await expect(insertMenu).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Rename' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect
    .poll(async () => (await listTree()).filter((n) => n.hierarchyLevel === 'scene').length)
    .toBe(scenesBefore + 1)
  const notesPanel = page.getByTestId('notes-panel')
  const notesOpenBefore = await notesPanel.isVisible()
  await menuBar.getByRole('menuitem', { name: 'View' }).click()
  await page.getByRole('menu', { name: 'View' }).getByRole('menuitem', { name: 'Notes' }).click()
  await expect(notesPanel).toBeVisible({ visible: !notesOpenBefore })
  await expect.poll(async () => (await getLayout()).notes.open).toBe(!notesOpenBefore)
  await menuBar.getByRole('menuitem', { name: 'View' }).click()
  await page.getByRole('menu', { name: 'View' }).getByRole('menuitem', { name: 'Notes' }).click()
  await expect(notesPanel).toBeVisible({ visible: notesOpenBefore })
  await menuBar.getByRole('menuitem', { name: 'Tools' }).click()
  await page
    .getByRole('menu', { name: 'Tools' })
    .getByRole('menuitem', { name: 'Settings' })
    .click()
  await expect(settingsDialog).toBeVisible()
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await menuBar.getByRole('menuitem', { name: 'Help' }).click()
  await page
    .getByRole('menu', { name: 'Help' })
    .getByRole('menuitem', { name: 'Keyboard shortcuts' })
    .click()
  const shortcutsDialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(shortcutsDialog.getByRole('row', { name: /^Insert scene / })).toContainText(
    'Ctrl+Shift+S'
  )
  await expect(shortcutsDialog.getByRole('row', { name: /^Focus mode / })).toContainText('F11')
  await page.keyboard.press('Escape')
  await expect(shortcutsDialog).toHaveCount(0)
  await menuBar.getByRole('menuitem', { name: 'Help' }).click()
  await page
    .getByRole('menu', { name: 'Help' })
    .getByRole('menuitem', { name: 'About MythScribe' })
    .click()
  const aboutDialog = page.getByRole('dialog', { name: 'About MythScribe' })
  const packageVersion = (
    JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string }
  ).version
  await expect(aboutDialog.getByTestId('about-version')).toHaveText(`Version ${packageVersion}`)
  await aboutDialog.getByRole('button', { name: 'OK' }).click()
  await expect(aboutDialog).toHaveCount(0)

  // F-15.7: Help › Check for updates… opens Settings on the Updates tab. This build is not a
  // packaged one, so it says so instead of reaching GitHub — the check must never leave the
  // machine in a test. The channel is a stored preference even here, so it survives the dialog.
  await menuBar.getByRole('menuitem', { name: 'Help' }).click()
  await page
    .getByRole('menu', { name: 'Help' })
    .getByRole('menuitem', { name: 'Check for updates…' })
    .click()
  await expect(settingsDialog).toBeVisible()
  await expect(settingsDialog.getByRole('tab', { name: 'Updates' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(settingsDialog.getByTestId('update-version')).toHaveText(
    `MythScribe ${packageVersion}`
  )
  await expect(settingsDialog.getByTestId('update-status')).toHaveText(
    'This is a development build; updates are installed by the released app.'
  )
  await expect(settingsDialog.getByRole('button', { name: 'Check for updates' })).toHaveCount(0)
  await settingsDialog.getByTestId('update-channel-beta').click()
  await expect(settingsDialog.getByTestId('update-channel-beta')).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'Updates' }).click()
  await expect(settingsDialog.getByTestId('update-channel-beta')).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await settingsDialog.getByTestId('update-channel-stable').click()
  await expect(settingsDialog.getByTestId('update-channel-stable')).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  const nativeMenu = (): Promise<{
    labels: (string | undefined)[]
    save: { enabled: boolean; accelerator: string | null } | null
  }> =>
    app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      const save = menu?.getMenuItemById('saveDocument')
      return {
        labels: menu?.items.map((item) => item.label) ?? [],
        save: save ? { enabled: save.enabled, accelerator: save.accelerator ?? null } : null
      }
    })
  expect(await nativeMenu()).toEqual({
    labels: ['File', 'Edit', 'Insert', 'View', 'Tools', 'Help'],
    save: { enabled: true, accelerator: 'CmdOrCtrl+S' }
  })
  await app.evaluate(({ Menu }) => {
    // `MenuItem.click` is typed as `Function` by Electron; the block keeps the return out of it.
    Menu.getApplicationMenu()?.getMenuItemById('openShortcuts')?.click()
  })
  await expect(shortcutsDialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(shortcutsDialog).toHaveCount(0)

  // F-1.4: choosing something that is not a project explains what to pick instead.
  await closeProject()
  // F-7.1: the native menu followed the close: File › Save is disabled again.
  expect((await nativeMenu()).save?.enabled).toBe(false)
  const stray = path.join(tmp, 'not-a-project.txt')
  fs.writeFileSync(stray, 'not a project')
  await stubOpenDialog(stray)
  await page.getByRole('button', { name: 'Open project' }).click()
  await expect(page.getByRole('status')).toContainText('Not a MythScribe project')
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()

  // F-1.6: a v0 project (here a single-file one) is converted after the author agrees: the new
  // project opens at the same path with v0's tree and text, and the original is kept beside it.
  const v0File = path.join(tmp, 'Old Ferryman.mythscribe')
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'v0-project.mythscribe'), v0File)
  const v0Original = fs.readFileSync(v0File)
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false })
  })
  await stubOpenDialog(v0File)
  await page.getByRole('button', { name: 'Open project' }).click()
  const landing = page.getByRole('treeitem', { name: 'Landing', exact: true })
  await expect(landing).toBeVisible()
  await landing.click()
  await expect(editor).toContainText('Mara waited at the ferry landing until the bell rang.')
  await expect(editor.locator('blockquote')).toContainText('Cross by noon.')
  expect(fs.statSync(v0File).isDirectory()).toBe(true)
  const v0Backup = fs.readdirSync(tmp).find((name) => name.startsWith('Old Ferryman (v0 backup'))
  expect(v0Backup).toBeDefined()
  expect(fs.readFileSync(path.join(tmp, v0Backup ?? ''))).toEqual(v0Original)
  await closeProject()

  // F-12.2, import to start: the welcome screen's Import manuscript… reads a plain-text file,
  // the review names the new project after it, a title opening a scene became a chapter of that
  // name, and Create project makes the project (no starter skeleton) and opens it.
  const startPath = path.join(tmp, 'Harbor Lights.txt')
  fs.writeFileSync(
    startPath,
    [
      'The Harbor',
      '',
      'Mara watched the boats come in.',
      '',
      '',
      'Nightfall',
      '',
      'The lights went out one by one.',
      ''
    ].join('\n')
  )
  await stubOpenDialog(startPath)
  await stubSaveDialog(path.join(tmp, 'Harbor Lights.mythscribe'))
  await page.getByRole('button', { name: 'Import manuscript…' }).click()
  const startImport = page.getByTestId('import-dialog')
  await expect(startImport).toBeVisible()
  await expect(startImport.getByRole('textbox', { name: 'Project name' })).toHaveValue(
    'Harbor Lights'
  )
  await expect(startImport.getByTestId('import-node')).toHaveText([
    /Harbor Lights/,
    /The Harbor/,
    /Scene 1.*Mara watched the boats come in\./,
    /Nightfall/,
    /Scene 1.*The lights went out one by one\./
  ])
  await startImport.getByTestId('import-commit').click()
  await expect(startImport).toHaveCount(0)
  await expect(page.getByTestId('project-name')).toHaveText('Harbor Lights')
  await expect(page.getByRole('treeitem', { name: 'Nightfall', exact: true })).toBeVisible()
  const startTree = await listTree()
  expect(
    startTree.filter((n) => n.hierarchyLevel !== null).map((n) => [n.title, n.hierarchyLevel])
  ).toEqual(
    expect.arrayContaining([
      ['Harbor Lights', 'part'],
      ['The Harbor', 'chapter'],
      ['Nightfall', 'chapter']
    ])
  )
  // No starter skeleton: the two imported scenes are the only ones.
  expect(startTree.filter((n) => n.hierarchyLevel === 'scene')).toHaveLength(2)
  await closeProject()

  // F-15.8: diagnostics are app-wide, so the tab is there on the welcome screen, and they are off
  // on every install. The preview is the report verbatim, and the switch survives the dialog
  // closing because main stores it in app state. Nothing leaves the machine here: this build has
  // no diagnostics endpoint, so a flush has nowhere to go.
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'Diagnostics' }).click()
  const diagnosticsSwitch = settingsDialog.getByTestId('diagnostics-enabled')
  await expect(diagnosticsSwitch).not.toBeChecked()
  await expect(settingsDialog.getByTestId('diagnostics-pending')).toHaveCount(0)
  await diagnosticsSwitch.check()
  await expect(diagnosticsSwitch).toBeChecked()
  await settingsDialog.getByRole('button', { name: 'See exactly what would be sent' }).click()
  const pending = settingsDialog.getByTestId('diagnostics-pending')
  await expect(pending).toContainText(`"appVersion": "${packageVersion}"`)
  await expect(pending).toContainText('"crashes": []')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'Diagnostics' }).click()
  await expect(settingsDialog.getByTestId('diagnostics-enabled')).toBeChecked()
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  // F-1.4: closing the OS window with a project open lets the renderer flush first, then main
  // closes the project and the window; with no windows left the app quits.
  await recents.getByRole('button', { name: 'Smoke Novel', exact: true }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
  // F-5.4: the conversations came back with the project (the panel stayed open in the layout).
  await expect(assistant).toBeVisible()
  await expect(assistant.getByRole('tab', { name: 'Why is Mara on the ridge?' })).toBeVisible()

  // F-12.2: File › Import manuscript… reads a Markdown file into a structure draft (headings are
  // chapters, `* * *` splits scenes), the author corrects it in the review dialog, and Import
  // writes the nodes after the existing ones with `origin: imported` on every paragraph.
  const importPath = path.join(tmp, 'the-ridge.md')
  fs.writeFileSync(
    importPath,
    [
      '# Chapter One',
      '',
      'The ridge was empty when Mara reached it.',
      '',
      'She waited *until dusk*.',
      '',
      '* * *',
      '',
      'Below, the lanterns of the village came on one by one.',
      '',
      '# Chapter Two',
      '',
      'Nobody came.',
      ''
    ].join('\n')
  )
  // F-12.3 needs Use AI on and a key, which the steps above turned off.
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await useAi.check()
  await expect.poll(async () => (await aiSettings()).dial).toBe(1)
  await keyField.fill(ACCEPTED_KEY)
  await settingsDialog.getByRole('button', { name: 'Save' }).click()
  await expect(keyHint).toHaveText('Key saved: sk-…wxyz')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await stubOpenDialog(importPath)
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'File' })
    .click()
  await page
    .getByRole('menu', { name: 'File' })
    .getByRole('menuitem', { name: 'Import manuscript…' })
    .click()
  const importDialog = page.getByTestId('import-dialog')
  await expect(importDialog).toBeVisible()
  await expect(importDialog.getByTestId('import-question')).toContainText('Does this look right?')
  await expect(importDialog.getByTestId('import-summary')).toContainText('3 scenes')
  // The combined outline: the project's own parts, chapters, and scenes come first, and the
  // imported rows after them are marked New. Leaving the project's rows alone deletes nothing.
  await expect(
    importDialog.locator('[data-testid="import-node"][data-import-kind="part"]').first()
  ).not.toHaveAttribute('data-import-new', 'true')
  await expect(importDialog.getByTestId('import-existing')).toHaveCount(0)
  const importRows = importDialog.locator('[data-testid="import-node"][data-import-new="true"]')
  await expect(importRows).toHaveText([
    /the-ridge/,
    /Chapter One/,
    /Scene 1.*The ridge was empty when Mara reached it\./,
    /Scene 2.*Below, the lanterns/,
    /Chapter Two/,
    /Scene 1.*Nobody came\./
  ])
  // F-12.3: the dialog offers the AI pass with an estimate from the word count before anything
  // is sent; Detect structure sends the draft in one chunk (the fake server answers one break,
  // one title, one tag candidate), the added scene is badged with the reason and can be
  // rejected, the AI title replaced the default one, and the line reports the cost against
  // the estimate. Nothing has been written yet.
  await expect(importDialog.getByTestId('import-detect-estimate')).toContainText(
    '(26 words, 1 chunk)'
  )
  const importBodiesBefore = openAiChatBodies.length
  await importDialog.getByTestId('import-detect').click()
  await expect(importDialog.getByTestId('import-detect-cost')).toContainText(
    '1 break added, 1 scene titled'
  )
  await expect(importDialog.getByTestId('import-detect-cost')).toContainText('AI pass cost')
  expect(openAiChatBodies.length).toBe(importBodiesBefore + 1)
  const importSystem = openAiChatBodies.at(-1)?.messages.find((m) => m.role === 'system')
  expect(importSystem?.content).toContain(IMPORT_STRUCTURE_SENTINEL)
  const importUser = openAiChatBodies.at(-1)?.messages.find((m) => m.role === 'user')
  expect(importUser?.content).toContain('[0] The ridge was empty when Mara reached it.')
  expect(importUser?.content).toContain('antagonist')
  await expect(importDialog.getByTestId('import-summary')).toContainText('4 scenes')
  await expect(importRows).toHaveText([
    /the-ridge/,
    /Chapter One/,
    /The Empty Ridge.*The ridge was empty when Mara reached it\./,
    /Scene 1 \(split\).*She waited until dusk\./,
    /Scene 2.*Below, the lanterns/,
    /Chapter Two/,
    /Scene 1.*Nobody came\./
  ])
  const importBadges = importDialog.getByTestId('import-ai-badge')
  await expect(importBadges).toHaveCount(2)
  await expect(importRows.nth(3).getByTestId('import-ai-badge')).toHaveAttribute(
    'title',
    /time skip/
  )
  await expect(importRows.nth(3).getByTestId('import-reject')).toBeVisible()
  await expect(importRows.nth(2).getByTestId('import-reject')).toHaveCount(0)
  // The rework's quick edits: tick two scenes and merge them into one, then Undo; Undo also
  // brings back a scene deleted with its ×.
  await importRows.nth(3).getByTestId('import-select').check()
  await importRows.nth(4).getByTestId('import-select').check()
  await expect(importDialog.getByTestId('import-selection')).toContainText('2 selected')
  await importDialog.getByTestId('import-merge-selected').click()
  await expect(importDialog.getByTestId('import-summary')).toContainText('3 scenes')
  await importDialog.getByTestId('import-undo').click()
  await expect(importDialog.getByTestId('import-summary')).toContainText('4 scenes')
  await importRows.nth(6).getByTestId('import-delete').click()
  await expect(importDialog.getByTestId('import-summary')).toContainText('3 scenes')
  await importDialog.getByTestId('import-undo').click()
  await expect(importDialog.getByTestId('import-summary')).toContainText('4 scenes')
  await importRows.nth(5).getByRole('button', { name: 'Chapter Two', exact: true }).click()
  const importRename = importDialog.getByTestId('import-rename')
  await importRename.fill('The Return')
  await importRename.press('Enter')
  await expect(importRows.nth(5)).toContainText('The Return')
  const treeBefore = await listTree()
  await importDialog.getByTestId('import-commit').click()
  await expect(importDialog).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Imported' })).toContainText(
    'Imported 4 scenes (26 words)'
  )
  // 13, not 12: `countWords` counts per text leaf, so the italic run leaves the closing full stop
  // as a token of its own (the editor counts a mid-sentence mark boundary the same way).
  const treeAfter = await listTree()
  const importedPart = treeAfter.find(
    (n) => n.title === 'the-ridge' && !treeBefore.some((before) => before.id === n.id)
  )
  // Depth-first from the imported part (`tree:list` answers by parent and position, not creation order).
  const walk = (parentId: string): TreeNode[] =>
    treeAfter
      .filter((n) => n.parentId === parentId)
      .sort((a, b) => a.position - b.position)
      .flatMap((n) => [n, ...walk(n.id)])
  const imported = importedPart ? [importedPart, ...walk(importedPart.id)] : []
  expect(imported.map((n) => [n.title, n.hierarchyLevel, n.wordCount])).toEqual([
    ['the-ridge', 'part', 0],
    ['Chapter One', 'chapter', 0],
    ['The Empty Ridge', 'scene', 8],
    ['Scene 1 (split)', 'scene', 5],
    ['Scene 2', 'scene', 11],
    ['The Return', 'chapter', 0],
    ['Scene 1', 'scene', 2]
  ])
  const manuscriptRoot = treeAfter.find((n) => n.sectionType === 'manuscript')
  expect(importedPart?.parentId).toBe(manuscriptRoot?.id)
  // After the project's own parts: the outline lays the parts out in the reviewed order.
  expect(importedPart?.position).toBe(
    treeBefore.filter((n) => n.parentId === manuscriptRoot?.id && n.hierarchyLevel === 'part')
      .length
  )
  // The first imported scene is selected and open; its paragraphs carry the provenance attribute.
  const importedScene = imported[2]
  await expect(tree.getByRole('treeitem', { name: 'The Return', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Document' })).toContainText(
    'The ridge was empty when Mara reached it.'
  )
  await expect(
    page.getByRole('textbox', { name: 'Document' }).locator('p[data-origin="imported"]')
  ).toHaveCount(1)
  // F-12.3: the tag candidate is a pending proposal on the created scene, offered in the tag
  // bar like an F-4.7 answer (no cost line: the chunk paid for it) and linked only on accept.
  await showTags()
  const importedSuggested = tagBar.getByRole('list', { name: 'Suggested tags' })
  await expect(importedSuggested.getByRole('listitem')).toHaveText(['antagonist'])
  await expect(tagBar.getByTestId('tag-recommend-cost')).toHaveText('gpt-5.4-mini · from import')
  const importedChips = tagBar.getByRole('list', { name: 'Document tags' })
  await expect(importedChips.getByRole('listitem')).toHaveCount(0)
  await tagBar.getByRole('button', { name: 'Accept antagonist' }).click()
  await expect(importedChips.getByRole('listitem')).toHaveText(['antagonist'])
  await expect(importedSuggested).toHaveCount(0)
  // F-13.4: the consistency checker. Mara's sheet says she is 34; the imported Scene 2 is made to
  // say twenty-nine twice. `Check this scene` in the assistant's Continuity view sends the scene
  // with the sheet as reference 1; the fake answer carries two findings against it and two main
  // must drop (a quote that is not in the scene, a reference number that was never sent). The
  // first finding's fix is applied through its proposal and is in the text; the second is
  // dismissed as "changed in the story", which also retires the reference for this scene: a
  // second check never sends that sheet line again.
  const maraSheet = await page.evaluate(async () => {
    const listed = (await window.mythscribe.invoke('entity:list', undefined)) as IpcResult<Entity[]>
    if (!listed.ok) throw new Error(listed.error.message)
    const existing = listed.data.find((e) => e.kind === 'character' && e.name === 'Mara')
    const saved = (await (existing
      ? window.mythscribe.invoke('entity:update', {
          id: existing.id,
          template: 'structured',
          fields: { age: '34' }
        })
      : window.mythscribe.invoke('entity:create', {
          kind: 'character',
          name: 'Mara',
          template: 'structured',
          fields: { age: '34' }
        }))) as IpcResult<Entity>
    if (!saved.ok) throw new Error(saved.error.message)
    return saved.data
  })
  expect(maraSheet.fields.age).toBe('34')
  await tree.getByRole('treeitem', { name: 'Scene 2', exact: true }).last().click()
  await expect(editor).toContainText('Below, the lanterns')
  await caretToEnd(editor)
  await page.keyboard.type(
    ` The road down was slick with old rain and the carts had left ruts a hand deep, so the going was slow and nobody spoke until the gate. ${CONTINUITY_QUOTE} ${CONTINUITY_SECOND_QUOTE}`
  )
  await dismissToasts()
  if (!(await assistant.isVisible())) await page.keyboard.press('Control+k')
  await expect(assistant).toBeVisible()
  const continuityBodies = (): string[] =>
    openAiChatBodies
      .filter((body) => body.messages[0]?.content.startsWith(CONTINUITY_SENTINEL))
      .map((body) => body.messages.at(-1)?.content ?? '')
  // Counted by sentinel: the typing above also queues the scene's background summary.
  const continuityRequestsBefore = continuityBodies().length
  // F-5.17: Check consistency, asked in the chat (2026-10-06): "Continuity" in Auto runs the
  // check and opens the findings view in place of the chat.
  await sendRouted('Continuity')
  const continuityPanel = assistant.getByTestId('continuity-panel')
  await expect(continuityPanel).toBeVisible()
  const findingCards = continuityPanel.getByTestId('continuity-finding')
  await expect(findingCards).toHaveCount(2, { timeout: 15_000 })
  expect(continuityBodies()).toHaveLength(continuityRequestsBefore + 1)
  await expect(continuityPanel.getByTestId('continuity-result')).toContainText(
    '2 contradictions found'
  )
  await expect(assistant.getByTestId('continuity-button')).toHaveText('Back to the conversation')
  const ageFinding = findingCards.filter({ hasText: CONTINUITY_WHY })
  await expect(ageFinding).toHaveAttribute('data-ref-kind', 'sheet')
  await expect(ageFinding.getByTestId('continuity-quote')).toContainText(CONTINUITY_QUOTE)
  await expect(ageFinding.getByTestId('continuity-ref')).toContainText('Mara · Age: 34')
  await expect(ageFinding.getByTestId('continuity-fix-diff')).toBeVisible()
  const continuityScene = imported[4]
  await ageFinding.getByTestId('continuity-apply').click()
  await expect(findingCards).toHaveCount(1)
  await expect
    .poll(() => documentText(continuityScene?.id ?? ''), { timeout: 5_000 })
    .toContain(CONTINUITY_FIX)
  expect(await documentText(continuityScene?.id ?? '')).not.toContain(CONTINUITY_QUOTE)
  await expect(editor.locator('.ai-origin', { hasText: CONTINUITY_FIX })).toHaveCount(1)
  await findingCards.first().getByTestId('continuity-dismiss').click()
  await expect(findingCards).toHaveCount(0)
  await expect(assistant.getByTestId('continuity-count')).toHaveCount(0)
  const continuityBodiesBefore = continuityBodies()
  expect(continuityBodiesBefore.at(-1)).toContain('Age: 34')
  // Other references may remain (what other scenes state about Mara), so the second check may
  // still ask; what it never does is send the dismissed sheet line or raise the finding again.
  // The link leads back to the chat, where the second check is asked.
  await assistant.getByTestId('continuity-button').click()
  await expect(continuityPanel).toHaveCount(0)
  await sendRouted('Continuity')
  await expect(
    continuityPanel
      .getByTestId('continuity-result')
      .or(continuityPanel.getByTestId('continuity-no-references'))
  ).toBeVisible({ timeout: 15_000 })
  await expect(continuityPanel.getByTestId('continuity-pending')).toHaveCount(0)
  await expect(findingCards).toHaveCount(0)
  for (const body of continuityBodies().slice(continuityBodiesBefore.length)) {
    expect(body).not.toContain('Age: 34')
  }
  const afterContinuity = await usageSummary()
  expect(
    afterContinuity.byFeature.find((f) => f.feature === 'continuity')?.requests
  ).toBeGreaterThanOrEqual(1)
  await assistant.getByTestId('continuity-button').click()
  await expect(continuityPanel).toHaveCount(0)

  // F-9.8: the context library, while Use AI is on and Mara's sheet says she is 34. Two files go
  // in through the Library tab (the OS dialog stubbed): the estimate shows first and nothing is
  // sent until Sort with AI; the fake server answers each file by name (Mara at 35 with a
  // nickname, Tomas Reed, The Landing, a theme). The review shows the conflict side by side with
  // the sheet's value kept by default; the author picks the upload's, applies, and the sheets,
  // their tags, and the Project notes page are there, and both files read "Sorted". Since
  // 2026-10-10 the pass is side work: no window over the editor, a status-bar item instead, and
  // the review opens in the assistant column from it.
  const contextDir = path.join(tmp, 'context')
  fs.mkdirSync(contextDir, { recursive: true })
  const peopleFile = path.join(contextDir, 'people.md')
  const placesFile = path.join(contextDir, 'places.txt')
  fs.writeFileSync(
    peopleFile,
    '# Mara\n\nMara Vell, Mara to everyone at the landing, is thirty-five. Grey eyes, a burn scar on the left wrist.\n\nShe runs the ferry her father built.\n\nThe book is about debts that outlive the people who made them.\n'
  )
  fs.writeFileSync(
    placesFile,
    'Tomas Reed is twenty-nine and owes the mill money.\n\nThe Landing is a jetty of black planks on the north bank.\n\nThe Weave costs a memory for every knot.\n\nThe Gull, a cutter, has a crew of twelve.\n'
  )
  await showSection('Library')
  const libraryPanel = page.getByRole('region', { name: 'Library section', exact: true })
  await expect(libraryPanel).toContainText('No files yet')
  await stubOpenDialogFiles([peopleFile, placesFile])
  const contextBodies = (): string[] =>
    openAiChatBodies
      .filter((body) => body.messages[0]?.content.startsWith(CONTEXT_IMPORT_SENTINEL))
      .map((body) => body.messages.at(-1)?.content ?? '')
  await libraryPanel.getByTestId('library-add').click()
  const libraryDialog = page.getByTestId('library-dialog')
  await expect(libraryDialog.getByTestId('library-estimate')).toContainText('2 files · 2 requests')
  expect(contextBodies()).toHaveLength(0)
  await libraryDialog.getByTestId('library-confirm').click()
  await expect(libraryDialog).toHaveCount(0)
  const uploadStatus = page.getByTestId('side-work-upload')
  await expect(uploadStatus).toHaveText('Upload: ready to review', { timeout: 15_000 })
  await uploadStatus.click()
  const uploadPanel = page.getByTestId('library-panel')
  const libraryReview = uploadPanel.getByTestId('review-deck')
  await expect(libraryReview).toBeVisible()
  expect(contextBodies()).toHaveLength(2)
  expect(contextBodies()[0]).toMatch(/^Existing sheets by kind:\ncharacter: .*\bMara\b/)
  await expect(uploadPanel.getByTestId('library-review-summary')).toHaveText(
    '4 new sheets · 1 sheet to update · 1 conflict · 1 note for Project notes'
  )
  // The review is a deck since 2026-10-08: one card at a time, grouped (a dropdown in the side
  // column), nothing accepted until the author says so.
  await expect(uploadPanel.getByTestId('review-group-select').locator('option')).toHaveText([
    'New categories 0/1',
    'New sheets 0/4',
    'Conflicts 0/1',
    'Project notes 0/1'
  ])
  await expect(uploadPanel.getByTestId('review-apply')).toHaveText('Apply 0 accepted')
  // F-9.9: the review chat. The author asks for a change; the fake server answers operations on
  // the listed review: Tomas Reed's card (further on) shows the new name and is marked Changed,
  // the reply lists each change with the one the review could not do (renaming an existing
  // sheet) and why, and the cost line is there. Nothing was written: the deck still decides.
  const reviewChat = uploadPanel.getByTestId('review-chat')
  await reviewChat.getByTestId('review-chat-input').fill('Tomas Reed is also called Tom.')
  await reviewChat.getByTestId('review-chat-send').click()
  await expect(reviewChat.getByTestId('review-chat-change')).toHaveText(
    [
      '“Tomas Reed” is also called “Tom”.',
      'Rename skipped: “Mara” is an existing sheet; rename it in the story bible.'
    ],
    { timeout: 15_000 }
  )
  await expect(reviewChat.getByTestId('review-chat-entry').last()).toContainText(
    'AI: Tomas Reed also goes by Tom.'
  )
  expect(
    openAiChatBodies.filter((body) => body.messages[0]?.content.startsWith(REVIEW_CHAT_SENTINEL))
  ).toHaveLength(1)
  // F-9.11: the model filed The Weave under Magic Systems and proposed a Ships category for The
  // Gull; the proposal is the first card, with Rename and Decline. Rename changes the name
  // before anything is created; Accept keeps it.
  const proposedCategory = libraryReview.getByTestId('library-proposed-category')
  await expect(proposedCategory).toContainText('Proposed new category: Ships')
  await expect(proposedCategory).toContainText('1 sheet · fields: Crew')
  await proposedCategory.getByRole('button', { name: 'Rename…' }).click()
  const renameProposal = page.getByRole('dialog', { name: 'Rename the proposed category' })
  await renameProposal.getByRole('textbox').fill('Vessels')
  await renameProposal.getByRole('button', { name: 'Rename' }).click()
  await expect(proposedCategory).toContainText('Proposed new category: Vessels')
  await libraryReview.getByTestId('review-accept').click()
  // The four new sheets, one after the other: A on each.
  const libraryCard = libraryReview.getByTestId('library-item')
  const reviewPosition = libraryReview.getByTestId('review-position')
  for (let i = 1; i <= 4; i++) {
    await expect(reviewPosition).toHaveText(`New sheet ${i} of 4`)
    const name = await libraryCard.getAttribute('data-item-name')
    if (name === 'The Weave') await expect(libraryCard).toContainText('magic system')
    if (name === 'Tomas Reed') {
      await expect(libraryCard).toContainText('Tag #tomas-reed')
      await expect(libraryCard.getByTestId('library-item-changed')).toBeVisible()
      await expect(libraryCard.getByTestId('library-item-aliases')).toHaveText('Also called: Tom')
    }
    await page.keyboard.press('a')
  }
  // The conflict: Mara's age, both values side by side; the upload's is picked.
  await expect(reviewPosition).toHaveText('Conflict 1 of 1')
  const maraItem = libraryReview.locator('[data-item-name="Mara"]')
  await expect(maraItem).toContainText('existing sheet')
  // The two descriptions were merged by the nickname; Split would separate them again.
  await expect(maraItem.getByTestId('library-matches')).toContainText(
    'Matched: “Mara” (people.md), “Mara Vell” (people.md) Split'
  )
  const ageConflict = maraItem.getByTestId('library-conflict')
  await expect(ageConflict.getByRole('radio', { name: /Keep the sheet’s\s*34/ })).toBeChecked()
  await ageConflict.getByText('Use the upload’s').click()
  await expect(ageConflict.getByRole('radio', { name: /Use the upload’s\s*35/ })).toBeChecked()
  await page.keyboard.press('a')
  // Project notes last; accepting the last card with nothing skipped applies the review.
  await expect(libraryReview.getByTestId('library-notes')).toContainText(
    'Theme: The book is about debts'
  )
  await expect(uploadPanel.getByTestId('review-apply')).toHaveText('Apply 6 accepted')
  await page.keyboard.press('a')
  await expect(uploadPanel).toHaveCount(0)
  await expect(uploadStatus).toHaveCount(0)
  await expect(libraryPanel.getByTestId('library-file-state')).toHaveText(['Sorted', 'Sorted'])
  const afterLibrary = await page.evaluate(async () => {
    const listed = (await window.mythscribe.invoke('entity:list', undefined)) as IpcResult<Entity[]>
    const tags = (await window.mythscribe.invoke('tag:list', undefined)) as IpcResult<Tag[]>
    if (!listed.ok || !tags.ok) throw new Error('list failed')
    return { entities: listed.data, tags: tags.data.map((tag) => tag.name) }
  })
  const librarySheet = (name: string): Entity | undefined =>
    afterLibrary.entities.find((entity) => entity.name === name)
  expect(librarySheet('Mara')?.fields).toMatchObject({
    age: '35',
    goals: 'Keep the ferry running.'
  })
  expect(librarySheet('Mara')?.fields.notes).toContain(
    'History: She runs the ferry her father built.'
  )
  expect(librarySheet('Tomas Reed')).toMatchObject({ kind: 'character', fields: { age: '29' } })
  expect(librarySheet('The Landing')).toMatchObject({ kind: 'setting' })
  expect(librarySheet('The Weave')).toMatchObject({
    kind: 'magic',
    fields: { costs: 'A memory for every knot.' }
  })
  expect(librarySheet('The Gull')).toMatchObject({ kind: 'c-vessels', fields: { crew: 'twelve' } })
  expect(librarySheet('Project notes')).toMatchObject({
    kind: 'world',
    template: 'blank',
    body: 'Theme: The book is about debts that outlive the people who made them.',
    tagId: null
  })
  expect(afterLibrary.tags).toEqual(expect.arrayContaining(['tomas-reed', 'the-landing']))
  expect(
    (await usageSummary()).byFeature.find((f) => f.feature === 'contextImport')?.requests
  ).toBe(2)
  expect((await usageSummary()).byFeature.find((f) => f.feature === 'reviewChat')?.requests).toBe(1)
  await dismissToasts()
  // F-9.11: the sheets made Magic Systems and the accepted Vessels category appear in the picker
  // (an empty category stays hidden), each with its count; Library shows now that it has files.
  await sectionPicker.click()
  await expect(sectionOptions()).toHaveText([
    /^Manuscript\d+$/,
    /^Characters\d+$/,
    /^Places\d+$/,
    /^World\d+$/,
    'Magic Systems1',
    'Vessels1',
    // F-9.15: the tags close the story bible as its Index; Threads leads the rest.
    /^Index\d+$/,
    // F-9.14: the thread the scene reading opened.
    /^Threads\d+$/,
    /^Outline\d+$/,
    'Library2',
    /^To do\d*$/,
    /^Edits\d+$/,
    /^Changes\d+$/,
    /^Show unused sections \(\d+\)$/,
    'New category…'
  ])
  await expect(sectionList.getByRole('option', { name: 'Religions' })).toHaveCount(0)
  await sectionList.getByRole('option', { name: 'Magic Systems' }).click()
  await expect(sectionPicker).toHaveAccessibleName('Section: Magic Systems')
  await expect(
    page.getByRole('region', { name: 'Magic Systems section', exact: true }).getByRole('button', {
      name: /^The Weave/
    })
  ).toBeVisible()
  // F-9.16: the To do list. Check the whole book asks the fast tier once (only on this click);
  // the fake flags one open question. Going through from it asks for its suggestions (each
  // labelled "Suggestion"); picking one only fills the editable line, and Add writes it to the
  // scene's notes as the author's text and marks the item done. The scene's text is unchanged.
  // A second check on the unchanged book sends nothing.
  // The fake flags three kinds: a loose end (the question), an undefined term, and a gap.
  await dismissToasts()
  await showSection('To do')
  const todoTab = page.getByTestId('todo-tab')
  const sentWith = (sentinel: string): number =>
    openAiChatBodies.filter((body) => body.messages[0]?.content.startsWith(sentinel)).length
  // The mention scan and the To do sync are debounced and silent, and the check sends what they
  // wrote: wait until the list (its items and the check's estimate) holds still across a full
  // debounce of both, so the second check below reads the same book as the first.
  const todoSnapshot = async (): Promise<string> =>
    JSON.stringify(await page.evaluate(() => window.mythscribe.invoke('todo:list', undefined)))
  await expect
    .poll(
      async () => {
        const before = await todoSnapshot()
        await page.waitForTimeout(TODO_DEBOUNCE_MS + MENTION_DEBOUNCE_MS + 500)
        return (await todoSnapshot()) === before
      },
      { timeout: 60_000, intervals: [0] }
    )
    .toBe(true)
  await todoTab.getByTestId('todo-check-book').click()
  const todoRow = todoTab.getByTestId('todo-item').filter({ hasText: TODO_SUBJECT })
  await expect(todoRow).toHaveCount(1)
  expect(sentWith(TODO_SENTINEL)).toBe(1)
  await expect(todoTab.getByRole('region', { name: 'Loose ends' })).toContainText(TODO_SUBJECT)
  await expect(todoTab.getByRole('region', { name: 'Undefined' })).toContainText('the Saltmarch')
  await expect(todoTab.getByRole('region', { name: 'Gaps' })).toContainText('the winter crossing')
  await dismissToasts()
  await todoTab.getByTestId('todo-check-book').click()
  await expect(
    page.getByText('Nothing changed since the last check.', { exact: true })
  ).toBeVisible()
  expect(sentWith(TODO_SENTINEL)).toBe(1)
  await dismissToasts()
  const todoListed = await page.evaluate(() => window.mythscribe.invoke('todo:list', undefined))
  if (!todoListed.ok) throw new Error('todo:list failed')
  const todoScene =
    (todoListed.data as TodoView).items.find((item) => item.subject === TODO_SUBJECT)?.nodeId ?? ''
  const todoSceneText = await documentText(todoScene)
  await todoRow.getByRole('button', { name: TODO_SUBJECT, exact: true }).click()
  const todoStrip = page.getByTestId('todo-review')
  const todoCard = todoStrip.getByTestId('todo-card')
  await expect(todoCard.getByTestId('todo-suggestions')).toContainText(TODO_OPTIONS[0] ?? '')
  await expect(todoCard.getByTestId('todo-suggestions')).toContainText('Suggestion')
  expect(sentWith(TODO_SUGGEST_SENTINEL)).toBeGreaterThanOrEqual(1)
  await todoCard.getByRole('button', { name: `Use: ${TODO_OPTIONS[1] ?? ''}` }).click()
  await expect(todoCard.getByTestId('todo-line')).toHaveValue(TODO_OPTIONS[1] ?? '')
  await todoCard.getByTestId('todo-add').click()
  await expect(todoRow).toHaveCount(0)
  await expect
    .poll(async () => {
      const notes = await page.evaluate(
        (id) => window.mythscribe.invoke('notes:get', { id }),
        todoScene
      )
      return notes.ok ? JSON.stringify(notes.data) : ''
    })
    .toContain(TODO_OPTIONS[1] ?? '')
  expect(await documentText(todoScene)).toBe(todoSceneText)
  await todoStrip.getByTestId('todo-review-close').click()
  await dismissToasts()
  await showSection('Manuscript')
  // F-9.10: Organise. A stray #reed tag beside #tomas-reed is what an upload leaves behind; the
  // local pass finds the look-alike and the Tags section offers to organise, quietly. Opening the
  // offer asks the AI for a plan (the fake merges the tags and fills The Landing's atmosphere).
  // In Ask the plan is a review deck, one change at a time (2026-10-08): A accepts the merge, the
  // sheet change is next, and accepting the last one applies both through the stores; the rail
  // jumps back to the sheet change, whose Undo takes it back. In Auto the change that can be
  // undone lands at once and "Undo the whole reorganisation" takes it back. No scene text changes.
  const organiseBodies = (): number =>
    openAiChatBodies.filter((body) => body.messages[0]?.content.startsWith(ORGANISE_SENTINEL))
      .length
  const sheetField = async (name: string, field: string): Promise<string | undefined> =>
    page.evaluate(
      async ({ name, field }) => {
        const listed = (await window.mythscribe.invoke('entity:list', undefined)) as IpcResult<
          Entity[]
        >
        if (!listed.ok) throw new Error('entity:list failed')
        return listed.data.find((entity) => entity.name === name)?.fields[field]
      },
      { name, field }
    )
  const sceneTextBeforeOrganise = await documentText(imported[3]?.id ?? '')
  const strayTag = await page.evaluate(() =>
    window.mythscribe.invoke('tag:create', { name: 'reed', category: 'custom' })
  )
  if (!strayTag.ok) throw new Error(`tag:create failed: ${strayTag.error.message}`)
  expect((await aiSettings()).chatMode).toBe('ask')
  await showSection('Index')
  const tagsSection = page.getByRole('region', { name: 'Index section', exact: true })
  const organiseOffer = tagsSection.getByTestId('organise-offer')
  await expect(organiseOffer).toContainText('possible duplicate', { timeout: 10_000 })
  expect(organiseBodies()).toBe(0)
  await organiseOffer.getByRole('button', { name: 'Review' }).click()
  // Side work (2026-10-10): the plan is worked out in the background; the status-bar item opens
  // it in the assistant column.
  const organiseStatus = page.getByTestId('side-work-organise')
  await expect(organiseStatus).toHaveText('Organise: ready to review', { timeout: 15_000 })
  await organiseStatus.click()
  const organisePanel = page.getByTestId('organise-panel')
  const organiseCard = organisePanel.getByTestId('organise-change')
  await expect(organiseCard).toHaveCount(1)
  expect(organiseBodies()).toBe(1)
  await expect(organisePanel.getByTestId('organise-reply')).toHaveText(
    'One Tomas, and the Landing filled in.'
  )
  const organiseRail = organisePanel.getByTestId('review-group-select')
  await expect(organiseRail.locator('option')).toHaveText(['Merges 0/1', 'Story bible 0/1'])
  await expect(organisePanel.getByTestId('review-position')).toHaveText('Merge 1 of 1')
  await expect(organiseCard).toContainText('Merge tags “#reed” into #tomas-reed')
  await expect(organisePanel.getByRole('checkbox')).toHaveCount(0)
  await page.keyboard.press('a')
  await expect(organiseCard).toContainText('Sheet “The Landing”: 1 field')
  await expect(organiseCard.locator('ins')).toHaveText(ORGANISE_ATMOSPHERE)
  await expect(organisePanel.getByTestId('review-apply')).toHaveText('Apply 1 accepted')
  await organisePanel.getByTestId('review-accept').click()
  await expect(organisePanel.getByTestId('review-done')).toContainText('All 2 reviewed.')
  // At the end no group is on show, so the dropdown offers to choose one.
  await expect(organiseRail.locator('option')).toHaveText([
    'Choose a group',
    'Merges 1/1',
    'Story bible 1/1'
  ])
  await organiseRail.selectOption({ label: 'Merges 1/1' })
  await expect(organiseCard).toHaveAttribute('data-status', 'applied')
  await organiseRail.selectOption({ label: 'Story bible 1/1' })
  await expect(organiseCard).toHaveAttribute('data-status', 'applied')
  const afterOrganise = await page.evaluate(async () => {
    const tags = (await window.mythscribe.invoke('tag:list', undefined)) as IpcResult<Tag[]>
    if (!tags.ok) throw new Error('tag:list failed')
    return tags.data
  })
  expect(afterOrganise.map((tag) => tag.name)).not.toContain('reed')
  expect(afterOrganise.find((tag) => tag.name === 'tomas-reed')?.aliases).toContain('Reed')
  expect(await sheetField('The Landing', 'atmosphere')).toBe(ORGANISE_ATMOSPHERE)
  await organiseCard.getByRole('button', { name: /^Undo: / }).click()
  await expect(organiseCard).toHaveAttribute('data-status', 'undone')
  await expect.poll(() => sheetField('The Landing', 'atmosphere')).toBeUndefined()
  await organisePanel.getByRole('button', { name: 'Done' }).click()
  await expect(organisePanel).toHaveCount(0)
  await expect(organiseStatus).toHaveCount(0)
  // Auto: the button asks again; the sheet change lands at once, and one Undo takes it all back.
  await assistant.getByRole('radio', { name: 'Auto', exact: true }).click()
  await expect.poll(async () => (await aiSettings()).chatMode).toBe('auto')
  await tagsSection.getByTestId('organise-button').click()
  await expect(organiseStatus).toHaveText('Organise: ready to review', { timeout: 15_000 })
  await organiseStatus.click()
  await expect(organiseCard).toHaveAttribute('data-status', 'applied')
  await expect(organiseRail.locator('option')).toHaveText(['Story bible 1/1'])
  expect(await sheetField('The Landing', 'atmosphere')).toBe(ORGANISE_ATMOSPHERE)
  await organisePanel.getByTestId('organise-undo-all').click()
  await expect(organiseCard).toHaveAttribute('data-status', 'undone')
  await expect.poll(() => sheetField('The Landing', 'atmosphere')).toBeUndefined()
  await organisePanel.getByRole('button', { name: 'Done' }).click()
  // F-9.15: both runs are in the one Changes log, newest first. The plan screen's Undo was the
  // log's, so each sheet change reads as undone there; the merge is listed without an Undo.
  await showSection('Changes')
  const changesPanel = page.getByRole('region', { name: 'Changes section', exact: true })
  const organiseRuns = changesPanel.getByRole('listitem', { name: 'Organise', exact: true })
  await expect(organiseRuns).toHaveCount(2)
  await expect(organiseRuns.nth(0).getByRole('listitem', { name: /^Sheet: / })).toContainText(
    'Undone'
  )
  const loggedMerge = organiseRuns.nth(1).getByRole('listitem', { name: /^Merge: / })
  await expect(loggedMerge).toContainText('No undo')
  await expect(loggedMerge.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  await expect(organiseRuns.nth(1).getByRole('listitem', { name: /^Sheet: / })).toContainText(
    'Undone'
  )
  await assistant.getByRole('radio', { name: 'Ask', exact: true }).click()
  await expect.poll(async () => (await aiSettings()).chatMode).toBe('ask')
  expect(await documentText(imported[3]?.id ?? '')).toBe(sceneTextBeforeOrganise)
  expect((await usageSummary()).byFeature.find((f) => f.feature === 'organise')?.requests).toBe(2)
  await showSection('Manuscript')

  // Back to Off and no key, as before this step.
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await useAi.uncheck()
  await expect.poll(async () => (await aiSettings()).dial).toBe(0)
  await settingsDialog.getByRole('button', { name: 'Clear' }).click()
  await expect(keyHint).toHaveText('No key')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  // The italic run survived the import and the AI split: it is the second scene's text now.
  expect(await documentText(importedScene?.id ?? '')).toBe(
    'The ridge was empty when Mara reached it.'
  )
  expect(await documentText(imported[3]?.id ?? '')).toBe('She waited until dusk.')
  await tree.getByRole('treeitem', { name: 'Scene 1 (split)', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: 'Document' }).locator('em', { hasText: 'until dusk' })
  ).toHaveCount(1)

  // F-8.3: crash recovery. Typing lands in the project's recovery journal within a quarter
  // second, long before the 1 s autosave; a renderer crash inside that window (main then closes
  // the project) loses nothing: reopening offers the text back and Recover writes it.
  const recoveryDir = path.join(projectPath, 'recovery')
  const crashSentence = 'The lanterns guttered out one by one.'
  await caretToEnd(editor)
  await page.keyboard.type(` ${crashSentence}`)
  const journalText = (): string => {
    if (!fs.existsSync(recoveryDir)) return ''
    return fs
      .readdirSync(recoveryDir)
      .filter((name) => name.startsWith('document-') && name.endsWith('.json'))
      .map((name) => {
        try {
          const entry = JSON.parse(fs.readFileSync(path.join(recoveryDir, name), 'utf8')) as {
            content: TiptapNodeT
          }
          return plainText(entry.content)
        } catch {
          return '' // caught between the temp write and the rename
        }
      })
      .join('\n')
  }
  await expect.poll(journalText, { intervals: [50], timeout: 2_000 }).toContain(crashSentence)
  const crashed = page.waitForEvent('crash')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer()
  )
  await crashed
  // Playwright keeps a crashed page dead even after Electron reloads it, so the step swaps the
  // window for a fresh one, as main would build at start: destroying the last window must not
  // quit the app, then `activate` creates the new one. Main closed the project when the renderer
  // died, so the fresh window starts on the welcome screen with the journal still on disk.
  const freshWindow = app.waitForEvent('window')
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const keepAlive = (event: { preventDefault: () => void }): void => event.preventDefault()
    electronApp.on('before-quit', keepAlive)
    BrowserWindow.getAllWindows()[0]?.destroy()
    electronApp.removeListener('before-quit', keepAlive)
    electronApp.emit('activate')
  })
  page = await freshWindow
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()
  expect(journalText()).toContain(crashSentence)
  await page
    .getByRole('list', { name: 'Recent projects' })
    .getByRole('button', { name: 'Smoke Novel', exact: true })
    .click()
  const recoverDialog = page.getByRole('dialog', { name: 'Recover unsaved changes?' })
  await expect(recoverDialog).toContainText('"Scene 1 (split)" (text)')
  await recoverDialog.getByRole('button', { name: 'Recover' }).click()
  await expect(recoverDialog).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Recovered' })).toContainText(
    'Recovered 1 unsaved change.'
  )
  expect(await documentText(imported[3]?.id ?? '')).toBe(`She waited until dusk. ${crashSentence}`)
  expect(fs.existsSync(recoveryDir) ? fs.readdirSync(recoveryDir) : []).toEqual([])
  await page
    .getByRole('tree', { name: 'Document tree' })
    .getByRole('treeitem', { name: 'Scene 1 (split)', exact: true })
    .click()
  await expect(page.getByRole('textbox', { name: 'Document' })).toContainText(crashSentence)

  // F-8.4: automatic backups. The closes earlier in this run already backed the project up (on
  // close, into userData/backups under the e2e override); "Back up now" writes one more, and
  // Restore opens the newest as a copy next to the original, with the recovered text in it.
  const backupsRoot = path.join(tmp, 'userData', 'backups')
  // Each archive as `<path>#<inode>`: a backup is written to a temp file and renamed over its
  // name, so a fresh one is a new pair even when it lands on the same second's name. Not mtimes:
  // the WSL clock steps backwards under load (journald logs "Time jumped backwards" dozens of
  // times a day), so a newer file can carry an older mtime and the old check failed now and then.
  const backupArchives = (): string[] =>
    fs.existsSync(backupsRoot)
      ? fs
          .readdirSync(backupsRoot, { recursive: true, encoding: 'utf8' })
          .filter((name) => name.endsWith('.zip'))
          .map((name) => `${name}#${fs.statSync(path.join(backupsRoot, name)).ino}`)
      : []
  const backupsSettings = page.getByRole('dialog', { name: 'Settings' })
  await page.getByRole('button', { name: 'Settings' }).click()
  await backupsSettings.getByRole('tab', { name: 'Backups' }).click()
  await expect(backupsSettings.getByTestId('backups-folder')).toHaveText(backupsRoot)
  const backupRows = backupsSettings.getByTestId('backup-row')
  await expect(backupRows.first()).toBeVisible()
  const archivesBefore = backupArchives()
  expect(archivesBefore.length).toBeGreaterThan(0)
  await backupsSettings.getByRole('button', { name: 'Back up now' }).click()
  await expect
    .poll(() => backupArchives().filter((archive) => !archivesBefore.includes(archive)), {
      timeout: 5_000
    })
    .toHaveLength(1)
  await backupRows
    .first()
    .getByRole('button', { name: /Restore the backup from/ })
    .click()
  const restoreConfirm = page.getByRole('dialog', { name: 'Restore as a copy?' })
  await expect(restoreConfirm).toContainText('Nothing is overwritten')
  await restoreConfirm.getByRole('button', { name: 'Restore' }).click()
  await expect(backupsSettings).toHaveCount(0)
  const currentProject = async (): Promise<ProjectInfo | null> => {
    const result = await page.evaluate<IpcResult<ProjectInfo | null>>(
      () =>
        window.mythscribe.invoke('project:current', undefined) as Promise<
          IpcResult<ProjectInfo | null>
        >
    )
    if (!result.ok) throw new Error(`project:current failed: ${result.error.message}`)
    return result.data
  }
  await expect.poll(async () => (await currentProject())?.path ?? '').toContain('(restored ')
  const restoredPath = (await currentProject())?.path ?? ''
  expect(path.dirname(restoredPath)).toBe(path.dirname(projectPath))
  expect(fs.existsSync(path.join(projectPath, 'project.db'))).toBe(true)
  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
  expect(await documentText(imported[3]?.id ?? '')).toBe(`She waited until dusk. ${crashSentence}`)
  await page
    .getByRole('tree', { name: 'Document tree' })
    .getByRole('treeitem', { name: 'Scene 1 (split)', exact: true })
    .click()
  await expect(page.getByRole('textbox', { name: 'Document' })).toContainText(crashSentence)

  // F-8.5: drafts, in the restored copy (nothing after this step reads its text). The project
  // starts with one draft, so the status bar has no draft label until a second exists. Draft 2
  // is a duplicate; a word typed there shows as an insert against Draft 1, a revert takes it out,
  // and typed again it lives in Draft 2 only. The step ends back on Draft 1.
  const draftScene = imported[3]?.id ?? ''
  const draftWord = 'Quillmarrow'
  const draftEditor = page.getByRole('textbox', { name: 'Document' })
  const draftsDialog = page.getByRole('dialog', { name: 'Drafts' })
  const draftRows = draftsDialog.getByTestId('draft-row')
  await expect(page.getByTestId('status-draft')).toHaveCount(0)
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'Tools' })
    .click()
  await page.getByRole('menu', { name: 'Tools' }).getByRole('menuitem', { name: 'Drafts…' }).click()
  await expect(draftRows).toHaveCount(1)
  await expect(draftRows.first()).toHaveAttribute('aria-current', 'true')
  await expect(draftRows.first()).toContainText('Draft 1')
  await draftsDialog.getByRole('button', { name: 'Duplicate Draft 1…' }).click()
  const duplicatePrompt = page.getByRole('dialog', { name: 'Duplicate draft' })
  await expect(duplicatePrompt.getByRole('textbox', { name: 'Duplicate draft' })).toHaveValue(
    'Draft 2'
  )
  await duplicatePrompt.getByRole('button', { name: 'Duplicate', exact: true }).click()
  await expect(draftRows).toHaveCount(2)
  await draftsDialog.getByRole('button', { name: 'Switch to Draft 2' }).click()
  await expect(draftRows.nth(1)).toHaveAttribute('aria-current', 'true')
  await expect(page.getByTestId('status-draft')).toHaveText('Draft 2')
  await draftsDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(draftsDialog).toHaveCount(0)
  // The switch rebuilt the editor; type at the end of the scene and wait for the autosave.
  await caretToEnd(draftEditor)
  await page.keyboard.type(` ${draftWord}`)
  await expect.poll(() => documentText(draftScene)).toContain(draftWord)
  await dismissToasts()
  await page.getByTestId('status-draft').click()
  await draftsDialog.getByRole('button', { name: 'Compare Draft 1 with current' }).click()
  const draftDiff = draftsDialog.getByRole('region', { name: 'Scene 1 (split)' })
  await expect(draftDiff.locator('ins', { hasText: draftWord })).toHaveCount(1)
  await expect(draftsDialog.getByTestId('draft-compare-summary')).toContainText('1 scene differs')
  await draftDiff.getByRole('button', { name: 'Revert this scene to "Draft 1"' }).click()
  await expect(draftsDialog.getByTestId('draft-compare-summary')).toHaveText(
    'The two drafts read the same.'
  )
  await expect(draftEditor).not.toContainText(draftWord)
  expect(await documentText(draftScene)).not.toContain(draftWord)
  await draftsDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await caretToEnd(draftEditor)
  await page.keyboard.type(` ${draftWord}`)
  await expect.poll(() => documentText(draftScene)).toContain(draftWord)
  await dismissToasts()
  await page.getByTestId('status-draft').click()
  await draftsDialog.getByRole('button', { name: 'Switch to Draft 1' }).click()
  await expect(page.getByTestId('status-draft')).toHaveText('Draft 1')
  await expect(draftEditor).toContainText(crashSentence)
  await expect(draftEditor).not.toContainText(draftWord)
  await draftsDialog.getByRole('button', { name: 'Switch to Draft 2' }).click()
  await expect(page.getByTestId('status-draft')).toHaveText('Draft 2')
  await expect(draftEditor).toContainText(draftWord)
  await draftsDialog.getByRole('button', { name: 'Switch to Draft 1' }).click()
  await expect(page.getByTestId('status-draft')).toHaveText('Draft 1')
  await expect(draftEditor).not.toContainText(draftWord)
  await draftsDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(draftsDialog).toHaveCount(0)

  // F-8.6: snapshots, still in the restored copy on Draft 1 with Scene 1 (split) open. A
  // whole-project snapshot holds the scene as it reads now; a word typed afterwards shows as an
  // insert against it, "Restore this document" takes it out again, and the restore leaves an
  // automatic snapshot of the text it overwrote.
  const snapshotWord = 'Lanternwick'
  const snapshotName = 'Before the lantern'
  const snapshotsDialog = page.getByRole('dialog', { name: 'Snapshots' })
  const snapshotRows = snapshotsDialog.getByTestId('snapshot-row')
  const openSnapshots = async (): Promise<void> => {
    await page
      .getByRole('menubar', { name: 'Application menu' })
      .getByRole('menuitem', { name: 'Tools' })
      .click()
    await page
      .getByRole('menu', { name: 'Tools' })
      .getByRole('menuitem', { name: 'Snapshots…' })
      .click()
    await expect(snapshotsDialog).toBeVisible()
  }
  await openSnapshots()
  const takeForm = snapshotsDialog.getByRole('form', { name: 'Take snapshot' })
  await expect(
    takeForm.getByRole('radio', { name: 'This document (Scene 1 (split))' })
  ).toBeChecked()
  await takeForm.getByRole('radio', { name: 'Whole project' }).check()
  await takeForm.getByLabel('Name', { exact: true }).fill(snapshotName)
  await takeForm.getByRole('button', { name: 'Take snapshot' }).click()
  await expect(snapshotRows).toHaveCount(1)
  await expect(snapshotRows.first()).toContainText(snapshotName)
  await expect(snapshotRows.first()).toContainText('Whole project')
  await snapshotsDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(snapshotsDialog).toHaveCount(0)
  await dismissToasts()
  await caretToEnd(draftEditor)
  await page.keyboard.type(` ${snapshotWord}`)
  await expect.poll(() => documentText(draftScene)).toContain(snapshotWord)
  await dismissToasts()
  await openSnapshots()
  await snapshotsDialog
    .getByRole('button', { name: `Compare ${snapshotName} with current` })
    .click()
  const snapshotDiff = snapshotsDialog.getByRole('region', { name: 'Scene 1 (split)' })
  await expect(snapshotDiff.locator('ins', { hasText: snapshotWord })).toHaveCount(1)
  await expect(snapshotsDialog.getByTestId('snapshot-compare-summary')).toContainText(
    '1 document differs'
  )
  await snapshotDiff.getByRole('button', { name: 'Restore this document' }).click()
  await expect(snapshotsDialog.getByTestId('snapshot-compare-summary')).toHaveText(
    'The snapshot reads the same as the current text.'
  )
  await expect(draftEditor).not.toContainText(snapshotWord)
  await expect(draftEditor).toContainText(crashSentence)
  expect(await documentText(draftScene)).not.toContain(snapshotWord)
  await snapshotsDialog.getByRole('button', { name: 'Back to snapshots' }).click()
  await expect(snapshotRows).toHaveCount(2)
  await expect(snapshotRows.first()).toContainText(`Before restoring "${snapshotName}"`)
  await expect(snapshotRows.first()).toContainText('Auto')
  await snapshotsDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(snapshotsDialog).toHaveCount(0)

  // Layout 3c: the panel menu is the keyboard alternative to dragging a grip. Move right puts
  // the sidebar's column right of the editor; the arrangement is written to app state and comes
  // back after the relaunch below, where View › Reset layout puts it back.
  const sidebarTabsList = page.getByRole('button', { name: /^Section: / })
  const editorColumn = page.locator('main > section')
  const leftOf = async (a: Locator, b: Locator): Promise<boolean> => {
    const [boxA, boxB] = [await a.boundingBox(), await b.boundingBox()]
    if (!boxA || !boxB) throw new Error('not laid out')
    return boxA.x < boxB.x
  }
  expect(await leftOf(sidebarTabsList, editorColumn)).toBe(true)
  await page.getByRole('button', { name: 'Sidebar panel options' }).click()
  await page.getByRole('menuitem', { name: 'Move right' }).click()
  await expect.poll(() => leftOf(editorColumn, sidebarTabsList)).toBe(true)
  await expect
    .poll(async () => (await getLayout()).dock.columns.slice(0, 2), { timeout: 3000 })
    .toEqual([['editor'], ['sidebar']])

  // F-1.7: where the author was comes back with the project. Scene 1 (split) is open; the caret
  // goes after its first three characters and the session saves it after its debounce. Then,
  // as the last moves before the window closes (so the flush on close writes them), the last
  // expandable folder folds shut and the sidebar moves to the Outline tab. After the relaunch
  // below the same scene is open with the caret there (a typed letter lands at that spot), the
  // folder is still folded, and the Outline tab is showing.
  const resumeEditor = page.getByRole('textbox', { name: 'Document' })
  const resumeTabs = page.getByRole('button', { name: /^Section: / })
  const resumeTree = page.getByRole('tree', { name: 'Document tree' })
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1 (split)')
  const resumeText = (await documentText(draftScene)) ?? ''
  expect(resumeText.length).toBeGreaterThan(3)
  // The keys wait out ProseMirror's focus timer (`clickIntoEditor`): a move it undid landed the
  // caret back at 1.
  await clickIntoEditor(resumeEditor)
  await page.keyboard.press('Control+Home')
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
  // The caret after three characters is position 4 (the paragraph opens at 1); the session
  // holds it after its debounce.
  await expect
    .poll(async () => {
      const session = await getSession()
      return [session.selectedNodeId, session.positions[0]?.selection]
    })
    .toEqual([draftScene, { anchor: 4, head: 4 }])
  const foldButton = resumeTree.getByRole('button', { name: /^Collapse / }).last()
  const foldName = ((await foldButton.getAttribute('aria-label')) ?? '').replace(/^Collapse /, '')
  expect(foldName).not.toBe('')
  await foldButton.click()
  await expect(resumeTree.getByRole('button', { name: `Expand ${foldName}` })).toBeVisible()
  await showSection('Outline')
  await expect(resumeTabs).toHaveAccessibleName('Section: Outline')

  // F-7.9: the window closes somewhere else at another size, with the project still open; the
  // next launch puts the window back there and opens the project again.
  const left = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setBounds({ x: 40, y: 30, width: 1000, height: 700 })
    return win?.getNormalBounds()
  })
  const openProject = await page.evaluate(
    () =>
      window.mythscribe.invoke('project:current', undefined) as Promise<
        IpcResult<{ path: string } | null>
      >
  )
  if (!openProject.ok || openProject.data === null) throw new Error('no project open at the end')

  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await closed
  expect(exited).toBe(true)

  await launch()
  await expect(page.getByTestId('project-name')).toBeVisible()
  await expect(page.getByRole('button', { name: 'New project' })).toHaveCount(0)
  // F-1.7: the same scene, focused at the same caret; the Outline tab; the folder still folded.
  // (The relaunch made a new page, so the locators are taken again.)
  const resumedEditor = page.getByRole('textbox', { name: 'Document' })
  const resumedTabs = page.getByRole('button', { name: /^Section: / })
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1 (split)')
  await expect(resumedEditor).toBeFocused()
  await page.keyboard.type('Z')
  await expect
    .poll(() => documentText(draftScene))
    .toBe(`${resumeText.slice(0, 3)}Z${resumeText.slice(3)}`)
  await page.keyboard.press('Backspace')
  await expect.poll(() => documentText(draftScene)).toBe(resumeText)
  await expect(resumedTabs).toHaveAccessibleName('Section: Outline')
  await showSection('Manuscript')
  const resumedTree = page
    .getByRole('region', { name: 'Manuscript section', exact: true })
    .getByRole('tree')
  await expect(resumedTree).toBeVisible()
  await expect(resumedTree.getByRole('button', { name: `Expand ${foldName}` })).toBeVisible()
  const relaunched = await page.evaluate(
    () =>
      window.mythscribe.invoke('project:current', undefined) as Promise<
        IpcResult<{ path: string } | null>
      >
  )
  expect(relaunched.ok && relaunched.data?.path).toBe(openProject.data.path)
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getNormalBounds())
  ).toEqual(left)
  // Layout 3c: the sidebar came back right of the editor; View › Reset layout returns it.
  const relaunchedTabs = page.getByRole('button', { name: /^Section: / })
  const relaunchedEditor = page.locator('main > section')
  const boxOf = async (locator: Locator): Promise<number> => {
    const box = await locator.boundingBox()
    if (!box) throw new Error('not laid out')
    return box.x
  }
  expect(await boxOf(relaunchedEditor)).toBeLessThan(await boxOf(relaunchedTabs))
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'View' })
    .click()
  await page
    .getByRole('menu', { name: 'View' })
    .getByRole('menuitem', { name: 'Reset layout' })
    .click()
  await expect
    .poll(async () => (await boxOf(relaunchedTabs)) < (await boxOf(relaunchedEditor)))
    .toBe(true)
  await expect
    .poll(async () => (await getLayout()).dock.columns[0], { timeout: 3000 })
    .toEqual(['sidebar'])

  // Developer tools (2026-10-07): off by default, so Help has no developer items; Settings ›
  // Advanced turns them on, Help › Developer tools opens the panel, and a ghost-text request the
  // fake server fails shows in the AI inspector with its code, and in the live log. The project
  // has no key by now, so the probe goes to the local server (the fake one, saved above).
  const devMenuBar = page.getByRole('menubar', { name: 'Application menu' })
  await devMenuBar.getByRole('menuitem', { name: 'Help' }).click()
  await expect(page.getByRole('menu', { name: 'Help' })).toBeVisible()
  await expect(
    page.getByRole('menu', { name: 'Help' }).getByRole('menuitem', { name: 'Developer tools' })
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Settings' }).click()
  const devSettings = page.getByRole('dialog', { name: 'Settings' })
  await devSettings.getByRole('tab', { name: 'Advanced' }).click()
  await devSettings.getByTestId('devtools-enabled').check()
  await expect(devSettings.getByTestId('devtools-enabled')).toBeChecked()
  await devSettings.getByRole('button', { name: 'Close settings' }).click()
  await devMenuBar.getByRole('menuitem', { name: 'Help' }).click()
  await page
    .getByRole('menu', { name: 'Help' })
    .getByRole('menuitem', { name: 'Developer tools' })
    .click()
  const devPanel = page.getByRole('region', { name: 'Developer tools' })
  await expect(devPanel).toBeVisible()
  const devAiBefore = await aiSettings()
  const devScene = (await listTree()).find((n) => n.hierarchyLevel === 'scene')
  if (!devScene) throw new Error('no scene for the devtools probe')
  const devProbe = await page.evaluate(
    async (input) => {
      const set = await window.mythscribe.invoke('aiSettings:set', input.settings)
      if (!set.ok) return set
      return window.mythscribe.invoke('ai:ghostText', input.request)
    },
    {
      settings: {
        ...devAiBefore,
        source: 'local' as const,
        dial: 1,
        features: { ...devAiBefore.features, ghostText: true }
      },
      request: {
        nodeId: devScene.id,
        before: `${DEVTOOLS_FAIL_SENTINEL} `,
        after: '',
        requestId: 'devtools-probe'
      }
    }
  )
  expect(devProbe).toMatchObject({ ok: true, data: { ok: false, code: 'PROVIDER' } })
  const devRow = devPanel.getByTestId('devtools-request').filter({ hasText: 'failed' }).first()
  await expect(devRow).toContainText('ghostText')
  await expect(devRow).toContainText('PROVIDER')
  await devRow.getByRole('button').first().click()
  await expect(devRow).toContainText('devtools-probe')
  await devPanel.getByRole('tab', { name: /Log/ }).click()
  await expect(devPanel.getByTestId('devtools-log')).toContainText('ghostText failed: PROVIDER')
  await page.evaluate(
    (settings) => window.mythscribe.invoke('aiSettings:set', settings),
    devAiBefore
  )
  await devPanel.getByRole('button', { name: 'Close developer tools' }).click()
  await expect(devPanel).toHaveCount(0)

  // Flexible nesting (the author, 2026-10-07): right-click Arc 1 → New Scene creates the scene
  // right under the arc (Interlude); a second one (Prologue) dragged onto Arc 1's top edge lands
  // on the manuscript root, first. The compiled preview heads both like chapters.
  const nestRows = await listTree()
  const nestRoot = nestRows.find((n) => n.sectionType === 'manuscript')
  const nestArc1 = nestRows.find((n) => n.parentId === nestRoot?.id && n.position === 0)
  if (!nestRoot || nestArc1?.hierarchyLevel !== 'part') throw new Error('Arc 1 not found')
  const rowOf = (id: string): Locator => resumedTree.locator(`[data-node-id="${id}"] > div`).first()
  const nestMenu = page.getByRole('menu')
  const newSceneInArc1 = async (title: string): Promise<string> => {
    await rowOf(nestArc1.id).click({ button: 'right' })
    await nestMenu.getByRole('menuitem', { name: 'New Scene' }).click()
    await expect(nestMenu).toBeHidden()
    await expect(page.getByRole('textbox', { name: 'Rename' })).toBeFocused()
    await page.keyboard.type(title)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('textbox', { name: 'Rename' })).toBeHidden()
    const made = (await listTree()).find((n) => n.title === title)
    if (!made) throw new Error(`${title} was not created`)
    expect(made).toMatchObject({ parentId: nestArc1.id, hierarchyLevel: 'scene' })
    return made.id
  }
  const interludeId = await newSceneInArc1('Interlude')
  const prologueId = await newSceneInArc1('Prologue')
  await rowOf(prologueId).dragTo(rowOf(nestArc1.id), { targetPosition: { x: 60, y: 4 } })
  await expect
    .poll(async () => {
      const node = (await listTree()).find((n) => n.id === prologueId)
      return [node?.parentId, node?.position]
    })
    .toEqual([nestRoot.id, 0])
  expect((await listTree()).find((n) => n.id === interludeId)?.parentId).toBe(nestArc1.id)
  await expect(page.locator('[data-drop]')).toHaveCount(0)
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'View' })
    .click()
  await page
    .getByRole('menu', { name: 'View' })
    .getByRole('menuitem', { name: 'Compiled preview' })
    .click()
  const nestCompiled = page.getByRole('dialog', { name: 'Compiled preview' })
  const nestHeadings = nestCompiled
    .getByTestId('compile-preview')
    .locator('[data-testid="compile-heading"][data-level="chapter"]')
  await expect(nestHeadings.first()).toHaveText('Prologue')
  await expect(nestHeadings.filter({ hasText: 'Interlude' })).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(nestCompiled).toHaveCount(0)
})

// 2026-10-08: a project in Google Drive (any path with a "My Drive" folder) is worked on through a
// local copy under userData; the database in the folder is only ever written whole, by the copy
// back, and is never opened by SQLite (so no -wal ever appears beside it).
test('a project in a Google Drive folder works on a local copy and is copied back', async () => {
  const drive = path.join(tmp, 'My Drive')
  fs.mkdirSync(drive, { recursive: true })
  const folder = path.join(drive, 'Drive Novel.mythscribe')
  const phrase = 'Rain kept falling on the drive'
  const made = await page.evaluate(
    (directory) =>
      window.mythscribe.invoke('project:create', {
        name: 'Drive Novel',
        format: 'webnovel',
        directory
      }) as Promise<IpcResult<ProjectInfo | null>>,
    drive
  )
  if (!made.ok || !made.data) throw new Error('the Drive project was not created')
  expect(made.data.path).toBe(folder)
  await expect(page.getByTestId('project-name')).toHaveText('Drive Novel')
  expect(fs.existsSync(path.join(folder, 'project.db'))).toBe(true)
  const working = path.join(tmp, 'userData', 'working')
  expect(fs.readdirSync(working)).toHaveLength(1)

  const scene = (await listTree()).find((n) => n.title === 'Scene 1')
  if (!scene) throw new Error('the starter has no Scene 1')
  await page
    .getByRole('tree', { name: 'Document tree' })
    .getByRole('treeitem', { name: 'Scene 1', exact: true })
    .first()
    .click()
  await expect(page.getByTestId('status-cloud')).toContainText('Google Drive')
  const editor = page.getByRole('textbox', { name: 'Document' })
  await editor.click()
  await page.keyboard.type(phrase)
  await expect.poll(() => documentText(scene.id), { timeout: 5000 }).toContain(phrase)
  // SQLite works on the local copy: nothing of its own appears in the Drive folder.
  expect(fs.existsSync(path.join(folder, 'project.db-wal'))).toBe(false)

  // Closing copies the working copy back; the Drive database then holds the text.
  const closed = await page.evaluate(
    () => window.mythscribe.invoke('project:close', undefined) as Promise<IpcResult<null>>
  )
  expect(closed.ok).toBe(true)
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()
  expect(fs.readFileSync(path.join(folder, 'project.db')).includes(phrase)).toBe(true)
  expect(fs.existsSync(path.join(folder, 'project.db-wal'))).toBe(false)
  expect(fs.existsSync(path.join(folder, '.mythscribe-open'))).toBe(false)

  // Reopening finds the text again.
  const reopened = await page.evaluate(
    (target) =>
      window.mythscribe.invoke('project:open', { path: target }) as Promise<
        IpcResult<ProjectInfo | null>
      >,
    folder
  )
  expect(reopened.ok).toBe(true)
  await expect(page.getByTestId('project-name')).toHaveText('Drive Novel')
  expect(await documentText(scene.id)).toContain(phrase)
})

/** The single-document editor's text with the ghost-text widget (F-5.3) left out. */
/**
 * Dismisses every toast on screen, first one first: clicking one removes it and moves the rest
 * up, so a snapshot of the list goes stale after the first click. A toast may also time out on
 * its own between the count and the click, so the list is counted again before every click and
 * a click on a toast that just left is not an error.
 */
/**
 * F-9.11: shows a sidebar section through the section picker — the used sections are listed,
 * the unused ones behind "Show unused sections", which is opened only when the section is not
 * already listed.
 */
async function showSection(name: string): Promise<void> {
  await page.getByRole('button', { name: /^Section: / }).click()
  const list = page.getByRole('listbox', { name: 'Sections' })
  const option = list.getByRole('option', { name, exact: true })
  if ((await option.count()) === 0) {
    await list.getByRole('option', { name: /^Show unused sections/ }).click()
  }
  await option.click()
  await expect(list).toHaveCount(0)
}

/** The picker's options as their visible text (name and count). */
function sectionOptions(): Locator {
  return page.getByRole('listbox', { name: 'Sections' }).getByRole('option')
}

async function dismissToasts(): Promise<void> {
  const buttons = page.getByRole('button', { name: 'Dismiss notification' })
  while ((await buttons.count()) > 0) {
    await buttons
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined)
  }
}

/**
 * Clicks into an editor and waits out ProseMirror's focus timer before any key is pressed.
 * On gaining focus, prosemirror-view (`handlers.focus`) schedules a 20 ms timer that writes its
 * own selection back into the DOM unless it has already read the DOM's, so an End or
 * Control+End pressed in between is undone and the caret falls back to where the click put it.
 * The typed text then lands mid-paragraph (the F-14.6 disclosure count off by one, the
 * typewriter lines at the top of the scene, a ghost suggestion asked for in the wrong place:
 * the e2e caret flakes up to 2026-10-08). A page timer of the same 20 ms set after the click
 * fires after ProseMirror's, so this waits for that timer itself, not for a guessed delay.
 */
async function clickIntoEditor(target: Locator): Promise<void> {
  await target.click()
  await expect(target).toBeFocused()
  await target.page().evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))
}

/** Whether the DOM caret is collapsed at the very end of `target`'s text. */
function caretAtEnd(target: Locator): Promise<boolean> {
  return target.evaluate((root) => {
    const selection = document.getSelection()
    if (!selection?.focusNode || !root.lastChild || !root.contains(selection.focusNode)) {
      return false
    }
    const rest = document.createRange()
    rest.setStart(selection.focusNode, selection.focusOffset)
    rest.setEndAfter(root.lastChild)
    return selection.isCollapsed && rest.toString() === ''
  })
}

/** Clicks into `target` and puts the caret at the end of the document, checked, ready to type. */
async function caretToEnd(target: Locator): Promise<void> {
  await clickIntoEditor(target)
  await target.page().keyboard.press('Control+End')
  await expect.poll(() => caretAtEnd(target)).toBe(true)
}

/**
 * The viewport once the renderer has caught up with the window. Main reports fullscreen before
 * the renderer has resized, so a size read at once can be the old one, and a pointer placed at
 * its bottom edge then misses the control bar's show zone (seen on WSLg; under Xvfb, with no
 * window manager, fullscreen never resizes the window, and the sizes agree at once).
 */
async function fullscreenViewport(): Promise<{ w: number; h: number }> {
  const contentSize = (): Promise<{ w: number; h: number } | null> =>
    app.evaluate(({ BrowserWindow }) => {
      const bounds = BrowserWindow.getAllWindows()[0]?.getContentBounds()
      return bounds === undefined ? null : { w: bounds.width, h: bounds.height }
    })
  const viewport = (): Promise<{ w: number; h: number }> =>
    page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  await expect
    .poll(async () => {
      const [inner, content] = await Promise.all([viewport(), contentSize()])
      return inner.w === content?.w && inner.h === content.h
    })
    .toBe(true)
  return viewport()
}

async function documentTextWithoutGhost(): Promise<string> {
  return page.getByRole('textbox', { name: 'Document' }).evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement
    clone.querySelectorAll('.ghost-text').forEach((ghost) => ghost.remove())
    return clone.textContent ?? ''
  })
}

async function closeProject(): Promise<void> {
  await page.getByRole('button', { name: 'Close project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()
}

async function stubOpenDialog(filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] })
  }, filePath)
}

/** The native open dialog answers these paths, as a multiple selection does (F-9.8). */
async function stubOpenDialogFiles(filePaths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: chosen })
  }, filePaths)
}

/** The native save dialog answers this path (F-9.5 exports; the wizard patches it the same way). */
async function stubSaveDialog(filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: chosen })
  }, filePath)
}

/** The plain text of a Tiptap document: paragraphs joined by newlines. */
function plainText(n: TiptapNodeT): string {
  return n.text ?? (n.content ?? []).map(plainText).join(n.type === 'doc' ? '\n' : '')
}

/** The plain text of a saved document, or null when never written. */
async function documentText(id: string): Promise<string | null> {
  const result = await page.evaluate<
    IpcResult<{ id: string; content: TiptapNodeT | null }>,
    string
  >(
    (nodeId) =>
      window.mythscribe.invoke('document:get', { id: nodeId }) as Promise<
        IpcResult<{ id: string; content: TiptapNodeT | null }>
      >,
    id
  )
  if (!result.ok) throw new Error(`document:get failed: ${result.error.message}`)
  return result.data.content ? plainText(result.data.content) : null
}

/** The tag ids of every tag range (F-4.8) in a saved document, one per marked text node. */
async function savedTagRanges(id: string): Promise<string[]> {
  const result = await page.evaluate<
    IpcResult<{ id: string; content: TiptapNodeT | null }>,
    string
  >(
    (nodeId) =>
      window.mythscribe.invoke('document:get', { id: nodeId }) as Promise<
        IpcResult<{ id: string; content: TiptapNodeT | null }>
      >,
    id
  )
  if (!result.ok) throw new Error(`document:get failed: ${result.error.message}`)
  const ids: string[] = []
  const walk = (n: TiptapNodeT): void => {
    for (const mark of n.marks ?? []) {
      if (mark.type === 'tagRange' && typeof mark.attrs?.tagId === 'string')
        ids.push(mark.attrs.tagId)
    }
    for (const child of n.content ?? []) walk(child)
  }
  if (result.data.content) walk(result.data.content)
  return ids
}

/** Every stored tag (F-4.1), as `tag:list` answers. */
async function listTags(): Promise<Tag[]> {
  const result = await page.evaluate<IpcResult<Tag[]>>(
    () => window.mythscribe.invoke('tag:list', undefined) as Promise<IpcResult<Tag[]>>
  )
  if (!result.ok) throw new Error(`tag:list failed: ${result.error.message}`)
  return result.data
}

/** The words the spellchecker accepts beyond its own dictionary (F-3.11, F-3.14), as the session holds them. */
function spellcheckerWords(): Promise<string[]> {
  return app.evaluate(({ session }) => session.defaultSession.listWordsInSpellCheckerDictionary())
}

/** Every stored entity (F-9.1), as `entity:list` answers. */
async function listEntities(): Promise<Entity[]> {
  const result = await page.evaluate<IpcResult<Entity[]>>(
    () => window.mythscribe.invoke('entity:list', undefined) as Promise<IpcResult<Entity[]>>
  )
  if (!result.ok) throw new Error(`entity:list failed: ${result.error.message}`)
  return result.data
}

/** Every dated fact of one record (F-9.13), the hidden ones included, as main lists them. */
/** A record's field facts (F-9.14): its relationships and thread events left out. */
async function fieldFactsOf(entityId: string): Promise<Fact[]> {
  return (await factsOf(entityId)).filter(
    (fact) => fact.objectEntityId === null && !fact.attribute.includes(':')
  )
}

async function factsOf(entityId: string): Promise<Fact[]> {
  const result = await page.evaluate<IpcResult<Fact[]>, string>(
    (id) =>
      window.mythscribe.invoke('fact:listForEntity', { entityId: id }) as Promise<
        IpcResult<Fact[]>
      >,
    entityId
  )
  if (!result.ok) throw new Error(`fact:listForEntity failed: ${result.error.message}`)
  return result.data
}

/** The quick reference panel's pins as the project stores them (F-9.6), in order. */
async function referencePins(): Promise<ReferencePin[]> {
  const result = await page.evaluate<IpcResult<ReferencePins>>(
    () => window.mythscribe.invoke('reference:get', undefined) as Promise<IpcResult<ReferencePins>>
  )
  if (!result.ok) throw new Error(`reference:get failed: ${result.error.message}`)
  return result.data.pins
}

/** The plain text of a node's saved notes (F-3.7), or null when never written. */
async function notesText(id: string): Promise<string | null> {
  const result = await page.evaluate<IpcResult<{ id: string; notes: TiptapNodeT | null }>, string>(
    (nodeId) =>
      window.mythscribe.invoke('notes:get', { id: nodeId }) as Promise<
        IpcResult<{ id: string; notes: TiptapNodeT | null }>
      >,
    id
  )
  if (!result.ok) throw new Error(`notes:get failed: ${result.error.message}`)
  return result.data.notes ? plainText(result.data.notes) : null
}

/** A node's saved scene metadata (F-4.5) including its brief (F-14.3), as main reports it. */
async function sceneMetaOf(id: string): Promise<SceneMeta> {
  const result = await page.evaluate<IpcResult<{ id: string; meta: SceneMeta }>, string>(
    (nodeId) =>
      window.mythscribe.invoke('sceneMeta:get', { id: nodeId }) as Promise<
        IpcResult<{ id: string; meta: SceneMeta }>
      >,
    id
  )
  if (!result.ok) throw new Error(`sceneMeta:get failed: ${result.error.message}`)
  return result.data.meta
}

/** The persisted panel layout (F-7.2) as main reports it. */
async function aiStatus(): Promise<AiStatus> {
  const result = await page.evaluate<IpcResult<AiStatus>>(
    () => window.mythscribe.invoke('ai:getStatus', undefined) as Promise<IpcResult<AiStatus>>
  )
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

/** The project's AI dial and toggles (F-14.4) as main reads them from the settings table. */
/** A valid 1×1 RGB PNG (F-6.2): the smallest image the background e2e step can upload. */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwTpsJAAICATNWh+JUAAAAAElFTkSuQmCC'

/** The project's focus-mode settings (F-6.2), read through the bridge. */
async function focusSettings(): Promise<FocusSettings> {
  const result = await page.evaluate<IpcResult<FocusSettings>>(
    () =>
      window.mythscribe.invoke('focusSettings:get', undefined) as Promise<IpcResult<FocusSettings>>
  )
  if (!result.ok) throw new Error(`focusSettings:get failed: ${result.error.message}`)
  return result.data
}

async function aiSettings(): Promise<AiSettings> {
  const result = await page.evaluate<IpcResult<AiSettings>>(
    () => window.mythscribe.invoke('aiSettings:get', undefined) as Promise<IpcResult<AiSettings>>
  )
  if (!result.ok) throw new Error(`aiSettings:get failed: ${result.error.message}`)
  return result.data
}

/** The project's author rules (F-14.2) as main reads them from the settings table. */
async function authorRules(): Promise<AuthorRules> {
  const result = await page.evaluate<IpcResult<AuthorRules>>(
    () => window.mythscribe.invoke('authorRules:get', undefined) as Promise<IpcResult<AuthorRules>>
  )
  if (!result.ok) throw new Error(`authorRules:get failed: ${result.error.message}`)
  return result.data
}

/** The project's writing presets (F-5.2) as main reads them from the settings table. */
async function writingPresets(): Promise<WritingPresets> {
  const result = await page.evaluate<IpcResult<WritingPresets>>(
    () => window.mythscribe.invoke('presets:get', undefined) as Promise<IpcResult<WritingPresets>>
  )
  if (!result.ok) throw new Error(`presets:get failed: ${result.error.message}`)
  return result.data
}

/** The AI spend summary (F-5.14) as main reports it. */
async function usageSummary(): Promise<AiUsageSummary> {
  const result = await page.evaluate<IpcResult<AiUsageSummary>>(
    () =>
      window.mythscribe.invoke('ai:usageSummary', undefined) as Promise<IpcResult<AiUsageSummary>>
  )
  if (!result.ok) throw new Error(`ai:usageSummary failed: ${result.error.message}`)
  return result.data
}

/** The open project's stored session (F-1.7). */
async function getSession(): Promise<ProjectSession> {
  const result = await page.evaluate<IpcResult<ProjectSession>>(
    () => window.mythscribe.invoke('session:get', undefined) as Promise<IpcResult<ProjectSession>>
  )
  if (!result.ok) throw new Error(`session:get failed: ${result.error.message}`)
  return result.data
}

async function getLayout(): Promise<Layout> {
  const result = await page.evaluate<IpcResult<Layout>>(
    () => window.mythscribe.invoke('layout:get', undefined) as Promise<IpcResult<Layout>>
  )
  if (!result.ok) throw new Error(`layout:get failed: ${result.error.message}`)
  return result.data
}

/** Adds Chapter 2–3 under Arc 1 and Arc 2 → Chapter 1–3, each chapter with a Scene 1. */
async function growLegacyStarter(seeded: TreeNode[]): Promise<void> {
  const manuscript = seeded.find((n) => n.sectionType === 'manuscript')
  const arc1 = seeded.find((n) => n.parentId === manuscript?.id)
  if (!manuscript || !arc1) throw new Error('starter has no Arc 1')
  const make = async (
    parentId: string,
    kind: 'folder' | 'document',
    hierarchyLevel: 'part' | 'chapter' | 'scene',
    title: string
  ): Promise<string> => {
    const created = await page.evaluate(
      (input) => window.mythscribe.invoke('tree:create', input) as Promise<IpcResult<TreeNode>>,
      { parentId, kind, hierarchyLevel }
    )
    if (!created.ok) throw new Error(`tree:create failed: ${created.error.message}`)
    const renamed = await page.evaluate(
      (input) => window.mythscribe.invoke('tree:rename', input) as Promise<IpcResult<TreeNode>>,
      { id: created.data.id, title }
    )
    if (!renamed.ok) throw new Error(`tree:rename failed: ${renamed.error.message}`)
    return created.data.id
  }
  const chapters = async (partId: string, from: number): Promise<void> => {
    for (let c = from; c < 3; c++) {
      const chapter = await make(partId, 'folder', 'chapter', `Chapter ${c + 1}`)
      await make(chapter, 'document', 'scene', 'Scene 1')
    }
  }
  await chapters(arc1.id, 1)
  await chapters(await make(manuscript.id, 'folder', 'part', 'Arc 2'), 0)
}

async function listTree(): Promise<TreeNode[]> {
  const result = await page.evaluate<IpcResult<TreeNode[]>>(
    () => window.mythscribe.invoke('tree:list', undefined) as Promise<IpcResult<TreeNode[]>>
  )
  if (!result.ok) throw new Error(`tree:list failed: ${result.error.message}`)
  return result.data
}
