import { describe, expect, it } from 'vitest'
import { estimateTokens } from '@shared/ai'
import { builtinParams } from '@shared/presets'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import { STORY_BIBLE_HEADING } from '@shared/storyBible'
import { buildChatPromptV3 } from './chat.v3'
import { buildChatPromptV4, type BuildChatPromptV4Input } from './chat.v4'

const SCENE =
  'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last.'
const BRIEF = 'Scene brief:\n- Goal: Mara wants to reach the landing before the storm.'
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara, tense.'
const STEER = `${SCENE_STEER_HEADING}\nTone: tense\nWrite in this tone.`
const META = { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF }

const general = builtinParams('general')
const plan: BuildChatPromptV4Input = {
  mode: 'plan',
  paragraphs: 1,
  sceneText: '',
  sceneMeta: null,
  brief: null,
  steer: null,
  refs: [],
  history: [],
  message: 'What is missing from this chapter?',
  voice: null,
  bible: null,
  preset: null
}
const agent: BuildChatPromptV4Input = {
  ...plan,
  mode: 'agent',
  paragraphs: 2,
  sceneText: SCENE,
  message: 'Bring Tomas onto the landing.',
  preset: general
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('chat.v4 prompt (F-5.4, F-14.3, F-14.9, F-14.13)', () => {
  it('Agent mode: the steer follows the brief and precedes the active scene, at the end of the system turn', () => {
    const input = {
      ...agent,
      voice: 'Short sentences.',
      bible: BIBLE,
      sceneMeta: META,
      brief: BRIEF
    }
    const built = buildChatPromptV4({ ...input, steer: STEER })
    expect(built.version).toBe('chat.v4')
    const v3System = buildChatPromptV3(input).messages[0]?.content ?? ''
    const scene = `Active scene:\n"""\n${SCENE}\n"""`
    expect(built.messages[0]?.content).toBe(
      v3System.replace(`${BRIEF}\n\n${scene}`, `${BRIEF}\n\n${STEER}\n\n${scene}`)
    )
    expect(built.messages[0]?.content).toContain(`${BRIEF}\n\n${STEER}\n\n${scene}`)
    expect(built.messages.slice(1)).toEqual(buildChatPromptV3(input).messages.slice(1))
  })

  it('Plan mode ignores the steer: it writes no prose', () => {
    const input = { ...plan, sceneText: SCENE, bible: BIBLE }
    expect(buildChatPromptV4({ ...input, steer: STEER }).messages).toEqual(
      buildChatPromptV3(input).messages
    )
  })

  it('is the version-3 prompt when there is no steer, in both modes', () => {
    const agentInput = {
      ...agent,
      voice: 'Short sentences; never semicolons.',
      sceneMeta: META,
      brief: BRIEF,
      bible: BIBLE,
      refs: [{ name: 'mara', notes: 'The ferryman’s daughter.' }],
      history: [{ role: 'user' as const, content: 'Earlier.' }]
    }
    const v4 = buildChatPromptV4({ ...agentInput, steer: null })
    const v3 = buildChatPromptV3(agentInput)
    expect(v4.messages).toEqual(v3.messages)
    expect(v4.maxTokens).toBe(v3.maxTokens)
    expect(v4.temperature).toBe(v3.temperature)
    expect(buildChatPromptV4(plan).messages).toEqual(buildChatPromptV3(plan).messages)
  })

  it('costs what the golden estimates say', () => {
    // A change here means the prompt changed and needs a new version.
    expect(estimateTokens(promptText(buildChatPromptV4(agent).messages))).toBe(202)
    expect(estimateTokens(promptText(buildChatPromptV4({ ...agent, steer: STEER }).messages))).toBe(
      220
    )
  })
})
