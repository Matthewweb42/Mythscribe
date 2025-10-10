// src/renderer/src/components/Sidebar/WorldBuildingTab.tsx
import React from 'react';
import { Globe, Plus } from 'lucide-react';

const WorldBuildingTab: React.FC = () => {
  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#252526'
    }}>
      <div style={{ flex: 1, padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
        <Globe size={48} color="#888" />
        <div style={{ textAlign: 'center', color: '#888', fontSize: '13px' }}>
          <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>World Building</div>
          <div>Coming in Phase 4!</div>
          <div style={{ fontSize: '11px', marginTop: '8px' }}>
            Document your world's magic systems,<br/>
            cultures, history, and lore.
          </div>
        </div>
      </div>

      <div style={{ padding: '12px', borderTop: '1px solid #333' }}>
        <button
          disabled
          style={{
            width: '100%',
            padding: '8px',
            backgroundColor: '#333',
            color: '#666',
            border: 'none',
            borderRadius: '3px',
            cursor: 'not-allowed',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '4px'
          }}
        >
          <Plus size={14} />
          New Note
        </button>
      </div>
    </div>
  );
};

export default WorldBuildingTab;
