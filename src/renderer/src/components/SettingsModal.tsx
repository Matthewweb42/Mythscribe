// src/renderer/src/components/SettingsModal.tsx
import React, { useState, useEffect } from 'react';
import { X, Key, Zap } from 'lucide-react';
import aiService, { DEFAULT_AI_SETTINGS } from '../services/aiService';

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

  useEffect(() => {
    setIsInitialized(true); // AI service is always ready with IPC
    const settings = aiService.getSettings();
    setAiEnabled(settings.enabled);
    setSuggestionDelay(settings.suggestionDelay);
    setTemperature(settings.temperature);
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

  const handleSaveSettings = () => {
    aiService.updateSettings({
      enabled: aiEnabled,
      suggestionDelay: suggestionDelay,
      temperature: temperature
    });
    alert('Settings saved!');
    onClose();
  };

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