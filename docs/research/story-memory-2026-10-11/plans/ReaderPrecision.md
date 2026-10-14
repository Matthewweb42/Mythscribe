# Reader precision (2026-10-14)

Three live planted-error runs failed (F-16.17). Each round patched the instances seen and the
next run showed new instances of the same families. This plan replaces instance patching.

## The author's decisions (2026-10-14)

- Build this plan; meanwhile the author tries the switch-over on a **copy** of the real book.
  The real project stays on v1 until the final live run passes.
- **The main bar: at least 95 % of stored facts are correct**, measured over every stored
  fact, not only facts on labelled sentences. Plus: no planted trap or negative stored, no
  claim from a never-read scene.

## What the third run showed (test-results/eval-memory, 2026-10-14T21:35)

- Safety bars passed: attribution 100 %, literal 100 %, support 93.8 %, never-read 0.
- "Quotes found" 78 % is mostly harmless refusals: invented slots (`voice` ×18, likely because
  the output has a field named `voice`), too short/long, other paragraph.
- "Verifier pass" 79.3 % is an efficiency figure: checker refusals are the system working.
- The one negative: the green-eyes trap ("The two women sat… She had green eyes") — a pronoun
  with two same-gender candidates in reach was accepted.
- 90 of 116 stored facts sit on unlabelled sentences; about 1 in 10 of those is wrong (wrong
  person: "he asked Miss Pell" → Clara; Hobb's sugar plum → Johanna; wrong kind: Hobb age
  "forty years"; a place as subject: Thornmere location; another person's: the Captain kinship
  "father"; junk relation lines).

## Steps

1. **Measure what matters.**
   - Label every sentence the live runs stored a fact on (the three reports' unreviewed lists),
     true or negative, from the text alone; list judgment calls for the author in QUESTIONS.md.
   - New bar: stored-fact precision ≥ 95 % over all stored facts (labelled after step 1).
   - "Quotes found" split: refusals for slot/length (cost, reported, no bar) vs a quote that
     is really not in the text (bar stays 90 % of the latter's denominator).
   - Verifier pass becomes a reported efficiency figure; no bar (decided by Claude,
     unconfirmed — the author confirmed only the 95 % bar).
   - The live runner can run the book twice (`MYTHSCRIBE_EVAL_RUNS=2`) and reports both.
2. **Fix causes, not instances.**
   - Rename the output field `voice` (e.g. `src`) in a new reader version so it stops being
     written as a slot.
   - Ambiguous pronoun gate: he/she/they as the subject is refused when more than one
     same-gender (or any, for they) named person is in reach of the paragraph.
   - Open-ended slots (history, traits, relation, kinship, role): stricter value rules in the
     prompt (who did what must be the subject; kinship value is the relation word to a named
     person), and their verification on the strong tier (DeepSeek V4 Pro, now $0.40/M in).
   - Kind gate extended: places/things never subjects of any person slot incl. location.
   - Every instance above planted in the offline replay.
3. **One final live run** (author runs it). Pass → the author switches the real project after
   the copy trial. Fail → stop and report; no fourth round of patches without the author.

Lean process (CLAUDE.md, 2026-10-14): one implementer, unit tests for what changes, full gates
once at the end.
