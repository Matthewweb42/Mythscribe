// src/renderer/src/components/Sidebar/OutlineTab.tsx
import React from 'react';
import { List } from 'lucide-react';

const OutlineTab: React.FC = () => {
  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#252526'
    }}>
      <div style={{ flex: 1, padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
        <List size={48} color="#888" />
        <div style={{ textAlign: 'center', color: '#888', fontSize: '13px' }}>
          <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Outline</div>
          <div>Coming in Phase 5!</div>
          <div style={{ fontSize: '11px', marginTop: '8px' }}>
            Plan your story with cork board view,<br/>
            outline trees, and plot threads.
          </div>
        </div>
      </div>
    </div>
  );
};

export default OutlineTab;
