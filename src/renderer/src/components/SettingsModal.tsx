// src/renderer/src/components/SettingsModal.tsx
import React, { useState, useEffect } from 'react';
import { X, Key, Zap, Sparkles, Type, Layout } from 'lucide-react';
import aiService, { DEFAULT_AI_SETTINGS } from '../services/aiService';
import { BUILT_IN_PRESETS } from '../../../shared/aiPresets';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabId = 'editor' | 'ai';

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<TabId>('editor');
  const [apiKey, setApiKey] = useState('');
  const [isInitialized, setIsInitialized] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(DEFAULT_AI_SETTINGS.enabled);
  const [suggestionDelay, setSuggestionDelay] = useState(DEFAULT_AI_SETTINGS.suggestionDelay);
  const [temperature, setTemperature] = useState(DEFAULT_AI_SETTINGS.temperature);

  // AI Preset settings
  const [activePresetId, setActivePresetId] = useState('general');
  const [customInstructions, setCustomInstructions] = useState('');
  const [customTemperature, setCustomTemperature] = useState(0.7);
  const [customMaxTokens, setCustomMaxTokens] = useState(50);
  const [customIntroduceNewElements, setCustomIntroduceNewElements] = useState(true);

  // Editor Formatting settings
  const [editorTextSize, setEditorTextSize] = useState(16);
  const [editorLineHeight, setEditorLineHeight] = useState(1.6);
  const [editorParagraphSpacing, setEditorParagraphSpacing] = useState(0);
  const [editorParagraphIndent, setEditorParagraphIndent] = useState(0);
  const [editorMaxWidth, setEditorMaxWidth] = useState(700);
  const [editorSceneBreakStyle, setEditorSceneBreakStyle] = useState('* * *');

  useEffect(() => {
    const loadSettings = async () => {
      setIsInitialized(true); // AI service is always ready with IPC
      const settings = aiService.getSettings();
      setAiEnabled(settings.enabled);
      setSuggestionDelay(settings.suggestionDelay);
      setTemperature(settings.temperature);

      // Load preset settings from database
      try {
        const presetId = await window.api.settings.get('ai_preset_id') || 'general';
        const instructions = await window.api.settings.get('ai_custom_instructions') || '';
        const temp = await window.api.settings.get('ai_custom_temperature');
        const tokens = await window.api.settings.get('ai_custom_max_tokens');
        const newElements = await window.api.settings.get('ai_custom_introduce_new_elements');

        setActivePresetId(presetId);
        setCustomInstructions(instructions);
        setCustomTemperature(temp ? parseFloat(temp) : 0.7);
        setCustomMaxTokens(tokens ? parseInt(tokens) : 50);
        setCustomIntroduceNewElements(newElements === 'true' || newElements === undefined);

        // Load editor formatting settings
        const textSize = await window.api.settings.get('editor_text_size');
        const lineHeight = await window.api.settings.get('editor_line_height');
        const paragraphSpacing = await window.api.settings.get('editor_paragraph_spacing');
        const paragraphIndent = await window.api.settings.get('editor_paragraph_indent');
        const maxWidth = await window.api.settings.get('editor_max_width');
        const sceneBreakStyle = await window.api.settings.get('editor_scene_break_style');

        if (textSize) setEditorTextSize(parseFloat(textSize));
        if (lineHeight) setEditorLineHeight(parseFloat(lineHeight));
        if (paragraphSpacing) setEditorParagraphSpacing(parseFloat(paragraphSpacing));
        if (paragraphIndent) setEditorParagraphIndent(parseFloat(paragraphIndent));
        if (maxWidth) setEditorMaxWidth(parseFloat(maxWidth));
        if (sceneBreakStyle) setEditorSceneBreakStyle(sceneBreakStyle);
      } catch (error) {
        console.error('Error loading preset settings:', error);
      }
    };

    if (isOpen) {
      loadSettings();
    }
  }, [isOpen]);

  const handleSaveApiKey = () => {
    if (!apiKey.trim()) {
      alert('Please enter an API key');
      return;
    }

    try {
      // Note: API key is now handled via .env file and main process
      setIsInitialized(true);
      alert('API key setting noted! Make sure to add OPENAI_API_KEY to your .env file.');
      setApiKey(''); // Clear the input for security
    } catch (error) {
      console.error('Error with API key setting:', error);
      alert('Note: API key should be set in .env file for security.');
    }
  };

  const handleTestApiKey = async () => {
    try {
      const result = await window.api.ai.testApiKey();
      if (result.success) {
        alert('✅ API Key Test Successful!\n\n' + result.message);
      } else {
        alert('❌ API Key Test Failed:\n\n' + result.message);
      }
    } catch (error) {
      console.error('Error testing API key:', error);
      alert('❌ Error testing API key:\n\n' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  const handleSaveSettings = async () => {
    try {
      // Save basic AI settings
      aiService.updateSettings({
        enabled: aiEnabled,
        suggestionDelay: suggestionDelay,
        temperature: temperature
      });

      // Save preset settings to database
      await window.api.settings.set('ai_preset_id', activePresetId);
      await window.api.settings.set('ai_custom_instructions', customInstructions);
      await window.api.settings.set('ai_custom_temperature', customTemperature.toString());
      await window.api.settings.set('ai_custom_max_tokens', customMaxTokens.toString());
      await window.api.settings.set('ai_custom_introduce_new_elements', customIntroduceNewElements.toString());

      // Save editor formatting settings
      await window.api.settings.set('editor_text_size', editorTextSize.toString());
      await window.api.settings.set('editor_line_height', editorLineHeight.toString());
      await window.api.settings.set('editor_paragraph_spacing', editorParagraphSpacing.toString());
      await window.api.settings.set('editor_paragraph_indent', editorParagraphIndent.toString());
      await window.api.settings.set('editor_max_width', editorMaxWidth.toString());
      await window.api.settings.set('editor_scene_break_style', editorSceneBreakStyle);

      alert('Settings saved! Reload the editor to see changes.');
      onClose();
    } catch (error) {
      console.error('Error saving settings:', error);
      alert('Error saving settings: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  // Get current active preset
  const currentPreset = BUILT_IN_PRESETS[activePresetId] || BUILT_IN_PRESETS.general;
  const isCustomPreset = activePresetId === 'custom';

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000
    }}>
      <div style={{
        backgroundColor: '#252526',
        borderRadius: '8px',
        width: '650px',
        maxHeight: '85vh',
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid #333'
      }}>
        {/* Header */}
        <div style={{
          padding: '16px 20px',
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600 }}>Settings</h2>
          <button
            onClick={onClose}
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              color: '#888',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              transition: 'color 0.2s'
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = '#fff'}
            onMouseLeave={(e) => e.currentTarget.style.color = '#888'}
          >
            <X size={20} />
          </button>
        </div>

        {/* Tab Navigation */}
        <div style={{
          display: 'flex',
          borderBottom: '1px solid #333',
          backgroundColor: '#2d2d2d',
          padding: '0 20px'
        }}>
          <button
            onClick={() => setActiveTab('editor')}
            style={{
              padding: '12px 20px',
              backgroundColor: 'transparent',
              color: activeTab === 'editor' ? '#dcb67a' : '#888',
              border: 'none',
              borderBottom: activeTab === 'editor' ? '2px solid #dcb67a' : '2px solid transparent',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              if (activeTab !== 'editor') e.currentTarget.style.color = '#d4d4d4';
            }}
            onMouseLeave={(e) => {
              if (activeTab !== 'editor') e.currentTarget.style.color = '#888';
            }}
          >
            <Type size={16} />
            Editor
          </button>
          <button
            onClick={() => setActiveTab('ai')}
            style={{
              padding: '12px 20px',
              backgroundColor: 'transparent',
              color: activeTab === 'ai' ? '#dcb67a' : '#888',
              border: 'none',
              borderBottom: activeTab === 'ai' ? '2px solid #dcb67a' : '2px solid transparent',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 500,
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              if (activeTab !== 'ai') e.currentTarget.style.color = '#d4d4d4';
            }}
            onMouseLeave={(e) => {
              if (activeTab !== 'ai') e.currentTarget.style.color = '#888';
            }}
          >
            <Sparkles size={16} />
            AI Assistant
          </button>
        </div>

        {/* Tab Content */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: '24px'
        }}>
          {activeTab === 'editor' && (
            <div>
              {/* Text Appearance Section */}
              <div style={{ marginBottom: '32px' }}>
                <h3 style={{
                  margin: '0 0 16px 0',
                  fontSize: '15px',
                  fontWeight: 600,
                  color: '#d4d4d4',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <Type size={16} color="#dcb67a" />
                  Text Appearance
                </h3>

                {/* Font Size */}
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', marginBottom: '8px', color: '#aaa', fontWeight: 500 }}>
                    Font Size: <span style={{ color: '#dcb67a' }}>{editorTextSize}px</span>
                  </label>
                  <input
                    type="range"
                    min="12"
                    max="24"
                    step="1"
                    value={editorTextSize}
                    onChange={(e) => setEditorTextSize(Number(e.target.value))}
                    style={{ width: '100%' }}
                  />
                  <p style={{ fontSize: '11px', color: '#666', marginTop: '4px', marginBottom: 0 }}>
                    Adjust the text size in the editor
                  </p>
                </div>

                {/* Line Spacing */}
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', marginBottom: '8px', color: '#aaa', fontWeight: 500 }}>
                    Line Spacing: <span style={{ color: '#dcb67a' }}>{editorLineHeight.toFixed(1)}</span>
                  </label>
                  <input
                    type="range"
                    min="1.0"
                    max="2.5"
                    step="0.1"
                    value={editorLineHeight}
                    onChange={(e) => setEditorLineHeight(Number(e.target.value))}
                    style={{ width: '100%' }}
                  />
                  <p style={{ fontSize: '11px', color: '#666', marginTop: '4px', marginBottom: 0 }}>
                    Single-spaced (1.0) to double-spaced (2.0) or more
                  </p>
                </div>
              </div>

              {/* Paragraph Formatting Section */}
              <div style={{ marginBottom: '32px' }}>
                <h3 style={{
                  margin: '0 0 16px 0',
                  fontSize: '15px',
                  fontWeight: 600,
                  color: '#d4d4d4',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <Layout size={16} color="#dcb67a" />
                  Paragraph Formatting
                </h3>

                {/* Paragraph Spacing */}
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', marginBottom: '8px', color: '#aaa', fontWeight: 500 }}>
                    Paragraph Spacing: <span style={{ color: '#dcb67a' }}>{editorParagraphSpacing.toFixed(1)}em</span>
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="2.0"
                    step="0.1"
                    value={editorParagraphSpacing}
                    onChange={(e) => setEditorParagraphSpacing(Number(e.target.value))}
                    style={{ width: '100%' }}
                  />
                  <p style={{ fontSize: '11px', color: '#666', marginTop: '4px', marginBottom: 0 }}>
                    Space between paragraphs (0 = no space, traditional manuscript)
                  </p>
                </div>

                {/* Paragraph Indent */}
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', marginBottom: '8px', color: '#aaa', fontWeight: 500 }}>
                    First-Line Indent: <span style={{ color: '#dcb67a' }}>{editorParagraphIndent.toFixed(1)}em</span>
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="3.0"
                    step="0.1"
                    value={editorParagraphIndent}
                    onChange={(e) => setEditorParagraphIndent(Number(e.target.value))}
                    style={{ width: '100%' }}
                  />
                  <p style={{ fontSize: '11px', color: '#666', marginTop: '4px', marginBottom: 0 }}>
                    First-line indentation (0 = no indent, modern web style)
                  </p>
                </div>
              </div>

              {/* Layout Section */}
              <div style={{ marginBottom: '32px' }}>
                <h3 style={{
                  margin: '0 0 16px 0',
                  fontSize: '15px',
                  fontWeight: 600,
                  color: '#d4d4d4',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <Layout size={16} color="#dcb67a" />
                  Layout
                </h3>

                {/* Max Width */}
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', marginBottom: '8px', color: '#aaa', fontWeight: 500 }}>
                    Maximum Text Width: <span style={{ color: '#dcb67a' }}>{editorMaxWidth}px</span>
                  </label>
                  <input
                    type="range"
                    min="500"
                    max="1000"
                    step="50"
                    value={editorMaxWidth}
                    onChange={(e) => setEditorMaxWidth(Number(e.target.value))}
                    style={{ width: '100%' }}
                  />
                  <p style={{ fontSize: '11px', color: '#666', marginTop: '4px', marginBottom: 0 }}>
                    Text column width (book-like width around 700px)
                  </p>
                </div>
              </div>

              {/* Document Elements Section */}
              <div style={{ marginBottom: '32px' }}>
                <h3 style={{
                  margin: '0 0 16px 0',
                  fontSize: '15px',
                  fontWeight: 600,
                  color: '#d4d4d4',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <Layout size={16} color="#dcb67a" />
                  Document Elements
                </h3>

                {/* Scene Break Style */}
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', marginBottom: '8px', color: '#aaa', fontWeight: 500 }}>
                    Scene Break Style
                  </label>
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
                    {['* * *', '***', '###', '~~~', '---'].map((style) => (
                      <button
                        key={style}
                        onClick={() => setEditorSceneBreakStyle(style)}
                        style={{
                          padding: '8px 16px',
                          backgroundColor: editorSceneBreakStyle === style ? '#dcb67a' : '#333',
                          color: editorSceneBreakStyle === style ? '#000' : '#d4d4d4',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontSize: '14px',
                          fontWeight: 500,
                          transition: 'all 0.2s'
                        }}
                        onMouseEnter={(e) => {
                          if (editorSceneBreakStyle !== style) {
                            e.currentTarget.style.backgroundColor = '#444';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (editorSceneBreakStyle !== style) {
                            e.currentTarget.style.backgroundColor = '#333';
                          }
                        }}
                      >
                        {style}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={editorSceneBreakStyle}
                    onChange={(e) => setEditorSceneBreakStyle(e.target.value)}
                    placeholder="Custom scene break..."
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      backgroundColor: '#1e1e1e',
                      border: '1px solid #333',
                      borderRadius: '4px',
                      color: '#d4d4d4',
                      fontSize: '13px'
                    }}
                  />
                  <p style={{ fontSize: '11px', color: '#666', marginTop: '6px', marginBottom: 0 }}>
                    Choose a preset or enter custom text for scene breaks
                  </p>
                </div>
              </div>

              {/* Preview */}
              <div style={{
                padding: '16px',
                backgroundColor: '#1e1e1e',
                borderRadius: '6px',
                border: '1px solid #333'
              }}>
                <div style={{ fontSize: '12px', color: '#888', marginBottom: '12px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Preview
                </div>
                <div style={{
                  fontSize: `${editorTextSize}px`,
                  lineHeight: `${editorLineHeight}`,
                  maxWidth: `${editorMaxWidth}px`,
                  margin: '0 auto'
                }}>
                  <p style={{
                    marginBottom: `${editorParagraphSpacing}em`,
                    textIndent: `${editorParagraphIndent}em`,
                    color: '#d4d4d4'
                  }}>
                    This is how your text will appear in the editor. The quick brown fox jumps over the lazy dog.
                  </p>
                  <p style={{
                    marginBottom: `${editorParagraphSpacing}em`,
                    textIndent: `${editorParagraphIndent}em`,
                    color: '#d4d4d4'
                  }}>
                    Each paragraph will use these spacing and indentation settings automatically.
                  </p>
                  <div style={{ textAlign: 'center', margin: '16px 0', color: '#888', fontSize: '18px' }}>
                    {editorSceneBreakStyle}
                  </div>
                  <p style={{
                    marginBottom: `${editorParagraphSpacing}em`,
                    textIndent: `${editorParagraphIndent}em`,
                    color: '#d4d4d4'
                  }}>
                    Scene breaks will appear like the symbol above, centered within your text column.
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'ai' && (
            <div>
              {/* API Key Section */}
              <div style={{ marginBottom: '32px' }}>
                <h3 style={{
                  margin: '0 0 16px 0',
                  fontSize: '15px',
                  fontWeight: 600,
                  color: '#d4d4d4',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <Key size={16} color="#dcb67a" />
                  OpenAI API Key
                </h3>

                {isInitialized ? (
                  <div>
                    <div style={{
                      padding: '12px',
                      backgroundColor: '#1e1e1e',
                      borderRadius: '4px',
                      border: '1px solid #0e639c',
                      color: '#0e639c',
                      marginBottom: '12px',
                      fontSize: '13px'
                    }}>
                      ✓ API Key configured
                    </div>
                    <button
                      onClick={handleTestApiKey}
                      style={{
                        padding: '10px 16px',
                        backgroundColor: '#dcb67a',
                        color: '#000',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        fontWeight: 500
                      }}
                    >
                      🧪 Test API Key
                    </button>
                  </div>
                ) : (
                  <>
                    <p style={{ fontSize: '13px', color: '#888', marginBottom: '12px' }}>
                      Get your API key from{' '}
                      <a
                        href="https://platform.openai.com/api-keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#0e639c' }}
                      >
                        OpenAI Platform
                      </a>
                    </p>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="sk-..."
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        backgroundColor: '#1e1e1e',
                        border: '1px solid #333',
                        borderRadius: '4px',
                        color: '#d4d4d4',
                        fontSize: '13px',
                        marginBottom: '12px'
                      }}
                    />
                    <button
                      onClick={handleSaveApiKey}
                      style={{
                        padding: '10px 16px',
                        backgroundColor: '#0e639c',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        fontWeight: 500
                      }}
                    >
                      Save API Key
                    </button>
                  </>
                )}
              </div>

              {/* AI Settings */}
              <div style={{ marginBottom: '32px' }}>
                <h3 style={{
                  margin: '0 0 16px 0',
                  fontSize: '15px',
                  fontWeight: 600,
                  color: '#d4d4d4',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <Zap size={16} color="#dcb67a" />
                  AI Assistance
                </h3>

                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  marginBottom: '20px',
                  cursor: 'pointer'
                }}>
                  <input
                    type="checkbox"
                    checked={aiEnabled}
                    onChange={(e) => setAiEnabled(e.target.checked)}
                    style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                  />
                  <span style={{ fontSize: '14px', fontWeight: 500 }}>Enable AI Suggestions</span>
                </label>
              </div>

              {/* Writing Presets */}
              <div style={{ marginBottom: '32px' }}>
                <h3 style={{
                  margin: '0 0 16px 0',
                  fontSize: '15px',
                  fontWeight: 600,
                  color: '#d4d4d4',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <Sparkles size={16} color="#dcb67a" />
                  Writing Presets
                </h3>

                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '13px', marginBottom: '8px', color: '#aaa', fontWeight: 500 }}>
                    Scene Type
                  </label>
                  <select
                    value={activePresetId}
                    onChange={(e) => setActivePresetId(e.target.value)}
                    disabled={!aiEnabled}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      backgroundColor: '#1e1e1e',
                      border: '1px solid #333',
                      borderRadius: '4px',
                      color: '#d4d4d4',
                      fontSize: '13px',
                      cursor: aiEnabled ? 'pointer' : 'not-allowed'
                    }}
                  >
                    {Object.values(BUILT_IN_PRESETS).map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name} - {preset.description}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{
                  padding: '12px',
                  backgroundColor: '#1e1e1e',
                  borderRadius: '4px',
                  border: '1px solid #333',
                  marginBottom: '16px'
                }}>
                  <div style={{ fontSize: '12px', color: '#888', marginBottom: '6px' }}>
                    <strong style={{ color: '#dcb67a' }}>{currentPreset.name}</strong>
                  </div>
                  <div style={{ fontSize: '11px', color: '#aaa', marginBottom: '6px' }}>
                    {currentPreset.description}
                  </div>
                  {!isCustomPreset && (
                    <div style={{ fontSize: '11px', color: '#666' }}>
                      {currentPreset.systemPromptAddition}
                    </div>
                  )}
                </div>

                {isCustomPreset && (
                  <>
                    <div style={{ marginBottom: '16px' }}>
                      <label style={{ display: 'block', fontSize: '13px', marginBottom: '8px', color: '#aaa', fontWeight: 500 }}>
                        Custom Instructions
                      </label>
                      <textarea
                        value={customInstructions}
                        onChange={(e) => setCustomInstructions(e.target.value)}
                        placeholder="Describe the style and tone you want..."
                        disabled={!aiEnabled}
                        style={{
                          width: '100%',
                          minHeight: '80px',
                          padding: '10px 12px',
                          backgroundColor: '#1e1e1e',
                          border: '1px solid #333',
                          borderRadius: '4px',
                          color: '#d4d4d4',
                          fontSize: '13px',
                          fontFamily: 'inherit',
                          resize: 'vertical'
                        }}
                      />
                    </div>

                    <div style={{ marginBottom: '16px' }}>
                      <label style={{ display: 'block', fontSize: '13px', marginBottom: '8px', color: '#aaa', fontWeight: 500 }}>
                        Custom Creativity: <span style={{ color: '#dcb67a' }}>{customTemperature.toFixed(1)}</span>
                      </label>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.1"
                        value={customTemperature}
                        onChange={(e) => setCustomTemperature(Number(e.target.value))}
                        disabled={!aiEnabled}
                        style={{ width: '100%' }}
                      />
                    </div>

                    <div style={{ marginBottom: '16px' }}>
                      <label style={{ display: 'block', fontSize: '13px', marginBottom: '8px', color: '#aaa', fontWeight: 500 }}>
                        Max Length: <span style={{ color: '#dcb67a' }}>{customMaxTokens} tokens</span>
                      </label>
                      <input
                        type="range"
                        min="20"
                        max="150"
                        step="10"
                        value={customMaxTokens}
                        onChange={(e) => setCustomMaxTokens(Number(e.target.value))}
                        disabled={!aiEnabled}
                        style={{ width: '100%' }}
                      />
                    </div>

                    <label style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      marginBottom: '16px',
                      cursor: aiEnabled ? 'pointer' : 'not-allowed'
                    }}>
                      <input
                        type="checkbox"
                        checked={customIntroduceNewElements}
                        onChange={(e) => setCustomIntroduceNewElements(e.target.checked)}
                        disabled={!aiEnabled}
                        style={{ cursor: aiEnabled ? 'pointer' : 'not-allowed', width: '16px', height: '16px' }}
                      />
                      <span style={{ fontSize: '13px', color: '#aaa' }}>Allow introducing new elements</span>
                    </label>
                  </>
                )}
              </div>

              {/* AI Behavior */}
              <div style={{ marginBottom: '32px' }}>
                <h3 style={{
                  margin: '0 0 16px 0',
                  fontSize: '15px',
                  fontWeight: 600,
                  color: '#d4d4d4',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}>
                  <Zap size={16} color="#dcb67a" />
                  AI Behavior
                </h3>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', marginBottom: '8px', color: '#aaa', fontWeight: 500 }}>
                    Suggestion Delay: <span style={{ color: '#dcb67a' }}>{suggestionDelay / 1000}s</span>
                  </label>
                  <input
                    type="range"
                    min="500"
                    max="5000"
                    step="500"
                    value={suggestionDelay}
                    onChange={(e) => setSuggestionDelay(Number(e.target.value))}
                    disabled={!aiEnabled}
                    style={{ width: '100%' }}
                  />
                  <p style={{ fontSize: '11px', color: '#666', marginTop: '4px', marginBottom: 0 }}>
                    How long to wait after you stop typing before showing suggestions
                  </p>
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', marginBottom: '8px', color: '#aaa', fontWeight: 500 }}>
                    Creativity: <span style={{ color: '#dcb67a' }}>{temperature.toFixed(1)}</span>
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={temperature}
                    onChange={(e) => setTemperature(Number(e.target.value))}
                    disabled={!aiEnabled}
                    style={{ width: '100%' }}
                  />
                  <p style={{ fontSize: '11px', color: '#666', marginTop: '4px', marginBottom: 0 }}>
                    Lower = more focused, Higher = more creative
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer with Save Button */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid #333',
          backgroundColor: '#2d2d2d'
        }}>
          <button
            onClick={handleSaveSettings}
            style={{
              width: '100%',
              padding: '12px',
              backgroundColor: '#0e639c',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 600,
              transition: 'background-color 0.2s'
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#0d5a8c'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#0e639c'}
          >
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
