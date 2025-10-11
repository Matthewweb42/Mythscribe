// src/renderer/src/components/Layout/MainLayout.tsx
import React, { useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import Sidebar from '../Sidebar';
import Editor from '../Editor/Editor';
import ReferencePanel from '../ReferencePanel/ReferencePanel';
import WelcomeScreen from '../WelcomeScreen';
import SettingsModal from '../SettingsModal';
import AIAssistantPanel from '../AIAssistantPanel';
import { ConfirmModal } from '../ConfirmModal';
import { useProject } from '../../contexts/ProjectContext';
import { useMenuEvents } from '../../hooks/useMenuEvents';
import { Settings } from 'lucide-react';

const MainLayout: React.FC = () => {
  const { isProjectOpen, projectMetadata, closeProject, openProject, createProject, references, documents, activeDocumentId } = useProject();
  const [showReferences, setShowReferences] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showAI, setShowAI] = useState(false);
  const [editorInsertText, setEditorInsertText] = useState<((text: string) => void) | null>(null);
  const [editorSetGhostText, setEditorSetGhostText] = useState<((text: string) => void) | null>(null);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  // Handle menu events
  useMenuEvents({
    'menu:new-project': () => {
      const name = prompt('Enter project name:');
      if (name) createProject(name);
    },
    'menu:open-project': () => openProject(),
    'menu:save': () => {
      // Save handled automatically by editor
      console.log('Save triggered');
    },
    'menu:toggle-sidebar': () => setShowSidebar(prev => !prev),
    'menu:toggle-notes': () => {
      // Will be handled by Editor component
      console.log('Toggle notes');
    },
    'menu:toggle-ai': () => {
      setShowAI(prev => !prev);
    },
    'menu:toggle-focus': () => {
      // Will be handled by Editor component
      console.log('Toggle focus mode');
    },
    'menu:settings': () => setShowSettings(true),
    'menu:export-pdf': () => {
      alert('PDF export coming soon!');
    },
    'menu:export-docx': () => {
      alert('DOCX export coming soon!');
    },
    'menu:export-epub': () => {
      alert('EPUB export coming soon!');
    },
    'menu:export-markdown': () => {
      alert('Markdown export coming soon!');
    },
    'menu:import-document': () => {
      alert('Document import coming soon!');
    },
    'menu:import-characters': () => {
      alert('Character import coming soon!');
    },
    'menu:find': () => {
      alert('Find coming soon!');
    },
    'menu:find-replace': () => {
      alert('Find & Replace coming soon!');
    },
    'menu:insert-scene': () => {
      alert('Insert scene - use sidebar for now');
    },
    'menu:insert-chapter': () => {
      alert('Insert chapter - use sidebar for now');
    },
    'menu:insert-part': () => {
      alert('Insert part - use sidebar for now');
    },
    'menu:insert-character': () => {
      alert('Insert character coming soon!');
    },
    'menu:insert-setting': () => {
      alert('Insert setting coming soon!');
    },
    'menu:insert-worldbuilding': () => {
      alert('Insert world building coming soon!');
    },
    'menu:insert-scene-break': () => {
      alert('Insert scene break - use toolbar for now');
    },
    'menu:word-count': () => {
      alert('Word count details coming soon!');
    },
    'menu:statistics': () => {
      alert('Statistics coming soon!');
    },
    'menu:goals': () => {
      alert('Goals coming soon!');
    },
    'menu:tags': () => {
      alert('Tags manager coming soon!');
    },
    'menu:drafts': () => {
      alert('Draft manager coming soon!');
    },
    'menu:snapshots': () => {
      alert('Snapshots coming soon!');
    },
    'menu:documentation': () => {
      alert('Documentation coming soon!');
    },
    'menu:shortcuts': () => {
      alert('Keyboard shortcuts:\n\nCtrl+N - New Project\nCtrl+O - Open Project\nCtrl+S - Save\nCtrl+F - Find\nF11 - Focus Mode\nCtrl+K - AI Assistant');
    }
  });

  // Show welcome screen if no project is open
  if (!isProjectOpen) {
    return <WelcomeScreen />;
  }

  return (
    <div style={{
      height: '100vh',
      width: '100vw',
      overflow: 'hidden',
      backgroundColor: '#1e1e1e',
      color: '#d4d4d4'
    }}>
      <PanelGroup direction="horizontal" autoSaveId="main-layout">
        {/* Sidebar Panel */}
        {showSidebar && (
          <>
            <Panel
              defaultSize={20}
              minSize={15}
              maxSize={35}
              style={{
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              <Sidebar />
            </Panel>

            {/* Resize Handle */}
            <PanelResizeHandle style={{
              width: '4px',
              backgroundColor: '#333',
              cursor: 'col-resize',
              transition: 'background-color 0.2s'
            }}
            onMouseEnter={(e) => (e.currentTarget as unknown as HTMLElement).style.backgroundColor = 'var(--primary-green)'}
            onMouseLeave={(e) => (e.currentTarget as unknown as HTMLElement).style.backgroundColor = '#333'}
            />
          </>
        )}

        {/* Main Editor Panel with AI */}
        <Panel minSize={40}>
          <PanelGroup direction="horizontal" autoSaveId="editor-ai-layout">
            {/* Editor Area */}
            <Panel minSize={30}>
              <div style={{
                height: '100%',
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
                      onClick={() => setShowAI(!showAI)}
                      style={{
                        padding: '6px 12px',
                        backgroundColor: showAI ? '#0e639c' : '#333',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '12px'
                      }}
                    >
                      {showAI ? 'Hide' : 'Show'} AI
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
                      onClick={() => setShowCloseConfirm(true)}
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
                  <Editor
                    onInsertTextReady={(insertFn) => setEditorInsertText(() => insertFn)}
                    onSetGhostTextReady={(setGhostTextFn) => setEditorSetGhostText(() => setGhostTextFn)}
                  />
                </div>
              </div>
            </Panel>

            {/* AI Assistant Panel */}
            {showAI && (
              <>
                <PanelResizeHandle style={{
                  width: '4px',
                  backgroundColor: '#333',
                  cursor: 'col-resize',
                  transition: 'background-color 0.2s'
                }}
                onMouseEnter={(e) => (e.currentTarget as unknown as HTMLElement).style.backgroundColor = 'var(--primary-green)'}
                onMouseLeave={(e) => (e.currentTarget as unknown as HTMLElement).style.backgroundColor = '#333'}
                />

                <Panel
                  defaultSize={30}
                  minSize={20}
                  maxSize={50}
                >
                  <AIAssistantPanel
                    onClose={() => setShowAI(false)}
                    onInsertText={(text) => {
                      if (editorInsertText) {
                        editorInsertText(text);
                      }
                    }}
                    onSetGhostText={(text) => {
                      if (editorSetGhostText) {
                        editorSetGhostText(text);
                      }
                    }}
                    references={references}
                    activeDocument={
                      activeDocumentId
                        ? documents.find(d => d.id === activeDocumentId) || null
                        : null
                    }
                  />
                </Panel>
              </>
            )}
          </PanelGroup>
        </Panel>

        {/* Reference Panel */}
        {showReferences && (
          <>
            {/* Resize Handle */}
            <PanelResizeHandle style={{
              width: '4px',
              backgroundColor: '#333',
              cursor: 'col-resize',
              transition: 'background-color 0.2s'
            }}
            onMouseEnter={(e) => (e.currentTarget as unknown as HTMLElement).style.backgroundColor = 'var(--primary-green)'}
            onMouseLeave={(e) => (e.currentTarget as unknown as HTMLElement).style.backgroundColor = '#333'}
            />

            <Panel
              defaultSize={20}
              minSize={15}
              maxSize={35}
              style={{
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              <ReferencePanel />
            </Panel>
          </>
        )}
      </PanelGroup>

      {/* Settings Modal */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

      {/* Close Project Confirmation */}
      <ConfirmModal
        isOpen={showCloseConfirm}
        title="Close Project"
        message="Are you sure you want to close this project? Any unsaved changes will be saved automatically."
        confirmText="Close Project"
        cancelText="Cancel"
        onConfirm={() => {
          closeProject();
          setShowCloseConfirm(false);
        }}
        onCancel={() => setShowCloseConfirm(false)}
        danger={false}
      />
    </div>
  );
};

export default MainLayout;