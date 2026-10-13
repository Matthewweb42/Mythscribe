# Story memory redesign (2026-10-11), approved by the author 2026-10-11

The author asked for a from-zero redesign of story memory (tags, lookups, sheets, auto-updates) optimised
for accuracy, ease of use, and token efficiency. **Approved by the author on 2026-10-11**, with the
recommended defaults except decision 3, which the author changed (see `design.md` › "Decisions
(2026-10-11)"). Building has started: P0 is done (2026-10-11; the author's probe run is still open), P1 is done
(2026-10-12; the author's checks in a development build are still open), P2a is done (2026-10-12; the
author's checks and the live runs are still open), P2b is done (2026-10-13; the author's checks, the
live knows run and live fidelity are still open), P3 is done (2026-10-13; the author's checks, the live
Ms Scribe run and live fidelity are still open), and P4 is planned (`plans/P4.md`).

- The spec: `FEATURES.md` §2.16 (F-16.1–16.38); milestones M8 (P0–P4 and the switch-over, before
  launch) and M9 (P5–P9, after launch) in `FEATURES.md` §6. The approval entry is in `QUESTIONS.md`
  (2026-10-11 · F-16).
- Phase plans: `plans/` (`plans/P0.md` first).
- The plan the author reviewed (Claude Docs, two tabs: Plan, Technical design, with an 8-row decisions
  table): https://claude.ai/artifact/UZ3sYxeoTL1cs3sLNb2Lic
- `author-answers.md`: the author's 24 binding answers from the Q&A.
- `design.md`: the final design (judge panel of three designs, merged, then revised after a four-lens
  red team: accuracy, cost, novelist, engineering). The Claude Docs plan was edited after a review
  (plain wording, To do kept, a Switching-over section, decision 8); where they differ, the doc wins.
- `research-brief.md` + `research-critique.md` (the critique corrects the brief) and `report-*.md`: six
  codebase maps and three web surveys (competitors, techniques, writers' needs).
