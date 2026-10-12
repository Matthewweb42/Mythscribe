import { aiFailure } from '@shared/ai'
import type { AiSettings } from '@shared/aiSettings'
import type { ReadNowResult } from '@shared/memory/views'
import { assertFeatureAllowed } from '../../ai/dial'
import { registerInflight, releaseInflight } from '../../ai/inflight'
import { AiProviderError } from '../../ai/providers/types'
import type { AiRequestDeps } from '../../ai/request'
import type { TreeDb } from '../../tree/treeStore'
import { runReading } from './pipeline'

/**
 * The reader service (F-16.16, F-16.17; plan P2a §2.6, rule 8): the one place the IPC handlers
 * reach the reading pipeline, so `handlers.ts` only registers channels. In slice 2 it runs *Read
 * now*: the gates first (Use AI, and the **Story memory reading** switch, which covers the reader
 * and its checker), then `runReading`, then the `memory:changed` push (and the name questions,
 * when a reading left facts waiting on a new name). Slice 3 adds the queue (leave, idle, the
 * backlog, Rebuild memory), the health gate and the Cloud cap; *Read now* then runs ahead of it.
 */

export interface ReaderServiceDeps {
  /** The open project's database (throws NO_PROJECT when none is open). */
  db: () => TreeDb
  settings: (db: TreeDb) => AiSettings
  requestDeps: (db: TreeDb) => AiRequestDeps
  /** `memory:changed` for these scenes and records. */
  changed: (payload: { nodeIds: string[]; recordIds: string[] }) => void
  /** The name questions may have moved (facts waiting on a new name). */
  questions: () => void
}

export interface ReaderService {
  readNow(nodeId: string, requestId: string): Promise<ReadNowResult>
}

export function createReaderService(deps: ReaderServiceDeps): ReaderService {
  return {
    async readNow(nodeId, requestId) {
      const db = deps.db()
      const controller = registerInflight(requestId)
      try {
        const settings = deps.settings(db)
        assertFeatureAllowed(settings, 'reader')
        assertFeatureAllowed(settings, 'verify')
        const outcome = await runReading(
          db,
          { ai: deps.requestDeps(db) },
          { nodeId, caretPara: null, requestId, signal: controller.signal }
        )
        if (!outcome.read) {
          const paused = outcome.reason === 'localCutoff'
          return {
            ok: true,
            read: false,
            reason: paused ? 'paused' : outcome.reason,
            readingId: null,
            costUsd: paused ? outcome.costUsd : 0
          }
        }
        deps.changed({ nodeIds: [nodeId], recordIds: outcome.recordIds })
        if (outcome.names.length > 0) deps.questions()
        return {
          ok: true,
          read: true,
          reason: null,
          readingId: outcome.readingId,
          costUsd: outcome.costUsd
        }
      } catch (err) {
        if (err instanceof AiProviderError) return aiFailure(err.code, err.message)
        throw err
      } finally {
        releaseInflight(requestId)
      }
    }
  }
}
