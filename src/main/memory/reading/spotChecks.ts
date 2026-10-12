import type { Claim } from '@shared/memory/claims'
import { parseVerifyAnswer } from '@shared/memory/readerAnswer'
import {
  REBUILD_FAST_CHECKS,
  REBUILD_STRONG_CHECKS,
  SPOT_EVERY,
  SPOT_FAST_BATCH,
  SPOT_STRONG_AROUND,
  SPOT_STRONG_DUE,
  spotPicked
} from '@shared/memory/spot'
import { sentenceHash } from '@shared/memory/anchor'
import { activeDraftId } from '../../draft/draftStore'
import { cancelInflight } from '../../ai/inflight'
import { VERIFY_PROMPT_VERSION, buildVerifyPrompt } from '../../ai/prompts/verify.v1'
import { AiCancelledError } from '../../ai/providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from '../../ai/request'
import type { TreeDb } from '../../tree/treeStore'
import { deleteClaims, draftClaims, getClaim, setClaimSpot } from './claimStore'
import { agrees, claimCheck, type ClaimCheck } from './pipeline'
import { loadReadingScene, type ReadingScene } from './readerContext'
import { getSpotState, setSpotState, type SpotState } from './readerRows'
import { readerRoster } from './rosterCache'

/**
 * Spot checks (F-16.17; design §2.3 "Measuring accuracy without a gold set" 3, plan P2a §3.5,
 * P2a-D8). After a *Rebuild memory*, 50 live claims proved in code go back through the fast
 * checker (10 per call, each with its sentences ±1) and 20 live claims the checker passed go to the
 * strong model (one per call, three sentences either side, 40 tokens out). From then on, 1 new
 * literal claim in 20 rides its reading's check batch (`pipeline.ts`, `spotEvery`), and 1 new
 * verified claim in 20 waits here for the next strong batch, sent once 5 wait. A strong rejection
 * deletes the claim (counted); a fast disagreement with code is only counted on the claim.
 */

export interface SpotRun {
  /** Whether any request left (the queue's rate limit counts it). */
  requested: boolean
  costUsd: number
  checked: { fast: number; strong: number }
  /** The claims a strong check refused, deleted. */
  deleted: string[]
  nodeIds: string[]
  recordIds: string[]
}

export interface SpotRunInput {
  requestId: string
  signal?: AbortSignal
}

/** Live claims of the active draft with no spot check yet, proved this way, in a stable order. */
function unchecked(db: TreeDb, proof: Claim['proof']): Claim[] {
  return draftClaims(db, activeDraftId(db))
    .filter(
      (claim) =>
        claim.state === 'live' &&
        claim.proof === proof &&
        claim.spot === null &&
        claim.recordId !== null
    )
    .sort((a, b) => sentenceHash(a.id).localeCompare(sentenceHash(b.id)))
}

/** Whether the strong checks waiting (or a rebuild's pass) make a spot-check run due. */
export function spotCheckDue(state: SpotState): boolean {
  return state.rebuildPass || state.strongDue.length >= SPOT_STRONG_DUE
}

/**
 * After a reading stored claims: 1 verified claim in 20 joins the strong batch's wait (only once a
 * rebuild has run). Answers whether a spot-check run is now due.
 */
export function pickStrongDue(
  db: TreeDb,
  inserted: readonly { id: string; proof: Claim['proof'] }[]
): boolean {
  const state = getSpotState(db)
  if (state.rebuiltAt === null) return spotCheckDue(state)
  const picked = inserted
    .filter((claim) => claim.proof === 'verified' && spotPicked(claim.id, SPOT_EVERY))
    .map((claim) => claim.id)
  if (picked.length > 0) {
    setSpotState(db, { ...state, strongDue: [...new Set([...state.strongDue, ...picked])] })
  }
  return spotCheckDue(getSpotState(db))
}

/** After a rebuild: its 50 fast and 20 strong checks are due, and 1 in 20 is checked from now on. */
export function markRebuilt(db: TreeDb, now: Date): void {
  setSpotState(db, { ...getSpotState(db), rebuiltAt: now.toISOString(), rebuildPass: true })
}

/** Runs the spot checks that are due (the `spotCheck` job). */
export async function runSpotChecks(
  db: TreeDb,
  deps: { ai: AiRequestDeps },
  input: SpotRunInput
): Promise<SpotRun> {
  const state = getSpotState(db)
  const run: SpotRun = {
    requested: false,
    costUsd: 0,
    checked: { fast: 0, strong: 0 },
    deleted: [],
    nodeIds: [],
    recordIds: []
  }
  const roster = readerRoster(db)
  const scenes = new Map<string, ReadingScene | null>()
  const sceneOf = (nodeId: string): ReadingScene | null => {
    if (!scenes.has(nodeId)) scenes.set(nodeId, loadReadingScene(db, nodeId))
    return scenes.get(nodeId) ?? null
  }
  const checkOf = (claim: Claim, around: number): ClaimCheck | null => {
    const scene = sceneOf(claim.nodeId)
    return scene === null ? null : claimCheck(scene, claim, roster, around)
  }

  let calls = 0
  let inFlight: string | null = null
  const onAbort = (): void => {
    if (inFlight !== null) cancelInflight(inFlight)
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })
  const ask = async (
    items: readonly ClaimCheck[],
    strong: boolean
  ): Promise<ReturnType<typeof parseVerifyAnswer>> => {
    if (input.signal?.aborted === true) throw new AiCancelledError('The spot checks were stopped.')
    const prompt = buildVerifyPrompt({ items, strong })
    calls += 1
    inFlight = `${input.requestId}:s${calls}`
    try {
      const result = await runAiRequest(deps.ai, {
        feature: 'verify',
        tier: strong ? 'strong' : 'fast',
        messages: prompt.messages,
        maxTokens: prompt.maxTokens,
        json: true,
        contextHash: sha256(JSON.stringify(prompt.messages)),
        promptVersion: VERIFY_PROMPT_VERSION,
        requestId: inFlight,
        cacheIf: (text) => parseVerifyAnswer(text).size > 0
      })
      if (!result.cached) run.requested = true
      run.costUsd += result.costUsd
      return parseVerifyAnswer(result.text)
    } finally {
      inFlight = null
    }
  }

  try {
    const now = (): Date => deps.ai.now()
    // The fast checks of claims proved in code: a rebuild's 50, counted only.
    if (state.rebuildPass) {
      const fast = unchecked(db, 'literal')
        .map((claim) => ({ claim, check: checkOf(claim, 1) }))
        .filter((entry): entry is { claim: Claim; check: ClaimCheck } => entry.check !== null)
        .slice(0, REBUILD_FAST_CHECKS)
      for (let at = 0; at < fast.length; at += SPOT_FAST_BATCH) {
        const batch = fast.slice(at, at + SPOT_FAST_BATCH)
        const verdicts = await ask(
          batch.map((entry) => entry.check),
          false
        )
        for (const [i, entry] of batch.entries()) {
          const verdict = verdicts.get(i + 1)
          if (verdict === undefined) continue
          const agreed = agrees(verdict, {
            expect: entry.check.expect,
            voice: entry.claim.voice,
            mode: entry.claim.mode
          })
          setClaimSpot(db, entry.claim.id, agreed ? 'agree' : 'disagree', 'fast', now())
          run.checked.fast += 1
        }
      }
    }
    // The strong checks of claims the checker passed: a rebuild's 20, or the 1 in 20 waiting.
    const strongIds = state.rebuildPass
      ? unchecked(db, 'verified')
          .slice(0, REBUILD_STRONG_CHECKS)
          .map((claim) => claim.id)
      : state.strongDue
    const sent = new Set<string>()
    const draftId = activeDraftId(db)
    for (const id of strongIds) {
      const claim = getClaim(db, id)
      sent.add(id)
      // Another draft's claim reads against text that is not on the page: it waits for its draft.
      if (claim?.draftId !== draftId) {
        if (claim !== null) sent.delete(id)
        continue
      }
      if (claim.state !== 'live' || claim.spot !== null) continue
      const check = checkOf(claim, SPOT_STRONG_AROUND)
      if (check === null) continue
      const verdict = (await ask([check], true)).get(1)
      if (verdict === undefined) continue
      run.checked.strong += 1
      if (agrees(verdict, { expect: check.expect, voice: claim.voice, mode: claim.mode })) {
        setClaimSpot(db, claim.id, 'agree', 'strong', now())
        continue
      }
      // The strong model refused what the fast checker passed: the claim goes (P2a-D8).
      deleteClaims(db, [claim.id])
      run.deleted.push(claim.id)
      run.nodeIds.push(claim.nodeId)
      if (claim.recordId !== null) run.recordIds.push(claim.recordId)
    }
    const after = getSpotState(db)
    setSpotState(db, {
      ...after,
      rebuildPass: false,
      strongDue: after.strongDue.filter((id) => !sent.has(id))
    })
    run.nodeIds = [...new Set(run.nodeIds)]
    run.recordIds = [...new Set(run.recordIds)]
    return run
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }
}
