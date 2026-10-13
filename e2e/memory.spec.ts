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
import type { AiSettings } from '../src/shared/aiSettings'
import type { IpcResult, ProjectInfo, TreeNode } from '../src/shared/ipc/contract'
import type { ResearchDoc } from '../src/shared/research'
import type { TiptapNodeT } from '../src/shared/tiptap'
import { caretToEnd, clickIntoEditor } from './support'

/**
 * Story memory v2 (FEATURES.md §2.16; plan P1). The app is launched with
 * `MYTHSCRIBE_STORY_MEMORY=v2` (honoured only in unpackaged builds). Slices 2 to 4 run with Use AI
 * off, and slice 5 checks that nothing reached a model before it: `OPENAI_BASE_URL` points at a
 * fake provider on loopback that records every request, and the Cloud URL at a closed local port.
 * The smoke test (`smoke.spec.ts`) keeps covering v1 and is not edited for P1.
 *
 * P1 slice 2 (F-16.8, the Not canon parts of F-16.6): the Research section is in the picker and
 * not in the Manuscript tree; a Markdown upload opens as an editable page; a paragraph is marked
 * Not canon; the page is switched Not canon; word search finds it as a source document; the
 * compiled preview leaves it out.
 *
 * P1 slice 3 (F-16.6, F-16.7, F-16.11, the v2 shell): the picker lists v2's sections only; a
 * record is made with a nickname, and creating that nickname warns through the twin gate; Pinned
 * and Ideas lines are saved; *Same as* merges a second record and *Split* brings it back; a
 * surname is shared by two records; a tone label is made, put on a scene and filtered by; Mara is
 * the scene's POV; a click in her *Named in* selects her name in the scene; `#` opens no
 * suggestion; a file dropped on the window becomes a Research page.
 *
 * P1 slice 4 (F-16.12, F-16.10, F-16.13, F-16.4): This scene, Needs a look, Dismissed, Rename in
 * book.
 *
 * P1 slice 5 (F-16.14, F-16.9, F-16.7), Use AI on with an own OpenAI key at the fake: ghost text
 * sends the Story notes block (and the panel's *What the AI is told* shows the same block); a
 * Research upload is filed into Pinned through the estimate and the deck, the line carries its
 * "Filed from" mark, and editing the source sentence raises a Needs a look conflict.
 *
 * P2a (F-16.16, F-16.17), still with the own key at the fake: a paragraph typed in Scene 1 sends
 * nothing; *Read now* sends one reader request (the whole scene, its first read) and one check;
 * the scene's memory holds Mara's eyes proved in code and where she walked proved by the checker
 * (the pronoun), with ⓘ's reading; a second *Read now* sends nothing. P2a slice 3 (F-16.16,
 * F-16.19): an edit to the eyes goes stale once the save settles and typing sends nothing; opening
 * the second scene reads Scene 1 back (one reader request, the eyes brown again); a Replace in
 * project over 6 scenes nobody read raises the backlog notice with a price and sends nothing;
 * `memory:rebuildEstimate` prices a rebuild; no request ever carried `summary.v5`'s opening.
 *
 * P2a slice 4 (F-16.18, F-16.16, F-16.19), the UI over the same project: the panel shows Mara Here
 * and True now's "Last seen at the quay, last stated in 1.1"; *Read now* after an edit sends one
 * reader request and then says nothing is new; Mara's sheet shows "Eyes: brown" under From the
 * book with ⓘ ("quote checked in code"); *Not right › Wrong value* sends it to Dismissed and its
 * *Undo* brings it back; a typed place shows dimmed beside the card's place in scene details and
 * Needs a look asks once (*Keep mine* clears it); Settings › AI shows the reading switch and the
 * idle minutes; *Rebuild memory* goes from its price to the summary grouped by sheet; an edit to
 * the quay sentence dims its True now line ("re-checking after you pause") with no reading.
 *
 * P2a slice 5 (F-16.20, F-16.21), the same project: the Outline shows Scene 1's card line in grey
 * where a synopsis would be; a planned scene ("Mara at the quay") and a drafted one whose card
 * matches it as closely as Scene 1's does: the drafted scene's reading asks `planLinks.v2` once,
 * the link is applied with the AI mark and the fake's reason, and *Unlink* sends the pair to
 * Dismissed and leaves *Not yet drafted*; a synopsis suggestion sends `synopsis.v2` with the card
 * and no stored summary; the beta reader sends the earlier scenes as card gists under its map
 * heading.
 *
 * P2b slice 2 (F-16.22, F-16.23), invoke level: `reader.v2` and `verify.v2` read who knows what
 * and threads. Scene "Bram sold the map. Orrin overheard Bram. Mara swore to find the heir." makes
 * a secret and a thread silently (AI-made, never names), with Bram knowing it before and Orrin
 * overhearing it from Bram; a second scene's planted duplicate ("The map had been sold by Bram.")
 * is judged the same by the checker's same-as item and merged, and the thread resolves; the
 * reader request lists both topics after the record roster, and no request carries an absence.
 *
 * P2b slice 4 (F-16.22), the UI in a new project (so the scenes are 1.1–1.3): scene 1.1 ("Mara
 * watched from the stair. Tomas sold the map. Orrin overheard Tomas.", Mara the POV) shows the
 * sold map with "readers since 1.1", Orrin overheard from Tomas, Tomas knew before and, muted, "No
 * scene shows Mara learning this (checked up to 1.1)"; scene 1.2 shows the POV's tension line and
 * "+ 1 more in Book" opens the Book's grid, where Mara's empty cell takes *Knew before the book*
 * and the tension line goes; the secret's sheet lists the reveal merged from 1.3, *Split* makes it
 * a secret of its own (Secrets lists two, Dismissed one more), *Not a secret* takes it away and
 * its *Undo* brings it back; a ghost-text request from 1.2 carries a Story notes block with no
 * absence and no who-knows-what line.
 *
 * P2b slice 5 (F-16.23), the UI in a new project: scene 1.1 (typed 1811) "Mara was born in 1792.
 * Mara swore to find the heir.", 1.2 "Mara was nineteen.", 1.3 "Three winters later, Mara found
 * the heir."; Book › Threads shows "the missing heir · resolved in 1.3" with its two steps; the
 * Timeline reads 1811, "1811 · from 1.1" and "year not known since “Three winters later” (1.3)"
 * with Mara about 19 in 1.1 and 1.2; her sheet's Age as of 1.2 is "about 19 · year from 1.1", as
 * of 1.3 "19, stated in 1.2 · since then: “Three winters later” (1.3)" (the reader's own value
 * for the hint is "some time": only the book's words show); typing 1814 as 1.3's story year makes
 * its row 1814 with Mara about 22; moving 1.3 before 1.2 with the Timeline open reorders its rows
 * and carries 1814 into the moved-down scene.
 *
 * P1 slice 6 (F-16.15), a second launch without the override: a v1 project with a character tag
 * typed inline goes through Help › Try the story-memory switch-over on a copy…; the dry run lists
 * the tag as a record; the consent screen's replacement is edited to "Mara"; the copy reopens on
 * v2 with plain "Mara" and a Mara record; the original reopens as v1 with its inline tag.
 */

let app: ElectronApplication
let page: Page
let tmp: string
let exited = false

/** The key the fake provider is given (any well-formed key; the fake does not check it). */
const OWN_KEY = 'sk-live-memory-5678'
/** F-16.9: the opening of `contextImport.v3`'s rules; the fake files the bestiary for it. */
const FILING_SENTINEL =
  "You are the filing feature inside a novel-writing app, filing the author's research document " +
  "into the pinned notes of their story's records."
/** F-16.14: the Story notes block's first line (`STORY_NOTES_HEADING`). */
const STORY_NOTES_HEADING = 'Story notes (the manuscript wins'
/** What the fake answers a plain completion (ghost text) with. */
const GHOST_ANSWER = 'The lamps along the quay were already lit.'
/** The Research page slice 5 files: its last paragraph is the one the filed line quotes. */
const BESTIARY =
  '# Bestiary\n\nThe fen-wight is a pale thing that hunts the marsh at dusk.\n\n' +
  'Mara Vell keeps a fen-wight skull above her door.\n'
const FILED_LINE = 'Keeps a fen-wight skull above her door'
/** The fake's filing answer: a line for Mara (an addition) and a new record, each quoted. */
const FILING_ANSWER = JSON.stringify({
  records: [
    {
      name: 'Mara Vell',
      category: 'character',
      aliases: [],
      lines: [{ text: FILED_LINE, q: 'keeps a fen-wight skull above her door' }]
    },
    {
      name: 'Fen-wight',
      category: 'creature',
      aliases: [],
      lines: [{ text: 'Hunts the marsh at dusk', q: 'a pale thing that hunts the marsh at dusk' }]
    }
  ],
  categories: [],
  images: []
})

/** F-16.17: the openings of `reader.v1` and `verify.v1`, which the fake answers. */
const READER_SENTINEL = 'You are the story-memory reader inside a novel-writing app.'
/** F-5.6: `summary.v5`'s opening (version 1's, byte for byte); never sent in v2 (P2a slice 3). */
const SUMMARY_SENTINEL = 'You are the scene-summary feature inside a novel-writing app.'
const VERIFY_SENTINEL = 'You are the fact checker inside a novel-writing app.'
/** F-16.20: `synopsis.v2`'s opening (`SYNOPSIS_V2_SENTINEL`), which tells it from `synopsis.v1`. */
const SYNOPSIS_V2_SENTINEL =
  'You are the synopsis feature inside a novel-writing app. Read the scene below, with the card'
/** F-16.20: the heading `betaReader.v2` puts over the earlier scenes' gists. */
const BETA_READER_MAP_HEADING = 'A map of the earlier scenes (not quotable'
/** The beta reader's opening (both versions). */
const BETA_READER_OPENING = 'You are the beta-reader feature inside a novel-writing app.'
/** F-16.21: `planLinks.v2`'s opening; the fake picks the first of the two scenes. */
const PLAN_LINKS_V2_SENTINEL =
  'You are the plan-link feature inside a novel-writing app, choosing which drafted scene'
/** What the fake's plan-link pick says (F-16.21); the Outline shows it beside the AI mark. */
const PLAN_LINK_WHY = 'She waits at the quay there.'
/** P2b slice 5: the stated ages the fake reader reads, in words. */
const AGE_WORDS: Readonly<Record<string, number>> = { eighteen: 18, nineteen: 19, twenty: 20 }
/** P2b slice 5: the elapsed hint a paragraph may open with (it crosses a year). */
const ELAPSED_HINT = 'Three winters later'
/**
 * The fake reader's own value for that hint: vague, and not in the quote. The Timeline and the
 * Age show the quote's words and end the year carry on them (review of P2b slice 5).
 */
const ELAPSED_VALUE = 'some time'
/** The paragraph slice P2a types; the fake reads Mara's eyes and where she walked from it. */
const READ_PARAGRAPH = "Mara's eyes were grey. She walked to the quay."

/** F-16.25: `agent.v9`'s opening (`AGENT_V9_SENTINEL`); the fake answers Ms Scribe for it. */
const SCRIBE_SENTINEL =
  "You are the story assistant inside a novel-writing app, answering the book's author from the evidence below."
/** F-16.25: the opening of `agent.v9`'s edit list, sent on write runs (Ask, Auto) only. */
const SCRIBE_EDITS_OPENING = 'Edits: only when the message asks for a change'
/** F-5.19: `route.v2`'s opening; the fake answers it `{}`, which routes to chat. */
const ROUTE_V2_SENTINEL = "You are the router inside a novel-writing app's assistant."

/**
 * The fake Ms Scribe (F-16.25, F-16.26), answering from the question at the end of the last user
 * turn: a question naming Orrin cites E0 ("Orrin overheard Tomas"); "Add to <Name>'s sheet that
 * she <words>." pins "<Words>" on that sheet; "Save this for <Name>: <words>." asks idea or canon
 * (place `ask`); anything else is a plain found answer.
 */
function scribeAnswer(messages: { content: string }[]): string {
  const last = messages.at(-1)?.content ?? ''
  const question = last.slice(last.lastIndexOf('Question: ') + 'Question: '.length).trim()
  const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)
  const pin = /^Add to (\w+)['’]s sheet that she (.+)\.$/u.exec(question)
  if (pin !== null) {
    return JSON.stringify({
      answer: `I put that on ${pin[1] ?? ''}'s sheet.`,
      found: true,
      edits: [{ edit: 'pin', name: pin[1], text: capital(pin[2] ?? ''), place: 'pinned' }]
    })
  }
  const save = /^Save this for (\w+): (.+)\.$/u.exec(question)
  if (save !== null) {
    return JSON.stringify({
      answer: 'Is this an idea or canon?',
      found: true,
      edits: [{ edit: 'pin', name: save[1], text: capital(save[2] ?? ''), place: 'ask' }]
    })
  }
  if (/\bOrrin\b/u.test(question)) {
    return JSON.stringify({
      answer: 'Orrin overheard Tomas. [E0 "Orrin overheard Tomas"]',
      found: true,
      edits: []
    })
  }
  return JSON.stringify({ answer: 'The book does not say yet.', found: true, edits: [] })
}

/**
 * The fake reader (F-16.17): in the numbered paragraphs it finds `Mara's eyes were <colour>.` and
 * `She walked to <place>.`, and answers those two facts about Mara Vell (by her roster id) with
 * their paragraph numbers, and, when the card is due, a card whose place is the quay with Mara on
 * the page. Its line is "Mara walks to the quay." unless a paragraph has Mara waiting somewhere.
 *
 * P2b (F-16.22, F-16.23, `reader.v2`): it reads the topics roster from the system message, and in
 * a paragraph `<A> sold the <thing>.` proposes a new secret "the sold <thing>" (or uses its listed
 * id) with A knowing it before; `<B> overheard <A>.` has B overhear the latest secret from A;
 * `<A> swore to find the heir.` opens a new thread "the missing heir"; `<A> found the heir.`
 * resolves the listed one; `The <thing> had been sold by <A>.` proposes a new secret "the <thing>
 * sale" (a planted duplicate of the sold one). Every roster character such a paragraph names is on
 * the card's page.
 *
 * P2b slice 5 (F-16.23): `<A> was born in <year>.` is A's `born` line, `<A> was <number word>.`
 * A's stated `age` (in digits), and a paragraph opening "Three winters later" gives the card that
 * elapsed hint.
 */
function readerAnswer(messages: { content: string }[]): string {
  const system = messages[0]?.content ?? ''
  const user = messages.at(-1)?.content ?? ''
  const mara = /^(r\d+) Mara Vell /m.exec(system)?.[1] ?? null
  const claims: Record<string, unknown>[] = []
  const topics: Record<string, unknown>[] = []
  const present: [string, number, string][] = []
  let place: [string, number, string] | null = null
  let elapsed: [string, number, string] | null = null
  // P2b: the roster's names (every name and nickname, to its id) and the listed topics.
  const people = new Map<string, string>()
  for (const match of system.matchAll(/^(r\d+) (.+?)(?: \((.*)\))? · character$/gm)) {
    const id = match[1] ?? ''
    for (const name of [match[2] ?? '', ...(match[3] ?? '').split('; ')]) {
      if (name !== '') people.set(name, id)
    }
  }
  const listed = new Map<string, string>()
  for (const match of system.matchAll(/^([st]\d+) (.+) · (?:secret|thread)$/gm)) {
    listed.set(match[2] ?? '', match[1] ?? '')
  }
  let latestSecret = [...listed].filter(([, id]) => id.startsWith('s')).at(-1)?.[1] ?? null
  for (const line of user.split('\n')) {
    const paragraph = /^¶(\d+) (.*)$/.exec(line)
    if (paragraph === null) continue
    const p = Number(paragraph[1])
    const text = paragraph[2] ?? ''
    const fact = (extra: Record<string, unknown>): void => {
      claims.push({ p, voice: 'narration', sp: null, mode: 'now', chg: false, ...extra })
    }
    let p2b = false
    const sold = /(\w+) sold the (\w+)\./.exec(text)
    if (sold !== null) {
      p2b = true
      const label = `the sold ${sold[2] ?? ''}`
      const q = `${sold[1] ?? ''} sold the ${sold[2] ?? ''}`
      const id = listed.get(label) ?? 'x1'
      if (!listed.has(label)) topics.push({ n: label, kind: 'secret', id, p, q })
      latestSecret = id
      fact({ r: people.get(sold[1] ?? ''), s: 'knows', o: id, how: 'knewBefore', q })
    }
    const overheard = /(\w+) overheard (\w+)\./.exec(text)
    if (overheard !== null && latestSecret !== null) {
      p2b = true
      fact({
        r: people.get(overheard[1] ?? ''),
        s: 'knows',
        o: latestSecret,
        how: 'overheard',
        fr: people.get(overheard[2] ?? ''),
        q: `${overheard[1] ?? ''} overheard ${overheard[2] ?? ''}`
      })
    }
    const swore = /(\w+) swore to find the heir\./.exec(text)
    if (swore !== null) {
      p2b = true
      const q = `${swore[1] ?? ''} swore to find the heir`
      const id = listed.get('the missing heir') ?? 'x2'
      if (!listed.has('the missing heir')) {
        topics.push({ n: 'the missing heir', kind: 'thread', id, p, q })
      }
      fact({ r: id, s: 'thread', how: 'opens', v: 'swears to find the heir', q })
    }
    const found = /(\w+) found the heir\./.exec(text)
    const thread = listed.get('the missing heir')
    if (found !== null && thread !== undefined) {
      p2b = true
      const q = `${found[1] ?? ''} found the heir`
      fact({ r: thread, s: 'thread', how: 'resolves', v: 'finds the heir', q })
    }
    // P2b slice 5: a birth year, a stated age, an elapsed hint the card quotes.
    const born = /(\w+) was born in (\d{3,4})\./.exec(text)
    if (born !== null && people.has(born[1] ?? '')) {
      p2b = true
      fact({
        r: people.get(born[1] ?? ''),
        s: 'born',
        v: born[2],
        o: null,
        q: `${born[1] ?? ''} was born in ${born[2] ?? ''}`
      })
    }
    const stated = /(\w+) was (\w+)\./.exec(text)
    const years = AGE_WORDS[stated?.[2] ?? '']
    if (stated !== null && years !== undefined && people.has(stated[1] ?? '')) {
      p2b = true
      fact({
        r: people.get(stated[1] ?? ''),
        s: 'age',
        v: String(years),
        o: null,
        q: `${stated[1] ?? ''} was ${stated[2] ?? ''}`
      })
    }
    if (text.startsWith(ELAPSED_HINT)) elapsed = [ELAPSED_VALUE, p, ELAPSED_HINT]
    const sale = /The (\w+) had been sold by (\w+)\./.exec(text)
    if (sale !== null) {
      p2b = true
      const q = `The ${sale[1] ?? ''} had been sold by ${sale[2] ?? ''}`
      topics.push({ n: `the ${sale[1] ?? ''} sale`, kind: 'secret', id: 'x3', p, q })
    }
    if (p2b) {
      for (const sentence of text.split(/(?<=\.) /)) {
        for (const [name, id] of people) {
          if (
            new RegExp(`\\b${name}\\b`).test(sentence) &&
            !present.some((each) => each[0] === id)
          ) {
            present.push([id, p, sentence.replace(/\.$/, '')])
          }
        }
      }
    }
    // The editor types a curly apostrophe; a quote with a straight one still matches.
    const eyes = /Mara[’']s eyes were (\w+)\./.exec(text)
    if (eyes !== null) {
      claims.push({
        p,
        r: mara,
        s: 'eyes',
        v: eyes[1],
        q: `Mara's eyes were ${eyes[1]}`,
        voice: 'narration',
        sp: null,
        mode: 'now',
        o: null,
        chg: false
      })
    }
    const walked = /She walked to (the \w+)\./.exec(text)
    if (walked !== null) {
      const q = `She walked to ${walked[1]}`
      claims.push({
        p,
        r: mara,
        s: 'location',
        v: walked[1],
        q,
        voice: 'narration',
        sp: null,
        mode: 'now',
        o: null,
        chg: false
      })
      place = [walked[1] ?? '', p, q]
    }
  }
  const eyesItem = claims.find((claim) => claim.s === 'eyes')
  // P2a slice 5: a scene where Mara waits somewhere gets its own line, so a plan can match it.
  const waited = /Mara waited at (the \w+)/.exec(user)
  const line = waited === null ? 'Mara walks to the quay.' : `Mara waits at ${waited[1]}.`
  const card = user.endsWith('Card: yes')
    ? {
        card: {
          line,
          gist: line,
          where: place,
          when: null,
          year: null,
          elapsed,
          pov: null,
          flash: null,
          present:
            present.length > 0
              ? present
              : eyesItem === undefined
                ? []
                : [[mara, eyesItem.p, eyesItem.q]],
          mood: 'quiet',
          theme: 'waiting'
        }
      }
    : {}
  return JSON.stringify({ c: claims, n: topics, same: [], drop: [], ...card })
}

/**
 * The fake checker: every item supported, about its first candidate, as narration now. P2b
 * (`verify.v2`): a knows item echoes the how and the source its Fact line gives, a thread item its
 * step; a same-as item is the same only when both labels share a word (the planted duplicate,
 * "the map sale", shares "map" with "the sold map").
 */
function verifyAnswer(messages: { content: string }[]): string {
  const user = (messages.at(-1)?.content ?? '').replace(/^Items:\n/, '')
  const words = (label: string): string[] =>
    label
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word !== '' && word !== 'the')
  const verdicts = user.split('\n\n').flatMap((block) => {
    const head = /^(\d+)\. (Who|Thread|Reveals|Same): (.*)$/m.exec(block)
    if (head === null) return []
    const i = Number(head[1])
    const fact = /^Fact: (.*)$/m.exec(block)?.[1] ?? ''
    if (head[2] === 'Same') {
      const [a, b] = (head[3] ?? '')
        .split(' | ')
        .map((side) => /^\S+ ([^:]+)/.exec(side)?.[1] ?? '')
      const shared = words(a ?? '').some((word) => words(b ?? '').includes(word))
      return [{ i, ok: shared }]
    }
    if (head[2] === 'Reveals') return [{ i, ok: true, voice: 'narration', mode: 'now' }]
    const step = /^(opens|advances|resolves):/.exec(fact)?.[1]
    if (head[2] === 'Thread') return [{ i, ok: true, how: step, voice: 'narration', mode: 'now' }]
    const knows = /^knows, (\w+)(?: from (r\d+))?/.exec(fact)
    return [
      {
        i,
        ok: true,
        r: /^(r\d+)/.exec(head[3] ?? '')?.[1] ?? null,
        voice: 'narration',
        mode: 'now',
        ...(knows === null ? {} : { how: knows[1], fr: knows[2] ?? null })
      }
    ]
  })
  return JSON.stringify({ v: verdicts })
}

/** Every chat request the fake provider saw: JSON mode or not, and its messages. */
const providerBodies: { json: boolean; messages: { role: string; content: string }[] }[] = []
let provider: http.Server

/**
 * A fake OpenAI-compatible provider on loopback: a filing request (its sentinel) gets
 * `FILING_ANSWER`, a reader or checker request (F-16.17) the fake reader's or checker's answer, a
 * plan-link pick (F-16.21) the first scene, a v2 synopsis one sentence, a beta read no items, any
 * other JSON request an empty object, a plain one `GHOST_ANSWER` (streamed when asked);
 * `GET /models/<id>` echoes the id.
 */
function startFakeProvider(): Promise<string> {
  provider = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
      const id = (req.url ?? '').split('/').pop() ?? ''
      res.end(JSON.stringify({ id, object: 'model', created: 0, owned_by: 'system' }))
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      const request = JSON.parse(body) as {
        model: string
        stream?: boolean
        response_format?: { type?: string }
        messages: { role: string; content: string }[]
      }
      const json = request.response_format?.type === 'json_object'
      providerBodies.push({ json, messages: request.messages })
      const system = request.messages[0]?.content ?? ''
      const content = system.startsWith(FILING_SENTINEL)
        ? FILING_ANSWER
        : system.startsWith(READER_SENTINEL)
          ? readerAnswer(request.messages)
          : system.startsWith(VERIFY_SENTINEL)
            ? verifyAnswer(request.messages)
            : system.startsWith(PLAN_LINKS_V2_SENTINEL)
              ? JSON.stringify({ pick: 'S1', why: PLAN_LINK_WHY })
              : system.startsWith(SYNOPSIS_V2_SENTINEL)
                ? JSON.stringify({ synopsis: 'Mara walks to the quay and waits.' })
                : system.startsWith(BETA_READER_OPENING)
                  ? JSON.stringify({ items: [] })
                  : system.startsWith(SCRIBE_SENTINEL)
                    ? scribeAnswer(request.messages)
                    : json
                      ? '{}'
                      : GHOST_ANSWER
      const usage = { prompt_tokens: 400, completion_tokens: 40, total_tokens: 440 }
      const base = { id: 'chatcmpl-fake', created: 0, model: request.model }
      if (request.stream === true) {
        res.setHeader('content-type', 'text/event-stream')
        const chunk = (payload: object): string =>
          `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...payload })}\n\n`
        res.write(chunk({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] }))
        res.write(chunk({ choices: [], usage }))
        res.end('data: [DONE]\n\n')
        return
      }
      res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage
        })
      )
    })
  })
  return new Promise((resolve) => {
    provider.listen(0, '127.0.0.1', () => {
      const address = provider.address()
      if (!address || typeof address === 'string') throw new Error('the fake provider has no port')
      resolve(`http://127.0.0.1:${address.port}/v1`)
    })
  })
}

/** A word nothing else in the project holds, so search and compile can be asked about it. */
const RESEARCH_WORD = 'Quillback'
const TYPED = ' The reef drops away past the second buoy.'
const SECOND_PARAGRAPH = 'Maybe the lighthouse keeper lied about the wreck.'

/** The launch environment without the story-memory override (slice 6 launches on v1 with it). */
let baseEnv: Record<string, string>

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-e2e-memory-'))
  const providerUrl = await startFakeProvider()
  baseEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[1] !== undefined && e[0] !== 'MYTHSCRIBE_STORY_MEMORY'
      )
    ),
    NODE_ENV: 'test',
    MYTHSCRIBE_USER_DATA: path.join(tmp, 'userData'),
    MYTHSCRIBE_E2E_PLAINTEXT_KEYS: '1',
    // Nothing leaves the machine: the own-key provider is the fake on loopback, and a closed
    // port answers any Cloud request at once.
    OPENAI_BASE_URL: providerUrl,
    MYTHSCRIBE_CLOUD_API_URL: 'http://127.0.0.1:9'
  }
  const env = { ...baseEnv, MYTHSCRIBE_STORY_MEMORY: 'v2' }
  app = await electron.launch({ args: ['.'], env })
  app.on('close', () => {
    exited = true
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  if (!exited) await app?.close()
  provider?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function invoke<T>(channel: string, input: unknown): Promise<T> {
  const result = await page.evaluate<IpcResult<T>, { channel: string; input: unknown }>(
    ({ channel: name, input: value }) =>
      window.mythscribe.invoke(name as never, value) as Promise<IpcResult<T>>,
    { channel, input }
  )
  if (!result.ok) throw new Error(`${channel} failed: ${result.error.message}`)
  return result.data
}

/** Shows a sidebar section through the picker (the unused ones behind "Show unused sections"). */
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

/**
 * Closes the open project and makes a new one through the wizard (Use AI on, its default; the own
 * key already saved), so its scenes are 1.1, 1.2, … and "checked up to" counts from its first.
 */
async function newV2Project(name: string): Promise<TreeNode> {
  await page.getByRole('button', { name: 'Close project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible()
  const projectPath = path.join(tmp, `${name}.mythscribe`)
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, projectPath)
  await page.getByRole('button', { name: 'New project' }).click()
  const wizard = page.getByRole('dialog')
  await wizard.getByRole('textbox', { name: 'Project name' }).fill(name)
  for (let step = 0; step < 4; step += 1) {
    await wizard.getByRole('button', { name: 'Next' }).click()
  }
  await wizard.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('project-name')).toHaveText(name)
  expect((await invoke<ProjectInfo | null>('project:current', undefined))?.storyMemory).toBe('v2')
  const first = (await invoke<TreeNode[]>('tree:list', undefined)).find(
    (n) => n.kind === 'document' && n.hierarchyLevel === 'scene'
  )
  if (!first) throw new Error('the new project has no scene')
  return first
}

/** Closes the project and opens it again from Recent projects (the tree then holds invoked scenes). */
async function reopenProject(name: string): Promise<void> {
  await page.getByRole('button', { name: 'Close project' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await page
    .getByRole('list', { name: 'Recent projects' })
    .getByRole('button', { name, exact: true })
    .click()
  await expect(page.getByTestId('project-name')).toHaveText(name)
}

/** The paragraphs of a stored page, each with its Not canon mark. */
async function storedParagraphs(id: string): Promise<{ text: string; notCanon: boolean }[]> {
  const stored = await invoke<{ content: TiptapNodeT | null }>('document:get', { id })
  return (stored.content?.content ?? [])
    .filter((block) => block.type === 'paragraph')
    .map((block) => ({
      text: (block.content ?? []).map((child) => child.text ?? '').join(''),
      notCanon: block.attrs?.notCanon === true
    }))
}

test('story memory v2: the Research section and Not canon pages (P1 slice 2)', async () => {
  // Create a project through the wizard with Use AI off; the dev override runs it on v2.
  const projectPath = path.join(tmp, 'Memory Novel.mythscribe')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, projectPath)
  await page.getByRole('button', { name: 'New project' }).click()
  const wizard = page.getByRole('dialog')
  await wizard.getByRole('textbox', { name: 'Project name' }).fill('Memory Novel')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await expect(wizard).toContainText('Step 4 of 5')
  await wizard.getByText('Off', { exact: true }).click()
  await expect(wizard.getByRole('radio', { name: /^off/i })).toBeChecked()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Memory Novel')
  const info = await invoke<ProjectInfo | null>('project:current', undefined)
  expect(info?.storyMemory).toBe('v2')

  // F-16.8: the v2 open made the Research root, after end matter.
  const roots = (await invoke<TreeNode[]>('tree:list', undefined)).filter(
    (n) => n.parentId === null
  )
  expect(roots.map((n) => n.sectionType)).toEqual(['front', 'manuscript', 'end', 'research'])

  // Research is in the picker; the Manuscript tree does not show it.
  await page.getByRole('button', { name: /^Section: / }).click()
  await expect(
    page.getByRole('listbox', { name: 'Sections' }).getByRole('option', { name: 'Research' })
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await showSection('Manuscript')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await expect(bookTree.getByRole('treeitem', { name: 'Manuscript' })).toBeVisible()
  await expect(bookTree.getByRole('treeitem', { name: 'Research' })).toHaveCount(0)

  // Add a .md file through the (stubbed) open dialog: it opens as an editable page.
  const notes = path.join(tmp, 'Reef notes.md')
  fs.writeFileSync(
    notes,
    `# The reef\n\n${RESEARCH_WORD} rockfish live forty fathoms down.\n\n${SECOND_PARAGRAPH}\n`
  )
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] })
  }, notes)
  await showSection('Research')
  const researchTree = page.getByRole('tree', { name: 'Document tree' })
  await expect(researchTree.getByRole('treeitem', { name: 'Research' })).toBeVisible()
  await expect(researchTree.getByRole('treeitem', { name: 'Manuscript' })).toHaveCount(0)
  await page
    .getByRole('toolbar', { name: 'Research' })
    .getByRole('button', { name: 'Add files…' })
    .click()
  await expect(researchTree.getByRole('treeitem', { name: 'Reef notes' })).toBeVisible()
  const researchPage = page.getByTestId('research-page')
  await expect(researchPage.getByRole('heading', { name: 'Reef notes' })).toBeVisible()
  await expect(researchPage.getByTestId('research-source')).toHaveText(
    'Uploaded from Reef notes.md'
  )
  const editor = page.getByRole('textbox', { name: 'Research page' })
  await expect(editor).toContainText(`${RESEARCH_WORD} rockfish live forty fathoms down.`)
  const nodeId =
    (await invoke<TreeNode[]>('tree:list', undefined)).find((n) => n.title === 'Reef notes')?.id ??
    ''
  expect(nodeId).not.toBe('')

  // Edit it: the typed words are saved with the page.
  await caretToEnd(editor)
  await page.keyboard.type(TYPED)
  await expect
    .poll(async () => (await storedParagraphs(nodeId)).map((p) => p.text).at(-1))
    .toBe(`${SECOND_PARAGRAPH}${TYPED}`)

  // Mark the paragraph Not canon from the page's toolbar: it is muted and stored marked.
  const notCanon = page
    .getByRole('toolbar', { name: 'Page' })
    .getByRole('button', { name: 'Not canon' })
  await expect(notCanon).toHaveAttribute('aria-pressed', 'false')
  await notCanon.click()
  await expect(notCanon).toHaveAttribute('aria-pressed', 'true')
  await expect(editor.locator('p[data-not-canon]')).toHaveCount(1)
  await expect(editor.locator('p[data-not-canon]')).toContainText(SECOND_PARAGRAPH)
  await expect
    .poll(async () => (await storedParagraphs(nodeId)).map((p) => p.notCanon))
    .toEqual([false, true])
  // The first paragraph is still canon until the page itself is switched.
  await editor.getByText(`${RESEARCH_WORD} rockfish`, { exact: false }).click()
  await expect(notCanon).toHaveAttribute('aria-pressed', 'false')

  // Switch the whole page Not canon.
  await researchPage.getByRole('switch').click()
  await expect(researchPage).toHaveAttribute('data-not-canon', 'true')
  await expect
    .poll(async () =>
      (await invoke<ResearchDoc[]>('research:list', undefined)).find((d) => d.nodeId === nodeId)
    )
    .toMatchObject({ origin: 'upload', fileType: 'md', notCanon: true })

  // Word search finds it, labelled a source document.
  const searchDialog = page.getByRole('dialog', { name: 'Search project' })
  await page.keyboard.press('Control+Shift+F')
  await expect(searchDialog).toBeVisible()
  await expect(searchDialog.getByRole('button', { name: 'Source documents' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await searchDialog.getByRole('searchbox', { name: 'Search the project' }).fill(RESEARCH_WORD)
  const hit = searchDialog.getByTestId('search-result-research')
  await expect(hit).toHaveCount(1)
  await expect(hit).toContainText('Reef notes')
  await expect(hit).toContainText('Source document')
  await expect(searchDialog.getByTestId('search-result-document')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(searchDialog).toHaveCount(0)

  // The compiled preview leaves Research out.
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'View' })
    .click()
  await page
    .getByRole('menu', { name: 'View' })
    .getByRole('menuitem', { name: 'Compiled preview' })
    .click()
  const compiled = page.getByRole('dialog', { name: 'Compiled preview' })
  const preview = compiled.getByTestId('compile-preview')
  await expect(preview).toBeVisible()
  await expect(preview).not.toContainText(RESEARCH_WORD)
  await expect(preview).not.toContainText('Reef notes')
  await page.keyboard.press('Escape')
  await expect(compiled).toHaveCount(0)
})

/** One record as `record:get` answers it, with its pages' text. */
interface StoredRecord {
  id: string
  name: string
  aliases: { id: string; text: string; shared: boolean }[]
  pinned: TiptapNodeT | null
  ideas: TiptapNodeT | null
}

const pageText = (doc: TiptapNodeT | null): string =>
  (doc?.content ?? [])
    .map((block) => (block.content ?? []).map((child) => child.text ?? '').join(''))
    .join('\n')

test('story memory v2: sheets, labels, typed details and the v2 editor (P1 slice 3)', async () => {
  // Continues in the project the slice 2 test made. Records replace the v1 sheets and tags.
  const sectionNames = async (): Promise<string[]> => {
    await page.getByRole('button', { name: /^Section: / }).click()
    const list = page.getByRole('listbox', { name: 'Sections' })
    const unused = list.getByRole('option', { name: /^Show unused sections/ })
    if ((await unused.count()) > 0) await unused.click()
    const names = await list.getByRole('option').allTextContents()
    await page.keyboard.press('Escape')
    await expect(list).toHaveCount(0)
    return names
  }
  // (The thread category stays, as a plain record list, until P2b.)
  const names = (await sectionNames()).join(' | ')
  for (const gone of ['Index', 'Timeline', 'Library', 'To do', 'Changes']) {
    expect(names).not.toMatch(new RegExp(`(^| )${gone}( |\\d|$)`))
  }
  expect(names).toContain('Research')
  expect(names).toContain('Outline')

  // F-16.6: create "Mara Vell" in Characters; the gate is clear, so it is made and opened.
  await showSection('Characters')
  const createDialog = page.getByRole('dialog', { name: 'New character' })
  await page.getByRole('button', { name: 'New character…' }).click()
  await createDialog.getByRole('textbox', { name: 'Name' }).fill('Mara Vell')
  await createDialog.getByRole('button', { name: 'Create' }).click()
  await expect(createDialog).toHaveCount(0)
  const sheet = page.getByTestId('record-sheet')
  await expect(sheet.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Mara Vell')
  const records = (): Promise<StoredRecord[]> => invoke<StoredRecord[]>('record:list', undefined)
  const maraId = (await records()).find((r) => r.name === 'Mara Vell')?.id ?? ''
  expect(maraId).not.toBe('')

  // Add the nickname "Mara".
  await sheet.getByRole('textbox', { name: 'New nickname' }).fill('Mara')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  const nicknames = sheet.getByRole('list', { name: 'Nicknames' })
  await expect(nicknames.getByRole('listitem', { name: 'Mara' })).toBeVisible()

  // Creating "Mara" now shows the twin gate's warning (decision P1-D4: warned, never blocked).
  await page.getByRole('button', { name: 'New character…' }).click()
  await createDialog.getByRole('textbox', { name: 'Name' }).fill('Mara')
  const warning = createDialog.getByTestId('record-gate-warning')
  await expect(warning).toContainText('Looks like Mara Vell')
  await expect(warning.getByRole('button', { name: 'Same as Mara Vell' })).toBeVisible()
  await expect(warning.getByRole('button', { name: 'Create anyway' })).toBeVisible()
  await expect(createDialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
  await createDialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(createDialog).toHaveCount(0)

  // A Pinned line and an Ideas line, each saved on the record's own page.
  const pinned = sheet.getByRole('textbox', { name: 'Pinned' })
  await caretToEnd(pinned)
  await page.keyboard.type('Eyes: grey as the harbour.')
  const ideas = sheet.getByRole('textbox', { name: 'Ideas' })
  await caretToEnd(ideas)
  await page.keyboard.type('Maybe she was a smuggler once.')
  await expect
    .poll(async () => {
      const stored = await invoke<StoredRecord>('record:get', { id: maraId })
      return [pageText(stored.pinned), pageText(stored.ideas)]
    })
    .toEqual(['Eyes: grey as the harbour.', 'Maybe she was a smuggler once.'])

  // A second record, then Same as: it joins Mara Vell; Split brings it back.
  await page.getByRole('button', { name: 'New character…' }).click()
  await createDialog.getByRole('textbox', { name: 'Name' }).fill('Tomas Harrow')
  await createDialog.getByRole('button', { name: 'Create' }).click()
  await expect(createDialog).toHaveCount(0)
  await expect(sheet.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'Tomas Harrow'
  )
  await page
    .getByRole('list', { name: 'Characters' })
    .getByRole('button', { name: /^Mara Vell/ })
    .click()
  await expect(sheet.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Mara Vell')
  await sheet.getByRole('button', { name: 'Same as…' }).click()
  await sheet
    .getByRole('combobox', { name: /Which record is the same/ })
    .selectOption({ label: 'Tomas Harrow' })
  await expect(sheet).toContainText('Tomas Harrow becomes part of Mara Vell')
  await sheet.getByRole('button', { name: 'Merge into Mara Vell' }).click()
  await expect(nicknames.getByRole('listitem', { name: 'Tomas Harrow' })).toBeVisible()
  await expect.poll(async () => (await records()).map((r) => r.name)).toEqual(['Mara Vell'])
  await sheet.getByRole('button', { name: 'Split…' }).click()
  await sheet.getByRole('checkbox', { name: 'Tomas Harrow' }).check()
  await sheet.getByRole('button', { name: 'Split into a new record' }).click()
  await expect(nicknames.getByRole('listitem', { name: 'Tomas Harrow' })).toHaveCount(0)
  await expect
    .poll(async () => (await records()).map((r) => r.name).sort())
    .toEqual(['Mara Vell', 'Tomas Harrow'])
  // Merged pages stay on Mara's sheet.
  await expect(pinned).toContainText('Eyes: grey as the harbour.')

  // Identity rule 4: Tomas has the surname "Harrow"; adding it to Mara offers to share it, and
  // Share marks it shared on both.
  const characters = page.getByRole('list', { name: 'Characters' })
  await characters.getByRole('button', { name: /^Tomas Harrow/ }).click()
  await expect(sheet.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
    'Tomas Harrow'
  )
  await sheet.getByRole('textbox', { name: 'New nickname' }).fill('Harrow')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(nicknames.getByRole('listitem', { name: 'Harrow' })).toBeVisible()
  await characters.getByRole('button', { name: /^Mara Vell/ }).click()
  await expect(sheet.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Mara Vell')
  await sheet.getByRole('textbox', { name: 'New nickname' }).fill('Harrow')
  await sheet.getByRole('button', { name: 'Add', exact: true }).click()
  const share = page.getByRole('dialog', { name: 'Share “Harrow”?' })
  await expect(share).toContainText('already a name of Tomas Harrow')
  await share.getByRole('button', { name: 'Share' }).click()
  await expect(nicknames.getByRole('listitem', { name: 'Harrow' })).toContainText(
    'Shared with Tomas Harrow'
  )
  await expect
    .poll(async () =>
      (await records())
        .flatMap((r) => r.aliases.filter((a) => a.text === 'Harrow').map((a) => [r.name, a.shared]))
        .sort()
    )
    .toEqual([
      ['Mara Vell', true],
      ['Tomas Harrow', true]
    ])

  // F-16.7 and F-16.11: open the first scene; its details take a tone label and Mara as POV.
  const scene = (await invoke<TreeNode[]>('tree:list', undefined)).find(
    (n) => n.kind === 'document' && n.hierarchyLevel === 'scene'
  )
  if (!scene) throw new Error('no scene in the seed')
  await showSection('Manuscript')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await bookTree.getByRole('treeitem', { name: scene.title }).first().click()
  await expect(sheet).toHaveCount(0)
  const notesColumn = page.getByTestId('notes-panel')
  if ((await notesColumn.count()) === 0) {
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
  }
  const detailsToggle = notesColumn.getByRole('button', { name: 'Scene details' })
  if ((await detailsToggle.getAttribute('aria-expanded')) !== 'true') await detailsToggle.click()
  const metadata = notesColumn.getByRole('group', { name: 'Scene metadata' })
  await expect(metadata.getByRole('combobox', { name: 'Location' })).toHaveCount(0)

  // A tone label, made in the Labels dialog and put on the scene.
  await metadata.getByRole('button', { name: 'Manage labels…' }).click()
  const labelsDialog = page.getByRole('dialog', { name: 'Labels' })
  await labelsDialog.getByRole('textbox', { name: 'New label name' }).fill('Wry')
  await labelsDialog.getByRole('combobox', { name: 'New label kind' }).selectOption('tone')
  await labelsDialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(labelsDialog.getByRole('listitem', { name: 'Wry' })).toBeVisible()
  await labelsDialog.getByRole('button', { name: 'Done' }).click()
  await expect(labelsDialog).toHaveCount(0)
  await metadata.getByRole('combobox', { name: 'Add a label' }).selectOption({ label: 'Wry' })
  await expect(metadata.getByTestId('label-chip')).toHaveText(['Wry'])

  // The Manuscript tree filters by it.
  await page.getByRole('combobox', { name: 'Filter by label' }).selectOption({ label: 'Wry' })
  await expect(page.getByText('1 document carries Wry')).toBeVisible()
  await expect(bookTree.getByRole('treeitem', { name: scene.title })).toBeVisible()
  await page.getByRole('button', { name: 'Clear filter' }).click()

  // Mara as the POV, stored as the record's id.
  const pov = metadata.getByRole('combobox', { name: 'POV' })
  await expect(pov).toBeEnabled()
  await pov.selectOption({ label: 'Mara Vell' })
  await expect
    .poll(
      async () =>
        (await invoke<{ povRecordId: string | null }>('sceneDetail:get', { nodeId: scene.id }))
          .povRecordId
    )
    .toBe(maraId)

  // F-16.5, F-16.6: the scene names Mara Vell; once the local name scan has run, her sheet's
  // Named in lists the scene, and a click there selects her name in it.
  const editor = page.getByRole('textbox', { name: 'Document' })
  await caretToEnd(editor)
  await page.keyboard.type(' Mara Vell waited by the steps.')
  await expect
    .poll(
      async () =>
        (await invoke<{ recordId: string; nodeId: string }[]>('names:byRecord', undefined)).some(
          (row) => row.recordId === maraId && row.nodeId === scene.id
        ),
      { timeout: 15_000 }
    )
    .toBe(true)
  await showSection('Characters')
  await characters.getByRole('button', { name: /^Mara Vell/ }).click()
  const namedIn = sheet.getByRole('region', { name: 'Named in' })
  await namedIn.getByRole('button', { name: new RegExp(scene.title) }).click()
  await expect(sheet).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe('Mara Vell')

  // F-16.4: typing # in the scene opens no tag suggestion (tags are gone in v2).
  await caretToEnd(editor)
  await page.keyboard.type(' #Ma')
  await expect(editor).toContainText('#Ma')
  await expect(page.getByRole('listbox', { name: 'Tag suggestions' })).toHaveCount(0)
  // Nor is there a tags column or its toggle.
  await expect(page.getByRole('button', { name: 'Tags', exact: true })).toHaveCount(0)

  // F-16.8: a file dropped on the window becomes a Research page (no Library, no sort).
  await page.evaluate(() => {
    const files = new DataTransfer()
    files.items.add(new File(['The tide turns at the second buoy.'], 'Harbour log.md'))
    const options = { dataTransfer: files, bubbles: true, cancelable: true }
    window.dispatchEvent(new DragEvent('dragenter', options))
    window.dispatchEvent(new DragEvent('drop', options))
  })
  const researchTree = page.getByRole('tree', { name: 'Document tree' })
  await expect(researchTree.getByRole('treeitem', { name: 'Harbour log' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Research page' })).toContainText(
    'The tide turns at the second buoy.'
  )
  expect(
    (await invoke<ResearchDoc[]>('research:list', undefined)).filter((d) => d.origin === 'upload')
  ).toHaveLength(2)
})

/** The stored plain text of a document, paragraphs joined by new lines. */
async function storedText(id: string): Promise<string> {
  return (await storedParagraphs(id)).map((paragraph) => paragraph.text).join('\n')
}

test('story memory v2: This scene, Needs a look, Dismissed and Rename in book (P1 slice 4)', async () => {
  // Continues in the project the slice 3 test made (Mara Vell, nickname "Mara", and Tomas Harrow).
  const scenes = (await invoke<TreeNode[]>('tree:list', undefined)).filter(
    (n) => n.kind === 'document' && n.hierarchyLevel === 'scene'
  )
  const first = scenes[0]
  if (!first) throw new Error('no scene in the seed')
  const records = (): Promise<StoredRecord[]> => invoke<StoredRecord[]>('record:list', undefined)
  const maraId = (await records()).find((r) => r.name === 'Mara Vell')?.id ?? ''
  await showSection('Manuscript')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await bookTree.getByRole('treeitem', { name: first.title }).first().click()
  const editor = page.getByRole('textbox', { name: 'Document' })
  await clickIntoEditor(editor)
  await page.keyboard.press('Control+A')
  await page.keyboard.type('Mara walked in.')

  // F-16.12: the This scene panel sits in the tags panel's slot (its header toggle in v2).
  const panel = page.getByTestId('this-scene-panel')
  if ((await panel.count()) === 0) {
    await page.getByRole('button', { name: 'This scene', exact: true }).click()
  }
  await expect(panel.getByRole('tab', { name: 'This scene' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  // Here: the POV the slice 3 test chose.
  await expect(panel.getByRole('region', { name: 'Here' }).getByLabel('POV')).toHaveValue(maraId)

  // F-16.5: "Mara walked in." gives a Named chip once the local scan has read the saved text
  // (the scene named "Mara Vell" before, so the chip is waited for on the new mention).
  await expect
    .poll(
      async () =>
        (await invoke<{ text: string }[]>('names:forNode', { nodeId: first.id })).map(
          (m) => m.text
        ),
      { timeout: 15_000 }
    )
    .toEqual(['Mara'])
  const chips = panel.getByTestId('named-chips')
  const maraChip = chips.getByRole('button', { name: /^Mara Vell/ })
  await expect(maraChip).toBeVisible({ timeout: 15_000 })
  await expect(maraChip).toHaveAttribute('title', 'named once: ¶1')

  // Not a mention takes it off and lands on the one Dismissed list (F-16.10).
  const before = (await invoke<{ count: number }>('dismissed:list', undefined)).count
  await maraChip.click()
  const why = panel.getByRole('group', { name: 'Why Mara Vell is here' })
  await why.getByRole('button', { name: 'Not a mention' }).click()
  await expect(maraChip).toHaveCount(0)
  const dismissedButton = panel.getByRole('button', { name: `Dismissed (${before + 1})` })
  await expect(dismissedButton).toBeVisible()
  await dismissedButton.click()
  const dismissedDialog = page.getByRole('dialog', { name: /^Dismissed \(/ })
  await expect(dismissedDialog.getByRole('heading')).toHaveText(`Dismissed (${before + 1})`)
  const undoRow = dismissedDialog.getByRole('button', { name: /^Undo: "Mara walked" is not/ })
  await expect(undoRow).toBeVisible()
  // Undo brings it back: the chip returns once the scan reads the scene again.
  await undoRow.click()
  await expect(dismissedDialog.getByRole('heading')).toHaveText(`Dismissed (${before})`)
  await dismissedDialog.getByRole('button', { name: 'Close' }).click()
  await expect(dismissedDialog).toHaveCount(0)
  await expect(maraChip).toBeVisible({ timeout: 15_000 })

  // F-16.4: "Hesk" written in two scenes becomes a question in Needs a look.
  await caretToEnd(editor)
  await page.keyboard.type(' They waited for Hesk.')
  await page.getByRole('button', { name: 'New scene' }).click()
  const renameBox = page.getByRole('textbox', { name: 'Rename' })
  await expect(renameBox).toBeFocused()
  await renameBox.fill('Two')
  await renameBox.press('Enter')
  await expect(renameBox).toBeHidden()
  await bookTree.getByRole('treeitem', { name: 'Two', exact: true }).click()
  await caretToEnd(editor)
  await page.keyboard.type('The boat belonged to Hesk.')
  const second = (await invoke<TreeNode[]>('tree:list', undefined)).find((n) => n.title === 'Two')
  if (!second) throw new Error('the second scene was not made')
  const needs = panel.getByRole('region', { name: 'Needs a look' })
  const questions = needs.getByRole('group', { name: 'Questions' })
  await expect(questions).toContainText('Hesk: named in 2 scenes', { timeout: 15_000 })
  // Its badge counts conflicts only: questions never light it.
  await expect(panel.getByTestId('needs-a-look-badge')).toHaveCount(0)
  await questions
    .getByRole('combobox', { name: 'Add Hesk as' })
    .selectOption({ label: 'Character' })
  await expect.poll(async () => (await records()).map((r) => r.name)).toContain('Hesk')
  await expect(questions).toHaveCount(0)

  // F-16.10: a to-do for this scene, added and ticked.
  await needs.getByRole('button', { name: 'Add a to-do' }).click()
  await needs.getByRole('textbox', { name: 'New to-do' }).fill('Check the tide tables')
  await needs.getByRole('button', { name: 'Add', exact: true }).click()
  const tick = needs.getByRole('checkbox', { name: 'Done: Check the tide tables' })
  await expect(tick).toBeVisible()
  // Ticked, it moves behind the collapsed "1 done" line (it never crowds Needs a look).
  await tick.click()
  await expect(needs.getByText('1 done', { exact: true })).toBeVisible()
  await expect
    .poll(async () =>
      (
        await invoke<{ text: string; done: boolean; nodeId: string | null }[]>(
          'authorTodo:list',
          undefined
        )
      ).map((t) => [t.text, t.done, t.nodeId])
    )
    .toEqual([['Check the tide tables', true, second.id]])

  // F-16.13: Rename in book, from Hesk's chip in the open scene: the preview counts the 2 places
  // the name scan reads as Hesk in 2 scenes; Rename changes the open scene in its editor (at
  // main's places) and the other one in main.
  const heskChip = chips.getByRole('button', { name: /^Hesk/ })
  await expect(heskChip).toBeVisible({ timeout: 15_000 })
  await heskChip.click()
  const heskCard = panel.getByRole('group', { name: 'Why Hesk is here' })
  await heskCard.getByRole('button', { name: 'Rename in book…' }).click()
  await heskCard.getByRole('textbox', { name: 'New name' }).fill('Haskel')
  await expect(heskCard.getByTestId('rename-preview')).toContainText('2 matches in 2 scenes')
  await heskCard.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(editor).toContainText('The boat belonged to Haskel.')
  await expect.poll(() => storedText(first.id)).toBe('Mara walked in. They waited for Haskel.')
  await expect.poll(async () => (await records()).map((r) => r.name)).toContain('Haskel')
  const renamed = page
    .getByRole('status')
    .locator('div')
    .filter({ hasText: 'Renamed “Hesk” to “Haskel”: 2 matches in 2 scenes.' })
  await expect(renamed).toBeVisible()

  // One Undo restores both scenes and the name.
  await renamed.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(editor).toContainText('The boat belonged to Hesk.')
  await expect.poll(() => storedText(first.id)).toBe('Mara walked in. They waited for Hesk.')
  await expect.poll(() => storedText(second.id)).toBe('The boat belonged to Hesk.')
  await expect.poll(async () => (await records()).map((r) => r.name)).toContain('Hesk')
})

test('story memory v2: the Story notes block and filing into Pinned (P1 slice 5)', async () => {
  // Slices 2 to 4 ran with Use AI off: nothing reached the provider.
  expect(providerBodies).toEqual([])
  const records = (): Promise<StoredRecord[]> => invoke<StoredRecord[]>('record:list', undefined)
  const maraId = (await records()).find((r) => r.name === 'Mara Vell')?.id ?? ''
  expect(maraId).not.toBe('')

  // Use AI on, with an own OpenAI key at the fake provider.
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('Control+,')
  await expect(settingsDialog).toBeVisible()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await settingsDialog.getByRole('switch', { name: 'Use AI' }).check()
  await settingsDialog
    .getByRole('radiogroup', { name: 'Key provider' })
    .getByTestId('own-key-provider-openai')
    .click()
  await expect(settingsDialog.getByRole('form', { name: 'OpenAI API key' })).toBeVisible()
  await settingsDialog.getByLabel('API key', { exact: true }).fill(OWN_KEY)
  await settingsDialog.getByRole('button', { name: 'Save' }).click()
  await expect(settingsDialog.getByTestId('ai-key-hint')).toHaveText('Key saved: sk-…5678')
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  // F-16.14: ghost text in the first scene (Mara's POV, her Pinned "Eyes: grey as the harbour.")
  // sends the Story notes block in its system turn; her Ideas line is never in it.
  const first = (await invoke<TreeNode[]>('tree:list', undefined)).find(
    (n) => n.kind === 'document' && n.hierarchyLevel === 'scene'
  )
  if (!first) throw new Error('no scene in the seed')
  await showSection('Manuscript')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await bookTree.getByRole('treeitem', { name: first.title }).first().click()
  const editor = page.getByRole('textbox', { name: 'Document' })
  const vibeWrite = page.getByRole('button', { name: 'VibeWrite' })
  await expect(vibeWrite).toBeEnabled()
  await vibeWrite.click()
  await expect(vibeWrite).toHaveAttribute('aria-pressed', 'true')
  await caretToEnd(editor)
  await page.keyboard.type(' Mara Vell looked back at the quay.')
  await expect(editor.locator('.ghost-text')).toHaveText(GHOST_ANSWER, { timeout: 15_000 })
  const ghost = providerBodies.filter((body) => !body.json).at(-1)
  const ghostSystem = ghost?.messages[0]
  expect(ghostSystem?.role).toBe('system')
  expect(ghostSystem?.content).toContain(STORY_NOTES_HEADING)
  expect(ghostSystem?.content).toContain('Here: Mara Vell (POV)')
  expect(ghostSystem?.content).toContain('Eyes: grey as the harbour.')
  expect(ghostSystem?.content).not.toContain('smuggler')
  await page.keyboard.press('Escape')
  await expect(editor.locator('.ghost-text')).toHaveCount(0)
  await vibeWrite.click()
  await expect(vibeWrite).toHaveAttribute('aria-pressed', 'false')

  // The panel's *What the AI is told* shows that block, read locally.
  const panel = page.getByTestId('this-scene-panel')
  if ((await panel.count()) === 0) {
    await page.getByRole('button', { name: 'This scene', exact: true }).click()
  }
  const told = panel.getByTestId('what-the-ai-is-told')
  await told.locator('summary').click()
  const block = told.getByTestId('story-notes-block')
  await expect(block).toContainText(STORY_NOTES_HEADING)
  expect(ghostSystem?.content).toContain((await block.textContent()) ?? '')

  // F-16.9: upload Bestiary.md into Research and file it into Pinned.
  const bestiary = path.join(tmp, 'Bestiary.md')
  fs.writeFileSync(bestiary, BESTIARY)
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] })
  }, bestiary)
  await showSection('Research')
  const researchTree = page.getByRole('tree', { name: 'Document tree' })
  await page
    .getByRole('toolbar', { name: 'Research' })
    .getByRole('button', { name: 'Add files…' })
    .click()
  await expect(researchTree.getByRole('treeitem', { name: 'Bestiary' })).toBeVisible()
  const researchPage = page.getByTestId('research-page')
  await expect(researchPage.getByRole('heading', { name: 'Bestiary', level: 2 })).toBeVisible()
  await researchPage.getByTestId('research-file').click()
  const filing = page.getByTestId('filing-dialog')
  await expect(filing.getByTestId('filing-estimate')).toContainText('1 request to gpt-5.4')
  await filing.getByTestId('filing-confirm').click()
  await expect(filing.getByTestId('filing-summary')).toHaveText(
    'From “Bestiary”: 1 new record · 1 record added to'
  )
  // By its sentinel: leaving a scene may have sent a reading since (P2a slice 3).
  const filingBody = providerBodies
    .filter((body) => body.messages[0]?.content.startsWith(FILING_SENTINEL) === true)
    .at(-1)
  expect(filingBody).toBeDefined()
  expect(filingBody?.messages.at(-1)?.content).toContain('Mara Vell keeps a fen-wight skull')
  // Everything starts accepted; Apply writes both cards.
  await filing.getByTestId('review-apply').click()
  await expect(filing).toHaveCount(0)
  await expect(researchPage.getByTestId('research-filed')).toContainText('Filed on ')
  await expect.poll(async () => (await records()).map((r) => r.name).sort()).toContain('Fen-wight')
  await expect
    .poll(async () => pageText((await invoke<StoredRecord>('record:get', { id: maraId })).pinned))
    .toBe(`Eyes: grey as the harbour.\n${FILED_LINE}`)

  // Mara's Pinned shows the filed line with its "Filed from" mark.
  await showSection('Characters')
  await page
    .getByRole('list', { name: 'Characters' })
    .getByRole('button', { name: /^Mara Vell/ })
    .click()
  const sheet = page.getByTestId('record-sheet')
  const pinned = sheet.getByRole('textbox', { name: 'Pinned' })
  await expect(pinned).toContainText(FILED_LINE)
  await expect(sheet.getByTestId('filed-from')).toHaveText(/^Filed from “Bestiary” ¶\d+$/)

  // Editing the quoted sentence in Research raises a Needs a look conflict.
  await showSection('Research')
  await researchTree.getByRole('treeitem', { name: 'Bestiary' }).click()
  const researchEditor = page.getByRole('textbox', { name: 'Research page' })
  await expect(researchEditor).toContainText('above her door.')
  await caretToEnd(researchEditor)
  for (const key of Array<string>('door.'.length).fill('Backspace')) await page.keyboard.press(key)
  await page.keyboard.type('gate.')
  await expect(researchEditor).toContainText('above her gate.')
  if ((await panel.count()) === 0) {
    await page.getByRole('button', { name: 'This scene', exact: true }).click()
  }
  const conflicts = panel
    .getByRole('region', { name: 'Needs a look' })
    .getByRole('group', { name: 'Conflicts' })
  const conflict = conflicts.getByTestId('filed-conflict')
  await expect(conflict).toContainText(`Mara Vell: “${FILED_LINE}”`, { timeout: 15_000 })
  await expect(conflict).toContainText('Mara Vell keeps a fen-wight skull above her gate.')
  await expect(panel.getByTestId('needs-a-look-badge')).toHaveText('1')
  // Keep line: the line stays as it is, and the conflict goes quiet.
  await conflict.getByRole('button', { name: 'Keep line' }).click()
  await expect(conflicts).toHaveCount(0)
  await expect
    .poll(async () => pageText((await invoke<StoredRecord>('record:get', { id: maraId })).pinned))
    .toBe(`Eyes: grey as the harbour.\n${FILED_LINE}`)
})

test('story memory v2: the evidence reader (P2a)', async () => {
  // Continues with Use AI on and an own key at the fake (slice 5); the reading switch is on.
  const isReader = (body: (typeof providerBodies)[number]): boolean =>
    body.messages[0]?.content.startsWith(READER_SENTINEL) === true
  const isVerify = (body: (typeof providerBodies)[number]): boolean =>
    body.messages[0]?.content.startsWith(VERIFY_SENTINEL) === true
  // Slice 5 left the second scene for the first with Use AI on, which read it (P2a slice 3).
  const readsBefore = providerBodies.filter(isReader).length
  const checksBefore = providerBodies.filter(isVerify).length
  const first = (await invoke<TreeNode[]>('tree:list', undefined)).find(
    (n) => n.kind === 'document' && n.hierarchyLevel === 'scene'
  )
  if (!first) throw new Error('no scene in the seed')
  await showSection('Manuscript')
  await page
    .getByRole('tree', { name: 'Document tree' })
    .getByRole('treeitem', { name: first.title })
    .first()
    .click()
  const editor = page.getByRole('textbox', { name: 'Document' })
  await caretToEnd(editor)
  await page.keyboard.press('Enter')
  await page.keyboard.type(READ_PARAGRAPH)
  await expect
    .poll(async () => (await storedText(first.id)).replace(/’/g, "'"), { timeout: 15_000 })
    .toContain(READ_PARAGRAPH)
  // Nothing reaches the reader while the author types.
  expect(providerBodies.filter(isReader)).toHaveLength(readsBefore)

  // Read now: the whole scene on its first read, then the check of what code could not prove.
  const read = await invoke<{ ok: boolean; read?: boolean }>('memory:readNow', {
    nodeId: first.id,
    requestId: 'e2e-read-now'
  })
  expect(read).toMatchObject({ ok: true, read: true })
  const reader = providerBodies.filter(isReader).slice(readsBefore)
  expect(reader).toHaveLength(1)
  expect(reader[0]?.json).toBe(true)
  expect(reader[0]?.messages[0]?.content).toMatch(/^r\d+ Mara Vell \(Mara/m)
  expect(reader[0]?.messages.at(-1)?.content.replace(/’/g, "'")).toContain(READ_PARAGRAPH)
  expect(providerBodies.filter(isVerify).slice(checksBefore)).toHaveLength(1)

  // The eyes are proved in code; where she walked, through the checker (the pronoun).
  interface MemoryClaim {
    id: string
    slot: string
    value: string
    proof: string
    state: string
  }
  const memory = await invoke<{ claims: MemoryClaim[]; card: { line: string } | null }>(
    'memory:scene',
    { nodeId: first.id }
  )
  const facts = memory.claims.map((claim) => [claim.slot, claim.value, claim.proof, claim.state])
  expect(facts).toContainEqual(['eyes', 'grey', 'literal', 'live'])
  expect(facts).toContainEqual(['location', 'the quay', 'verified', 'live'])
  expect(memory.card?.line).toBe('Mara walks to the quay.')
  const location = memory.claims.find((claim) => claim.slot === 'location')
  const info = await invoke<{
    claim: { quote: string }
    reading: { promptVersion: string } | null
  }>('memory:claim', { claimId: location?.id ?? '' })
  expect(info.claim.quote).toBe('She walked to the quay')
  // P2b slice 2: the reading is `reader.v2`'s (the same sentinel and the same facts here).
  expect(info.reading?.promptVersion).toBe('reader.v2')

  // Nothing changed since: a second Read now sends nothing.
  const before = providerBodies.length
  expect(
    await invoke('memory:readNow', { nodeId: first.id, requestId: 'e2e-read-now-2' })
  ).toMatchObject({ ok: true, read: false, reason: 'upToDate' })
  expect(providerBodies).toHaveLength(before)

  // P2a slice 3 (F-16.16): an edit to the eyes makes the claim stale once the save settles (the
  // anchors job), typing sends nothing, and opening the second scene reads Scene 1 again.
  const eyesOf = async (): Promise<MemoryClaim | undefined> =>
    (await invoke<{ claims: MemoryClaim[] }>('memory:scene', { nodeId: first.id })).claims.find(
      (claim) => claim.slot === 'eyes'
    )
  await caretToEnd(editor)
  // Back over "grey. She walked to the quay." (29 characters), then type it with brown.
  for (let i = 0; i < 29; i += 1) await page.keyboard.press('Backspace')
  await page.keyboard.type('brown. She walked to the quay.')
  await expect
    .poll(async () => (await storedText(first.id)).replace(/’/g, "'"), { timeout: 15_000 })
    .toContain("Mara's eyes were brown. She walked to the quay.")
  await expect.poll(async () => (await eyesOf())?.state, { timeout: 15_000 }).toBe('stale')
  const readsTyped = providerBodies.filter(isReader).length
  expect(readsTyped).toBe(readsBefore + 1)
  await page
    .getByRole('tree', { name: 'Document tree' })
    .getByRole('treeitem', { name: 'Two', exact: true })
    .click()
  await expect
    .poll(() => providerBodies.filter(isReader).length, { timeout: 15_000 })
    .toBe(readsTyped + 1)
  const leaveRead = providerBodies.filter(isReader).at(-1)
  expect(leaveRead?.messages.at(-1)?.content.replace(/’/g, "'")).toContain(
    "Mara's eyes were brown."
  )
  await expect
    .poll(
      async () => {
        const eyes = await eyesOf()
        return [eyes?.value, eyes?.state]
      },
      { timeout: 15_000 }
    )
    .toEqual(['brown', 'live'])

  // A Replace in project across 6 scenes nobody has read yet: more than 5 to read, so main asks
  // with the price and sends nothing (F-16.16, the backlog).
  const chapter = first.parentId ?? ''
  const added: string[] = []
  for (let i = 1; i <= 6; i += 1) {
    const node = await invoke<TreeNode>('tree:create', {
      parentId: chapter,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: `Harbour ${i}`
    })
    await invoke('document:save', {
      id: node.id,
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: `The lantern ${i} swung.` }] }
        ]
      }
    })
    added.push(node.id)
  }
  const readsBeforeReplace = providerBodies.filter(isReader).length
  const replaced = await invoke<{ changed: unknown[] }>('replace:commit', {
    query: 'lantern',
    replacement: 'lamp',
    matchCase: false,
    wholeWord: true,
    scopeId: null,
    ids: added
  })
  expect(replaced.changed).toHaveLength(6)
  interface Notice {
    kind: string
    scenes?: number
    priceUsd?: number
  }
  await expect
    .poll(
      async () =>
        (await invoke<Notice[]>('memory:notices', undefined)).find((n) => n.kind === 'backlog'),
      { timeout: 15_000 }
    )
    .toMatchObject({ kind: 'backlog' })
  const backlog = (await invoke<Notice[]>('memory:notices', undefined)).find(
    (n) => n.kind === 'backlog'
  )
  expect(backlog?.scenes).toBeGreaterThanOrEqual(6)
  expect(backlog?.priceUsd).toBeGreaterThan(0)
  expect(providerBodies.filter(isReader)).toHaveLength(readsBeforeReplace)

  // Rebuild memory is priced before anything is sent.
  const estimate = await invoke<{ scenes: number; costUsd: number }>(
    'memory:rebuildEstimate',
    undefined
  )
  expect(estimate.scenes).toBeGreaterThanOrEqual(8)
  expect(estimate.costUsd).toBeGreaterThan(0)
  expect(providerBodies.filter(isReader)).toHaveLength(readsBeforeReplace)

  // `summary.v5` is off in v2: no request ever carried its opening.
  expect(
    providerBodies.some((body) => body.messages[0]?.content.startsWith(SUMMARY_SENTINEL) === true)
  ).toBe(false)
})

test('story memory v2: Here, True now, sheets, cards and Rebuild memory (P2a slice 4)', async () => {
  // Continues with Use AI on, the own key at the fake, and Scene 1 read by the P2a test.
  const isReader = (body: (typeof providerBodies)[number]): boolean =>
    body.messages[0]?.content.startsWith(READER_SENTINEL) === true
  const scenes = (await invoke<TreeNode[]>('tree:list', undefined)).filter(
    (n) => n.kind === 'document' && n.hierarchyLevel === 'scene'
  )
  const first = scenes[0]
  const harbour = scenes.find((n) => n.title === 'Harbour 1')
  if (!first || !harbour) throw new Error('the P2a test’s scenes are missing')
  const maraId =
    (await invoke<StoredRecord[]>('record:list', undefined)).find((r) => r.name === 'Mara Vell')
      ?.id ?? ''
  await showSection('Manuscript')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await bookTree.getByRole('treeitem', { name: first.title }).first().click()
  const panel = page.getByTestId('this-scene-panel')
  if ((await panel.count()) === 0) {
    await page.getByRole('button', { name: 'This scene', exact: true }).click()
  }
  await panel.getByRole('tab', { name: 'This scene' }).click()

  // F-16.18: Scene 1 has a card, so Here and Mentioned (P2a-D21); Mara is Here (her typed POV)
  // and True now says where she was last seen.
  await expect(panel.getByRole('region', { name: 'Here' }).getByLabel('POV')).toHaveValue(maraId)
  await expect(panel.getByRole('region', { name: 'Mentioned' })).toBeVisible({ timeout: 15_000 })
  const trueNow = panel.getByRole('group', { name: 'True now: Mara Vell' })
  await expect(trueNow).toContainText('Last seen at the quay', { timeout: 15_000 })
  await expect(trueNow).toContainText('last stated in 1.1')
  await expect(panel.getByTestId('last-read')).toHaveText(/^Read (just now|\d+ min ago)$/)

  // F-16.16: Read now after an edit reads it (one reader request); again, nothing new.
  const editor = page.getByRole('textbox', { name: 'Document' })
  await caretToEnd(editor)
  await page.keyboard.press('Enter')
  await page.keyboard.type('The tide turned at noon.')
  await expect
    .poll(() => storedText(first.id), { timeout: 15_000 })
    .toContain('The tide turned at noon.')
  const readNow = panel.getByRole('button', { name: 'Read now' })
  const readsBefore = providerBodies.filter(isReader).length
  await readNow.click()
  await expect
    .poll(() => providerBodies.filter(isReader).length, { timeout: 15_000 })
    .toBe(readsBefore + 1)
  await expect(readNow).toBeEnabled({ timeout: 15_000 })
  await readNow.click()
  await expect(page.getByText('Nothing new to read in this scene.')).toBeVisible()
  expect(providerBodies.filter(isReader)).toHaveLength(readsBefore + 1)

  // Mara's sheet: From the book as of the open scene, with ⓘ; Not right › Wrong value sends the
  // line to Dismissed, whose Undo brings it back.
  await panel.getByRole('tab', { name: 'Book' }).click()
  await panel.getByRole('button', { name: /^Mara Vell/ }).click()
  const sheet = page.getByTestId('record-sheet')
  const fixed = sheet.getByRole('region', { name: 'From the book' }).getByRole('group', {
    name: 'Fixed'
  })
  const eyes = fixed.getByTestId('claim-line').filter({ hasText: 'Eyes: brown' })
  await expect(eyes).toBeVisible({ timeout: 15_000 })
  await eyes.getByRole('button', { name: 'Where this comes from: Eyes: brown' }).click()
  await expect(eyes.getByTestId('claim-info')).toContainText('quote checked in code')
  await expect(eyes.getByTestId('claim-info')).toContainText("Mara's eyes were brown")
  const dismissedBefore = (await invoke<{ count: number }>('dismissed:list', undefined)).count
  await eyes.getByRole('button', { name: 'Not right' }).click()
  await eyes.getByRole('button', { name: 'Wrong value' }).click()
  await expect(eyes).toHaveCount(0)
  const dismissedButton = panel.getByRole('button', { name: `Dismissed (${dismissedBefore + 1})` })
  await expect(dismissedButton).toBeVisible()
  await dismissedButton.click()
  const dismissedDialog = page.getByRole('dialog', { name: /^Dismissed \(/ })
  await dismissedDialog.getByRole('button', { name: 'Undo: Mara Vell: Eyes brown' }).click()
  await expect(dismissedDialog.getByRole('heading')).toHaveText(`Dismissed (${dismissedBefore})`)
  await dismissedDialog.getByRole('button', { name: 'Close' }).click()
  await expect(eyes).toBeVisible({ timeout: 15_000 })

  // Decision 4: a typed place the text disagrees with shows dimmed beside the card's place, and
  // Needs a look asks once; Keep mine clears it. (The Cast opened Mara in the Characters section.)
  await showSection('Manuscript')
  await bookTree.getByRole('treeitem', { name: first.title }).first().click()
  await expect(sheet).toHaveCount(0)
  const notesColumn = page.getByTestId('notes-panel')
  if ((await notesColumn.count()) === 0) {
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
  }
  const detailsToggle = notesColumn.getByRole('button', { name: 'Scene details' })
  if ((await detailsToggle.getAttribute('aria-expanded')) !== 'true') await detailsToggle.click()
  const metadata = notesColumn.getByRole('group', { name: 'Scene metadata' })
  const placeText = metadata.getByRole('textbox', { name: 'Place, in your words' })
  await placeText.fill('the harbour')
  await placeText.press('Enter')
  await metadata.getByRole('button', { name: 'Card' }).click()
  const where = metadata.getByTestId('card-Where')
  await expect(where).toContainText('the quay')
  await expect(where.getByTestId('typed-dimmed')).toHaveText('you typed: the harbour', {
    timeout: 15_000
  })
  await panel.getByRole('tab', { name: 'This scene' }).click()
  const conflict = panel
    .getByTestId('detail-conflict')
    .filter({ hasText: '1.1: the text says the quay; you typed the harbour' })
  await expect(conflict).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByTestId('needs-a-look-badge')).toBeVisible()
  await conflict.getByRole('button', { name: 'Keep mine' }).click()
  await expect(conflict).toHaveCount(0)
  await expect(
    panel.getByRole('button', { name: `Dismissed (${dismissedBefore + 1})` })
  ).toBeVisible()

  // Settings › AI in v2: the one reading switch, the idle minutes, no Summarize all scenes.
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('Control+,')
  await expect(settingsDialog).toBeVisible()
  await settingsDialog.getByRole('tab', { name: 'AI' }).click()
  await expect(settingsDialog.getByRole('checkbox', { name: 'Story memory reading' })).toBeChecked()
  await expect(settingsDialog.getByLabel('Read after a pause of (minutes)')).toHaveValue('3')
  await expect(settingsDialog.getByTestId('memory-health')).toBeVisible()
  await expect(settingsDialog.getByTestId('summarize-all')).toHaveCount(0)
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(settingsDialog).toHaveCount(0)

  // F-16.19: Rebuild memory from the Book tab: the price first, then the run, then the summary
  // grouped by sheet (Harbour 1 now states Mara's eyes: one new line for her).
  await invoke('document:save', {
    id: harbour.id,
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: "Mara's eyes were brown. The lamp 1 swung." }]
        }
      ]
    }
  })
  await panel.getByRole('tab', { name: 'Book' }).click()
  const readsBeforeRebuild = providerBodies.filter(isReader).length
  await panel.getByRole('button', { name: 'Rebuild memory…' }).click()
  const rebuild = page.getByRole('dialog', { name: 'Rebuild memory' })
  await expect(rebuild.getByTestId('rebuild-estimate')).toContainText(/^About .+ for \d+ scenes/)
  expect(providerBodies.filter(isReader)).toHaveLength(readsBeforeRebuild)
  await rebuild.getByRole('button', { name: 'Rebuild', exact: true }).click()
  const summary = rebuild.getByTestId('rebuild-summary')
  await expect(summary).toBeVisible({ timeout: 90_000 })
  await expect(summary).toContainText('Mara Vell: 1 new line')
  expect(providerBodies.filter(isReader).length).toBeGreaterThan(readsBeforeRebuild)
  await rebuild.getByRole('button', { name: 'Close' }).click()
  await expect(rebuild).toHaveCount(0)

  // F-16.18: an edit to a line's sentence dims it in True now once the save settles (the anchors
  // job's push), with no reading in between.
  await panel.getByRole('tab', { name: 'This scene' }).click()
  const quayLine = panel
    .getByRole('group', { name: 'True now: Mara Vell' })
    .getByTestId('claim-line')
    .filter({ hasText: 'Last seen at the quay' })
  await expect(quayLine).toBeVisible({ timeout: 15_000 })
  await expect(quayLine).not.toHaveAttribute('data-stale', 'true')
  const readsBeforeDim = providerBodies.filter(isReader).length
  await caretToEnd(editor)
  // Back over "The tide turned at noon." (24 characters), the paragraph break and the quay
  // sentence's full stop, then end that sentence otherwise.
  for (let i = 0; i < 26; i += 1) await page.keyboard.press('Backspace')
  await page.keyboard.type(' at last.')
  await expect
    .poll(async () => (await storedText(first.id)).replace(/’/g, "'"), { timeout: 15_000 })
    .toContain('She walked to the quay at last.')
  await expect(quayLine).toHaveAttribute('data-stale', 'true', { timeout: 15_000 })
  await expect(quayLine).toContainText('re-checking after you pause')
  expect(providerBodies.filter(isReader)).toHaveLength(readsBeforeDim)
})

test('story memory v2: card lines, plan links, synopsis and beta reader on cards (P2a slice 5)', async () => {
  // Continues with Use AI on, the own key at the fake, and Scene 1 read (its card line is "Mara
  // walks to the quay."). Plan links, synopsis and the beta reader are switched on for it.
  const isPlanPick = (body: (typeof providerBodies)[number]): boolean =>
    body.messages[0]?.content.startsWith(PLAN_LINKS_V2_SENTINEL) === true
  const settings = await invoke<AiSettings>('aiSettings:get', undefined)
  await invoke('aiSettings:set', {
    ...settings,
    features: { ...settings.features, planLinks: true, synopsis: true, betaReader: true }
  })
  const scenes = (await invoke<TreeNode[]>('tree:list', undefined)).filter(
    (n) => n.kind === 'document' && n.hierarchyLevel === 'scene'
  )
  const first = scenes[0]
  if (!first) throw new Error('no scene in the seed')

  // F-16.21: a planned scene (no words) with a synopsis, then a drafted scene whose card matches
  // it as closely as Scene 1's does, both made in the book tree; the second's text is typed.
  await showSection('Manuscript')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await bookTree.getByRole('treeitem', { name: 'Two', exact: true }).click()
  const renameBox = page.getByRole('textbox', { name: 'Rename' })
  const newScene = async (title: string): Promise<TreeNode> => {
    await page.getByRole('button', { name: 'New scene' }).click()
    await expect(renameBox).toBeFocused()
    await renameBox.fill(title)
    await renameBox.press('Enter')
    await expect(renameBox).toBeHidden()
    const made = (await invoke<TreeNode[]>('tree:list', undefined)).find((n) => n.title === title)
    if (!made) throw new Error(`${title} was not made`)
    return made
  }
  const plan = await newScene('Mara at the quay')
  const planMeta = await invoke<{ meta: Record<string, unknown> }>('sceneMeta:get', {
    id: plan.id
  })
  await invoke('sceneMeta:set', {
    id: plan.id,
    // Mara counts once (her record), so the plan's terms are quay, walk, wait, dusk and Mara:
    // Scene 1 holds 3 of 5, the dusk scene 4 of 5, too close for code (P2a slice 5 review).
    meta: { ...planMeta.meta, synopsis: 'She walks to the quay and waits at dusk.' }
  })
  const dusk = await newScene('Quay at dusk')
  const duskText = [
    'Mara waited at the quay at dusk.',
    'The ferry was late again, and the gulls had given up on the nets. She counted the lamps ' +
      'along the far wall twice, then a third time, and still the water lay flat and grey ' +
      'under the low cloud.'
  ]
  await bookTree.getByRole('treeitem', { name: 'Quay at dusk', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Document' })
  await clickIntoEditor(editor)
  await page.keyboard.type(duskText[0] ?? '')
  await page.keyboard.press('Enter')
  await page.keyboard.type(duskText[1] ?? '')
  await expect.poll(() => storedText(dusk.id), { timeout: 15_000 }).toContain('low cloud.')
  const picksBefore = providerBodies.filter(isPlanPick).length
  // The name scan of the new scene settles first (a save queues it), as it would while the
  // author writes; then its first reading.
  await expect
    .poll(async () => (await invoke<unknown[]>('names:forNode', { nodeId: dusk.id })).length, {
      timeout: 15_000
    })
    .toBeGreaterThan(0)
  await invoke('memory:readNow', { nodeId: dusk.id, requestId: 'e2e-read-dusk' })
  interface AiLink {
    planId: string
    sceneId: string
    origin: string
    reason: string
  }
  await expect
    .poll(
      async () =>
        (await invoke<{ aiLinks: AiLink[] }>('planLinks:get', undefined)).aiLinks.find(
          (link) => link.planId === plan.id
        ),
      { timeout: 15_000 }
    )
    .toEqual({ planId: plan.id, sceneId: dusk.id, origin: 'ai', reason: PLAN_LINK_WHY })
  const picks = providerBodies.filter(isPlanPick).slice(picksBefore)
  expect(picks).toHaveLength(1)
  expect(picks[0]?.json).toBe(true)
  expect(picks[0]?.messages.at(-1)?.content).toContain('Mara at the quay')
  expect(picks[0]?.messages.at(-1)?.content).toContain('Mara waits at the quay.')

  // F-16.20: the Outline shows Scene 1's card line, greyed behind the AI mark, where a synopsis
  // would be (no summary is read in v2).
  await showSection('Outline')
  const outline = page.getByRole('region', { name: 'Outline section', exact: true })
  // A row by its own title button (a plan line in another row names it too).
  const rowOf = (title: string): ReturnType<Page['getByTestId']> =>
    outline.getByTestId('outline-row').filter({
      has: page.locator('div').getByRole('button', { name: title, exact: true })
    })
  await expect(rowOf(first.title).getByTestId('outline-card-line')).toContainText(
    'Mara walks to the quay.',
    { timeout: 15_000 }
  )
  await expect(outline.getByTestId('outline-ai-summary')).toHaveCount(0)

  // F-16.21: the plan is fulfilled by the drafted scene, marked as the AI's, with its reason;
  // Unlink takes it off, sends the pair to Dismissed, and the plan reads Not yet drafted.
  const fulfilled = rowOf('Mara at the quay').getByTestId('outline-fulfilled')
  await expect(fulfilled).toContainText('Fulfilled by Quay at dusk', { timeout: 15_000 })
  await expect(fulfilled).toHaveAttribute('data-origin', 'ai')
  await expect(fulfilled).toContainText(PLAN_LINK_WHY)
  await expect(rowOf('Quay at dusk').getByTestId('outline-fulfils')).toContainText(
    'Fulfils plan Mara at the quay'
  )
  const dismissedBefore = (await invoke<{ count: number }>('dismissed:list', undefined)).count
  await fulfilled.getByRole('button', { name: 'Unlink' }).click()
  await expect(fulfilled).toHaveCount(0)
  await expect(rowOf('Mara at the quay').getByTestId('outline-not-drafted')).toHaveText(
    'Not yet drafted'
  )
  const dismissed = await invoke<{ count: number; items: { kind: string; label: string }[] }>(
    'dismissed:list',
    undefined
  )
  expect(dismissed.count).toBe(dismissedBefore + 1)
  expect(dismissed.items).toContainEqual(
    expect.objectContaining({
      kind: 'unlink',
      label: 'Plan link: Mara at the quay fulfilled by Quay at dusk'
    })
  )
  expect((await invoke<{ aiLinks: AiLink[] }>('planLinks:get', undefined)).aiLinks).toEqual([])

  // F-16.20: a synopsis suggestion sends synopsis.v2 with the scene's card and no stored summary.
  const opens = (opening: string) => (body: (typeof providerBodies)[number]) =>
    body.messages[0]?.content.startsWith(opening) === true
  const synopsesBefore = providerBodies.filter(opens(SYNOPSIS_V2_SENTINEL)).length
  const synopsis = await invoke<{ ok: boolean }>('ai:suggestSynopsis', {
    nodeId: dusk.id,
    requestId: 'e2e-synopsis-v2'
  })
  expect(synopsis).toMatchObject({ ok: true })
  const synopses = providerBodies.filter(opens(SYNOPSIS_V2_SENTINEL))
  expect(synopses).toHaveLength(synopsesBefore + 1)
  const synopsisBody = synopses.at(-1)
  const synopsisUser = synopsisBody?.messages.at(-1)?.content ?? ''
  expect(synopsisUser).toContain("Scene card (the AI's map of this scene, not quotable):")
  expect(synopsisUser).toContain('Mara waits at the quay.')
  expect(synopsisUser).not.toContain('Stored summary')

  // F-16.20: the beta reader reads the earlier scenes as their card gists under the map heading,
  // never their summaries, and this scene in full.
  const beta = await invoke<{ ok: boolean }>('ai:betaReader', {
    nodeId: dusk.id,
    requestId: 'e2e-beta-v2'
  })
  expect(beta).toMatchObject({ ok: true })
  const betaBody = providerBodies.filter(opens(BETA_READER_OPENING)).at(-1)
  const betaUser = betaBody?.messages.at(-1)?.content ?? ''
  expect(betaUser).toContain(BETA_READER_MAP_HEADING)
  expect(betaUser).toContain('Mara walks to the quay.')
  expect(betaUser).toContain(duskText[1])
  expect(betaUser).not.toContain('Scenes read so far, in order (summaries)')

  // F-16.21 (slice 5 review): Undo of the Unlink in Dismissed puts the AI's link back, pushed to
  // the open Outline; Keep makes it the author's own link.
  const unlinked = (
    await invoke<{ items: { id: string; kind: string; label: string }[] }>(
      'dismissed:list',
      undefined
    )
  ).items.find((item) => item.kind === 'unlink')
  if (!unlinked) throw new Error('the Unlink row is missing from Dismissed')
  await invoke('dismissed:undo', { id: unlinked.id })
  await expect(fulfilled).toContainText('Fulfilled by Quay at dusk', { timeout: 15_000 })
  await expect(fulfilled).toHaveAttribute('data-origin', 'ai')
  await expect(fulfilled).toContainText(PLAN_LINK_WHY)
  expect((await invoke<{ count: number }>('dismissed:list', undefined)).count).toBe(dismissedBefore)
  await fulfilled.getByRole('button', { name: 'Keep' }).click()
  await expect(fulfilled).toHaveAttribute('data-origin', 'author', { timeout: 15_000 })
  await expect(fulfilled.getByRole('button', { name: 'Keep' })).toHaveCount(0)
  expect((await invoke<{ aiLinks: AiLink[] }>('planLinks:get', undefined)).aiLinks).toEqual([])
  const kept = await invoke<{ meta: { fulfilledBy?: string } }>('sceneMeta:get', { id: plan.id })
  expect(kept.meta.fulfilledBy).toBe(dusk.id)
})

test('story memory v2: who knows what and threads are read (P2b slice 2)', async () => {
  // Continues with Use AI on and the own key at the fake. Two characters of their own (so no
  // earlier record's name or nickname is near them), two new scenes, each read with Read now.
  const isReader = (body: (typeof providerBodies)[number]): boolean =>
    body.messages[0]?.content.startsWith(READER_SENTINEL) === true
  const isVerify = (body: (typeof providerBodies)[number]): boolean =>
    body.messages[0]?.content.startsWith(VERIFY_SENTINEL) === true
  const made: Record<string, string> = {}
  for (const name of ['Orrin', 'Bram']) {
    const result = await invoke<{ record?: { id: string } }>('record:create', {
      name,
      categoryId: 'character',
      aliases: [],
      force: true
    })
    made[name] = result.record?.id ?? ''
  }
  const mara = (await invoke<{ id: string; name: string }[]>('record:list', undefined)).find(
    (each) => each.name === 'Mara Vell'
  )?.id
  const first = (await invoke<TreeNode[]>('tree:list', undefined)).find(
    (n) => n.kind === 'document' && n.hierarchyLevel === 'scene'
  )
  if (!first || mara === undefined) throw new Error('no scene or no Mara in the project')
  const scene = async (title: string, text: string): Promise<string> => {
    const node = await invoke<TreeNode>('tree:create', {
      parentId: first.parentId,
      kind: 'document',
      hierarchyLevel: 'scene',
      title
    })
    await invoke('document:save', {
      id: node.id,
      content: {
        type: 'doc',
        content: text
          .split('\n')
          .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
      }
    })
    return node.id
  }
  interface SceneClaim {
    slot: string
    recordId: string | null
    objectId: string | null
    how: string | null
    fromId: string | null
  }
  interface Rec {
    id: string
    name: string
    kind: string
    origin: string
  }
  const topicsNow = async (): Promise<Rec[]> =>
    (await invoke<Rec[]>('record:list', undefined)).filter(
      (each) => each.kind === 'secret' || each.kind === 'thread'
    )

  // Scene 1: a secret sold, overheard, and a thread sworn.
  const one = await scene(
    'Secrets 1',
    'Bram sold the map.\nOrrin overheard Bram.\nMara swore to find the heir.'
  )
  const before = providerBodies.length
  expect(await invoke('memory:readNow', { nodeId: one, requestId: 'e2e-p2b-1' })).toMatchObject({
    ok: true,
    read: true
  })
  const firstReader = providerBodies.slice(before).find(isReader)
  expect(firstReader?.messages[0]?.content).toContain('Secrets and threads (id label · kind):')
  const claims = (await invoke<{ claims: SceneClaim[] }>('memory:scene', { nodeId: one })).claims
  const topics = await topicsNow()
  const map = topics.find((each) => each.name === 'the sold map')
  const heir = topics.find((each) => each.name === 'the missing heir')
  expect(topics.map((each) => [each.name, each.kind, each.origin]).sort()).toEqual([
    ['the missing heir', 'thread', 'ai'],
    ['the sold map', 'secret', 'ai']
  ])
  const knows = claims
    .filter((claim) => claim.slot === 'knows')
    .map((claim) => [claim.recordId, claim.objectId, claim.how, claim.fromId])
  expect(knows).toContainEqual([made.Bram, map?.id, 'knewBefore', null])
  expect(knows).toContainEqual([made.Orrin, map?.id, 'overheard', made.Bram])
  expect(
    claims.filter((claim) => claim.slot === 'thread').map((claim) => [claim.recordId, claim.how])
  ).toEqual([[heir?.id, 'opens']])
  // Secrets and threads are not names: no mention of either anywhere.
  const named = await invoke<{ recordId: string }[]>('names:byRecord', undefined)
  expect(named.some((row) => row.recordId === map?.id || row.recordId === heir?.id)).toBe(false)

  // Scene 2: the planted duplicate is judged the same and merged; the thread resolves.
  const two = await scene('Secrets 2', 'The map had been sold by Bram.\nMara found the heir.')
  const beforeTwo = providerBodies.length
  expect(await invoke('memory:readNow', { nodeId: two, requestId: 'e2e-p2b-2' })).toMatchObject({
    ok: true,
    read: true
  })
  const secondReader = providerBodies.slice(beforeTwo).find(isReader)
  const system = secondReader?.messages[0]?.content ?? ''
  expect(system).toMatch(/^s\d+ the sold map · secret$/m)
  expect(system).toMatch(/^t\d+ the missing heir · thread$/m)
  const check = providerBodies.slice(beforeTwo).find(isVerify)
  expect(check?.messages.at(-1)?.content).toMatch(/^\d+\. Same: x3 the map sale: /m)
  expect((await topicsNow()).filter((each) => each.kind === 'secret')).toHaveLength(1)
  const steps = (await invoke<{ claims: SceneClaim[] }>('memory:scene', { nodeId: two })).claims
    .filter((claim) => claim.slot === 'thread')
    .map((claim) => [claim.recordId, claim.how])
  expect(steps).toEqual([[heir?.id, 'resolves']])

  // Absence is never sent: no request ever carried a scoped "no scene shows" line.
  expect(
    providerBodies.some((body) =>
      body.messages.some((message) => message.content.includes('No scene shows'))
    )
  ).toBe(false)
})

test('story memory v2: who knows what in the panel, the grid and sheets (P2b slice 4)', async () => {
  // A new project (Use AI on, the wizard's default; the own key at the fake), so its scenes are
  // 1.1, 1.2 and 1.3 and "checked up to" counts from the book's first scene.
  const first = await newV2Project('Knows Novel')

  // Mara (the POV of every scene), Orrin and Tomas; three scenes, each read once.
  const ids: Record<string, string> = {}
  for (const name of ['Mara', 'Orrin', 'Tomas']) {
    const result = await invoke<{ record?: { id: string } }>('record:create', {
      name,
      categoryId: 'character',
      aliases: [],
      force: true
    })
    ids[name] = result.record?.id ?? ''
  }
  const mara = ids.Mara ?? ''
  // A Pinned line, so the ghost text's Story notes block has something to carry.
  await invoke('record:savePage', {
    id: mara,
    page: 'pinned',
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Eyes: grey' }] }]
    }
  })
  const write = async (id: string, text: string): Promise<void> => {
    await invoke('document:save', {
      id,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
    })
    await invoke('sceneDetail:set', {
      nodeId: id,
      details: {
        povRecordId: mara,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: null,
        alsoHere: []
      }
    })
  }
  const scene = async (title: string, text: string): Promise<string> => {
    const node = await invoke<TreeNode>('tree:create', {
      parentId: first.parentId,
      kind: 'document',
      hierarchyLevel: 'scene',
      title
    })
    await write(node.id, text)
    return node.id
  }
  await write(first.id, 'Mara watched from the stair. Tomas sold the map. Orrin overheard Tomas.')
  const quay = await scene('Quay', 'Mara waited at the quay.')
  const sale = await scene('Sale', 'The map had been sold by Tomas.')
  for (const [i, nodeId] of [first.id, quay, sale].entries()) {
    expect(await invoke('memory:readNow', { nodeId, requestId: `e2e-p2b4-${i}` })).toMatchObject({
      ok: true
    })
  }
  // The planted duplicate merged into the one secret.
  const secretsNow = async (): Promise<{ id: string; name: string }[]> =>
    (await invoke<{ id: string; name: string; kind: string }[]>('record:list', undefined)).filter(
      (each) => each.kind === 'secret'
    )
  await expect
    .poll(async () => (await secretsNow()).map((each) => each.name))
    .toEqual(['the sold map'])

  // Open it again, so the tree holds the scenes made above.
  await reopenProject('Knows Novel')

  // F-16.22: scene 1.1 shows the secret, its holders Here and, muted, Mara's scoped line.
  await showSection('Manuscript')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await bookTree.getByRole('treeitem', { name: first.title }).first().click()
  const panel = page.getByTestId('this-scene-panel')
  if ((await panel.count()) === 0) {
    await page.getByRole('button', { name: 'This scene', exact: true }).click()
  }
  await panel.getByRole('tab', { name: 'This scene' }).click()
  const who = panel.getByRole('region', { name: 'Who knows what' })
  const map = who.getByRole('group', { name: 'Who knows the sold map' })
  await expect(map).toBeVisible({ timeout: 15_000 })
  await expect(map.getByTestId('readers-since')).toHaveText('readers since 1.1')
  await expect(
    map.getByTestId('claim-line').filter({ hasText: 'Orrin: overheard from Tomas (1.1)' })
  ).toBeVisible()
  await expect(
    map.getByTestId('claim-line').filter({ hasText: 'Tomas: knew before (1.1)' })
  ).toBeVisible()
  await expect(map.getByTestId('absence-line')).toHaveText(
    'No scene shows Mara learning this (checked up to 1.1)'
  )

  // Scene 1.2: the POV's tension line, and "+ 1 more in Book" opens the grid.
  await bookTree.getByRole('treeitem', { name: 'Quay', exact: true }).click()
  const tension = who.getByTestId('tension-line')
  await expect(tension).toHaveText(
    'Readers know the sold map (since 1.1); no scene shows Mara (POV) learning it (checked up to 1.2)',
    { timeout: 15_000 }
  )
  await who.getByRole('button', { name: '+ 1 more in Book' }).click()
  await expect(panel.getByRole('tab', { name: 'Book' })).toHaveAttribute('aria-selected', 'true')
  const grid = panel.getByTestId('knows-grid')
  const maraCell = grid.getByRole('button', {
    name: 'Mara, the sold map: No scene shows Mara learning this (checked up to 1.2)'
  })
  await expect(maraCell).toHaveText('—', { timeout: 15_000 })
  await maraCell.click()
  await grid
    .getByTestId('knows-cell-detail')
    .getByRole('button', { name: 'Knew before the book' })
    .click()
  await expect(
    grid.getByRole('button', { name: 'Mara, the sold map: knew before the book (you)' })
  ).toBeVisible({ timeout: 15_000 })
  // The tension line goes: she knew it before the book.
  await panel.getByRole('tab', { name: 'This scene' }).click()
  await expect(panel.getByTestId('tension-line')).toHaveCount(0, { timeout: 15_000 })

  // The secret's sheet lists the reveal merged into it from 1.3; Split makes it a secret of its
  // own, and the split goes to Dismissed.
  const dismissedBefore = (await invoke<{ count: number }>('dismissed:list', undefined)).count
  await panel.getByRole('tab', { name: 'Book' }).click()
  await grid.getByRole('button', { name: 'the sold map', exact: true }).click()
  const sheet = page.getByTestId('record-sheet')
  const theSecret = sheet.getByRole('region', { name: 'The secret' })
  await expect(theSecret.getByTestId('topic-reveal').nth(1)).toContainText(
    'also read as “the map sale” in 1.3: merged into this secret',
    { timeout: 15_000 }
  )
  await theSecret.getByRole('button', { name: 'Split “the map sale” off' }).click()
  const secretsList = page.getByRole('list', { name: 'Secrets' })
  await expect(secretsList.getByRole('listitem')).toHaveCount(2, { timeout: 15_000 })
  await expect(
    panel.getByRole('button', { name: `Dismissed (${dismissedBefore + 1})` })
  ).toBeVisible({ timeout: 15_000 })

  // Not a secret on the split one takes it away; Undo in Dismissed brings it back.
  await secretsList.getByRole('button', { name: /^the map sale/ }).click()
  await sheet
    .getByRole('region', { name: 'The secret' })
    .getByRole('button', { name: 'Not a secret' })
    .click()
  await expect(secretsList.getByRole('listitem')).toHaveCount(1, { timeout: 15_000 })
  const dismissedButton = panel.getByRole('button', { name: `Dismissed (${dismissedBefore + 2})` })
  await expect(dismissedButton).toBeVisible({ timeout: 15_000 })
  await dismissedButton.click()
  const dismissedDialog = page.getByRole('dialog', { name: /^Dismissed \(/ })
  await dismissedDialog.getByRole('button', { name: 'Undo: Not a secret: the map sale' }).click()
  await expect(dismissedDialog.getByRole('heading')).toHaveText(
    `Dismissed (${dismissedBefore + 1})`
  )
  await dismissedDialog.getByRole('button', { name: 'Close' }).click()
  await expect(secretsList.getByRole('listitem')).toHaveCount(2, { timeout: 15_000 })

  // Ghost text in 1.2: its Story notes block carries no absence and no who-knows-what line.
  await showSection('Manuscript')
  await bookTree.getByRole('treeitem', { name: 'Quay', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Document' })
  const vibeWrite = page.getByRole('button', { name: 'VibeWrite' })
  await expect(vibeWrite).toBeEnabled()
  if ((await vibeWrite.getAttribute('aria-pressed')) !== 'true') await vibeWrite.click()
  await expect(vibeWrite).toHaveAttribute('aria-pressed', 'true')
  const ghostsBefore = providerBodies.filter((body) => !body.json).length
  await caretToEnd(editor)
  await page.keyboard.type(' Mara looked back at the stair.')
  await expect(editor.locator('.ghost-text')).toHaveText(GHOST_ANSWER, { timeout: 15_000 })
  const ghost = providerBodies
    .filter((body) => !body.json)
    .slice(ghostsBefore)
    .at(-1)
  const ghostText = ghost?.messages.map((message) => message.content).join('\n') ?? ''
  expect(ghostText).toContain(STORY_NOTES_HEADING)
  expect(ghostText).toContain('Eyes: grey')
  expect(ghostText).not.toContain('No scene shows')
  expect(ghostText).not.toContain('checked up to')
  expect(ghostText).not.toContain('the sold map')
  expect(ghostText).not.toMatch(/knew before|overheard/i)
})

test('story memory v2: threads, the timeline and ages (P2b slice 5)', async () => {
  // A new project (Use AI on, the own key at the fake): scenes 1.1–1.3, Mara the POV of each.
  const first = await newV2Project('Time Novel')
  const made = await invoke<{ record?: { id: string } }>('record:create', {
    name: 'Mara',
    categoryId: 'character',
    aliases: [],
    force: true
  })
  const mara = made.record?.id ?? ''
  const write = async (id: string, text: string, storyYear: number | null): Promise<void> => {
    await invoke('document:save', {
      id,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
    })
    await invoke('sceneDetail:set', {
      nodeId: id,
      details: {
        povRecordId: mara,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear,
        alsoHere: []
      }
    })
  }
  const scene = async (title: string, text: string): Promise<string> => {
    const node = await invoke<TreeNode>('tree:create', {
      parentId: first.parentId,
      kind: 'document',
      hierarchyLevel: 'scene',
      title
    })
    await write(node.id, text, null)
    return node.id
  }
  await write(first.id, 'Mara was born in 1792. Mara swore to find the heir.', 1811)
  const nineteen = await scene('Nineteen', 'Mara was nineteen.')
  const heir = await scene('Heir', `${ELAPSED_HINT}, Mara found the heir.`)
  for (const [i, nodeId] of [first.id, nineteen, heir].entries()) {
    expect(await invoke('memory:readNow', { nodeId, requestId: `e2e-p2b5-${i}` })).toMatchObject({
      ok: true
    })
  }
  await reopenProject('Time Novel')

  // Book › Threads as of 1.3 (the open scene): resolved, with its two steps.
  await showSection('Manuscript')
  const bookTree = page.getByRole('tree', { name: 'Document tree' })
  await bookTree.getByRole('treeitem', { name: 'Heir', exact: true }).click()
  const panel = page.getByTestId('this-scene-panel')
  if ((await panel.count()) === 0) {
    await page.getByRole('button', { name: 'This scene', exact: true }).click()
  }
  await panel.getByRole('tab', { name: 'Book' }).click()
  const thread = panel.getByRole('group', { name: 'Thread: the missing heir' })
  await expect(thread.getByTestId('thread-head')).toHaveText('the missing heir · resolved in 1.3', {
    timeout: 15_000
  })
  await expect(thread.getByTestId('claim-line')).toHaveCount(2)
  await expect(thread.getByTestId('claim-line').first()).toContainText(
    'opens 1.1: swears to find the heir'
  )
  await expect(thread.getByTestId('claim-line').nth(1)).toContainText(
    'resolves 1.3: finds the heir'
  )

  // Book › Timeline: the typed year, carried, then ended by the hint; Mara about 19 in 1.1 and 1.2.
  const timeline = panel.getByTestId('timeline')
  const row = (name: string) => timeline.getByRole('listitem', { name })
  await expect(row(`1.1 ${first.title}`).getByTestId('timeline-year')).toHaveText('1811', {
    timeout: 15_000
  })
  await expect(row('1.2 Nineteen').getByTestId('timeline-year')).toHaveText('1811 · from 1.1')
  await expect(row('1.3 Heir').getByTestId('timeline-year')).toHaveText(
    `year not known since “${ELAPSED_HINT}” (1.3)`
  )
  await expect(row(`1.1 ${first.title}`).getByTestId('timeline-age')).toContainText('Mara about 19')
  await expect(row('1.2 Nineteen').getByTestId('timeline-age')).toContainText('Mara about 19')

  // Mara's sheet: her Age as of 1.2 counts from the year; as of 1.3 the last stated age stands,
  // with the hint since listed and never added up.
  await panel.getByRole('region', { name: 'Cast' }).getByRole('button', { name: /^Mara/ }).click()
  const sheet = page.getByTestId('record-sheet')
  const age = sheet.getByRole('region', { name: 'Age' })
  await age.getByRole('combobox', { name: 'as of' }).selectOption(nineteen)
  await expect(age.getByTestId('age-line')).toHaveText('about 19 · year from 1.1', {
    timeout: 15_000
  })
  await expect(age.getByTestId('claim-line')).toContainText('Born: 1792')
  await age.getByRole('combobox', { name: 'as of' }).selectOption(heir)
  await expect(age.getByTestId('age-line')).toHaveText(
    `19, stated in 1.2 · since then: “${ELAPSED_HINT}” (1.3)`,
    { timeout: 15_000 }
  )
  // Her Threads: the steps whose paragraph names her.
  await expect(
    sheet
      .getByRole('region', { name: 'Threads' })
      .getByRole('group', { name: 'Thread: the missing heir' })
  ).toBeVisible()

  // Typing 1814 as 1.3's story year: its row reads 1814, and Mara about 22 there.
  await showSection('Manuscript')
  await bookTree.getByRole('treeitem', { name: 'Heir', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  const notesColumn = page.getByTestId('notes-panel')
  if ((await notesColumn.count()) === 0) {
    await page.getByRole('button', { name: 'Notes', exact: true }).click()
  }
  const detailsToggle = notesColumn.getByRole('button', { name: 'Scene details' })
  if ((await detailsToggle.getAttribute('aria-expanded')) !== 'true') await detailsToggle.click()
  const storyYear = notesColumn
    .getByRole('group', { name: 'Scene metadata' })
    .getByRole('textbox', { name: 'Story year' })
  await storyYear.fill('1814')
  await storyYear.press('Enter')
  await panel.getByRole('tab', { name: 'Book' }).click()
  await expect(row('1.3 Heir').getByTestId('timeline-year')).toHaveText('1814', {
    timeout: 15_000
  })
  await expect(row('1.3 Heir').getByTestId('timeline-age')).toContainText('Mara about 22')
  await expect(timeline).not.toContainText(ELAPSED_VALUE)

  // Moving 1.3 before 1.2 with the Timeline open: the rows follow the book's new order at once,
  // and the typed 1814 now carries into the scene after it.
  await invoke<TreeNode>('tree:move', { id: heir, parentId: first.parentId, afterId: first.id })
  await expect(row('1.2 Heir').getByTestId('timeline-year')).toHaveText('1814', {
    timeout: 15_000
  })
  await expect(row('1.3 Nineteen').getByTestId('timeline-year')).toHaveText('1814 · from 1.2')
  // Nothing about years or threads was sent anywhere: all of it is local.
  expect(
    providerBodies.some((body) =>
      body.messages.some((message) => message.content.includes('year not known'))
    )
  ).toBe(false)
})

/** A record's page paragraphs as stored, each with its `aiWritten` mark (F-16.26). */
async function pageLines(
  id: string,
  page: 'pinned' | 'ideas'
): Promise<{ text: string; written: boolean }[]> {
  const record = await invoke<{ pinned: TiptapNodeT | null; ideas: TiptapNodeT | null }>(
    'record:get',
    { id }
  )
  return ((page === 'pinned' ? record.pinned : record.ideas)?.content ?? []).map((block) => ({
    text: (block.content ?? []).map((child) => child.text ?? '').join(''),
    written: block.attrs?.aiWritten !== null && block.attrs?.aiWritten !== undefined
  }))
}

test('story memory v2: Ms Scribe v9 answers and writes sheet lines (P3 slice 2)', async () => {
  // A new project (Use AI on, chat in Ask, the own key at the fake): Mara, Orrin and Tomas, and
  // scene 1.1 read once.
  const first = await newV2Project('Scribe Novel')
  const ids: Record<string, string> = {}
  for (const name of ['Mara', 'Orrin', 'Tomas']) {
    const result = await invoke<{ record?: { id: string } }>('record:create', {
      name,
      categoryId: 'character',
      aliases: [],
      force: true
    })
    ids[name] = result.record?.id ?? ''
  }
  const mara = ids.Mara ?? ''
  await invoke('document:save', {
    id: first.id,
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Mara watched the quay. Tomas sold the map. Orrin overheard Tomas.'
            }
          ]
        }
      ]
    }
  })
  expect(await invoke('memory:readNow', { nodeId: first.id, requestId: 'e2e-p3-1' })).toMatchObject(
    { ok: true }
  )
  await reopenProject('Scribe Novel')
  await showSection('Manuscript')
  await page
    .getByRole('tree', { name: 'Document tree' })
    .getByRole('treeitem', { name: first.title })
    .first()
    .click()
  await expect(page.getByRole('textbox', { name: 'Document' })).toContainText('Orrin overheard')

  const scribeButton = page.getByRole('button', { name: 'Ms Scribe', exact: true })
  if ((await scribeButton.getAttribute('aria-pressed')) !== 'true') await scribeButton.click()
  const assistant = page.getByTestId('assistant-panel')
  await expect(assistant).toBeVisible()
  const messageBox = assistant.getByRole('textbox', { name: 'Message' })
  const turns = assistant.locator('[data-testid="chat-turn"]')
  const scribeBodies = (): typeof providerBodies =>
    providerBodies.filter((body) => body.messages[0]?.content.startsWith(SCRIBE_SENTINEL) === true)
  const send = async (mode: 'Auto' | 'Ask' | 'Plan', message: string): Promise<void> => {
    await assistant.getByRole('radio', { name: mode, exact: true }).click()
    await messageBox.fill(message)
    await messageBox.press('Enter')
  }

  // Ask, a question: one agent.v9 request (after the router's), the whole open scene as E0
  // numbered, no tool protocol; the kept citation's quote is the one E0 holds.
  const before = scribeBodies().length
  await send('Ask', 'What did Orrin hear?')
  await expect(turns).toHaveCount(2)
  await expect(turns.nth(1)).toContainText('Orrin overheard Tomas.', { timeout: 15_000 })
  expect(scribeBodies()).toHaveLength(before + 1)
  const asked = scribeBodies().at(-1)
  const tail = asked?.messages.at(-1)?.content ?? ''
  expect(tail).toContain('E0 [happened, the open scene 1.1, id ')
  expect(tail).toContain('¶0 Mara watched the quay. Tomas sold the map. Orrin overheard Tomas.')
  expect(tail.endsWith('Question: What did Orrin hear?')).toBe(true)
  expect(tail).not.toContain('"tool"')
  expect(asked?.json).toBe(true)
  expect(
    providerBodies
      .slice(-2)
      .map((body) => body.messages[0]?.content.startsWith(ROUTE_V2_SENTINEL) === true)
  ).toEqual([true, false])
  const stored = async (): Promise<
    { role: string; scribe: { citations: { quote: string; evidence: string }[] } | null }[]
  > => {
    const value = await invoke<{
      active: string | null
      items: {
        id: string
        messages: {
          role: string
          scribe: { citations: { quote: string; evidence: string }[] } | null
        }[]
      }[]
    }>('conversations:get', undefined)
    return value.items.find((item) => item.id === value.active)?.messages ?? []
  }
  await expect
    .poll(async () => (await stored()).at(-1)?.scribe?.citations ?? [])
    .toEqual([expect.objectContaining({ evidence: 'E0', quote: 'Orrin overheard Tomas' })])

  // Auto, an explicit sheet write: the line lands on Mara's Pinned with the chat's mark, the
  // turn says so with Undo, and Undo takes it out.
  await send('Auto', "Add to Mara's sheet that she hates the sea.")
  await expect(turns).toHaveCount(4)
  const pinned = turns.nth(3).getByTestId('agent-change')
  await expect(pinned).toHaveAttribute('data-status', 'applied', { timeout: 15_000 })
  await expect(pinned).toContainText('Pinned on Mara’s sheet: “Hates the sea”')
  await expect
    .poll(() => pageLines(mara, 'pinned'))
    .toEqual([{ text: 'Hates the sea', written: true }])
  await pinned.getByTestId('agent-change-undo').click()
  await expect(pinned).toHaveAttribute('data-status', 'undone')
  await expect.poll(() => pageLines(mara, 'pinned')).toEqual([])

  // Ask, a save Ms Scribe cannot place: "Is this an idea or canon?"; Idea files it in Ideas.
  await send('Ask', 'Save this for Mara: a scar from the fire.')
  await expect(turns).toHaveCount(6)
  const question = turns.nth(5).getByTestId('agent-change')
  await expect(question).toContainText('Is this an idea or canon?', { timeout: 15_000 })
  await question.getByRole('button', { name: 'Idea' }).click()
  await expect(question).toHaveAttribute('data-status', 'applied')
  await expect(question).toContainText('Added to Mara’s Ideas: “A scar from the fire”')
  await expect
    .poll(() => pageLines(mara, 'ideas'))
    .toEqual([{ text: 'A scar from the fire', written: true }])

  // Plan: the same request goes out without the edit list, and nothing is written.
  const planBefore = scribeBodies().length
  await send('Plan', "Add to Mara's sheet that she hates the sea.")
  await expect(turns).toHaveCount(8)
  await expect(turns.nth(7)).toContainText('I put that on Mara', { timeout: 15_000 })
  expect(scribeBodies()).toHaveLength(planBefore + 1)
  expect(scribeBodies().at(-1)?.messages[0]?.content).not.toContain(SCRIBE_EDITS_OPENING)
  await expect(turns.nth(7).getByTestId('agent-change')).toHaveCount(0)
  expect(await pageLines(mara, 'pinned')).toEqual([])
  // The write runs carried the edit list; no request ever stated an absence.
  expect(
    scribeBodies().some((body) => body.messages[0]?.content.includes(SCRIBE_EDITS_OPENING))
  ).toBe(true)
  expect(
    providerBodies.some((body) =>
      body.messages.some((message) => message.content.includes('No scene shows'))
    )
  ).toBe(false)
})

test('story memory: the switch-over on a copy of a v1 project (P1 slice 6)', async () => {
  // A second launch without the override, with its own app data: new projects run v1.
  if (!exited) await app.close()
  app = await electron.launch({
    args: ['.'],
    env: { ...baseEnv, MYTHSCRIBE_USER_DATA: path.join(tmp, 'userData-v1') }
  })
  exited = false
  app.on('close', () => {
    exited = true
  })
  page = await app.firstWindow()

  const projectPath = path.join(tmp, 'Switch Novel.mythscribe')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath })
  }, projectPath)
  await page.getByRole('button', { name: 'New project' }).click()
  const wizard = page.getByRole('dialog')
  await wizard.getByRole('textbox', { name: 'Project name' }).fill('Switch Novel')
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByText('Off', { exact: true }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Switch Novel')
  expect((await invoke<ProjectInfo | null>('project:current', undefined))?.storyMemory).toBe('v1')

  // A character tag, made in the Index, typed inline through the `#` suggestion.
  await showSection('Index')
  const tagsPanel = page.getByRole('region', { name: 'Index section', exact: true })
  await tagsPanel
    .getByRole('tablist', { name: 'Tag categories' })
    .getByRole('tab', { name: 'Characters' })
    .click()
  const tagForm = tagsPanel.getByRole('form', { name: 'New tag' })
  await tagForm.getByRole('textbox', { name: 'Tag name' }).fill('mara')
  await tagForm.getByRole('button', { name: 'Create tag' }).click()
  await showSection('Manuscript')
  const scene = (await invoke<TreeNode[]>('tree:list', undefined)).find(
    (n) => n.hierarchyLevel === 'scene'
  )
  if (scene === undefined) throw new Error('the new project has no scene')
  await page
    .getByRole('tree', { name: 'Document tree' })
    .getByText(scene.title, { exact: true })
    .click()
  const editor = page.getByRole('textbox', { name: 'Document' })
  await clickIntoEditor(editor)
  await page.keyboard.type('Then #mar')
  const suggestions = page.getByRole('listbox', { name: 'Tag suggestions' })
  await expect(suggestions.getByRole('option').first()).toHaveText('mara')
  await page.keyboard.press('Tab')
  await page.keyboard.type('left.')
  await expect(editor.locator('[data-inline-tag]')).toHaveText(['#mara'])
  const storedText = async (): Promise<string> =>
    JSON.stringify(
      (await invoke<{ content: TiptapNodeT | null }>('document:get', { id: scene.id })).content
    )
  await expect.poll(storedText).toContain('left.')
  expect(await storedText()).toContain('inlineTag')

  // Help › Try the story-memory switch-over on a copy…: the dry run lists the tag as a record.
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'Help' })
    .click()
  await page
    .getByRole('menu', { name: 'Help' })
    .getByRole('menuitem', { name: 'Try the story-memory switch-over on a copy…' })
    .click()
  const dryRun = page.getByRole('dialog', { name: 'Switch-over dry run' })
  // (A character tag arrives with its sheet in v1, F-9.12, so the record comes from both.)
  await expect(dryRun.getByRole('list', { name: 'Converted' })).toContainText(
    'Mara: Record (character): from its sheet and tag.'
  )
  await dryRun.getByRole('button', { name: 'Next' }).click()

  // The consent screen: the replacement (the record's name), edited to other words.
  const replacement = page.getByRole('textbox', { name: 'Replacement for #mara' })
  await expect(replacement).toHaveValue('Mara')
  await replacement.fill('Mara of the Reef')
  await page.getByRole('button', { name: 'Convert' }).click()
  const done = page.getByRole('dialog', { name: 'Switched over' })
  await expect(done).toBeVisible({ timeout: 15_000 })

  // The copy opens on v2: the edited words in the scene, and a Mara record.
  const copy = await invoke<ProjectInfo | null>('project:current', undefined)
  expect(copy?.storyMemory).toBe('v2')
  expect(path.basename(copy?.path ?? '')).toMatch(
    /^Switch Novel \(story memory test \d{4}-\d\d-\d\d \d{4}\)\.mythscribe$/
  )
  const converted = await storedText()
  expect(converted).not.toContain('inlineTag')
  expect(converted).toContain('Then Mara of the Reef left.')
  expect((await invoke<{ name: string }[]>('record:list', undefined)).map((r) => r.name)).toEqual([
    'Mara'
  ])
  await done.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(done).toHaveCount(0)
  await page
    .getByRole('tree', { name: 'Document tree' })
    .getByText(scene.title, { exact: true })
    .click()
  await expect(editor).toContainText('Then Mara of the Reef left.')
  await expect(editor.locator('[data-inline-tag]')).toHaveCount(0)

  // The original reopens (File › Open project…) as v1, its inline tag as it was.
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] })
  }, projectPath)
  await page
    .getByRole('menubar', { name: 'Application menu' })
    .getByRole('menuitem', { name: 'File' })
    .click()
  await page
    .getByRole('menu', { name: 'File' })
    .getByRole('menuitem', { name: 'Open project…' })
    .click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByTestId('project-name')).toHaveText('Switch Novel')
  const original = await invoke<ProjectInfo | null>('project:current', undefined)
  expect(original?.path).toBe(projectPath)
  expect(original?.storyMemory).toBe('v1')
  expect(await storedText()).toContain('inlineTag')
  await page
    .getByRole('tree', { name: 'Document tree' })
    .getByText(scene.title, { exact: true })
    .click()
  await expect(editor.locator('[data-inline-tag]')).toHaveText(['#mara'])
})
