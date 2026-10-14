import { z } from 'zod'
import { AiSource } from '../aiSettings'
import { TwinRule } from './twinGate'

/**
 * The story-memory switch-over (F-16.15, story memory P1 slice 6; F-16.31 part A, plan
 * `Switchover.md`; design Part 3, answer 16): the steps that move a v1 project onto v2, on a test
 * copy or, since F-16.31, on the project itself. One owner for the shapes both sides share: the
 * dry run (`SwitchoverPlan`), the consent screen's inline-tag rows, what the author consents to,
 * the steps and their failures, what the conversion answers, and the switch-over record. The
 * rules are `src/main/memory/switchover/`; the pure mapping is `switchoverMapping.ts`.
 */

/**
 * The `settings` row that marks a project as a switch-over trial copy (*Try it on a copy first*).
 * A test copy skips the safety step (its original is its safety, decision SW-D4) and its record
 * says `trial`; otherwise it runs as the project itself does. Once the author has written in the
 * copy (its prose no longer matches `prose`), the original no longer holds that writing, so the
 * conversion keeps a backup of the copy first (no dated copy; review of Switch-over slice 1).
 */
export const SWITCHOVER_TRIAL_KEY = 'switchoverTrial'

export const SwitchoverTrial = z.object({
  /** The folder the copy was made from. */
  source: z.string(),
  createdAt: z.string(),
  /**
   * A digest of the copy's prose as it was made (every node's content and notes, every draft's
   * text: what the conversion rewrites). Absent on a copy made before 2026-10-14, which therefore
   * always gets its backup.
   */
  prose: z.string().optional()
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
 * The in-place run's steps, in order (F-16.31, plan Switchover §1.2): the Google Drive working
 * copy flushed, the kept backup, the dated copy beside the project, the open project checked, the
 * conversion. A failure names the step it stopped at.
 */
export const SWITCHOVER_STEPS = ['flush', 'backup', 'datedCopy', 'project', 'convert'] as const
export const SwitchoverStep = z.enum(SWITCHOVER_STEPS)
export type SwitchoverStep = z.infer<typeof SwitchoverStep>

/** How every failure's message ends: a failed step changed nothing. */
export const SWITCHOVER_NOTHING_CHANGED =
  'Nothing was changed: this project still uses the old story memory.'

/**
 * A step that failed (F-16.31): which, what happened (ending `SWITCHOVER_NOTHING_CHANGED`), and
 * what to do next. The project is still v1 and untouched.
 */
export const SwitchoverFailure = z.object({
  ok: z.literal(false),
  step: SwitchoverStep,
  message: z.string(),
  nextStep: z.string()
})
export type SwitchoverFailure = z.infer<typeof SwitchoverFailure>

/**
 * What `switchover:safety` answers (the project itself, before the dry run): the kept backup and
 * the dated copy beside the project (in Google Drive for a Drive project), or the failure.
 */
export const SwitchoverSafetyOutcome = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), backup: z.string(), datedCopy: z.string() }),
  SwitchoverFailure
])
export type SwitchoverSafetyOutcome = z.infer<typeof SwitchoverSafetyOutcome>

/**
 * What a conversion that ran answers: the counts, the safety copies (the kept backup and the dated
 * copy; null on a test copy, whose original is its safety), and the folder, which main has closed
 * so the renderer reopens it on v2.
 */
export const SwitchoverResult = z.object({
  folder: z.string(),
  trial: z.boolean(),
  backup: z.string().nullable(),
  datedCopy: z.string().nullable(),
  counts: SwitchoverCounts
})
export type SwitchoverResult = z.infer<typeof SwitchoverResult>

/** What `switchover:convert` takes: the consent, and the open project's id (decision SW-D5). */
export const SwitchoverConvertInput = z.object({
  consent: SwitchoverConsent,
  projectId: z.string().min(1)
})
export type SwitchoverConvertInput = z.infer<typeof SwitchoverConvertInput>

/** What `switchover:convert` answers: the result, or the step that failed. */
export const SwitchoverOutcome = z.discriminatedUnion('ok', [
  SwitchoverResult.extend({ ok: z.literal(true) }),
  SwitchoverFailure
])
export type SwitchoverOutcome = z.infer<typeof SwitchoverOutcome>

/**
 * The switch-over record (F-16.31, decision SW-D7): a project `settings` row written in the
 * conversion's transaction, so where the backup and the dated copy are, and how to go back, are
 * never lost with the dialog. `rebuild` is `waiting` until a *Rebuild memory* starts.
 */
export const SWITCHOVER_RECORD_KEY = 'switchover'

export const SwitchoverRecord = z.object({
  switchedAt: z.string(),
  /** A test copy (`switchoverTrial`). */
  trial: z.boolean(),
  /** The kept backup's zip (null on a test copy). */
  backup: z.string().nullable(),
  /** The dated copy's folder (null on a test copy). */
  datedCopy: z.string().nullable(),
  rebuild: z.enum(['waiting', 'started']),
  rebuildStartedAt: z.string().nullable()
})
export type SwitchoverRecord = z.infer<typeof SwitchoverRecord>
