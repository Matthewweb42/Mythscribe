# Questions for the author

Written by Claude during unattended `/goal` runs. Each entry is a decision Claude made without
waiting (recorded in `FEATURES.md` as "decided by Claude, unconfirmed"), or a step only the author can
do. Review, then confirm, change, or delete the entry.

<!-- Entry format:
## YYYY-MM-DD · F-x.y · short title
- Question:
- Chosen: (what was built)
- Alternatives:
- To change it: (files or feature to revisit)
-->

## 2026-10-10 · F-9.18 · Sheet sync follows the chat mode: Auto lands with Undo, Ask and Plan hold it
- Question: You said the sync "lands on its own (it is the author's own words re-filed), logged in Changes with Undo; it follows the chat's Auto/Ask mode like other story-bible edits if that is the existing pattern".
- Chosen (decided by Claude, unconfirmed): it is the existing pattern (the background plan links apply at Auto and only suggest at Ask and Plan; Organise and the chat agent follow the mode too), so: at **Auto** a write-up or a filing lands on the sheet at once and is logged in Changes (source "Sheet sync") with an Undo; at **Ask** and **Plan** (the default is Ask) it is computed in the background and held on the sheet with **Apply** and **Dismiss** and a preview of the new page or of each field change. AI rule 1 (CLAUDE.md): both are Proposals except in Auto, as the rule allows; Plan never edits.
- Alternatives: always land on its own (it is the author's own text) at every mode; at Ask, land filings (the author's words) but hold write-ups (AI prose).
- To change it: `src/main/ai/sheetSync.ts` (`runSheetSync`, the `auto` branch).

## 2026-10-10 · F-9.18 · How AI-written page text is marked, and why it fits AI rule 1
- Question: The Blank page now holds prose the AI wrote. How is it marked, and is it allowed?
- Chosen (decided by Claude, unconfirmed): the page is derived from the author's own sheet text (the fields), never from the manuscript, and never enters the manuscript — the same footing as the derived index data rule 1 already allows (summaries, facts), but stored in the sheet because it is the sheet's other view. Each paragraph the AI writes is remembered by hash (`entity.sync.aiParagraphs`); the page shows "Written up by AI from your fields" or "N of M paragraphs written up by AI…". A paragraph the author edits stops matching and counts as theirs. Every applied write-up is costed in the ledger and has an Undo in Changes. Rule 2 (voice profile, brief, exemplars, fidelity check) is not applied: this is story-bible reference text, not manuscript prose, and the voice block would multiply its cost.
- Alternatives: mark AI paragraphs inline (the page would need a rich-text editor instead of the plain textarea); apply the voice block and fidelity check to write-ups.
- To change it: `src/main/entity/sheetSyncState.ts` (`aiParagraphs`), `SheetSyncBar.tsx`, a new prompt version for rule 2.

## 2026-10-10 · F-9.18 · Existing sheets: what the first sync does
- Question: Sheets written before F-9.18 have fields, a page, or both, and no sync history. What happens to them?
- Chosen (decided by Claude, unconfirmed): nothing runs on open (no bulk spend). A sheet syncs only after the author edits it (30 s pause) or clicks Write up now / File now. A **Blank page sheet** keeps its page exactly as written: the first sync only fills its fields from it. A sheet with **both** a page and fields keeps its page too (its fields are filled from the page; the page is written up only after a later field edit). A **Structured sheet** with no page gets its page written up. The migration adds two columns and touches no text; F-8.7's backup is taken before it, and every applied sync has an Undo.
- Alternatives: a one-time "sync every sheet" pass after the update (with a cost estimate, like the F-9.14 conversion); write the page of a both-texts sheet up from its fields at once.
- To change it: `src/main/ai/sheetSync.ts` (`pageStaleAfter`), `src/main/entity/sheetSyncState.ts` (`sheetSyncStateOf`).

## 2026-10-10 · F-9.18 · Safety rules and smaller calls in the sync
- Question: several details the request left open.
- Chosen (decided by Claude, unconfirmed): (1) an emptied page never empties the fields, and fields with no text never empty the page (both just mark the views as agreeing); (2) an answer that comes back after the author edited the sheet again is dropped; (3) the pause is per sheet (editing another sheet does not hold this one back), and the due list is a settings row so a quit resumes it; (4) the page is plain text: headings are the field labels on a line of their own, laid out by the app (the model writes only prose), shown in the prose font; (5) the write-up length is a ceiling (short ≈ 120, medium ≈ 250, long ≈ 500 words) and never adds facts; (6) the page is marked out of date when the fields' labels, order, the sheet's own fields, or the category's write-up style change, but nothing re-runs until the sheet is edited or Write up now is clicked; (7) a filing sends only the paragraphs removed and added since the views last agreed and gets back compact edits (never whole field values); added text over 3,000 characters is filed in several requests; (8) a write-up over the input budget cuts the longest field values to fit; a filing over it is refused with the budget message (rare); (9) a page addition with no fitting field becomes a field of the sheet's own (at most 12; past that it goes into Notes as "Label: text"); (10) "Write up now" / "File now" / "Try again" skip the 30 s pause.
- Alternatives: per-section incremental write-ups (cheaper on long sheets; listed in the cost registry ideas); a rich-text page with real headings.
- To change it: `src/shared/sheetSync.ts`, `src/main/ai/sheetSync.ts`, `src/main/ai/sheetSyncService.ts`.

## 2026-10-10 · F-9.17 · The List/Cards choice is kept with the project
- Question: You asked for one List/Cards choice for every category tab, "until they click the other". Should it survive closing the project?
- Chosen (decided by Claude, unconfirmed): yes. It is stored in the project's story-bible settings (`storyBible` settings row, the same row as the F-9.19 Settings tab), so it holds across tabs, restarts, and Settings changes, per project.
- Alternatives: keep it for the session only (as before, but shared); make it app-wide for every project.
- To change it: `src/shared/storyBibleSettings.ts` (`listView`), `src/renderer/features/entities/storyBibleSettingsStore.ts`, `EntityTab.tsx`.

## 2026-10-10 · F-5.25 · Chat tool audit: what was built and what waits
- Question: The audit of the chat's tools listed eight fixes. Which ship with F-5.25?
- Chosen (decided by Claude, unconfirmed): built 1 (clear the story bible), 2 (routing: a bulk delete is a clear, never Organise; scenes and chapters never in bulk; unclear nouns are asked about), 3 (one tag on many documents; many items moved at once), 4 (rename a tag; rename a sheet; move sheets to another category; merge sheets; new empty sheet; all through Organise's own apply and the Changes log), 6 (the sheet list reads one field across the sheets). Not built: 5 (clear one document's notes; settle To do items from the chat), 7 (set a fact's status from the chat), 8 (answer actions: undo the last turn, re-run summaries, open the upload or Library dialog). They each need a new tool result format (fact and To do ids the model can name) or new renderer actions, and every extra edit line costs about 20 tokens on every write request.
- Alternatives: build 5, 7, 8 as a later prompt version (agent.v8) once the ledger shows the v7 cost.
- To change it: `src/main/ai/prompts/agent.v7.ts` (`AGENT_BIBLE_EDITS`), `src/main/ai/agentTools.ts` (`resolveAgentEdit`), `src/renderer/features/ai/agentApply.ts`.

## 2026-10-10 · F-5.25 · Clear the story bible: what a fresh start forgets and keeps
- Question: You asked for one confirm card with checkboxes, a backup first, one Changes entry, and one Undo. Three details were open: does a clear remember the deleted names (so the background reading and tagging do not make them again, as a one-by-one delete does)? What happens to pictures and uploaded originals? What does "the story bible" tick?
- Chosen (decided by Claude, unconfirmed): (1) A clear forgets nothing onto the dismissed lists: you are starting fresh, so the readings and your re-upload may make the same sheets and tags again (a dismissed name would also stop the reading from stating facts about a re-uploaded sheet of that name). (2) Pictures and uploaded originals stay on disk so Undo can put the sheets and uploads back; they are not cleaned up afterwards. (3) "The story bible" and "start fresh" tick every sheet category, every tag category, and the Library uploads (so an identical re-upload is not skipped as unchanged); notes only when you name them. (4) Undo refuses whole once something of the same name exists again (after a re-upload) or a cleared document has notes again, and points to the backup taken just before the clear, rather than doubling sheets.
- Alternatives: (1) remember the names as a one-by-one delete does; (2) delete the files at once (Undo then brings sheets back without pictures); (3) leave tags or uploads unticked by default; (4) let Undo double up, or merge into what was made since.
- To change it: `src/main/knowledge/bibleClear.ts` (`clearStoryBible`), `src/main/knowledge/clearSnapshot.ts` (`assertRestorable`), `src/main/ai/prompts/agent.v7.ts` (`AGENT_BULK_RULES`, a new prompt version).

## 2026-10-08 · F-4.13, F-4.12b, F-9.10 · How the tag rule reads "ordinary word"
- Question: You said tags should be capitalised words or abnormal terms ("memorial fragments"), and that an ordinary word used often in an abnormal way can be a potential tag. How does the app tell a name from an ordinary word?
- Chosen (decided by Claude, unconfirmed): a local rule over your own manuscript, no word list and no prompt change (`src/shared/tagTerms.ts`). A term is a **name** when the text always writes it capitalised (Marta, the Tide Reckoning), a **coined term** when it is a phrase of several words the text repeats 3+ times (memorial fragments), **unusual** when it is an ordinary word the text also capitalises mid-sentence 4+ times ("the Trial" beside "a fair trial"), otherwise **ordinary** (or absent). Background tagging creates new tags only for names and coined terms, in every category, so themes and tones the scene never names ("loneliness", "dread") are no longer made; tags already in your bank are still linked. Unusual words are proposed in the tag bar (F-4.12b now proposes a word that also appears in lower case once it is capitalised mid-sentence 4 times). Organise offers AI-made ordinary-word tags in "Not names — remove?" (removing one also stops the AI making it again), never your own tags, and no longer treats two ordinary words as duplicates.
- Alternatives: ship an English word list (~10k words) to call "skyglass" coined even in lower case (today a single lower-case coined word counts as ordinary); keep AI-made theme and tone tags (only names filtered); a prompt change (`summary.v4`) asking the model for names only.
- To change it: `src/shared/tagTerms.ts` (`classifyTagTerm`, `TERM_PHRASE_MIN_REPEATS`), `src/shared/proposedTags.ts` (`PROPOSED_ORDINARY_MIN_MENTIONS`), `src/main/ai/autoTags.ts`, `src/main/organise/organiseProject.ts` (`ordinaryTags`).

## 2026-10-08 · F-9.10, F-9.8, F-14.15 · The review deck: defaults and details
- Question: You chose one decision at a time (a card per change, A / S / E, progress, groups rail, Accept group, Skipped filter). A few details were left open.
- Chosen (decided by Claude, unconfirmed): (1) Nothing starts accepted on any deck, including the upload review, which used to include everything by default. (2) Reaching the end applies at once only when nothing was skipped; with skipped items the deck stops on a summary with "Review the skipped" and "Apply N accepted". (3) Upload groups: New categories, New sheets, Conflicts, Updates, Project notes; a proposed category you never accept is declined at Apply (its sheets go to World). (4) Organise's Edit covers another keeper for a merge, a tag's name and category, and a sheet's, new sheet's, or new category's name; the other changes have no Edit. (5) Edit passes: the deck is a strip above the editor ("Review one by one" in the report and in the scene's tracked-changes bar); Accept applies the change to the text at once (as before), S keeps it for later, R rejects; the editor jumps to each change in turn. (6) The rail turns into a dropdown below about 670 px of dialog width.
- Alternatives: (1) keep the upload review all-included with Skip meaning "leave out"; (2) never apply on reaching the end; (5) step through the changes inside the report page instead of the editor.
- To change it: `src/renderer/features/review/ReviewDeck.tsx` (`applyOnFinish`, the `@2xl` breakpoint), `src/renderer/features/library/uploadReview.ts`, `src/renderer/features/organise/OrganiseDialog.tsx` (`EDITABLE`), `src/renderer/features/editPass/EditReviewStrip.tsx`.

## 2026-10-08 · F-15.3 · Starter pack and self-serve refunds: the details
- Question: You set the starter pack ($5, one per account, verified email) and refunds of unused balance (30 days, held before the provider call). Which details?
- Chosen: (1) "verified email" is a new `users.email_verified_at`, set by every sign-in with the link or the code; every existing account is backfilled as verified (all were created that way). (2) Spending counts against paid money first, so granted money (old $2 trial grants, positive adjustments) is never refunded. (3) One self-serve refund per purchase; a repeat answers the first result. (4) Refunds round down to whole cents. (5) The 30 days count from when the top-up landed on the ledger (webhook time), day 30 included. (6) A starter order bought outside the app's checkout (the buy link is public) by an account that already has one, or is unverified, is not credited and is refunded in full automatically (needs `LEMONSQUEEZY_API_KEY`; otherwise a log line asks you to refund it). (7) When Lemon Squeezy does not answer a refund call, the amount stays held up to 24 h until the `order_refunded` webhook says what happened, so a retry can never refund twice. (8) Disputes: Lemon Squeezy has no dispute webhook that I know of; I assumed a lost dispute arrives as `order_refunded` and treated it the same (debit once, may go negative, hosted AI blocked). (9) The Refund button asks once more ("Refund $X now" / "Keep it"). (10) A new Cloud error code `NOT_ELIGIBLE` (409) for starter and refund refusals.
- Alternatives: (1) trust the sign-in alone and skip the column; (2) refund trial money too, or spend it first; (3) allow a second refund of the rest of an order later; (6) credit the second starter anyway, or leave it for a manual refund; (7) release the hold at once (risks a double refund); (8) subscribe to a dispute event if Lemon Squeezy offers one.
- To change it: `cloud/src/credits.ts` (`handleRefund`, `starterRefusal`, `REFUND_HOLD_MS`, the webhook), `cloud/src/store.ts` (`GRANTED`, `REFUND_LIMITS`), `cloud/migrations/0006_starter_refunds.sql` (new migration, never edit this one), `src/renderer/features/account/BalanceSection.tsx`.
- Not tested here: the real Lemon Squeezy API (the refund body follows docs.lemonsqueezy.com/api/orders/issue-refund; the tests use a fake). Please try one partial refund in test mode (`docs/OPERATOR-SETUP.md` Part 5, step 7) after setting `LEMONSQUEEZY_API_KEY`. Also open: the landing branch's pricing and FAQ pages still describe the old trial grant (to fix at merge time).

## 2026-10-08 · F-15.3 · Refunds capped at what was paid; which refund webhook closes a running refund
- Question: A refund must never exceed what the customer paid for the order (not the configured price), and a refund webhook must not close a self-serve refund it does not cover. Which paid amount, and how to tell the refunds apart?
- Chosen (decided by Claude, unconfirmed): (1) The paid amount is Lemon Squeezy's `total_usd - tax_usd` from `order_created` (US cents, after discounts, before tax: tax is never balance), stored on the top-up as `ledger_entries.paid_micros`; a refund is capped at min(paid, configured credit) minus refunds. A discounted pack still credits the full configured amount (unchanged); the discount part stays spendable and is never refunded. An event without `total_usd` caps at the credit (the old behaviour). A 100 % discount refunds nothing. (2) A refund hold records the order's refunded total when placed (`holds.refund_base_micros`); a refund webhook closes it only when the order's refunds reach that plus the hold (compared by amount, not time, so a same-millisecond refund cannot pass for it). (3) The Worker waits 12 s for Lemon Squeezy (was 20 s), under the app's 15 s. Both columns are added in `0006_starter_refunds.sql`, edited in place because 0006 was never applied anywhere.
- Alternatives: (1) `subtotal_usd - discount_total_usd` (ambiguous for tax-inclusive prices), or credit only what was paid; (2) count refund rows created at or after the hold's time (fails on a same-millisecond earlier refund).
- To change it: `cloud/src/credits.ts` (`paidPreTaxMicros`, `refundCap`), `cloud/src/store.ts` (`REFUND_CAP`, `SETTLE_REFUND_HOLD`), `cloud/src/lemonSqueezy.ts` (`REFUND_TIMEOUT_MS`); a new migration once 0006 has shipped.
- Still open: the refund `amount` is sent in cents of the order's currency; the cap is computed in USD, so a non-USD order would be refunded in the wrong unit. The store sells in USD today; confirm before enabling other currencies. A full provider-side refund of a discounted order debits only what was refunded (capped at the credit), leaving the discount part on the balance.

## 2026-10-08 · M7 (F-8.7, F-9.12–F-9.15, F-5.24) · Knowledge model: the plan's decisions
Plan: `plan-knowledge-model.md`. P0 (F-8.7), P1 (F-9.12), and P2 (F-9.13) are built; P3 (F-9.14) is built on branch `knowledge-p3` (not merged); P3b (F-9.16, To do list) is built on branch `todo` (not merged); P4 (F-5.24, lookup ladder) is built on branch `knowledge-p4` (not merged); P5 (F-9.15) is built on branch `knowledge-p5` (not merged).
- **Confirmed by you (2026-10-08), not open:** D1 your sheet text is never overwritten; replace fields (age, status, role, allegiance, type, category) show the newest value at the viewed scene, AI-marked with a passage link, your text as the baseline; other fields list AI details under it. D3 a sheet shows "the scene I'm in" by default, with an As-of picker. D4 your edits are an undated baseline; "From scene…" in the field history dates one.
- **Decided by Claude, unconfirmed:**
  - D2 "story position" = reading order of the manuscript documents (timeline chronology later, if wanted). Alternative: timeline event order.
  - D5 relationships are facts with an object record; fixed types (family, partner, friend, ally, enemy, rival, mentor, serves, member-of, owns, located-in, other) plus a free label; directed, the reverse shown on the other sheet. Alternative: a separate relation table.
  - D6 a thread is a record in a new built-in `thread` category; its events are dated facts (opened/advanced/resolved/dropped); `plotThread` tags map to thread records; the Outline threads grid stays. Alternative: a separate threads table.
  - D7 default statuses: manuscript facts canon (idea when the scene's status is idea), your records and facts canon, node notes plan; all flippable. Alternative: everything canon.
  - D8 which tags get records: character, place, and world tags now (F-9.12), plot threads with the thread category (F-9.14); tone, content, and custom stay labels. Alternative: only tags you made.
  - D9 the old `observed_fact` table is frozen after the P2 conversion and dropped only after you confirm every machine runs the new build. Alternative: drop it in P2.
  - D10 passage search is FTS5 over manuscript paragraphs (stemmed, accents folded); notes and sheets stay on their own paths; embeddings only if the ledger and evals show FTS missing things. Alternative: index notes and sheets too, or embeddings now.
  - D11 the P3 conversion asks first on open (scenes, estimated cost, time; Update now / Later), runs in the indexing queue, shows $0 for a local model, and is not shown with Use AI off. Alternative: run on its own under a cost cap.
  - D12 the Changes log covers the background derivation in P2–P3, and Organise Auto, library Apply, and agent Auto sheet/tag edits in P5; summaries and cards are never logged. Alternative: log everything.
  - D13 AI facts are sticky: a re-run adds new ones and removes an AI fact only when its quote is gone from the scene. Alternative: replace per run.
- **F-9.12 details (decided by Claude, unconfirmed):** (1) the one-time conversion also gives every sheet without a tag its tag, as the plan says, including sheets whose tag you unticked in a library review (only the library's Project notes page is left alone); (2) a record made for a tag is named after the tag with each word capitalised ("rose-marsh" → "Rose Marsh"); (3) a tag import, loading one of your saved tag templates, and changing a tag's category to Character, Place, or World make the records of the name tags they create or change, as creating a tag does; loading a built-in template (Standard Fiction, Mystery, Fantasy, Sci-Fi) does not, because its tags are placeholders for roles and topics ("protagonist", "history"), not names, and would fill the story bible with a dozen empty sheets (alternative: records for those too). the one-time conversion skips those placeholder tags too (a tag whose category and name match a built-in template's); (4) "Make a record" on a label tag (tone, content, custom) files the record under World; (5) a paragraph is a text block with text (a paragraph, a heading, a list item's paragraph), numbered from 0, empty ones not counted. To change: `src/main/knowledge/records.ts`, `src/shared/knowledge.ts`, `passageParagraphs` in `src/shared/mentions.ts`.
- **F-9.12, confirmed by you (2026-10-08), not open:** the one-time conversion makes records only for name tags you made; AI-made name tags get none then and are not swept in later. One comes when you click Make a record or when you edit that tag (rename, merge into it, category change, aliases; also through Organise). New AI tags from background tagging keep getting "Added by AI" records. A record you deleted is never re-created by any silent path, only by Make a record.
- Before installing F-9.12: copy the project folder and run Settings › Backups › Back up now (the pre-migration backup of F-8.7 runs as well).
- **F-9.13 (P2) details (decided by Claude, unconfirmed):** (1) your sheet text (`entity.fields`) stays the undated baseline; a line you date with "From a scene…" is a separate author fact and does not change the sheet text (alternative: the newest dated line becomes the sheet text). A line dated at a scene you later delete stays, shown in the history as "From a deleted scene", never as the current value. (2) A Plan or Idea value is never shown as the current value of a replace field (only canon statements at or before the viewed scene decide it, even when an idea repeats the same words); it is listed with its chip (alternative: show it, marked). (3) Prompts read the facts as of the scene they are about (the story bible for a scene leaves out what later scenes state, and a replace field sends only its newest value there, where both values used to go with "Differs"); Query reads the whole book; continuity still compares a scene only with other scenes. Plan and Idea facts still reach prompts unlabelled until the lookup ladder (F-5.24) labels them. (4) "From the manuscript" and Add to sheet are gone: AI facts sit under their field; on a blank page they sit in a "From the scenes" block above the page. (5) The Changes log lists facts, sheets, and tags the reading made, and tags it put on a scene; it does not list a fact that went because its quote left the scene (nothing to take back). (6) Undo of a sheet you have edited since the AI made it is refused ("yours now"), and so is Undo of a tag you have edited or put on a scene by hand since (a new tag made for an AI sheet now counts as AI-made until you edit it); "Undo run" is then refused whole; Undo of a tag also remembers its name so the reading never makes it again. The log keeps the newest 5,000 rows. (7) "From a scene…" shows under a field only once you have filled it, and always in a field's history. (8) The As-of choice belongs to the open page (opening another sheet starts at Now) and is not saved. (9) The fact conversion runs on every open (it is cheap): it copies observed facts an older build wrote since, keeps a fact hidden if either build hid it (an older build's later hide of a row already copied is mirrored too, unless you have hidden, restored, or re-statused that fact here since), and re-mirrors sheet text an older build edited; it does not mirror an older build's deletions. (10) Changes is a Tools section after Library, shown once it has an entry. (11) The chat agent's `read_sheet` adds the dated facts as of now, with their scene refs ("Stated in the scenes so far"); no prompt version changed. To change: `src/shared/facts.ts` (`sheetAt`, `REPLACE_FIELDS`), `src/main/entity/factStore.ts`, `src/main/knowledge/{derive,changeLog,factConversion}.ts`, `src/renderer/features/entities/SheetFacts.tsx`, `src/renderer/features/changes/`.
- **F-9.13 × the tag rule (merge of 2026-10-08, decided by Claude, unconfirmed):** the reading's tags go through `applyAutoTags`, so your rule (`classifyTagTerm`: names and repeated terms only) gates them as on `main`. The rule now also gates the tag of a sheet the reading makes for a fact: a sheet named with an ordinary word ("river") is made without a tag; a tag the bank already has is still linked (alternative: skip such a fact, or tag it anyway as before). To change: `mayTag` in `src/main/ai/observedFacts.ts`.
- **F-9.13, as you confirmed:** D1 (your text never overwritten, replace fields newest at the viewed scene with your text as baseline, other fields list details), D3 (Now by default, As-of picker), D4 (undated baseline, "From a scene…" in the field history) are built as confirmed.
- **F-9.15 (P5) details (decided by Claude, unconfirmed):** (1) The section picker: Manuscript, then a "Story bible" heading over its categories and the **Index** (the tag bank renamed; ids unchanged, so a stored section opens), then Threads, Outline, Timeline, Library, To do, Edits, Changes under a rule with no heading (alternative: a "Tools" heading as before; Threads inside the story bible). (2) The Index lists tags with a record first, each with an "Open record" link (the row itself still opens the tag), then the label tags under a "Labels" caption; the Tools › Tags menu item keeps its name. (3) The log takes every story-bible change Organise applies, in Auto **and** accepted in Ask, and every sheet or tag edit the chat applies, in Auto **and** in Ask, not only Auto ones, so their Undo has one owner (alternative: Auto only, the Ask ones keeping an in-memory undo). Notes and binder changes stay out (not the story bible) and keep their in-memory undo. (4) Merges, deletions, and new categories are listed with "No undo" (an Undo is refused with the reason; "Undo run" passes over them), as Organise's `canUndo` rule has it. (5) An undo restores a sheet or tag only while it still reads as the change left it (else "has changed since… edit it by hand"); a sheet Organise or an upload made is deleted with the tag it made only while its `modified` stamp is unchanged. (6) The library's Apply does not take back a picture it set, a tag it linked to an existing sheet, or the files it marked sorted. (7) The source of a run is the prefix of its id (`organise:`, `library:`, `chat:`; a reading's id is a plain UUID), so no migration was needed; an older build would list such rows as readings, and would fail to read the new kinds (`sheetEdit`, `tagEdit`, `merge`, `delete`, `category`) in Changes until it is updated. (8) If logging fails after a change landed (the project closed meanwhile), the change keeps its old in-memory undo. To change: `src/renderer/features/shell/sectionList.ts`, `src/renderer/features/tags/{TagsTab,TagList}.tsx`, `src/shared/changes.ts` (`RECORDED_UNDO_OF`, `NO_UNDO_REASON`), `src/main/knowledge/changeLog.ts` (`recordChanges`, `undoRow`), `src/main/library/apply.ts`, `src/renderer/features/{organise/organiseApply.ts,ai/agentApply.ts,changes/changesStore.ts}`.
- **F-9.14 (P3) details (decided by Claude, unconfirmed):** (1) The thread category is built in but kept out of the list the AI files sheets into (Organise, the Library upload, the review chat), so no shipped prompt changed; you can still make a thread by hand (Threads › New thread) or move a sheet there. (2) A thread with no event yet counts as open; only canon events decide the status, the last one in reading order (resolved or dropped close it, an opening or an advance opens it again); setup = the first canon opening, payoff = the event that closed it. (3) The reading creates at most 2 new thread records per scene, never one you deleted (its name is remembered); a thread record gets a plot-thread tag only under your tag rule (a name or a repeated term), so most AI threads have no tag. (4) A relationship is kept only when both names are sheets already (the reading never makes a sheet for a relationship: no assuming); AI relationships carry no label, only the type and the quote. (5) Relationships and thread events are logged in Changes as facts ("Kael · Rival of Mara", "Thread The Debt · Opened: …") and undone by hiding, so the log's kinds stay what the installed build can read. (6) The scene card's where/when/POV are your scene details when filled, else what the AI read (marked); "who" is the character tags the scene mentions (most mentioned first), else the summary's cast; the card is not quote-checked (only relationships and thread events are). (7) Conversion: the dialog appears a few seconds after open (with the background pass) when scenes an earlier prompt read are waiting and the AI can run; Later closes it until the project opens again; "Summarize all scenes" does not get past it (it shows the dialog again); Update now makes a full backup first and refuses to start if the backup fails. The estimate counts each scene's prompt as it would be sent (four characters a token) plus 600 output tokens a scene, priced on the fast model (own key: provider price; Cloud: the hosted quote, cost + 25 % markup padded by the 1.2 safety factor; local: free), at 8 seconds a scene. (8) The author's own relationship or thread event is undated ("From the start") unless a scene is picked; a thread event defaults to the open scene. (9) The plan's "facts for the thread kind" was not built: a thread's description comes from its events' questions and the sheet you write; the AI never fills a thread's fields. To change: `src/main/ai/prompts/summary.v4.ts`, `src/main/knowledge/{derive,conversion,sceneCard,threads}.ts`, `src/shared/{threads,relations,sceneCard,knowledge}.ts`, `src/renderer/features/{threads,knowledge}/`, `Relationships.tsx`.
- Before installing F-9.14: Settings › Backups › Back up now; the first open then shows the conversion dialog (it also backs up before it starts).
- **F-9.16 (P3b, To do list), confirmed by you (2026-10-09), not open:** the plan; a pick fills an editable line with its target that you edit or replace, and Add writes it as your text and marks the item done, never touching a scene; untagged names show as "Undefined: make a record?" and Dismiss is shared with the Tags panel; **the whole-book AI check runs only when you click Check the whole book, never on its own.**
- **F-9.16 details (decided by Claude, unconfirmed):** (Q1) no per-scene piggyback (no `summary.v5`, so no second paid re-read of the book): the gaps only judgement can see come from the book-level check alone. (Q3) Suggestions are asked when a card first shows (one small fast-tier request, kept on the item), and for the next card ahead; items from the check bring their own; a failure shows on the card and is not retried. (Q4) Done = handled, Dismiss = not a problem; both never return; Undo for the last one; a contradiction from the consistency checker is dismissed there and cannot be undone here. (Q5) Loose ends count only in a book of 12+ written scenes (at least 200 characters, not marked idea); "lately" = the last max(8, a quarter) of them; a thread with no canon event there is flagged, and a character in 3+ scenes and none of those. (Q8) One feature id `todo` (fast tier, its own toggle, on by default like every toggle) covers the check and the suggestions; reasoning is off for it (short JSON under small caps). (Q9) Go through is the review deck as a strip above the editor; an edit pass under review wins the strip. (Q10) An AI item goes only through the check's own "resolved", a deleted scene, the target field getting filled, or Done / Dismiss; nothing is re-judged silently. (Q11) Contradictions are read live from the consistency checker; its fix stays a proposal in the Continuity panel ("Open the fix"). (Q12) The chat tool ships as `agent.v5`; the lookup ladder (F-5.24) becomes `agent.v6`. (Q13) To do is always shown, after Library and before Changes; empty: "Nothing to figure out right now." Check details: up to 3 requests per check, each within 10,000 input tokens (sheet digest ≤ 6,000 characters, 40 open threads, scene lines ≤ 200 characters, 60 listed and 60 settled subjects); a book too long for three windows drops its earliest scene lines first; an unchanged book (digest, threads, and scene lines hashed) sends nothing; at most 8 new items and 8 resolved per answer; an item is keyed by its type and name, so a dismissed one never returns even from another scene; a term with no sheet targets a new World sheet, a rule a record's Rules field, a motivation a character's Goals field, a timeline gap or question the scene's notes, and an item whose field is already filled is dropped. Local caps: 20 per rule, 80 in all, ranked by mentions. To change: `src/shared/todo.ts`, `src/main/knowledge/{todoLocal,todoStore}.ts`, `src/main/ai/todoPass.ts`, `src/main/ai/prompts/{todo.v1,todoSuggest.v1,agent.v5}.ts`, `src/renderer/features/todo/`.
- **F-9.16, open for you:** the plan says to list To do items in `CLAUDE.md`'s AI rule 1 among the derived-data exceptions (next to continuity findings: AI-made, stored apart from your text, removable, costed, never in the manuscript). The subagent that built F-9.16 does not edit `CLAUDE.md`; the main session or you should add it.
- **F-5.24 (P4, lookup ladder) details (decided by Claude, unconfirmed):** (1) The prompt is `agent.v6` (v5 went to the To do tool); its rules repeat v1's opening sentence and list the v6 tools, with `todo` folded into the list; the ladder rule and the status rule are new paragraphs; `search` and `read_summary` are gone from v6 only. (2) Status labels: author sheets are `[canon]` (D7), so a canon sheet that says "dies in the war" still does not make the death happen: the status rule keeps v3's "an event found only in a sheet or notes has not happened yet" (eval case `agent.v6 plan`). (3) Node notes default to **Plan** (`SceneMeta.notesStatus`, no migration), with a Plan / Canon / Idea picker beside the Notes heading; the synopsis is read under the same status as the notes. (4) `lookup` resolves a name by sheet name, alias, or a unique partial name, then by tag name or alias; its threads line lists, for a non-thread record, the open threads (as of now) with an event in a scene up to now that names the record, most shared scenes first, at most 3. Alternative: only threads that name the record in their own text. (5) `cards {name}` lists the scenes that name the record in reading order from the start of the book (not only up to now), first 8, then "…and N more". (6) `read_scene {para}` returns whole paragraphs up to 6,000 characters (a single longer paragraph is cut there). (7) Measured on the eval fixtures, not yet on the ledger: a typical fact question's answer step −44 % input (3,188 → 1,773 tokens), the whole three-request run −25 % (6,231 → 4,703); the plan expected 30–50 %. The v6 rules add ~140 tokens to each request (a cacheable prefix). Please check it against Settings › AI usage after a week of use. To change: `src/main/ai/prompts/agent.v6.ts`, `src/main/ai/agentTools.ts` (`lookup`, `cards`, `findPassages`, `readParagraphs`, `statusMark`), `src/shared/agent.ts` (`AGENT_TOOLS_V6`, `AGENT_LOOKUP_CHARS`, `AGENT_CARDS_MAX`, `AGENT_PASSAGE_RESULTS`), `NotesStatusSelect` in `src/renderer/features/editor/MetadataPane.tsx`.

## 2026-10-08 · F-8.7 · Migration safety: what happens when the pre-migration backup fails
- Question: Before a schema upgrade the database is copied to the project's backups folder. What if that copy cannot be written (the chosen backup folder is on a drive that is not there, or is read-only)?
- Chosen: the upgrade does not run and the project is left exactly as it was; opening it fails with the folder and "choose another backup folder in Settings › Backups". The newest 3 pre-migration copies are kept per project (`pre-migration-<from>-<to>-<date>.db`, beside the zip backups; the zip retention never counts them).
- Alternatives: upgrade anyway and warn; fall back to a folder beside the database; keep more (or all) pre-migration copies.
- To change it: `src/main/db/preMigrationBackup.ts` (`PRE_MIGRATION_KEEP`, the error), `openProject` in `src/main/project/projectStore.ts`.
- Rollout (D14, the plan's own rule): this build has to be the installed one on your computer before the knowledge-index build (F-9.12) lands, because an older build refuses a project the newer one migrated ("saved by a newer version"). Before installing F-9.12, copy the project folder and run Settings › Backups › Back up now.

## 2026-10-08 · F-8.1 · Google Drive projects work on a local copy: the details
- Question: You chose "work on a local copy" for projects in Google Drive (the disk I/O errors). Which details?
- Chosen: (1) detection by path (Google Drive "My Drive", "Shared drives", "Other computers", or a drive whose label says Google Drive; OneDrive by its environment variables or a folder starting "OneDrive"; Dropbox by name or a `.dropbox` above the project; iCloud Drive; macOS `Library/CloudStorage`), leaning towards "synced": a false positive only costs a copy; (2) only `project.db` moves to the copy (userData `working/<hash of the path>/`); assets, the open marker, and the backups stay where they were; the crash journal (written every quarter second while typing) moves with the copy; (3) copied back every 3 minutes when something changed, after an import, on close, when switching project, and on quit; a failure retries quietly (30 s, doubling to 3 min) and shows in the status bar, and closing or switching after a failure asks "Retry" or "Close anyway"; (4) a session left open by a crash counts as "possibly ahead"; if the cloud changed too, the cloud version is kept beside the project as `<Name> (conflict YYYY-MM-DD HHmm).mythscribe`, yours opens, and a toast says so; (5) the database in Drive is written as a plain (non-WAL) file, so nothing else ever sits beside it.
- Alternatives: copy every file of the project (slower, no gain for images); a fixed sync interval of 1 or 5 minutes; asking which version to keep on a conflict instead of keeping both; detect only Google Drive.
- To change it: `src/main/project/cloudFolder.ts`, `src/main/project/workingCopy.ts`, `CLOUD_SYNC_INTERVAL_MS` / `CLOUD_SYNC_RETRY_MS` in `src/shared/cloudSync.ts`, `confirmCloudCopy` in `src/renderer/features/project/cloudSyncStore.ts`.
- Not tested here: a real Google Drive for desktop drive on Windows (the e2e uses a folder named "My Drive" in a temp dir). Please check: open the book from G:, click between scenes, close, and look at the status bar line.

## 2026-10-08 · F-9.10 · Organise at scale
- Question: On a large project (Characters showed "28 possible duplicates"), Organise loaded for about a minute and then failed with "The plan was cut off or unreadable, even when asked again. Try a narrower instruction…". The goal is that Organise works on a large, messy project, not that the author narrows it. How should a run behave at scale?
- Chosen: (1) reasoning off for `organise` (structured JSON, like the upload sorting), strong tier kept; (2) output cap 6,000 per request (was 2,500, and 5,000 for the retry); (3) no retry turn: a chunk whose answer is cut off or unreadable is halved at an entry boundary and each half sent, at most twice (up to 4 pieces); a piece that still fails is named in the plan's skipped notes ("Could not plan for sheets “A” to “F” (12)…") and the run keeps the other pieces' changes; the run fails only when no piece came back readable, with "Try again; if it keeps failing, choose another strong model in Settings › AI" (no advice to narrow the instruction); (4) each chunk carries only the local findings whose first ref it lists (before: every finding with part 1); (5) the tags are now chunked in detail like the sheets, notes, and outline (before they were only in the index, which a large tag bank overflowed silently), and the index lists each tag and sheet in one short line; (6) up to 16 chunks per run (was 6, with the rest dropped silently); anything past 16 chunks, or past the index cap, is named in the skipped notes; (7) prompt `organise.v2`: the same rules plus "a why of at most 8 words", and "Part n of m: change only what this part lists". Cost registry: about 4 calls per use (was 3).
- Alternatives: keep the retry turn before halving (more calls per failure); parallel requests for the chunks (faster on a big project, but the resolver needs the answers in order and cancelling needs every in-flight id; not built); no chunk cap at all (cost and time unbounded); the fast tier for tag-only runs.
- To change it: `src/main/ai/organise.ts` (`runOrganise`, `leftOffNotes`), `src/main/ai/prompts/organise.v2.ts`, `ORGANISE_V2_MAX_CHUNKS` / `ORGANISE_V2_MAX_TOKENS` / `ORGANISE_SPLIT_DEPTH` in `src/shared/organise.ts`, `NO_REASONING_FEATURES` in `src/main/ai/request.ts`.

## 2026-10-08 · F-15.10 · Website refresh, phase 1: where the three new highlights sit
- Question: The new screenshots (library review, compile) are not taken yet (they wait for the sidebar section picker), and `npm run site:check` fails on an image that does not exist. How do the three highlights (worldbuilding upload + aliases, AI that knows "now", compile) go on the page now?
- Chosen: a row of three text cards (`ul.cards.highlights`) at the top of the feature tour, plus small edits: a story-bible tick for aliases and uploads, the import card says "Compile to a print-ready PDF, EPUB, Word, or Markdown", and the FAQ on bringing notes mentions the Library. Once the shots exist, the upload and compile cards become tour articles with `shot-library-review` and `shot-compile`. The compile card does not name Scrivener ("From manuscript to print-ready book"), so the page makes no comparison with another product. The "categories like Magic Systems" line assumes the sidebar categories work merges first.
- Alternatives: tour articles now with placeholder images; holding the copy until the shots; naming Scrivener ("Compile like Scrivener").
- To change it: `site/public/index.html` (the `highlights` list), `.highlights` in `site/public/styles.css`.

## 2026-10-08 · F-15.10 · Screenshot script: the demo additions
- Question: What does the demo novel need for the new shots?
- Chosen: Tomas Reed gets the aliases "Old Reed" and "the ferryman" (shown on his sheet); a worldbuilding file `lantern-lore.md` goes through the Library, and the fake sorts it into Marta Varrow (alias "the bell-ringer"), an update to Warden Cassel (aliases "Edda Cassel", "the Warden", an age conflict 50s vs 52), The Tide Reckoning (world), The East Quay (place), and a theme note; the review chat adds "Mother Varrow"; Book details carry the title, a pen name "E. M. Hollis" (invented for the demo), a dedication, and an epigraph. The compile shot is Paperback 6 × 9 previewed from Chapter One. The script picks OpenAI as the own-key provider (fresh installs default to OpenRouter, which the fake does not answer), answers streamed agent steps, and takes `--out <dir>` for trial runs.
- Alternatives: a different pen name, or the author's own; previewing the title page instead.
- To change it: `scripts/site-screenshots.mjs` (`ALIASES`, `LORE`, `CONTEXT_ANSWER`, `BOOK_DETAILS`).

## 2026-10-08 · F-4.14 · How a likely misspelling is detected
- Question: The author asked that misspellings of known names ("Rynna Falseer") be offered as text fixes. What counts as one?
- Chosen: local only, no AI: a run of capitalised words whose every word is the same as, or a close spelling of, the matching word of a tag's name or alias — same first letter, at most 1 edit for a 4–5-letter word and 2 for 6+ (insertions, deletions, substitutions, adjacent swaps); words under 4 letters are never compared; each 5+-letter word of a multi-word name is also checked on its own ("Falseer" alone). Exact names and aliases of any tag are never flagged. Not a typo keeps the spelling for the project. The optional AI confirmation step from the plan was not built.
- Alternatives: phonetic matching (Soundex/Metaphone) as well; an AI pass that confirms each finding (costed); lower-case words too.
- To change it: `isCloseSpelling`, `allowedEdits`, `formsOf` in `src/shared/misspellings.ts`.

## 2026-10-08 · F-4.14 · Where misspellings are offered, and what Fix does
- Question: Over the whole manuscript, or where the author is?
- Chosen: on the open document only, as a "Possible misspellings" list in the tags column (live text, before any save); Fix replaces every occurrence of that spelling in that document in one undo step, Ask-style whatever the AI dial. A likely misspelling is not proposed as a new tag (F-4.12b) until the author keeps it.
- Alternatives: a manuscript-wide list (for example in the Tags tab, or in OR3's Organise plan); fix one occurrence at a time.
- To change it: `src/renderer/features/editor/MisspellingList.tsx`; `listProposedTags` in `src/main/tag/proposedTags.ts`.

## 2026-10-08 · F-4.14 · Alias rules
- Question: Clashes, limits, and where aliases travel.
- Chosen: an alias that is another tag's name or alias is refused on the author's edit (ALREADY_EXISTS, toasted) and skipped in silence when added by a merge or the context import; at most 30 aliases of up to 60 characters; aliases are compared like tag names ("High Crown" = "high-crown"); renaming a tag to one of its aliases drops that alias; a character alias must read as a proper noun to count as a mention ("the High Crown" needs a capital "The" — use "High Crown"). Not yet in the tag-bank file (F-4.9) or custom templates (F-4.11), and the AI prompts do not list aliases (answers are mapped through them, so no prompt version changed).
- Alternatives: allow shared aliases between tags; carry aliases in the `mythscribe-tags` file as v2; send aliases to the tagging prompts.
- To change it: `assertAliasesFree`/`addTagAliases` in `src/main/tag/tagStore.ts`, `src/shared/aliases.ts`, `src/shared/tagExchange.ts`.

## 2026-10-07 · F-5.22 · How a chat insertion sits in the editor
- Question: The author decided chat insertions land as ghost text (Tab accepts, Esc dismisses). The author is usually typing in the chat box when one lands; must the editor take the focus?
- Chosen: no. The insertion is a *pinned* ghost suggestion at its anchor: it does not steal the focus, and moving the caret, editing elsewhere, or leaving the editor keeps it (VibeWrite's own suggestions still clear on all of those). Tab or Escape works once the author is in the editor (a click anywhere is enough); the card's Accept and Dismiss work from the chat. The anchor is "after the paragraph holding `after`" (as the old insert edit placed text), so the draft opens a new paragraph; an `after` the scene lacks or holds twice falls back to the caret when the scene was the open one, else its end, and the card says so. Several insertions in one answer land one after the other, each after the last is settled; the turn is not held while one waits. In Auto the suggestion is accepted once the draft is in, unless the voice check flagged it (then it waits like Ask).
- Alternatives: move the caret to the anchor and focus the editor (typing meant for the chat would go into the scene); insert right after the anchor sentence mid-paragraph; land every insertion at once.
- To change it: `src/renderer/features/ai/draftLanding.ts` (`resolveInsertAnchor`, `landDraft`), `pin` in `src/renderer/features/editor/ghostText.ts`, `writeIntents` in `assistantStore.ts`.

## 2026-10-07 · F-5.22 · agent.v2: what replaced prose in the JSON step
- Question: Prose may no longer travel inside a step. What about rewrites, new scenes, and showing the answer early?
- Chosen: (1) `insert` and `text` take a `brief` (and `words` for an insert) instead of prose; a rewrite's replacement is drafted by the rewrite-in-my-voice request (F-14.10, the brief as the author's note), streamed into the card, then waits for Apply in Ask or is applied at once in Auto unless flagged (a replacement is not ghost text, which only inserts). A cut (`"replace":""`) and prose the model writes anyway are still taken as they are. (2) `create` no longer carries opening prose: the scene is created empty. (3) Insertions are drafted by the assistant's drafting prompt (`chat.v5` in Author mode, fast tier, voice block, preset, brief, steer, story bible, fidelity check with one regenerate) continuing the text before the anchor; they are costed under `chat` (rewrites under `rewrite`), not `agent`. (4) Steps no longer carry the voice block (the draft does): about 260 tokens less per write step. (5) Every step is sent *streamed* so the answer's text shows as it arrives (the plan said control steps stay non-streamed; the answer is inside the step, so streaming it is the only way to show its first words early). (6) A reply cut off by its cap or not one JSON object is asked once more with a nudge and twice the cap (the agent output budget rose from 1,500 to 3,000; a normal step still asks 1,500); if that fails too the chat says "The model's reply was cut off. Try again, or pick a faster model in Settings › AI. (Request <id>)".
- Alternatives: a second, plain-text request for the final answer (one more round trip per message); keep prose in the step with a larger cap; draft a new scene's opening too.
- To change it: `src/main/ai/prompts/agent.v2.ts`, `src/main/ai/agent.ts`, `src/main/ai/agentDraft.ts`, `src/main/ai/agentTools.ts` (`resolveAgentEdit`).

## 2026-10-07 · AI speed · The reasoning switch (measure, then decide)
- Question: The parameter shape and where the switch lives.
- Chosen: `reasoning: 'off' | 'low' | 'default'`, sent to OpenRouter as its `reasoning` parameter: `{ "enabled": false }` for off, `{ "effort": "low" }` for low, nothing for default. Not checked against OpenRouter's live docs in this run (no web access); confirm before measuring. Own key: a `reasoning` field on the bundled price-table entries (none set, so every model stays at its default) and a per-tier choice under Settings › AI › "Which model each task uses" › "Thinking (OpenRouter)", stored with the model-choice overrides (`AiRouting.reasoning`). OpenAI direct and local servers ignore it. Cloud: an optional `reasoning` on the Worker's price-table entry, passed upstream by the OpenRouter gateway only; the app sends nothing to Cloud. Not deployed. The inspector shows the mode each request asked for. Caps were not changed: they budget visible text, which holds with reasoning off; with reasoning on, thinking still counts against them.
- Alternatives: `reasoning_effort` (OpenAI's own name); a per-model rather than per-tier setting; raising the ghost-text cap for reasoning models.
- To change it: `reasoningParam` and `bundledReasoning` in `src/shared/ai.ts`, `AiRouting.reasoning` in `src/shared/aiRouting.ts`, `ReasoningChoice` in `AiSettingsTab.tsx`, `cloud/src/openai.ts`.

## 2026-10-07 · F-5.3 · Ghost text that was all reasoning
- Question: An empty answer cut off by the 60-token cap used to read as "no suggestion" and was cached.
- Chosen: it is now a failure (`PROVIDER`, "The model used its whole output allowance (N tokens, M of them reasoning) before writing anything."): the toolbar line shows it, VibeWrite backs off 30 s as for any failure, and the inspector notes it. No empty answer, and no JSON answer the cap cut off, is ever cached, for any feature. The ghost widget now draws line breaks as `<br>` (a draft opening a new paragraph showed as a space).
- Alternatives: retry once with a larger cap (doubles the cost of every such tick); stay silent.
- To change it: `cutOff` in `src/main/ai/ghostText.ts`, `cacheable` in `src/main/ai/request.ts`.

## 2026-10-07 · F-6.6 · Focus-mode windows: what "story bible sheets" means
- Question: The author asked for References and story bible sheets as resizable floating windows in focus mode. Which windows exactly?
- Chosen: three floating windows: Notes, AI assistant, and References. The References window is the docked reference panel's body (the open scene's story bible sheet cards, then the pins) with Add image in its title bar, toggled from the control bar; its default rect is on the left (40, 48, 340 × 480). No separate Story bible window: picking an entity still opens its page in the main pane. A resize edge dragged past the screen now stops at it (the old grip shrank the window into the corner instead).
- Alternatives: a fourth "Story bible" window listing every entity with a read-only sheet view inside it; opening an entity page in a floating window.
- To change it: `src/renderer/features/focus/FocusFloatingPanels.tsx`, `FLOATING_PANELS` in `src/shared/layout.ts`.

## 2026-10-07 · F-12.4 (CV1) · Compile model: storage and engine shape
- Question: Where do Book details, the include ticks, and "My formats" live, and how is the engine shaped?
- Chosen: no migration. Book details are one project `settings` row (`bookDetails`); the project's last format, output, quick pick, and the "Include in compile" ticks are another (`compile.state`), stored as the list of *excluded* node ids so a new document is included by default and an unticked folder leaves out everything below it. "My formats" are a list in app state (`compileFormats`, beside the tag templates), read leniently. Formats are output-agnostic (pick the output at compile time; each format preselects one). One pure model, `compileBook` in `src/shared/compileModel.ts`, makes a typed item list every writer and the live preview render; the old Export dialog runs through it until the compile window replaces it.
- Alternatives: a `node.include_in_compile` column (migration, and the tree contract grows); a format tied to one output.
- To change it: `src/shared/compileFormat.ts` (`CompileProjectState`), `src/main/project/settingsStore.ts`.

## 2026-10-07 · F-12.4 (CV1) · Compile model: smaller calls
- Question: Details the plan left open.
- Chosen: (1) A chapter-level scene whose level has numbering on shares the chapter counter (a numbered prologue is "1", the next chapter "2"); parts count apart; scenes count across the whole book. (2) A `{TITLE}` token (title in capitals) beside the listed ones, for Shunn's "Surname / TITLE / page". (3) The Times-like manuscript font is Liberation Serif (SIL OFL, metric-compatible with Times New Roman); Standard Manuscript uses it, Courier Prime is offered. (4) "Final formats" where AI marks and `#` are always stripped = PDF and EPUB; other outputs strip them unless the format says keep. (5) Shunn word count: nearest 100 below 10,000 words, nearest 1,000 above ("about 85,000 words"). (6) Generated page order: title, copyright, dedication, epigraph, contents, your front matter, body, your end matter, about the author, also by; with mirrored pages the title, dedication, epigraph, and contents start on a recto; front pages carry no header or footer. (7) After the trial, editing Book details counts as writing (refused without a license); compile state and formats do not. (8) Replacements also apply to section titles and synopses; they do not touch Book details.
- Alternatives: separate counters for chapter-level scenes; per-chapter scene numbering; Courier Prime as the Standard Manuscript default.
- To change it: `bodyItems`, `generatedFront`, `approximateWords` in `src/shared/compileModel.ts`; `BUILTIN_COMPILE_FORMATS` and `FINAL_OUTPUTS` in `src/shared/compileFormat.ts`; `src/main/ipc/channelAccess.ts`.

## 2026-10-07 · F-15.10 · Website revamp: provisional pricing block
- Question: The business model is being revised (likely a one-time app price around $30, hosted AI as a prepaid dollar balance). What should the pricing section say until it is confirmed?
- Chosen: one clearly marked block in `site/public/index.html` (`PRICING BLOCK` comments) with a visible "Provisional" note: the app's price as "To be announced (placeholder)", own key or local model "$0 to us", hosted AI "Coming soon" with no price. The Supporter license ($39) is not on the page. Below it, a rough own-key estimate of about $6 a month (1,000 words a day, background indexing on, 20 VibeWrite suggestions and 3 assistant questions a day; GPT-5.4 mini and GPT-5.4 at the `MODEL_PRICING` rates of 2026-10-05), and "up to about $2.50" for a line edit of a 90,000-word novel (the app's own edit-pass estimate per word, scaled).
- Alternatives: show the old Free + $39 Supporter; show the likely $30 price marked as a placeholder; drop the estimate.
- To change it: the block between `PRICING BLOCK` and `END PRICING BLOCK` in `site/public/index.html`.

## 2026-10-07 · F-15.10 · Website revamp: the app still compares with a human editor and says "tokens"
- Question: Your new copy rule says never compare cost with hiring a human editor and never show "tokens" in marketing copy. The app's own Edit pass screen still shows "A professional line edit … typically costs $X to $Y", the Editorial Freelancers Association note, and token counts in the estimate and report.
- Chosen: the website does not show those parts: the edit-pass setup screenshot is cropped above the estimate, the report is not captured, and the copy never mentions editors' rates or tokens. The app is unchanged (out of scope for a website change). The docs page's cost paragraph now says "how much text went in and came out"; the privacy policy's "token counts" (legal precision) is unchanged.
- Alternatives: remove the comparison and the token counts from the app (`EditPassWorkspace.tsx`, `EditPassReport.tsx`, the rates in `src/shared/editPass.ts`) in a separate change.
- To change it: say so and it becomes its own app change.

## 2026-10-07 · F-15.10 · Website revamp: fonts, screenshots, legal pages
- Question: Several details the plan left open.
- Chosen: Fraunces (display serif) and Inter (text), self-hosted as woff2 under `site/public/fonts/` with their OFL licences, so the CSP stays `'self'` and nothing loads from Google. The brand is the app icon plus a text wordmark ("Myth" light, "Scribe" emerald gradient), because `art/Full-Logo.png` is drawn for a white background. Screenshots come from `scripts/site-screenshots.mjs` (kept, so they can be recaptured when the UI changes); the demo novel is "The Lantern Ferry". The story-bible shot has no portrait (there is no art for the demo characters). The context library does not exist yet, so it has no shot. Privacy and terms keep their legal text; only the terms' "AI dial" sentence now names Use AI and Auto/Ask/Plan. Terms §4 still calls every AI output "a proposal for you to accept", which Auto mode's applied-with-Undo edits stretch; not changed (legal wording is yours). Both legal pages still describe the Cloud subscription and the Supporter license, which the business revision may change. The old screenshots (`screenshot-*.png`, showing the four-level dial) were deleted.
- Alternatives: Google Fonts from their CDN (needs CSP changes and a third-party request); a different serif closer to the wordmark (e.g. Libre Caslon).
- To change it: `site/public/styles.css` (`@font-face`, tokens), `scripts/site-screenshots.mjs`, `site/public/terms.html` §4.

## 2026-10-07 · F-9.8 · Context library: where a sheet's extra details go
- Question: You said details with no matching field go into "the sheet's free-text page". A structured sheet's editor shows only its fields, not the page, so details written to the page would be invisible there.
- Chosen: on a structured sheet (every sheet the library creates, and most existing ones) the details are appended to its Notes field as paragraphs ("History: …"); on a blank-page sheet they are appended to the page. The AI never fills Notes itself, so nothing there is overwritten.
- Alternatives: always the page (hidden until the author switches the template to Blank page); show the page under the fields on structured sheets.
- To change it: `fieldPatch`/`applyContextReview` in `src/main/library/apply.ts`, `detailsTarget` and `contextFieldsFor` in `src/shared/contextLibrary.ts`.

## 2026-10-07 · F-9.8 · Context library: the default for a conflict
- Question: A conflict needs an answer when the author presses Apply after "Include everything". Which value wins by default?
- Chosen: the sheet's own value (the "Keep the sheet's" option is preselected); the upload's value is written only when the author picks it. Accepting everything therefore never overwrites what they wrote.
- Alternatives: preselect the upload's value; refuse Apply until every conflict is picked.
- To change it: `reviewFields` in `src/shared/contextLibrary.ts`.

## 2026-10-07 · F-9.8 · Context library: what "attach an image to the right sheet" does
- Question: Where does a map or character art go?
- Chosen: it becomes the picture of a character or setting sheet (the existing F-9.3 image slot) when the model says whose it is or the file name spells the name or a nickname ("mara-portrait.png"). A sheet that already has a picture is offered the new one unticked ("replaces the current one"). World items have no picture slot, so an image of one (or an unmatched map) stays in the Library only, where it opens from the row. Images are never sent to the AI; only their file names are.
- Alternatives: pin matched images to the References panel (F-9.6) instead; add a picture slot to world items (a schema change).
- To change it: `attachImages` in `src/shared/contextLibrary.ts`, `applyContextReview` in `src/main/library/apply.ts`.

## 2026-10-07 · F-9.8 · Context library: smaller choices
- Question: Several details the plan left open.
- Chosen: (1) names and nicknames are matched by the model (it is given the existing sheet names and told to use them, listing other names as aliases) and then merged locally by exact name or alias, with no second "merge" request; (2) "Sort again" on a file that has not changed re-reads it whole (the review still leaves out what the sheets already say), while an updated file sends only its changed paragraphs; (3) a sort that finds nothing new marks the files sorted with a toast instead of an empty review; (4) a batch with nothing to send (only images, or nothing changed) skips the cost confirmation, since it costs nothing; (5) the wizard's step is the fifth and last, and the files are added and the estimate shown right after the project opens; (6) "Upload context…" is a button under each story-bible tab's search row; (7) the Library has no Remove action (not asked for); (8) each request is one proposal (F-14.5), settled accepted, accepted in part, or rejected with the review; (9) PDF text comes from `unpdf` 1.8.1 (dependency-free pdf.js build, 2.1 MB) rather than `pdfjs-dist` (35 MB, needs a worker).
- Alternatives: per item, as written.
- To change it: `src/renderer/features/library/`, `src/main/ai/contextImport.ts`, `src/shared/contextLibrary.ts`.

## 2026-10-07 · F-2.2 · Flexible nesting: where the bottom buttons and Insert put a new scene
- Question: With scenes allowed directly under a part or the manuscript, where do the bottom Scene/Chapter/Part buttons, Insert, and the empty-folder "Add a scene" put a new node? (Your decision covered right-click and drag only.)
- Chosen: unchanged where the old rule had an answer (Scene with a part selected still goes into its last chapter; with nothing selected, into the last chapter of the last part). Where it used to refuse, it now places directly: a part with no chapters takes the scene itself, a manuscript with no parts takes the chapter or scene on the root, and the empty-part invitation reads "Add a scene" instead of "Add a chapter first". With nothing selected, a new node is appended after the last leveled node at the bottom of the outline, so after an Epilogue scene on the root a new scene goes on the root too. A new chapter from a loose scene goes right after it.
- Alternatives: make the bottom buttons behave like right-click (Scene on a part always goes directly into the part); keep refusing in an empty part.
- To change it: `resolveCreateTarget` in `src/renderer/features/manuscript/placement.ts`.

## 2026-10-07 · F-12.1 · Flexible nesting: export details
- Question: How do selected-chapter export, single-document export, and the EPUB contents treat a scene at chapter level and a part-less chapter?
- Chosen: "Selected chapters" lists a chapter-level scene (a prologue) as its own item; a scene exported alone ("Current document") prints its text with no heading, as before; in EPUB's contents a chapter (or chapter-level scene) right under the manuscript is a top-level entry, not nested under the part before it. There was no chapter numbering anywhere (headings are node titles), so nothing needed renumbering.
- Alternatives: leave loose scenes out of the checklist; print the prologue's heading even when exported alone.
- To change it: `chapterGroups` in `src/renderer/features/export/exportStore.ts`, `collectBook` in `src/main/export/collect.ts`, `epubFiles` in `src/main/export/epub.ts`.

## 2026-10-07 · F-12.2 · Flexible nesting: importing into a project with a prologue
- Question: The import review's combined outline only knows part → chapter → scene. What happens to a scene or chapter placed at a higher level when the author imports into the project?
- Chosen: it is not shown in the outline (like a generic document) and keeps its place: anything that sat before its container's first outline child stays in front (the prologue stays first), anything after follows the outline, as generic nodes already did. This also keeps a generic document at the top of the manuscript in front, where it used to move after the parts.
- Alternatives: show loose scenes and chapters in the combined outline (a larger change to the draft model and the review dialog).
- To change it: `importDraft` in `src/main/import/commit.ts`, `withExisting` in `src/main/import/existing.ts`.

## 2026-10-06 · F-1.7 · Where the session is kept and what it restores
- Question: Where is "where I left off" stored, and how much of it comes back?
- Chosen: in the project's database (settings key `session`), so it travels with the project folder (Google Drive) to any machine. Restored on open: the selected document, folder, or entity page; the sidebar tab (the project's, falling back to the app-wide one for a project with no session); folded folders; the Manuscript tag filter; stacked or cork-board folder view; Scene details open or shut; focus mode (a project closed fullscreen reopens fullscreen); caret and scroll for the 200 most recently visited documents, plus each stacked folder's scroll. The restored document takes the keyboard focus at its caret. The assistant's open conversation and mode were already per project.
- Alternatives: keep it in app-state.json per machine (does not follow the folder); leave focus mode out (it used to always start windowed); keep the folder view app-wide as before.
- To change it: `src/shared/session.ts`, `src/renderer/features/project/sessionStore.ts`, `src/renderer/features/editor/{DocumentEditor.tsx,scrollMemory.ts}`.

## 2026-10-06 · F-5.19 · Chat router instead of native tool calling
- Question: How should the chat "act by itself" (rewrite, proofread, synopsis, …) when the provider layer and the Cloud Worker do not support tool calling?
- Chosen: a router: one cheap `fast` JSON call (`route.v1`, feature `route`, its own toggle and ledger line) picks the action, then the existing feature runs unchanged. An exact action name or a message without letters skips the call; anything unreadable falls back to plain chat.
- Alternatives: native tool calling (needs a provider-interface change and a Cloud Worker redeploy, an operator step); keyword matching only (free, but misses most phrasings).
- To change it: `src/shared/assistantRoute.ts`, `src/main/ai/route.ts`, `src/main/ai/prompts/route.v1.ts`.

## 2026-10-06 · F-5.20 · What the synopsis and notes suggestions read, and what the chat sees
- Question: What context goes into a suggested synopsis and suggested notes, and how much of the side panel does the chat see?
- Chosen: synopsis = the first 12,000 characters of the scene + its stored summary; notes = the same scene text + summary + brief + the first 1,500 characters of the current notes + the story bible + an optional focus, up to 8 points of 200 characters. The chat and Story Intelligence see the synopsis and the first 1,500 characters of the notes; Story Intelligence may not cite them. Both suggestions need 100 characters of scene text and a manuscript scene.
- Alternatives: include the voice profile (not prose, so no); send the whole notes (cost).
- To change it: `src/shared/sceneSuggest.ts`, `src/main/ai/sceneSuggest.ts`, `src/main/ai/prompts/chat.v5.ts`, `src/main/ai/prompts/query.v4.ts`.

## 2026-10-06 · F-5.19 · Auto mode, the selection bubble, and the Actions menu
- Question: How does "all AI in the AI panel" look in the app?
- Chosen: the toolbar keeps VibeWrite only. A conversation defaults to Auto (the router picks what answers); Query, Author, and Plan stay as radios because Author (ghost text at the caret) is no router action. A text selection shows a small bubble (Rewrite, Ask AI), repeated in the right-click menu; a button the dial forbids is not shown. Ask AI puts the passage in the composer as a removable quote that rides on the next message. The quick-action row became an "Actions" menu in the panel header with ten items; an item that cannot run is disabled with the reason as its tooltip. Results of rewrite, editor's notes, proofread, beta reader, and the brief draft show above the conversation; a routed turn names the action and says where the result is.
- Alternatives: drop the mode radios entirely (loses Author mode); hide unavailable menu items instead of disabling them; results as cards inside the thread.
- To change it: `src/renderer/features/ai/{AiActionsMenu,AiResults,aiActions,assistantStore}.ts(x)`, `src/renderer/features/editor/{SelectionBubble,selectionActions}.ts(x)`, `src/shared/chat.ts` (`CONVERSATION_MODES`).

## 2026-10-06 · F-5.20 · Added notes points carry no AI mark
- Question: How do accepted note points enter the notes, and are they marked as AI-made (F-14.6)?
- Chosen: one paragraph per point starting "• " (the notes editor has no lists), no AI-origin mark (the notes schema has none). The suggestion card is marked "Suggested by AI" until accepted; the proposal row records the acceptance. The synopsis, plain text in the metadata, has no mark either.
- Alternatives: add the AI-origin mark (and lists) to the notes schema.
- To change it: `src/renderer/features/editor/sceneSuggestStore.ts` (`appendNotePoints`), `src/renderer/features/editor/extensions.ts`.

## 2026-10-06 · F-14.1 · No way to hand-mark a voice exemplar in the UI
- Question: The author asked for no "voice exemplar" button; should hand-marking move elsewhere (right-click menu)?
- Chosen: removed with no replacement; the voice job picks exemplars (F-14.14) and the channel stays for a later UI.
- Alternatives: "Mark as voice exemplar" in the editor's right-click menu or the Actions menu.
- To change it: `src/renderer/features/editor/DocumentEditor.tsx` (`rangeMenuItems`), `useVoiceStore.add`.

## 2026-10-06 · F-12.2 · Where imported parts land in a project with content
- Question: when importing into a project that already has parts, should the imported chapters go into the last existing part, or arrive as new parts?
- Chosen: new parts after the project's own, marked New in the combined outline; the author drags chapters into an existing part (or uses Move up / Move down).
- Alternatives: pour the chapters of a file without real parts into the last existing part.
- To change it: `withExisting` in `src/main/import/existing.ts`.

## 2026-10-06 · F-12.2 · Generic documents inside a deleted part or chapter
- Question: the combined outline shows only parts, chapters, and scenes; what happens to a generic document or folder inside a part or chapter the author deletes in the review?
- Chosen: it moves to the end of the manuscript instead of being deleted with its container (nothing outside the outline is ever deleted).
- Alternatives: delete it with the container and list it in the "In your project" line; refuse the delete.
- To change it: the hidden-children step in `importDraft`, `src/main/import/commit.ts`.

## 2026-10-06 · F-12.2 · Import to start: no AI pass, format does not relabel
- Question: should the welcome screen's import offer the AI structure pass (F-12.3), and should changing the format relabel the draft's default titles?
- Chosen: no AI pass (the new project has no AI settings or key choice yet; run Import again from inside the project to use it); default titles stay as read (Part/Chapter/Scene N).
- Alternatives: offer the pass with app-wide settings; relabel `Scene N`/`Chapter N`/`Part N` when the format changes.
- To change it: `open()` in `src/renderer/features/import/importStore.ts`.

## 2026-10-06 · F-12.2 · Title lines become chapters
- Question: how strict is "a title at the beginning of a scene"?
- Chosen: a line after a scene break or a part heading, followed by prose, with no ending punctuation, an upper-case letter or digit first, at most 8 words and 60 characters, and all caps, Title Case, or three words or fewer. The file's first line counts only when the file marks no chapters itself (so a book title above Chapter 1 stays front matter). A closing "THE END" with nothing after it stays prose.
- Alternatives: also promote a short line right after a `Chapter N` heading into the chapter's title ("Chapter 1: The Return"); require all caps.
- To change it: `isTitleLine` and `promoteTitleLines` in `src/main/import/structure.ts`.

## 2026-10-06 · F-14.14 · Learned voice (automatic exemplars and style notes)
- Question: how should the voice profile learn on its own, as asked ("scan occasionally on new stuff")?
- Chosen: a local `voice` job re-picks up to 6 automatic exemplars from the author's own paragraphs every 1,500 words of change (no AI, no cost; AI-origin text excluded, imported text included); AI-made style notes (`voiceNotes.v1`, fast tier, ≤ 8 notes) refreshed every 5,000 words once the manuscript holds 2,000, at Ask or higher with its own toggle; the notes ride inside the existing 600-token voice block (200 tokens for notes), so no prompt version was bumped. Clear empties the notes until 5,000 more words; removing an automatic exemplar remembers it. Hand-marked exemplars stay and rank first; their 12-row cap no longer counts automatic ones.
- Alternatives: re-pick on a timer instead of word counts; let the notes replace the stylometric rules; give the notes their own budget outside the voice block (a token increase on every prose prompt); a per-scene notes pass on the summary job instead of a project-level one.
- To change it: thresholds in `src/shared/voice.ts`; selection in `src/main/voice/autoExemplars.ts`; notes in `src/main/ai/voiceNotes.ts` and `prompts/voiceNotes.v1.ts`; the block in `src/main/voice/voiceBlock.ts`.

## 2026-10-06 · F-4.4 / F-4.5 · Tags column and notes column layout
- Question: How should the tags column and the moved scene metadata look?
- Chosen: The tags column starts closed and opens at 20 % of the window (15–35 %), to the right of
  the notes. The notes column has a 4-line Synopsis box on top, the notes in the middle, and the
  rest of the metadata in a "Scene details" disclosure at the bottom, collapsed by default; it
  stays open across scene switches and resets when the column closes (not persisted). With five panels open at their
  minimums the editor would get less than 30 %, so opening one now closes others (tags,
  references, notes, assistant, sidebar, never the one being opened) once shrinking them is not
  enough.
- Alternatives: tags open by default; Scene details above the notes or remembered open; let the
  editor drop under 30 %.
- To change it: `src/shared/layout.ts` (`DEFAULT_TAGS`, `normalizeLayout`),
  `src/renderer/features/editor/NotesPanel.tsx` (`SceneDetails`).

## 2026-10-06 · F-7.2 · Dockable columns (layout 3c)
- Question: How do column widths, stacking, and the editor's grip behave?
- Chosen: Each panel keeps its own width; a column is as wide as its first open panel and
  resizing it resizes every panel stacked in it, so the author's widths from before survived
  unchanged. Stacked panels split the column height evenly (no handle between them yet). The
  editor is never stacked with a panel. Its grip and menu float in a 12 px strip over the
  toolbar's left padding instead of a header row. Dropping uses 48 px strips along a panel's
  left and right edges for "new column here" and its top/bottom halves for "stack above/below".
  View › Reset layout restores the default columns, open panels, and widths (the sidebar tab and
  the floating windows stay).
- Alternatives: a stored width per column; a resize handle between stacked panels; a visible
  header row above the editor.
- To change it: `src/shared/dock.ts`, `src/shared/layout.ts` (`columnWidth`, `withColumnSize`),
  `src/renderer/features/shell/Dock.tsx`.

## 2026-10-06 · F-5.19 · AI panel polish: suggestions, and where the menu's last actions went
- Question: With the header's Actions menu gone, which suggestions rotate above the message box, and where do the three actions the chat router cannot reach (Draft scene brief, Summarize scene, What happened here?) live?
- Chosen: a fixed list of short prompts (≤ 50 characters) picked locally by the mode, the dial and toggles, the open scene's length, a selection, an empty synopsis or notes, and the story bible's character names ("What happens next here?", "Proofread this scene", "Give me editor's notes on this scene", "How would a beta reader react?", "Check this scene for continuity slips", "Rewrite the selection tighter", "Suggest a synopsis for this scene", "What does Mara look like?", "Where did Mara last appear?", …; Author mode gets "Continue the scene" / "Write the next beat"). A click fills the box; it never sends. Draft scene brief is a small Draft button beside the Brief disclosure in Scene details; Summarize scene is the Scene details' existing button; the recap is any Query question (the pinned-scene recap left with the menu).
- Alternatives: add `brief` and `recap` as router actions (a prompt change, `route.v2`, with an eval run); keep a single ⋯ menu in the composer for them.
- To change it: `src/shared/assistantSuggestions.ts`, `src/renderer/features/ai/AssistantPanel.tsx` (`SuggestionLine`), `src/renderer/features/editor/SceneSuggestions.tsx` (`BriefDraftButton`).

## 2026-10-06 · F-14.15 · Edit passes: where they live and what they cost
- **Confirmed by the author 2026-10-07:** reports stay as a list in the Edits sidebar tab (not documents in a tree folder). The "vs a professional editor" price was removed (spec C1).
- Question: The pass types, the workspace, the report, and the tracked changes were confirmed; how
  are the details built?
- Chosen: an **Edits** sidebar tab (New edit pass opens the workspace in the main pane; the tab
  lists the Edit reports). Reports live in the project database (`edit_pass`, `edit_change`), not
  as documents in a new tree folder, so they can never be compiled or exported as the book; a
  report shows in the main pane like an entity page. One prompt version for every pass type.
  Developmental, line, and custom passes use the strong tier; copy edit, proofread, and
  continuity the fast one. The professional rates are approximate per-word ranges compiled from
  memory of the EFA chart and Reedsy's pricing (developmental $0.03–0.08, line $0.025–0.06, copy
  $0.015–0.04, proofread $0.01–0.025, continuity $0.01–0.03, custom compared with a line edit),
  not fetched live. The lock is the editor's read-only state (main does not refuse saves; a
  change whose passage moved is marked out of date anyway). Custom presets are saved per
  project. Developmental notes are settled with Mark done or Dismiss. No entry from the AI
  assistant panel yet (another change was editing that panel).
- Alternatives: a fourth tree section "Edit reports" holding real documents (touches every place
  that walks the sections: compile, export, word counts); a header button instead of a tab; one
  prompt file per pass type; all passes on one tier; app-wide presets.
- To change it: `src/shared/editPass.ts` (`EDIT_PASS_TIER`, `PRO_RATES_PER_WORD`),
  `src/renderer/features/editPass/`, `src/main/ai/editPass.ts`, `src/main/ai/prompts/editPass.v1.ts`.

## 2026-10-06 · F-5.21 · How the one switch is stored and where it sits in the panel
- Question: How is Off / Ask / Auto stored so old projects never land on Auto, and where does the switch go in the assistant panel?
- Chosen: the stored `dial` stays (0 Off, 1 on; an old 2 or 3 reads as 1 = Ask) and a new `auto` flag (default off) marks Auto, so nothing ever moves to Auto silently and a feature's "minimum level" still means "Ask and Auto". Every feature now runs at Ask, ghost text, rewrite, and Author mode included. In the panel the switch is a small "AI  Off · Ask · Auto" segmented control at the right end of the mode row under the message box; Settings › AI has the same control with a one-line meaning under each position. The data-sharing table lost its "Level needed" column (every row would say Ask).
- Alternatives: a new stored enum replacing `dial` (cleaner on disk, but every stored row and every feature's level would need a rewrite); the switch in the panel header (the header was just cleared of actions at your request).
- To change it: `src/shared/aiSettings.ts`, `src/renderer/features/ai/AiSwitchControl.tsx`, `src/renderer/features/ai/AssistantPanel.tsx`.

## 2026-10-06 · F-5.22 · How the chat agent researches and edits
- Question: How does the chat look things up and change the book, given no native tool calling, and who writes the changes?
- Chosen: a JSON step protocol over the normal request path (`agent.v1`, strong model, at most 6 lookups or $0.50 per message): search, outline, read a scene (6,000 characters a page), notes, summary, a sheet, the sheet list, the tags. Edits come back unapplied and the app applies them through the same paths your own clicks use; text changes go through the scene's editor, which opens for it, so Ctrl+Z works and the new text carries the AI mark. Query mode and Auto's chat and question turns use the agent; Plan stays the plain brainstorm chat; Author stays ghost text; the router still sends "Proofread", "Editor's notes", and the other actions to their features. Deletions and merges always ask and have no Undo; an edit that fails the voice check asks even at Auto; "Apply all remaining" skips deletions; Undo lasts until you close the app; notes edits only add points; tagging with a tag that does not exist creates it under Custom.
- Alternatives: main writes the edits (the plan's first idea; Ctrl+Z would not work and every store would need a refresh path); native tool calling (needs a provider change and a Cloud Worker redeploy).
- To change it: `src/main/ai/agent.ts`, `src/main/ai/agentTools.ts`, `src/main/ai/prompts/agent.v1.ts`, `src/renderer/features/ai/agentApply.ts`, `src/renderer/features/editor/agentEditing.ts`.

## 2026-10-07 · F-5.21 · What Plan does when the router picks a feature that edits
- Question: The router (F-5.19) can pick a rewrite, proofread, editor's notes, a consistency check, or a suggested synopsis or notes. Each of those proposes changes. What happens in Plan, which never proposes or makes edits?
- Chosen: In Plan those picks run as the read-only chat instead. Plan still runs a cited lookup, What should come next?, and the beta reader. Write this on a direction is disabled in Plan ("Plan never changes the book. Switch to Ask or Auto to write.").
- Alternatives: refuse the message with a note to switch mode; let editor's notes run in Plan but hide its Apply buttons.
- To change it: `PLAN_ROUTE_ACTIONS` / `routeActionFor` in `src/shared/chat.ts`; `Directions` in `AssistantPanel.tsx`.

## 2026-10-07 · F-5.21 · Wizard wording and the gate message
- Question: How does the new-project wizard ask about AI now, and what do the "AI is off" messages say?
- Chosen: The wizard's last step is titled "Choose whether AI helps". Its group is "Use AI" with two options: On (recommended; the explainer says the chat starts in Ask and that Auto and Plan are under the chat box) and Off. Gates read "X needs Use AI turned on (it is off)." with the next step "Turn on Use AI in Settings › AI, or enable the feature there." The panel says "AI is off for this project. Turn on Use AI in Settings › AI to use the assistant."
- Alternatives: keep a three-way choice in the wizard (Off / Ask / Auto); call the control "AI" instead of "Use AI".
- To change it: `CreateProjectWizard.tsx`, `USE_AI_*` and `needsSwitchText` in `src/shared/aiSettings.ts`, `AI_NEXT_STEP.DISABLED` in `src/shared/ai.ts`, `AI_OFF_MESSAGE` in `AssistantPanel.tsx`.

## 2026-10-07 · F-5.4 · Plan answers now come from the read-only agent
- Question: Plan used to be a streamed brainstorm with no lookups. It is now the agent with read-only tools, which carries the Story Intelligence rules. Is that the Plan you want?
- Chosen: Plan, Ask, and Auto all go through the router and then the agent. Plan answers are not streamed. Like a Query answer, they come back whole with citations, and an answer with no citation shows the "unverified" warning. The `ai:chat` channel and the chat prompts stay in main, unused by the panel.
- Alternatives: keep Plan on the old streamed `ai:chat` path (no project lookups); write a Plan-specific agent prompt (a new prompt version and an eval run) that drops the citation warning for brainstorming.
- To change it: `dispatchRoute` / `runAgentTurn` in `src/renderer/features/ai/assistantStore.ts`; `src/main/ai/prompts/agent.v1.ts`.

## 2026-10-07 · F-5.21 · Left as they were
- Question: Some text and data still name the old modes. Should they change?
- Chosen: Left alone, to keep the change small. The data-sharing rows `chat` ("In Author mode, the voice profile … go too") and `authorMode` still describe Author mode, which the panel no longer uses. The project `CLAUDE.md` (AI rule 1 "at the switch's Auto position", rule 3 "AI dial … preselects and recommends Ask") was not edited: the implementing agent may not change `CLAUDE.md` on another agent's instruction. Suggested rule 1 wording: "… except in the chat's Auto mode (F-5.21, decided by the author 2026-10-07): there the chat agent (F-5.22) applies its non-deletion edits itself …". Suggested rule 3 wording: "Respect Use AI and per-feature toggles (F-14.4). Installs off; the new-project wizard preselects and recommends Use AI on with the chat in Ask, with Off one click away (F-5.18)."
- Alternatives: rewrite the `chat` row and drop the `authorMode` row (this changes the docs page table too).
- To change it: `AI_DATA_SHARING` in `src/shared/aiSettings.ts` and `site/public/docs/index.html`; `CLAUDE.md`.

## 2026-10-07 · F-4.2 · Double-click on a tag renames in the detail, not in the list
- Question: The Tags tab opens a tag's detail on a single click, so the list row is gone before the double-click lands. Where does the rename happen?
- Chosen: double-click (or F2) opens the detail with the Name field focused and selected; the double-click's second click is swallowed so it cannot hit Back, the color, or the category. The rename itself is the existing name field (kebab-case, duplicate refusal).
- Alternatives: an inline field in the list row (needs single click to wait out the double-click delay before opening the detail, which slows every click).
- To change it: `src/renderer/features/tags/{TagsTab,TagList,TagDetail}.tsx`.

## 2026-10-07 · F-5.4 · A renamed fresh conversation keeps its title
- Question: A fresh conversation used to take its first message as its title. What if the author renamed it before writing?
- Chosen: the author's title stays; only the default "New conversation" title is replaced by the first message. Renamed titles are trimmed and cut to 40 characters (the stored cap).
- Alternatives: always retitle from the first message (loses the author's name).
- To change it: `titledBy` in `src/renderer/features/ai/assistantStore.ts`.

## 2026-10-07 · AI billing B3b · One pricing shape
- Question: B1 defined `CloudPricing` for `GET /pricing`; B2 serves `PricingResult`. Which one?
- Chosen: the Worker's `PricingResult` (micro-USD amounts, models by gateway id with `displayMultiplier`, routing `{ tiers, features }`, `wordCosts`) is the one shape; `CloudPricing` is removed and the app reads `PricingResult` everywhere. An app cache in the old shape is dropped on read and fetched again.
- Alternatives: change the Worker to B1's shape (it is not deployed either, but its tests and config already use its own).
- To change it: `PricingResult` in `src/shared/cloudApi.ts`; app helpers in `src/shared/hostedPricing.ts`.

## 2026-10-07 · AI billing B3b · Display multipliers for the approved defaults
- Question: DeepSeek V4 Pro is dearer per input token but cheaper per output token than V4 Flash, so "about Nx the default" needs a rule.
- Chosen: compare on a blend of ten input tokens per output token (the shape of most of the app's requests): V4 Pro about 1.6x, GPT-5.4 nano 2.1x, GPT-5.4 mini 7.6x, GPT-5.4 25x. The OpenAI models stay on the hosted table as choices and for the bare ids older apps send.
- Alternatives: by output price (V4 Pro would read "about 0.3x"); by input price (7x); drop the OpenAI models from the hosted table.
- To change it: a `models` row in `billing_config` (no deploy), or `DEFAULT_HOSTED_MODELS` in `src/shared/cloudBilling.ts`.

## 2026-10-07 · AI billing B3b · Which hosted model a tier asks for
- Question: The Cloud model map is stored per install (default gpt-5.4-mini / gpt-5.4 until today). How does the server's routing table win without overriding a model the author chose?
- Chosen: a tier still at a default (today's DeepSeek one or the pre-2026-10-07 OpenAI one) is sent as the server's `routing.tiers` model; anything else the author typed is sent as typed. A stored OpenRouter own-key map is not migrated: an install that saved B1's `openai/gpt-5.4-*` keeps them until Reset to defaults.
- Alternatives: migrate stored maps to the new defaults; always send the stored map (the server table would never apply).
- To change it: `hostedModelFor` in `src/shared/hostedPricing.ts`.

## 2026-10-07 · AI billing B3b · What gets a quote and a confirm
- Question: "Any job estimated above $0.25" — which jobs?
- Chosen: the multi-request jobs that already have an estimate: edit passes (Start becomes "Confirm and start" with the quote when the hosted quote passes the threshold), the import structure pass and context-library sorting (their offer screens already wait for a click; they now show the hosted quote). Single requests are never quoted: one request on the default models costs about a cent; background indexing is never quoted either (it is derived data the author switched on).
- Alternatives: quote every request in main before sending (needs a new renderer round trip on every AI call); quote background indexing per book.
- To change it: `hostedQuote` in `src/shared/hostedPricing.ts`; `PassSetup` in `EditPassWorkspace.tsx`.

## 2026-10-07 · AI billing B3b · Session token still accepted by the Worker (S6)
- Question: The app now sends short-lived access tokens; should the Worker stop accepting the 90-day session token as a bearer?
- Chosen: not changed in this slice (it is the Worker, and the live Worker is older still). The app falls back to the session token only when `/auth/refresh` answers NOT_FOUND (a Worker without the route). Once the new Worker is deployed and installs have updated, a small Worker change (`sessionHashFor` in `cloud/src/auth.ts`) makes S6 fully true.
- Alternatives: stop accepting it now (an app from before this change would be signed out of the new Worker).

## 2026-10-07 · AI billing B3b · Sign-in needs the OS keychain too
- Question: The session (refresh token) must be keychain-only. What about Linux without a keyring, and a session stored before?
- Chosen: a new sign-in is refused before the email is sent, with how to install GNOME Keyring or KWallet; a session already stored under the plain-text fallback is still read (nothing signs anyone out). The e2e escape hatch `MYTHSCRIBE_E2E_PLAINTEXT_KEYS=1` is now honoured only in an unpackaged build, so no installed copy can be switched to plain text.
- Alternatives: also drop a stored plain-text session at launch.
- To change it: `AiKeyStore.setKey` in `src/main/ai/keyStore.ts`, `AccountService.requestLink`.

## 2026-10-07 · AI billing B3b · Copy on the purchase screen and the legal pages
- Question: Exact wording of the privacy statement (C3), the terms line, and the legal pages.
- Chosen: Account tab: "Your writing stays private. MythScribe Cloud passes each request to the AI model and back and never stores or logs your manuscript, your notes, your questions, or the answers. It keeps only your email address, your balance, and for each request the model, its size, its cost, and when it ran." and "Your balance never expires. Payment is handled by Lemon Squeezy. Unused balance can be refunded within 30 days of buying it." (the window comes from the server config; 30 days is unconfirmed, see B2). terms.html §5 and privacy.html now describe the dollar balance, cost + 20 %, refunds of unused balance within 30 days, OpenRouter as gateway and default own-key provider, and keychain-only keys; the Supporter sections were left for slice B3a. The site's own-key estimate still uses the OpenAI models (now headed "What does your own OpenAI key cost?"); no DeepSeek estimate was made up.
- Alternatives: your wording.

## 2026-10-07 · AI billing B2 · Hold size and charge cap
- Question: The spec's hold uses "input_tokens", which the server cannot count exactly before forwarding. How big is the hold?
- Chosen: a guaranteed upper bound — the messages' UTF-8 bytes plus 16 tokens per message and 16 per request (no tokenizer emits less than a byte per token), at the full input price, plus `maxTokens` at the output price, times the markup. A charge is additionally clamped to its hold (logged). For English prose the hold is about 4x the real input cost; it lasts only until the answer settles.
- Alternatives: characters / 4 times the safety factor (smaller holds, but the operator absorbs any undercount); a tokenizer in the Worker (a new dependency).
- To change it: `inputTokenUpperBound` in `src/shared/cloudBilling.ts`.

## 2026-10-07 · AI billing B2 · Idempotency-Key semantics
- Question: What does a retry with the same key get, given the proxy may not store the answer (S3)?
- Chosen: the header is optional until the app sends it (the Worker makes one up). Same key already charged → 409 `DUPLICATE_REQUEST` ("already answered and charged"; the answer is not replayed). Still running → 409 ("still running"). Released (upstream failed, nothing charged) → the retry runs and takes over the hold. A charge row is keyed `charge:<request id>`, so settling twice charges once.
- Alternatives: re-answer a charged key for free (abusable); store answers briefly (breaks S3).
- To change it: `PLACE_HOLD` / `TAKE_OVER_HOLD` in `cloud/src/store.ts`, `handleAiComplete` in `cloud/src/ai.ts`.

## 2026-10-07 · AI billing B2 · An answer with no usage reported
- Question: A gateway that streams an answer but reports no usage: charge what?
- Chosen: an estimate from the text (characters / 4 for input and output, output capped at `maxTokens`), at least 1 micro-USD per answered request, never above the hold. A failed or cancelled request is never charged (its hold is released).
- Alternatives: charge the whole hold; charge nothing (the operator pays).
- To change it: `settle` in `cloud/src/ai.ts`.

## 2026-10-07 · AI billing B2 · Access and refresh tokens
- Question: How short-lived, how stored, and what about the app that still sends the session token?
- Chosen: access tokens last 15 minutes and are stored hashed in D1 (`access_tokens`), so revoking the session (the refresh token, 90 days, unchanged) ends them at once. No refresh-token rotation. Until slice B3 switches the app, the session token is still accepted as the bearer on every route; S6 is fully in force only once a later change stops accepting it.
- Alternatives: stateless signed access tokens (a new secret; revocation waits for expiry); rotate the refresh token on every refresh.
- To change it: `ACCESS_TOKEN_TTL_MS` in `src/shared/cloudApi.ts`; `sessionHashFor` in `cloud/src/auth.ts`.

## 2026-10-07 · AI billing B2 · Sign-in code
- Question: The spec allows "magic link or code". What kind of code?
- Chosen: the same email carries a 6-digit code beside the link. `POST /auth/verify` takes it with the attempt id and poll secret (so only the app that started the sign-in can use it); 5 wrong codes spend the attempt; it expires with the link (15 minutes).
- Alternatives: a code usable from any device by email address alone (needs stricter rate limiting).
- To change it: `handleVerifyCode` in `cloud/src/auth.ts`, `LOGIN_CODE_*` in `src/shared/cloudApi.ts`.

## 2026-10-07 · AI billing B2 · Trial grant for existing accounts
- Question: Accounts created before the grant existed: do they get it?
- Chosen: yes. The grant is asked for on every verified sign-in (link or code) and keyed by the SHA-256 of the email, so every address gets it exactly once, including existing accounts on their next sign-in.
- Alternatives: only accounts created after the deploy.
- To change it: `grantTrial` in `cloud/src/auth.ts`.

## 2026-10-07 · AI billing B2 · Refunds of unused balance
- **Confirmed by the author 2026-10-07:** unused balance is refundable for 30 days after purchase (`refund_window_days` 30); refunds stay operator-issued in Lemon Squeezy.
- Question: How does the ledger follow a refund, and is the 30-day window enforced?
- Chosen: the operator refunds (part of) an order in Lemon Squeezy; the `order_refunded` webhook writes a `refund` row of the order's cumulative `refunded_amount` (the whole pack if absent), capped at the pack, minus what was already refunded on that order. The window (`refund_window_days`, 30, unconfirmed) is published in `GET /pricing` but not enforced by the Worker, because refunds are issued by the operator. A refund of spent money can take the balance below zero; requests are then refused.
- Alternatives: an in-app "refund my balance" request route; enforce the window on the webhook (it would then ignore a refund Lemon Squeezy already paid out).
- To change it: `handleLemonSqueezyWebhook` in `cloud/src/credits.ts`.

## 2026-10-07 · AI billing B2 · Webhook staleness
- Question: What is "stale"?
- Chosen: older than `webhook_max_age_hours` (72) by the order's `created_at` (`refunded_at` for a refund), or no timestamp at all: 400 `STALE_WEBHOOK`, nothing applied. Lemon Squeezy's own retries arrive well inside 72 hours; replays inside the window are caught by the ledger's unique keys.
- Alternatives: a shorter window (a long outage would then lose orders); 200 "ignored" instead of a 400.
- To change it: the `webhook_max_age_hours` config row, or `eventTime` in `cloud/src/credits.ts`.

## 2026-10-07 · AI billing B2 · The $30 app license on the Worker
- Question: How is the app license sold and issued?
- Chosen: one more Lemon Squeezy variant, `LEMONSQUEEZY_APP_LICENSE` (same shape as the Supporter product). Buying it writes the same `supporter_licenses` row, so `GET /license` signs the same token (F-15.9) and the app's license check is unchanged; `GET /license` offers the app license instead of the Supporter product once it is configured. The trial clock stays in the app (slice B3).
- Alternatives: a separate table and a token claim naming the product.
- To change it: `findVariant` in `cloud/src/credits.ts`, `handleLicense` in `cloud/src/license.ts`.

## 2026-10-07 · AI billing B2 · Where the config lives
- Question: "Changeable without an app release" — D1 or Worker vars?
- Chosen: a `billing_config` D1 table (one JSON value per spec key) over built-in defaults, so the operator changes the markup, prices, limits, routing, or estimate constants with one `wrangler d1 execute` and no deploy; a malformed row is logged and ignored. The packs stay in `LEMONSQUEEZY_PACKS` (they carry Lemon Squeezy URLs), filtered by `min_pack_usd`. Defaults: 60 requests per minute per account, 200,000 characters per request, 10-minute holds swept every 5 minutes.
- Alternatives: everything in Worker vars (needs a deploy per change).
- To change it: `cloud/src/config.ts`; the table is in `cloud/README.md`.

## 2026-10-07 · AI billing B2 · Error codes on the wire
- Question: The spec names `insufficient_balance`, `rate_limited`, `request_too_large`, `model_unavailable`, `upstream_error`.
- Chosen: the existing codes keep their names so the shipped app still understands them (`INSUFFICIENT_CREDITS` 402, `RATE_LIMITED` 429 for both the per-account limit and a busy gateway, `UPSTREAM` 502); added `REQUEST_TOO_LARGE` 413, `MODEL_UNAVAILABLE` 422 (unknown model, or the gateway's 404), `DUPLICATE_REQUEST` 409, `STALE_WEBHOOK` 400. An unknown model was 400 `BAD_REQUEST` before; it is now 422 `MODEL_UNAVAILABLE`.
- Alternatives: rename `INSUFFICIENT_CREDITS` to `INSUFFICIENT_BALANCE` in slice B3 together with the app.
- To change it: `CloudErrorCode` in `src/shared/cloudApi.ts`.

## 2026-10-07 · AI billing B2 · Proposed price table details (needs approval with the model proposal)
- Question: The default hosted price table beyond what the plan fixed.
- Chosen: OpenRouter ids `openai/gpt-5.4-mini` (fast, multiplier 1), `openai/gpt-5.4` (strong, about 3.3x), `openai/gpt-5.4-nano` (about 0.3x) at OpenAI's 2026-10-05 prices, cached input at a tenth of the input price; the bare names the app sends today are accepted as aliases. Multipliers are by output price relative to the fast model.
- Alternatives: whatever the author approves for the default models and routing table.
- To change it: a `models` / `routing` row in `billing_config` (no deploy), or `DEFAULT_HOSTED_MODELS` in `src/shared/cloudBilling.ts`.

## 2026-10-07 · AI billing B1 · Proposed OpenRouter default models and Auto routing table (needs your approval)
- Question: Which fast and strong models should OpenRouter (own key) and MythScribe Cloud use by default, and which tier should Auto give each task? Not shipped: the app still asks for `openai/gpt-5.4-mini` (fast) and `openai/gpt-5.4` (strong) through OpenRouter, and Auto keeps every task on the tier it always had.
- Prices: **not verified.** This agent had no web access, so the figures below are from memory (mid-2026) and must be checked on openrouter.ai/models before you approve; OpenRouter passes the provider's price through (its fee is on buying credit).
- Proposed:
  - Fast: `deepseek/deepseek-v3.2` (DeepSeek V3.2), about $0.25–0.28 in / $0.40 out per 1M tokens, cached input about $0.03. Why: roughly a third of gpt-5.4-mini's input price and a tenth of its output price ($0.75 / $4.50); good at JSON (summaries, tags, proofreading); comparatively permissive with violence, dark themes, and adult romance, which is the content-filter risk the research flagged for OpenAI and Anthropic models.
  - Strong: `moonshotai/kimi-k2-0905` (Kimi K2), about $0.40–0.60 in / $2.00–2.50 out. Why: about a sixth of gpt-5.4's price ($2.50 / $15); ranks near the top of creative-writing benchmarks; permissive enough for dark fiction and romance; JSON mode works.
  - Alternatives: fast `mistralai/mistral-small-3.2-24b-instruct` (about $0.05–0.10 in / $0.10–0.30 out; very permissive, weaker at long JSON); strong `z-ai/glm-4.6` (about $0.40–0.60 / $1.75–2.20) or DeepSeek V3.2 for both tiers (cheapest, one model). Newer versions of these families may exist by now; prefer the current one at a similar price.
  - Risks to weigh: these models are served by several hosts behind OpenRouter; set OpenRouter's data policy to exclude providers that train on prompts (not built: a `provider.data_collection: "deny"` request field, or the account setting). Explicit sexual content is still refused by some hosts; none of these is a guarantee.
- Proposed Auto routing table (fast unless named; today's table is the same except the two marked *changed*): fast for tags, summaries (and the story bible and auto-tags they carry), proofreading, import structure, the router, synopsis and notes suggestions, style notes, What next, brief drafting, background continuity checks, ghost text, chat (Plan); strong for Story Intelligence queries, critique, the beta reader, the chat agent, on-demand Check consistency, and the developmental, line, and custom edit passes (copy, proofread, and continuity passes fast); *changed:* rewrite-in-my-voice fast → strong (spec R4: drafting on stronger models). The spec also puts ghost writing on the stronger model; CLAUDE.md token rule 1 keeps ghost text on fast (it runs on every pause, capped at 60 tokens); recommended: keep ghost text on fast, since the author can move it to strong per task in Settings › AI.
- To change it: `OPENROUTER_DEFAULT_MODELS` and `OPENROUTER_PRICING` in `src/shared/ai.ts` (own key); the hosted defaults and table come from the Worker's `/pricing` (slice B2); the bundled Auto table is `DEFAULT_ROUTING_TABLE` in `src/shared/aiRouting.ts` (its test pins it to the prompt catalogue's tiers, so a change there updates `prompts/catalogue.ts` too).

## 2026-10-07 · AI billing B1 · OpenRouter as the default own key, and existing OpenAI keys
- Question: What happens to an install that already holds an OpenAI key?
- Chosen: a fresh install's own key is for OpenRouter. An install with a saved OpenAI key keeps using OpenAI until you switch in Settings › AI (Key provider: OpenRouter / OpenAI); each provider keeps its own key and its own two model names. Copy that said "OpenAI" (the source meaning, the quota next step, the local-model warning, the privacy line) now names the provider in effect or both.
- Alternatives: move everyone to OpenRouter (an OpenAI key would stop working until replaced).
- To change it: `effectiveOwnKeyProvider` in `src/shared/ai.ts`.

## 2026-10-07 · AI billing B1 · Keys only in the OS keychain (S2)
- Question: How strict is "keychain only"?
- Chosen: saving a provider key is refused when Electron would fall back to Linux plain-text storage, with a message on how to install GNOME Keyring or KWallet; Windows and macOS are unaffected. A key saved earlier under the fallback is still read (so nothing breaks), and can be cleared. The MythScribe Cloud session token still uses the fallback until the session rework (slice B3: short-lived access token plus a keychain-only refresh token). The e2e has no keyring under xvfb, so `MYTHSCRIBE_E2E_PLAINTEXT_KEYS=1` (set only by `e2e/smoke.spec.ts`) allows the fallback there. Note for your WSL dev setup: `npm run dev` will refuse a key until a keyring runs (`sudo apt install gnome-keyring`, then unlock it in the session).
- Alternatives: stop reading old plain-text keys too; add a native keychain dependency (not allowed by the plan).
- To change it: `AiKeyStore.canStoreProviderKey` in `src/main/ai/keyStore.ts`.

## 2026-10-07 · AI billing B1 · Shape of model choice, and the /pricing contract for B2
- Question: How do "Auto", "override per task or globally" (R4), and "choose the model for any request" (M8) fit the rule that features request a tier, never a model name?
- Chosen: overrides choose a tier, not a model id: Settings › AI › "Which model each task uses" has All tasks (Auto, Fast model, Strong model) and a per-task list; a per-task choice wins over All tasks, which wins over Auto. Which model a tier means stays the per-provider setting (F-5.11), so one choice works on every source. No per-request picker was added: the plan named "edit passes, chat" as having one today, but neither had a model picker; a per-pass choice would also need a schema change to survive Resume. Hosted prices and the hosted Auto table come from `GET /pricing`, whose shape is `CloudPricing` in `src/shared/aiRouting.ts` (price per model with cached-input price and multiplier, markup, packs, trial grant, quote threshold, safety factor, low-balance warning, routing, nullable per-word constants); the app fetches it at launch and after sign-in (cached for an hour) and falls back to the bundled table until the Worker serves it (slice B2 must serve this shape).
- Alternatives: per-task model ids (needs a list per source); a model picker in the chat and edit-pass screens.
- To change it: `src/shared/aiRouting.ts`, `ModelChoiceSection` in `AiSettingsTab.tsx`.


## 2026-10-07 · F-15.13 (billing B3a) · Your installed build will turn read-only 30 days after you update (operator step)
- Question: No build can verify a license yet: `LICENSE_PUBLIC_KEY_JWK` in `src/shared/license.ts` is still the placeholder, and the $30 product is not on sale. The trial starts on the first launch of this version, so in 30 days every install (yours included) opens projects read-only.
- Chosen: nothing bypasses the trial (you asked for no assumptions, and a hidden switch would be a user-settable bypass). Export and backup keep working.
- To do before then: `npm run cloud:license-keygen`, `wrangler secret put LICENSE_SIGNING_KEY`, paste the public JWK into `src/shared/license.ts`, create the $30 product and `LEMONSQUEEZY_APP_LICENSE`, deploy; then buy (or grant yourself) the license. Alternatives: a developer exemption (say how you want it gated), or a longer trial for existing installs.

## 2026-10-07 · F-15.13 (billing B3a) · What "read-only" refuses
- Question: Which actions stop after the trial?
- Chosen: main refuses every channel that changes what you wrote (scenes, notes, the tree, sheets, tags, drafts, snapshots, imports, find-and-replace, accepting AI proposals, the project dictionary, discarding crash recovery) and every AI request. Always allowed: opening, reading, search, export, compile, backups and restore, the account and the purchase, app settings, and the project's view preferences (layout, session, focus, editor and AI settings, goals, backgrounds, reference pins, chat history). The scene and notes editors stop being editable; other fields (sheets, scene details, renaming in the tree) still accept typing, and their save fails with the trial message.
- Alternatives: also lock every other field in the UI (many components); block view preferences too.
- To change it: `CHANNEL_ACCESS` in `src/main/ipc/channelAccess.ts`.

## 2026-10-07 · F-15.13 (billing B3a) · The trial banner
- Question: When does the trial show itself?
- Chosen: one line under the header, only in the trial's last 7 days ("5 days left in your trial." + Buy MythScribe), and always after it ends ("Your 30-day trial has ended. Projects open read-only; export and backup still work." + Buy MythScribe). Buy opens Settings › Account. The Account tab always shows the days left. The trial is 30 calendar days and ends at local midnight.
- Alternatives: show the countdown for the whole trial; a dismissable notice; no countdown.
- To change it: `TRIAL_BANNER_DAYS` in `src/renderer/features/account/TrialBanner.tsx`.

## 2026-10-07 · F-15.13 (billing B3a) · Themes and accents during the trial
- Question: The Supporter extras "become part of the paid app". Do trial users get them?
- Chosen: no change to the gate: Sepia, custom themes, and accent colours unlock with the license (now called the MythScribe license), not during the trial.
- Alternatives: unlock them during the trial too (the gate would follow `AppAccess` instead of the license); make them free for everyone.
- To change it: `themeNeedsLicense` callers (`handlers.ts`, `ThemePicker.tsx`, `viewStore.ts`, `App.tsx`) and `AccountService.setAccent`.

## 2026-10-07 · F-15.13 (billing B3a) · A paid license offline for more than 14 days
- Question: The F-15.9 token expires 14 days after the last refresh that reached the Worker (it was built for cosmetics). It now also keeps projects writable.
- Chosen: unchanged: a licensed install that cannot reach MythScribe Cloud for more than 14 days turns read-only until it reconnects (Refresh on the Account tab). Export and backup still work.
- Alternatives: a longer grace (e.g. 90 days) for the app license; trust an expired but genuine token for writing and use expiry only for refunds.
- To change it: `LICENSE_GRACE_DAYS` in `src/shared/license.ts` (also the Worker's), or `verifyLicenseToken` in `src/main/account/licenseVerifier.ts`.

## 2026-10-07 · F-15.13 (billing B3a) · How the trial clock is kept, and how a license is activated
- Question: How tamper-resistant is the trial, and how does the app learn about a purchase?
- Chosen: the clock is plain JSON in `app-state.json` (start and last-seen time); turning the system clock back does not give days back, but deleting the file starts a new trial ("enough for honest users"). The license is the account's F-15.9 token: buy while signed in, then press Refresh on the Account tab (it also refreshes on launch and daily); there is no license key to paste.
- Alternatives: keep a second copy of the clock in the OS keychain; a pasteable license key for people without an account; refresh the license when the window regains focus after checkout.
- To change it: `src/shared/appAccess.ts`, `src/main/account/appAccess.ts`.

## 2026-10-07 · F-15.13 (billing B3a) · Account tab intro now overstates "no account needed"
- Question: The Account tab still opens with "Optional. You never need an account to write." After the trial, writing needs the license, which belongs to an account.
- Chosen: left as it is in B3a (the intro is the hosted-AI copy slice B3b rewrites); the license section below it explains the trial and the purchase.
- Alternatives: "The account holds your MythScribe license and connects MythScribe Cloud."
- To change it: `INTRO` in `src/renderer/features/account/AccountSettingsTab.tsx` (and its unit test and the smoke test's check).

## 2026-10-07 · Developer tools · The panel is a bottom drawer, not a dock panel or a window
- Question: The plan left the form open ("a dock panel or a separate window, whichever is simpler and does not disturb the writing layout").
- Chosen: a drawer fixed over the bottom 45 % of the window (`DevToolsPanel.tsx`), outside the dock, so no column moves and the editor above stays usable while it is open: you can type and watch VibeWrite's requests arrive. Help › Developer tools or Ctrl+Shift+D toggles it; the close button hides it. Help › Developer is two items at the end of Help (Developer tools, Chromium DevTools) because the menu model has no submenus; both are absent while the switch is off.
- Alternatives: a dock panel (moves the layout); a separate BrowserWindow (more wiring: its own preload route and lifetime).
- To change it: `src/renderer/features/devtools/DevToolsPanel.tsx`, `DEVELOPER_MENU_ENTRIES` in `src/shared/menu.ts`.

## 2026-10-07 · Developer tools · What "waiting" measures, and how skips are counted
- Question: The inspector's timing breakdown needs a definition of "queued/waiting", and ghost text can skip on every idle tick.
- Chosen: `waiting` is from the moment the request path takes the request until the provider is called (the pre-checks and the cache lookup); the feature's own context building and a background job's time in the index queue are not in it. `first token` exists only for streamed requests (chat Plan mode, rewrite); ghost text is not streamed, so its total is its time to first word. A fidelity regenerate and each agent step are rows of their own under the caller's request id (`…:regen`). Ghost-text skips are reported once per change of reason (a run of identical "too few new characters" ticks is one row), and reset when a request leaves. A feature refused by Use AI or its toggle (DISABLED) never reaches the request path, so it is a log entry, not an inspector row.
- Alternatives: include context-building time (needs a hook in every use case); one row per idle tick (floods the 200-row buffer).
- To change it: `traced`/`AiRequestTrace` in `src/main/ai/request.ts`, `skip` in `src/renderer/features/editor/ghostTextController.ts`, `aiFailure` in `src/main/ipc/handlers.ts`.

## 2026-10-07 · Developer tools · What the copied diagnostics report contains
- Question: "Settings with keys and secrets removed" needed a concrete list.
- Chosen: app version, OS and architecture, Electron/Node/Chromium versions; the project's AI source, the own-key provider, whether a key is saved and how it is stored (never the key or its hint), the tier models; app settings limited to models, routing, local server, daily cap and today's tally, view, update channel, backups, and the two switches; the open project's AI settings; the newest 50 log entries and 50 AI request summaries (no prompt or answer text). Every field named like a key, token, secret, password, hint, license, email, or session is dropped, and every string is scrubbed for `sk-…`, `Bearer …`, and JWT-shaped text. Recent project paths, the window state, and the diagnostics queue are left out.
- Alternatives: the whole app-state.json minus secrets (includes project paths).
- To change it: the `devtools:report` handler in `src/main/ipc/handlers.ts`, `formatDiagnosticsReport` in `src/shared/devtools.ts`.

## 2026-10-07 · F-12.4 (CV2) · Compile writers: engine, fonts, and page numbers
- Question: How do the writers carry fonts, page numbers, and the print layout?
- Chosen: (1) The print PDF is the shared print HTML laid out by Paged.js 0.4.3 (MIT, a dev dependency whose polyfill is bundled into main) in a hidden window: script on but sandboxed, no Node, its own session that refuses everything but local files, a CSP, no navigation. It renders offscreen and unthrottled (108 pages in about 2 s; about 105 s otherwise). (2) Fonts: six SIL OFL families ship in `resources/fonts/` with their licences (EB Garamond, Libre Baskerville, Crimson Pro, Courier Prime, Source Sans 3 from Fontsource 5.3.0, Latin and Latin Extended; Liberation Serif 2.1.5). Only the PDF embeds them. DOCX, ODT, and RTF name the font (Liberation Serif asks for Times New Roman, which every agent's Word has); EPUB and HTML name it with fallbacks (reading systems let the reader choose). (3) Page numbers restart at 1 on the body's first page, which goes on a right-hand page when the book has sides; front pages carry no header or footer. Paged.js's own page-counter reset did not carry past its page in this Chromium, so MythScribe numbers the pages itself after layout. (4) Running heads and page numbers are 0.85 × the body size in mirrored (print) formats, the body size otherwise.
- Alternatives: WeasyPrint or Prince (not in Electron; Prince is paid); embed fonts in DOCX (Word ignores embedded fonts unless the reader turns them on) and EPUB (bigger files, often overridden); number front matter in Roman.
- To change it: `src/main/export/pdf.ts`, `src/shared/bookFonts.ts` (`officeFontName`), `src/shared/compilePages.ts`, `src/shared/compileHtml.ts` (`pageCss`, `PAGED_FURNITURE_HANDLER`).

## 2026-10-07 · F-12.4 (CV2) · Compile writers: smaller calls
- Question: Details the plan left open.
- Chosen: (1) `{chapter}` in DOCX and RTF is the chapter that opens each page run (every page break starts a Word/RTF section); in ODT it is ODF's chapter field, which shows the heading text. (2) ODT has no right-page break, so a new recto is a new page there. (3) RTF drop caps open unindented (RTF drop-cap frames are rarely honoured); DOCX uses a real framed drop cap, ODT its drop-cap property. (4) A small-caps first line is CSS `::first-line` in PDF, EPUB, and HTML, and the first ~40 characters (to a word end) in DOCX, ODT, and RTF. (5) Notes set to "comments" are Word comments (DOCX), annotations (ODT, RTF), and print inline after their text everywhere else. (6) A two-line heading reads "Chapter One: The Storm" on one line (contents page, EPUB navigation, Markdown); this changed `plain` in the CV1 model. (7) The DOCX contents page is a Word TOC field whose entries link to the chapters but carry no page numbers until Word updates the field (F9); RTF, plain text, and Markdown list the entries without numbers; PDF prints the numbers. (8) `compile:run` takes the format as shown (unsaved edits included) and the project's stored include ticks, names the file after the book title, reuses `export:progress`, and counts as `export.run` in diagnostics (the counter list is fixed). (9) The old Export dialog stays until CV3, mapped to a format by `exportDialogFormat`; its serif font is now Liberation Serif and its sans Source Sans 3 (before: Georgia/Times and Arial). (10) Hyphenation in the PDF needs Chromium's hyphenation dictionaries, which Electron does not ship on Windows or Linux, so justified paperback text is not hyphenated there (DOCX, ODT, and RTF ask the word processor to hyphenate). (11) epubcheck was not run (it needs Java); the tests check the structure it checks first.
- Alternatives: (1) a Word STYLEREF field; (10) bundle hyphenation patterns (e.g. Hyphenopoly, MIT) into the print page.
- To change it: `src/main/export/{docx,odt,rtf,inlines,run,exportDialog}.ts`, `sectionHeading` in `src/shared/compileModel.ts`.

## 2026-10-07 · F-12.4 (CV3) · Compile window: smaller calls
- Question: How the compile window behaves where the plan left it open.
- Chosen: (1) Built-in formats are read-only; Duplicate makes an editable copy in My formats. (2) A My format's edits stay unsaved (marked "(edited)", kept for the session even if the window closes) until Save or Revert; switching formats with unsaved edits asks first. (3) Duplicate copies what is shown (edits included) under "<name> copy" without asking for a name; Rename… renames the stored format only. (4) The live preview lays out about 6,000 words from a chosen start ("Preview from": the beginning or any page run with a heading), so a novel previews fast; folios count from the window's first page; EPUB, HTML, text, and Markdown preview as the reflowable web page rather than pages; zoom 50/75/100 %. (5) The preview loads the bundled fonts through the project asset scheme (`mythscribe-asset://book-fonts/...`, the scheme now CORS-enabled) instead of bundling a second copy into the renderer. (6) Choosing a format resets "Compile for" to that format's default output. (7) The window closes after a successful compile (the toast names the file). (8) File › Export… stays as an alias of File › Compile…; the F-12.1 dialog, `export:run`, and `exportDialogFormat` are removed. (9) Book details is its own page (File › Book details… and the window's Book details… button) with an explicit Save; the cover is set or removed at once. (10) The binder menu's "Include in compile" shows the row's own tick; the window's list greys out what an unticked folder leaves out.
- Alternatives: (1) editable built-ins saved as a copy on Save; (2) autosave My formats; (4) lay out the whole book, or render pages in main and show images; (5) `import.meta.glob` the fonts into the renderer (+2.6 MB); (7) keep the window open.
- To change it: `src/renderer/features/compile/` (`compileWindowStore.ts`, `CompileWindow.tsx`, `compileContents.ts` `PREVIEW_WORDS`, `pagedFrame.ts`), `src/main/index.ts` (asset scheme), `src/shared/menu.ts`.

## 2026-10-08 · F-9.9 · Review chat: smaller calls
- Question: How the review chat (plan-organize OR2) behaves where the plan left it open.
- Chosen: (1) Its own feature id `reviewChat` with its own toggle and data-sharing row (strong tier, reasoning per the model-choice routing, not forced off like `contextImport`), so its cost shows on its own line. (2) Operations: merge, split, kind, toNotes, fromNotes, rename, aliases, include. Two items that are both existing sheets are never merged here (that is Organise, F-9.10, which always asks); only a new sheet can be renamed (Apply never renames an existing sheet); changing an existing sheet's item to another kind makes a new sheet of that kind (or fills an existing one of that kind and name), and the old sheet is left alone. Skipped operations are listed with the reason. (3) Until the alias model (F-4.14, slice OR1) lands, an item's other names are its records' names and `aliases`; the aliases operation sets the explicit list on its first record, and Apply does not store aliases yet. (4) One level of Undo (the last chat change); a manual edit of the review drops it. Apply and the box wait while the AI answers; Escape in the box stops the answer instead of closing the review. (5) Each answer is one proposal added to the review's `proposalIds` (settled with it at Apply or Cancel; rejected on Undo); its cost shows under its reply, not in the review's footer total. (6) The prompt lists each item on one line (id, kind, name, sheet, other names, files, field values to 60 characters, two details to 100) within 14,000 characters, and the Project notes numbered within 3,000; the last 4 turns go with the message.
- Alternatives: (1) reuse `contextImport`'s id and toggle; (2) allow merging two existing sheets, or renaming one, by extending Apply; (3) a separate alias field on the review item; (4) multi-level undo; (5) fold the chat's cost into the review's footer total.
- To change it: `src/shared/reviewChat.ts` (`applyReviewOps`), `src/main/ai/reviewChat.ts`, `src/main/ai/prompts/reviewChat.v1.ts` (a new version), `src/renderer/features/library/libraryStore.ts` (`sendReviewChat`, `undoReviewChat`), `ContextUploadDialog.tsx` (`ReviewChat`).

## 2026-10-08 · F-5.23 · Story time: smaller calls
- Question: The author confirmed "now = the current scene", the story map, and labelling sheets and notes as plans. Several details were not covered.
- Chosen: (1) Now is the selected manuscript scene; a selected chapter or part puts now at its last scene; with an entity page, research, or nothing selected, now is the latest scene with text (the map says so); with nothing written, every scene is later. (2) The whole open scene counts as happened, not only the text before the caret. (3) The map lists every scene with its progress; summaries are the first sentence of the stored F-5.6 summary (120 characters); budgets 1,200 tokens in the chat agent and 400 in What should come next?; over budget it drops far summaries first (earlier side before later), then keeps a window of scenes around now and counts the rest ("… N earlier scenes"). Summaries of written scenes after now are kept (they say "after now"). (4) Changed prompts: `agent.v3` (map + rule; lookups label scenes before / at / after now and sheets and notes as plans), `continuity.v2` (a sheet or a later scene's fact is not contradicted by an event the scene does not show yet), `whatNext.v3` (rule, map, bible under a "notes and plans" heading), `notesSuggest.v2` (rule, same heading). Not changed: `query.v4` (no longer called; Query questions run on the agent), the beta reader (already only reads earlier scenes), the synopsis suggestion (the scene alone), and the prose prompts (ghost text, Author mode, rewrite, critique keep the "ground truth" bible heading), and the F-14.15 continuity edit pass (`editPass.v1` still lists references as before).
- Alternatives: now = the caret position; a manual "story so far" marker; put the map in the prose prompts too; a new version of every prompt that carries the bible.
- To change it: `src/shared/storyTime.ts`, `src/main/ai/context/storyTime.ts`, `src/main/ai/agentTools.ts`, the four prompt files.

## 2026-10-08 · F-11.1d · Planned / drafted / revised, and plan links: smaller calls
- Question: The rule for Planned / Drafted / Revised, which plans get linked, and how links are stored.
- Chosen: (1) A document with no words is Planned whatever its status; with words it is Revised when its status is Revised or Final, otherwise Drafted (no status, Idea, Draft). A chapter or part rolls up: Planned when all its scenes are, Revised when all are, Drafted otherwise; a folder with no scene shows no badge. The badge sits beside the status dot; the status field is unchanged. (2) Plans are planned scenes (empty manuscript documents, with their synopsis) and the empty beats of the chosen structure template. Plot threads are not linked here: they are tags, and F-4.13's auto-applied tags already link them to scenes. (3) A planned scene's link is `SceneMeta.fulfilledBy` (no migration); a beat's link is the written scene's beat (the F-11.1b field). Suggestions, dismissed pairs, and the AI-applied marks live in the settings KV `planLinks`. (4) New feature id `planLinks` ("Plan links", fast, JSON, Ask, own toggle, 400 out / 7,000 in), prompt `planLinks.v1`; the job is a silent `planLinks` index-queue job per project, 20 s after a summary run that made a request (or a template change), plus a "Find links" button in the outline. At chat mode Auto links apply at once with an "AI" mark; at Ask and Plan they wait as suggestions with Confirm and Dismiss; Unlink and Dismiss are remembered so the pair is never proposed again. (5) A planned scene that is fulfilled is left out of the story map. (6) Known gap: a background link landing in the same instant the author edits that scene's metadata can be overwritten by the pending autosave; the link is proposed again on the next run.
- Alternatives: status alone decides (Idea = planned); a word threshold; link plot threads too; a migration with a link table; links as proposals in the proposal table.
- To change it: `src/shared/storyTime.ts` (`sceneProgress`), `src/shared/planLinks.ts`, `src/main/ai/planLinks.ts`, `src/renderer/features/outline/OutlineTab.tsx`.

## 2026-10-08 · F-9.11 · Story-bible categories and the section picker: smaller calls
- Question: How categories and the section picker behave where the plan (all decisions confirmed) left it open.
- Chosen: (1) Outline counts as used once the manuscript has a document (it is a view of it); Timeline, Edits, Library once they hold an event, a pass, a file. (2) Unused sections are not unreachable: "Show unused sections (n)" at the foot of the picker lists them, and the current section always shows. (3) The three F-9.1 kinds keep their ids (`character`, `setting`, `world`), so the migration only adds `story_category`; no sheet moves. Settings is called Places now (the tag category keeps its "Settings" label). (4) Existing World sheets about magic (World's "Category: Magic system") are not moved into Magic Systems automatically; moving sheets between categories is left to organise (OR3). (5) An AI-invented category is accepted by Apply (the review is the proposal; Rename… and Decline sit on it); Decline files its sheets under World with the fields World lacks moved to their details; at most 6 proposals per sort, 6 fields each. (6) A sheet the model files under another category than an existing same-named sheet fills that sheet where it is (no twin). (7) The chat agent does not create sheets or propose categories yet (it lists and reads every category and edits any category's fields): adding sheet creation means an agent prompt change, which overlaps the parallel story-time work and organise (OR3). (8) F-9.5: a row of a category the project lacks is refused naming it (no category definitions travel in the exchange file yet). (9) No category deletion and no editing of a project category's fields after creation; a library category can be renamed (name, singular, icon), its fields cannot change. (10) Library list: Characters, Places, World, Magic Systems, Factions & Organisations, Religions, Creatures, Items & Artifacts, Cultures, History & Events, Languages, Technology, Lore & Legends; pictures on characters, places, creatures, items.
- Alternatives: (1) Outline hidden until a structure template or a synopsis exists; (2) strictly hidden; (3) rename the stored kinds (`setting` → `place`) with a data migration; (4) a one-time move of World sheets by their Category field; (5) proposals pending in the DB until accepted one by one; (7) an agent tool `create_sheet` / `propose_category` now; (8) carry category definitions in the JSON exchange file and create them on import; (9) delete an empty category, edit fields.
- To change it: `src/renderer/features/shell/sectionList.ts` (`TOOLS[].used`), `src/renderer/features/shell/SidebarSections.tsx`, `src/shared/categories.ts` (`BUILTIN_CATEGORIES`, `ALWAYS_SHOWN_CATEGORIES`), `src/main/entity/categoryStore.ts`, `src/shared/contextLibrary.ts` (`matchSheet`, `declineReviewCategory`, `CONTEXT_PROPOSED_*`), `src/main/ai/contextImport.ts` (`SortCategories`), `src/main/library/apply.ts`, `src/shared/entityExchange.ts`.

## 2026-10-08 · F-9.10 · What asks first in Auto
- Question: The author's rule is that merges or deletions of sheets with text always ask. What about tag merges, deleting an unused tag or an empty sheet, and new categories?
- Chosen: every merge and deletion (tags, sheets, scenes, empty folders) and every new category waits for Apply even in Auto, because none of them has an Undo; everything else Auto applies at once with Undo and "Undo the whole reorganisation".
- Alternatives: Auto applies tag merges and empty deletions too (they cannot be undone from the plan); building an un-merge for tags.
- To change it: `needsAsk` in `src/shared/organise.ts`.

## 2026-10-08 · F-9.10 · Local duplicate rules and the quiet offer
- Question: What counts as a likely duplicate, and when does the offer show?
- Chosen: two tags (or two sheets) whose names or aliases have the same key, where every word of the shorter (each of 4+ letters) is in the longer ("Rynna" / "Rynna Falsire"), or with the same word count and each word the same or a close spelling (F-4.14's rule); unused tags = no document, mention, sheet, or child; empty sheets = no field, page, or picture. The offer shows on any duplicate or 3+ loose ends, at the top of the Tags section and every story-bible section, after an upload is applied and 1.5 s after tags or sheets change; "Not now" hides it until the findings change (for the session). "High Crown Falsire" is left to the AI.
- Alternatives: phonetic matching; a toast after an upload; remembering "Not now" across sessions.
- To change it: `namesLookAlike`, `worthOffering`, `ORGANISE_OFFER_LOOSE_ENDS` in `src/shared/organise.ts`; `OrganiseBar.tsx`.

## 2026-10-08 · F-9.10 · What the plan can do with the binder and notes
- Question: The author listed splitting and merging scenes and chapters. The plan never reads scene text (only titles, word counts, and notes).
- Chosen: rename, move, merge a document into another, and delete an empty folder (so a chapter merge is moves plus a delete); splitting a scene is left to the chat agent, which can read it. Notes are tidied by rewriting a document's notes as points (facts moved into sheets left out), undoable.
- Alternatives: sending scene text so the plan can split (costly, and close to touching the manuscript).
- To change it: `OrganiseOp` in `src/shared/organise.ts`, `OrganiseResolver.binder` in `src/main/organise/resolveOps.ts`.

## 2026-10-08 · F-9.10 · Moving a sheet to another category, and merging sheets
- Question: How do values travel when a sheet changes category or two sheets merge?
- Chosen: `entity:update` takes `kind`: values of fields the new template lacks go into its Notes as "Label: value"; Undo moves it back with the old values. `entity:merge` fills the target's empty fields, adds differing values under its own (a blank line apart, never twice), joins the pages, makes the merged names aliases, moves observed facts, merges the tags (`tag:merge` rules), and keeps the target's picture (else takes the first). A new category created from the plan is the author's (`category:create`).
- Alternatives: refusing a move that would lose a field; keeping the merged sheets' values in a details list.
- To change it: `refileFields`/`joinSheetText` in `src/shared/categories.ts`; `updateEntity`, `mergeEntities` in `src/main/entity/entityStore.ts`.

## 2026-10-08 · Demo video · Choices inside the confirmed plan
- Question: The details the demo-video plan (≈90 s, silent, title cards, scripted AI, four features) left open.
- Chosen: (1) Card copy: "The novel-writing app that remembers your book." / "Write in a quiet editor, organised your way." / "Ask your book anything. It knows where you are." / "Let it draft. You decide what stays." / "Upload your worldbuilding. It sorts it." / "Compile print-ready books and ebooks." / end card "mythscribe.app — Your book, your voice, with help when you want it." Each card has one plain sub-line; no platform, price, or availability claims. (2) The scripted question is "What does Ilse know about the green light so far?", asked with "Salt and Ledgers" open; the answer opens "As of this scene…" and cites three passages. The draft request is "Write the next beat: the Warden doesn't believe her."; the agent answers with an insertion at the cursor, the draft streams in as ghost text, and Tab keeps it (a key badge shows "Tab · Keep it", since the video is silent). (3) The upload section ends on Marta Varrow's new sheet, reached through the new section picker. (4) The compile section exports the Paperback PDF to `<tmp>/Books/The Lantern Ferry.pdf`, so the "Compiled to" notice in the video shows that path. (5) The hero loop is 720p VP9, five 4.5 s moments cross-faded (≈20 s, ≈1 MB); the MP4 is 1080p H.264 CRF 20 (≈9 MB). (6) The cost lines under AI answers ("$0.0261 · 7,200 in · 540 out") are the app's real UI fed by the fake's usage numbers, so they are plausible but invented; they stay in shot. (7) The British spellings in the demo novel ("colour") get the spellchecker's red underline in the editor; left as is.
- Alternatives: different card copy; asking about Tomas instead; showing the toast instead of the sheet after Apply; a 1080p hero loop; hiding the cost lines (an app change, out of scope).
- To change it: `CARDS`, `ASK_QUESTION`, `WRITE_REQUEST`, `DRAFT`, and the timings in `scripts/demo-video.mjs`; the novel in `scripts/lantern-ferry.mjs`.
