import { z } from 'zod'

/** Settings-table key under which the writing presets (F-5.2) are stored as JSON. */
export const WRITING_PRESETS_KEY = 'presets'

export const PRESET_IDS = [
  'general',
  'action',
  'suspense',
  'dialogue',
  'romance',
  'worldBuilding',
  'custom'
] as const
export const PresetId = z.enum(PRESET_IDS)
export type PresetId = z.infer<typeof PresetId>

export const TEMPERATURE_MIN = 0
export const TEMPERATURE_MAX = 1.5
/** Ghost text's own budget (F-5.3, CLAUDE.md token-efficiency rule 6) caps at 60 regardless. */
export const MAX_SUGGESTION_TOKENS_MIN = 20
export const MAX_SUGGESTION_TOKENS_MAX = 60
export const STYLE_INSTRUCTION_MAX = 300

/**
 * What a preset bundles (F-5.2): sampling temperature, the ghost-text output budget in tokens,
 * one sentence of task-specific guidance appended after the voice profile and story bible
 * (PLAN.md §2.1–2.3; it never overrides either), and whether the AI may introduce named
 * characters, places, or facts the manuscript does not have yet.
 */
export const PresetParams = z.object({
  temperature: z.number().min(TEMPERATURE_MIN).max(TEMPERATURE_MAX),
  maxSuggestionTokens: z.number().min(MAX_SUGGESTION_TOKENS_MIN).max(MAX_SUGGESTION_TOKENS_MAX),
  styleInstruction: z.string().trim().min(1).max(STYLE_INSTRUCTION_MAX),
  allowNewElements: z.boolean()
})
export type PresetParams = z.infer<typeof PresetParams>

export type BuiltinPresetId = Exclude<PresetId, 'custom'>

/** The six built-in presets; exhaustive over `BuiltinPresetId` by type. Custom stores its own params. */
export const PRESETS: Record<BuiltinPresetId, PresetParams & { label: string; blurb: string }> = {
  general: {
    label: 'General',
    blurb: 'Balanced continuation for everyday scenes.',
    temperature: 0.8,
    maxSuggestionTokens: 40,
    allowNewElements: false,
    styleInstruction:
      'Continue naturally in the established voice and pacing, balancing action, dialogue, and description.'
  },
  action: {
    label: 'Action',
    blurb: 'Short, fast sentences for high-stakes movement.',
    temperature: 0.9,
    maxSuggestionTokens: 35,
    allowNewElements: false,
    styleInstruction:
      'Favor short, punchy sentences and concrete physical detail; keep the pace fast and momentum forward.'
  },
  suspense: {
    label: 'Suspense/Mystery',
    blurb: 'Tension and withheld information; nothing resolved early.',
    temperature: 0.75,
    maxSuggestionTokens: 40,
    allowNewElements: false,
    styleInstruction:
      'Build tension through withheld information, sensory unease, and foreshadowing; do not resolve the question.'
  },
  dialogue: {
    label: 'Dialogue',
    blurb: 'Naturalistic exchange with light narration.',
    temperature: 0.85,
    maxSuggestionTokens: 45,
    allowNewElements: false,
    styleInstruction:
      'Prioritize naturalistic spoken exchange with minimal narration between lines; let subtext carry the scene.'
  },
  romance: {
    label: 'Romance',
    blurb: 'Interiority and charged subtext between characters.',
    temperature: 0.85,
    maxSuggestionTokens: 40,
    allowNewElements: false,
    styleInstruction:
      'Emphasize emotional interiority, physical awareness, and charged subtext between the characters present.'
  },
  worldBuilding: {
    label: 'World Building',
    blurb: 'Concrete world detail woven into the scene.',
    temperature: 0.7,
    maxSuggestionTokens: 50,
    allowNewElements: true,
    styleInstruction:
      'Ground the continuation in sensory, concrete world detail without stopping the scene for exposition.'
  }
}

/** Custom's accessible name and blurb, shown beside the built-ins in Settings. */
export const CUSTOM_PRESET_LABEL = 'Custom'
export const CUSTOM_PRESET_BLURB =
  'Your own instruction, temperature, length, and new-elements rule.'

/** The label of any preset id, built-in or Custom. */
export function presetLabel(id: PresetId): string {
  return id === 'custom' ? CUSTOM_PRESET_LABEL : PRESETS[id].label
}

/** The active preset and the stored Custom params, persisted per project. */
export const WritingPresets = z.object({ active: PresetId, custom: PresetParams })
export type WritingPresets = z.infer<typeof WritingPresets>

/** A built-in's params without its label and blurb. */
export function builtinParams(id: BuiltinPresetId): PresetParams {
  const { label: _label, blurb: _blurb, ...params } = PRESETS[id]
  return params
}

/** Custom starts as a copy of General's params, and General is active (spec: "custom = general's params"). */
export function defaultWritingPresets(): WritingPresets {
  return { active: 'general', custom: builtinParams('general') }
}

/** The active preset's params: the built-in's (minus label/blurb) or the stored custom object. */
export function resolvePreset(settings: WritingPresets): PresetParams {
  if (settings.active === 'custom') return settings.custom
  return builtinParams(settings.active)
}
