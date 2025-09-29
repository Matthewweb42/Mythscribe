// src/renderer/components/Layout/MainLayout.tsx
import React, { useState } from 'react';
import Sidebar from '../Sidebar/Sidebar';
import Editor from '../Editor/Editor';
import ReferencePanel from '../ReferencePanel/ReferencePanel';
import { Document } from '../../types';

const MainLayout: React.FC = () => {
  const [activeDocument, setActiveDocument] = useState<Document | null>(null);
  const [showReferences, setShowReferences] = useState(false);

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
        <Sidebar 
          onDocumentSelect={setActiveDocument}
          activeDocumentId={activeDocument?.id}
        />
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
          <button
            onClick={() => setShowReferences(!showReferences)}
            style={{
              padding: '6px 12px',
              backgroundColor: showReferences ? '#0e639c' : '#333',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            {showReferences ? 'Hide' : 'Show'} References
          </button>
          
          {activeDocument && (
            <span style={{ fontSize: '14px', color: '#888' }}>
              {activeDocument.name}
            </span>
          )}
        </div>

        {/* Editor Content */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <Editor document={activeDocument} />
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
    </div>
  );
};

export default MainLayout;