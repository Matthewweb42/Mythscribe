import { and, eq, isNull } from 'drizzle-orm'
import { isFeatureAllowed } from '@shared/aiSettings'
import { VOICE_AUTO_REFRESH_WORDS } from '@shared/voice'
import { AiCancelledError } from '../ai/providers/types'
import type { AiRequestDeps } from '../ai/request'
import { refreshVoiceNotes, voiceNotesDue } from '../ai/voiceNotes'
import { node } from '../db/schema'
import { getAiSettings, getVoiceNotes } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { refreshAutoExemplars } from './autoExemplars'

/**
 * The voice job (F-14.14, decided by Claude, unconfirmed): one `voice` job per project, keyed to
 * the manuscript root in `index_job`, run on its own silent queue instance `VOICE_JOB_DEBOUNCE_MS`
 * after the last save and once on open. It never blocks typing and never surfaces a failure:
 * the local step (automatic exemplars) cannot fail on a provider, and the AI step (learned
 * notes) runs only when due, allowed, and a provider is set up; its failure is remembered so a
 * broken key is not asked again until the manuscript has moved by `VOICE_AUTO_REFRESH_WORDS`.
 */

/** The id the voice job is keyed to: the manuscript root, or null for a project without one. */
export function manuscriptRootId(db: TreeDb): string | null {
  const row = db
    .select({ id: node.id })
    .from(node)
    .where(and(isNull(node.parentId), eq(node.sectionType, 'manuscript')))
    .get()
  return row?.id ?? null
}

export interface VoiceJobDeps {
  /** The request path for this project, built only when the notes step actually runs. */
  request: () => AiRequestDeps
  /** Whether a provider for the project's AI source is set up (a key, an account, a local server). */
  providerReady: () => boolean
  now: () => Date
}

/** What the session remembers between runs: the word count at the notes step's last failure. */
export interface VoiceJobMemo {
  failedAtWords: number | null
}

export interface VoiceJobResult {
  exemplarsChanged: boolean
  notesChanged: boolean
  /** Whether a provider request actually left (the queue's rate limit counts only those). */
  requested: boolean
}

export async function runVoiceJob(
  db: TreeDb,
  deps: VoiceJobDeps,
  options: { requestId?: string; memo: VoiceJobMemo }
): Promise<VoiceJobResult> {
  const local = refreshAutoExemplars(db, deps.now())
  const result: VoiceJobResult = {
    exemplarsChanged: local.changed,
    notesChanged: false,
    requested: false
  }
  if (!isFeatureAllowed(getAiSettings(db), 'voiceNotes') || !deps.providerReady()) return result
  if (!voiceNotesDue(getVoiceNotes(db), local.words)) return result
  const failed = options.memo.failedAtWords
  if (failed !== null && Math.abs(local.words - failed) < VOICE_AUTO_REFRESH_WORDS) return result
  try {
    const run = await refreshVoiceNotes(db, deps.request(), {
      ...(options.requestId === undefined ? {} : { requestId: options.requestId })
    })
    options.memo.failedAtWords = null
    return { ...result, notesChanged: true, requested: !run.cached }
  } catch (err) {
    if (err instanceof AiCancelledError) throw err
    options.memo.failedAtWords = local.words
    return result
  }
}
