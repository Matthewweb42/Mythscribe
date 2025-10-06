// src/shared/aiPresets.ts
// AI Writing Presets Configuration

export interface AIPreset {
  id: string;
  name: string;
  description: string;
  temperature: number; // 0.0-1.0, controls creativity
  maxTokens: number; // Max length of suggestions
  systemPromptAddition: string; // Additional instructions for the AI
  introduceNewElements: boolean; // Whether AI can add new plot elements
}

export const BUILT_IN_PRESETS: Record<string, AIPreset> = {
  general: {
    id: 'general',
    name: 'General Writing',
    description: 'Balanced suggestions for all types of writing',
    temperature: 0.7,
    maxTokens: 50,
    systemPromptAddition: 'Maintain a natural flow and match the author\'s established style.',
    introduceNewElements: true
  },

  action: {
    id: 'action',
    name: 'Action Scene',
    description: 'Fast-paced, visceral action sequences',
    temperature: 0.8,
    maxTokens: 40,
    systemPromptAddition: 'Write with short, punchy sentences. Focus on movement, physical sensations, and immediate reactions. Keep the pace quick and intense. Use active verbs.',
    introduceNewElements: true
  },

  suspense: {
    id: 'suspense',
    name: 'Suspense/Mystery',
    description: 'Atmospheric tension and slow reveals',
    temperature: 0.75,
    maxTokens: 60,
    systemPromptAddition: 'Build tension through atmosphere and subtle details. Use sensory descriptions. Hint at things without revealing too much. Create unease through pacing and word choice.',
    introduceNewElements: false
  },

  dialogue: {
    id: 'dialogue',
    name: 'Dialogue Heavy',
    description: 'Natural conversation and character voice',
    temperature: 0.8,
    maxTokens: 45,
    systemPromptAddition: 'Focus on natural, character-specific dialogue. Include realistic speech patterns, interruptions, and subtext. Keep dialogue tags simple. Show personality through word choice and rhythm.',
    introduceNewElements: false
  },

  romance: {
    id: 'romance',
    name: 'Romance',
    description: 'Emotional and sensory romantic moments',
    temperature: 0.75,
    maxTokens: 55,
    systemPromptAddition: 'Emphasize emotional interiority and physical sensations. Use sensory details—touch, warmth, proximity. Focus on character feelings and chemistry. Write with emotional depth.',
    introduceNewElements: false
  },

  worldbuilding: {
    id: 'worldbuilding',
    name: 'World Building',
    description: 'Descriptive, expansive setting detail',
    temperature: 0.7,
    maxTokens: 70,
    systemPromptAddition: 'Provide rich, immersive descriptions of the world. Include cultural details, environmental elements, and atmospheric texture. Build the setting naturally into the narrative.',
    introduceNewElements: true
  },

  custom: {
    id: 'custom',
    name: 'Custom',
    description: 'Your personalized settings',
    temperature: 0.7,
    maxTokens: 50,
    systemPromptAddition: '',
    introduceNewElements: true
  }
};

export interface CustomAISettings {
  activePresetId: string;
  customInstructions: string;
  customTemperature: number;
  customMaxTokens: number;
  customIntroduceNewElements: boolean;
}

export const DEFAULT_CUSTOM_SETTINGS: CustomAISettings = {
  activePresetId: 'general',
  customInstructions: '',
  customTemperature: 0.7,
  customMaxTokens: 50,
  customIntroduceNewElements: true
};

// Helper to get active preset settings
export function getActivePresetSettings(settings: CustomAISettings): AIPreset {
  const preset = BUILT_IN_PRESETS[settings.activePresetId];

  if (!preset) {
    return BUILT_IN_PRESETS.general;
  }

  // If custom preset, use custom values
  if (settings.activePresetId === 'custom') {
    return {
      ...preset,
      temperature: settings.customTemperature,
      maxTokens: settings.customMaxTokens,
      systemPromptAddition: settings.customInstructions,
      introduceNewElements: settings.customIntroduceNewElements
    };
  }

  return preset;
}
