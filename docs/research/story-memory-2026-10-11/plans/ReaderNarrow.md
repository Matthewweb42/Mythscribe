# Reader narrowed to concrete facts (2026-10-14)

The fourth live planted-error run (two readings, reader.v5/verify.v4, reports in
`test-results/eval-memory/` stamped 2026-10-15T02:37 and 02:47 UTC) failed: stored-fact precision
46.1 % and 39.7 % as scored, about 79 % and 70 % once the unjudged facts are read. Concrete slots
were mostly right; nearly every wrong fact sat in the open-ended slots (traits, history, relation,
role) or in location, clothing and objects, plus a possessive given to the wrong person ("her dark
eyes" stored as Mr. Varrow's, "his features… hauteur" as Liesel's). Three rounds of patching showed
the same families each time (`ReaderPrecision.md`).

## The author's decision (2026-10-14, confirmed)

**Narrow it.** The reader stores only concrete facts. Traits, history, relations and roles are no
longer stored as facts; Ms Scribe answers those questions by searching the text and quoting the
passage (agent.v9 + cite.v1, already built). Then one more live run, with the 95 % stored-fact
precision bar measured on what is still stored.

## What is stored (decided by Claude, unconfirmed: the exact list)

- Kept: `eyes`, `born`, `species`, `kinship` (only to a named record, value the relation word),
  `hair`, `alive`, `age`, `scars`, `injuries`, `location` (where the person is now: a place phrase
  of at most 5 words, never a clause), and the `detail:<label>` slots (fixed and lasting, short
  values: occupation, income, birthplace, home…; a reported value stays a rumour).
- No longer read: `traits`, `history`, `relation`, `role`, `clothing`, `objects`. They stay in the
  closed slot list (stored v1 data, the author's own notes and the switch-over keep working); the
  reader is not asked for them and the pipeline refuses one in code with a new reason
  (`notRead`, reported as a cost, no bar).
- Unchanged: knows lines, thread steps, secrets and threads (P2b, their own live run), cards.

## Steps

1. **Prompt.** `reader.v6`: asks only for the kept slots, with the fewest rules that still say what
   each value is; drops the open-ended slot rules (fewer tokens than v5, and shorter replies, which
   should end the cut-offs v5 brought back: 6 and 4 of 18 readings lost paragraphs). `verify.v5`
   only if the checker's rules need the same cut; otherwise keep verify.v4 on the fast tier and
   retire the strong batch for the reading (kinship alone may stay strong if it earns it; say which).
2. **Code.** The pipeline refuses the dropped slots (`notRead`). Extend the pronoun gates to
   possessives for body and detail slots: "her"/"his" before the value must fit the subject's
   gender (titles, as now) and must not have two candidates in reach; "her dark eyes" can never be
   Mr. Varrow's. Location values must be a place phrase, not a clause ("near enough for her to
   overhear…" refused).
3. **Labels.** Judge every fact the fourth run stored in a kept slot (both reports, absolute path
   `/home/lostfromlight/coding/mythscribe/test-results/eval-memory/`) in `storedVerdicts`, strict,
   judgment calls flagged; find and explain run 2's wrong literal fact (literal precision 88.9 %).
   Re-score both readings offline under the narrowed set (only kept slots count) and report the
   numbers; this shows whether the narrowing alone reaches 95 % before any money is spent.
4. **Downstream.** Sheets, the This scene panel, Ms Scribe's instant cards, the switch-over replay,
   the knows and scribe oracles: anything that expected reader-made traits/history/relation/role
   lines is updated, never by hiding a stored v1 line or the author's own text. The sheets show no
   empty "History"/"Traits" section implying something is missing. Check that the scribe eval's
   labelled questions about traits or history are answered from cited passages.
5. **Prices.** aiCostNotes, rebuild and backlog prices follow the new calls.
6. **Docs.** FEATURES.md F-16.17 note (the author's decision), QUESTIONS.md entry, ARCHITECTURE
   bullet.
7. **One live run** by the author (`MYTHSCRIBE_EVAL_RUNS=2`). Pass → copy trial, then the real
   switch. Fail → stop and report.

Lean process: one implementer, unit tests for what changes, full gates once at the end. The main
session runs `npm run eval:ai -- -u` after the merge (the worktree guard refuses "eval").
