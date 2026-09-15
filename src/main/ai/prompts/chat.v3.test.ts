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
import { STORY_BIBLE_HEADING, STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import { buildChatPromptV2 } from './chat.v2'
import { buildChatPromptV3, type BuildChatPromptV3Input } from './chat.v3'

const SCENE =
  'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last.'
const BRIEF = [
  'Scene brief:',
  '- Goal: Mara wants to reach the landing before the storm.',
  "Next scene's goal: Tomas counts what the mill owes."
].join('\n')
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'

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
const plan: BuildChatPromptV3Input = {
  mode: 'plan',
  paragraphs: 1,
  sceneText: '',
  sceneMeta: null,
  brief: null,
  refs: [],
  history: [],
  message: 'What is missing from this chapter?',
  voice: null,
  bible: null,
  preset: null
}
const agent: BuildChatPromptV3Input = {
  ...plan,
  mode: 'agent',
  paragraphs: 2,
  sceneText: SCENE,
  message: 'Bring Tomas onto the landing.',
  preset: general
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('chat.v3 prompt (F-5.4, F-14.3, F-14.9)', () => {
  it('Plan mode: the rules and the no-scene line system-side, the message last, the feature output cap, no temperature', () => {
    const built = buildChatPromptV3(plan)
    expect(built.version).toBe('chat.v3')
    expect(built.messages).toEqual([
      { role: 'system', content: `${PLAN_RULES}\n\n${NO_SCENE}` },
      { role: 'user', content: 'What is missing from this chapter?' }
    ])
    expect(built.maxTokens).toBe(outputBudget('chat'))
    expect(built.temperature).toBeUndefined()
  })

  it('Plan mode never folds in the voice block, the preset, the scene metadata, or the brief', () => {
    const built = buildChatPromptV3({
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

  it('Plan mode does send the story bible, between the rules and the context', () => {
    const built = buildChatPromptV3({ ...plan, sceneText: SCENE, bible: BIBLE })
    expect(built.messages[0]?.content).toBe(
      `${PLAN_RULES}\n\n${BIBLE}\n\nActive scene:\n"""\n${SCENE}\n"""`
    )
  })

  it('Agent mode: the voice block and the preset, then the bible, then the metadata, the brief, and the scene', () => {
    const built = buildChatPromptV3({
      ...agent,
      voice: 'Short sentences; never semicolons.',
      bible: BIBLE,
      sceneMeta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
      brief: BRIEF
    })
    expect(built.messages[0]?.content).toBe(
      `${AGENT_RULES} Short sentences; never semicolons. ${general.styleInstruction} ${NEW_ELEMENTS}\n\n` +
        `${BIBLE}\n\n` +
        'Scene: location Ferry landing, POV Mara, timeline —.\n\n' +
        `${BRIEF}\n\n` +
        `Active scene:\n"""\n${SCENE}\n"""`
    )
  })

  it('is the version-2 prompt when there is no bible, in both modes', () => {
    const agentInput = {
      ...agent,
      voice: 'Short sentences; never semicolons.',
      sceneMeta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
      brief: BRIEF,
      refs: [{ name: 'mara', notes: 'The ferryman’s daughter.' }],
      history: [{ role: 'user' as const, content: 'Earlier.' }]
    }
    expect(buildChatPromptV3({ ...agentInput, bible: null }).messages).toEqual(
      buildChatPromptV2(agentInput).messages
    )
    expect(buildChatPromptV3(plan).messages).toEqual(buildChatPromptV2(plan).messages)
  })

  it('keeps version 2’s other placements: the references first, the history between the system turn and the message, the paragraph count leading it', () => {
    const built = buildChatPromptV3({
      ...agent,
      refs: [{ name: 'mara', notes: 'The ferryman’s daughter.' }],
      brief: BRIEF,
      bible: BIBLE,
      history: [{ role: 'user', content: 'Who is on the ridge?' }]
    })
    expect(built.messages).toEqual([
      {
        role: 'system',
        content:
          `${AGENT_RULES} ${general.styleInstruction} ${NEW_ELEMENTS}\n\n${BIBLE}\n\n` +
          'Referenced notes:\n#mara:\nThe ferryman’s daughter.\n\n' +
          `${BRIEF}\n\nActive scene:\n"""\n${SCENE}\n"""`
      },
      { role: 'user', content: 'Who is on the ridge?' },
      { role: 'user', content: 'Write 2 paragraphs. Bring Tomas onto the landing.' }
    ])
    expect(built.maxTokens).toBe(2 * CHAT_TOKENS_PER_PARAGRAPH)
    expect(built.temperature).toBe(general.temperature)
  })

  it('stays under the chat input budget with every context cap at its limit, the brief and the bible included, and no history', () => {
    const maxed: BuildChatPromptV3Input = {
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
      voice: 'v'.repeat(2_400),
      bible: 'g'.repeat(STORY_BIBLE_TOKEN_BUDGET * 4)
    }
    const estimate = estimateTokens(promptText(buildChatPromptV3(maxed).messages))
    expect(estimate).toBeLessThan(inputBudget('chat'))
    // The golden estimates: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(4_814)
    expect(estimateTokens(promptText(buildChatPromptV3({ ...maxed, bible: null }).messages))).toBe(
      4_414
    )
    expect(estimateTokens(promptText(buildChatPromptV3(plan).messages))).toBe(109)
    expect(estimateTokens(promptText(buildChatPromptV3(agent).messages))).toBe(202)
  })
})
