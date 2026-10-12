import { PLANNED_COST_NOTES, SHIPPED_PLAN_ROWS, type PlannedCostNote } from '@shared/aiCostNotes'
import type { AiSource } from '@shared/aiSettings'
import type { PricingResult } from '@shared/cloudApi'
import { CONVERSION_SECONDS_PER_SCENE } from '@shared/knowledge'
import { REBUILD_FAST_CHECKS, REBUILD_STRONG_CHECKS } from '@shared/memory/spot'
import type {
  InlineTagReplacement,
  RebuildEstimate,
  SwitchoverPlan
} from '@shared/memory/switchover'
import { estimateCost } from '../../knowledge/conversion'
import type { TreeDb } from '../../tree/treeStore'
import { buildSwitchoverModel } from './model'

/**
 * The switch-over's dry run (F-16.15, plan P1 §6.1 step 2) and consent rows (step 3). Both read
 * only: the model (`buildSwitchoverModel`) is reported by name, and the rebuild that follows the
 * switch (P2a's *Rebuild memory*) is priced from the planned `reader.v1` and `verify.v1` rows over
 * this book's own scene sizes, on the models the author has set up.
 */

/** Where the rebuild's requests would go and at what price. */
export interface RebuildContext {
  source: AiSource
  /** The fast and strong tiers' models ('' with no provider). */
  fastModel: string
  strongModel: string
  /** The hosted price table, null until it has answered. */
  pricing: PricingResult | null
}

/**
 * The planned row with this id, planned or shipped (F-16.17 moved the reader and verify rows to
 * `SHIPPED_PLAN_ROWS`); `planSwitchover.test.ts` fails when one of them goes.
 */
export function plannedRow(id: string): PlannedCostNote {
  const row = [...PLANNED_COST_NOTES, ...SHIPPED_PLAN_ROWS].find((note) => note.id === id)
  if (row === undefined) throw new Error(`No planned cost row ${id}`)
  return row
}

/** The prose tokens a `reader.v1` first read takes per page (its `when`: pages of 2,500). */
export const REBUILD_PAGE_TOKENS = 2_500
/** Spot checks per rebuild (the `verify.v1:pro` and `verify.v1:spot` rows' `when`). */
export { REBUILD_FAST_CHECKS, REBUILD_STRONG_CHECKS }

/**
 * The rebuild's price and time: each scene read whole once (`reader.v1:first`, one request per
 * page of `REBUILD_PAGE_TOKENS` prose tokens, the row's other input on each page) and its claims
 * verified once per page (`verify.v1`), then the spot checks; priced on the configured fast and
 * strong models (`estimateCost`), minutes from `CONVERSION_SECONDS_PER_SCENE`.
 */
export function estimateRebuild(
  scenes: readonly number[],
  context: RebuildContext
): RebuildEstimate {
  const reader = plannedRow('reader.v1:first')
  const verify = plannedRow('verify.v1')
  const strong = plannedRow('verify.v1:pro')
  const spot = plannedRow('verify.v1:spot')
  const overhead = reader.typicalInTokens - REBUILD_PAGE_TOKENS
  let pages = 0
  let fastIn = 0
  let fastOut = 0
  for (const tokens of scenes) {
    const sceneTokens = Math.max(tokens, 1)
    const scenePages = Math.ceil(sceneTokens / REBUILD_PAGE_TOKENS)
    pages += scenePages
    fastIn += sceneTokens + scenePages * (overhead + verify.typicalInTokens)
    fastOut += scenePages * (reader.typicalOutTokens + verify.typicalOutTokens)
  }
  const checks = scenes.length === 0 ? 0 : 1
  fastIn += checks * REBUILD_FAST_CHECKS * spot.typicalInTokens
  fastOut += checks * REBUILD_FAST_CHECKS * spot.typicalOutTokens
  const strongIn = checks * REBUILD_STRONG_CHECKS * strong.typicalInTokens
  const strongOut = checks * REBUILD_STRONG_CHECKS * strong.typicalOutTokens
  const fast = estimateCost(
    { source: context.source, model: context.fastModel, pricing: context.pricing },
    fastIn,
    fastOut
  )
  const strongCost = estimateCost(
    { source: context.source, model: context.strongModel, pricing: context.pricing },
    strongIn,
    strongOut
  )
  return {
    scenes: scenes.length,
    requests: pages * 2 + checks * (REBUILD_FAST_CHECKS + REBUILD_STRONG_CHECKS),
    tokensIn: fastIn + strongIn,
    tokensOut: fastOut + strongOut,
    costUsd: fast.costUsd + strongCost.costUsd,
    priced: fast.priced && strongCost.priced,
    source: context.source,
    fastModel: context.fastModel,
    strongModel: context.strongModel,
    minutes:
      scenes.length === 0
        ? 0
        : Math.max(1, Math.ceil((scenes.length * CONVERSION_SECONDS_PER_SCENE) / 60))
  }
}

/** The dry run (`switchover:plan`): writes nothing. */
export function planSwitchover(db: TreeDb, context: RebuildContext): SwitchoverPlan {
  const model = buildSwitchoverModel(db)
  return {
    kept: model.kept,
    converted: model.converted,
    dropped: model.dropped,
    merges: model.merges,
    filedByAi: model.records
      .filter((record) => record.filedByAi.length > 0)
      .map((record) => ({ name: record.name, lines: record.filedByAi })),
    notes: model.notes,
    inlineTags: model.inlineTags.length,
    rebuild: estimateRebuild(model.rebuildScenes, context)
  }
}

/**
 * The consent screen's rows (`switchover:consent`): every inline tag with its count, a sample and
 * its default replacement, the linked sheet's name or the tag name with hyphens as spaces.
 */
export function inlineTagReplacements(db: TreeDb): InlineTagReplacement[] {
  return buildSwitchoverModel(db).inlineTags.map((row) => ({
    key: row.key,
    tag: row.tag,
    count: row.count,
    sample: row.sample,
    replacement: row.replacement
  }))
}
