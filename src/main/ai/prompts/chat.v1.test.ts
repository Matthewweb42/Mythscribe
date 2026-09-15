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
import { buildChatPrompt, type BuildChatPromptInput } from './chat.v1'

const SCENE =
  'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last.'

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
const plan: BuildChatPromptInput = {
  mode: 'plan',
  paragraphs: 1,
  sceneText: '',
  sceneMeta: null,
  refs: [],
  history: [],
  message: 'What is missing from this chapter?',
  voice: null,
  preset: null
}
const agent: BuildChatPromptInput = {
  ...plan,
  mode: 'agent',
  paragraphs: 2,
  sceneText: SCENE,
  message: 'Bring Tomas onto the landing.',
  preset: general
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('chat.v1 prompt (F-5.4)', () => {
  it('Plan mode: the rules and the no-scene line system-side, the message last, the feature output cap, no temperature', () => {
    const built = buildChatPrompt(plan)
    expect(built.version).toBe('chat.v1')
    expect(built.messages).toEqual([
      { role: 'system', content: `${PLAN_RULES}\n\n${NO_SCENE}` },
      { role: 'user', content: 'What is missing from this chapter?' }
    ])
    expect(built.maxTokens).toBe(outputBudget('chat'))
    expect(built.temperature).toBeUndefined()
  })

  it('Plan mode never folds in the voice block, the preset, or the scene metadata', () => {
    const built = buildChatPrompt({
      ...plan,
      sceneText: SCENE,
      sceneMeta: { location: 'Ridge', pov: 'Mara', timeline: '' },
      voice: 'VOICE BLOCK',
      preset: general
    })
    expect(built.messages[0]?.content).toBe(`${PLAN_RULES}\n\nActive scene:\n"""\n${SCENE}\n"""`)
    expect(built.temperature).toBeUndefined()
  })

  it('places the referenced notes before the scene text, and the history turns between the system turn and the message', () => {
    const built = buildChatPrompt({
      ...plan,
      sceneText: SCENE,
      refs: [
        { name: 'mara', notes: 'The ferryman’s daughter.' },
        { name: 'ridge', notes: 'Above the landing.' }
      ],
      history: [
        { role: 'user', content: 'Who is on the ridge?' },
        { role: 'assistant', content: 'Mara, per the opening.' }
      ]
    })
    expect(built.messages).toEqual([
      {
        role: 'system',
        content:
          `${PLAN_RULES}\n\n` +
          'Referenced notes:\n#mara:\nThe ferryman’s daughter.\n\n#ridge:\nAbove the landing.\n\n' +
          `Active scene:\n"""\n${SCENE}\n"""`
      },
      { role: 'user', content: 'Who is on the ridge?' },
      { role: 'assistant', content: 'Mara, per the opening.' },
      { role: 'user', content: 'What is missing from this chapter?' }
    ])
  })

  it('Agent mode: rules, style instruction, new-elements rule, then the scene; the paragraph count leads the message; the preset temperature and a per-paragraph cap', () => {
    const built = buildChatPrompt(agent)
    expect(built.messages).toEqual([
      {
        role: 'system',
        content:
          `${AGENT_RULES} ${general.styleInstruction} ${NEW_ELEMENTS}\n\n` +
          `Active scene:\n"""\n${SCENE}\n"""`
      },
      { role: 'user', content: 'Write 2 paragraphs. Bring Tomas onto the landing.' }
    ])
    expect(built.maxTokens).toBe(2 * CHAT_TOKENS_PER_PARAGRAPH)
    expect(built.temperature).toBe(general.temperature)
    expect(buildChatPrompt({ ...agent, paragraphs: 1 }).messages.at(-1)?.content).toBe(
      'Write 1 paragraph. Bring Tomas onto the landing.'
    )
  })

  it('Agent mode places the voice block between the rules and the style instruction, and the metadata before the scene', () => {
    const built = buildChatPrompt({
      ...agent,
      voice: 'Short sentences; never semicolons.',
      sceneMeta: { location: 'Ferry landing', pov: 'Mara', timeline: '' }
    })
    expect(built.messages[0]?.content).toBe(
      `${AGENT_RULES} Short sentences; never semicolons. ${general.styleInstruction} ${NEW_ELEMENTS}\n\n` +
        'Scene: location Ferry landing, POV Mara, timeline —.\n\n' +
        `Active scene:\n"""\n${SCENE}\n"""`
    )
  })

  it('omits the new-elements rule when the preset allows new elements, and never asks for more than the chat output budget', () => {
    const world = builtinParams('worldBuilding')
    const built = buildChatPrompt({ ...agent, preset: world })
    expect(
      built.messages[0]?.content.startsWith(`${AGENT_RULES} ${world.styleInstruction}\n\n`)
    ).toBe(true)
    expect(built.temperature).toBe(world.temperature)
    expect(buildChatPrompt({ ...agent, paragraphs: CHAT_PARAGRAPHS_MAX }).maxTokens).toBe(
      Math.min(CHAT_PARAGRAPHS_MAX * CHAT_TOKENS_PER_PARAGRAPH, outputBudget('chat'))
    )
  })

  it('stays under the chat input budget with every context cap at its limit and no history', () => {
    const built = buildChatPrompt({
      ...agent,
      paragraphs: CHAT_PARAGRAPHS_MAX,
      sceneText: 's'.repeat(CHAT_SCENE_CHAR_BUDGET),
      sceneMeta: { location: 'L'.repeat(200), pov: 'P'.repeat(200), timeline: 'T'.repeat(500) },
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
    expect(estimate).toBe(4_009)
    expect(estimateTokens(promptText(buildChatPrompt(plan).messages))).toBe(109)
    expect(estimateTokens(promptText(buildChatPrompt(agent).messages))).toBe(202)
  })
})
