// src/renderer/src/components/ReferencePanel/ReferencePanel.tsx
import React, { useState, useEffect } from 'react';
import { User, MapPin, Globe, Plus, Save } from 'lucide-react';
import { useProject } from '../../contexts/ProjectContext';

type ReferenceCategory = 'character' | 'setting' | 'worldBuilding';

const ReferencePanel: React.FC = () => {
  const { references, createReference, updateReference, loadReferences } = useProject();
  const [activeCategory, setActiveCategory] = useState<ReferenceCategory>('character');
  const [selectedRefId, setSelectedRefId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [showNewRefInput, setShowNewRefInput] = useState(false);
  const [newRefName, setNewRefName] = useState('');

  // Load references when component mounts
  useEffect(() => {
    loadReferences();
  }, [loadReferences]);

  // Update edit content when selection changes
  useEffect(() => {
    const selectedRef = references.find(r => r.id === selectedRefId);
    setEditContent(selectedRef?.content || '');
  }, [selectedRefId, references]);

  const categories = [
    { key: 'character' as ReferenceCategory, label: 'Characters', icon: User },
    { key: 'setting' as ReferenceCategory, label: 'Settings', icon: MapPin },
    { key: 'worldBuilding' as ReferenceCategory, label: 'World', icon: Globe }
  ];

  const currentRefs = references.filter(r => r.category === activeCategory);
  const selectedRef = references.find(r => r.id === selectedRefId);

  const handleCreateReference = async () => {
    if (!newRefName.trim()) return;

    try {
      const id = await createReference(newRefName, activeCategory);
      setSelectedRefId(id);
      setNewRefName('');
      setShowNewRefInput(false);
    } catch (error) {
      console.error('Error creating reference:', error);
    }
  };

  const handleSave = async () => {
    if (!selectedRefId) return;

    try {
      await updateReference(selectedRefId, editContent);
      alert('Saved!');
    } catch (error) {
      console.error('Error saving reference:', error);
    }
  };

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
              onClick={() => {
                setActiveCategory(cat.key);
                setSelectedRefId(null);
                setShowNewRefInput(false);
              }}
              style={{
                flex: 1,
                padding: '10px',
                backgroundColor: activeCategory === cat.key ? '#1e1e1e' : 'transparent',
                color: activeCategory === cat.key ? '#fff' : '#888',
                border: 'none',
                borderBottom: activeCategory === cat.key ? '2px solid var(--primary-green)' : 'none',
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
        flex: selectedRefId ? 0.4 : 1,
        overflow: 'auto',
        padding: '8px'
      }}>
        {currentRefs.length === 0 && !showNewRefInput && (
          <div style={{ 
            padding: '20px', 
            textAlign: 'center', 
            color: '#888', 
            fontSize: '13px' 
          }}>
            No {categories.find(c => c.key === activeCategory)?.label.toLowerCase()} yet.
            <br />
            Create one below!
          </div>
        )}

        {currentRefs.map(ref => (
          <div
            key={ref.id}
            onClick={() => {
              setSelectedRefId(ref.id === selectedRefId ? null : ref.id);
              setShowNewRefInput(false);
            }}
            style={{
              padding: '10px',
              marginBottom: '4px',
              backgroundColor: ref.id === selectedRefId ? '#37373d' : 'transparent',
              borderRadius: '4px',
              cursor: 'pointer',
              borderLeft: ref.id === selectedRefId ? '3px solid var(--primary-green)' : '3px solid transparent'
            }}
            onMouseEnter={(e) => {
              if (ref.id !== selectedRefId) {
                e.currentTarget.style.backgroundColor = '#2a2d2e';
              }
            }}
            onMouseLeave={(e) => {
              if (ref.id !== selectedRefId) {
                e.currentTarget.style.backgroundColor = 'transparent';
              }
            }}
          >
            <div style={{ fontSize: '13px', fontWeight: 'bold' }}>
              {ref.name}
            </div>
            {ref.content && (
              <div style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>
                {ref.content.substring(0, 50)}{ref.content.length > 50 ? '...' : ''}
              </div>
            )}
          </div>
        ))}

        {/* Input for new reference */}
        {showNewRefInput && (
          <div style={{ marginTop: '8px' }}>
            <input
              type="text"
              value={newRefName}
              onChange={(e) => setNewRefName(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') handleCreateReference();
                if (e.key === 'Escape') setShowNewRefInput(false);
              }}
              placeholder="Name..."
              autoFocus
              style={{
                width: '100%',
                padding: '8px',
                backgroundColor: '#1e1e1e',
                border: '1px solid var(--primary-green)',
                borderRadius: '4px',
                color: '#d4d4d4',
                fontSize: '12px',
                marginBottom: '6px'
              }}
            />
            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                onClick={handleCreateReference}
                style={{
                  flex: 1,
                  padding: '6px',
                  backgroundColor: 'var(--primary-green)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  fontSize: '11px'
                }}
              >
                Create
              </button>
              <button
                onClick={() => setShowNewRefInput(false)}
                style={{
                  flex: 1,
                  padding: '6px',
                  backgroundColor: '#333',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  fontSize: '11px'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Add button */}
        {!showNewRefInput && (
          <button
            onClick={() => setShowNewRefInput(true)}
            style={{
              width: '100%',
              padding: '8px',
              marginTop: '8px',
              backgroundColor: 'var(--primary-green)',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px'
            }}
          >
            <Plus size={16} />
            New {activeCategory === 'character' ? 'Character' : 
                 activeCategory === 'setting' ? 'Setting' : 'Note'}
          </button>
        )}
      </div>

      {/* Detail view */}
      {selectedRef && (
        <div style={{
          flex: 0.6,
          borderTop: '1px solid #333',
          padding: '16px',
          overflow: 'auto',
          backgroundColor: '#1e1e1e',
          display: 'flex',
          flexDirection: 'column'
        }}>
          <h3 style={{ marginTop: 0, marginBottom: '12px', fontSize: '16px' }}>
            {selectedRef.name}
          </h3>
          
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            placeholder="Add details about this reference..."
            style={{
              flex: 1,
              width: '100%',
              minHeight: '200px',
              backgroundColor: '#252526',
              color: '#d4d4d4',
              border: '1px solid #333',
              borderRadius: '4px',
              padding: '12px',
              fontSize: '13px',
              fontFamily: 'inherit',
              resize: 'vertical',
              lineHeight: '1.5'
            }}
          />
          
          <button
            onClick={handleSave}
            style={{
              marginTop: '12px',
              padding: '8px 16px',
              backgroundColor: '#0e639c',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              fontWeight: 'bold'
            }}
          >
            <Save size={16} />
            Save Changes
          </button>

          <div style={{ 
            marginTop: '12px', 
            fontSize: '11px', 
            color: '#666',
            textAlign: 'center'
          }}>
            Last modified: {new Date(selectedRef.modified).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
};

export default ReferencePanel;