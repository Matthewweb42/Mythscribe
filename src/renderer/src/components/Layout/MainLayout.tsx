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
import { InputModal } from '../InputModal';
import MenuBar from '../MenuBar';
import { useProject } from '../../contexts/ProjectContext';
import { useNotification } from '../../contexts/NotificationContext';
import { useMenuEvents } from '../../hooks/useMenuEvents';
import { Settings } from 'lucide-react';

const MainLayout: React.FC = () => {
  const { isProjectOpen, projectMetadata, closeProject, openProject, createProject, references, documents, activeDocumentId } = useProject();
  const { showInfo } = useNotification();
  const [showReferences, setShowReferences] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showAI, setShowAI] = useState(false);
  const [editorInsertText, setEditorInsertText] = useState<((text: string) => void) | null>(null);
  const [editorSetGhostText, setEditorSetGhostText] = useState<((text: string) => void) | null>(null);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [showInputModal, setShowInputModal] = useState(false);
  const [inputModalConfig, setInputModalConfig] = useState({ title: '', message: '', onConfirm: (_: string) => {} });

  const openInputModal = (title: string, message: string, onConfirm: (value: string) => void) => {
    setInputModalConfig({ title, message, onConfirm });
    setShowInputModal(true);
  };

  // Handle menu bar actions
  const handleMenuAction = (action: string) => {
    switch (action) {
      case 'menu:new-project':
        openInputModal('New Project', 'Enter a name for your new project:', (name) => {
          createProject(name);
          setShowInputModal(false);
        });
        break;
      case 'menu:open-project':
        openProject();
        break;
      case 'menu:save':
        console.log('Save triggered');
        break;
      case 'menu:toggle-sidebar':
        setShowSidebar(prev => !prev);
        break;
      case 'menu:toggle-notes':
        console.log('Toggle notes');
        break;
      case 'menu:toggle-ai':
        setShowAI(prev => !prev);
        break;
      case 'menu:toggle-focus':
        console.log('Toggle focus mode');
        break;
      case 'menu:settings':
        setShowSettings(true);
        break;
      default:
        console.log('Menu action:', action);
    }
  };

  // Handle menu events
  useMenuEvents({
    'menu:new-project': () => {
      openInputModal('New Project', 'Enter a name for your new project:', (name) => {
        createProject(name);
        setShowInputModal(false);
      });
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
      showInfo('PDF export coming soon!');
    },
    'menu:export-docx': () => {
      showInfo('DOCX export coming soon!');
    },
    'menu:export-epub': () => {
      showInfo('EPUB export coming soon!');
    },
    'menu:export-markdown': () => {
      showInfo('Markdown export coming soon!');
    },
    'menu:import-document': () => {
      showInfo('Document import coming soon!');
    },
    'menu:import-characters': () => {
      showInfo('Character import coming soon!');
    },
    'menu:find': () => {
      showInfo('Find coming soon!');
    },
    'menu:find-replace': () => {
      showInfo('Find & Replace coming soon!');
    },
    'menu:insert-scene': () => {
      showInfo('Insert scene - use sidebar for now');
    },
    'menu:insert-chapter': () => {
      showInfo('Insert chapter - use sidebar for now');
    },
    'menu:insert-part': () => {
      showInfo('Insert part - use sidebar for now');
    },
    'menu:insert-character': () => {
      showInfo('Insert character coming soon!');
    },
    'menu:insert-setting': () => {
      showInfo('Insert setting coming soon!');
    },
    'menu:insert-worldbuilding': () => {
      showInfo('Insert world building coming soon!');
    },
    'menu:insert-scene-break': () => {
      showInfo('Insert scene break - use toolbar for now');
    },
    'menu:word-count': () => {
      showInfo('Word count details coming soon!');
    },
    'menu:statistics': () => {
      showInfo('Statistics coming soon!');
    },
    'menu:goals': () => {
      showInfo('Goals coming soon!');
    },
    'menu:tags': () => {
      showInfo('Tags manager coming soon!');
    },
    'menu:drafts': () => {
      showInfo('Draft manager coming soon!');
    },
    'menu:snapshots': () => {
      showInfo('Snapshots coming soon!');
    },
    'menu:documentation': () => {
      showInfo('Documentation coming soon!');
    },
    'menu:shortcuts': () => {
      showInfo('Keyboard shortcuts:\n\nCtrl+N - New Project\nCtrl+O - Open Project\nCtrl+S - Save\nCtrl+F - Find\nF11 - Focus Mode\nCtrl+K - AI Assistant');
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
      color: '#d4d4d4',
      display: 'flex',
      flexDirection: 'column'
    }}>
      {/* Menu Bar */}
      <MenuBar onMenuAction={handleMenuAction} />

      {/* Main Content Area */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
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
      </div>

      {/* Settings Modal */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

      {/* Input Modal */}
      <InputModal
        isOpen={showInputModal}
        title={inputModalConfig.title}
        message={inputModalConfig.message}
        placeholder="Enter name..."
        onConfirm={inputModalConfig.onConfirm}
        onCancel={() => setShowInputModal(false)}
      />

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
