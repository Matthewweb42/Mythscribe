import { GHOST_AFTER_CHARS, GHOST_BEFORE_CHARS } from '@shared/ai'
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
  CRITIQUE_NOTES_CHAR_CAP,
  CRITIQUE_SCENE_CHAR_BUDGET,
  DEFAULT_HONESTY
} from '@shared/critique'
import type { VoiceProfile } from '@shared/ipc/contract'
import { builtinParams } from '@shared/presets'
import { PROPOSAL_NOTE_MAX } from '@shared/proposal'
import { REWRITE_CONTEXT_CHARS, REWRITE_TEXT_MAX } from '@shared/rewrite'
import {
  renderStoryBible,
  STORY_BIBLE_CATEGORIES,
  STORY_BIBLE_GHOST_TOKEN_BUDGET,
  STORY_BIBLE_TOKEN_BUDGET,
  type StoryBibleCategory,
  type StoryBibleFacts
} from '@shared/storyBible'
import {
  classifyKind,
  computeStylometrics,
  renderVoiceRules,
  type Stylometrics
} from '@shared/stylometry'
import type { TagCategory } from '@shared/tags'
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
import { buildTagsPrompt, TAGS_PROMPT_VERSION, TAGS_TEXT_CHAR_BUDGET } from '../prompts/tags.v1'
import { buildTagsRegenPrompt, TAGS_REGEN_PROMPT_VERSION } from '../prompts/tagsRegen.v1'
import {
  BRIEF_SCENE_CHAR_BUDGET,
  EMPTY_SCENE_BRIEF,
  renderSceneBriefBlock,
  SCENE_BRIEF_FIELD_MAX,
  type SceneBrief
} from '@shared/sceneMeta'

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
  previous: {
    title: 'The mill ledger',
    location: 'The mill',
    pov: 'Mara',
    timeline: 'Two days before'
  },
  next: { title: 'The north pasture', location: 'North pasture', pov: 'Mara', timeline: 'Dawn' }
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
    timeline: 'Two days before the thaw'
  },
  next: {
    title: 'The north pasture, under the elm',
    location: 'The north pasture',
    pov: 'Tomas',
    timeline: 'Dawn after the thaw'
  }
}

/** The bible a full request carries, per budget: the chat/critique/rewrite one and the ghost one. */
export const FIXTURE_BIBLE = renderStoryBible(FIXTURE_FACTS, STORY_BIBLE_TOKEN_BUDGET)
const FIXTURE_GHOST_BIBLE = renderStoryBible(FIXTURE_FACTS, STORY_BIBLE_GHOST_TOKEN_BUDGET)
/** The bible at each budget: the renderer cuts the category lines to fit, so these are the caps. */
const MAXED_BIBLE = renderStoryBible(MAXED_FACTS, STORY_BIBLE_TOKEN_BUDGET)
const MAXED_GHOST_BIBLE = renderStoryBible(MAXED_FACTS, STORY_BIBLE_GHOST_TOKEN_BUDGET)

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

/** Every case, grouped by version in catalogue order. */
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
  )
]
