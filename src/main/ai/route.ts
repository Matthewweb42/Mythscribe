import { z } from 'zod'
import {
  localRoute,
  ROUTE_HISTORY_TURNS,
  ROUTE_INSTRUCTION_MAX,
  ROUTE_MESSAGE_CHARS,
  ROUTE_SELECTION_PREVIEW_CHARS,
  ROUTE_TITLE_CHARS,
  ROUTE_TURN_CHARS,
  RouteAction,
  settleRoute,
  type RouteDecision,
  type RouteSituation
} from '@shared/assistantRoute'
import { getAiSettings } from '../project/settingsStore'
import { getNode, type TreeDb } from '../tree/treeStore'
import { headTruncate } from './context/chatContext'
import { assertFeatureAllowed } from './dial'
import type { ChatTurn } from './prompts/chat.v1'
import { buildRoutePrompt, ROUTE_PROMPT_VERSION } from './prompts/route.v1'
import type { CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

export interface RouteInput {
  /** The open document, or null with none open. */
  nodeId: string | null
  /** The author's chat message. */
  message: string
  /** The recent turns the renderer keeps, oldest first; only the last `ROUTE_HISTORY_TURNS` are read. */
  history: ChatTurn[]
  /** The selection in the open document, or null with none. */
  selection: { text: string } | null
  /** The caller's id for `ai:cancel` (F-5.10); optional so tests can run without one. */
  requestId?: string
}

export interface RouteResult extends RouteDecision {
  /** `local` when no request was needed (`localRoute`), `model` when the router was asked. */
  routedBy: 'local' | 'model'
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  /** The model that decided; null for a local decision. */
  model: string | null
  /** The prompt version that decided; null for a local decision. */
  promptVersion: string | null
}

const ModelAnswer = z.object({ action: z.unknown(), instruction: z.unknown().optional() })

/**
 * The assistant router (F-5.19). The gate first (`route` must be allowed: nothing is read or
 * sent below Ask or with the feature off). Then the situation — an open document (any document
 * outside the section roots) and a non-blank selection — and the local short-circuit
 * (`localRoute`: a message with no letters or digits, or exactly an action or quick-action id,
 * needs no request). Otherwise one fast-tier JSON request carrying exactly what the data-sharing
 * panel lists: the opening of the message, the last two turns cut short, the open document's
 * kind and title, and the opening of the selection. The answer never fails the turn: anything
 * unreadable is `chat` (`parseRouteAnswer`), and every decision passes `settleRoute` (a rewrite
 * needs a selection, a scene action an open document). Provider failures still come back as
 * errors, so the caller can fall back to the chat itself.
 *
 * The context hash covers everything that shaped the messages.
 */
export async function runRoute(
  db: TreeDb,
  deps: AiRequestDeps,
  input: RouteInput
): Promise<RouteResult> {
  assertFeatureAllowed(getAiSettings(db), 'route')

  const row = input.nodeId === null ? undefined : getNode(db, input.nodeId)
  const document = row !== undefined && row.parentId !== null && row.kind === 'document'
  const selectionText = input.selection?.text.trim() ?? ''
  const situation: RouteSituation = { hasNode: document, hasSelection: selectionText !== '' }

  const local = localRoute(input.message, situation)
  if (local !== null) {
    return {
      ...local,
      routedBy: 'local',
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      cached: false,
      model: null,
      promptVersion: null
    }
  }

  const message = headTruncate(input.message.trim(), ROUTE_MESSAGE_CHARS)
  const history = input.history.slice(-ROUTE_HISTORY_TURNS).map((turn) => ({
    role: turn.role,
    content: headTruncate(turn.content.trim(), ROUTE_TURN_CHARS)
  }))
  const active =
    row !== undefined && row.parentId !== null
      ? `${row.hierarchyLevel ?? row.kind} "${headTruncate(row.title, ROUTE_TITLE_CHARS)}"`
      : null
  const selection = selectionText
    ? headTruncate(selectionText, ROUTE_SELECTION_PREVIEW_CHARS)
    : null
  const prompt = buildRoutePrompt({ message, history, active, selection })

  const result = await runAiRequest(deps, {
    feature: 'route',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(JSON.stringify({ message, history, active, selection })),
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })

  return {
    ...settleRoute(parseRouteAnswer(result.text), situation),
    routedBy: 'model',
    usage: result.usage,
    costUsd: result.costUsd,
    cached: result.cached,
    model: result.model,
    promptVersion: ROUTE_PROMPT_VERSION
  }
}

/**
 * The model's `{ action, instruction }`, leniently: an answer that is not JSON, not an object,
 * or names no known action is `chat` (the router must never cost the author their turn); the
 * instruction is trimmed and cut to `ROUTE_INSTRUCTION_MAX`, and blank or not a string is null.
 * The action is matched case-insensitively, since models capitalise ids now and then.
 */
export function parseRouteAnswer(text: string): RouteDecision {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { action: 'chat', instruction: null }
  }
  const answer = ModelAnswer.safeParse(json)
  if (!answer.success || typeof answer.data.action !== 'string') {
    return { action: 'chat', instruction: null }
  }
  const wanted = answer.data.action.trim().toLowerCase()
  const action = RouteAction.options.find((id) => id.toLowerCase() === wanted)
  if (action === undefined) return { action: 'chat', instruction: null }
  const raw = answer.data.instruction
  const instruction =
    typeof raw === 'string' ? raw.trim().slice(0, ROUTE_INSTRUCTION_MAX).trim() : ''
  return { action, instruction: instruction || null }
}
