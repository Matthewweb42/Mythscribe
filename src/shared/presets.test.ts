import { describe, expect, it } from 'vitest'
import {
  MAX_SUGGESTION_TOKENS_MAX,
  MAX_SUGGESTION_TOKENS_MIN,
  PRESET_IDS,
  PRESETS,
  PresetParams,
  STYLE_INSTRUCTION_MAX,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  WritingPresets,
  builtinParams,
  defaultWritingPresets,
  presetLabel,
  resolvePreset,
  type BuiltinPresetId
} from './presets'

const BUILTIN_IDS = PRESET_IDS.filter((id): id is BuiltinPresetId => id !== 'custom')

describe('PRESETS (F-5.2)', () => {
  it('has one entry per built-in id, and Custom is the only other id', () => {
    expect(Object.keys(PRESETS).sort()).toEqual([...BUILTIN_IDS].sort())
    expect(BUILTIN_IDS).toHaveLength(6)
    expect(PRESET_IDS).toHaveLength(7)
    expect(PRESET_IDS[PRESET_IDS.length - 1]).toBe('custom')
  })

  it('every built-in parses as PresetParams and stays in range, with a label and a blurb', () => {
    for (const id of BUILTIN_IDS) {
      const preset = PRESETS[id]
      expect(preset.label.length).toBeGreaterThan(0)
      expect(preset.blurb.length).toBeGreaterThan(0)
      expect(PresetParams.safeParse(builtinParams(id)).success).toBe(true)
      expect(preset.temperature).toBeGreaterThanOrEqual(TEMPERATURE_MIN)
      expect(preset.temperature).toBeLessThanOrEqual(TEMPERATURE_MAX)
      expect(preset.maxSuggestionTokens).toBeGreaterThanOrEqual(MAX_SUGGESTION_TOKENS_MIN)
      expect(preset.maxSuggestionTokens).toBeLessThanOrEqual(MAX_SUGGESTION_TOKENS_MAX)
      expect(preset.styleInstruction.trim().length).toBeGreaterThan(0)
      expect(preset.styleInstruction.length).toBeLessThanOrEqual(STYLE_INSTRUCTION_MAX)
    }
  })

  it('only World Building may introduce new elements', () => {
    for (const id of BUILTIN_IDS) {
      expect(PRESETS[id].allowNewElements).toBe(id === 'worldBuilding')
    }
  })

  it('builtinParams strips the label and blurb', () => {
    expect(Object.keys(builtinParams('action')).sort()).toEqual([
      'allowNewElements',
      'maxSuggestionTokens',
      'styleInstruction',
      'temperature'
    ])
  })

  it('presetLabel names every id', () => {
    expect(presetLabel('suspense')).toBe('Suspense/Mystery')
    expect(presetLabel('worldBuilding')).toBe('World Building')
    expect(presetLabel('custom')).toBe('Custom')
  })
})

describe('PresetParams', () => {
  it('refuses out-of-range values and a blank instruction, and trims the instruction', () => {
    const base = builtinParams('general')
    expect(PresetParams.safeParse({ ...base, temperature: -0.1 }).success).toBe(false)
    expect(PresetParams.safeParse({ ...base, temperature: 1.6 }).success).toBe(false)
    expect(PresetParams.safeParse({ ...base, maxSuggestionTokens: 19 }).success).toBe(false)
    expect(PresetParams.safeParse({ ...base, maxSuggestionTokens: 61 }).success).toBe(false)
    expect(PresetParams.safeParse({ ...base, styleInstruction: '   ' }).success).toBe(false)
    expect(
      PresetParams.safeParse({ ...base, styleInstruction: 'x'.repeat(STYLE_INSTRUCTION_MAX + 1) })
        .success
    ).toBe(false)
    expect(PresetParams.parse({ ...base, styleInstruction: '  keep it short  ' })).toEqual({
      ...base,
      styleInstruction: 'keep it short'
    })
  })
})

describe('defaultWritingPresets / resolvePreset', () => {
  it('starts on General with Custom as a copy of General', () => {
    const defaults = defaultWritingPresets()
    expect(defaults).toEqual({ active: 'general', custom: builtinParams('general') })
    expect(WritingPresets.safeParse(defaults).success).toBe(true)
    defaults.custom.temperature = 1.2
    expect(PRESETS.general.temperature).toBe(0.8) // a copy, not the shared object
  })

  it('resolves every built-in to its own params and Custom to the stored object', () => {
    for (const id of BUILTIN_IDS) {
      expect(resolvePreset({ ...defaultWritingPresets(), active: id })).toEqual(builtinParams(id))
    }
    const custom = { ...builtinParams('romance'), temperature: 1.1, styleInstruction: 'Be terse.' }
    expect(resolvePreset({ active: 'custom', custom })).toEqual(custom)
  })

  it('WritingPresets refuses an unknown id', () => {
    expect(
      WritingPresets.safeParse({ active: 'horror', custom: builtinParams('general') }).success
    ).toBe(false)
  })
})
