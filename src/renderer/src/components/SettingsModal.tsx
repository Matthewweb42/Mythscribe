// src/renderer/src/components/SettingsModal.tsx
import React, { useState, useEffect } from 'react';
import { X, Key, Zap, Sparkles } from 'lucide-react';
import aiService, { DEFAULT_AI_SETTINGS } from '../services/aiService';
import { BUILT_IN_PRESETS } from '../../../shared/aiPresets';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
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

      alert('Settings saved!');
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
        width: '500px',
        maxHeight: '80vh',
        overflow: 'auto',
        border: '1px solid #333'
      }}>
        {/* Header */}
        <div style={{
          padding: '16px',
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <h2 style={{ margin: 0, fontSize: '18px' }}>Settings</h2>
          <button
            onClick={onClose}
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              color: '#888',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex'
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '20px' }}>
          {/* API Key Section */}
          <div style={{ marginBottom: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <Key size={18} color="#dcb67a" />
              <h3 style={{ margin: 0, fontSize: '16px' }}>OpenAI API Key</h3>
            </div>
            
            {isInitialized ? (
              <div>
                <div style={{
                  padding: '12px',
                  backgroundColor: '#1e1e1e',
                  borderRadius: '4px',
                  border: '1px solid #0e639c',
                  color: '#0e639c',
                  marginBottom: '8px'
                }}>
                  ✓ API Key configured
                </div>
                <button
                  onClick={handleTestApiKey}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: '#dcb67a',
                    color: '#000',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '13px'
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
                    padding: '10px',
                    backgroundColor: '#1e1e1e',
                    border: '1px solid #333',
                    borderRadius: '4px',
                    color: '#d4d4d4',
                    fontSize: '13px',
                    marginBottom: '8px'
                  }}
                />
                <button
                  onClick={handleSaveApiKey}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: '#0e639c',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '13px'
                  }}
                >
                  Save API Key
                </button>
              </>
            )}
          </div>

          {/* AI Settings Section */}
          <div style={{ marginBottom: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <Zap size={18} color="#dcb67a" />
              <h3 style={{ margin: 0, fontSize: '16px' }}>AI Assistance</h3>
            </div>

            {/* Enable/Disable AI */}
            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '16px',
              cursor: 'pointer'
            }}>
              <input
                type="checkbox"
                checked={aiEnabled}
                onChange={(e) => setAiEnabled(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span style={{ fontSize: '14px' }}>Enable AI Suggestions</span>
            </label>
          </div>

          {/* Writing Presets Section */}
          <div style={{ marginBottom: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <Sparkles size={18} color="#dcb67a" />
              <h3 style={{ margin: 0, fontSize: '16px' }}>Writing Presets</h3>
            </div>

            {/* Preset Selector */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: '#888' }}>
                Scene Type
              </label>
              <select
                value={activePresetId}
                onChange={(e) => setActivePresetId(e.target.value)}
                disabled={!aiEnabled}
                style={{
                  width: '100%',
                  padding: '8px',
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

            {/* Preset Info */}
            <div style={{
              padding: '12px',
              backgroundColor: '#1e1e1e',
              borderRadius: '4px',
              border: '1px solid #333',
              marginBottom: '16px'
            }}>
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '8px' }}>
                <strong style={{ color: '#dcb67a' }}>{currentPreset.name}</strong>
              </div>
              <div style={{ fontSize: '11px', color: '#aaa', marginBottom: '8px' }}>
                {currentPreset.description}
              </div>
              {!isCustomPreset && (
                <div style={{ fontSize: '11px', color: '#666' }}>
                  {currentPreset.systemPromptAddition}
                </div>
              )}
            </div>

            {/* Custom Preset Settings */}
            {isCustomPreset && (
              <>
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: '#888' }}>
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
                      padding: '8px',
                      backgroundColor: '#1e1e1e',
                      border: '1px solid #333',
                      borderRadius: '4px',
                      color: '#d4d4d4',
                      fontSize: '12px',
                      fontFamily: 'inherit',
                      resize: 'vertical'
                    }}
                  />
                </div>

                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: '#888' }}>
                    Custom Creativity: {customTemperature.toFixed(1)}
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
                  <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: '#888' }}>
                    Max Length: {customMaxTokens} tokens
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
                  gap: '8px',
                  marginBottom: '16px',
                  cursor: aiEnabled ? 'pointer' : 'not-allowed'
                }}>
                  <input
                    type="checkbox"
                    checked={customIntroduceNewElements}
                    onChange={(e) => setCustomIntroduceNewElements(e.target.checked)}
                    disabled={!aiEnabled}
                    style={{ cursor: aiEnabled ? 'pointer' : 'not-allowed' }}
                  />
                  <span style={{ fontSize: '13px', color: '#888' }}>Allow introducing new elements</span>
                </label>
              </>
            )}
          </div>

          {/* AI Behavior Settings */}
          <div style={{ marginBottom: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <Zap size={18} color="#dcb67a" />
              <h3 style={{ margin: 0, fontSize: '16px' }}>AI Behavior</h3>
            </div>

            {/* Suggestion Delay */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: '#888' }}>
                Suggestion Delay: {suggestionDelay / 1000}s
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
              <p style={{ fontSize: '11px', color: '#666', marginTop: '4px' }}>
                How long to wait after you stop typing before showing suggestions
              </p>
            </div>

            {/* Temperature */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', marginBottom: '6px', color: '#888' }}>
                Creativity: {temperature.toFixed(1)}
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
              <p style={{ fontSize: '11px', color: '#666', marginTop: '4px' }}>
                Lower = more focused, Higher = more creative
              </p>
            </div>
          </div>

          {/* Save Button */}
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
              fontWeight: 'bold'
            }}
          >
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;