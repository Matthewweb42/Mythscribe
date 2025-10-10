// src/renderer/src/components/Sidebar/SettingsTab.tsx
import React from 'react';
import { MapPin, Plus } from 'lucide-react';

const SettingsTab: React.FC = () => {
  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#252526'
    }}>
      <div style={{ flex: 1, padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
        <MapPin size={48} color="#888" />
        <div style={{ textAlign: 'center', color: '#888', fontSize: '13px' }}>
          <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Settings & Locations</div>
          <div>Coming in Phase 4!</div>
          <div style={{ fontSize: '11px', marginTop: '8px' }}>
            Track locations, places, and settings<br/>
            where your story takes place.
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
          New Setting
        </button>
      </div>
    </div>
  );
};

export default SettingsTab;
