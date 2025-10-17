// src/renderer/src/components/Editor/InlineTagAutocomplete.tsx
import React, { useEffect, useRef } from 'react';
import { Tag } from 'lucide-react';

interface TagRow {
  id: string;
  name: string;
  category: string | null;
  color: string;
  usage_count: number;
}

interface InlineTagAutocompleteProps {
  tags: TagRow[];
  searchQuery: string;
  selectedIndex: number;
  position: { top: number; left: number };
  onSelect: (tag: TagRow) => void;
  onClose: () => void;
}

const InlineTagAutocomplete: React.FC<InlineTagAutocompleteProps> = ({
  tags,
  searchQuery,
  selectedIndex,
  position,
  onSelect,
  onClose
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter tags based on search query
  const filteredTags = tags.filter(tag =>
    tag.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Handle click outside to close
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Scroll selected item into view
  useEffect(() => {
    const selectedElement = containerRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (filteredTags.length === 0) {
    return (
      <div
        ref={containerRef}
        style={{
          position: 'absolute',
          top: `${position.top}px`,
          left: `${position.left}px`,
          minWidth: '250px',
          maxWidth: '350px',
          backgroundColor: '#252526',
          border: '1px solid #454545',
          borderRadius: '4px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          padding: '8px',
          zIndex: 1000
        }}
      >
        <div style={{
          padding: '8px 12px',
          color: '#888',
          fontSize: '12px',
          textAlign: 'center'
        }}>
          No tags found for "{searchQuery}"
          <div style={{ marginTop: '8px', fontSize: '11px' }}>
            Press <strong>Enter</strong> to create new tag
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        top: `${position.top}px`,
        left: `${position.left}px`,
        minWidth: '250px',
        maxWidth: '350px',
        maxHeight: '300px',
        overflow: 'auto',
        backgroundColor: '#252526',
        border: '1px solid #454545',
        borderRadius: '4px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        padding: '4px 0',
        zIndex: 1000
      }}
    >
      {/* Header */}
      <div style={{
        padding: '6px 12px',
        fontSize: '10px',
        color: '#888',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        borderBottom: '1px solid #333',
        marginBottom: '4px'
      }}>
        <Tag size={10} style={{ display: 'inline', marginRight: '4px' }} />
        Tags {searchQuery && `matching "${searchQuery}"`}
      </div>

      {/* Tag list */}
      {filteredTags.map((tag, index) => (
        <button
          key={tag.id}
          data-index={index}
          onClick={() => onSelect(tag)}
          style={{
            width: '100%',
            padding: '8px 12px',
            backgroundColor: index === selectedIndex ? '#0e639c' : 'transparent',
            color: '#d4d4d4',
            border: 'none',
            textAlign: 'left',
            cursor: 'pointer',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            transition: 'background-color 0.1s'
          }}
          onMouseEnter={(e) => {
            if (index !== selectedIndex) {
              e.currentTarget.style.backgroundColor = '#333';
            }
          }}
          onMouseLeave={(e) => {
            if (index !== selectedIndex) {
              e.currentTarget.style.backgroundColor = 'transparent';
            }
          }}
        >
          {/* Color indicator */}
          <div
            style={{
              width: '14px',
              height: '14px',
              backgroundColor: tag.color,
              borderRadius: '2px',
              flexShrink: 0
            }}
          />

          {/* Tag name */}
          <span style={{ flex: 1, fontWeight: '500' }}>
            {tag.name}
          </span>

          {/* Category badge */}
          {tag.category && (
            <span style={{
              fontSize: '10px',
              padding: '2px 6px',
              backgroundColor: 'rgba(255,255,255,0.1)',
              borderRadius: '3px',
              color: '#888'
            }}>
              {tag.category}
            </span>
          )}

          {/* Usage count */}
          {tag.usage_count > 0 && (
            <span style={{
              fontSize: '10px',
              color: '#666',
              marginLeft: 'auto'
            }}>
              {tag.usage_count}×
            </span>
          )}
        </button>
      ))}

      {/* Footer hint */}
      <div style={{
        padding: '6px 12px',
        fontSize: '10px',
        color: '#666',
        borderTop: '1px solid #333',
        marginTop: '4px'
      }}>
        <kbd style={{ backgroundColor: '#333', padding: '2px 4px', borderRadius: '2px' }}>↑↓</kbd> Navigate
        {' • '}
        <kbd style={{ backgroundColor: '#333', padding: '2px 4px', borderRadius: '2px' }}>Enter</kbd> Select
        {' • '}
        <kbd style={{ backgroundColor: '#333', padding: '2px 4px', borderRadius: '2px' }}>Esc</kbd> Cancel
      </div>
    </div>
  );
};

export default InlineTagAutocomplete;
