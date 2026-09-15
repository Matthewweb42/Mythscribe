import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import {
  CHAT_MESSAGE_MAX,
  CHAT_PARAGRAPHS_MAX,
  CHAT_REF_NOTES_CHAR_BUDGET,
  CHAT_SCENE_CHAR_BUDGET,
  CHAT_TOKENS_PER_PARAGRAPH
} from '@shared/chat'
import { builtinParams } from '@shared/presets'
import { EMPTY_SCENE_BRIEF, SCENE_BRIEF_FIELD_MAX } from '@shared/sceneMeta'
import { buildChatPromptV2, type BuildChatPromptV2Input } from './chat.v2'

const SCENE =
  'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last.'
const BRIEF = [
  'Scene brief:',
  '- Goal: Mara wants to reach the landing before the storm.',
  "Next scene's goal: Tomas counts what the mill owes."
].join('\n')

const PLAN_RULES =
  'You are the assistant inside a novel-writing app, talking with the author about their ' +
  'manuscript. Answer the question or request in plain prose, briefly. When the active scene ' +
  'below grounds your answer, quote or point to the passage you rely on; when it does not, ' +
  'say so instead of guessing. Do not write manuscript prose unless asked.'
const AGENT_RULES =
  'You are drafting inside a novel-writing app. Write exactly the number of paragraphs asked ' +
  "for, continuing the active scene at the author's cursor, in the same voice, tense, and " +
  'person as the scene, following the instruction. Reply with the prose only: no headings, no ' +
  'notes, no preamble, and no quotation marks around the answer. Separate paragraphs with a ' +
  'blank line.'
const NEW_ELEMENTS =
  'Do not introduce any new named character, place, or plot fact that the scene or the ' +
  'context below does not already establish.'
const NO_SCENE = 'No scene is open; the author is working outside the manuscript.'

const general = builtinParams('general')
const plan: BuildChatPromptV2Input = {
  mode: 'plan',
  paragraphs: 1,
  sceneText: '',
  sceneMeta: null,
  brief: null,
  refs: [],
  history: [],
  message: 'What is missing from this chapter?',
  voice: null,
  preset: null
}
const agent: BuildChatPromptV2Input = {
  ...plan,
  mode: 'agent',
  paragraphs: 2,
  sceneText: SCENE,
  message: 'Bring Tomas onto the landing.',
  preset: general
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('chat.v2 prompt (F-5.4, F-14.3)', () => {
  it('Plan mode: the rules and the no-scene line system-side, the message last, the feature output cap, no temperature', () => {
    const built = buildChatPromptV2(plan)
    expect(built.version).toBe('chat.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: `${PLAN_RULES}\n\n${NO_SCENE}` },
      { role: 'user', content: 'What is missing from this chapter?' }
    ])
    expect(built.maxTokens).toBe(outputBudget('chat'))
    expect(built.temperature).toBeUndefined()
  })

  it('Plan mode never folds in the voice block, the preset, the scene metadata, or the brief', () => {
    const built = buildChatPromptV2({
      ...plan,
      sceneText: SCENE,
      sceneMeta: { location: 'Ridge', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
      brief: BRIEF,
      voice: 'VOICE BLOCK',
      preset: general
    })
    expect(built.messages[0]?.content).toBe(`${PLAN_RULES}\n\nActive scene:\n"""\n${SCENE}\n"""`)
    expect(built.temperature).toBeUndefined()
  })

  it('Agent mode puts the brief right after the metadata line and before the scene', () => {
    const built = buildChatPromptV2({
      ...agent,
      voice: 'Short sentences; never semicolons.',
      sceneMeta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
      brief: BRIEF
    })
    expect(built.messages[0]?.content).toBe(
      `${AGENT_RULES} Short sentences; never semicolons. ${general.styleInstruction} ${NEW_ELEMENTS}\n\n` +
        'Scene: location Ferry landing, POV Mara, timeline —.\n\n' +
        `${BRIEF}\n\n` +
        `Active scene:\n"""\n${SCENE}\n"""`
    )
  })

  it('Agent mode carries the brief with no metadata, and neither when there is none', () => {
    expect(buildChatPromptV2({ ...agent, brief: BRIEF }).messages[0]?.content).toBe(
      `${AGENT_RULES} ${general.styleInstruction} ${NEW_ELEMENTS}\n\n` +
        `${BRIEF}\n\nActive scene:\n"""\n${SCENE}\n"""`
    )
    expect(buildChatPromptV2(agent).messages[0]?.content).toBe(
      `${AGENT_RULES} ${general.styleInstruction} ${NEW_ELEMENTS}\n\n` +
        `Active scene:\n"""\n${SCENE}\n"""`
    )
  })

  it('keeps version 1’s other placements: the references first, the history between the system turn and the message, the paragraph count leading it', () => {
    const built = buildChatPromptV2({
      ...agent,
      refs: [{ name: 'mara', notes: 'The ferryman’s daughter.' }],
      brief: BRIEF,
      history: [{ role: 'user', content: 'Who is on the ridge?' }]
    })
    expect(built.messages).toEqual([
      {
        role: 'system',
        content:
          `${AGENT_RULES} ${general.styleInstruction} ${NEW_ELEMENTS}\n\n` +
          'Referenced notes:\n#mara:\nThe ferryman’s daughter.\n\n' +
          `${BRIEF}\n\nActive scene:\n"""\n${SCENE}\n"""`
      },
      { role: 'user', content: 'Who is on the ridge?' },
      { role: 'user', content: 'Write 2 paragraphs. Bring Tomas onto the landing.' }
    ])
    expect(built.maxTokens).toBe(2 * CHAT_TOKENS_PER_PARAGRAPH)
    expect(built.temperature).toBe(general.temperature)
  })

  it('stays under the chat input budget with every context cap at its limit, the brief included, and no history', () => {
    const built = buildChatPromptV2({
      ...agent,
      paragraphs: CHAT_PARAGRAPHS_MAX,
      sceneText: 's'.repeat(CHAT_SCENE_CHAR_BUDGET),
      sceneMeta: {
        location: 'L'.repeat(200),
        pov: 'P'.repeat(200),
        timeline: 'T'.repeat(500),
        brief: EMPTY_SCENE_BRIEF
      },
      brief: ['g', 'c', 't', 'b', 'a', 'p', 'n']
        .map((c) => c.repeat(SCENE_BRIEF_FIELD_MAX + 30))
        .join('\n'),
      refs: [1, 2, 3, 4].map((n) => ({
        name: `ref-${n}`,
        notes: 'n'.repeat(CHAT_REF_NOTES_CHAR_BUDGET / 4)
      })),
      message: 'm'.repeat(CHAT_MESSAGE_MAX),
      voice: 'v'.repeat(2_400)
    })
    const estimate = estimateTokens(promptText(built.messages))
    expect(estimate).toBeLessThan(inputBudget('chat'))
    // The golden estimates: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(4_414)
    expect(estimateTokens(promptText(buildChatPromptV2(plan).messages))).toBe(109)
    expect(estimateTokens(promptText(buildChatPromptV2(agent).messages))).toBe(202)
  })
})
