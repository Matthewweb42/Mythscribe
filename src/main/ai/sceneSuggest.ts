import { z } from 'zod'
import { inputBudget } from '@shared/ai'
import { docToText } from '@shared/docText'
import { SCENE_SYNOPSIS_MAX } from '@shared/sceneMeta'
import {
  NOTES_SUGGEST_CURRENT_CHARS,
  NOTES_SUGGEST_POINT_MAX,
  NOTES_SUGGEST_POINTS_MAX,
  SCENE_SUGGEST_CHAR_BUDGET,
  SCENE_SUGGEST_TEXT_MIN
} from '@shared/sceneSuggest'
import { STORY_BIBLE_PLANS_HEADING, STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import type { PromptCard } from '@shared/memory/cardText'
import type { StoryMemoryVersion } from '@shared/storyMemory'
import { getDocumentContent } from '../document/documentStore'
import { sceneBriefBlock } from '../document/sceneNeighbours'
import { getSummary } from '../document/summaryStore'
import { AppError } from '../ipc/errors'
import { promptCard } from '../memory/reading/cardContext'
import { buildStoryNotes } from '../memory/storyNotes'
import { getAiSettings } from '../project/settingsStore'
import { getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { headTruncate } from './context/chatContext'
import { notesText } from './context/scenePanel'
import { buildStoryBible } from './context/storyBible'
import { fitSceneToBudget } from './critique'
import { assertFeatureAllowed } from './dial'
import { buildNotesSuggestPromptV2 } from './prompts/notesSuggest.v2'
import { buildNotesSuggestPromptV4 } from './prompts/notesSuggest.v4'
import { buildSynopsisPrompt } from './prompts/synopsis.v1'
import { buildSynopsisPromptV2 } from './prompts/synopsis.v2'
import { AiFallbackError, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

/** What both suggestions report besides their content. */
interface SuggestMeta {
  /** Whether the scene was cut from the end before it was sent. */
  truncated: boolean
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  model: string
  promptVersion: string
}

export interface SynopsisResult extends SuggestMeta {
  synopsis: string
}

export interface NotesSuggestResult extends SuggestMeta {
  points: string[]
  /** How many points the answer held that `parseNotesSuggestAnswer` threw away. */
  dropped: number
}

export interface SuggestInput {
  nodeId: string
  /** The caller's id for `ai:cancel` (F-5.10); optional so tests can run without one. */
  requestId?: string
  /**
   * F-16.4: the open project's story memory. v1 sends the stored summary (`synopsis.v1`,
   * `notesSuggest.v2` with the story bible as notes and plans); v2 (F-16.20) sends the scene's v2
   * card in its place (`synopsis.v2`, `notesSuggest.v4` with the Story notes block, F-16.14).
   */
  memory: StoryMemoryVersion
}

export interface NotesSuggestInput extends SuggestInput {
  /** What the author asked to focus on (from the chat router's instruction), or null. */
  instruction?: string | null
}

const BAD_FORMAT = 'The model did not answer in the expected format.'

/**
 * The scene both suggestions read (F-5.20): the gate first, then a manuscript document
 * (NOT_FOUND / VALIDATION from `getDocumentContent`, VALIDATION outside the manuscript) with at
 * least `SCENE_SUGGEST_TEXT_MIN` characters of text; in v1 its stored summary (F-5.6), if any, in
 * v2 (F-16.20) its v2 card as the readers take it (`promptCard`), if any; never both.
 */
function readScene(
  db: TreeDb,
  feature: 'synopsis' | 'notesSuggest',
  nodeId: string,
  memory: StoryMemoryVersion
): {
  text: string
  summary: { summary: string; keyPoints: string[] } | null
  card: PromptCard | null
} {
  assertFeatureAllowed(getAiSettings(db), feature)
  const { content } = getDocumentContent(db, nodeId)
  if (!manuscriptDocuments(db).some((row) => row.id === nodeId)) {
    throw new AppError('VALIDATION', 'Only a scene in the manuscript has a synopsis and notes', {
      nodeId
    })
  }
  const text = content ? docToText(content).trim() : ''
  if (text.length < SCENE_SUGGEST_TEXT_MIN) {
    throw new AppError(
      'VALIDATION',
      `Write at least ${SCENE_SUGGEST_TEXT_MIN} characters in this scene before asking for suggestions`,
      { nodeId, length: text.length }
    )
  }
  if (memory === 'v2') return { text, summary: null, card: promptCard(db, nodeId) }
  const stored = getSummary(db, nodeId)
  return {
    text,
    summary: stored ? { summary: stored.summary, keyPoints: stored.keyPoints } : null,
    card: null
  }
}

const SCENE_LIMITS = { chars: SCENE_SUGGEST_CHAR_BUDGET, min: SCENE_SUGGEST_TEXT_MIN }

/**
 * A suggested synopsis for the side panel (F-5.20). Sends exactly what the data-sharing panel
 * lists: the head of the scene within `SCENE_SUGGEST_CHAR_BUDGET` (shorter still while the
 * prompt is over `inputBudget('synopsis')`, token rule 8) and, in v1, its stored summary with key
 * points (`synopsis.v1`), in v2 its card (`synopsis.v2`, F-16.20). Fast tier, JSON, not streamed.
 * The handler records the answer as a proposal; nothing is written into the panel until the
 * author accepts it.
 */
export async function runSuggestSynopsis(
  db: TreeDb,
  deps: AiRequestDeps,
  input: SuggestInput
): Promise<SynopsisResult> {
  const scene = readScene(db, 'synopsis', input.nodeId, input.memory)
  const v2 = input.memory === 'v2'
  const build = (
    cut: string
  ): ReturnType<typeof buildSynopsisPrompt> | ReturnType<typeof buildSynopsisPromptV2> =>
    v2
      ? buildSynopsisPromptV2({ sceneText: cut, card: scene.card })
      : buildSynopsisPrompt({ sceneText: cut, summary: scene.summary })
  const { sceneText, truncated } = fitSceneToBudget(
    scene.text,
    inputBudget('synopsis'),
    (cut) => build(cut).messages,
    SCENE_LIMITS
  )
  const prompt = build(sceneText)
  const result = await runAiRequest(deps, {
    feature: 'synopsis',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(
      JSON.stringify(v2 ? { sceneText, card: scene.card } : { sceneText, summary: scene.summary })
    ),
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })
  return {
    synopsis: parseSynopsisAnswer(result.text),
    truncated,
    usage: result.usage,
    costUsd: result.costUsd,
    cached: result.cached,
    model: result.model,
    promptVersion: prompt.version
  }
}

/**
 * Suggested key points for the scene's notes (F-5.20). Sends exactly what the data-sharing
 * panel lists: the head of the scene (fitted as the synopsis fits it, against
 * `inputBudget('notesSuggest')`), its stored summary, its notes cut to
 * `NOTES_SUGGEST_CURRENT_CHARS` (so the points add rather than repeat), its brief block, the
 * story bible, and the author's focus. Fast tier, JSON, not streamed; the handler records a
 * proposal and nothing enters the notes until the author accepts.
 */
export async function runSuggestNotes(
  db: TreeDb,
  deps: AiRequestDeps,
  input: NotesSuggestInput
): Promise<NotesSuggestResult> {
  const scene = readScene(db, 'notesSuggest', input.nodeId, input.memory)
  const row = getNode(db, input.nodeId)
  const current = headTruncate(
    notesText(row?.notes ?? null, input.nodeId),
    NOTES_SUGGEST_CURRENT_CHARS
  )
  const notes = current || null
  const brief = sceneBriefBlock(db, input.nodeId)
  const focus = input.instruction?.trim() ?? ''
  const instruction = focus === '' ? null : focus
  const v2 = input.memory === 'v2'
  // F-5.23: the bible as the author's notes and plans, not ground truth about events. F-16.14:
  // v2 carries the Story notes block in its slot, and since F-16.20 the card in the summary's
  // place (`notesSuggest.v4`).
  const bible = v2
    ? null
    : buildStoryBible(db, {
        nodeId: input.nodeId,
        maxTokens: STORY_BIBLE_TOKEN_BUDGET,
        heading: STORY_BIBLE_PLANS_HEADING
      })
  const storyNotes = v2
    ? buildStoryNotes(db, { nodeId: input.nodeId, maxTokens: STORY_BIBLE_TOKEN_BUDGET })
    : null
  const context = v2
    ? { card: scene.card, brief, notes, storyNotes, instruction }
    : { summary: scene.summary, brief, notes, bible, instruction }
  const build = (
    sceneText: string
  ): ReturnType<typeof buildNotesSuggestPromptV2> | ReturnType<typeof buildNotesSuggestPromptV4> =>
    v2
      ? buildNotesSuggestPromptV4({
          card: scene.card,
          brief,
          notes,
          storyNotes,
          instruction,
          sceneText
        })
      : buildNotesSuggestPromptV2({
          summary: scene.summary,
          brief,
          notes,
          bible,
          instruction,
          sceneText
        })
  const { sceneText, truncated } = fitSceneToBudget(
    scene.text,
    inputBudget('notesSuggest'),
    (cut) => build(cut).messages,
    SCENE_LIMITS
  )
  const prompt = build(sceneText)
  const result = await runAiRequest(deps, {
    feature: 'notesSuggest',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(JSON.stringify({ ...context, sceneText })),
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })
  const { points, dropped } = parseNotesSuggestAnswer(result.text)
  return {
    points,
    dropped,
    truncated,
    usage: result.usage,
    costUsd: result.costUsd,
    cached: result.cached,
    model: result.model,
    promptVersion: prompt.version
  }
}

const SynopsisAnswer = z.object({ synopsis: z.string() })
const NotesAnswer = z.object({ points: z.array(z.unknown()) })

/**
 * The model's `{ synopsis }`: PROVIDER when the answer is not JSON, not that shape, or blank;
 * otherwise trimmed, whitespace runs collapsed, and cut to `SCENE_SYNOPSIS_MAX`.
 */
export function parseSynopsisAnswer(text: string): string {
  const answer = SynopsisAnswer.safeParse(parseJson(text))
  if (!answer.success) throw new AiFallbackError(BAD_FORMAT, answer.error)
  const synopsis = answer.data.synopsis
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SCENE_SYNOPSIS_MAX)
    .trim()
  if (!synopsis) throw new AiFallbackError(BAD_FORMAT)
  return synopsis
}

/**
 * The model's `{ points: [...] }`: PROVIDER when the answer is not JSON or has no `points`
 * array, lenient point by point otherwise — each is trimmed and cut to
 * `NOTES_SUGGEST_POINT_MAX`; a point that is not a string, blank, a repeat, or past the
 * `NOTES_SUGGEST_POINTS_MAX`th kept one is dropped and counted.
 */
export function parseNotesSuggestAnswer(text: string): { points: string[]; dropped: number } {
  const answer = NotesAnswer.safeParse(parseJson(text))
  if (!answer.success) throw new AiFallbackError(BAD_FORMAT, answer.error)
  const points: string[] = []
  for (const entry of answer.data.points) {
    if (points.length >= NOTES_SUGGEST_POINTS_MAX) break
    if (typeof entry !== 'string') continue
    const point = entry.replace(/\s+/g, ' ').trim().slice(0, NOTES_SUGGEST_POINT_MAX).trim()
    if (point && !points.includes(point)) points.push(point)
  }
  return { points, dropped: answer.data.points.length - points.length }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
}
