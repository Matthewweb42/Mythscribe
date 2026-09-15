import { GHOST_AFTER_CHARS, GHOST_BEFORE_CHARS } from '@shared/ai'
import type { VoiceProfile } from '@shared/ipc/contract'
import { builtinParams } from '@shared/presets'
import { PROPOSAL_NOTE_MAX } from '@shared/proposal'
import {
  classifyKind,
  computeStylometrics,
  renderVoiceRules,
  type Stylometrics
} from '@shared/stylometry'
import { TAG_TEMPLATES } from '@shared/tagTemplates'
import { voiceConfidence, VOICE_EXEMPLAR_TEXT_MAX } from '@shared/voice'
import { voiceBlock } from '../../voice/voiceBlock'
import type { AiMessage } from '../providers/types'
import type { PromptVersion } from '../prompts/catalogue'
import {
  buildGhostTextPrompt,
  GHOST_NOTES_CHAR_CAP,
  GHOST_PROMPT_VERSION,
  type BuildGhostTextPromptInput
} from '../prompts/ghostText.v1'
import { buildGhostTextRegenPrompt, GHOST_REGEN_PROMPT_VERSION } from '../prompts/ghostTextRegen.v1'
import { buildTagsPrompt, TAGS_PROMPT_VERSION, TAGS_TEXT_CHAR_BUDGET } from '../prompts/tags.v1'
import { buildTagsRegenPrompt, TAGS_REGEN_PROMPT_VERSION } from '../prompts/tagsRegen.v1'

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

/** The profile a project holding `FIXTURE_PASSAGE` with its opening marked as an exemplar has. */
export const FIXTURE_PROFILE: VoiceProfile = {
  rules: renderVoiceRules(FIXTURE_STATS),
  stats: FIXTURE_STATS,
  exemplars: [exemplar('ex-1', FIXTURE_PASSAGE.split('\n\n').slice(0, 5).join('\n\n'))],
  confidence: voiceConfidence(FIXTURE_STATS.wordCount, 1),
  wordCount: FIXTURE_STATS.wordCount
}

/** The same profile at the exemplar ceiling: three exemplars at the maximum length, so the voice block hits its budget. */
const MAXED_PROFILE: VoiceProfile = {
  ...FIXTURE_PROFILE,
  exemplars: [1, 2, 3].map((n) =>
    exemplar(`ex-${n}`, FIXTURE_PASSAGE.repeat(3).slice(0, VOICE_EXEMPLAR_TEXT_MAX))
  ),
  confidence: voiceConfidence(FIXTURE_STATS.wordCount, 3)
}

/** The last `GHOST_BEFORE_CHARS` of the passage, minus its final sentence, as the caret window. */
const CARET_BEFORE = FIXTURE_PASSAGE.slice(0, FIXTURE_PASSAGE.lastIndexOf('\n\n')).slice(
  -GHOST_BEFORE_CHARS
)
const CARET_AFTER = 'She did not wait to see his face.'
const NOTES = 'Mara confronts Tomas at the ferry. Ends with the reveal about the elm.'
const META = { location: 'Ferry landing', pov: 'Mara', timeline: 'Night, first thaw' }

/** The Standard Fiction template names: the bank a new project loads first. */
export const FIXTURE_BANK: string[] = (TAG_TEMPLATES[0]?.tags ?? []).map((tag) => tag.name)
/** Every template's names, deduplicated: the largest bank the templates alone produce. */
const MAXED_BANK: string[] = [
  ...new Set(TAG_TEMPLATES.flatMap((t) => t.tags.map((tag) => tag.name)))
]

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
  )
]
