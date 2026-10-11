# Story memory: the final design plan

## Decisions (2026-10-11)

**Approved by the author on 2026-10-11: build it.** The author took the recommended default on decisions 1, 2 and 4–8 (Part 6) and changed decision 3:

- **Decision 3, as changed by the author.** When the author explicitly asks Ms Scribe to put something on a sheet ("add this to Mara's sheet"), it goes there (Pinned) with a quick confirmation and an Undo. When Ms Scribe cannot tell from context whether it is canon or an idea, it asks "Is this an idea or canon?" as a two-choice quick question. The recommended default it replaces was "into Ideas unless she says pin it". §2.2 and §2.6 below are amended to match.
- Decision 8 (from the plan doc's decisions table): sheet text the AI wrote before the switch-over is kept in a "Filed by AI earlier: please check" block marked Not canon (Part 3).
- The spec is `FEATURES.md` §2.16 (F-16.1–16.38) with milestones M8 (before launch) and M9 (after launch) in §6. Phase plans are in `plans/`; P0 is in progress (`plans/P0.md`).

*Written for the author's approval, 2026-10-11. This is the merged Evidence-first design, revised for all 4 blockers and 45 major issues from the red-team review. Part 6 lists the fixes that were changed rather than taken as written. Prices are list prices: V4 Flash $0.14 in / $0.28 out and V4 Pro $1.74 / $3.48 per million tokens. The prices in `src/shared/ai.ts` are wrong, and phase P0 checks the real ones.*

## What changes for you

1. You stop keeping your story bible. When you leave a scene or pause, the app reads what changed. From your prose it fills the sheets, who-knows-what, threads, the timeline and ages, and every line shows its quote.
2. Tags go. Names and nicknames take over their job. You keep a few labels you choose, such as tone, content warnings or "needs research".
3. One **This scene** panel and Ms Scribe replace five sections. A contradiction appears as a quiet entry plus a soft underline, never a pop-up.
4. Ms Scribe reads your whole open scene, finds moments by meaning, and either cites your book or says "not found".
5. Reading a whole novel once costs about 12¢, a writing session 1–2.5¢, and an open question about 2¢. Everything you wrote is kept; the AI rebuilds its own part.

# Part 1: For the author

## How it works day to day

**Opening a scene.** In chapter 14, scene 2, the panel shows:
- **Here:** Mara (POV), Orrin. **Mentioned:** Tomas.
- **True now:** "Mara's arm: bandaged, last stated in 13.4." "Tomas: at the harbour, last stated in 12.1."
- **Who knows what:** "Tomas sold the map. Orrin knows (overheard, 9.3). No scene shows Mara learning it (checked up to 14.2)."
- **Needs a look:** "Is 'Ry' Rynna Falsire?" You click Yes. Ignoring it is safe too.

Every line the AI wrote has **ⓘ** (the quote, where it came from, what it cost) and **Not right**.

**Writing.** Nothing is sent while you type. When you open another scene, or stop for three minutes, the app reads the paragraphs you changed plus the ones around them, for about a tenth of a cent. A new line appears: "Orrin: his brother drowned (14.2)". Then you write "Tomas's brown eyes". A soft underline appears, and hovering over it shows *2.1: "Tomas's grey eyes"* with **Go there · This one's right · Not a problem**.

**Asking.**
- "Mara's eyes?" A card appears at once with the quote, marked *Read by AI from your book · quote checked · no AI call now*.
- "Does Tomas know about Orrin's brother?" Ms Scribe reads the whole scene and answers: "I found no scene where Tomas learns it (searched 1–14.2). Orrin tells Mara in 14.2; Tomas was last at the harbour (12.1)." Each sentence is cited. This costs about 1.5¢.
- "When does Mara first stop trusting Tomas?" The answer is "The earliest I found, searching scenes 1–14 for distrust, suspicion and lies: 7.4", with the quote. About 2¢.
- "What was my idea about the drowned bell?" The answer comes from the Ideas on the Bell sheet, labelled "your idea, not in the book".

**A note disagrees.** "Your note on Orrin says green eyes; the book says brown (11.2)." You get **Go there · Update my note · Not a problem.**

**Planning.** The Outline shows your synopsis for each scene, or the AI's one-line summary card in grey if you have not written one. A planned card, "Mara learns about the map", says *not yet drafted* because no drafted scene is linked to it.

**Revising.** You cut a paragraph in chapter 2, so "grey" leaves Tomas's sheet and the underline goes. Renaming Hesk to Haskel first shows "12 matches in 7 scenes", then offers one Undo. *Check the book* shows its price first (about 3¢), then reports "2 possible contradictions" and says what it checked and what it did not (travel times, objects).

You never have to edit a sheet unless you want to.

## What goes away
- Tags: the tag bank, the tag Manager, templates, inline `#tags` (they become plain words, with your consent), AI tag chips, Recommend and Organise.
- Two sheet views kept in step, Story bible settings, Canon/Plan/Idea on every fact, about eight hidden "never bring back" lists, and the full re-read at every 4-second pause.
- Threads, Timeline, To do, Changes and Index as separate sections. Their content moves into the panel's Book view.

## What stays
- Everything you wrote, including sheet pictures, your categories, timeline years, confirmed plan links and uploads.
- Plot threads, the timeline with ages, the beta reader, plan links and a To do list (answer 21).
- The Outline, the upload review deck, the chat modes, Use AI off, your own key, local models and Cloud.

## What it costs (own key; Cloud adds 25 %)

| What | Cost |
|---|---|
| Read the whole novel once (also the rebuild after switching over) | about 12¢ |
| A 2-hour writing session | 1–2.5¢ |
| A quick fact | free as a card; about 1¢ through Ms Scribe |
| An open question | about 2¢ (3¢ when it digs wider) |
| Check the whole book | 3–4¢; nothing if the book has not changed |
| File a 20,000-word upload into sheets, once | about 15¢ |
| A busy month (20 sessions, 100 questions) | $1.60–2.30 |

Chat is about 80 % of a month's cost. Whole-book actions show their price before they run.

## What you control
- **Use AI**, plus four switches: story memory reading, contradiction check, Ms Scribe, and upload filing.
- **Not right**, **Not a problem**, and one **Dismissed** list where every entry can be undone.
- What counts as true. The manuscript always does. Notes and uploads count unless you switch a page, or mark a paragraph, **Not canon**. Ideas, and scenes marked Idea, never count.
- Names. You confirm each nickname once, and you have *Same as…*, *Split* and *Rename in book*.
- On Cloud, a monthly cap for background reading (suggested $1). Past it, the app asks before spending more.
- Your typed POV, place, time and story year. When the text disagrees, you see both and are asked once.

# Part 2: The design

## 2.1 Core ideas
1. **The manuscript is the only canon** (answer 1). Memory is a set of **claims**, each with its proof: a verbatim quote, its scene, and hashes of the sentences that proved it.
2. **A claim is stored** only when its quote is in the text sent, the quote says what the claim says (§2.3 ladder), and its subject is pinned down without guessing. It stays **live** only while its proof sentences are unchanged.
3. **Code computes the rest:** presence, state as of scene N, who knows what, ages, threads and contradiction candidates. Absence is never shown as fact.
4. **Derived rows obey AI rule 1:** stored apart, marked AI-made, removable, costed (each points to its `reading`) and rebuildable.

## 2.2 Data model

**Author-owned.** The AI writes these only through four exceptions:
- sheet lines she asks for in the chat: Pinned when she says where ("add this to Mara's sheet"), Ideas when she says it is an idea, and when context cannot tell, Ms Scribe asks "Is this an idea or canon?" first (decision 3 as changed by the author, 2026-10-11);
- *Update my note* proposals she accepts;
- *Update my detail* proposals she accepts;
- upload filing through the review deck.

| Thing | Contents |
|---|---|
| Manuscript | Active-draft text; scene notes; scene details (synopsis, brief, beats, status incl. **Idea**, typed POV/where/when/year, "+ also here" record ids) |
| `record` | name; `category_id` (built-in or her own, kept); kind derived from the category (character, place, thing, group, term, secret, thread); image; origin; **Pinned**; **Ideas**. Secrets add a defining quote and `knew_before` |
| `alias` | record, text, `norm`, case rule, origin, `shared` flag (a `norm` may belong to several records only when shared); not-a-mention phrases per record |
| Notes, Research documents | A **Not canon** switch per page and a **Not canon** mark per paragraph (a Tiptap attribute). Pinned paragraphs carry `aiFiled` {doc, ¶, source quote} or `aiWritten` {chat turn, date}, cleared when she edits them |
| `label` | name, colour, kind (tone, content, theme, custom); author only |
| `author_todo`, `dismissed` | Her own to-dos (a new table; `todo_item` retires). One Dismissed list: kind, key, label, quote, date |
| Plan links | Links she confirmed, and AI-made links (derived; *Unlink* sends them to Dismissed) |

**Derived.** Every row has a `reading_id` and a `draft_id`. Only the active draft's rows are live.

| Table | Fields |
|---|---|
| `reading` | scene, draft, sentence hashes read, partial reads since the last full one, prompt version, model, tokens, reasoning tokens, cost, finish reason |
| `card` | `line` (≤30 words) and `gist` (60–80 words), both a map only and never citable; where/when/POV/year/flashback/elapsed as `[value, quote, verified]`; `present` with quotes; mood; theme |
| `claim` | record, slot, value, value key, object, `how`, `from`, `voice` (narration, dialogue+speaker, thought+holder, rumour), `mode` (now, memory, hypothetical, dream), quote, scene, ¶, anchor (hashes of every proof sentence), proof (`literal`/`verified`), change flag, state (`live`/`stale`/`waiting`), spot-checked |
| `finding` | rule, two references, verdicts in both orders, fingerprint, state; `verdict_cache` keyed by quotes + context sentences + relative order + modes/flashback |

**Local index** (free, rebuildable):
- `mention`: record, scene, ¶, offsets, ambiguous flag.
- One FTS5 `passage` table over the manuscript, Pinned, Ideas, notes, Research and card lines. Each row is labelled with its source and its paragraph's canon status.

**Slots** (a closed list):

| Group | Slots | How it behaves |
|---|---|---|
| fixed | eyes, born, species, kinship type, fixed `detail:` labels | never changes |
| lasting state | hair, alive, role, stated age, scars | the latest value wins, shown "since 12.1" |
| transient state | location, injuries, clothing, objects held | shown only as "last stated in N" |
| accumulating | traits, history, `relation:<record>` | values add up |
| knows | object is a secret, with `from`; `how` ∈ saw, told, overheard, read, deduced, suspects, believes-false, knew-before, tells, refers | §2.5 |
| thread | opens, advances, resolves | |
| `detail:<label>` | a closed list of about 20 labels | no free-form labels |

Only narration claims in `now` mode set state or win against notes. Other claims show as "Mara says…" or "remembered".

**Meaning by place:**
- manuscript up to the open scene: happened;
- later scenes: later in the book;
- Pinned, notes and Research: timeless canon, which never makes a plot event happen;
- synopses, briefs, **scene notes** and planned cards: plans;
- never real, and never read: Not canon pages and paragraphs, Ideas, Try, chats, inactive drafts, and scenes with status Idea or left out of compile.

**Identity rules** (code):
1. A mention is the **longest capitalised span**. A surname alias matches only when the whole span equals a known alias, so "Jem Falsire" is an unknown name, not Rynna. Possessives count. Plurals point to a group or stay ambiguous.
2. Titles are folded only inside the twin gate, never when matching mentions. The AI never proposes a bare title or title + surname as an alias. One the author adds or confirms ("the Captain") counts, matched with exact case.
3. Names that are also dictionary words (Will, May) match case-sensitively. A match at the start of a sentence counts only if the scene names the person elsewhere. **Not a mention** saves the phrase.
4. **Shared aliases** are resolved in code: the paragraph or its neighbours name exactly one owner, a gendered title fits one, or one is the POV. Otherwise the chip shows dimmed ("Rynna or Tomas?") and claims wait. No question is asked.
5. **The twin gate** runs before any record is created, and once over her own records at migration. It blocks a new record that:
   - matches an alias after folding;
   - is a word subset of a name once titles are removed;
   - is a prefix of an existing name of 4+ letters;
   - is 1 edit from a 5–7-letter name, or 2 from a name of 8+ letters;
   - is on Dismissed (blocked silently).
6. The AI creates a character, place or thing only when the gate is clear, the name is capitalised mid-sentence, and it appears twice or carries a proved claim. New names and nicknames are asked about once. Secrets and threads follow §2.5.
7. Waiting claims attach on Yes after an anchor check; any whose anchor changed go back through the ladder. No sends the name to Dismissed.
8. *Same as…* merges two records; *Split* moves aliases back. *Rename in book* previews matches by scene and takes a snapshot. It flushes autosave, applies the rename to the open scene through the editor (as `agentApply.ts` does), and rewrites other scenes, inactive drafts, quotes, anchors and Dismissed keys in one main-process transaction, with one Undo.

## 2.3 The reading pipeline

**When** (answer 5). A scene is read:
- when the author opens another manuscript scene or closes the project (opening the chat, Outline, sheets or Research does not count);
- after an idle pause (3 minutes by default, adjustable from 2 to 5);
- on *Read now*.

A code gate decides whether to read:
- a finished sentence must have changed;
- the paragraph at the caret is skipped while it has no closing punctuation;
- the **cosmetic skip** covers only whitespace, punctuation, or a fix of ≤2 characters to a word that was not in the dictionary. Skipped sentences stay unread;
- names are not part of any hash.

**Changes made outside the editor** go into one queue: draft switches, revert, Replace in project, chat bulk tools, edit passes, and backlogs after the cap or the health gate. Up to 5 scenes are read at once. For more, the app asks once with the computed price ("Read 37 changed scenes: about 3¢"); otherwise each scene is read when visited. Switching back to a draft whose anchors still hold costs nothing. A draft never read is priced like *Rebuild memory*.

**Window.** The changed paragraphs ±2, extended back to the last paragraph that names a record. The whole scene is read on a first read, when >50 % of it changed, or after five partial reads. Windows over 1,500 prose tokens are split. Full reads go in pages of 2,500 tokens and are never truncated.

**What is sent** (`reader.v1`, fast tier, JSON, reasoning off on every route, input cap 6,000):

| Part | Tokens |
|---|---|
| Cached: rules, slot vocabulary, schema | ~900 |
| Cached: roster, one line per record. Additions are appended (`r12 +Ry`); the roster is rebuilt only on a removal, rename, merge, split, rebuild or new reader version. Characters, places and things ≤1,200 (the least-mentioned drop out; the code gate still covers them). Secrets and threads have their own ≤400 and never drop out | ≤1,600 |
| Tail: position, typed details, current card | ≤200 |
| Tail: live claims near the window; knows lines only for secrets that FTS-match the window or are held by someone Here; open threads | ≤400 |
| Tail: claims anchored in the window, and stale ones there | ≤250 |
| Tail: the window, paragraphs numbered | ≤2,500 |

**Output caps.**
- A first read gets 720 tokens (claims 600, card 120).
- A window read gets min(600, 120 + 0.3 × prose tokens), plus 120 when a card is due.
- A reply cut off at the cap is parsed up to its last complete item. Only the paragraphs after the last one quoted are re-read, once. The ledger logs the `finish_reason=length` rate.
- Each item returns `p` (paragraph), `voice` and `mode`. A new name looks like `{"n":"Hesk"}`; a new secret like `{"n":"the sold map","kind":"secret","q":"…"}`.

**Verification ladder:**
1. **Presence.** The normalised quote (3–25 words) must sit in the window that was sent, in paragraph `p`, exactly once.
2. **Subject.**
   - A name or alias in the quote's sentence lets the claim try literal proof.
   - A pronoun subject goes to the verifier with its antecedent span (back to the last sentence that names someone). If more than one named character fits, the claim waits, and is dropped at the next full read.
   - First person resolves to the POV only if the author typed the POV and the text agrees. A POV the AI read never anchors a claim.
   - A learner in a knows claim must be Here or the POV.
3. **Literal proof, in code.** The quote must match a per-slot pattern ("<Name>'s <value> <cue>", "<Name>'s <cue> was/were <value>", "<Name> had <value> <cue>"…). Its sentence must name exactly one character, sit outside quotation marks, and hold no negation, modal, conditional, comparative, simile or pluperfect marker. Displayed values use only words from the quote. Expect 15–30 % of claims to pass here.
4. **Verifier** (`verify.v1`, fast tier, one batch per reading).
   - It sees the subject candidates, slot, value, voice, mode, `how`/`from`, and the quote's sentences ±1 (plus the antecedent span), but never the whole scene.
   - It stores only "supported" claims with subject, voice and mode confirmed (and learner, `how` and `from` for knows claims).
   - The same batch checks on-page presence, the card fields that feed computation (POV, year, flashback), and "same as s40?" for new secrets and threads.
5. **Rejections** are logged with their reasons in the yields ledger.

**Reconciliation:**
- `same` counts only for claims whose anchor is unchanged.
- A stale claim comes back only through a fresh item with its own quote that passes the ladder. That item replaces the quote and the anchor.
- `drop` counts only for stale claims, or after the verifier rejects the current quote.
- Values merge by containment within one reading only. Across scenes they are shown side by side ("grey-blue · also 'grey' 2.1").
- Keys on the Dismissed list are dropped before storing.

**Invalidation.**
- On every save, code checks each claim's anchor: the quote's sentences ±1, plus the naming sentence for a pronoun subject. Any change makes the claim stale, shown dimmed ("re-checking after you pause").
- **Free re-proof.** A literal claim whose quote is still word for word in the text stays live if the code proof still passes and the changed neighbouring sentences added no marker word (dream, remembered, rumour, said, if, imagined, perhaps, lied, not…).
- A deleted scene deletes its claims. A moved scene re-dates them for free, and contradiction candidates are recomputed. A new reader version keeps the old claims.
- A record created late gets a **lazy back-fill**: paged, run once, counted against the Cloud cap, and priced in Needs a look when it needs more than 3 pages.

**Reasoning.**
- `reader`, `verify`, `judge`, `navigator`, `planLinks`, `contextImport` and `reviewChat` join `NO_REASONING_FEATURES`.
- Cloud's `AiCompleteBody` gets an optional `reasoning` field, honoured only when it lowers thinking. billing_config sets V4 Flash to `off`.
- The OpenAI adapter sends its lowest `reasoning_effort`.
- A local model that returns an empty reply with `finish_reason=length` pauses reading with one notice.

**Measuring accuracy without a gold set** (answer 20):
1. **Invariants**, checked in tests and on save: every live anchor is present; every claim is literal or verified; no unshared alias belongs to two records; nothing comes from Try, chats, inactive drafts or Idea scenes; no answer cites a card.
2. **Health gate**, per model over the last 20 readings. If fewer than 90 % of quotes are found, or fewer than 80 % of claims pass the verifier, reading stops (with one probe read per 10 scenes). Needs a look says: "Story memory paused: this model's readings aren't reliable enough. Switch to DeepSeek V4 Flash · Keep reading anyway · Details".
3. **Spot checks.** On each rebuild, 50 literal claims go back through the verifier, and Pro checks 20 verified claims with more surrounding text. After that, 1 in 20. Settings shows "proof agreement: 48 of 50 checked", never "accuracy".
4. **Test fixtures.**
   - *Pride and Prejudice* chapters with names and facts changed, plus original hard cases: pronoun traps, characters known only by title, lies, memories, negations, shared surnames, secret originators, time skips.
   - Scored per slot: quote, support, attribution and literal precision; twin rate; knows recall; false alarms. Judge agreement and underline precision are logged too.
   - A live run (~$0.10) is a merge condition for P2a, P2b and P4.

## 2.4 Contradictions

Code finds candidates. `judge.v1` (fast tier, ≤10 pairs per call) rules on each pair **twice, with the quotes swapped**, and only two "contradiction" verdicts make a finding. The judge sees both quotes with context, their positions, voice and mode, and is told that notes are timeless and may describe the future. Claims that are not narration in `now` mode never raise C1, C2 or C6 on their own.

| Rule | Candidate | Runs |
|---|---|---|
| C1 | Two values in a fixed slot (incl. kinship) where neither contains the other. Equal or contained values are grouped, and one per group is judged (k−1 pairs) | Background |
| C2 | A dead character **Here** in a later scene, outside a memory or flashback; or a lasting body state changed between adjacent appearances with no change claim | Background |
| C3 | X `tells` or `refers` before X's learning claim, which exists **later** and is not a memory. Skipped if X is in `knew_before` or X's group knew earlier. Always two quotes | Background |
| C4 | A stated age more than a year off the birth year plus a year stated or typed **in that scene** (same calendar). C4b: a stated age that falls in reading order outside a flashback | Background |
| C5 | A thread advancing after it was resolved | Background |
| C6 | The book against notes and canon Research, for fixed slots and kinship. State slots are compared only with dated note lines at the same scene. A note sentence is paired only if it holds the record's name and a slot cue. Values are compared in code; the judge sees only typed values that differ without either containing the other. ≤2 note sentences per claim, ≤10 pairs per reading | Background; the code part also runs when a note is saved |
| C7 | History or detail claims about one object, or sharing ≥2 content nouns, whose values differ (≤5 pairs per claim) | *Check the book* only |

- **Lifecycle.** Candidates are recomputed after claim changes, scene moves, flag changes and typed-detail changes. A finding its rule no longer produces closes itself.
- **Not a problem** is keyed by (record, slot, value A, scene A, value B, scene B), so it survives rewording and renames.
- **Check the book** judges every uncached candidate. Pro then confirms only pairs called a contradiction in both orders, at most 20. "Unclear" is shown as unclear. The report lists what was checked and what was not, including findings hidden because a scene looks like a flashback ("Not a flashback?").
- **Note conflicts** show both quotes with *Go there · Update my note · Not a problem*. *Update my note* is not offered when the book's side is speech, rumour or a memory.
- **Underlines.**
  - They mark both quotes, are drawn from anchors, and are never saved in the document.
  - At most 3 per scene, only in paragraphs with no unread change, never at the caret.
  - If precision falls below 70 % over 20 underlines, Needs a look asks once whether to show contradictions in the panel only.

## 2.5 Who knows what (answer 12)
- **The AI creates secrets and threads silently** whenever a proved claim backs one. Each gets a **defining quote**: the sentence that reveals the secret or opens the thread. There is no capital-letter test and no question.
- **Duplicates merge themselves.** A new secret or thread that shares a content word or holders with an open one gets a "same as s40?" check in that reading's verify batch, judged on both defining quotes. "Same" merges automatically and shows in ⓘ. *Split* undoes it and adds the split to Dismissed. Threads the author made (the Threads category) are records too.
- **Knows claims** need the learner to be Here or the POV. The verifier confirms the learner, `how` and `from`. A group learner ("the whole harbour knew") attaches to a group record.
- **"Readers have known since"** is the scene of the secret's earliest proved quote.
- **Absence is scoped, never a fact.** The panel says "No scene shows Mara learning this (checked up to 14.2)" in muted text. This never enters the prose block or Ms Scribe's evidence as "doesn't know". The Book grid offers **Knew before the book**, which writes the author-owned `knew_before`.
- **This scene** shows only secrets touched in the scene, plus tension lines: someone in the room knows and another does not, or readers know and the POV does not. A "+ 9 more in Book" link leads to the full grid.

## 2.6 Retrieval and Ms Scribe
**Step 0** (local, <50 ms) gathers:
- the whole open scene (answer 10);
- the records named in the question, with their live state, knowledge, threads and age;
- FTS5 hits over all labelled sources;
- an evidence menu of ids and snippets.

**Instant cards** answer three kinds of question from a live, uncontested claim, labelled *Read by AI from your book · quote checked · no AI call now*:
- record + slot ("Mara's eyes?");
- "does A know X" (only when the answer is yes);
- "who knows X", with the scoped absence line.

A card hands over to Ms Scribe when the slot has a stale claim, an open finding or incompatible values. If an unread changed sentence names the record and contains a cue for the slot, the app first reads that window (~0.1¢).

**Navigator** (`navigator.v1`, fast tier, ≤3 steps, ≤150 tokens out each; replaces `route.v2`).
- Cached prefix: rules and tools → roster → first line of each Idea → story map, capped at ~3k tokens (full lines within ±1 chapter, one line per chapter beyond).
- Tail: "Now: 14.2", the question, the evidence menu.
- It classifies the turn, then calls `search(terms)` (its own synonyms over FTS5; this is the meaning search through the paid AI, answer 11), `cards`, `read`, `state`, `knows`, `timeline` or `ideas`, or says "enough". It returns evidence ids, never prose.
- Questions with **first, last, ever, never, how many** or **knows** must search every earlier scene.

**Answer** (`agent.v9`, strong tier, one call). The prompt order:
1. rules, citation and time rules, edit tools (~1,200 tokens, against 2,329 today);
2. roster (names and aliases only);
3. history (≤1,500 tokens: earlier questions and final answers, older turns cut to one line, not citable);
4. voice profile (edit and draft turns only);
5. **the whole open scene as current text** (E0);
6. labelled evidence (*happened, Ch 3 ¶4* · *later in the book* · *your notes* · *not canon* · *filed from <doc>* · *your idea* · *source document* · *planned* · *idea scene*);
7. the question.

Reasoning is off for answer, lookup, idea and to-do turns. It is low for edit and what-if turns, with `max_tokens` raised to match. `provider.order` stays unset.

**Citations.**
- Answers cite `[E7 "quote"]`, and code checks the quote against E7 as it was sent.
- Every sentence that names a record or event must carry a citation, or it is marked "not checked".
- `cite.v1` (fast tier) checks cited sentences, and checks that the search scope supports "first" or "last".
- Answers to ordinal and absence questions state their scope.
- An unsupported main claim retries once, then says "Not found in the manuscript (I looked in …)".
- **Self-Route** allows one `{"need":"chapter 9"}` request (≤8k tokens). Evidence it finds that the first search missed is logged as a **search miss**, which is the trigger for adding embeddings later.

**Writes.** The chat never writes claims. Manuscript edits keep the Auto, Ask and Plan rules. Sheet writes follow decision 3 as the author changed it on 2026-10-11:
- An explicit request to put something on a sheet ("add this to Mara's sheet", "pin that on the Bell") goes there, into **Pinned**, with a quick confirmation in the chat and an Undo. Pinned writes carry `aiWritten` until she edits them.
- When she asks to save something and Ms Scribe cannot tell from context whether it is canon or an idea, it asks "Is this an idea or canon?" as a two-choice quick question: *Idea* goes to the sheet's **Ideas**, *Canon* to **Pinned**. "Save this idea" or "brainstorm" goes to Ideas without asking.
- Chat modes (decided by Claude, unconfirmed): in Auto the line lands at once; in Ask, Ask's one click is the confirmation; Plan never writes.

(The recommended default was: sheet writes go to Ideas unless she asks to pin them.)

**Prose story block** (ghost text, Rewrite, Author mode, critique, edit passes, What next, scene suggestions).
- New heading: "Story notes (the manuscript wins: where the passage and these notes disagree, follow the passage)".
- Contents: records Here with their live lasting values (narration, now); transient values from this scene; Pinned canon paragraphs; tone, content and theme labels; the card's mood.
- Never absences, and never speech as fact. Budgets stay at 400 and 150 tokens.
- The panel shows exactly this block.

**Beta reader.** It reads card gists as a labelled map. Each item must quote manuscript text, and code checks the quote.

**Data sharing and toggles.** One row and one toggle per new feature id. Grouped switches in Settings write their member ids. Labels and Research passages are named in the prose and agent rows.

## 2.7 Surfaces
- **This scene | Book** panel (answer 4).
  - *Here* (the POV, characters with an on-page quote, "+ also here") and *Mentioned* (the name scan). Hovering a chip says why it is there and offers *Not a mention*.
  - *True now* per §2.2 and §2.5.
  - *Book*: Cast (a view of the Characters category), the who-knows-what grid, Threads, Timeline with ages, and *Check the book* and *Rebuild memory*, both priced first.
  - Footer: "Read 3 min ago · Read now · today 0.3¢ · Cloud 12¢ of $1" and **Dismissed (n)**.
- **Needs a look** is quiet and never required. Its badge counts conflicts only. It holds:
  - *Conflicts:* book against book, book against note, typed detail against text (*Update my detail · Keep mine*), Research against lines filed from it;
  - *Questions*, asked once: new names and nicknames;
  - *My to-dos*, at the top;
  - *Loose ends*, only behind the furthest drafted scene, each with *Ask Ms Scribe*: author-made threads, or threads with ≥2 events, untouched for max(8 scenes, ¼ of the book); a character absent that long; planned cards before the last drafted scene. Secrets nobody learns appear only in *Check the book*;
  - *Notices*;
  - after a rebuild, one summary grouped by page, with bulk actions.
- **Dismissed** is one list with Undo on every row: names, alias removals, not-a-mention phrases, Not right, Not a problem, unlinks and splits. **Not right** asks which is wrong:
  - *Not about Mara*: the claim is re-verified for the person she picks;
  - *Wrong value*: dismissed, keyed by record + slot + value + anchor, so a new sentence stating it counts as new evidence.
- **Sheets, one view** (answer 7): aliases with *Same as / Split / Rename*; **Pinned**; **Ideas**; **From the book, as of [scene ▾]**; Knows, Relationships, Threads, Appears in, Age.
- **Typed details** win only where the card has no quoted value. Otherwise the text's value shows with "you typed: harbour" dimmed, plus one conflict.
- **Years and ages.** A typed year carries forward, skipping flashbacks, until the next typed year or a quoted elapsed hint. Years the AI quotes apply only to their own scene. Age is the birth year plus that year ("about 19, year from 1.1"); otherwise the last stated age, with later elapsed hints listed but never added up.
- **Labels** are filters only the author sets. Tone, content and theme labels steer prose (F-14.13); custom labels stay local.
- **Outline.** Plan links become **derived index data**.
  - Unambiguous code matches are applied.
  - `planLinks.v2` runs only for an ambiguous top two, only when a card line changes, cached, at most one call per reading.
  - AI-made links carry *Unlink*.
  - *Not yet drafted* means no link to a drafted scene.
- **Research** (answers 23 and 24).
  - A new root section, excluded from compile, stats, goals, drafts, snapshots and the reader.
  - Docx, md and txt become editable documents; PDFs become plain text marked "converted"; images stay as attachments. *Open original* keeps the file.
  - Filing into Pinned runs once, through the review deck. Each filed paragraph keeps a source quote that code checks. Saving the document proposes updates to filed lines that no longer match.

## 2.8 Series projects (answer 15; P6)
A Book level sits above parts in one `project.db`. Claims follow reading order, so the memory spans books. P6 also adds:
- front and end matter per book;
- "Convert this novel into a series";
- chapter numbering per book;
- a story map that shows earlier books one line per chapter.

## 2.9 Try-things-out space (answer 13; P5)
- Scene **Versions** (snapshot kind `variant`) and **Try chats**, never read into memory.
- A free list of later scenes whose claims a what-if touches.
- *Use this version*, *Save to Ideas* and *Make a planned card*.

Until P5, answer 13 already holds: chats never write claims, and Idea scenes and inactive drafts are never read.

## 2.10 With AI off or a weak local model (answer 19)
These keep working: names, nicknames and mentions; word search; the panel (POV, "+ also here", *Named in this scene*); sheets; labels; the Outline; Research; to-dos; local Needs a look items; Dismissed. Existing claims stay visible, marked "reading paused", while their anchors hold.

# Part 3: Removals and migration

| Today | Fate | Replacement |
|---|---|---|
| Tag bank, Manager, templates, range tags, tag filter, Index | Removed | Records, aliases, mentions; Book › Cast |
| Inline `#tags`, compile `keepTags` | Converted with consent; the nodes stay as inert legacy types | Plain words |
| Tone, content, custom tags | Converted | Labels (colours kept; nesting dropped) |
| AI auto-tags, Recommend, proposed/title tags, misspelling Fix, `importStructure` tag candidates, Organise | Removed | Name proposals through the twin gate; *Same as / Split*; the migration merge list; names in the spellcheck |
| Sheet fields, two views, sync (F-9.18), Story bible settings (F-9.19) | Replaced | One view; fields become Pinned "Label: value" lines; categories kept |
| Canon/Plan/Idea on each item | Replaced | Meaning by place; Not canon switch and mark; scene status Idea kept |
| `summary.v1–v5`, `observed_fact`, AI facts, `scene_summary`, the 5 conversions on open | Replaced | `reader`, `verify`: `reading`, `card`, `claim` |
| `continuity.v2`, Continuity view, `continuity_finding` | Replaced | `judge`, `finding`, underlines |
| Changes, ~8 hidden lists, "Clear story bible" | Replaced | ⓘ, Dismissed, *Rebuild memory* |
| To do, `todo.v1`, `todoSuggest.v1`, `todo_item` | Replaced | Loose ends; `author_todo` |
| Threads, Timeline, Index sections; timeline events; tag-based ages | Re-pointed | Book views; typed years; ages from claims |
| `planLinks.v1` | Replaced | Code-first links + `planLinks.v2`, applied automatically |
| `route.v2`, `agent.v8`, `query.v4` | Replaced | `navigator.v1`, `agent.v9`, `cite.v1` |
| Story-bible block from tags; scene steer | Re-pointed | Block built from the panel, with the new heading |
| Other summary readers: `synopsis.v1`, `notesSuggest.v2`, SummaryBlock, "Summarize all scenes", wizard text, activity jobs, beta reader | Re-pointed | `synopsis.v2`, `notesSuggest.v3`, card view, *Rebuild memory*, reader jobs; the beta reader uses gists as a map and quotes the manuscript |
| Library list, `apply.ts`, `contextImport.v2`, `reviewChat.v2`; `legacyImport` tag writes | Replaced | Research documents; filing into Pinned (`v3` prompts) with source marks; imports write records and labels |
| Feature ids `tags`, `summary`, `continuity`, `organise`, `todo`, `sheetSync`, `query`, `route` | Retired once the lenient settings parse ships | `reader`, `verify`, `judge`, `navigator` |

**The author's Drive project** (answer 16):
1. **Before switching over.** The installed app, built from `main`, runs migrations 0028+. They only add tables and copy into them from tags, entities and `context_file`. The old memory keeps running (`storyMemory: v1`). Dev builds and the e2e open only copies.
2. **The switch-over, which the author starts:**
   1. Flush the Drive working copy, then make the F-8.7 backup and a dated Drive copy.
   2. A **dry run** lists, by name, what is kept, converted and dropped. It includes:
      - a twin-gate merge list over her own records, to tick;
      - AI-written sheet text, found through the `knowledge_change` sheet-edit rows and `entity.origin`, which moves to a "Filed by AI earlier: please check" block marked Not canon;
      - tag nesting and old dismissals that cannot be converted;
      - the computed rebuild cost and time.
   3. A **consent screen** lists every inline tag with its replacement (the linked sheet's name, otherwise the tag name with hyphens turned into spaces), editable per row.
   4. The **conversion** is a JS step after open, modelled on `knowledge/conversion.ts`. It rewrites `node.content`, `node.notes` and `draft_text` in one transaction and leaves snapshots untouched.
   5. The project switches to `v2`. *Rebuild memory* asks once with its price and does not count against the monthly background cap (the daily cap still applies). It ends with the grouped summary.
3. **Kept:** everything she wrote, including:
   - timeline years, typed on the first scene of each run of scenes linked to one event;
   - filled fields, as Pinned lines (dated facts with scene ids);
   - sheets marked Plan or Idea, moved into Ideas; project notes marked Plan or Idea, set Not canon;
   - scene notes and Idea scenes, untouched;
   - plot-thread tags, as thread records;
   - uploads, with their originals;
   - dismissals that still apply.
4. **Dropped (AI-made):** AI facts, `observed_fact`, summaries, cards, AI tags and links, sheets with only AI text, Changes, findings, computed To do items, sync state, AI plan links, obsolete dismissals.
5. The old tables stay until P9. **Other users** get the same steps. With AI off, the rebuild waits; on Cloud it asks with its price first.

# Part 4: Build phases

**Rules for every phase:**
- Slices merge to `main` behind `storyMemory: 'v1' | 'v2'`. Installed builds stay on v1 until the switch-over, and migrations stay additive until P9.
- Tag, entity, knowledge, Organise and To do code is frozen for edit lists during the build; such requests are logged as superseded in QUESTIONS.md.
- Each prompt version ships with a golden test, eval cases, a token-report row, an `aiCostNotes.ts` entry and a data-sharing row, with one `eval:ai -u` run per slice.
- The e2e is rewritten inside each slice; the sizes include ~30 % for this.
- Each phase's first slice marks the ticked features it replaces "replaced by F-x.y" in FEATURES.md (F-2.8, F-4.1–4.13, F-5.6, F-5.7, F-5.16, F-9.4, F-9.7, F-11.1c, F-11.2, F-11.2b, F-13.4, and the unticked M7 features), adds the new ids and moves the launch line.

| Phase and goal | Ships | Size | Tested by |
|---|---|---|---|
| **P0 Ground truth**: real prices, safe plumbing | `npm run ai:probe` (the author runs it once: prices from `/api/v1/models`, cache and reasoning tokens from repeated Flash and Pro calls); price table; Cloud `reasoning` field; ledger stores reported cost and reasoning tokens; lenient `features` parse; the switch; fixture text and labels; invariant helpers; cost rows; gateway routing in OPERATOR-SETUP | S, ~4 days | Unit tests (a Cloud reader request goes out with reasoning off; stored settings with retired ids still parse); probe output in the commit |
| **P1 Names and documents**: records replace tags; AI off works | Additive migrations; identity rules, twin gate, mentions, FTS on records; one-view sheets with categories, Pinned, Ideas, Not canon; labels; Research section; to-dos, Dismissed; panel shell; Rename in book; inert legacy nodes; the switch-over flow, tested on copies; new story-block heading (~12 prose versions); filing into Pinned (`contextImport.v3`, `reviewChat.v3`); `legacyImport`. Until P3, v2 runs `agent.v8` without its tag and sheet tools. 14 prompt versions | L, ~3 weeks | Every stored JSON column loads with `errorOnInvalidContent: true`; migration tests; e2e AI-off path |
| **P2a Evidence reader**: claims from prose | `reader.v1`, `verify.v1` and all of §2.3 for fixed, state and accumulating slots; cards and gists; Here/Mentioned; True now; as-of sheets; ⓘ / Not right; Cloud monthly tally (`app-state.json`, reconciled with `/credits`); *Rebuild memory*; re-points (beta reader, scene steer, story map, `synopsis.v2`, `notesSuggest.v3`, plan links); `summary.v5` off in v2. 6 prompt versions | L, ~2.5 weeks | Golden tests; invariants; **a live planted-error run is a merge condition** |
| **P2b Who knows what, threads, time**: answers 12, 21 | `reader.v2`, `verify.v2` with knows and thread claims; silent secrets and auto-merge; the grid; Threads; Timeline; ages. 2 prompt versions | M, ~1.5 weeks (parallel with P3) | Live run: knows recall, attribution, duplicate rate |
| **P3 Ms Scribe v9**: cheaper cited answers | Step 0, instant cards, `navigator.v1`, `agent.v9`, `cite.v1`, scope rules, Self-Route, search-miss log, Ideas recall. 3 prompt versions | M, ~1.5 weeks | Golden tests incl. a turn-8 fixture; live agent fidelity |
| **P4 Contradictions, Needs a look**: answers 6, 21 | C1–C7, `judge.v1`, lifecycle, underlines, note/detail/Research conflicts, loose ends, *Check the book* | M, ~1.5 weeks | Live run: false alarms, judge agreement; e2e underline step |
| **Switch-over**: one system | The author's switch-over; v1 code deleted (≈ −25k lines); ids retired; FEATURES.md and ARCHITECTURE.md updated | M, ~1 week | Full gates; the author checks the installed app |
| **— LAUNCH LINE —** | **P0–P4 plus the switch-over: about 10 weeks** | | |
| P5 Try space | §2.9 | M, ~1 week | |
| P6 Series | §2.8 | M–L, ~1.5 weeks | |
| P7 Storyboard | Thread lanes, a "when" row | S–M | |
| P8 Measured extras | Embeddings only if search misses justify them (`embed` in providers and the gateway, plus a data-sharing row); local-model calibration; opt-in deep check | S each | |
| P9 Cleanup | Drop the old tables once the author confirms | S | |

# Part 5: Token and cost budget

**Assumptions:**
- OpenRouter list prices: Flash $0.14 in / $0.28 out, Pro $1.74 / $3.48 per million tokens. Cloud = own key × 1.25.
- Reasoning off for background calls and answer turns.
- No cache discount counted. Where noted, a second figure assumes DeepSeek's cache-hit price of about 1/50; whether OpenRouter passes it through is unconfirmed until P0.
- A 90,000-word novel in 90 scenes; 1,000 words ≈ 1,350 tokens; ~10 claims per scene; 5 % retries; chat history ≤1,500 tokens.
- In the app, every estimate is computed from the active model's prices and the actual book.

| Task | What runs | Tokens (in / out) | Own key | Cloud |
|---|---|---|---|---|
| **Index once** (= rebuild) | 90 reads (3,800 / 520), 90 verifies (1,300 / 110), ~12 judge calls, 50 Flash and 20 Pro spot checks | 490k / 61k Flash; 14k / 0.8k Pro | **≈ 12¢** (≈ 9¢ cached) | ≈ 15¢ |
| **2-hour session** | ~12 window reads (4,000 / 300), 3 card refreshes, 12 verifies, ~4 judge calls, ≤2 plan-link calls | 73k / 6.5k Flash | **≈ 1.3¢** (up to 2.5¢ when hopping between many scenes) | 1.6–3.1¢ |
| **Instant card** | Local; sometimes one Flash window read | 0, or 4k / 0.3k | **$0** (≈ 0.1¢) | same |
| **Lookup via Ms Scribe** | Pro (3,700–5,200 / 120) + `cite.v1` | 4–5k Pro | **0.7–1¢** | 0.9–1.2¢ |
| **Open question** | 2 navigator steps (12k / 0.3k) + Pro (5,700–7,200 / 350) + `cite.v1` | 13k Flash + 6–7k Pro | **1.3–1.6¢**; ≈ 3¢ when widened (1 in 5); **average ≈ 2¢** | ≈ 2.5¢ |
| **Check the book** | ~100 pairs × 2 orders (20 Flash calls); Pro confirms ≤20 | 30k / 6k Flash + 12k / 1.8k Pro | **3–4¢**; ≈ $0 if the book has not changed | 4–5¢ |
| **Upload 20k words**, once | Filing on strong, 14 chunks, reasoning off | 45k / 21k Pro | **≈ 15¢** (≈ 1.2¢ on fast) | ≈ 19¢ |
| **What-if** (P5) | 5 Try turns + 1 Version on Pro | ~60k Flash + 42k Pro | **10–12¢** | 13–15¢ |
| **Heavy month** | 20 sessions; 30 cards, 20 lookups, 50 open questions; 2 checks; 1 what-if | | **$1.60–2.30** | $2.00–2.90 |

- **What drives the month:** open questions ≈ $1.00, lookups ≈ 20¢, sessions 26–50¢, what-if ≈ 11¢, checks ≈ 5¢. The top of the range assumes Pro thinks anyway (+≈ 0.5¢ per call). After P0, Settings projects the month from the ledger.
- **Accuracy extras** (verifier, both judge orders, `cite.v1`, spot checks): ≈ 5¢ per rebuild, 0.3¢ per session, 0.02¢ per question.
- **Cloud background** in a heavy month is ≈ 30¢, well under the suggested $1 cap.
- **OpenAI key** (gpt-5.4-mini/gpt-5.4): about 7× for background (index ≈ 70¢, session ≈ 8¢); an open question ≈ 3¢. **Local models:** $0.
- **Storage:** 2–4 MB per novel in `project.db` on Drive; no vectors.

# Part 6: Risks, review changes, and open decisions

## Risks and how they are contained
1. **Sheets may be thinner than you expect.** Doubtful facts are skipped, not guessed. Sheets say "not stated in the book", and Ms Scribe reads the text itself, so a missed fact makes an answer slower, never wrong.
2. **The two AI checks may miss the same things.** Strict checks in code, spot checks by the stronger model, and a disguised test book full of traps.
3. **A line dims for a few minutes after you edit its sentence.** Simple facts are re-checked at once for free. This is the price of never showing a fact the text no longer supports.
4. **False underlines.** Two verdicts must agree, there are at most 3 per scene, they disappear on their own when the cause goes, and low precision brings one question, never a silent change.
5. **Duplicate secrets.** They merge themselves. At worst you see a muted "no scene shows…" line, never a false contradiction.
6. **A fact lands on the wrong person.** The full name list goes into every reading, the twin check catches near-duplicate names, unclear surnames are left dimmed, and "Not about Mara" moves a line.
7. **Prices and hidden "thinking" are not yet checked.** P0's probe checks them with your key, and every figure here holds even without caching.
8. **Surprise spending.** The Cloud cap, prices shown before whole-book actions and big backlogs, and spending in the status line.
9. **Losing work when switching over.** Backup, a dated Drive copy, a dry run, your consent for the one change to your prose, and old data kept until you confirm.
10. **Two systems side by side during the build.** Your installed app keeps the old memory until you switch.
11. **Launch moves by about 10 weeks** (decision 1).
12. **Search by meaning can miss moments that are only implied.** Misses are logged, and they decide whether a stronger search comes later.

## Review fixes changed rather than taken as written
- **New secrets** are created silently and merged automatically (novelist review), instead of being asked about (accuracy review). Answer 22 and the no-upkeep goal rule out one question per secret. The defining quote and the separate roster budget are kept.
- **A slip with no learning scene at all** is neither a question nor a finding. C3 needs a later learning claim, so it always has two quotes.
- **The "Not a problem" key** holds both values and both scenes. It survives rewording (novelist) yet stays tied to the scenes (accuracy).
- **Wide anchors** (accuracy) come with dimming and the free re-check (novelist).
- **Story years:** typed years carry forward (novelist), but C4 uses only years from the same scene (accuracy).
- **Spot checks stay at launch.** Engineering suggested moving them later, but they are the only ongoing check against the text. Local-model calibration moves to P8.
- **The leaner Pro prompt** does not wait for the cache result, because AI rule 2 needs the voice profile only for prose.
- **Content and theme labels keep steering prose**, as F-14.13 does today.

## Decisions (were open; settled by the author 2026-10-11)

All eight were settled on 2026-10-11: the recommended default stands for 1, 2 and 4–8, and decision 3 was changed by the author (see "Decisions (2026-10-11)" at the top). Decision 8 is in the plan doc and Part 3.

| # | Question | Recommended default |
|---|---|---|
| 1 | Build this before launch (about 10 weeks), or launch on today's memory and ship this as the first update? | **Before launch.** Today's memory is not signed off, and converting paying customers' projects later is riskier. |
| 2 | Apply plan links automatically, marked AI-made with *Unlink*, instead of waiting for you to confirm each one? | **Yes.** |
| 3 | When you ask Ms Scribe to add something to a sheet, should it go into **Ideas** unless you say "pin it"? | ~~**Yes.** Chat brainstorms stay out of canon.~~ **Changed by the author 2026-10-11:** an explicit request goes where asked (Pinned) with a quick confirmation and Undo; when context cannot tell, Ms Scribe asks "Is this an idea or canon?" |
| 4 | When the text disagrees with your typed POV, place or time, show the text's value with yours dimmed and ask once? | **Yes.** The alternative: your typed value always wins, silently. |
| 5 | Type one story year per time jump and let it carry forward? | **Yes.** |
| 6 | File uploads with the strong model (≈15¢ per 20,000 words) or the fast one (≈1.2¢)? | **Strong, with thinking off.** It is a one-time write into canon. |
| 7 | What monthly Cloud cap for background reading? | **$1.** A heavy month uses about 30¢. |
| 8 | Sheet text the AI wrote earlier (uploads, Organise, the chat): keep it in a "Filed by AI earlier: please check" block marked Not canon, or drop it? | **Keep, marked Not canon.** |