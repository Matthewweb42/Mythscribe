// src/main/ipcHandlers.ts
import { ipcMain, dialog, app } from 'electron';
import path from 'path';
import ProjectDatabase from './database';
import OpenAI from 'openai';
import { getActivePresetSettings, DEFAULT_CUSTOM_SETTINGS, CustomAISettings } from '../shared/aiPresets';

let currentDb: ProjectDatabase | null = null;
let openaiClient: OpenAI | null = null;

// Initialize OpenAI client
function initializeOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey && !openaiClient) {
    openaiClient = new OpenAI({ apiKey });
    console.log('OpenAI client initialized in main process');
  }
}

export function setupIpcHandlers() {
  // ============= PROJECT OPERATIONS =============

  ipcMain.handle('project:create', async (_, projectName: string, format: 'novel' | 'epic' | 'webnovel' = 'novel') => {
    try {
      const { filePath } = await dialog.showSaveDialog({
        title: 'Create New Project',
        defaultPath: path.join(app.getPath('documents'), 'Mythscribe', `${projectName}.mythscribe`),
        filters: [{ name: 'Mythscribe Project', extensions: ['mythscribe'] }],
        properties: ['createDirectory']
      });

      if (!filePath) return null;

      // Close existing database if any
      if (currentDb) {
        currentDb.close();
      }

      // Create new database
      currentDb = new ProjectDatabase(filePath);
      const projectId = currentDb.createProject(projectName, format);

      return { projectId, projectPath: filePath };
    } catch (error) {
      console.error('Error creating project:', error);
      throw error;
    }
  });

  ipcMain.handle('project:open', async () => {
    try {
      const { filePaths } = await dialog.showOpenDialog({
        title: 'Open Project',
        filters: [{ name: 'Mythscribe Project', extensions: ['mythscribe'] }],
        properties: ['openFile']
      });

      if (!filePaths || filePaths.length === 0) return null;

      // Close existing database if any
      if (currentDb) {
        currentDb.close();
      }

      // Open database
      currentDb = new ProjectDatabase(filePaths[0]);
      currentDb.updateLastOpened();

      // Seed tag templates if they don't exist (for existing projects)
      currentDb.seedDefaultTagTemplates();

      const metadata = currentDb.getProjectMetadata();
      return { metadata, projectPath: filePaths[0] };
    } catch (error) {
      console.error('Error opening project:', error);
      throw error;
    }
  });

  ipcMain.handle('project:getMetadata', async () => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getProjectMetadata();
  });

  ipcMain.handle('project:close', async () => {
    if (currentDb) {
      currentDb.close();
      currentDb = null;
    }
  });

  // ============= DOCUMENT OPERATIONS =============

  ipcMain.handle('document:create', async (_, name: string, parentId: string | null, docType: 'manuscript' | 'note', hierarchyLevel?: 'novel' | 'part' | 'chapter' | 'scene' | null) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.createDocument(name, parentId, docType, hierarchyLevel || null);
  });

  ipcMain.handle('folder:create', async (_, name: string, parentId: string | null, hierarchyLevel?: 'novel' | 'part' | 'chapter' | null) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.createFolder(name, parentId, hierarchyLevel || null);
  });

  ipcMain.handle('document:get', async (_, id: string) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getDocument(id);
  });

  ipcMain.handle('document:getByParent', async (_, parentId: string | null) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getDocumentsByParent(parentId);
  });

  ipcMain.handle('document:getAll', async () => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getAllDocuments();
  });

  ipcMain.handle('document:updateContent', async (_, id: string, content: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.updateDocumentContent(id, content);
  });

  ipcMain.handle('document:updateName', async (_, id: string, name: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.updateDocumentName(id, name);
  });

  ipcMain.handle('document:updateNotes', async (_, id: string, notes: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.updateDocumentNotes(id, notes);
  });

  ipcMain.handle('document:updateWordCount', async (_, id: string, wordCount: number) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.updateDocumentWordCount(id, wordCount);
  });

  ipcMain.handle('document:delete', async (_, id: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.deleteDocument(id);
  });

  ipcMain.handle('document:move', async (_, id: string, newParentId: string | null, newPosition: number) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.moveDocument(id, newParentId, newPosition);
  });

  ipcMain.handle('document:updateMetadata', async (_, id: string, location: string | null, pov: string | null, timelinePosition: string | null) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.updateDocumentMetadata(id, location, pov, timelinePosition);
  });

  ipcMain.handle('document:getMetadata', async (_, id: string) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getDocumentMetadata(id);
  });

  // ============= REFERENCE OPERATIONS =============

  ipcMain.handle('reference:create', async (_, name: string, category: 'character' | 'setting' | 'worldBuilding', content: string) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.createReference(name, category, content);
  });

  ipcMain.handle('reference:get', async (_, id: string) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getReference(id);
  });

  ipcMain.handle('reference:getByCategory', async (_, category: 'character' | 'setting' | 'worldBuilding') => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getReferencesByCategory(category);
  });

  ipcMain.handle('reference:getAll', async () => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getAllReferences();
  });

  ipcMain.handle('reference:update', async (_, id: string, content: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.updateReference(id, content);
  });

  ipcMain.handle('reference:updateName', async (_, id: string, name: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.updateReferenceName(id, name);
  });

  ipcMain.handle('reference:delete', async (_, id: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.deleteReference(id);
  });

  // ============= SETTINGS OPERATIONS =============

  ipcMain.handle('settings:get', async (_, key: string) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getSetting(key);
  });

  ipcMain.handle('settings:set', async (_, key: string, value: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.setSetting(key, value);
  });

  // ============= TAG OPERATIONS =============

  ipcMain.handle('tag:create', async (_, name: string, category: 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom' | null, color?: string, parentTagId?: string | null) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.createTag(name, category, color, parentTagId);
  });

  ipcMain.handle('tag:get', async (_, id: string) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getTag(id);
  });

  ipcMain.handle('tag:getAll', async () => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getAllTags();
  });

  ipcMain.handle('tag:getByCategory', async (_, category: 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom') => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getTagsByCategory(category);
  });

  ipcMain.handle('tag:update', async (_, id: string, name: string, color: string, category: 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom' | null) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.updateTag(id, name, color, category);
  });

  ipcMain.handle('tag:delete', async (_, id: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.deleteTag(id);
  });

  ipcMain.handle('tag:incrementUsage', async (_, id: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.incrementTagUsage(id);
  });

  ipcMain.handle('tagTemplate:create', async (_, name: string, tagsJson: string, isGlobal?: boolean) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.createTagTemplate(name, tagsJson, isGlobal);
  });

  ipcMain.handle('tagTemplate:getAll', async () => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getAllTagTemplates();
  });

  ipcMain.handle('tagTemplate:delete', async (_, id: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.deleteTagTemplate(id);
  });

  // ============= DOCUMENT-TAG OPERATIONS =============

  ipcMain.handle('documentTag:add', async (_, documentId: string, tagId: string, positionStart?: number | null, positionEnd?: number | null) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.addTagToDocument(documentId, tagId, positionStart, positionEnd);
  });

  ipcMain.handle('documentTag:remove', async (_, documentId: string, tagId: string) => {
    if (!currentDb) throw new Error('No project open');
    currentDb.removeTagFromDocument(documentId, tagId);
  });

  ipcMain.handle('documentTag:getForDocument', async (_, documentId: string) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getDocumentTags(documentId);
  });

  ipcMain.handle('documentTag:getDocumentsByTag', async (_, tagId: string) => {
    if (!currentDb) throw new Error('No project open');
    return currentDb.getDocumentsByTag(tagId);
  });

  // ============= AI OPERATIONS =============

  // Rate limiting for AI requests
  let lastAIRequestTime = 0;
  const MIN_REQUEST_INTERVAL = 2000; // 2 seconds between requests

  ipcMain.handle('ai:generate-suggestion', async (_, recentText: string, context?: {
    characterNotes?: string;
    settingNotes?: string;
    worldBuildingNotes?: string;
  }) => {
    try {
      // Rate limiting check
      const now = Date.now();
      const timeSinceLastRequest = now - lastAIRequestTime;
      
      if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
        console.log(`⏳ Rate limiting: waiting ${waitTime}ms before making request`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      
      lastAIRequestTime = Date.now();

      // Initialize OpenAI if not already done
      if (!openaiClient) {
        initializeOpenAI();
      }
      
      if (!openaiClient) {
        throw new Error('OpenAI API key not found in environment variables');
      }

      // Validate API key format
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey || !apiKey.startsWith('sk-')) {
        throw new Error('Invalid OpenAI API key format. Key should start with "sk-"');
      }

      // Load preset settings from database
      const presetSettings: CustomAISettings = {
        activePresetId: currentDb?.getSetting('ai_preset_id') || DEFAULT_CUSTOM_SETTINGS.activePresetId,
        customInstructions: currentDb?.getSetting('ai_custom_instructions') || DEFAULT_CUSTOM_SETTINGS.customInstructions,
        customTemperature: parseFloat(currentDb?.getSetting('ai_custom_temperature') || String(DEFAULT_CUSTOM_SETTINGS.customTemperature)),
        customMaxTokens: parseInt(currentDb?.getSetting('ai_custom_max_tokens') || String(DEFAULT_CUSTOM_SETTINGS.customMaxTokens)),
        customIntroduceNewElements: currentDb?.getSetting('ai_custom_introduce_new_elements') === 'true' || DEFAULT_CUSTOM_SETTINGS.customIntroduceNewElements
      };

      const activePreset = getActivePresetSettings(presetSettings);

      // Build the prompt with context and preset instructions
      let systemPrompt = `You are a creative writing assistant helping an author write their novel.
Your job is to suggest the next few words or sentence that naturally continues the story.
Keep suggestions concise (1-2 sentences max).
Match the author's tone and style.
Be creative but consistent with the established context.

${activePreset.systemPromptAddition}

${!activePreset.introduceNewElements ? 'IMPORTANT: Do not introduce new plot elements, characters, or locations. Only continue with what has been established.' : ''}`;

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

      console.log('🤖 Making OpenAI API call from main process...');
      console.log('📝 Request text length:', recentText.length);
      console.log('🎨 Using preset:', activePreset.name);
      console.log('🌡️ Temperature:', activePreset.temperature);
      console.log('📏 Max tokens:', activePreset.maxTokens);

      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Continue this text naturally:\n\n${recentText}` }
        ],
        temperature: activePreset.temperature,
        max_tokens: activePreset.maxTokens,
        stream: false
      });

      const suggestion = response.choices[0]?.message?.content?.trim() || '';
      console.log('✅ OpenAI suggestion received:', suggestion);
      return suggestion;
    } catch (error) {
      console.error('❌ OpenAI API error:', error);
      
      // Handle specific error types
      if (error instanceof Error) {
        if (error.message.includes('429')) {
          throw new Error('Rate limit exceeded. Please wait a moment before trying again. If you have a new OpenAI account, you may have lower rate limits.');
        } else if (error.message.includes('401')) {
          throw new Error('Invalid API key. Please check your OpenAI API key in the .env file.');
        } else if (error.message.includes('quota')) {
          throw new Error('OpenAI quota exceeded. Please check your OpenAI account billing and usage at https://platform.openai.com/usage');
        }
      }
      
      throw new Error(`AI generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  });

  // Test API key functionality
  ipcMain.handle('ai:test-api-key', async () => {
    try {
      if (!openaiClient) {
        initializeOpenAI();
      }
      
      if (!openaiClient) {
        throw new Error('OpenAI API key not found in environment variables');
      }

      console.log('🧪 Testing OpenAI API key...');
      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Say "API key is working" in exactly those words.' }],
        max_tokens: 10,
        temperature: 0
      });

      const result = response.choices[0]?.message?.content?.trim() || '';
      console.log('✅ API key test successful:', result);
      return { success: true, message: 'API key is working correctly' };
    } catch (error) {
      console.error('❌ API key test failed:', error);
      let errorMessage = 'Unknown error';
      
      if (error instanceof Error) {
        if (error.message.includes('429')) {
          errorMessage = 'Rate limit exceeded. Your API key works but you\'re making requests too quickly.';
        } else if (error.message.includes('401')) {
          errorMessage = 'Invalid API key. Please check your OpenAI API key.';
        } else if (error.message.includes('quota')) {
          errorMessage = 'Quota exceeded. Check your OpenAI billing at https://platform.openai.com/usage';
        } else {
          errorMessage = error.message;
        }
      }
      
      return { success: false, message: errorMessage };
    }
  });

  // Directed AI generation (from AI Assistant Panel)
  ipcMain.handle('ai:generate-directed', async (_, params: {
    instruction: string;
    paragraphCount: number;
    conversationHistory?: Array<{ role: string; content: string }>;
    referencedNotes?: string;
  }) => {
    try {
      if (!openaiClient) {
        initializeOpenAI();
      }

      if (!openaiClient) {
        throw new Error('OpenAI API key not found in environment variables');
      }

      // Load preset settings
      const presetSettings: CustomAISettings = {
        activePresetId: currentDb?.getSetting('ai_preset_id') || DEFAULT_CUSTOM_SETTINGS.activePresetId,
        customInstructions: currentDb?.getSetting('ai_custom_instructions') || DEFAULT_CUSTOM_SETTINGS.customInstructions,
        customTemperature: parseFloat(currentDb?.getSetting('ai_custom_temperature') || String(DEFAULT_CUSTOM_SETTINGS.customTemperature)),
        customMaxTokens: parseInt(currentDb?.getSetting('ai_custom_max_tokens') || String(DEFAULT_CUSTOM_SETTINGS.customMaxTokens)),
        customIntroduceNewElements: currentDb?.getSetting('ai_custom_introduce_new_elements') === 'true' || DEFAULT_CUSTOM_SETTINGS.customIntroduceNewElements
      };

      const activePreset = getActivePresetSettings(presetSettings);

      // Build system prompt for directed generation
      let systemPrompt = `You are a creative writing assistant helping an author write their novel.
The author will give you specific instructions about what should happen next in the story.
Your job is to write ${params.paragraphCount} paragraph${params.paragraphCount > 1 ? 's' : ''} that fulfill their request.

${activePreset.systemPromptAddition}

${!activePreset.introduceNewElements ? 'IMPORTANT: Do not introduce new plot elements, characters, or locations unless specifically instructed. Only work with what has been established.' : ''}

Write exactly ${params.paragraphCount} paragraph${params.paragraphCount > 1 ? 's' : ''}.
Make it compelling and consistent with the established tone and style.`;

      // Add referenced notes if provided
      if (params.referencedNotes) {
        systemPrompt += `\n\nRELEVANT REFERENCE NOTES:${params.referencedNotes}`;
      }

      // Build messages array with conversation history
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt }
      ];

      // Add conversation history for context (last few exchanges)
      if (params.conversationHistory && params.conversationHistory.length > 0) {
        params.conversationHistory.forEach(msg => {
          messages.push({
            role: msg.role as 'user' | 'assistant',
            content: msg.content
          });
        });
      }

      // Add current instruction
      messages.push({
        role: 'user',
        content: params.instruction
      });

      console.log('🤖 Making directed AI generation call...');
      console.log('📝 Instruction:', params.instruction);
      console.log('📄 Paragraphs requested:', params.paragraphCount);
      console.log('🎨 Using preset:', activePreset.name);

      // Calculate max tokens based on paragraph count (roughly 100-150 tokens per paragraph)
      const maxTokens = Math.min(params.paragraphCount * 150, 1000);

      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messages,
        temperature: activePreset.temperature,
        max_tokens: maxTokens,
        stream: false
      });

      const generatedText = response.choices[0]?.message?.content?.trim() || '';
      console.log('✅ Directed generation successful');
      return generatedText;

    } catch (error) {
      console.error('❌ Directed AI generation error:', error);

      if (error instanceof Error) {
        if (error.message.includes('429')) {
          throw new Error('Rate limit exceeded. Please wait a moment before trying again.');
        } else if (error.message.includes('401')) {
          throw new Error('Invalid API key. Please check your OpenAI API key in the .env file.');
        } else if (error.message.includes('quota')) {
          throw new Error('OpenAI quota exceeded. Please check your OpenAI account billing.');
        }
      }

      throw new Error(`AI generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  });

  // AI Tag Suggestions
  ipcMain.handle('ai:suggest-tags', async (_, documentContent: string) => {
    try {
      if (!currentDb) throw new Error('No project open');

      if (!openaiClient) {
        initializeOpenAI();
      }

      if (!openaiClient) {
        throw new Error('OpenAI API key not found in environment variables');
      }

      // Get available tags
      const allTags = currentDb.getAllTags();

      // Build tag list by category for the prompt
      const tagsByCategory: Record<string, string[]> = {};
      allTags.forEach(tag => {
        const cat = tag.category || 'custom';
        if (!tagsByCategory[cat]) tagsByCategory[cat] = [];
        tagsByCategory[cat].push(tag.name);
      });

      const tagListText = Object.entries(tagsByCategory)
        .map(([category, tags]) => `${category}: ${tags.join(', ')}`)
        .join('\n');

      const systemPrompt = `You are a writing assistant helping an author tag their story content for better organization.

Analyze the provided scene/chapter content and suggest relevant tags from the available tag list.

Available tags by category:
${tagListText}

Your task:
1. Read the content carefully
2. Identify key elements: characters mentioned, settings/locations, tone/mood, content type (action, dialogue, etc.), and plot threads
3. Suggest 3-8 relevant tags from the available list that best describe this content
4. Return ONLY a JSON array of tag names, nothing else

Example response format:
["protagonist", "dark", "action", "main-plot"]`;

      console.log('🏷️ Generating AI tag suggestions...');
      console.log('📝 Content length:', documentContent.length);
      console.log('🏷️ Available tags:', allTags.length);

      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze this content and suggest relevant tags:\n\n${documentContent.slice(0, 3000)}` }
        ],
        temperature: 0.3,
        max_tokens: 200,
        stream: false
      });

      const suggestionsText = response.choices[0]?.message?.content?.trim() || '[]';
      console.log('✅ AI tag suggestions received:', suggestionsText);

      // Parse the JSON response
      try {
        const suggestedTagNames = JSON.parse(suggestionsText);

        // Find the actual tag objects
        const suggestedTags = suggestedTagNames
          .map((name: string) => allTags.find(t => t.name.toLowerCase() === name.toLowerCase()))
          .filter((t: any) => t != null);

        return suggestedTags;
      } catch (parseError) {
        console.error('Failed to parse AI response:', parseError);
        return [];
      }

    } catch (error) {
      console.error('❌ AI tag suggestion error:', error);

      if (error instanceof Error) {
        if (error.message.includes('429')) {
          throw new Error('Rate limit exceeded. Please wait before requesting suggestions.');
        } else if (error.message.includes('401')) {
          throw new Error('Invalid API key.');
        } else if (error.message.includes('quota')) {
          throw new Error('OpenAI quota exceeded.');
        }
      }

      throw new Error(`Tag suggestion failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  });
}

export function closeDatabase() {
  if (currentDb) {
    currentDb.close();
    currentDb = null;
  }
}