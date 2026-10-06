import { estimateTokens, GHOST_AFTER_CHARS, GHOST_BEFORE_CHARS, inputBudget } from '@shared/ai'
import { AUTHOR_RULES_TEXT_MAX, defaultAuthorRules } from '@shared/authorRules'
import {
  CHAT_HISTORY_TURNS,
  CHAT_MAX_REFS,
  CHAT_MESSAGE_MAX,
  CHAT_PARAGRAPHS_MAX,
  CHAT_REF_NOTES_CHAR_BUDGET,
  CHAT_SCENE_CHAR_BUDGET
} from '@shared/chat'
import {
  CONTINUITY_REF_VALUE_MAX,
  CONTINUITY_REFS_TOKEN_BUDGET,
  CONTINUITY_SCENE_CHAR_BUDGET,
  CONTINUITY_TEXT_MIN,
  type ContinuityRef
} from '@shared/continuity'
import {
  CRITIQUE_NOTES_CHAR_CAP,
  CRITIQUE_SCENE_CHAR_BUDGET,
  DEFAULT_HONESTY
} from '@shared/critique'
import type { VoiceProfile } from '@shared/ipc/contract'
import { builtinParams } from '@shared/presets'
import {
  PROOFREAD_CHAR_BUDGET,
  PROOFREAD_KEEP_WORDS_MAX,
  PROOFREAD_TEXT_MIN
} from '@shared/proofread'
import { PROPOSAL_NOTE_MAX } from '@shared/proposal'
import { REWRITE_CONTEXT_CHARS, REWRITE_TEXT_MAX } from '@shared/rewrite'
import {
  renderStoryBible,
  renderStoryBibleEntities,
  STORY_BIBLE_CATEGORIES,
  STORY_BIBLE_GHOST_TOKEN_BUDGET,
  STORY_BIBLE_TOKEN_BUDGET,
  STORY_BIBLE_VALUE_MAX,
  type StoryBibleCategory,
  type StoryBibleEntity,
  type StoryBibleFacts
} from '@shared/storyBible'
import {
  classifyKind,
  computeStylometrics,
  renderVoiceRules,
  type Stylometrics
} from '@shared/stylometry'
import { TAG_NAME_MAX, type TagCategory } from '@shared/tags'
import { TAG_TEMPLATES, type TagTemplateTag } from '@shared/tagTemplates'
import { voiceConfidence, VOICE_EXEMPLAR_TEXT_MAX } from '@shared/voice'
import { voiceBlock } from '../../voice/voiceBlock'
import type { AiMessage } from '../providers/types'
import type { PromptVersion } from '../prompts/catalogue'
import { buildBriefPrompt, BRIEF_PROMPT_VERSION } from '../prompts/brief.v1'
import {
  buildChatPrompt,
  CHAT_PROMPT_VERSION,
  type BuildChatPromptInput,
  type ChatTurn
} from '../prompts/chat.v1'
import {
  buildChatPromptV2,
  CHAT_PROMPT_V2_VERSION,
  type BuildChatPromptV2Input
} from '../prompts/chat.v2'
import {
  buildChatPromptV3,
  CHAT_PROMPT_V3_VERSION,
  type BuildChatPromptV3Input
} from '../prompts/chat.v3'
import { buildChatRegenPrompt, CHAT_REGEN_PROMPT_VERSION } from '../prompts/chatRegen.v1'
import { buildChatRegenPromptV2, CHAT_REGEN_PROMPT_V2_VERSION } from '../prompts/chatRegen.v2'
import { buildChatRegenPromptV3, CHAT_REGEN_PROMPT_V3_VERSION } from '../prompts/chatRegen.v3'
import {
  buildChatPromptV4,
  CHAT_PROMPT_V4_VERSION,
  type BuildChatPromptV4Input
} from '../prompts/chat.v4'
import { buildChatRegenPromptV4, CHAT_REGEN_PROMPT_V4_VERSION } from '../prompts/chatRegen.v4'
import {
  buildContinuityPrompt,
  CONTINUITY_PROMPT_VERSION,
  continuityRefLine
} from '../prompts/continuity.v1'
import {
  buildCritiquePrompt,
  CRITIQUE_PROMPT_VERSION,
  type BuildCritiquePromptInput
} from '../prompts/critique.v1'
import {
  buildCritiquePromptV2,
  CRITIQUE_PROMPT_V2_VERSION,
  type BuildCritiquePromptV2Input
} from '../prompts/critique.v2'
import {
  buildCritiquePromptV3,
  CRITIQUE_PROMPT_V3_VERSION,
  type BuildCritiquePromptV3Input
} from '../prompts/critique.v3'
import {
  buildCritiqueRegenPrompt,
  CRITIQUE_REGEN_PROMPT_VERSION
} from '../prompts/critiqueRegen.v1'
import {
  buildCritiqueRegenPromptV2,
  CRITIQUE_REGEN_PROMPT_V2_VERSION
} from '../prompts/critiqueRegen.v2'
import {
  buildCritiqueRegenPromptV3,
  CRITIQUE_REGEN_PROMPT_V3_VERSION
} from '../prompts/critiqueRegen.v3'
import {
  buildGhostTextPrompt,
  GHOST_NOTES_CHAR_CAP,
  GHOST_PROMPT_VERSION,
  type BuildGhostTextPromptInput
} from '../prompts/ghostText.v1'
import {
  buildGhostTextPromptV2,
  GHOST_PROMPT_V2_VERSION,
  type BuildGhostTextPromptV2Input
} from '../prompts/ghostText.v2'
import {
  buildGhostTextPromptV3,
  GHOST_PROMPT_V3_VERSION,
  type BuildGhostTextPromptV3Input
} from '../prompts/ghostText.v3'
import { buildGhostTextRegenPrompt, GHOST_REGEN_PROMPT_VERSION } from '../prompts/ghostTextRegen.v1'
import {
  buildGhostTextRegenPromptV2,
  GHOST_REGEN_PROMPT_V2_VERSION
} from '../prompts/ghostTextRegen.v2'
import {
  buildGhostTextRegenPromptV3,
  GHOST_REGEN_PROMPT_V3_VERSION
} from '../prompts/ghostTextRegen.v3'
import {
  buildGhostTextPromptV4,
  GHOST_PROMPT_V4_VERSION,
  type BuildGhostTextPromptV4Input
} from '../prompts/ghostText.v4'
import {
  buildGhostTextRegenPromptV4,
  GHOST_REGEN_PROMPT_V4_VERSION
} from '../prompts/ghostTextRegen.v4'
import {
  buildRewritePrompt,
  REWRITE_PROMPT_VERSION,
  type BuildRewritePromptInput
} from '../prompts/rewrite.v1'
import {
  buildRewritePromptV2,
  REWRITE_PROMPT_V2_VERSION,
  type BuildRewritePromptV2Input
} from '../prompts/rewrite.v2'
import { buildRewriteRegenPrompt, REWRITE_REGEN_PROMPT_VERSION } from '../prompts/rewriteRegen.v1'
import {
  buildRewriteRegenPromptV2,
  REWRITE_REGEN_PROMPT_V2_VERSION
} from '../prompts/rewriteRegen.v2'
import {
  buildRewritePromptV3,
  REWRITE_PROMPT_V3_VERSION,
  type BuildRewritePromptV3Input
} from '../prompts/rewrite.v3'
import {
  buildRewriteRegenPromptV3,
  REWRITE_REGEN_PROMPT_V3_VERSION
} from '../prompts/rewriteRegen.v3'
import { buildSummaryPrompt, SUMMARY_PROMPT_VERSION } from '../prompts/summary.v1'
import {
  buildSummaryPromptV2,
  SUMMARY_PROMPT_V2_VERSION,
  type SummaryKnownNames
} from '../prompts/summary.v2'
import {
  buildSummaryPromptV3,
  SUMMARY_PROMPT_V3_VERSION,
  type SummaryBankTags
} from '../prompts/summary.v3'
import {
  buildBetaReaderPrompt,
  BETA_READER_PROMPT_VERSION,
  type BuildBetaReaderPromptInput
} from '../prompts/betaReader.v1'
import {
  buildBetaReaderRegenPrompt,
  BETA_READER_REGEN_PROMPT_VERSION
} from '../prompts/betaReaderRegen.v1'
import {
  buildImportStructurePrompt,
  IMPORT_STRUCTURE_PROMPT_VERSION,
  type StructurePromptParagraph
} from '../prompts/importStructure.v1'
import {
  buildQueryPrompt,
  QUERY_PROMPT_VERSION,
  type BuildQueryPromptInput
} from '../prompts/query.v1'
import {
  buildQueryPromptV2,
  QUERY_PROMPT_V2_VERSION,
  type BuildQueryPromptV2Input
} from '../prompts/query.v2'
import {
  buildQueryPromptV3,
  QUERY_PROMPT_V3_VERSION,
  type BuildQueryPromptV3Input
} from '../prompts/query.v3'
import { buildProofreadPrompt, PROOFREAD_PROMPT_VERSION } from '../prompts/proofread.v1'
import { buildWhatNextPrompt, WHAT_NEXT_PROMPT_VERSION } from '../prompts/whatNext.v1'
import { buildWhatNextPromptV2, WHAT_NEXT_PROMPT_V2_VERSION } from '../prompts/whatNext.v2'
import { fitTailToBudget } from '../whatNext'
import { fitSceneToBudget } from '../critique'
import { fitQueryPrompt } from '../query'
import { buildTagsPrompt, TAGS_PROMPT_VERSION, TAGS_TEXT_CHAR_BUDGET } from '../prompts/tags.v1'
import { buildTagsRegenPrompt, TAGS_REGEN_PROMPT_VERSION } from '../prompts/tagsRegen.v1'
import {
  SUMMARY_BANK_NAMES_MAX,
  SUMMARY_BANK_TAGS_MAX,
  SUMMARY_KEY_POINT_MAX,
  SUMMARY_KEY_POINTS_MAX,
  SUMMARY_KNOWN_NAMES_MAX,
  SUMMARY_MAX_CHARS,
  SUMMARY_SCENE_CHAR_BUDGET
} from '@shared/summary'
import { BETA_READER_SCENE_CHAR_BUDGET } from '@shared/betaReader'
import { IMPORT_CHUNK_WORDS } from '@shared/importStructure'
import {
  QUERY_BIBLE_ENTITIES,
  QUERY_BIBLE_TOKEN_BUDGET,
  QUERY_SCENE_CHAR_BUDGET,
  QUERY_V3_BIBLE_TOKEN_BUDGET,
  QUERY_V3_BIBLE_VALUE_MAX
} from '@shared/query'
import {
  BRIEF_SCENE_CHAR_BUDGET,
  EMPTY_SCENE_BRIEF,
  renderSceneBriefBlock,
  SCENE_BRIEF_FIELD_MAX,
  type SceneBrief
} from '@shared/sceneMeta'
import { renderSceneSteer, SCENE_STEER_CATEGORIES, SCENE_STEER_NAMES_MAX } from '@shared/sceneSteer'
import {
  ROUTE_MESSAGE_CHARS,
  ROUTE_SELECTION_PREVIEW_CHARS,
  ROUTE_TITLE_CHARS,
  ROUTE_TURN_CHARS
} from '@shared/assistantRoute'
import {
  NOTES_SUGGEST_CURRENT_CHARS,
  NOTES_SUGGEST_INSTRUCTION_MAX,
  PANEL_NOTES_CHARS,
  PANEL_SYNOPSIS_CHARS,
  SCENE_SUGGEST_CHAR_BUDGET,
  SCENE_SUGGEST_TEXT_MIN
} from '@shared/sceneSuggest'
import {
  buildChatPromptV5,
  CHAT_PROMPT_V5_VERSION,
  type BuildChatPromptV5Input,
  type ScenePanel
} from '../prompts/chat.v5'
import { buildChatRegenPromptV5, CHAT_REGEN_PROMPT_V5_VERSION } from '../prompts/chatRegen.v5'
import {
  buildQueryPromptV4,
  QUERY_PROMPT_V4_VERSION,
  type BuildQueryPromptV4Input
} from '../prompts/query.v4'
import {
  buildRoutePrompt,
  ROUTE_PROMPT_VERSION,
  type BuildRoutePromptInput
} from '../prompts/route.v1'
import {
  buildSynopsisPrompt,
  SYNOPSIS_PROMPT_VERSION,
  type BuildSynopsisPromptInput
} from '../prompts/synopsis.v1'
import {
  buildNotesSuggestPrompt,
  NOTES_SUGGEST_PROMPT_VERSION,
  type BuildNotesSuggestPromptInput
} from '../prompts/notesSuggest.v1'

/**
 * The eval harness's fixtures (F-5.12): one manuscript passage, the voice profile it yields,
 * a tag bank, and the cases every catalogued prompt version is built over. The cases are the
 * shapes production sends (a fresh project, a full context, the worst case each cap allows),
 * so the token report reads as what a request actually costs, and the live run scores real
 * answers with the same post-processing and fidelity check the features apply.
 */

/** A past-tense, third-person scene (~270 words, 16 paragraphs, `said` only) as `docToText` would yield it. */
export const FIXTURE_PASSAGE = [
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
    'bell had lost its clapper years ago.',
  'She set the lantern down on the post and waited.',
  '"You came alone," a voice said behind her.',
  'She did not turn. "You said to."',
  'Tomas stepped onto the boards. He carried nothing, which worried her more than a knife would ' +
    'have. "The river is up," he said. "Nobody crosses tonight."',
  '"Then we talk here."',
  'He looked at the lantern, then at the far bank, where the dark trees ran down to the water ' +
    'like a crowd that had come to watch. "Your brother owes the mill. The mill owes me. That is ' +
    'the whole of it."',
  '"That is not the whole of it," Mara said.',
  'The wind came off the water and pushed the lantern flame flat. She counted the seconds until ' +
    'it stood up again. Four. Fewer than last night.',
  '"He took the ledger," Tomas said. "I want it back before the thaw."',
  '"He took nothing. He copied it."',
  'Tomas was quiet for a long moment. Somewhere upstream a branch broke loose and went under. ' +
    '"Then the copy," he said. "And we forget the rest."',
  'She picked up the lantern. The boards were slick and she walked them slowly, the way her ' +
    'father had taught her, heel first. At the bank she stopped.',
  '"He is in the north pasture," she said. "Under the elm. You put him there."',
  'She did not wait to see his face.'
].join('\n\n')

const FIXTURE_STATS: Stylometrics = computeStylometrics(FIXTURE_PASSAGE)

const exemplar = (id: string, text: string): VoiceProfile['exemplars'][number] => ({
  id,
  nodeId: null,
  text,
  pov: 'Mara',
  kind: classifyKind(text),
  created: '2026-09-15T00:00:00.000Z'
})

/** Two lines of style rules over the seeded banned phrases: what an author who edited the section has (F-14.2). */
const FIXTURE_AUTHOR_RULES = {
  ...defaultAuthorRules(),
  rules: 'No rhetorical questions in narration.\nMara never swears.'
}

/** The profile a project holding `FIXTURE_PASSAGE` with its opening marked as an exemplar has. */
export const FIXTURE_PROFILE: VoiceProfile = {
  rules: renderVoiceRules(FIXTURE_STATS),
  stats: FIXTURE_STATS,
  exemplars: [exemplar('ex-1', FIXTURE_PASSAGE.split('\n\n').slice(0, 5).join('\n\n'))],
  authorRules: FIXTURE_AUTHOR_RULES,
  confidence: voiceConfidence(FIXTURE_STATS.wordCount, 1),
  wordCount: FIXTURE_STATS.wordCount
}

/**
 * The same profile at the exemplar ceiling: three exemplars at the maximum length, so the voice
 * block hits its budget, and the author's rules text at its own character cap, so the author
 * block hits `AUTHOR_RULES_TOKEN_BUDGET` too.
 */
const MAXED_PROFILE: VoiceProfile = {
  ...FIXTURE_PROFILE,
  exemplars: [1, 2, 3].map((n) =>
    exemplar(`ex-${n}`, FIXTURE_PASSAGE.repeat(3).slice(0, VOICE_EXEMPLAR_TEXT_MAX))
  ),
  authorRules: {
    ...defaultAuthorRules(),
    rules: FIXTURE_PASSAGE.slice(0, AUTHOR_RULES_TEXT_MAX)
  },
  confidence: voiceConfidence(FIXTURE_STATS.wordCount, 3)
}

/** The last `GHOST_BEFORE_CHARS` of the passage, minus its final sentence, as the caret window. */
const CARET_BEFORE = FIXTURE_PASSAGE.slice(0, FIXTURE_PASSAGE.lastIndexOf('\n\n')).slice(
  -GHOST_BEFORE_CHARS
)
const CARET_AFTER = 'She did not wait to see his face.'
const NOTES = 'Mara confronts Tomas at the ferry. Ends with the reveal about the elm.'
const META = {
  location: 'Ferry landing',
  pov: 'Mara',
  timeline: 'Night, first thaw',
  brief: EMPTY_SCENE_BRIEF
}

/** The brief an author writes for the fixture scene, with the two neighbouring lines (F-14.3). */
const BRIEF_BLOCK =
  renderSceneBriefBlock({
    current: {
      goal: 'Mara wants Tomas to say what he actually wants for the ledger.',
      conflict: 'The river is up, Tomas came empty-handed, and neither will leave first.',
      turn: 'She stops bargaining and tells him where her brother is.',
      beat: 'Wary patience hardening into cruelty.',
      after: 'Tomas killed her brother, and Mara has known it the whole scene.'
    },
    previous: { ...EMPTY_SCENE_BRIEF, after: 'Her brother copied the mill ledger and vanished.' },
    next: { ...EMPTY_SCENE_BRIEF, goal: 'Tomas wants to reach the elm before the thaw.' }
  }) ?? ''

/** Every line of the block at its cap: five own fields plus the two neighbour lines. */
const maxedLine = (char: string): string => char.repeat(SCENE_BRIEF_FIELD_MAX)
const MAXED_BRIEF_BLOCK =
  renderSceneBriefBlock({
    current: {
      goal: maxedLine('g'),
      conflict: maxedLine('c'),
      turn: maxedLine('t'),
      beat: maxedLine('b'),
      after: maxedLine('a')
    } satisfies SceneBrief,
    previous: { ...EMPTY_SCENE_BRIEF, after: maxedLine('p') },
    next: { ...EMPTY_SCENE_BRIEF, goal: maxedLine('n') }
  }) ?? ''

/** The Standard Fiction template names: the bank a new project loads first. */
export const FIXTURE_BANK: string[] = (TAG_TEMPLATES[0]?.tags ?? []).map((tag) => tag.name)
/** Every template's names, deduplicated: the largest bank the templates alone produce. */
const MAXED_BANK: string[] = [
  ...new Set(TAG_TEMPLATES.flatMap((t) => t.tags.map((tag) => tag.name)))
]

const isStoryCategory = (category: TagCategory): category is StoryBibleCategory =>
  (STORY_BIBLE_CATEGORIES as readonly TagCategory[]).includes(category)

/** The template tags that state story facts, deduplicated by name, as the bible's bank (F-14.9). */
function storyBank(tags: readonly TagTemplateTag[]): StoryBibleFacts['bank'] {
  const seen = new Set<string>()
  return tags.flatMap(({ category, name }) => {
    if (!isStoryCategory(category) || seen.has(name)) return []
    seen.add(name)
    return [{ category, name }]
  })
}

/** The facts a project holding the fixture scene in the middle of a chapter states (F-14.9). */
const FIXTURE_FACTS: StoryBibleFacts = {
  bank: storyBank(TAG_TEMPLATES[0]?.tags ?? []),
  scene: {
    title: 'The ferry landing',
    ancestors: ['Chapter 2', 'Part One'],
    index: 2,
    count: 4,
    tags: ['protagonist', 'antagonist', 'primary-location', 'main-plot']
  },
  // The neighbours carry no summary (F-5.6): the shipped prompts' rows in the token report
  // measure the bible as a project sends it before the background index has caught up, and
  // the summary lines' own budget behaviour is pinned by `src/shared/storyBible.test.ts`.
  previous: {
    title: 'The mill ledger',
    location: 'The mill',
    pov: 'Mara',
    timeline: 'Two days before',
    summary: null
  },
  next: {
    title: 'The north pasture',
    location: 'North pasture',
    pov: 'Mara',
    timeline: 'Dawn',
    summary: null
  }
}
/** Every template's story facts, with long titles and a heavily tagged scene: the bible at its cap. */
const MAXED_FACTS: StoryBibleFacts = {
  bank: storyBank(TAG_TEMPLATES.flatMap((t) => t.tags)),
  scene: {
    title: 'The ferry landing, the ledger, and what the river gave back',
    ancestors: ['Chapter 12: The thaw and the ledger', 'Part Three: What the river gave back'],
    index: 12,
    count: 40,
    tags: MAXED_BANK.slice(0, 12)
  },
  previous: {
    title: 'The mill ledger, copied twice',
    location: 'The mill on the north bank',
    pov: 'Mara',
    timeline: 'Two days before the thaw',
    summary: null
  },
  next: {
    title: 'The north pasture, under the elm',
    location: 'The north pasture',
    pov: 'Tomas',
    timeline: 'Dawn after the thaw',
    summary: null
  }
}

/** The bible a full request carries, per budget: the chat/critique/rewrite one and the ghost one. */
export const FIXTURE_BIBLE = renderStoryBible(FIXTURE_FACTS, STORY_BIBLE_TOKEN_BUDGET)
const FIXTURE_GHOST_BIBLE = renderStoryBible(FIXTURE_FACTS, STORY_BIBLE_GHOST_TOKEN_BUDGET)
/** The bible at each budget: the renderer cuts the category lines to fit, so these are the caps. */
const MAXED_BIBLE = renderStoryBible(MAXED_FACTS, STORY_BIBLE_TOKEN_BUDGET)
const MAXED_GHOST_BIBLE = renderStoryBible(MAXED_FACTS, STORY_BIBLE_GHOST_TOKEN_BUDGET)

/** The scene steer a full request carries (F-14.13): a tone, a content tag, a plot thread, and a theme. */
const FIXTURE_STEER = renderSceneSteer([
  { category: 'tone', name: 'suspenseful' },
  { category: 'content', name: 'dialogue' },
  { category: 'plotThread', name: 'main-plot' },
  { category: 'custom', name: 'debt' }
])
/** Every steer category over its name cap, each name at the tag-name cap: the steer at its worst. */
const MAXED_STEER = renderSceneSteer(
  SCENE_STEER_CATEGORIES.flatMap((category) =>
    Array.from({ length: SCENE_STEER_NAMES_MAX + 1 }, (_, i) => ({
      category,
      name: `${category}-${i}-`.padEnd(TAG_NAME_MAX, 'x')
    }))
  )
)

export interface EvalCase {
  version: PromptVersion
  name: string
  /** What the case exercises, for the report. */
  note: string
  messages: AiMessage[]
  maxTokens: number
  temperature?: number
  /**
   * How a live answer is scored: a prose case is post-processed like ghost text and checked
   * against the profile (only when a voice block went out, as `generateGhostText` does); a JSON
   * case must parse and name bank tags only.
   */
  scoring:
    | { kind: 'prose'; before: string; after: string; profile: Stylometrics | null }
    | { kind: 'json'; bank: string[] }
    /** A chat answer: post-processed like an Agent draft and, when a voice block went out, checked at any length (`checkChatFidelity`). */
    | { kind: 'chat'; profile: Stylometrics | null }
    /** Editor's notes: the answer must parse and every note must quote the scene that was sent. */
    | { kind: 'critique'; sceneText: string }
    /** A scene brief (F-14.3): the answer must parse to the five string lines the prompt asks for. */
    | { kind: 'brief' }
    /** A scene summary (F-5.6): the answer must parse to `SceneSummary`, caps and all. */
    | { kind: 'summary' }
    /**
     * A scene summary with observed facts (F-5.16): the summary must parse as above, and every
     * fact must survive the feature's own checks — shape, attribute of its kind, and a quote
     * found in the scene text as sent.
     */
    | { kind: 'summaryFacts'; sceneText: string }
    /**
     * A beta-reader report (F-14.11): the answer must parse, every item must name a scene in
     * range, and its quote must be in that scene's text as sent — one entry per scene sent, the
     * current scene last.
     */
    | { kind: 'betaReader'; texts: string[] }
    /**
     * A Story Intelligence answer (F-5.7): the answer must parse, every citation must name one
     * of the scenes sent in full, and its quote must be in that scene's text as sent.
     */
    | { kind: 'query'; texts: string[] }
    /**
     * An import structure pass (F-12.3): the answer must parse, every paragraph number must be
     * one that was sent in this chunk, and every tag must name the bank — the three rules the
     * runner enforces before a suggestion reaches the draft.
     */
    | { kind: 'structure'; bank: string[]; indices: number[] }
    /**
     * A consistency check (F-13.4): the answer must parse, every finding must name one of the
     * `references` numbered references that were sent, and its quote must be in the scene text
     * as sent — the two citations the feature turns on.
     */
    | { kind: 'continuity'; sceneText: string; references: number }
    /**
     * A proofread (F-14.12): the answer must parse, and every fix must survive the feature's own
     * checks against the text as sent (here the whole scene) and the keep words.
     */
    | { kind: 'proofread'; text: string; keepWords: string[] }
    /**
     * What should come next? (F-5.17): the answer must parse, and every direction must survive
     * the feature's own parser (shape, non-blank, within the caps), three of them.
     */
    | { kind: 'whatNext' }
    /**
     * The assistant router (F-5.19): the answer, read by the feature's own parser, must name
     * `expected`, the action a well-behaved router picks for the case.
     */
    | { kind: 'route'; expected: string }
    /** A suggested synopsis (F-5.20): the answer must survive the feature's own parser. */
    | { kind: 'synopsis' }
    /** Suggested notes (F-5.20): the answer must survive the feature's own parser, nothing dropped. */
    | { kind: 'notesSuggest' }
}

const general = builtinParams('general')
const suspense = builtinParams('suspense')

const fresh: BuildGhostTextPromptInput = {
  before: CARET_BEFORE,
  after: '',
  notes: null,
  meta: null,
  voice: null,
  preset: general
}
const full: BuildGhostTextPromptInput = {
  before: CARET_BEFORE,
  after: CARET_AFTER,
  notes: NOTES,
  meta: META,
  voice: voiceBlock(FIXTURE_PROFILE, { text: CARET_BEFORE, pov: 'Mara' }),
  preset: suspense
}
const maxedBefore = FIXTURE_PASSAGE.repeat(2).slice(-GHOST_BEFORE_CHARS)
const maxed: BuildGhostTextPromptInput = {
  before: maxedBefore,
  after: FIXTURE_PASSAGE.slice(0, GHOST_AFTER_CHARS),
  notes: FIXTURE_PASSAGE.slice(0, GHOST_NOTES_CHAR_CAP + 100),
  meta: { location: 'L'.repeat(200), pov: 'P'.repeat(200), timeline: 'T'.repeat(500) },
  voice: voiceBlock(MAXED_PROFILE, { text: maxedBefore, pov: 'Mara' }),
  preset: suspense
}

function ghostCase(
  name: string,
  note: string,
  input: BuildGhostTextPromptInput,
  violation: string | null
): EvalCase {
  const built =
    violation === null
      ? buildGhostTextPrompt(input)
      : buildGhostTextRegenPrompt({ ...input, violation })
  return {
    version: violation === null ? GHOST_PROMPT_VERSION : GHOST_REGEN_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    temperature: built.temperature,
    scoring: {
      kind: 'prose',
      before: input.before,
      after: input.after,
      profile: input.voice === null ? null : FIXTURE_STATS
    }
  }
}

/** The same three shapes under `ghostText.v2` (F-14.3): no brief, the fixture brief, a brief at every line cap. */
const ghostFreshV2: BuildGhostTextPromptV2Input = { ...fresh, brief: null }
const ghostFullV2: BuildGhostTextPromptV2Input = { ...full, brief: BRIEF_BLOCK }
const ghostMaxedV2: BuildGhostTextPromptV2Input = { ...maxed, brief: MAXED_BRIEF_BLOCK }

function ghostCaseV2(
  name: string,
  note: string,
  input: BuildGhostTextPromptV2Input,
  violation: string | null
): EvalCase {
  const built =
    violation === null
      ? buildGhostTextPromptV2(input)
      : buildGhostTextRegenPromptV2({ ...input, violation })
  return {
    version: violation === null ? GHOST_PROMPT_V2_VERSION : GHOST_REGEN_PROMPT_V2_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    temperature: built.temperature,
    scoring: {
      kind: 'prose',
      before: input.before,
      after: input.after,
      profile: input.voice === null ? null : FIXTURE_STATS
    }
  }
}

/** The same three shapes under `ghostText.v3` (F-14.9): no bible, the fixture bible at the ghost budget, the bible at its cap. */
const ghostFreshV3: BuildGhostTextPromptV3Input = { ...ghostFreshV2, bible: null }
const ghostFullV3: BuildGhostTextPromptV3Input = { ...ghostFullV2, bible: FIXTURE_GHOST_BIBLE }
const ghostMaxedV3: BuildGhostTextPromptV3Input = { ...ghostMaxedV2, bible: MAXED_GHOST_BIBLE }

function ghostCaseV3(
  name: string,
  note: string,
  input: BuildGhostTextPromptV3Input,
  violation: string | null
): EvalCase {
  const built =
    violation === null
      ? buildGhostTextPromptV3(input)
      : buildGhostTextRegenPromptV3({ ...input, violation })
  return {
    version: violation === null ? GHOST_PROMPT_V3_VERSION : GHOST_REGEN_PROMPT_V3_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    temperature: built.temperature,
    scoring: {
      kind: 'prose',
      before: input.before,
      after: input.after,
      profile: input.voice === null ? null : FIXTURE_STATS
    }
  }
}

/** The same three shapes under `ghostText.v4` (F-14.13): no steer, the fixture steer, the steer at its cap. */
const ghostFreshV4: BuildGhostTextPromptV4Input = { ...ghostFreshV3, steer: null }
const ghostFullV4: BuildGhostTextPromptV4Input = { ...ghostFullV3, steer: FIXTURE_STEER }
const ghostMaxedV4: BuildGhostTextPromptV4Input = { ...ghostMaxedV3, steer: MAXED_STEER }

function ghostCaseV4(
  name: string,
  note: string,
  input: BuildGhostTextPromptV4Input,
  violation: string | null
): EvalCase {
  const built =
    violation === null
      ? buildGhostTextPromptV4(input)
      : buildGhostTextRegenPromptV4({ ...input, violation })
  return {
    version: violation === null ? GHOST_PROMPT_V4_VERSION : GHOST_REGEN_PROMPT_V4_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    temperature: built.temperature,
    scoring: {
      kind: 'prose',
      before: input.before,
      after: input.after,
      profile: input.voice === null ? null : FIXTURE_STATS
    }
  }
}

function tagsCase(
  name: string,
  note: string,
  text: string,
  bank: string[],
  regenNote: string | null | undefined
): EvalCase {
  const built =
    regenNote === undefined
      ? buildTagsPrompt({ text, tagNames: bank })
      : buildTagsRegenPrompt({ text, tagNames: bank, note: regenNote })
  return {
    version: regenNote === undefined ? TAGS_PROMPT_VERSION : TAGS_REGEN_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'json', bank }
  }
}

const VIOLATION = 'switches to present tense'

/** Two turns of a conversation about the fixture scene. */
const CHAT_HISTORY: ChatTurn[] = [
  { role: 'user', content: 'Why does Mara go to the landing alone?' },
  {
    role: 'assistant',
    content:
      'Because Tomas asked her to ("You said to.") and she wants the meeting on her own terms; ' +
      'the scene never says she told anyone.'
  }
]
const CHAT_REF = { name: 'mara', notes: NOTES }
const planFresh: BuildChatPromptInput = {
  mode: 'plan',
  paragraphs: 1,
  sceneText: '',
  sceneMeta: null,
  refs: [],
  history: [],
  message: 'What should the opening chapter establish?',
  voice: null,
  preset: null
}
const planFull: BuildChatPromptInput = {
  ...planFresh,
  sceneText: FIXTURE_PASSAGE,
  sceneMeta: META,
  refs: [CHAT_REF],
  history: CHAT_HISTORY,
  message: 'What does #mara want from Tomas here?'
}
const agentFull: BuildChatPromptInput = {
  ...planFull,
  mode: 'agent',
  paragraphs: 3,
  message: 'Continue with Tomas following her up the bank. #mara',
  voice: voiceBlock(FIXTURE_PROFILE, { text: FIXTURE_PASSAGE, pov: 'Mara' }),
  preset: suspense
}
/** Every chat cap at its limit while the whole prompt stays under the input budget: the history turns are sized to fit. */
const CHAT_MAXED_TURN_CHARS = 1_200
const agentMaxed: BuildChatPromptInput = {
  mode: 'agent',
  paragraphs: CHAT_PARAGRAPHS_MAX,
  sceneText: `${FIXTURE_PASSAGE.repeat(6).slice(0, CHAT_SCENE_CHAR_BUDGET)}…`,
  sceneMeta: {
    location: 'L'.repeat(200),
    pov: 'P'.repeat(200),
    timeline: 'T'.repeat(500),
    brief: EMPTY_SCENE_BRIEF
  },
  refs: Array.from({ length: CHAT_MAX_REFS }, (_, i) => ({
    name: `ref-${i + 1}`,
    notes: `${FIXTURE_PASSAGE.slice(0, CHAT_REF_NOTES_CHAR_BUDGET / CHAT_MAX_REFS)}…`
  })),
  history: Array.from({ length: CHAT_HISTORY_TURNS }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: FIXTURE_PASSAGE.slice(0, CHAT_MAXED_TURN_CHARS)
  })),
  message: FIXTURE_PASSAGE.repeat(3).slice(0, CHAT_MESSAGE_MAX),
  voice: voiceBlock(MAXED_PROFILE, { text: FIXTURE_PASSAGE, pov: 'Mara' }),
  preset: suspense
}

function chatCase(
  name: string,
  note: string,
  input: BuildChatPromptInput,
  violation: string | null
): EvalCase {
  const built =
    violation === null ? buildChatPrompt(input) : buildChatRegenPrompt({ ...input, violation })
  return {
    version: violation === null ? CHAT_PROMPT_VERSION : CHAT_REGEN_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    ...(built.temperature === undefined ? {} : { temperature: built.temperature }),
    scoring: { kind: 'chat', profile: input.voice === null ? null : FIXTURE_STATS }
  }
}

/** The same four shapes under `chat.v2` (F-14.3): the brief in Agent mode only. */
const planFreshV2: BuildChatPromptV2Input = { ...planFresh, brief: null }
const planFullV2: BuildChatPromptV2Input = { ...planFull, brief: BRIEF_BLOCK }
const agentFullV2: BuildChatPromptV2Input = { ...agentFull, brief: BRIEF_BLOCK }
const agentMaxedV2: BuildChatPromptV2Input = { ...agentMaxed, brief: MAXED_BRIEF_BLOCK }

function chatCaseV2(
  name: string,
  note: string,
  input: BuildChatPromptV2Input,
  violation: string | null
): EvalCase {
  const built =
    violation === null ? buildChatPromptV2(input) : buildChatRegenPromptV2({ ...input, violation })
  return {
    version: violation === null ? CHAT_PROMPT_V2_VERSION : CHAT_REGEN_PROMPT_V2_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    ...(built.temperature === undefined ? {} : { temperature: built.temperature }),
    scoring: { kind: 'chat', profile: input.voice === null ? null : FIXTURE_STATS }
  }
}

/** The same four shapes under `chat.v3` (F-14.9): Plan mode carries the bible too (PLAN.md §2.3). */
const planFreshV3: BuildChatPromptV3Input = { ...planFreshV2, bible: null }
const planFullV3: BuildChatPromptV3Input = { ...planFullV2, bible: FIXTURE_BIBLE }
const agentFullV3: BuildChatPromptV3Input = { ...agentFullV2, bible: FIXTURE_BIBLE }
const agentMaxedV3: BuildChatPromptV3Input = { ...agentMaxedV2, bible: MAXED_BIBLE }

function chatCaseV3(
  name: string,
  note: string,
  input: BuildChatPromptV3Input,
  violation: string | null
): EvalCase {
  const built =
    violation === null ? buildChatPromptV3(input) : buildChatRegenPromptV3({ ...input, violation })
  return {
    version: violation === null ? CHAT_PROMPT_V3_VERSION : CHAT_REGEN_PROMPT_V3_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    ...(built.temperature === undefined ? {} : { temperature: built.temperature }),
    scoring: { kind: 'chat', profile: input.voice === null ? null : FIXTURE_STATS }
  }
}

/** The same four shapes under `chat.v4` (F-14.13): Agent mode carries the steer; Plan mode never does. */
const planFreshV4: BuildChatPromptV4Input = { ...planFreshV3, steer: null }
const planFullV4: BuildChatPromptV4Input = { ...planFullV3, steer: FIXTURE_STEER }
const agentFullV4: BuildChatPromptV4Input = { ...agentFullV3, steer: FIXTURE_STEER }
const agentMaxedV4: BuildChatPromptV4Input = { ...agentMaxedV3, steer: MAXED_STEER }

function chatCaseV4(
  name: string,
  note: string,
  given: BuildChatPromptV4Input,
  violation: string | null
): EvalCase {
  // The oldest history turns are dropped until the first prompt fits, exactly as `runChat`
  // drops them (token rule 8); the regenerate reuses the trimmed history, as it does there.
  const fits = (candidate: BuildChatPromptV4Input): boolean =>
    estimateTokens(
      buildChatPromptV4(candidate)
        .messages.map((m) => m.content)
        .join('\n')
    ) <= inputBudget('chat')
  let input = given
  while (input.history.length > 0 && !fits(input)) {
    input = { ...input, history: input.history.slice(1) }
  }
  const built =
    violation === null ? buildChatPromptV4(input) : buildChatRegenPromptV4({ ...input, violation })
  return {
    version: violation === null ? CHAT_PROMPT_V4_VERSION : CHAT_REGEN_PROMPT_V4_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    ...(built.temperature === undefined ? {} : { temperature: built.temperature }),
    scoring: { kind: 'chat', profile: input.voice === null ? null : FIXTURE_STATS }
  }
}

/** The paragraph an author would select for a rewrite, with the manuscript text each side of it. */
const REWRITE_PASSAGE =
  'He looked at the lantern, then at the far bank, where the dark trees ran down to the water ' +
  'like a crowd that had come to watch. "Your brother owes the mill. The mill owes me. That is ' +
  'the whole of it."'
const REWRITE_BEFORE = FIXTURE_PASSAGE.slice(0, FIXTURE_PASSAGE.indexOf(REWRITE_PASSAGE)).slice(
  -REWRITE_CONTEXT_CHARS
)
const REWRITE_AFTER = FIXTURE_PASSAGE.slice(
  FIXTURE_PASSAGE.indexOf(REWRITE_PASSAGE) + REWRITE_PASSAGE.length
).slice(0, REWRITE_CONTEXT_CHARS)

const rewriteFresh: BuildRewritePromptInput = {
  text: REWRITE_PASSAGE,
  before: '',
  after: '',
  meta: null,
  voice: null
}
const rewriteFull: BuildRewritePromptInput = {
  ...rewriteFresh,
  before: REWRITE_BEFORE,
  after: REWRITE_AFTER,
  meta: META,
  voice: voiceBlock(FIXTURE_PROFILE, { text: REWRITE_PASSAGE, pov: 'Mara' })
}
/** Every rewrite cap at its limit: the passage, both context windows, long metadata, a voice block at its budget. */
const rewriteMaxedText = FIXTURE_PASSAGE.repeat(3).slice(0, REWRITE_TEXT_MAX)
const rewriteMaxed: BuildRewritePromptInput = {
  text: rewriteMaxedText,
  before: FIXTURE_PASSAGE.slice(-REWRITE_CONTEXT_CHARS),
  after: FIXTURE_PASSAGE.slice(0, REWRITE_CONTEXT_CHARS),
  meta: {
    location: 'L'.repeat(200),
    pov: 'P'.repeat(200),
    timeline: 'T'.repeat(500),
    brief: EMPTY_SCENE_BRIEF
  },
  voice: voiceBlock(MAXED_PROFILE, { text: rewriteMaxedText, pov: 'Mara' })
}

function rewriteCase(
  name: string,
  note: string,
  input: BuildRewritePromptInput,
  regen: { note: string | null; violation: string | null } | null
): EvalCase {
  const built =
    regen === null ? buildRewritePrompt(input) : buildRewriteRegenPrompt({ ...input, ...regen })
  return {
    version: regen === null ? REWRITE_PROMPT_VERSION : REWRITE_REGEN_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'chat', profile: input.voice === null ? null : FIXTURE_STATS }
  }
}

/** The same three shapes under `rewrite.v2` (F-14.9): no bible, the fixture bible, the bible at its cap. */
const rewriteFreshV2: BuildRewritePromptV2Input = { ...rewriteFresh, bible: null }
const rewriteFullV2: BuildRewritePromptV2Input = { ...rewriteFull, bible: FIXTURE_BIBLE }
const rewriteMaxedV2: BuildRewritePromptV2Input = { ...rewriteMaxed, bible: MAXED_BIBLE }

function rewriteCaseV2(
  name: string,
  note: string,
  input: BuildRewritePromptV2Input,
  regen: { note: string | null; violation: string | null } | null
): EvalCase {
  const built =
    regen === null ? buildRewritePromptV2(input) : buildRewriteRegenPromptV2({ ...input, ...regen })
  return {
    version: regen === null ? REWRITE_PROMPT_V2_VERSION : REWRITE_REGEN_PROMPT_V2_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'chat', profile: input.voice === null ? null : FIXTURE_STATS }
  }
}

/** The same three shapes under `rewrite.v3` (F-14.13): no steer, the fixture steer, the steer at its cap. */
const rewriteFreshV3: BuildRewritePromptV3Input = { ...rewriteFreshV2, steer: null }
const rewriteFullV3: BuildRewritePromptV3Input = { ...rewriteFullV2, steer: FIXTURE_STEER }
const rewriteMaxedV3: BuildRewritePromptV3Input = { ...rewriteMaxedV2, steer: MAXED_STEER }

function rewriteCaseV3(
  name: string,
  note: string,
  input: BuildRewritePromptV3Input,
  regen: { note: string | null; violation: string | null } | null
): EvalCase {
  const built =
    regen === null ? buildRewritePromptV3(input) : buildRewriteRegenPromptV3({ ...input, ...regen })
  return {
    version: regen === null ? REWRITE_PROMPT_V3_VERSION : REWRITE_REGEN_PROMPT_V3_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'chat', profile: input.voice === null ? null : FIXTURE_STATS }
  }
}

/** The scene an author asks for notes on: the fixture as `docToText` yields it. */
const critiqueFresh: BuildCritiquePromptInput = {
  sceneText: FIXTURE_PASSAGE,
  notes: null,
  meta: null,
  voice: null,
  honesty: DEFAULT_HONESTY
}
const critiqueFull: BuildCritiquePromptInput = {
  ...critiqueFresh,
  notes: NOTES,
  meta: META,
  voice: voiceBlock(FIXTURE_PROFILE, { text: FIXTURE_PASSAGE, pov: 'Mara' })
}
/** Every critique cap at its limit: the scene at its character budget, the notes at theirs, long metadata, a voice block at its budget, the bluntest honesty line. */
const critiqueMaxedScene = `${FIXTURE_PASSAGE.repeat(20).slice(0, CRITIQUE_SCENE_CHAR_BUDGET)}\u2026`
const critiqueMaxed: BuildCritiquePromptInput = {
  sceneText: critiqueMaxedScene,
  notes: `${FIXTURE_PASSAGE.slice(0, CRITIQUE_NOTES_CHAR_CAP)}\u2026`,
  meta: {
    location: 'L'.repeat(200),
    pov: 'P'.repeat(200),
    timeline: 'T'.repeat(500),
    brief: EMPTY_SCENE_BRIEF
  },
  voice: voiceBlock(MAXED_PROFILE, { text: critiqueMaxedScene, pov: 'Mara' }),
  honesty: 'brutal'
}

function critiqueCase(
  name: string,
  note: string,
  input: BuildCritiquePromptInput,
  regenNote: string | null | undefined
): EvalCase {
  const built =
    regenNote === undefined
      ? buildCritiquePrompt(input)
      : buildCritiqueRegenPrompt({ ...input, note: regenNote })
  return {
    version: regenNote === undefined ? CRITIQUE_PROMPT_VERSION : CRITIQUE_REGEN_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'critique', sceneText: input.sceneText }
  }
}

/** The same three shapes under `critique.v2` (F-14.3): the brief in place of the notes. */
const critiqueFreshV2: BuildCritiquePromptV2Input = {
  sceneText: FIXTURE_PASSAGE,
  brief: null,
  meta: null,
  voice: null,
  honesty: DEFAULT_HONESTY
}
const critiqueFullV2: BuildCritiquePromptV2Input = {
  ...critiqueFreshV2,
  brief: BRIEF_BLOCK,
  meta: META,
  voice: voiceBlock(FIXTURE_PROFILE, { text: FIXTURE_PASSAGE, pov: 'Mara' })
}
const critiqueMaxedV2: BuildCritiquePromptV2Input = {
  sceneText: critiqueMaxedScene,
  brief: MAXED_BRIEF_BLOCK,
  meta: {
    location: 'L'.repeat(200),
    pov: 'P'.repeat(200),
    timeline: 'T'.repeat(500),
    brief: EMPTY_SCENE_BRIEF
  },
  voice: voiceBlock(MAXED_PROFILE, { text: critiqueMaxedScene, pov: 'Mara' }),
  honesty: 'brutal'
}

function critiqueCaseV2(
  name: string,
  note: string,
  input: BuildCritiquePromptV2Input,
  regenNote: string | null | undefined
): EvalCase {
  const built =
    regenNote === undefined
      ? buildCritiquePromptV2(input)
      : buildCritiqueRegenPromptV2({ ...input, note: regenNote })
  return {
    version:
      regenNote === undefined ? CRITIQUE_PROMPT_V2_VERSION : CRITIQUE_REGEN_PROMPT_V2_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'critique', sceneText: input.sceneText }
  }
}

/** The same three shapes under `critique.v3` (F-14.9): no bible, the fixture bible, the bible at its cap. */
const critiqueFreshV3: BuildCritiquePromptV3Input = { ...critiqueFreshV2, bible: null }
const critiqueFullV3: BuildCritiquePromptV3Input = { ...critiqueFullV2, bible: FIXTURE_BIBLE }
const critiqueMaxedV3: BuildCritiquePromptV3Input = { ...critiqueMaxedV2, bible: MAXED_BIBLE }

function critiqueCaseV3(
  name: string,
  note: string,
  input: BuildCritiquePromptV3Input,
  regenNote: string | null | undefined
): EvalCase {
  const built =
    regenNote === undefined
      ? buildCritiquePromptV3(input)
      : buildCritiqueRegenPromptV3({ ...input, note: regenNote })
  return {
    version:
      regenNote === undefined ? CRITIQUE_PROMPT_V3_VERSION : CRITIQUE_REGEN_PROMPT_V3_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'critique', sceneText: input.sceneText }
  }
}

/**
 * The read-through an author asks their beta reader for: the fixture scene with the scenes
 * before it as their stored summaries. The texts an item may cite are the summary blocks and
 * the scene itself, exactly as the feature matches them.
 */
const betaReaderScenes: BuildBetaReaderPromptInput['scenes'] = [
  {
    title: 'Chapter 1 \u203a The ledger',
    summary:
      'Mara finds the ledger her brother copied and learns the mill has been paying Tomas for ' +
      'a debt that was never hers.',
    keyPoints: ['The ledger is a copy.', 'Tomas holds the mill\u2019s debt.']
  },
  {
    title: 'Chapter 1 \u203a The north pasture',
    summary: 'Tomas refuses to talk while the river is up and sends Mara back to the landing.',
    keyPoints: ['The river is rising.']
  }
]
const betaReaderFresh: BuildBetaReaderPromptInput = {
  scenes: [],
  current: { title: 'Chapter 1 \u203a The ferry landing', text: FIXTURE_PASSAGE },
  honesty: DEFAULT_HONESTY
}
const betaReaderFull: BuildBetaReaderPromptInput = {
  ...betaReaderFresh,
  scenes: betaReaderScenes,
  current: { title: 'Chapter 2 \u203a The ferry landing', text: FIXTURE_PASSAGE }
}
/** Every beta-reader cap at its limit: a 20,000-character scene, 20 earlier summaries at theirs, long titles, the bluntest honesty line. */
const betaReaderMaxed: BuildBetaReaderPromptInput = {
  scenes: Array.from({ length: 20 }, (_, index) => ({
    title: `${'C'.repeat(40)} \u203a ${'S'.repeat(40)} ${index}`,
    summary: 's'.repeat(SUMMARY_MAX_CHARS),
    keyPoints: Array.from({ length: SUMMARY_KEY_POINTS_MAX }, () =>
      'k'.repeat(SUMMARY_KEY_POINT_MAX)
    )
  })),
  current: {
    title: 'T'.repeat(90),
    text: `${FIXTURE_PASSAGE.repeat(20).slice(0, BETA_READER_SCENE_CHAR_BUDGET)}\u2026`
  },
  honesty: 'brutal'
}

function betaReaderCase(
  name: string,
  note: string,
  input: BuildBetaReaderPromptInput,
  regenNote: string | null | undefined
): EvalCase {
  const built =
    regenNote === undefined
      ? buildBetaReaderPrompt(input)
      : buildBetaReaderRegenPrompt({ ...input, note: regenNote })
  return {
    version:
      regenNote === undefined ? BETA_READER_PROMPT_VERSION : BETA_READER_REGEN_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: {
      kind: 'betaReader',
      texts: [
        ...input.scenes.map((scene) => [scene.summary, ...scene.keyPoints].join('\n')),
        input.current.text
      ]
    }
  }
}

function briefCase(
  name: string,
  note: string,
  sceneText: string,
  meta: typeof META | null
): EvalCase {
  const built = buildBriefPrompt({ sceneText, meta })
  return {
    version: BRIEF_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'brief' }
  }
}

function summaryCase(
  name: string,
  note: string,
  sceneText: string,
  meta: typeof META | null,
  characters: string[]
): EvalCase {
  const built = buildSummaryPrompt({ sceneText, meta, characters })
  return {
    version: SUMMARY_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'summary' }
  }
}

function summaryV2Case(
  name: string,
  note: string,
  sceneText: string,
  meta: typeof META | null,
  known: SummaryKnownNames
): EvalCase {
  const built = buildSummaryPromptV2({ sceneText, meta, known })
  return {
    version: SUMMARY_PROMPT_V2_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'summaryFacts', sceneText }
  }
}

function summaryV3Case(
  name: string,
  note: string,
  sceneText: string,
  meta: typeof META | null,
  known: SummaryKnownNames,
  bank: SummaryBankTags
): EvalCase {
  const built = buildSummaryPromptV3({ sceneText, meta, known, bank })
  return {
    version: SUMMARY_PROMPT_V3_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    // The tags are lenient by design (a dropped tag costs nothing), so the facts rule scores v3 too.
    scoring: { kind: 'summaryFacts', sceneText }
  }
}

/** The tag bank a summary request lists (F-4.13): none, a working bank, and the cap. */
const NO_BANK_TAGS: SummaryBankTags = { tone: [], content: [], plotThread: [], custom: [] }
const FIXTURE_BANK_TAGS: SummaryBankTags = {
  tone: ['dread', 'tense'],
  content: ['dialogue'],
  plotThread: ['the-mill-debt'],
  custom: ['duty']
}
const MAXED_BANK_TAGS: SummaryBankTags = {
  tone: Array.from({ length: SUMMARY_BANK_TAGS_MAX }, (_, index) => `a-long-tone-name-${index}`),
  content: [],
  plotThread: [],
  custom: []
}

/** The story-bible names the fixture scene contains (F-5.16): its two people and the place. */
const FIXTURE_KNOWN: SummaryKnownNames = {
  character: ['Mara', 'Tomas'],
  setting: ['ferry landing'],
  world: []
}
/** The known-names line at its cap, every name at a realistic full length. */
const MAXED_KNOWN: SummaryKnownNames = {
  character: Array.from(
    { length: SUMMARY_KNOWN_NAMES_MAX },
    (_, index) => `Character Name ${index}`
  ),
  setting: [],
  world: []
}

/** The character names a summary request lists: the bible's own cast, and the bank at its cap. */
const FIXTURE_CHARACTERS = FIXTURE_FACTS.bank
  .filter((entry) => entry.category === 'character')
  .map((entry) => entry.name)
const MAXED_CHARACTERS = MAXED_BANK.slice(0, SUMMARY_BANK_NAMES_MAX)

/**
 * A Story Intelligence turn (F-5.7): a question about the whole manuscript, the scenes main
 * retrieved for it in full, and the next candidates as their stored summaries. The texts a
 * citation may quote are exactly the full scenes, as the feature matches them.
 */
const QUERY_QUESTION = 'What does Tomas want from Mara, and what does she give him instead?'
const queryFresh: BuildQueryPromptInput = {
  full: [{ title: 'Chapter 1 \u203a The ferry landing', text: FIXTURE_PASSAGE }],
  summaries: [],
  history: [],
  question: QUERY_QUESTION
}
const queryFull: BuildQueryPromptInput = {
  full: [
    { title: 'Chapter 1 \u203a The ferry landing', text: FIXTURE_PASSAGE },
    { title: 'Chapter 2 \u203a The mill ledger', text: FIXTURE_PASSAGE.slice(0, 1_200) },
    { title: 'Chapter 2 \u203a The north pasture', text: FIXTURE_PASSAGE.slice(-1_200) }
  ],
  summaries: betaReaderScenes,
  history: [
    { role: 'user', content: 'Who is Tomas to Mara?' },
    {
      role: 'assistant',
      content: 'He is the man the mill owes; he meets her at the ferry landing. [1]'
    }
  ],
  question: QUERY_QUESTION
}
/**
 * The worst input the feature can be handed — three scenes at the character budget, ten
 * summaries at every cap, long titles, ten history turns at the message cap — as `fitQueryPrompt`
 * leaves it, which is what production would actually send: the raw shape is far over the input
 * budget, so the fit shrinks the scenes to their floor, drops the summaries, and drops the
 * lowest-ranked scenes before anything goes out (CLAUDE.md, token rule 8).
 */
const queryMaxedRaw = {
  full: Array.from({ length: 3 }, (_, index) => ({
    nodeId: `full-${index}`,
    title: `${'C'.repeat(40)} \u203a ${'S'.repeat(40)} ${index}`,
    text: `${FIXTURE_PASSAGE.repeat(20).slice(0, QUERY_SCENE_CHAR_BUDGET)}\u2026`
  })),
  summaries: Array.from({ length: 10 }, (_, index) => ({
    nodeId: `summary-${index}`,
    contentHash: `hash-${index}`,
    title: `${'C'.repeat(40)} \u203a ${'S'.repeat(40)} ${index}`,
    summary: 's'.repeat(SUMMARY_MAX_CHARS),
    keyPoints: Array.from({ length: SUMMARY_KEY_POINTS_MAX }, () =>
      'k'.repeat(SUMMARY_KEY_POINT_MAX)
    )
  })),
  history: Array.from({ length: CHAT_HISTORY_TURNS }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: 'h'.repeat(CHAT_MESSAGE_MAX)
  }))
}
const MAXED_QUESTION = 'q'.repeat(CHAT_MESSAGE_MAX)
const queryMaxed: BuildQueryPromptInput = {
  ...fitQueryPrompt(
    queryMaxedRaw,
    inputBudget('query'),
    (full, summaries, history) =>
      buildQueryPrompt({ full, summaries, history, question: MAXED_QUESTION }).messages
  ),
  question: MAXED_QUESTION
}

/**
 * The story bible a query carries for the entities its question names (F-5.16): the author's
 * sheet for Mara, and for Tomas only what the manuscript states, with the scene it was read
 * from. Rendered through the feature's own budgeted renderer.
 */
const QUERY_BIBLE_ENTITIES_FIXTURE: StoryBibleEntity[] = [
  {
    name: 'Mara',
    kind: 'character',
    sheet: [
      { label: 'Age', value: '31' },
      { label: 'Goals / motivations', value: 'Clear her brother\u2019s debt to the mill.' }
    ],
    observed: [
      {
        label: 'Relationships',
        value: 'Her brother owes the mill (Chapter 1 \u203a The ferry landing)'
      }
    ]
  },
  {
    name: 'Tomas',
    kind: 'character',
    sheet: [],
    observed: [
      {
        label: 'Goals / motivations',
        value: 'Wants the mill\u2019s debt paid (Chapter 1 \u203a The ferry landing)'
      }
    ]
  }
]
const queryBible = (entities: StoryBibleEntity[]): string | null => {
  const lines = renderStoryBibleEntities(entities, QUERY_BIBLE_TOKEN_BUDGET)
  return lines.length > 0 ? lines.join('\n') : null
}
const queryV2Fresh: BuildQueryPromptV2Input = { ...queryFresh, bible: null }
const queryV2Full: BuildQueryPromptV2Input = {
  ...queryFull,
  bible: queryBible(QUERY_BIBLE_ENTITIES_FIXTURE)
}
/** The block at its budget: the most entities a question can name, every sheet and fact list full. */
const MAXED_QUERY_BIBLE = queryBible(
  Array.from({ length: QUERY_BIBLE_ENTITIES }, (_, index) => ({
    name: `${'N'.repeat(40)} ${index}`,
    kind: 'character' as const,
    sheet: Array.from({ length: 8 }, (_unused, field) => ({
      label: `Field ${field}`,
      value: 'v'.repeat(STORY_BIBLE_VALUE_MAX)
    })),
    observed: Array.from({ length: 7 }, (_unused, fact) => ({
      label: `Attribute ${fact}`,
      value: 'o'.repeat(STORY_BIBLE_VALUE_MAX)
    }))
  }))
)
const queryV2Maxed: BuildQueryPromptV2Input = {
  ...fitQueryPrompt(
    queryMaxedRaw,
    inputBudget('query'),
    (full, summaries, history) =>
      buildQueryPromptV2({
        full,
        summaries,
        history,
        question: MAXED_QUESTION,
        bible: MAXED_QUERY_BIBLE
      }).messages
  ),
  question: MAXED_QUESTION,
  bible: MAXED_QUERY_BIBLE
}

/** query.v3's bible: the same entities through the larger budget and the longer value cap. */
const queryBibleV3 = (entities: StoryBibleEntity[]): string | null => {
  const lines = renderStoryBibleEntities(
    entities,
    QUERY_V3_BIBLE_TOKEN_BUDGET,
    QUERY_V3_BIBLE_VALUE_MAX
  )
  return lines.length > 0 ? lines.join('\n') : null
}
const queryV3Fresh: BuildQueryPromptV3Input = { ...queryFresh, bible: null }
const queryV3Full: BuildQueryPromptV3Input = {
  ...queryFull,
  bible: queryBibleV3(QUERY_BIBLE_ENTITIES_FIXTURE)
}
/** The v3 block at its budget: the most entities, every sheet and fact list full at the v3 cap. */
const MAXED_QUERY_BIBLE_V3 = queryBibleV3(
  Array.from({ length: QUERY_BIBLE_ENTITIES }, (_, index) => ({
    name: `${'N'.repeat(40)} ${index}`,
    kind: 'character' as const,
    sheet: Array.from({ length: 8 }, (_unused, field) => ({
      label: `Field ${field}`,
      value: 'v'.repeat(QUERY_V3_BIBLE_VALUE_MAX)
    })),
    observed: Array.from({ length: 7 }, (_unused, fact) => ({
      label: `Attribute ${fact}`,
      value: 'o'.repeat(QUERY_V3_BIBLE_VALUE_MAX)
    }))
  }))
)
const queryV3Maxed: BuildQueryPromptV3Input = {
  ...fitQueryPrompt(
    queryMaxedRaw,
    inputBudget('query'),
    (full, summaries, history) =>
      buildQueryPromptV3({
        full,
        summaries,
        history,
        question: MAXED_QUESTION,
        bible: MAXED_QUERY_BIBLE_V3
      }).messages
  ),
  question: MAXED_QUESTION,
  bible: MAXED_QUERY_BIBLE_V3
}

/** The fixture passage as the import draft sees it: one paragraph per block, in reading order. */
const IMPORT_PARAGRAPHS = FIXTURE_PASSAGE.split('\n\n')

/**
 * A chunk of a draft: `every` paragraphs a scene starts (the boundaries the heuristics already
 * found), the first one a chapter too, which is the shape `flattenDraft` hands the prompt.
 */
function structureChunk(texts: string[], every: number): StructurePromptParagraph[] {
  let scene = 0
  return texts.map((text, index) => {
    const sceneStart = index % every === 0
    if (sceneStart) scene += 1
    return {
      index,
      text,
      sceneStart,
      chapterStart: index === 0,
      sceneTitle: `Scene ${scene}`,
      chapterTitle: 'Chapter One'
    }
  })
}

/** A chunk at the word cap: the fixture prose repeated until `IMPORT_CHUNK_WORDS` is reached. */
function maxedChunk(): StructurePromptParagraph[] {
  const texts: string[] = []
  let words = 0
  while (words < IMPORT_CHUNK_WORDS) {
    const text = IMPORT_PARAGRAPHS[texts.length % IMPORT_PARAGRAPHS.length] ?? ''
    texts.push(text)
    words += text.split(/\s+/).length
  }
  return structureChunk(texts, 8)
}

function structureCase(
  name: string,
  note: string,
  paragraphs: StructurePromptParagraph[],
  bank: string[]
): EvalCase {
  const built = buildImportStructurePrompt({ paragraphs, tagNames: bank })
  return {
    version: IMPORT_STRUCTURE_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'structure', bank, indices: paragraphs.map((p) => p.index) }
  }
}

function queryCase(name: string, note: string, input: BuildQueryPromptInput): EvalCase {
  const built = buildQueryPrompt(input)
  return {
    version: QUERY_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'query', texts: input.full.map((scene) => scene.text) }
  }
}

function queryV3Case(name: string, note: string, input: BuildQueryPromptV3Input): EvalCase {
  const built = buildQueryPromptV3(input)
  return {
    version: QUERY_PROMPT_V3_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'query', texts: input.full.map((scene) => scene.text) }
  }
}

function queryV2Case(name: string, note: string, input: BuildQueryPromptV2Input): EvalCase {
  const built = buildQueryPromptV2(input)
  return {
    version: QUERY_PROMPT_V2_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'query', texts: input.full.map((scene) => scene.text) }
  }
}

/** Every case, grouped by version in catalogue order. */
/** A sheet field, a fact of another scene with its passage, and the previous scene's timeline: one of each kind. */
const sheetRef = (attribute: string, label: string, value: string): ContinuityRef => ({
  kind: 'sheet',
  entityId: 'entity-mara',
  entityName: 'Mara',
  entityKind: 'character',
  attribute,
  label,
  value,
  nodeId: null,
  quote: null
})
const factRef = (
  attribute: string,
  label: string,
  value: string,
  quote: string
): ContinuityRef => ({
  kind: 'fact',
  entityId: 'entity-tomas',
  entityName: 'Tomas',
  entityKind: 'character',
  attribute,
  label,
  value,
  nodeId: 'scene-2',
  quote
})
const TIMELINE_REF: ContinuityRef = {
  kind: 'timeline',
  entityId: null,
  entityName: null,
  entityKind: null,
  attribute: null,
  label: 'Timeline',
  value: 'Night, first thaw',
  nodeId: 'scene-1',
  quote: null
}
const CONTINUITY_FULL_REFS: ContinuityRef[] = [
  sheetRef('age', 'Age', '34'),
  sheetRef('appearance', 'Appearance', 'Grey eyes, a burn scar on the left wrist.'),
  sheetRef('relationships', 'Relationships', 'Sister of Pell, who kept the mill ledger.'),
  factRef(
    'background',
    'Background',
    'Holds the mill\u2019s debt',
    'The mill owes me. That is the whole of it.'
  ),
  TIMELINE_REF
]
/** Sheet fields at the value cap, as many as the reference budget admits (`continuityRefs` counts the same way). */
const CONTINUITY_MAXED_REFS: ContinuityRef[] = (() => {
  const ref = sheetRef('background', 'Background', 'v'.repeat(CONTINUITY_REF_VALUE_MAX))
  const cost = estimateTokens(`${continuityRefLine(ref, 10)}\n`)
  return Array<ContinuityRef>(Math.floor(CONTINUITY_REFS_TOKEN_BUDGET / cost)).fill(ref)
})()

function continuityCase(
  name: string,
  note: string,
  text: string,
  references: ContinuityRef[],
  timeline: string | null,
  brief: string | null
): EvalCase {
  const voice = voiceBlock(FIXTURE_PROFILE, { text: FIXTURE_PASSAGE, pov: 'Mara' })
  // The scene is fitted to the input budget exactly as the feature fits it (token rule 8).
  const { sceneText } = fitSceneToBudget(
    text,
    inputBudget('continuity'),
    (cut) => buildContinuityPrompt({ sceneText: cut, references, timeline, voice, brief }).messages,
    { chars: CONTINUITY_SCENE_CHAR_BUDGET, min: CONTINUITY_TEXT_MIN }
  )
  const built = buildContinuityPrompt({ sceneText, references, timeline, voice, brief })
  return {
    version: CONTINUITY_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'continuity', sceneText, references: references.length }
  }
}

/** The fixture passage with four planted errors: a misspelled name, a doubled word, a typo, a missing comma. */
const PROOFREAD_PASSAGE = FIXTURE_PASSAGE.replace('when Mara reached', 'when Marra reached')
  .replace('The rope hung', 'The the rope hung')
  .replace('the far bank', 'teh far bank')
  .replace('"Then we talk here."', '"Then we talk here" she said.')
/** The names of the fixture story: what the keep list carries for a project with its characters linked. */
const PROOFREAD_KEEP_WORDS = ['Mara', 'Tomas', 'Pell']
/** Dictionary words at the length cap the keep list allows, names first. */
const PROOFREAD_MAXED_KEEP_WORDS = [
  ...PROOFREAD_KEEP_WORDS,
  ...Array.from(
    { length: PROOFREAD_KEEP_WORDS_MAX - PROOFREAD_KEEP_WORDS.length },
    (_, i) => `${'k'.repeat(20)}${i}`
  )
]

function proofreadCase(
  name: string,
  note: string,
  input: { text: string; voice: string | null; brief: string | null; keepWords: string[] }
): EvalCase {
  // The text is fitted to the input budget exactly as the feature fits it (token rule 8).
  const { sceneText: text } = fitSceneToBudget(
    input.text,
    inputBudget('proofread'),
    (cut) => buildProofreadPrompt({ ...input, text: cut }).messages,
    { chars: PROOFREAD_CHAR_BUDGET, min: PROOFREAD_TEXT_MIN }
  )
  const built = buildProofreadPrompt({ ...input, text })
  return {
    version: PROOFREAD_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'proofread', text, keepWords: input.keepWords }
  }
}

function whatNextCase(
  name: string,
  note: string,
  input: { text: string; brief: string | null; bible: string | null }
): EvalCase {
  // The tail is fitted to the input budget exactly as the feature fits it (token rule 8).
  const { text } = fitTailToBudget(
    input.text,
    inputBudget('whatNext'),
    (cut) => buildWhatNextPrompt({ ...input, text: cut }).messages
  )
  const built = buildWhatNextPrompt({ ...input, text })
  return {
    version: WHAT_NEXT_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'whatNext' }
  }
}

function whatNextCaseV2(
  name: string,
  note: string,
  input: { text: string; brief: string | null; steer: string | null; bible: string | null }
): EvalCase {
  // The tail is fitted to the input budget exactly as the feature fits it (token rule 8).
  const { text } = fitTailToBudget(
    input.text,
    inputBudget('whatNext'),
    (cut) => buildWhatNextPromptV2({ ...input, text: cut }).messages
  )
  const built = buildWhatNextPromptV2({ ...input, text })
  return {
    version: WHAT_NEXT_PROMPT_V2_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'whatNext' }
  }
}

/** The side panel the author keeps for the fixture scene (F-5.20): a synopsis and the scene notes. */
const FIXTURE_PANEL: ScenePanel = {
  synopsis:
    'Mara meets Tomas at the flooded ferry landing and, instead of bargaining over the ledger, ' +
    'tells him she knows where her brother is buried.',
  notes: NOTES
}
/** The panel at its caps: a synopsis at its full length and the notes cut at theirs. */
const MAXED_PANEL: ScenePanel = {
  synopsis: 's'.repeat(PANEL_SYNOPSIS_CHARS),
  notes: `${FIXTURE_PASSAGE.repeat(2).slice(0, PANEL_NOTES_CHARS)}…`
}

/** The same four shapes under `chat.v5` (F-5.20): the side panel in both modes. */
const planFreshV5: BuildChatPromptV5Input = { ...planFreshV4, panel: null }
const planFullV5: BuildChatPromptV5Input = { ...planFullV4, panel: FIXTURE_PANEL }
const agentFullV5: BuildChatPromptV5Input = { ...agentFullV4, panel: FIXTURE_PANEL }
const agentMaxedV5: BuildChatPromptV5Input = { ...agentMaxedV4, panel: MAXED_PANEL }

function chatCaseV5(
  name: string,
  note: string,
  given: BuildChatPromptV5Input,
  violation: string | null
): EvalCase {
  // The oldest history turns are dropped until the first prompt fits, as `runChat` drops them.
  const fits = (candidate: BuildChatPromptV5Input): boolean =>
    estimateTokens(
      buildChatPromptV5(candidate)
        .messages.map((m) => m.content)
        .join('\n')
    ) <= inputBudget('chat')
  let input = given
  while (input.history.length > 0 && !fits(input)) {
    input = { ...input, history: input.history.slice(1) }
  }
  const built =
    violation === null ? buildChatPromptV5(input) : buildChatRegenPromptV5({ ...input, violation })
  return {
    version: violation === null ? CHAT_PROMPT_V5_VERSION : CHAT_REGEN_PROMPT_V5_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    ...(built.temperature === undefined ? {} : { temperature: built.temperature }),
    scoring: { kind: 'chat', profile: input.voice === null ? null : FIXTURE_STATS }
  }
}

/** The same three shapes under `query.v4` (F-5.20): no panel, the fixture panel, the panel at its caps. */
const queryV4Fresh: BuildQueryPromptV4Input = { ...queryV3Fresh, panel: null }
const queryV4Full: BuildQueryPromptV4Input = { ...queryV3Full, panel: FIXTURE_PANEL }
const queryV4Maxed: BuildQueryPromptV4Input = {
  ...fitQueryPrompt(
    queryMaxedRaw,
    inputBudget('query'),
    (full, summaries, history) =>
      buildQueryPromptV4({
        full,
        summaries,
        history,
        question: MAXED_QUESTION,
        bible: MAXED_QUERY_BIBLE_V3,
        panel: MAXED_PANEL
      }).messages
  ),
  question: MAXED_QUESTION,
  bible: MAXED_QUERY_BIBLE_V3,
  panel: MAXED_PANEL
}

function queryV4Case(name: string, note: string, input: BuildQueryPromptV4Input): EvalCase {
  const built = buildQueryPromptV4(input)
  return {
    version: QUERY_PROMPT_V4_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'query', texts: input.full.map((scene) => scene.text) }
  }
}

function routeCase(
  name: string,
  note: string,
  input: BuildRoutePromptInput,
  expected: string
): EvalCase {
  const built = buildRoutePrompt(input)
  return {
    version: ROUTE_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'route', expected }
  }
}

function synopsisCase(name: string, note: string, input: BuildSynopsisPromptInput): EvalCase {
  // The scene is fitted to the input budget exactly as the feature fits it (token rule 8).
  const { sceneText } = fitSceneToBudget(
    input.sceneText,
    inputBudget('synopsis'),
    (cut) => buildSynopsisPrompt({ ...input, sceneText: cut }).messages,
    { chars: SCENE_SUGGEST_CHAR_BUDGET, min: SCENE_SUGGEST_TEXT_MIN }
  )
  const built = buildSynopsisPrompt({ ...input, sceneText })
  return {
    version: SYNOPSIS_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'synopsis' }
  }
}

function notesSuggestCase(
  name: string,
  note: string,
  input: BuildNotesSuggestPromptInput
): EvalCase {
  // The scene is fitted to the input budget exactly as the feature fits it (token rule 8).
  const { sceneText } = fitSceneToBudget(
    input.sceneText,
    inputBudget('notesSuggest'),
    (cut) => buildNotesSuggestPrompt({ ...input, sceneText: cut }).messages,
    { chars: SCENE_SUGGEST_CHAR_BUDGET, min: SCENE_SUGGEST_TEXT_MIN }
  )
  const built = buildNotesSuggestPrompt({ ...input, sceneText })
  return {
    version: NOTES_SUGGEST_PROMPT_VERSION,
    name,
    note,
    messages: built.messages,
    maxTokens: built.maxTokens,
    scoring: { kind: 'notesSuggest' }
  }
}

/** The stored summary of the fixture scene (F-5.6), and one at every cap. */
const SUGGEST_SUMMARY = {
  summary:
    'Mara meets Tomas at the ferry landing. He wants the mill ledger back; she reveals her ' +
    'brother only copied it, then tells Tomas she knows he buried her brother under the elm.',
  keyPoints: ['The ledger is a copy.', 'Tomas killed her brother.']
}
const MAXED_SUGGEST_SUMMARY = {
  summary: 's'.repeat(SUMMARY_MAX_CHARS),
  keyPoints: Array.from({ length: SUMMARY_KEY_POINTS_MAX }, () => 'k'.repeat(SUMMARY_KEY_POINT_MAX))
}

export const EVAL_CASES: EvalCase[] = [
  ghostCase('fresh', 'no voice block, no notes or metadata, General preset', fresh, null),
  ghostCase(
    'full',
    'voice rules and one exemplar, notes, metadata, text after the caret, Suspense preset',
    full,
    null
  ),
  ghostCase(
    'maxed',
    'every cap at its limit: the caret window, the notes, long metadata, a voice block at its budget',
    maxed,
    null
  ),
  ghostCase('full', 'the full case regenerated after a tense violation', full, VIOLATION),
  ghostCase('maxed', 'the maxed case regenerated after a tense violation', maxed, VIOLATION),
  ghostCaseV2(
    'fresh',
    'no voice block, no brief, notes, or metadata, General preset',
    ghostFreshV2,
    null
  ),
  ghostCaseV2(
    'full',
    'voice rules and one exemplar, the scene brief with both neighbour lines, notes, metadata, text after the caret, Suspense preset',
    ghostFullV2,
    null
  ),
  ghostCaseV2(
    'maxed',
    'every cap at its limit: the caret window, the notes, long metadata, a brief at every line cap, a voice block at its budget',
    ghostMaxedV2,
    null
  ),
  ghostCaseV2('full', 'the full case regenerated after a tense violation', ghostFullV2, VIOLATION),
  ghostCaseV2(
    'maxed',
    'the maxed case regenerated after a tense violation',
    ghostMaxedV2,
    VIOLATION
  ),
  ghostCaseV3(
    'fresh',
    'the v2 fresh case with no story bible: a project that states no facts yet',
    ghostFreshV3,
    null
  ),
  ghostCaseV3(
    'full',
    'the v2 full case plus the story bible at the ghost budget (the bank, the scene, its neighbours)',
    ghostFullV3,
    null
  ),
  ghostCaseV3(
    'maxed',
    'every cap at its limit, the story bible filling its ghost budget too',
    ghostMaxedV3,
    null
  ),
  ghostCaseV3(
    'full',
    'the full case with its bible, regenerated after a tense violation',
    ghostFullV3,
    VIOLATION
  ),
  ghostCaseV3(
    'maxed',
    'the maxed case with its bible, regenerated after a tense violation',
    ghostMaxedV3,
    VIOLATION
  ),
  ghostCaseV4(
    'fresh',
    'the v3 fresh case with no scene steer: a scene with no tone, content, plot thread, or theme tag',
    ghostFreshV4,
    null
  ),
  ghostCaseV4(
    'full',
    'the v3 full case plus the scene steer (a tone, a content tag, a plot thread, a theme)',
    ghostFullV4,
    null
  ),
  ghostCaseV4(
    'maxed',
    'every cap at its limit, the steer with every category over its name cap at the tag-name cap',
    ghostMaxedV4,
    null
  ),
  ghostCaseV4(
    'full',
    'the full case with its steer, regenerated after a tense violation',
    ghostFullV4,
    VIOLATION
  ),
  ghostCaseV4(
    'maxed',
    'the maxed case with its steer, regenerated after a tense violation',
    ghostMaxedV4,
    VIOLATION
  ),
  tagsCase(
    'fixture',
    'the fixture scene against the Standard Fiction bank',
    FIXTURE_PASSAGE,
    FIXTURE_BANK,
    undefined
  ),
  tagsCase(
    'maxed',
    'a passage at the character budget against every template name',
    FIXTURE_PASSAGE.repeat(6).slice(0, TAGS_TEXT_CHAR_BUDGET + 500),
    MAXED_BANK,
    undefined
  ),
  tagsCase(
    'no note',
    'the fixture regenerated without a note',
    FIXTURE_PASSAGE,
    FIXTURE_BANK,
    null
  ),
  tagsCase(
    'maxed',
    'the maxed case regenerated with a note at the length limit',
    FIXTURE_PASSAGE.repeat(6).slice(0, TAGS_TEXT_CHAR_BUDGET + 500),
    MAXED_BANK,
    'n'.repeat(PROPOSAL_NOTE_MAX)
  ),
  chatCase(
    'plan fresh',
    'Plan mode with no scene open, no references, no history',
    planFresh,
    null
  ),
  chatCase(
    'plan full',
    'Plan mode over the fixture scene with one #reference and two turns of history',
    planFull,
    null
  ),
  chatCase(
    'agent full',
    'Agent mode, 3 paragraphs: voice rules and one exemplar, Suspense preset, metadata, one #reference, two turns',
    agentFull,
    null
  ),
  chatCase(
    'agent maxed',
    'every cap at its limit: the scene, four references, long metadata, a voice block at its budget, ten history turns, a message at the limit, 10 paragraphs',
    agentMaxed,
    null
  ),
  chatCase(
    'agent full',
    'the agent full case regenerated after a tense violation',
    agentFull,
    VIOLATION
  ),
  chatCase(
    'agent maxed',
    'the agent maxed case regenerated after a tense violation',
    agentMaxed,
    VIOLATION
  ),
  chatCaseV2(
    'plan fresh',
    'Plan mode with no scene open, no references, no history',
    planFreshV2,
    null
  ),
  chatCaseV2(
    'plan full',
    'Plan mode over the fixture scene with one #reference and two turns of history (Plan mode carries no brief)',
    planFullV2,
    null
  ),
  chatCaseV2(
    'agent full',
    'Agent mode, 3 paragraphs: voice rules and one exemplar, Suspense preset, metadata, the scene brief, one #reference, two turns',
    agentFullV2,
    null
  ),
  chatCaseV2(
    'agent maxed',
    'every cap at its limit: the scene, four references, long metadata, a brief at every line cap, a voice block at its budget, ten history turns, a message at the limit, 10 paragraphs',
    agentMaxedV2,
    null
  ),
  chatCaseV2(
    'agent full',
    'the agent full case regenerated after a tense violation',
    agentFullV2,
    VIOLATION
  ),
  chatCaseV2(
    'agent maxed',
    'the agent maxed case regenerated after a tense violation',
    agentMaxedV2,
    VIOLATION
  ),
  chatCaseV3(
    'plan fresh',
    'the v2 plan fresh case with no story bible: a project that states no facts yet',
    planFreshV3,
    null
  ),
  chatCaseV3('plan full', 'the v2 plan full case plus the story bible', planFullV3, null),
  chatCaseV3('agent full', 'the v2 agent full case plus the story bible', agentFullV3, null),
  chatCaseV3(
    'agent maxed',
    'every cap at its limit, the story bible filling its budget too',
    agentMaxedV3,
    null
  ),
  chatCaseV3(
    'agent full',
    'the agent full case with its bible, regenerated after a tense violation',
    agentFullV3,
    VIOLATION
  ),
  chatCaseV3(
    'agent maxed',
    'the agent maxed case with its bible, regenerated after a tense violation',
    agentMaxedV3,
    VIOLATION
  ),
  chatCaseV4('plan fresh', 'the v3 plan fresh case with no scene steer', planFreshV4, null),
  chatCaseV4(
    'plan full',
    'the v3 plan full case with a steer passed in, which Plan mode leaves out',
    planFullV4,
    null
  ),
  chatCaseV4('agent full', 'the v3 agent full case plus the scene steer', agentFullV4, null),
  chatCaseV4(
    'agent maxed',
    'every cap at its limit, the steer at its cap too, the oldest history turn dropped to fit as the feature does',
    agentMaxedV4,
    null
  ),
  chatCaseV4(
    'agent full',
    'the agent full case with its steer, regenerated after a tense violation',
    agentFullV4,
    VIOLATION
  ),
  chatCaseV4(
    'agent maxed',
    'the agent maxed case with its steer and trimmed history, regenerated after a tense violation',
    agentMaxedV4,
    VIOLATION
  ),
  rewriteCase('fresh', 'no voice block, no context either side, no metadata', rewriteFresh, null),
  rewriteCase(
    'full',
    'voice rules and one exemplar, metadata, manuscript text before and after the passage',
    rewriteFull,
    null
  ),
  rewriteCase(
    'maxed',
    'every cap at its limit: a 4,000-character passage, both context windows, long metadata, a voice block at its budget',
    rewriteMaxed,
    null
  ),
  rewriteCase(
    'full note',
    'the full case regenerated with an author note at the length limit',
    rewriteFull,
    { note: 'n'.repeat(PROPOSAL_NOTE_MAX), violation: null }
  ),
  rewriteCase('full violation', 'the full case regenerated after a tense violation', rewriteFull, {
    note: null,
    violation: VIOLATION
  }),
  rewriteCase(
    'maxed both',
    'the maxed case regenerated with an author note at the length limit and a tense violation',
    rewriteMaxed,
    { note: 'n'.repeat(PROPOSAL_NOTE_MAX), violation: VIOLATION }
  ),
  rewriteCaseV2(
    'fresh',
    'the fresh case with no story bible: a project that states no facts yet',
    rewriteFreshV2,
    null
  ),
  rewriteCaseV2('full', 'the full case plus the story bible', rewriteFullV2, null),
  rewriteCaseV2(
    'maxed',
    'every cap at its limit, the story bible filling its budget too',
    rewriteMaxedV2,
    null
  ),
  rewriteCaseV2(
    'full note',
    'the full case with its bible, regenerated with an author note at the length limit',
    rewriteFullV2,
    { note: 'n'.repeat(PROPOSAL_NOTE_MAX), violation: null }
  ),
  rewriteCaseV2(
    'full violation',
    'the full case with its bible, regenerated after a tense violation',
    rewriteFullV2,
    { note: null, violation: VIOLATION }
  ),
  rewriteCaseV2(
    'maxed both',
    'the maxed case with its bible, regenerated with an author note and a tense violation',
    rewriteMaxedV2,
    { note: 'n'.repeat(PROPOSAL_NOTE_MAX), violation: VIOLATION }
  ),
  rewriteCaseV3('fresh', 'the v2 fresh case with no scene steer', rewriteFreshV3, null),
  rewriteCaseV3('full', 'the v2 full case plus the scene steer', rewriteFullV3, null),
  rewriteCaseV3('maxed', 'every cap at its limit, the steer at its cap too', rewriteMaxedV3, null),
  rewriteCaseV3(
    'full note',
    'the full case with its steer, regenerated with an author note at the length limit',
    rewriteFullV3,
    { note: 'n'.repeat(PROPOSAL_NOTE_MAX), violation: null }
  ),
  rewriteCaseV3(
    'full violation',
    'the full case with its steer, regenerated after a tense violation',
    rewriteFullV3,
    { note: null, violation: VIOLATION }
  ),
  rewriteCaseV3(
    'maxed both',
    'the maxed case with its steer, regenerated with an author note and a tense violation',
    rewriteMaxedV3,
    { note: 'n'.repeat(PROPOSAL_NOTE_MAX), violation: VIOLATION }
  ),
  critiqueCase(
    'fresh',
    'no voice block, no notes as the brief, no metadata, the default honesty line',
    critiqueFresh,
    undefined
  ),
  critiqueCase(
    'full',
    "voice rules and one exemplar, the scene's notes as the brief, metadata",
    critiqueFull,
    undefined
  ),
  critiqueCase(
    'maxed',
    'every cap at its limit: a 20,000-character scene, the notes at their cap, long metadata, a voice block at its budget, the brutal honesty line',
    critiqueMaxed,
    undefined
  ),
  critiqueCase(
    'full note',
    'the full case regenerated with an author note at the length limit',
    critiqueFull,
    'n'.repeat(PROPOSAL_NOTE_MAX)
  ),
  critiqueCase(
    'maxed note',
    'the maxed case regenerated with an author note at the length limit',
    critiqueMaxed,
    'n'.repeat(PROPOSAL_NOTE_MAX)
  ),
  critiqueCaseV2(
    'fresh',
    'no voice block, no brief, no metadata, the default honesty line',
    critiqueFreshV2,
    undefined
  ),
  critiqueCaseV2(
    'full',
    "voice rules and one exemplar, the scene's brief with both neighbour lines, metadata",
    critiqueFullV2,
    undefined
  ),
  critiqueCaseV2(
    'maxed',
    'every cap at its limit: a 20,000-character scene, a brief at every line cap, long metadata, a voice block at its budget, the brutal honesty line',
    critiqueMaxedV2,
    undefined
  ),
  critiqueCaseV2(
    'full note',
    'the full case regenerated with an author note at the length limit',
    critiqueFullV2,
    'n'.repeat(PROPOSAL_NOTE_MAX)
  ),
  critiqueCaseV2(
    'maxed note',
    'the maxed case regenerated with an author note at the length limit',
    critiqueMaxedV2,
    'n'.repeat(PROPOSAL_NOTE_MAX)
  ),
  critiqueCaseV3(
    'fresh',
    'the v2 fresh case with no story bible: a project that states no facts yet',
    critiqueFreshV3,
    undefined
  ),
  critiqueCaseV3('full', 'the v2 full case plus the story bible', critiqueFullV3, undefined),
  critiqueCaseV3(
    'maxed',
    'every cap at its limit, the story bible filling its budget too',
    critiqueMaxedV3,
    undefined
  ),
  critiqueCaseV3(
    'full note',
    'the full case with its bible, regenerated with an author note at the length limit',
    critiqueFullV3,
    'n'.repeat(PROPOSAL_NOTE_MAX)
  ),
  critiqueCaseV3(
    'maxed note',
    'the maxed case with its bible, regenerated with an author note at the length limit',
    critiqueMaxedV3,
    'n'.repeat(PROPOSAL_NOTE_MAX)
  ),
  betaReaderCase(
    'fresh',
    'the first scene of a manuscript: nothing read before it, the default honesty line',
    betaReaderFresh,
    undefined
  ),
  betaReaderCase(
    'full',
    'two earlier scenes as their stored summaries and key points, then the scene in full',
    betaReaderFull,
    undefined
  ),
  betaReaderCase(
    'maxed',
    'every cap at its limit: a 20,000-character scene, 20 earlier summaries at their caps, long titles, the brutal honesty line',
    betaReaderMaxed,
    undefined
  ),
  betaReaderCase(
    'full note',
    'the full case regenerated with an author note at the length limit',
    betaReaderFull,
    'n'.repeat(PROPOSAL_NOTE_MAX)
  ),
  betaReaderCase(
    'maxed note',
    'the maxed case regenerated with an author note at the length limit',
    betaReaderMaxed,
    'n'.repeat(PROPOSAL_NOTE_MAX)
  ),
  briefCase(
    'fresh',
    'the fixture scene with no metadata: the shape a new project sends',
    FIXTURE_PASSAGE,
    null
  ),
  briefCase(
    'maxed',
    'a scene at the character budget with long metadata: the most a brief draft can cost',
    `${FIXTURE_PASSAGE.repeat(20).slice(0, BRIEF_SCENE_CHAR_BUDGET)}…`,
    {
      location: 'L'.repeat(200),
      pov: 'P'.repeat(200),
      timeline: 'T'.repeat(500),
      brief: EMPTY_SCENE_BRIEF
    }
  ),
  summaryCase(
    'fresh',
    'the fixture scene with no character names and no metadata: the shape a new project sends',
    FIXTURE_PASSAGE,
    null,
    []
  ),
  summaryCase(
    'full',
    "the fixture scene with the bank's character names and the scene's metadata",
    FIXTURE_PASSAGE,
    META,
    FIXTURE_CHARACTERS
  ),
  summaryCase(
    'maxed',
    `a scene at the character budget with ${SUMMARY_BANK_NAMES_MAX} character names and long metadata: the most a background summary can cost`,
    `${FIXTURE_PASSAGE.repeat(20).slice(0, SUMMARY_SCENE_CHAR_BUDGET)}…`,
    {
      location: 'L'.repeat(200),
      pov: 'P'.repeat(200),
      timeline: 'T'.repeat(500),
      brief: EMPTY_SCENE_BRIEF
    },
    MAXED_CHARACTERS
  ),
  summaryV2Case(
    'fresh',
    'the fixture scene with no story-bible names and no metadata: the shape a new project sends',
    FIXTURE_PASSAGE,
    null,
    { character: [], setting: [], world: [] }
  ),
  summaryV2Case(
    'full',
    "the fixture scene with the story-bible names it contains and the scene's metadata",
    FIXTURE_PASSAGE,
    META,
    FIXTURE_KNOWN
  ),
  summaryV2Case(
    'maxed',
    `a scene at the character budget with ${SUMMARY_KNOWN_NAMES_MAX} known names and long metadata: the most a background summary with facts can cost`,
    `${FIXTURE_PASSAGE.repeat(20).slice(0, SUMMARY_SCENE_CHAR_BUDGET)}…`,
    {
      location: 'L'.repeat(200),
      pov: 'P'.repeat(200),
      timeline: 'T'.repeat(500),
      brief: EMPTY_SCENE_BRIEF
    },
    MAXED_KNOWN
  ),
  summaryV3Case(
    'fresh',
    'the fixture scene with no story-bible names, no tag bank, and no metadata: the shape a new project sends',
    FIXTURE_PASSAGE,
    null,
    { character: [], setting: [], world: [] },
    NO_BANK_TAGS
  ),
  summaryV3Case(
    'full',
    "the fixture scene with the story-bible names it contains, a working tag bank, and the scene's metadata",
    FIXTURE_PASSAGE,
    META,
    FIXTURE_KNOWN,
    FIXTURE_BANK_TAGS
  ),
  summaryV3Case(
    'maxed',
    `a scene at the character budget with ${SUMMARY_KNOWN_NAMES_MAX} known names, ${SUMMARY_BANK_TAGS_MAX} bank tags, and long metadata: the most a background summary with facts and tags can cost`,
    `${FIXTURE_PASSAGE.repeat(20).slice(0, SUMMARY_SCENE_CHAR_BUDGET)}…`,
    {
      location: 'L'.repeat(200),
      pov: 'P'.repeat(200),
      timeline: 'T'.repeat(500),
      brief: EMPTY_SCENE_BRIEF
    },
    MAXED_KNOWN,
    MAXED_BANK_TAGS
  ),
  queryCase(
    'fresh',
    'one retrieved scene, no summaries and no history: the shape a new project sends',
    queryFresh
  ),
  queryCase(
    'full',
    'three retrieved scenes in full, two candidates as their stored summaries, two history turns',
    queryFull
  ),
  queryCase(
    'maxed',
    'the worst input (three scenes at the character budget, ten summaries at theirs, ten history turns at the message cap) as the fit leaves it',
    queryMaxed
  ),
  queryV2Case(
    'fresh',
    'one retrieved scene and no story bible: the messages are query.v1\u2019s exactly',
    queryV2Fresh
  ),
  queryV2Case(
    'full',
    'three retrieved scenes, two summaries, two history turns, and the story bible for the two characters the question names',
    queryV2Full
  ),
  queryV2Case(
    'maxed',
    'the worst input as the fit leaves it, with the story-bible block at its token budget',
    queryV2Maxed
  ),
  queryV3Case(
    'fresh',
    'one retrieved scene and no story bible: the v3 rules over query.v1\u2019s scene block',
    queryV3Fresh
  ),
  queryV3Case(
    'full',
    'three retrieved scenes, two summaries, two history turns, and the author\u2019s sheets as a citable source',
    queryV3Full
  ),
  queryV3Case(
    'maxed',
    'the worst input as the fit leaves it, with the story-bible block at the v3 budget and value cap',
    queryV3Maxed
  ),
  structureCase(
    'fixture',
    'one chunk of an imported draft: the fixture passage with two scene starts already found, against the Standard Fiction bank',
    structureChunk(IMPORT_PARAGRAPHS, 8),
    FIXTURE_BANK
  ),
  structureCase(
    'maxed',
    `a chunk at the ${IMPORT_CHUNK_WORDS}-word cap against every template name: the most one chunk of an import can cost`,
    maxedChunk(),
    MAXED_BANK
  ),
  continuityCase(
    'background',
    'the background run: the voice block, the brief, the one paragraph that states something the sheet states differently, and that one reference',
    FIXTURE_PASSAGE.split('\n\n')[4] ?? '',
    [sheetRef('personality', 'Personality', 'Never goes anywhere unarmed.')],
    null,
    BRIEF_BLOCK
  ),
  continuityCase(
    'full',
    'Check consistency on the fixture scene with the voice block and the brief: three sheet fields, a fact of another scene with its passage, and the previous scene\u2019s timeline',
    FIXTURE_PASSAGE,
    CONTINUITY_FULL_REFS,
    'The next morning',
    BRIEF_BLOCK
  ),
  continuityCase(
    'maxed',
    'the worst input as the fit leaves it: a scene at the character budget against references at their token budget',
    FIXTURE_PASSAGE.repeat(20),
    CONTINUITY_MAXED_REFS,
    'T'.repeat(500),
    MAXED_BRIEF_BLOCK
  ),
  proofreadCase(
    'fresh',
    'the fixture scene with four planted errors, no voice block, no brief, and no names: the shape a new project sends',
    { text: PROOFREAD_PASSAGE, voice: null, brief: null, keepWords: [] }
  ),
  proofreadCase(
    'full',
    'the same scene with the voice block, the brief, and the story\u2019s three names as the keep list',
    {
      text: PROOFREAD_PASSAGE,
      voice: voiceBlock(FIXTURE_PROFILE, { text: PROOFREAD_PASSAGE, pov: 'Mara' }),
      brief: BRIEF_BLOCK,
      keepWords: PROOFREAD_KEEP_WORDS
    }
  ),
  proofreadCase(
    'maxed',
    `the worst input as the fit leaves it: a scene at the character budget, the voice block and the brief at their caps, and ${PROOFREAD_KEEP_WORDS_MAX} keep words`,
    {
      text: PROOFREAD_PASSAGE.repeat(20),
      voice: voiceBlock(MAXED_PROFILE, { text: PROOFREAD_PASSAGE, pov: 'Mara' }),
      brief: MAXED_BRIEF_BLOCK,
      keepWords: PROOFREAD_MAXED_KEEP_WORDS
    }
  ),
  whatNextCase(
    'fresh',
    'the fixture scene with no brief and no story bible: the shape a new project sends',
    { text: FIXTURE_PASSAGE, brief: null, bible: null }
  ),
  whatNextCase(
    'maxed',
    'the worst input as the fit leaves it: the tail of a long scene at the character budget, the brief and the story bible at their caps',
    { text: FIXTURE_PASSAGE.repeat(20), brief: MAXED_BRIEF_BLOCK, bible: MAXED_BIBLE }
  ),
  whatNextCaseV2('fresh', 'the v1 fresh case with no scene steer', {
    text: FIXTURE_PASSAGE,
    brief: null,
    steer: null,
    bible: null
  }),
  whatNextCaseV2('full', 'the fixture scene with its brief, the scene steer, and the story bible', {
    text: FIXTURE_PASSAGE,
    brief: BRIEF_BLOCK,
    steer: FIXTURE_STEER,
    bible: FIXTURE_BIBLE
  }),
  whatNextCaseV2(
    'maxed',
    'the worst input as the fit leaves it: the tail of a long scene at the character budget, the brief, the steer, and the story bible at their caps',
    {
      text: FIXTURE_PASSAGE.repeat(20),
      brief: MAXED_BRIEF_BLOCK,
      steer: MAXED_STEER,
      bible: MAXED_BIBLE
    }
  ),
  chatCaseV5('plan fresh', 'the v4 plan fresh case with no side panel', planFreshV5, null),
  chatCaseV5(
    'plan full',
    'the v4 plan full case plus the side panel (a synopsis and the scene notes)',
    planFullV5,
    null
  ),
  chatCaseV5('agent full', 'the v4 agent full case plus the side panel', agentFullV5, null),
  chatCaseV5(
    'agent maxed',
    'every cap at its limit, the side panel at its caps too, the oldest history turns dropped to fit as the feature does',
    agentMaxedV5,
    null
  ),
  chatCaseV5(
    'agent full',
    'the agent full case with its side panel, regenerated after a tense violation',
    agentFullV5,
    VIOLATION
  ),
  chatCaseV5(
    'agent maxed',
    'the agent maxed case with its side panel and trimmed history, regenerated after a tense violation',
    agentMaxedV5,
    VIOLATION
  ),
  queryV4Case(
    'fresh',
    'one retrieved scene, no story bible, and no side panel: query.v3’s messages exactly',
    queryV4Fresh
  ),
  queryV4Case('full', 'the v3 full case plus the open scene’s side panel', queryV4Full),
  queryV4Case(
    'maxed',
    'the worst input as the fit leaves it, with the story bible at the v3 budget and the side panel at its caps',
    queryV4Maxed
  ),
  routeCase(
    'fresh',
    'a short question with no document open, no selection, and no history',
    { message: 'Who owes the mill money?', history: [], active: null, selection: null },
    'query'
  ),
  routeCase(
    'full',
    'a rewrite request over a selection in the open scene, two turns of history',
    {
      message: 'Make this tighter and colder.',
      history: CHAT_HISTORY,
      active: 'scene "The ferry landing"',
      selection: REWRITE_PASSAGE.slice(0, ROUTE_SELECTION_PREVIEW_CHARS)
    },
    'rewrite'
  ),
  routeCase(
    'maxed',
    'every cap at its limit: the message, two turns, the title, and the selection opening',
    {
      message: FIXTURE_PASSAGE.repeat(3).slice(0, ROUTE_MESSAGE_CHARS),
      history: [
        { role: 'user', content: FIXTURE_PASSAGE.slice(0, ROUTE_TURN_CHARS) },
        { role: 'assistant', content: FIXTURE_PASSAGE.slice(0, ROUTE_TURN_CHARS) }
      ],
      active: `scene "${'T'.repeat(ROUTE_TITLE_CHARS)}"`,
      selection: FIXTURE_PASSAGE.slice(0, ROUTE_SELECTION_PREVIEW_CHARS)
    },
    'chat'
  ),
  synopsisCase(
    'fresh',
    'the fixture scene with no stored summary yet: the shape a new project sends',
    { sceneText: FIXTURE_PASSAGE, summary: null }
  ),
  synopsisCase('full', 'the fixture scene with its stored summary and key points', {
    sceneText: FIXTURE_PASSAGE,
    summary: SUGGEST_SUMMARY
  }),
  synopsisCase(
    'maxed',
    'the worst input as the fit leaves it: a scene at the character budget and a summary at every cap',
    { sceneText: FIXTURE_PASSAGE.repeat(60), summary: MAXED_SUGGEST_SUMMARY }
  ),
  notesSuggestCase(
    'fresh',
    'the fixture scene with no summary, brief, notes, story bible, or focus: the shape a new project sends',
    {
      sceneText: FIXTURE_PASSAGE,
      summary: null,
      brief: null,
      notes: null,
      bible: null,
      instruction: null
    }
  ),
  notesSuggestCase(
    'full',
    'the fixture scene with its summary, brief, notes, the story bible, and a focus',
    {
      sceneText: FIXTURE_PASSAGE,
      summary: SUGGEST_SUMMARY,
      brief: BRIEF_BLOCK,
      notes: NOTES,
      bible: FIXTURE_BIBLE,
      instruction: 'What Tomas knows about the ledger.'
    }
  ),
  notesSuggestCase(
    'maxed',
    'the worst input as the fit leaves it: every block at its cap and a scene at the character budget',
    {
      sceneText: FIXTURE_PASSAGE.repeat(60),
      summary: MAXED_SUGGEST_SUMMARY,
      brief: MAXED_BRIEF_BLOCK,
      notes: `${FIXTURE_PASSAGE.repeat(2).slice(0, NOTES_SUGGEST_CURRENT_CHARS)}…`,
      bible: MAXED_BIBLE,
      instruction: 'i'.repeat(NOTES_SUGGEST_INSTRUCTION_MAX)
    }
  )
]
