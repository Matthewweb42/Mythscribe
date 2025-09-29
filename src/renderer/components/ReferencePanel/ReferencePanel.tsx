// src/renderer/components/ReferencePanel/ReferencePanel.tsx
import React, { useState } from 'react';
import { User, MapPin, Globe } from 'lucide-react';

type ReferenceCategory = 'characters' | 'settings' | 'worldBuilding';

// Mock data
const mockReferences = {
  characters: [
    { id: '1', name: 'John Smith', content: 'Protagonist, 35 years old, detective' },
    { id: '2', name: 'Sarah Connor', content: 'Antagonist, mysterious background' }
  ],
  settings: [
    { id: '3', name: 'Downtown Office', content: 'Glass building, 40th floor' }
  ],
  worldBuilding: [
    { id: '4', name: 'Magic System', content: 'Based on emotional energy' }
  ]
};

const ReferencePanel: React.FC = () => {
  const [activeCategory, setActiveCategory] = useState<ReferenceCategory>('characters');
  const [selectedRef, setSelectedRef] = useState<string | null>(null);

  const categories = [
    { key: 'characters' as ReferenceCategory, label: 'Characters', icon: User },
    { key: 'settings' as ReferenceCategory, label: 'Settings', icon: MapPin },
    { key: 'worldBuilding' as ReferenceCategory, label: 'World', icon: Globe }
  ];

  const currentRefs = mockReferences[activeCategory];
  const selectedRefData = currentRefs.find(r => r.id === selectedRef);

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#252526'
    }}>
      {/* Header */}
      <div style={{
        padding: '12px',
        borderBottom: '1px solid #333',
        fontWeight: 'bold',
        fontSize: '12px',
        textTransform: 'uppercase',
        color: '#888'
      }}>
        References
      </div>

      {/* Category tabs */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid #333'
      }}>
        {categories.map(cat => {
          const Icon = cat.icon;
          return (
            <button
              key={cat.key}
              onClick={() => setActiveCategory(cat.key)}
              style={{
                flex: 1,
                padding: '10px',
                backgroundColor: activeCategory === cat.key ? '#1e1e1e' : 'transparent',
                color: activeCategory === cat.key ? '#fff' : '#888',
                border: 'none',
                borderBottom: activeCategory === cat.key ? '2px solid #0e639c' : 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                fontSize: '12px'
              }}
            >
              <Icon size={14} />
              {cat.label}
            </button>
          );
        })}
      </div>

      {/* Reference list */}
      <div style={{
        flex: selectedRef ? 0.4 : 1,
        overflow: 'auto',
        padding: '8px'
      }}>
        {currentRefs.map(ref => (
          <div
            key={ref.id}
            onClick={() => setSelectedRef(ref.id === selectedRef ? null : ref.id)}
            style={{
              padding: '10px',
              marginBottom: '4px',
              backgroundColor: ref.id === selectedRef ? '#37373d' : 'transparent',
              borderRadius: '4px',
              cursor: 'pointer',
              borderLeft: ref.id === selectedRef ? '3px solid #0e639c' : '3px solid transparent'
            }}
            onMouseEnter={(e) => {
              if (ref.id !== selectedRef) {
                e.currentTarget.style.backgroundColor = '#2a2d2e';
              }
            }}
            onMouseLeave={(e) => {
              if (ref.id !== selectedRef) {
                e.currentTarget.style.backgroundColor = 'transparent';
              }
            }}
          >
            <div style={{ fontSize: '13px', fontWeight: 'bold' }}>
              {ref.name}
            </div>
            <div style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>
              {ref.content.substring(0, 50)}...
            </div>
          </div>
        ))}

        <button style={{
          width: '100%',
          padding: '8px',
          marginTop: '8px',
          backgroundColor: '#0e639c',
          color: '#fff',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '12px'
        }}>
          + New {activeCategory === 'characters' ? 'Character' : 
               activeCategory === 'settings' ? 'Setting' : 'Note'}
        </button>
      </div>

      {/* Detail view */}
      {selectedRef && selectedRefData && (
        <div style={{
          flex: 0.6,
          borderTop: '1px solid #333',
          padding: '16px',
          overflow: 'auto',
          backgroundColor: '#1e1e1e'
        }}>
          <h3 style={{ marginTop: 0, fontSize: '16px' }}>
            {selectedRefData.name}
          </h3>
          <textarea
            defaultValue={selectedRefData.content}
            style={{
              width: '100%',
              height: '200px',
              backgroundColor: '#252526',
              color: '#d4d4d4',
              border: '1px solid #333',
              borderRadius: '4px',
              padding: '8px',
              fontSize: '13px',
              fontFamily: 'inherit',
              resize: 'vertical'
            }}
          />
          <button style={{
            marginTop: '8px',
            padding: '6px 12px',
            backgroundColor: '#0e639c',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '12px'
          }}>
            Save Changes
          </button>
        </div>
      )}
    </div>
  );
};

export default ReferencePanel;