# Story memory as suggestions you approve (2026-10-14)

## Why

Five live planted-error runs: stored-fact precision went about 40 % → 80 % → 88 %, never 95 %.
Each round closed one family of mistakes and the next run showed another (wrong person, acts as
traits, a true sentence under the wrong heading). Fiction is ambiguous on purpose; a reader that
files facts with nobody looking needs near-perfect precision because a wrong fact sits unseen on a
sheet. The author's own Claude workflow works because the author sees what it writes.

## The author's decision (2026-10-14, confirmed)

**Suggestions you approve.** After a scene settles, the reader proposes story-bible updates, each
with its quote; the author accepts or dismisses them, singly or in a batch. Ms Scribe answers from
the text with citations (already built). Nothing the reader proposes reaches a sheet, the panel's
facts, the Timeline, ages, contradictions or Ms Scribe's instant cards until accepted. This follows
the app's first AI rule: AI output is a proposal.

## The author's answers (2026-10-14, confirmed)

1. **Slots:** the concrete slots plus `history` and `traits`; `relation`, `role`, `clothing`,
   `objects` stay off.
2. **Quote-exact facts:** no auto-apply; everything is a suggestion.
3. **Per scene:** no limit; every suggestion that passes the gates is shown, best first
   (literal, then verified).

## What changes

1. **State.** A new claim state `suggested` (`src/shared/memory/claims.ts`; the column is plain
   text, no migration). The reading pipeline stores what passes the gates and the checker as
   `suggested`, not `live`. Every reader of claims already filters on `live`, so sheets, the
   panel's True now, ages, the Timeline, findings, judge pairs, instant cards and the chat's tools
   see only accepted ones; audit each and test it.
2. **Accept / Dismiss.** Channels `memory:suggestions` (by scene or record), `memory:accept`
   (ids → `live`, marked accepted by the author), `memory:dismiss` (ids → the existing Dismissed
   list, so the same sentence never comes back). Undo for both through Changes.
3. **Where the author sees them.**
   - The status bar's side-work item: "4 suggestions" after a scene is read; opens the side panel
     beside the editor (never blocks writing).
   - The This scene panel's Needs a look: "Suggestions from this scene" with each line, its quote
     (ⓘ) and Accept / Dismiss, plus Accept all.
   - Rebuild memory (and the switch-over's rebuild): the summary becomes a review grouped by
     character, reusing `ReviewDeck` with Accept all for a character.
4. **Who knows what and threads.** Their claims become suggestions the same way (one rule).
   Scene cards (POV, year, mood) stay automatic, marked as AI, as now.
5. **Slots:** concrete plus `history` and `traits` (a new reader version asks for them again, with
   reader.v5's value rules for those two); the gates from the last two rounds stay (they
   cut noise the author would otherwise dismiss by hand).
6. **The live run's bar.** Precision now measures how many suggestions are worth accepting:
   **at least 85 %** (decided by Claude, unconfirmed), plus the safety bars unchanged (no
   negative or trap suggested, attribution ≥ 95 %, nothing from a never-read scene). The fifth
   run (about 88 % and 83 % once judged) is re-scored offline under this bar first.
7. **Docs.** FEATURES.md F-16.17 (and the panel, sheets and rebuild entries it touches),
   QUESTIONS.md entry, ARCHITECTURE bullet. Prices unchanged (same calls).

## Not changing

Ms Scribe's cited answers, the name scan, who is in a scene, the switch-over's conversion of v1
data (the author's own sheets stay hers), and v1 for installed builds until the switch.

## Process

Lean: one implementer, unit tests for what changes, full gates (e2e included) once at the end;
the main session runs `npm run eval:ai -- -u` after the merge. Then one live run by the author.

## Sixth live run and the author's decision (2026-10-15, confirmed)

The sixth run (reader.v7, reports 2026-10-15T14:40 and 14:48 UTC) failed: suggestion precision
42.1 % and 56.3 % (41 and 24 unjudged), one planted negative suggested (the Captain "owed Mr.
Varrow money" as `detail:wealth`). The concrete slots stayed about 90 % right; traits and history
were about half noise (dialogue and single acts as traits, Mrs. Harrow's lines filed under Lady
Pell and Mrs. Tull, trivia as history).

**Decision: concrete-only suggestions, then the copy trial.** Traits and history are not read
again (back to `reader.v6`'s slot set and prompt; `reader.v7` stays in the catalogue, unused);
everything stays a suggestion the author accepts. Ms Scribe answers history and character
questions from the text. No more test-book live runs for now: the author tries suggestions on a
copy of the real book.
