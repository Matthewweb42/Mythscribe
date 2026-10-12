import { z } from 'zod'
import { AiSource } from '../aiSettings'
import { TwinRule } from './twinGate'

/**
 * The story-memory switch-over (F-16.15, story memory P1 slice 6; design Part 3, answer 16): the
 * steps that move a v1 project onto v2, built and tested on copies only in P1. One owner for the
 * shapes both sides share: the dry run (`SwitchoverPlan`), the consent screen's inline-tag rows,
 * what the author consents to, and what the conversion answers. The rules are
 * `src/main/memory/switchover/`; the pure mapping is `switchoverMapping.ts`.
 */

/**
 * The `settings` row that marks a project as a switch-over trial copy (Help › Try the
 * story-memory switch-over on a copy…). The `switchover:*` channels refuse a project without it
 * unless the in-place run of F-16.31 says so (`allowInPlace`), so in P1 nothing converts a real
 * project.
 */
export const SWITCHOVER_TRIAL_KEY = 'switchoverTrial'

export const SwitchoverTrial = z.object({
  /** The folder the copy was made from. */
  source: z.string(),
  createdAt: z.string()
})
export type SwitchoverTrial = z.infer<typeof SwitchoverTrial>

/** The label a trial copy and the safety copy carry in their folder names. */
export const TRIAL_COPY_LABEL = 'story memory test'
export const SAFETY_COPY_LABEL = 'before story memory'

/** One line of the dry run: what (by name) and what happens to it. */
export const SwitchoverItem = z.object({ name: z.string(), detail: z.string() })
export type SwitchoverItem = z.infer<typeof SwitchoverItem>

/**
 * Two records-to-be the twin gate says may be one (`twinPairs`), offered for a merge the author
 * ticks; unticked by default. `keep` and `merge` are the planned records' keys (`entity:<id>`,
 * `tag:<id>`, `pov:<name>`).
 */
export const SwitchoverMerge = z.object({
  keep: z.string(),
  keepName: z.string(),
  /** The category's noun ("character"), so two records of one name can be told apart. */
  keepCategory: z.string(),
  merge: z.string(),
  mergeName: z.string(),
  mergeCategory: z.string(),
  rule: TwinRule,
  /** The name that matched, and what it matched. */
  name: z.string(),
  matched: z.string()
})
export type SwitchoverMerge = z.infer<typeof SwitchoverMerge>

/** The computed price and time of *Rebuild memory* after the switch (the rebuild itself is P2a's). */
export const RebuildEstimate = z.object({
  scenes: z.number().int(),
  requests: z.number().int(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costUsd: z.number(),
  /** False when a model's price is unknown (the cost is then a lower bound). */
  priced: z.boolean(),
  source: AiSource,
  fastModel: z.string(),
  strongModel: z.string(),
  minutes: z.number().int()
})
export type RebuildEstimate = z.infer<typeof RebuildEstimate>

/**
 * The dry run (`switchover:plan`): writes nothing. By name, what is kept as it is, what is
 * converted (records, labels, Research, typed details, dismissals), and what is dropped (what the
 * AI made); the merge list; the sheet text the AI wrote, which moves to a Not canon block; the
 * notes (nesting dropped, dismissals that cannot convert, custom labels); the rebuild estimate.
 */
export const SwitchoverPlan = z.object({
  kept: z.array(SwitchoverItem),
  converted: z.array(SwitchoverItem),
  dropped: z.array(SwitchoverItem),
  merges: z.array(SwitchoverMerge),
  /** Per record: the lines that go under "Filed by AI earlier: please check". */
  filedByAi: z.array(z.object({ name: z.string(), lines: z.array(z.string()) })),
  notes: z.array(z.string()),
  /** Distinct inline tags the consent screen will list. */
  inlineTags: z.number().int(),
  rebuild: RebuildEstimate
})
export type SwitchoverPlan = z.infer<typeof SwitchoverPlan>

/** The longest replacement the consent screen takes. */
export const INLINE_TAG_REPLACEMENT_MAX = 200

/**
 * One row of the consent screen (`switchover:consent`): one inline tag (by the tag its tokens
 * resolve to, merges followed), how many tokens, a sample, and the words that replace it: the
 * name of the record the tag becomes (its sheet's, or the tag's own as a record names it),
 * otherwise (a label, a dropped or deleted tag) the tag name with hyphens as spaces. Editable per
 * row.
 */
export const InlineTagReplacement = z.object({
  key: z.string(),
  /** The tag as the author knows it (`#name`). */
  tag: z.string(),
  count: z.number().int(),
  sample: z.string(),
  replacement: z.string()
})
export type InlineTagReplacement = z.infer<typeof InlineTagReplacement>

/** What the author agreed to: the words per inline tag, and the merges she ticked. */
export const SwitchoverConsent = z.object({
  replacements: z
    .array(
      z.object({
        key: z.string().min(1).max(200),
        text: z.string().trim().min(1).max(INLINE_TAG_REPLACEMENT_MAX)
      })
    )
    .max(5000),
  merges: z.array(z.object({ keep: z.string(), merge: z.string() })).max(500)
})
export type SwitchoverConsent = z.infer<typeof SwitchoverConsent>

/** What the conversion wrote, for the done screen. */
export const SwitchoverCounts = z.object({
  records: z.number().int(),
  labels: z.number().int(),
  research: z.number().int(),
  scenesWithDetails: z.number().int(),
  dismissals: z.number().int(),
  merged: z.number().int(),
  /** Inline tag tokens replaced, and the documents (contents, notes, inactive drafts) rewritten. */
  tokens: z.number().int(),
  documents: z.number().int()
})
export type SwitchoverCounts = z.infer<typeof SwitchoverCounts>

/**
 * What `switchover:convert` answers: the counts, the safety copies made first (the backup file
 * and the dated copy; when either cannot be written the call fails and nothing converts), and
 * the folder, which main has closed so the renderer reopens it on v2.
 */
export const SwitchoverResult = z.object({
  folder: z.string(),
  backup: z.string(),
  datedCopy: z.string(),
  counts: SwitchoverCounts
})
export type SwitchoverResult = z.infer<typeof SwitchoverResult>
