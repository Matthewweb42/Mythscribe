// src/renderer/src/components/Editor/InlineTagAutocomplete.tsx
import React, { useEffect, useRef } from 'react';

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

  // Filter tags based on search query and remove duplicates
  const filteredTags = tags
    .filter(tag => tag.name.toLowerCase().includes(searchQuery.toLowerCase()))
    .filter((tag, index, self) =>
      // Remove duplicates - keep only the first occurrence of each unique tag ID
      index === self.findIndex(t => t.id === tag.id)
    );

  // Calculate dynamic width based on longest tag name
  const calculateDynamicWidth = () => {
    if (filteredTags.length === 0) return 250;

    const longestTag = filteredTags.reduce((longest, tag) => {
      const tagLength = tag.name.length + (tag.category?.length || 0);
      const currentLongest = longest.name.length + (longest.category?.length || 0);
      return tagLength > currentLongest ? tag : longest;
    }, filteredTags[0]);

    // Estimate width: ~8px per character + padding + icons + category badge
    const estimatedWidth = Math.max(250, Math.min(500, longestTag.name.length * 8 + 100));
    return estimatedWidth;
  };

  const dynamicWidth = calculateDynamicWidth();

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
          width: `${dynamicWidth}px`,
          backgroundColor: '#252526',
          border: '1px solid #3c3c3c',
          borderRadius: '3px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
          padding: '4px',
          zIndex: 1000
        }}
      >
        <div style={{
          padding: '4px 8px',
          color: '#888',
          fontSize: '11px',
          textAlign: 'center'
        }}>
          No tags found
          <div style={{ marginTop: '2px', fontSize: '10px', color: '#666' }}>
            <kbd style={{ backgroundColor: '#333', padding: '1px 3px', borderRadius: '2px', fontSize: '9px' }}>Tab</kbd> to create
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
        width: `${dynamicWidth}px`,
        maxHeight: '200px',
        overflow: 'auto',
        backgroundColor: '#252526',
        border: '1px solid #3c3c3c',
        borderRadius: '3px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        padding: '2px',
        zIndex: 1000,
        fontSize: '12px'
      }}
    >
      {/* Tag list - no header for compact design */}
      {filteredTags.map((tag, index) => (
        <button
          key={tag.id}
          data-index={index}
          onClick={() => onSelect(tag)}
          style={{
            width: '100%',
            padding: '4px 8px',
            backgroundColor: index === selectedIndex ? '#094771' : 'transparent',
            color: '#d4d4d4',
            border: 'none',
            textAlign: 'left',
            cursor: 'pointer',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            transition: 'background-color 0.05s',
            borderRadius: '2px'
          }}
          onMouseEnter={(e) => {
            if (index !== selectedIndex) {
              e.currentTarget.style.backgroundColor = '#2a2d2e';
            }
          }}
          onMouseLeave={(e) => {
            if (index !== selectedIndex) {
              e.currentTarget.style.backgroundColor = 'transparent';
            }
          }}
        >
          {/* Color indicator - smaller */}
          <div
            style={{
              width: '10px',
              height: '10px',
              backgroundColor: tag.color,
              borderRadius: '2px',
              flexShrink: 0
            }}
          />

          {/* Tag name */}
          <span style={{ flex: 1, fontWeight: '400' }}>
            {tag.name}
          </span>

          {/* Category badge - more subtle */}
          {tag.category && (
            <span style={{
              fontSize: '9px',
              padding: '1px 4px',
              backgroundColor: 'rgba(255,255,255,0.08)',
              borderRadius: '2px',
              color: '#888'
            }}>
              {tag.category}
            </span>
          )}

          {/* Usage count - smaller */}
          {tag.usage_count > 0 && (
            <span style={{
              fontSize: '9px',
              color: '#666'
            }}>
              {tag.usage_count}×
            </span>
          )}
        </button>
      ))}
    </div>
  );
};

export default InlineTagAutocomplete;
