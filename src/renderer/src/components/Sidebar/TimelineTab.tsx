// src/renderer/src/components/Sidebar/TimelineTab.tsx
import React from 'react';
import { Clock } from 'lucide-react';

const TimelineTab: React.FC = () => {
  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#252526'
    }}>
      <div style={{ flex: 1, padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
        <Clock size={48} color="#888" />
        <div style={{ textAlign: 'center', color: '#888', fontSize: '13px' }}>
          <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Timeline</div>
          <div>Coming in Phase 5!</div>
          <div style={{ fontSize: '11px', marginTop: '8px' }}>
            Track story events, character ages,<br/>
            and maintain continuity.
          </div>
        </div>
      </div>
    </div>
  );
};

export default TimelineTab;
