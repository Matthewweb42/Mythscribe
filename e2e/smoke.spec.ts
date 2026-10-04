import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { priceFor, type AiStatus, type AiUsageSummary } from '../src/shared/ai'
import type { AiSettings } from '../src/shared/aiSettings'
import type { AuthorRules } from '../src/shared/authorRules'
import { LOGIN_ATTEMPT_TTL_MS } from '../src/shared/cloudApi'
import { cloudChargeMicros, cloudPriceFor, MICROS_PER_USD } from '../src/shared/cloudRates'
import { USAGE_PERIOD_DAYS } from '../src/shared/cloudUsage'
import type { FocusSettings } from '../src/shared/focus'
import { encodeLicensePayload, formatLicenseToken, LICENSE_GRACE_MS } from '../src/shared/license'
import type { Entity, IpcResult, ProjectInfo, Tag, TreeNode } from '../src/shared/ipc/contract'
import type { Layout } from '../src/shared/layout'
import type { ObservedFact } from '../src/shared/observedFacts'
import { PRESETS, type WritingPresets } from '../src/shared/presets'
import type { ReferencePin, ReferencePins } from '../src/shared/references'
import { matterTemplate } from '../src/shared/matterTemplates'
import type { SceneMeta } from '../src/shared/sceneMeta'
import { STORY_BIBLE_HEADING } from '../src/shared/storyBible'
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
 * F-4.13: the tags the canned summary carries (`summary.v3` keeps the sentinel too). The tone is
 * new to the bank, so main creates it as AI-made and links it to the scene; "Zephyr" is a
 * character name Scene 1 never holds, so main must drop it.
 */
const SUMMARY_TAGS = [
  { name: 'stormbound', category: 'tone' },
  { name: 'Zephyr', category: 'character' }
]
const SUMMARY_ANSWER = JSON.stringify({
  summary: SUMMARY_TEXT,
  keyPoints: SUMMARY_KEY_POINTS,
  characters: SUMMARY_CHARACTERS,
  facts: SUMMARY_FACTS,
  tags: SUMMARY_TAGS
})
const BRIEF_SENTINEL = 'You are the scene-brief feature inside a novel-writing app.'
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
 * `src/main/ai/prompts/query.v1.ts`, repeated here for the same reason). A JSON request
 * carrying it gets the canned answer below: one citation quoting a passage of the scene that
 * ranks first, one quoting a passage that is nowhere in it, and one naming a scene that was
 * never sent, so both drop rules show and the dangling `[3]` marker is stripped.
 */
const QUERY_SENTINEL = 'You are the Story Intelligence feature inside a novel-writing app.'
const QUERY_QUESTION = 'Where does the storm reach the ridge?'
const QUERY_ANSWER_TEXT = 'She waits out the storm on the ridge [1], then crosses at dawn [3].'
/** What the answer reads once main drops the uncited scene and strips its marker. */
const QUERY_ANSWER_KEPT = 'She waits out the storm on the ridge [1], then crosses at dawn.'
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
/** F-5.10: a request whose body carries this waits before answering, so a Stop can land. */
const SLOW_SENTINEL = 'SLOW'
const SLOW_DELAY_MS = 3_000
const OFF_VOICE_SENTINEL = 'She counted the lanterns on the far bank.'
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
let fakeOpenAi: http.Server
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
          // F-5.4: a Plan turn streams (server-sent events in the shape the SDK parses: content
          // deltas, one usage-only chunk, then [DONE]); an Agent turn is a plain completion.
          if (request.stream) {
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/event-stream')
            const chunk = (payload: object): string =>
              `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 0, model: 'gpt-5.4-mini', ...payload })}\n\n`
            const answer = rewrite ? REWRITE_ANSWER : CHAT_ANSWER
            const cut = rewrite
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
                      ? whatNext
                        ? WHAT_NEXT_ANSWER
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
        setTimeout(respond, body.includes(SLOW_SENTINEL) ? SLOW_DELAY_MS : 0)
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
const CLOUD_USER_ID = 'e2e-user-1'
const CLOUD_SINCE = '2026-09-19T12:00:00.000Z'
/**
 * F-15.3: a little over $1.00 of credit, one pack on sale, and one feature that has spent
 * something. F-15.5: the period rows the meter shows, and a balance close enough to the
 * low-credit line ($1.00) that one charged Cloud request takes it under, so the status-bar
 * notice is driven for real. The fake keeps the balance: `/ai/complete` charges it and
 * `/credits` answers it, so what the app shows after a charge is what the Worker said.
 */
const CLOUD_BALANCE_MICROS = 1_003_000
let cloudBalanceMicros = CLOUD_BALANCE_MICROS
const CLOUD_PACK = { variantId: 'pack-5', priceCents: 500 }
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
 * as a different number from the OpenAI one.
 */
const CLOUD_AI_USAGE = { inputTokens: 10_000, outputTokens: 2_000 }
const CLOUD_AI_ANSWER = 'MythScribe Cloud answered this one.'
const CLOUD_QUESTION = 'Does MythScribe Cloud answer this?'
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
 * alone. It also answers the two credit routes (F-15.3) behind the same bearer, and `/license`
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
  const authorized = (req: http.IncomingMessage): boolean =>
    !cloudSessionRevoked && req.headers.authorization === `Bearer ${CLOUD_SESSION_TOKEN}`

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
        packs: [CLOUD_PACK]
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
        const chargeMicros = cloudChargeMicros(
          request.model,
          CLOUD_AI_USAGE.inputTokens,
          CLOUD_AI_USAGE.outputTokens
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
  const cloudApiUrl = await startFakeCloudApi()
  // Point app-level state (recents, the AI key, the Cloud session) at the temp dir so the
  // developer's real userData is untouched, the OpenAI SDK at the fake provider, and the account
  // routes (F-15.2) at the fake Worker, so nothing leaves the machine.
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MYTHSCRIBE_USER_DATA: path.join(tmp, 'userData'),
      OPENAI_BASE_URL: openAiBaseUrl,
      MYTHSCRIBE_CLOUD_API_URL: cloudApiUrl,
      // F-15.9: verify licenses against the fixture keypair, not the key the release ships with.
      MYTHSCRIBE_LICENSE_PUBLIC_KEY: JSON.stringify(LICENSE_FIXTURE.publicKey)
    }
  })
  app.on('close', () => {
    exited = true
  })
  page = await app.firstWindow()
})

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
  // step: where AI requests go.
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
  // F-15.11: own key is the default; the Cloud card says what it needs (nobody is signed in yet).
  await expect(wizard).toContainText('Step 3 of 3')
  await expect(wizard.getByRole('radio', { name: /^my own key/i })).toBeChecked()
  await wizard.getByText('MythScribe Cloud', { exact: true }).click()
  await expect(wizard.getByRole('radio', { name: /^mythscribe cloud/i })).toBeChecked()
  await expect(wizard.getByTestId('wizard-source-hint')).toContainText(
    'Sign in and buy credits under Settings › Account'
  )
  await wizard.getByRole('button', { name: 'Create' }).click()

  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
  // F-15.11: the choice was stored with the project, the AI tab opens on it with the Cloud rate
  // beside each model (2x the provider price), and it switches back: the rest of this test runs
  // on the author's own key.
  expect((await aiSettings()).source).toBe('cloud')
  await page.getByRole('button', { name: 'Settings' }).click()
  const firstSettings = page.getByRole('dialog', { name: 'Settings' })
  await firstSettings.getByRole('tab', { name: 'AI' }).click()
  await expect(firstSettings.getByTestId('ai-source-cloud')).toHaveAttribute('aria-checked', 'true')
  await expect(firstSettings.getByTestId('ai-model-rate-fast')).toHaveText(
    'MythScribe Cloud rate: $0.50 input, $4.00 output per 1M tokens.'
  )
  await expect(firstSettings.getByTestId('ai-model-rate-strong')).toHaveText(
    'MythScribe Cloud rate: $2.50 input, $20.00 output per 1M tokens.'
  )
  await firstSettings.getByTestId('ai-source-ownKey').click()
  await expect(firstSettings.getByTestId('ai-model-rate-fast')).toHaveCount(0)
  await expect.poll(async () => (await aiSettings()).source).toBe('ownKey')
  await firstSettings.getByRole('button', { name: 'Close settings' }).click()
  await expect(firstSettings).toHaveCount(0)
  // F-1.5: the shell header and window title carry the project name and format.
  await expect(page).toHaveTitle('Smoke Novel — MythScribe')
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

  // F-1.3: the new project is seeded with the three sections and the starter skeleton.
  const seeded = await listTree()
  expect(seeded).toHaveLength(17)
  expect(seeded.filter((n) => n.sectionType !== null)).toHaveLength(3)
  const titles = seeded.map((n) => n.title)
  expect(titles).toContain('Arc 1')
  expect(titles).toContain('Arc 2')
  expect(titles.filter((t) => t.startsWith('Chapter'))).toHaveLength(6)
  expect(titles.filter((t) => t === 'Scene 1')).toHaveLength(6)

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
  await expect
    .poll(storedView, { timeout: 3000 })
    .toEqual({ editorZoom: 1, uiScale: 'medium', pageEdges: true })

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

  // F-7.3: the sidebar is a tab bar; only the built tabs are listed (no placeholders: the entity
  // tabs arrived with F-9.2), Manuscript is selected, and its panel holds the tree.
  const sidebarTabs = page.getByRole('tablist', { name: 'Sidebar' })
  await expect(sidebarTabs.getByRole('tab')).toHaveText([
    'Manuscript',
    'Characters',
    'Settings',
    'World',
    'Tags'
  ])
  const manuscriptTab = sidebarTabs.getByRole('tab', { name: 'Manuscript' })
  await expect(manuscriptTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: 'Manuscript' }).getByRole('tree')).toBeVisible()

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
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await expect(settingsDialog.getByRole('tab', { name: 'AI' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  // F-14.4: the project's AI dial installs at Off, so every feature toggle is locked; Suggest
  // unlocks ghost text, the level lands in the project's settings table, and it survives
  // closing the dialog. Back to Off before the key steps so nothing below depends on it.
  const dial = settingsDialog.getByRole('radiogroup', { name: 'AI dial' })
  const ghostTextToggle = settingsDialog.getByRole('checkbox', { name: /^Ghost text/ })
  await expect(dial.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true')
  await expect(ghostTextToggle).toBeDisabled()
  await expect(ghostTextToggle).toHaveAccessibleName('Ghost text (needs Suggest)')
  expect((await aiSettings()).dial).toBe(0)
  await dial.getByRole('radio', { name: 'Suggest' }).click()
  await expect(dial.getByRole('radio', { name: 'Suggest' })).toHaveAttribute('aria-checked', 'true')
  await expect(ghostTextToggle).toBeEnabled()
  await expect(ghostTextToggle).toHaveAccessibleName('Ghost text')
  await expect.poll(async () => (await aiSettings()).dial).toBe(2)
  await expect(
    settingsDialog.getByRole('table', { name: 'What each AI feature sends' }).getByRole('row', {
      name: /^Ghost text /
    })
  ).toContainText('OpenAI')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await expect(dial.getByRole('radio', { name: 'Suggest' })).toHaveAttribute('aria-checked', 'true')
  await expect(ghostTextToggle).toBeEnabled()
  await dial.getByRole('radio', { name: 'Off' }).click()
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
  await expect(settingsDialog.getByText('OpenAI', { exact: true }).first()).toBeVisible()
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
    cloud: { fast: 'gpt-5.4-mini', strong: 'gpt-5.4' }
  })
  expect(
    (JSON.parse(fs.readFileSync(appStateFile, 'utf8')) as { models: AiStatus['models'] }).models
  ).toEqual({
    openai: { fast: 'gpt-5.4-nano', strong: 'gpt-5.4' },
    cloud: { fast: 'gpt-5.4-mini', strong: 'gpt-5.4' }
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
  // F-15.3: the credits section loads with the signed-in state. Buy is only checked for being
  // there; clicking it would hand a Lemon Squeezy URL to the machine's real browser.
  await expect(settingsDialog.getByTestId('account-credit-balance')).toHaveText(
    balanceText(cloudBalanceMicros)
  )
  await expect(settingsDialog.getByRole('button', { name: 'Buy $5' })).toBeVisible()
  // F-15.5: the meter over the rolling period, and no warning while the balance is above $1.00.
  await expect(settingsDialog.getByTestId('account-period-spent')).toHaveText(
    balanceText(CLOUD_PERIOD_SPEND.micros)
  )
  await expect(settingsDialog.getByTestId('account-run-out')).toContainText('left at this pace')
  await expect(settingsDialog.getByTestId('account-credit-warning')).toHaveCount(0)
  await expect(page.getByTestId('credit-notice')).toHaveCount(0)
  // F-15.4: the AI tab's source picker. With the account signed in, MythScribe Cloud names it
  // and Test connection reaches the fake Worker's `/credits` (no key is saved at this point).
  // The project goes back to the author's own key before anything else runs.
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await settingsDialog.getByTestId('ai-source-cloud').click()
  await expect(settingsDialog.getByTestId('ai-cloud-account')).toHaveText(
    'Signed in as author@example.com. Manage credits on the Account tab.'
  )
  const openAiBeforeCloudTest = openAiRequests.length
  await settingsDialog.getByRole('button', { name: 'Test connection' }).click()
  await expect(testResult).toHaveText('Connected. gpt-5.4-mini answered.')
  // It asked MythScribe Cloud, not OpenAI: the fake provider saw nothing.
  expect(openAiRequests).toHaveLength(openAiBeforeCloudTest)
  await settingsDialog.getByTestId('ai-source-ownKey').click()
  await expect.poll(async () => (await aiSettings()).source).toBe('ownKey')
  await settingsDialog.getByRole('tab', { name: 'Account' }).click()
  // F-15.9: the Supporter license. The fake Worker signs a token for this account, main verifies
  // it against the fixture public key and caches it, and the background refresh that follows the
  // sign-in is what puts the badge on the tab — nothing here clicks Refresh. The accent is the
  // cosmetic extra the license unlocks: it lands on <html>, is written to app-state.json, and is
  // still there after the window is reloaded from main's state alone.
  await expect(settingsDialog.getByTestId('account-supporter-badge')).toBeVisible({
    timeout: 15_000
  })
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
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('project-name')).toHaveText('Smoke Novel')
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'ember')
  // The reload dropped the renderer's selection (main keeps the project open, not the caret), so
  // put the scene and the dialog back for the steps that follow.
  await scene1.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(settingsDialog).toBeVisible()
  await settingsDialog.getByRole('tab', { name: 'Account' }).click()
  await settingsDialog.getByRole('button', { name: 'Sign out' }).click()
  await expect(settingsDialog.getByLabel('Email')).toBeVisible()
  // Signed out, Cloud says so and Test connection has nothing to test with.
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await settingsDialog.getByTestId('ai-source-cloud').click()
  await expect(settingsDialog.getByTestId('ai-cloud-account')).toHaveText(
    'Not signed in. Sign in on the Account tab to use MythScribe Cloud.'
  )
  await expect(settingsDialog.getByRole('button', { name: 'Test connection' })).toBeDisabled()
  await settingsDialog.getByTestId('ai-source-ownKey').click()
  await expect.poll(async () => (await aiSettings()).source).toBe('ownKey')
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
  await sidebarTabs.getByRole('tab', { name: 'Tags' }).click()
  const tagsPanel = page.getByRole('tabpanel', { name: 'Tags' })
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
  await expect(tagRows.getByRole('button')).toHaveText(['dark-forest 0 uses'])
  await expect(
    tagRows.getByRole('button', { name: /^dark-forest/ }).locator('span[aria-hidden]')
  ).toHaveCSS('background-color', 'rgb(234, 88, 12)')
  await categories.getByRole('tab', { name: 'Settings' }).click()
  await expect(tagRows.getByRole('button')).toHaveText(['dark-forest 0 uses'])
  await categories.getByRole('tab', { name: 'Tone' }).click()
  await expect(tagsPanel.getByText('No tags match.')).toBeVisible()
  const tagForm = tagsPanel.getByRole('form', { name: 'New tag' })
  await expect(tagForm.getByRole('combobox', { name: 'Category' })).toHaveValue('tone')
  await expect(tagForm.getByLabel('Color')).toHaveValue('#2563eb')
  await tagForm.getByRole('textbox', { name: 'Tag name' }).fill('Moody')
  await tagForm.getByRole('button', { name: 'Create tag' }).click()
  await expect(tagRows.getByRole('button')).toHaveText(['moody 0 uses'])
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
  await expect(tagRows.getByRole('button')).toHaveText(['dark-forest 0 uses'])
  // F-4.3: loading a template after the confirm adds its tags (28 for Standard Fiction) and toasts.
  const templates = tagsPanel.getByRole('form', { name: 'Tag templates' })
  await templates.getByRole('combobox', { name: 'Template' }).selectOption('standard-fiction')
  await templates.getByRole('button', { name: 'Load' }).click()
  const loadDialog = page.getByRole('dialog', { name: 'Load the Standard Fiction template?' })
  await expect(loadDialog).toBeVisible()
  await loadDialog.getByRole('button', { name: 'Load' }).click()
  await expect(loadDialog).toBeHidden()
  await expect(page.getByRole('status')).toContainText('Added 28 tags')
  await expect(tagRows.getByRole('button')).toHaveCount(29)
  await expect(tagRows.getByRole('button', { name: /^protagonist/ })).toBeVisible()

  // F-9.4: Scene 1 gains a sentence naming Mara, so the character created next has somewhere to
  // appear; it is taken out again once her page has shown it, so the text the later steps assert
  // is the one they were written for.
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(MARA_SENTENCE)
  await expect
    .poll(() => documentText(scene1Row.id), { timeout: 5000 })
    .toBe(`${SENTENCE}${MARA_SENTENCE}`)

  // F-9.2: the Characters tab starts empty; quick-add creates a character (structured template)
  // that appears as a card and is selected, the search hides and shows it, the list view drops
  // the card border, and Delete asks first and then removes it, so the tab says the kind is
  // empty again (the empty-kind message wins over the search's "no match").
  await sidebarTabs.getByRole('tab', { name: 'Characters' }).click()
  const charactersPanel = page.getByRole('tabpanel', { name: 'Characters' })
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
  const entityScenes = entityEditor.getByRole('list', { name: 'Scenes with Mara' })
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
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
  await scene1.click()
  await expect(entityEditor).toHaveCount(0)
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await sidebarTabs.getByRole('tab', { name: 'Characters' }).click()
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
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
  await scene1.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await sidebarTabs.getByRole('tab', { name: 'Characters' }).click()
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
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
  await expect(manuscriptTab).toHaveAttribute('aria-selected', 'true')
  await expect(tree).toBeVisible()

  // F-4.4: the tag bar above Scene 1's editor starts without chips; "Add tag" opens a picker of
  // the unassigned tags, searching "forest" narrows it to dark-forest (the template's plain
  // "dark" tone tag would also match "dark"), Enter links it as a chip, and the Tags tab shows
  // the usage at once; removing the chip returns it to 0. Collapsing hides the chips, the
  // picker, and the handle, and the state persists in the layout.
  await expect(scene1).toHaveAttribute('aria-selected', 'true')
  const tagBar = page.getByRole('region', { name: 'Tags', exact: true })
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
  await sidebarTabs.getByRole('tab', { name: 'Tags' }).click()
  await tagRows.getByRole('button', { name: /^dark-forest/ }).click()
  const taggedDocuments = tagsPanel.getByRole('list', { name: 'Documents with this tag' })
  await expect(taggedDocuments.getByRole('button')).toHaveText(['Scene 1Chapter 1'])
  await tagsPanel.getByRole('button', { name: 'Show in tree' }).click()
  await expect(manuscriptTab).toHaveAttribute('aria-selected', 'true')
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
  await sidebarTabs.getByRole('tab', { name: 'Tags' }).click()
  await expect(tagRows.getByRole('button', { name: /^dark-forest/ })).toHaveText(
    'dark-forest 1 use'
  )
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
  await tagBar.getByRole('button', { name: 'Remove dark-forest' }).click()
  await expect(tagBar.getByRole('listitem')).toHaveCount(0)
  await sidebarTabs.getByRole('tab', { name: 'Tags' }).click()
  await expect(tagRows.getByRole('button', { name: /^dark-forest/ })).toHaveText(
    'dark-forest 0 uses'
  )
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
  const tagBarToggle = tagBar.getByRole('button', { name: /^Tags/ })
  await expect(tagBarToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(tagBar.getByRole('separator', { name: 'Resize tag bar' })).toHaveAttribute(
    'aria-valuenow',
    '180'
  )
  await tagBarToggle.click()
  await expect(tagBarToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(tagBar.getByRole('button', { name: 'Add tag' })).toHaveCount(0)
  await expect(tagBar.getByRole('separator')).toHaveCount(0)
  await expect
    .poll(async () => (await getLayout()).tagBar, { timeout: 3000 })
    .toEqual({ open: false, height: 180, split: 0.4 })
  await tagBarToggle.click()
  await expect(tagBarToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(tagBar.getByRole('button', { name: 'Add tag' })).toBeVisible()

  // F-4.5: the metadata pane sits beside the chips for a scene. Location autocompletes from the
  // setting tags (typing "dark" offers dark-forest, Enter fills it in), POV and the timeline
  // position are free text. Showing another scene flushes the edits and coming back reloads
  // them from disk. The split between the panes moves from its handle and persists.
  const metadata = tagBar.getByRole('group', { name: 'Scene metadata' })
  const location = metadata.getByRole('combobox', { name: 'Location' })
  await expect(location).toBeEnabled()
  await location.fill('dark')
  await expect(
    metadata.getByRole('listbox', { name: 'Location suggestions' }).getByRole('option')
  ).toHaveText(['dark-forest'])
  await location.press('Enter')
  await expect(location).toHaveValue('dark-forest')
  await metadata.getByRole('combobox', { name: 'POV' }).fill('Mara')
  await metadata.getByRole('textbox', { name: 'Timeline' }).fill('Day 3, after the storm')
  await opening.getByText('Opening', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Opening')
  await expect(metadata.getByRole('combobox', { name: 'Location' })).toHaveValue('')
  await scene1.getByText('Scene 1', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect(metadata.getByRole('combobox', { name: 'Location' })).toHaveValue('dark-forest')
  await expect(metadata.getByRole('combobox', { name: 'POV' })).toHaveValue('Mara')
  await expect(metadata.getByRole('textbox', { name: 'Timeline' })).toHaveValue(
    'Day 3, after the storm'
  )
  const splitHandle = tagBar.getByRole('separator', { name: 'Resize metadata pane' })
  await expect(splitHandle).toHaveAttribute('aria-valuenow', '40')
  await splitHandle.focus()
  await page.keyboard.press('ArrowRight')
  await expect
    .poll(async () => (await getLayout()).tagBar.split, { timeout: 3000 })
    .toBeGreaterThan(0.4)

  // F-2.5/F-3.8: selecting Chapter 1 stacks Opening and Scene 1 in tree order, each as its own
  // region with the web-novel scene break between them; typing into Opening leaves Scene 1
  // untouched and autosaves under Opening's own id.
  await chapter1.getByText('Chapter 1', { exact: true }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Chapter 1')
  // The folder's own tag bar (F-4.5) is a region too; the document regions are the sections.
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
  await editor.click()
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
  await sidebarTabs.getByRole('tab', { name: 'Tags' }).click()
  await categories.getByRole('tab', { name: 'Custom' }).click()
  await expect(tagRows.getByRole('button')).toHaveText(['stormfront 1 use'])
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
  await tokens.first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Open in Tag Manager' }).click()
  await expect(sidebarTabs.getByRole('tab', { name: 'Tags' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(tagsPanel.getByRole('textbox', { name: 'Tag name' })).toHaveValue('dark-forest')
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
  await tokens.last().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Remove' }).click()
  await expect(tokens).toHaveText(['#dark-forest'])
  await expect(inlineList.getByRole('listitem')).toHaveText(['dark-forest ×1'])
  await expect(chipList.getByRole('listitem')).toHaveText(['dark-forest', 'stormfront'])
  await expect(page.getByTestId('status-words')).toHaveText(`${SENTENCE_WORDS + 2} words`)

  // F-4.12: automatic mentions. A character tag created through the bridge is found in the
  // text once the save and the scan's debounce have run: the tag bar's Mentions list counts it
  // apart from the chips (nothing is linked, nothing is inserted), Jump selects the word, the
  // Tag Manager's detail shows the document with a jump of its own, and Track mentions off
  // drops the rows at once (on again rescans). None of the template's tag names appear in
  // Scene 1 as plain words, so the list holds exactly the one row.
  await sidebarTabs.getByRole('tab', { name: 'Tags' }).click()
  await categories.getByRole('tab', { name: 'Characters' }).click()
  const roseForm = tagsPanel.getByRole('form', { name: 'New tag' })
  await roseForm.getByRole('textbox', { name: 'Tag name' }).fill('Rose')
  await roseForm.getByRole('button', { name: 'Create tag' }).click()
  await expect(tagRows.getByRole('button', { name: /^rose/ })).toHaveText('rose 0 uses')
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
  await editor.click()
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
  await sidebarTabs.getByRole('tab', { name: 'Tags' }).click()
  await categories.getByRole('tab', { name: 'Characters' }).click()
  await tagRows.getByRole('button', { name: /^rose/ }).click()
  await expect(tagsPanel.getByRole('textbox', { name: 'Tag name' })).toHaveValue('rose')
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
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()

  // F-4.12b: proposed tags. A capitalised name the manuscript keeps using mid-sentence that no
  // tag stands for is proposed in the bar of the document that carries it, with its count.
  // Create tag makes it a character tag — which is what the F-4.12 scan then finds — and
  // Dismiss keeps the name out for good, though the text still holds it and every later save
  // scans it again. Nothing is created or hidden until one of the two is clicked.
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' But Tash saw Tash, then Tash.')
  const proposedList = tagBar.getByRole('list', { name: 'Proposed tags' })
  await expect(proposedList.getByRole('listitem')).toHaveText(['Tash ×3'], { timeout: 15_000 })
  await proposedList.getByRole('button', { name: 'Create tag Tash' }).click()
  await expect(proposedList).toHaveCount(0)
  await expect(mentionList.getByRole('listitem')).toHaveText(['rose ×1', 'tash ×3'], {
    timeout: 15_000
  })
  await sidebarTabs.getByRole('tab', { name: 'Tags' }).click()
  await categories.getByRole('tab', { name: 'Characters' }).click()
  await expect(tagRows.getByRole('button', { name: /^tash/ })).toHaveText('tash 0 uses')
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' But Bren saw Bren, then Bren.')
  await expect(proposedList.getByRole('listitem')).toHaveText(['Bren ×3'], { timeout: 15_000 })
  await proposedList.getByRole('button', { name: 'Dismiss Bren' }).click()
  await expect(proposedList).toHaveCount(0)
  // A third name proposed after the dismissal is what proves the scan ran again and still
  // leaves Bren out; a plain "the list is empty" could have passed before the scan.
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' But Kael saw Kael, then Kael.')
  await expect(proposedList.getByRole('listitem')).toHaveText(['Kael ×3'], { timeout: 15_000 })

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
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' The river she had to cross was rising fast.')
  await expect(recommend).toBeEnabled()
  const requestsBefore = openAiRequests.length
  await recommend.click()
  const recommendResult = tagBar.getByTestId('tag-recommend-result')
  await expect(recommendResult).toHaveText(
    'Tag suggestions needs the AI dial at Ask or higher (it is at Off). Turn the AI dial up in Settings, or enable the feature there.'
  )
  expect(openAiRequests).toHaveLength(requestsBefore)
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await dial.getByRole('radio', { name: 'Ask' }).click()
  await expect.poll(async () => (await aiSettings()).dial).toBe(1)
  // F-5.6: summaries would otherwise run in the background after every save from here on
  // and disturb the exact request counts below; the summary step turns them back on.
  const summaryToggle = settingsDialog.getByRole('checkbox', { name: /^Scene summaries/ })
  await expect(summaryToggle).toBeEnabled()
  await summaryToggle.uncheck()
  await expect.poll(async () => (await aiSettings()).features.summary).toBe(false)
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
    'gpt-5.4-mini · $0.0001 · 400 in · 12 out'
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
  await sidebarTabs.getByRole('tab', { name: 'Tags' }).click()
  await categories.getByRole('tab', { name: 'All' }).click()
  await expect(tagRows.getByRole('button', { name: /^protagonist/ })).toHaveText(
    'protagonist 1 use'
  )
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
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
  await expect(voiceSection.getByTestId('voice-words')).toContainText('0 of 12 exemplars')
  await expect(voiceSection).toContainText('No exemplars marked yet.')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  const markExemplar = page.getByRole('button', { name: 'Mark voice exemplar' })
  await expect(markExemplar).toBeDisabled()
  await editor.click()
  await page.keyboard.press('Control+a')
  await expect(markExemplar).toBeEnabled()
  await markExemplar.click()
  await expect(page.getByRole('status')).toContainText('Added to your voice profile (1 of 12)')
  await page.keyboard.press('End')
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  const exemplarRows = voiceSection
    .getByRole('list', { name: 'Voice exemplars' })
    .getByRole('listitem')
  await expect(exemplarRows).toHaveCount(1)
  await expect(exemplarRows.first()).toContainText('Mixed · POV Mara')
  await expect(exemplarRows.first()).toContainText('The storm broke at dusk. Rain followed.')
  await expect(voiceSection.getByTestId('voice-words')).toContainText(
    /Built from [1-9]\d* words of manuscript and 1 of 12 exemplars/
  )

  // F-5.3: VibeWrite. Suggest unlocks ghost text; the idle delay drops to 0.5 s in the AI tab
  // and lands in the settings table. The toolbar toggle arms the mode (persisted per project).
  // Typing into Scene 1 and pausing brings the fake server's continuation as ghost text at the
  // caret (a widget, not document text); Tab accepts it into the document and the ledger gains
  // a ghostText request. A second suggestion is dismissed with Escape and inserts nothing.
  // The mode is turned off again before the dial and the key are restored below.
  await dial.getByRole('radio', { name: 'Suggest' }).click()
  await expect.poll(async () => (await aiSettings()).dial).toBe(2)
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
  await editor.click()
  await page.keyboard.press('Control+End')
  for (let i = 0; i < 5; i++) await page.keyboard.type(VOICE_PARAGRAPH)
  await expect
    .poll(async () => ((await documentText(scene1Row.id)) ?? '').split('pulled it open').length, {
      timeout: 3000
    })
    .toBe(6)
  // F-14.3: the scene brief. The metadata pane's Brief disclosure holds the five lines and,
  // for a document, "Draft with AI" asks main for them (the dial is at Suggest and the key is
  // set by now, and Scene 1 is well past the 200-character floor). The draft is a proposal:
  // Use draft fills the fields, which autosave like the rest of the metadata, so the
  // ghost-text request below carries the brief.
  const briefRequestsBefore = openAiRequests.length
  await metadata.getByRole('button', { name: 'Brief' }).click()
  await metadata.getByRole('button', { name: 'Draft with AI' }).click()
  const briefDraft = metadata.getByRole('group', { name: 'Brief draft' })
  await expect(briefDraft).toContainText(`Goal: ${BRIEF_GOAL}`)
  expect(openAiRequests).toHaveLength(briefRequestsBefore + 1)
  await briefDraft.getByRole('button', { name: 'Use draft' }).click()
  await expect(briefDraft).toHaveCount(0)
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
  await editor.click()
  await page.keyboard.press('Control+End')
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
  await editor.click()
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
  await editor.click()
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
  await editor.click()
  await page.keyboard.press('Control+End')
  for (let i = 0; i < 14; i += 1) await page.keyboard.type('\nThe typewriter line rolls on.')
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
  await editor.click()
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
  const screenSize = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
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
  const resized = { ...moved, width: moved.width - 40, height: moved.height + 30 }
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

  // F-5.4: the assistant panel. Ctrl+K opens it (the dial is still at Suggest with the key
  // saved). A Plan question streams its answer into the chat with the cost line, and the
  // request carries the scene's text; the tab takes the question as its title. Author mode
  // places a two-paragraph answer in the editor as ghost text with a notice in the chat; Tab
  // accepts it as AI-origin paragraphs. A second conversation is cleared after confirming.
  // F-5.8: a fresh conversation starts in Query mode, so the radios are Query, Author, Plan
  // and the Plan questions here pick Plan first.
  const chatRequestsBefore = openAiChatBodies.length
  // Toasts stack over the panel's composer (bottom right); dismiss what the steps above left.
  await dismissToasts()
  await page.keyboard.press('Control+k')
  const assistant = page.getByTestId('assistant-panel')
  await expect(assistant).toBeVisible()
  await expect(page.getByRole('button', { name: 'Assistant' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  const messageBox = assistant.getByRole('textbox', { name: 'Message' })
  const turns = assistant.locator('[data-testid="chat-turn"]')
  const modeRadios = assistant.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio')
  await expect(modeRadios).toHaveText(['Query', 'Author', 'Plan'])
  await expect(modeRadios.nth(0)).toHaveAttribute('aria-checked', 'true')
  await assistant.getByRole('radio', { name: 'Plan' }).click()
  await messageBox.fill('Why is Mara on the ridge?')
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(2)
  await expect(turns.nth(0)).toHaveAttribute('data-role', 'user')
  await expect(turns.nth(1)).toHaveAttribute('data-role', 'assistant')
  await expect(turns.nth(1)).toContainText(CHAT_ANSWER)
  await expect(turns.nth(1).getByTestId('chat-turn-cost')).toContainText('gpt-5.4-mini')
  // F-5.9: the cost line carries the tokens the turn spent, not the model and the cost alone.
  await expect(turns.nth(1).getByTestId('chat-turn-cost')).toContainText(' in · ')
  expect(openAiChatBodies).toHaveLength(chatRequestsBefore + 1)
  expect(openAiChatBodies.at(-1)?.messages.at(-1)?.content).toBe('Why is Mara on the ridge?')
  expect(openAiChatBodies.at(-1)?.messages[0]?.content).toContain('Mara waited on the ridge')
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
  await expect(page.getByTestId('ai-activity')).toContainText('Assistant chat')
  await assistant.getByTestId('assistant-stop').click()
  await expect(assistant.getByTestId('chat-pending')).toHaveCount(0)
  await expect(turns).toHaveCount(3)
  await expect(turns.nth(2)).toHaveAttribute('data-role', 'user')
  await expect(page.getByTestId('ai-activity')).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'stopped' })).toHaveCount(0)
  expect(openAiChatBodies).toHaveLength(chatRequestsBefore + 2)
  await expect(assistant.getByTestId('assistant-send')).toBeVisible()
  await assistant.getByRole('radio', { name: 'Author' }).click()
  await assistant.getByRole('combobox', { name: 'Paragraphs' }).selectOption('2')
  await messageBox.fill('Continue the scene.')
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(5)
  await expect(turns.nth(4)).toContainText('Placed in the editor. Tab accepts, Escape dismisses.')
  expect(openAiChatBodies.at(-1)?.messages.at(-1)?.content).toBe(
    'Write 2 paragraphs. Continue the scene.'
  )
  expect(openAiChatBodies.at(-1)?.messages[0]?.content).toContain("Match the author's voice:")
  expect(openAiChatBodies.at(-1)?.messages[0]?.content).toContain(STORY_BIBLE_HEADING)
  const agentGhost = editor.locator('.ghost-text')
  await expect(agentGhost).toContainText(AGENT_FIRST)
  await expect(agentGhost).toContainText(AGENT_SECOND)
  await page.keyboard.press('Tab')
  await expect(agentGhost).toHaveCount(0)
  await expect(editor).toContainText(AGENT_SECOND)
  await expect(editor.locator('.ai-origin[data-proposal-id]')).toHaveCount(2)
  await expect(page.getByTestId('status-ai')).toHaveText(/^[1-9]\d*% AI$/)
  // F-5.17: What should come next?. The quick action asks the fast tier once (the scene's tail,
  // its brief, and the story bible) and lands three directions in the conversation as chat;
  // Write this on the first sends it through Author mode, which places ghost text at the caret.
  const whatNextBodies = (): { role: string; content: string }[][] =>
    openAiChatBodies
      .filter((body) => body.messages[0]?.content.startsWith(WHAT_NEXT_SENTINEL))
      .map((body) => body.messages)
  const whatNextBefore = whatNextBodies().length
  const whatNextButton = assistant.getByTestId('quick-action-whatNext')
  await expect(whatNextButton).toBeEnabled()
  await expect(whatNextButton).toContainText('fast')
  await expect(assistant.getByTestId('quick-action-continuity')).toContainText('strong')
  await whatNextButton.click()
  const directions = assistant.getByTestId('what-next-direction')
  await expect(directions).toHaveCount(3)
  await expect(directions.first()).toContainText(WHAT_NEXT_TITLES[0] ?? '')
  await expect(turns).toHaveCount(7)
  await expect(turns.nth(5)).toContainText('What should come next?')
  expect(whatNextBodies()).toHaveLength(whatNextBefore + 1)
  expect(whatNextBodies().at(-1)?.[0]?.content).toContain(STORY_BIBLE_HEADING)
  await directions.first().getByTestId('what-next-write').click()
  await expect(turns).toHaveCount(9)
  await expect(turns.nth(8)).toContainText('Placed in the editor. Tab accepts, Escape dismisses.')
  expect(openAiChatBodies.at(-1)?.messages.at(-1)?.content).toBe(
    `Write 2 paragraphs. Continue the scene in this direction: ${WHAT_NEXT_TITLES[0]}. She doubts the crossing and heads back to the camp.`
  )
  await expect(agentGhost).toContainText(AGENT_FIRST)
  await page.keyboard.press('Escape')
  await expect(agentGhost).toHaveCount(0)
  await expect(editor.locator('.ai-origin[data-proposal-id]')).toHaveCount(2)
  const afterWhatNext = await usageSummary()
  expect(afterWhatNext.byFeature.find((f) => f.feature === 'whatNext')).toMatchObject({
    requests: 1
  })
  await assistant.getByRole('button', { name: 'New conversation', exact: true }).click()
  await expect(turns).toHaveCount(0)
  await expect(assistant.getByRole('radio', { name: 'Query' })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await assistant.getByRole('radio', { name: 'Plan' }).click()
  await messageBox.fill('A second question.')
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(2)
  await assistant.getByRole('button', { name: 'Clear conversation' }).click()
  await page
    .getByRole('dialog', { name: 'Clear conversation' })
    .getByRole('button', { name: 'Clear' })
    .click()
  await expect(turns).toHaveCount(0)
  await expect(assistant.getByRole('tab')).toHaveCount(2)

  // F-14.10: rewrite in my voice. With Scene 1's opening sentence selected (set on the DOM, as
  // the provenance step does, since the paragraph wraps), the toolbar button sends the passage
  // with the voice block in the system turn; the fake server streams the rewrite and the panel
  // shows it as a word diff against the selection. Accept replaces the passage as AI-origin
  // text through the editor (so it autosaves), and the ledger gains a rewrite request.
  await dismissToasts()
  const rewriteButton = page.getByRole('button', { name: 'Rewrite in my voice' })
  await expect(rewriteButton).toBeDisabled()
  const rewriteBodiesBefore = openAiChatBodies.length
  await editor.click()
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

  // F-14.8: editor's notes. The toolbar button asks main for a critique of Scene 1; the fake
  // server answers three notes, one of them citing a passage that was never written, and main
  // drops it, so only the two cited notes reach the panel (no uncited praise). Apply replaces
  // exactly the quoted passage with the fix through the editor, as AI-origin text that
  // autosaves, and the ledger gains a critique request. Close settles the proposal.
  const critiqueButton = page.getByRole('button', { name: "Editor's notes" })
  const critiqueBodiesBefore = openAiChatBodies.length
  await expect(critiqueButton).toBeEnabled()
  await critiqueButton.click()
  const critiquePanel = page.getByTestId('critique-panel')
  await expect(critiquePanel).toBeVisible()
  await expect(critiquePanel.getByTestId('critique-note')).toHaveCount(2)
  await expect(critiquePanel.getByTestId('critique-quote').first()).toHaveText(CRITIQUE_QUOTE)
  await expect(critiquePanel.getByTestId('critique-quote').nth(1)).toHaveText(CRITIQUE_PRAISE_QUOTE)
  await expect(critiquePanel).not.toContainText(CRITIQUE_FABRICATED_QUOTE)
  expect(openAiChatBodies).toHaveLength(critiqueBodiesBefore + 1)
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

  // F-14.12: proofread. A sentence with a misspelling and a doubled word is typed at the end of
  // Scene 1; with the caret collapsed the Proofread quick action in the assistant (F-5.17)
  // proofreads the whole scene. The fake
  // server answers three fixes, one quoting a passage that was never written, and main drops it,
  // so two cards show. Accept takes the first, Accept all the other, each replacing exactly its
  // quoted passage as AI-origin text from the one proposal (how it settles is a store test).
  await dismissToasts()
  await editor.click()
  await page.keyboard.press('Control+End')
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
  const proofreadButton = assistant.getByTestId('quick-action-proofread')
  await expect(proofreadButton).toBeEnabled()
  await proofreadButton.click()
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
  expect(openAiRequests).toHaveLength(summaryRequestsBefore + 1)
  const summarySystem = openAiChatBodies.at(-1)?.messages[0]
  expect(summarySystem?.role).toBe('system')
  expect(summarySystem?.content.startsWith(SUMMARY_SENTINEL)).toBe(true)
  // F-4.13: the same request tagged the scene. The new tone is in the tag bar with the "Added
  // by AI" mark, without a click; the character the scene never names was not created. One
  // click takes the tag off, and it stays in the bank.
  const aiChip = tagBar.locator('li[data-ai="true"]').filter({ hasText: 'stormbound' })
  await expect(aiChip).toBeVisible()
  await expect(aiChip.getByTestId('tag-ai-mark')).toHaveText('Added by AI')
  expect((await listTags()).some((tag) => tag.name === 'zephyr')).toBe(false)
  await aiChip.getByRole('button', { name: 'Remove stormbound' }).click()
  await expect(aiChip).toHaveCount(0)
  await editor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' She counted the boats twice.')
  await expect(metadata.getByTestId('summary-status')).toHaveText('Updating…')
  await expect
    .poll(() => openAiRequests.length, { timeout: 15_000 })
    .toBe(summaryRequestsBefore + 2)
  await expect(metadata.getByTestId('summary-status')).toHaveText('')
  await expect(metadata.getByTestId('summary-text')).toHaveText(SUMMARY_TEXT)
  // F-4.13: the background run answered the same tag again; a tag the author took off this
  // scene is never re-applied to it, and nothing of it is in the manuscript.
  await expect(tagBar.getByRole('listitem').filter({ hasText: 'stormbound' })).toHaveCount(0)
  expect((await listTags()).find((tag) => tag.name === 'stormbound')).toMatchObject({
    usageCount: 0
  })
  await expect(editor).not.toContainText('stormbound')
  const afterSummary = await usageSummary()
  expect(afterSummary.byFeature.find((f) => f.feature === 'summary')).toMatchObject({
    requests: 2
  })

  // F-5.16: the automatic story bible. The summary answer carried two observed facts, and no
  // entity was left in the project, so main created both characters as AI-made blank pages with
  // their tags. Kael is listed in the Characters tab marked "Added by AI"; his page shows the
  // fact under "From the manuscript", and its passage button opens Scene 1 with the quoted
  // sentence selected (nothing is typed, so the scene reads as it did). Back on his page, Add to
  // sheet copies the fact onto the blank page (an author edit, so the AI mark goes and the row
  // says On sheet), and Hide puts the row away. No request is made by any of it.
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
  await sidebarTabs.getByRole('tab', { name: 'Characters' }).click()
  const kaelRow = characterRows.getByRole('button', { name: /^Kael/ })
  await expect(kaelRow).toContainText('Added by AI')
  await kaelRow.click()
  await expect(entityEditor).toBeVisible()
  await expect(entityEditor).toContainText('Character · Blank page · Added by AI')
  const observedFacts = entityEditor.getByRole('region', { name: 'From the manuscript' })
  const watchfulRow = observedFacts.getByRole('listitem', { name: 'Personality: Watchful' })
  await expect(watchfulRow).toBeVisible()
  await expect(watchfulRow).not.toContainText('Differs')
  await watchfulRow.getByRole('button', { name: 'Go to passage in Scene 1' }).click()
  await expect(entityEditor).toHaveCount(0)
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''), { timeout: 5_000 })
    .toBe(SUMMARY_FACTS[1]?.quote)
  await kaelRow.click()
  await expect(entityEditor).toBeVisible()
  await watchfulRow.getByRole('button', { name: 'Add to sheet' }).click()
  await expect(watchfulRow).toContainText('On sheet')
  await expect(watchfulRow.getByRole('button', { name: 'Add to sheet' })).toHaveCount(0)
  await expect(entityEditor.getByRole('textbox', { name: 'Page' })).toHaveValue(
    'Personality: Watchful'
  )
  await expect(entityEditor).not.toContainText('Added by AI')
  await expect(kaelRow).not.toContainText('Added by AI')
  await expect
    .poll(async () => (await listEntities()).find((entity) => entity.id === kaelEntity.id))
    .toMatchObject({ origin: 'author', body: 'Personality: Watchful' })
  await watchfulRow.getByRole('button', { name: 'Hide', exact: true }).click()
  await expect(watchfulRow).toHaveCount(0)
  await expect(observedFacts.getByRole('button', { name: 'Show hidden (1)' })).toBeVisible()
  await expect
    .poll(async () => (await observedFactsOf(kaelEntity.id)).map((fact) => fact.hidden))
    .toEqual([true])
  expect(openAiRequests).toHaveLength(factRequestsBefore)
  // Back to Scene 1 for the steps below; the entity page replaced the scene's panes, so the
  // Summary disclosure is closed again and is reopened here.
  await entityEditor.getByRole('button', { name: 'Close Kael' }).click()
  await expect(entityEditor).toHaveCount(0)
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
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
  await editor.click()
  await page.keyboard.press('Control+End')
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
  // F-5.16: that run read Scene 1 again and its answer carried the same two facts. The one hidden
  // on Kael's page is a tombstone, so it was not logged a second time; Mara's was replaced as
  // usual, and no third character appeared.
  await expect
    .poll(async () => (await observedFactsOf(kaelEntity.id)).map((fact) => fact.hidden))
    .toEqual([true])
  expect(
    (await listEntities())
      .filter((entity) => entity.kind === 'character')
      .map((entity) => entity.name)
  ).toEqual(['Kael', 'Mara'])
  await sidebarTabs.getByRole('tab', { name: 'Characters' }).click()
  await kaelRow.click()
  await expect(observedFacts.getByRole('button', { name: 'Show hidden (1)' })).toBeVisible()
  await expect(observedFacts.getByRole('list', { name: 'Observed facts' })).toHaveCount(0)
  await entityEditor.getByRole('button', { name: 'Close Kael' }).click()
  await expect(entityEditor).toHaveCount(0)
  await sidebarTabs.getByRole('tab', { name: 'Manuscript' }).click()
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
  const betaReaderButton = page.getByRole('button', { name: 'Beta reader' })
  const betaReaderBodiesBefore = openAiChatBodies.length
  await expect(betaReaderButton).toBeEnabled()
  await betaReaderButton.click()
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

  // F-5.7: Story Intelligence. The assistant's third mode asks about the whole manuscript: main
  // ranks the scenes on the question's words (Scene 1 carries both "storm" and "ridge", so it
  // goes out in full as [1]), and the answer's citations are checked against the text that was
  // sent. The fabricated quote and the one naming a scene that was never sent are dropped, and
  // the `[3]` marker they left behind is stripped. Clicking the surviving citation opens the
  // scene and selects the passage in the editor.
  await dismissToasts()
  const queryBodiesBefore = openAiChatBodies.length
  await expect(assistant).toBeVisible()
  const queryRadio = assistant.getByRole('radio', { name: 'Query' })
  await expect(queryRadio).toBeEnabled()
  await queryRadio.click()
  await expect(queryRadio).toHaveAttribute('aria-checked', 'true')
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
  expect(openAiChatBodies).toHaveLength(queryBodiesBefore + 1)
  const querySystem = openAiChatBodies.at(-1)?.messages[0]
  expect(querySystem?.role).toBe('system')
  expect(querySystem?.content.startsWith(QUERY_SENTINEL)).toBe(true)
  expect(querySystem?.content).toContain(CRITIQUE_PRAISE_QUOTE)
  expect(openAiChatBodies.at(-1)?.messages.at(-1)?.content).toBe(QUERY_QUESTION)
  const afterQuery = await usageSummary()
  expect(afterQuery.byFeature.find((f) => f.feature === 'query')).toMatchObject({ requests: 1 })
  // The citation opens its scene and selects the cited passage there.
  await citation.click()
  await expect(page.getByTestId('selected-title')).toHaveText('Scene 1')
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''), { timeout: 5_000 })
    .toBe(CRITIQUE_PRAISE_QUOTE)
  // F-5.17: What happened here?. With the cited passage still selected, the quick action asks
  // Query for a recap of that passage, with the open scene pinned first so it goes out as [1];
  // the canned answer's citation of Scene 1 survives.
  const recapBodiesBefore = openAiChatBodies.length
  await assistant.getByTestId('quick-action-recap').click()
  await expect(turns).toHaveCount(4)
  await expect(turns.nth(2)).toContainText('What happens in this passage?')
  await expect(turns.nth(3)).toContainText(QUERY_ANSWER_KEPT)
  await expect(turns.nth(3).getByTestId('query-citation')).toContainText('Chapter 1 › Scene 1')
  expect(openAiChatBodies).toHaveLength(recapBodiesBefore + 1)
  expect(openAiChatBodies.at(-1)?.messages.at(-1)?.content).toBe(
    `What happens in this passage? Give a short recap, citing it: "${CRITIQUE_PRAISE_QUOTE}"`
  )
  expect(openAiChatBodies.at(-1)?.messages[0]?.content).toMatch(/\[1\] Chapter 1 › Scene 1/)

  // F-15.4: MythScribe Cloud. Signing in again (the account step signed out), the AI tab's
  // source picker points this project at the proxy; the next assistant question streams through
  // the fake Cloud Worker instead of the fake OpenAI, carrying the session bearer and the
  // feature it is charged to, and its cost line shows the Cloud rate — twice the provider's.
  // The project goes back to the author's own key, signed out, for the steps below.
  await dismissToasts()
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'Account' }).click()
  await settingsDialog.getByLabel('Email').fill('author@example.com')
  await settingsDialog.getByRole('button', { name: 'Send sign-in link' }).click()
  approveSignIn()
  await expect(settingsDialog.getByTestId('account-signed-in')).toHaveText(
    'Signed in as author@example.com',
    { timeout: 15_000 }
  )
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await settingsDialog.getByTestId('ai-source-cloud').click()
  await expect.poll(async () => (await aiSettings()).source).toBe('cloud')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)
  const cloudBodiesBefore = openAiChatBodies.length
  await assistant.getByRole('radio', { name: 'Plan' }).click()
  await messageBox.fill(CLOUD_QUESTION)
  await messageBox.press('Enter')
  await expect(turns).toHaveCount(6)
  await expect(turns.nth(5)).toContainText(CLOUD_AI_ANSWER)
  const cloudCost = cloudPriceFor(
    'gpt-5.4-mini',
    CLOUD_AI_USAGE.inputTokens,
    CLOUD_AI_USAGE.outputTokens
  )
  const ownKeyCost = priceFor(
    'gpt-5.4-mini',
    CLOUD_AI_USAGE.inputTokens,
    CLOUD_AI_USAGE.outputTokens
  )
  expect(cloudCost.costUsd).toBeCloseTo(ownKeyCost.costUsd * 2, 8)
  await expect(turns.nth(5).getByTestId('chat-turn-cost')).toHaveText(
    `gpt-5.4-mini · $${cloudCost.costUsd.toFixed(4)} · 10,000 in · 2,000 out`
  )
  expect(openAiChatBodies).toHaveLength(cloudBodiesBefore)
  expect(cloudAiRequests.filter((request) => request.feature === 'chat')).toEqual([
    { feature: 'chat', model: 'gpt-5.4-mini', stream: true, auth: `Bearer ${CLOUD_SESSION_TOKEN}` }
  ])
  // F-15.5: the balance in the stream's `done` reached the renderer by itself — no Settings
  // visit, no Refresh — and the charge took it under $1.00, so the status bar offers the way to
  // the Account tab, where the meter shows the same figure.
  const creditNotice = page.getByTestId('credit-notice')
  await expect(creditNotice).toHaveText(`Cloud credits low: ${balanceText(cloudBalanceMicros)}`)
  await creditNotice.click()
  await expect(settingsDialog).toBeVisible()
  await expect(settingsDialog.getByRole('tab', { name: 'Account' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(settingsDialog.getByTestId('account-credit-balance')).toHaveText(
    balanceText(cloudBalanceMicros)
  )
  await expect(settingsDialog.getByTestId('account-period-spent')).toHaveText(
    balanceText(CLOUD_PERIOD_SPEND.micros)
  )
  await expect(settingsDialog.getByTestId('account-run-out')).toContainText('left at this pace')
  await expect(settingsDialog.getByTestId('account-credit-warning')).toHaveText(
    `Cloud credits low: ${balanceText(cloudBalanceMicros)}`
  )
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await settingsDialog.getByTestId('ai-source-ownKey').click()
  await expect.poll(async () => (await aiSettings()).source).toBe('ownKey')
  await settingsDialog.getByRole('tab', { name: 'Account' }).click()
  await settingsDialog.getByRole('button', { name: 'Sign out' }).click()
  await expect(settingsDialog.getByLabel('Email')).toBeVisible()
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  // Back to Off and no key, as the steps above left them.
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await dial.getByRole('radio', { name: 'Off' }).click()
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
  // F-12.3 needs the dial at Suggest and a key, which the steps above turned off.
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await dial.getByRole('radio', { name: 'Suggest' }).click()
  await expect.poll(async () => (await aiSettings()).dial).toBe(2)
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
  const importRows = importDialog.getByTestId('import-node')
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
  expect(importedPart?.position).toBe(
    treeBefore.filter((n) => n.parentId === manuscriptRoot?.id).length
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
  await editor.click()
  await page.keyboard.press('Control+End')
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
  // F-5.17: the Check consistency quick action runs the check and opens the findings view.
  await assistant.getByTestId('quick-action-continuity').click()
  const continuityPanel = assistant.getByTestId('continuity-panel')
  await expect(continuityPanel).toBeVisible()
  const findingCards = continuityPanel.getByTestId('continuity-finding')
  await expect(findingCards).toHaveCount(2, { timeout: 15_000 })
  expect(continuityBodies()).toHaveLength(continuityRequestsBefore + 1)
  await expect(continuityPanel.getByTestId('continuity-result')).toContainText(
    '2 contradictions found'
  )
  await expect(assistant.getByTestId('continuity-count')).toHaveText('2')
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
  await assistant.getByTestId('quick-action-continuity').click()
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
  // Back to Off and no key, as before this step.
  await page.getByRole('button', { name: 'Settings' }).click()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await dial.getByRole('radio', { name: 'Off' }).click()
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

  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await closed
  expect(exited).toBe(true)
})

/** The single-document editor's text with the ghost-text widget (F-5.3) left out. */
/**
 * Dismisses every toast on screen, first one first: clicking one removes it and moves the rest
 * up, so a snapshot of the list goes stale after the first click.
 */
async function dismissToasts(): Promise<void> {
  const buttons = page.getByRole('button', { name: 'Dismiss notification' })
  for (let left = await buttons.count(); left > 0; left -= 1) {
    await buttons.first().click()
  }
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

/** Every observed fact of one entity (F-5.16), the hidden ones included, as main lists them. */
async function observedFactsOf(entityId: string): Promise<ObservedFact[]> {
  const result = await page.evaluate<IpcResult<ObservedFact[]>, string>(
    (id) =>
      window.mythscribe.invoke('observedFact:listForEntity', { entityId: id }) as Promise<
        IpcResult<ObservedFact[]>
      >,
    entityId
  )
  if (!result.ok) throw new Error(`observedFact:listForEntity failed: ${result.error.message}`)
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

async function getLayout(): Promise<Layout> {
  const result = await page.evaluate<IpcResult<Layout>>(
    () => window.mythscribe.invoke('layout:get', undefined) as Promise<IpcResult<Layout>>
  )
  if (!result.ok) throw new Error(`layout:get failed: ${result.error.message}`)
  return result.data
}

async function listTree(): Promise<TreeNode[]> {
  const result = await page.evaluate<IpcResult<TreeNode[]>>(
    () => window.mythscribe.invoke('tree:list', undefined) as Promise<IpcResult<TreeNode[]>>
  )
  if (!result.ok) throw new Error(`tree:list failed: ${result.error.message}`)
  return result.data
}
