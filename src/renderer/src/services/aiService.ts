// src/renderer/src/services/aiService.ts

export interface AISettings {
  enabled: boolean;
  model: string;
  temperature: number;
  maxTokens: number;
  suggestionDelay: number; // milliseconds before showing suggestion
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  enabled: true,
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 100,
  suggestionDelay: 2000 // 2 seconds
};

class AIService {
  private settings: AISettings = DEFAULT_AI_SETTINGS;

  updateSettings(settings: Partial<AISettings>) {
    this.settings = { ...this.settings, ...settings };
  }

  getSettings(): AISettings {
    return { ...this.settings };
  }

  async generateSuggestion(
    currentText: string,
    context?: {
      characterNotes?: string;
      settingNotes?: string;
      worldBuildingNotes?: string;
    }
  ): Promise<string> {
    if (!this.settings.enabled) {
      return '';
    }

    try {
      // Build the prompt with context
      let systemPrompt = `You are a creative writing assistant helping an author write their novel. 
Your job is to suggest the next few words or sentence that naturally continues the story.
Keep suggestions concise (1-2 sentences max).
Match the author's tone and style.
Be creative but consistent with the established context.`;

      let userPrompt = currentText;

      // Add context if available
      if (context) {
        let contextInfo = '';
        
        if (context.characterNotes) {
          contextInfo += `\n\nCHARACTER NOTES:\n${context.characterNotes}`;
        }
        if (context.settingNotes) {
          contextInfo += `\n\nSETTING NOTES:\n${context.settingNotes}`;
        }
        if (context.worldBuildingNotes) {
          contextInfo += `\n\nWORLD-BUILDING NOTES:\n${context.worldBuildingNotes}`;
        }

        if (contextInfo) {
          systemPrompt += `\n\nUse the following context to ensure consistency:${contextInfo}`;
        }
      }

      // Use IPC to call the main process for AI generation
      const suggestion = await window.api.ai.generateSuggestion(userPrompt, context);

      return suggestion || '';
    } catch (error) {
      console.error('Error generating AI suggestion:', error);
      if (error instanceof Error) {
        throw new Error(`AI generation failed: ${error.message}`);
      }
      throw error;
    }
  }
}

// Export singleton instance
export const aiService = new AIService();
export default aiService;