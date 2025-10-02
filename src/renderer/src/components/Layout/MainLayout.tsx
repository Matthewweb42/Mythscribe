// src/renderer/src/components/Layout/MainLayout.tsx
import React, { useState } from 'react';
import Sidebar from '../Sidebar';
import Editor from '../Editor/Editor';
import ReferencePanel from '../ReferencePanel/ReferencePanel';
import WelcomeScreen from '../WelcomeScreen';
import SettingsModal from '../SettingsModal';
import { useProject } from '../../contexts/ProjectContext';
import { Settings } from 'lucide-react';

const MainLayout: React.FC = () => {
  const { isProjectOpen, projectMetadata, closeProject } = useProject();
  const [showReferences, setShowReferences] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Show welcome screen if no project is open
  if (!isProjectOpen) {
    return <WelcomeScreen />;
  }

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      width: '100vw',
      overflow: 'hidden',
      backgroundColor: '#1e1e1e',
      color: '#d4d4d4'
    }}>
      {/* Sidebar - Document Tree */}
      <div style={{
        width: '250px',
        borderRight: '1px solid #333',
        display: 'flex',
        flexDirection: 'column'
      }}>
        <Sidebar />
      </div>

      {/* Main Editor Area */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column'
      }}>
        {/* Toolbar */}
        <div style={{
          height: '50px',
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          padding: '0 16px',
          gap: '12px'
        }}>
          <div style={{ fontSize: '14px', fontWeight: 'bold' }}>
            {projectMetadata?.name}
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setShowSettings(true)}
              style={{
                padding: '6px 12px',
                backgroundColor: '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <Settings size={14} />
              Settings
            </button>

            <button
              onClick={() => setShowReferences(!showReferences)}
              style={{
                padding: '6px 12px',
                backgroundColor: showReferences ? '#0e639c' : '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '12px'
              }}
            >
              {showReferences ? 'Hide' : 'Show'} References
            </button>

            <button
              onClick={() => {
                if (confirm('Close this project?')) {
                  closeProject();
                }
              }}
              style={{
                padding: '6px 12px',
                backgroundColor: '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '12px'
              }}
            >
              Close Project
            </button>
          </div>
        </div>

        {/* Editor Content */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <Editor />
        </div>
      </div>

      {/* Reference Panel - Slides in from right */}
      {showReferences && (
        <div style={{
          width: '300px',
          borderLeft: '1px solid #333',
          display: 'flex',
          flexDirection: 'column'
        }}>
          <ReferencePanel />
        </div>
      )}

      {/* Settings Modal */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
};

export default MainLayout;