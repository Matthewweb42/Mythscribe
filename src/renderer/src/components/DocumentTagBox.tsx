// src/renderer/src/components/DocumentTagBox.tsx
import React, { useState, useEffect } from 'react';
import { Tag, Plus, X } from 'lucide-react';

interface TagRow {
  id: string;
  name: string;
  category: string | null;
  color: string;
  usage_count: number;
}

interface DocumentTagBoxProps {
  documentId: string | null;
}

const DocumentTagBox: React.FC<DocumentTagBoxProps> = ({ documentId }) => {
  const [documentTags, setDocumentTags] = useState<TagRow[]>([]);
  const [allTags, setAllTags] = useState<TagRow[]>([]);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Load document tags and all available tags
  useEffect(() => {
    if (!documentId) {
      setDocumentTags([]);
      return;
    }

    loadDocumentTags();
    loadAllTags();
  }, [documentId]);

  const loadDocumentTags = async () => {
    if (!documentId) return;

    try {
      const tags = await (window.api as any).documentTag.getForDocument(documentId);
      setDocumentTags(tags);
    } catch (error) {
      console.error('Error loading document tags:', error);
    }
  };

  const loadAllTags = async () => {
    try {
      const tags = await (window.api as any).tag.getAll();
      setAllTags(tags);
    } catch (error) {
      console.error('Error loading all tags:', error);
    }
  };

  const handleAddTag = async (tagId: string) => {
    if (!documentId) return;

    try {
      await (window.api as any).documentTag.add(documentId, tagId, null, null);
      await loadDocumentTags();
      setShowAddMenu(false);
      setSearchQuery('');
    } catch (error) {
      console.error('Error adding tag:', error);
      alert('Failed to add tag');
    }
  };

  const handleRemoveTag = async (tagId: string) => {
    if (!documentId) return;

    try {
      await (window.api as any).documentTag.remove(documentId, tagId);
      await loadDocumentTags();
    } catch (error) {
      console.error('Error removing tag:', error);
      alert('Failed to remove tag');
    }
  };

  // Filter available tags (not already on document)
  const documentTagIds = new Set(documentTags.map(t => t.id));
  const availableTags = allTags.filter(tag => {
    const notOnDocument = !documentTagIds.has(tag.id);
    const matchesSearch = searchQuery === '' ||
      tag.name.toLowerCase().includes(searchQuery.toLowerCase());
    return notOnDocument && matchesSearch;
  });

  if (!documentId) {
    return null;
  }

  return (
    <div style={{
      padding: '12px',
      borderBottom: '1px solid #333',
      backgroundColor: '#1e1e1e'
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '8px'
      }}>
        <Tag size={14} color="#888" />
        <span style={{
          fontSize: '11px',
          fontWeight: 'bold',
          color: '#888',
          textTransform: 'uppercase',
          flex: 1
        }}>
          Document Tags
        </span>
        <button
          onClick={() => setShowAddMenu(!showAddMenu)}
          style={{
            padding: '4px 8px',
            backgroundColor: showAddMenu ? '#333' : 'var(--primary-green)',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '11px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }}
          title="Add tag"
        >
          <Plus size={12} />
          Add
        </button>
      </div>

      {/* Document tags */}
      {documentTags.length > 0 && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px',
          marginBottom: showAddMenu ? '8px' : 0
        }}>
          {documentTags.map(tag => (
            <div
              key={tag.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 8px',
                backgroundColor: tag.color,
                color: '#fff',
                borderRadius: '3px',
                fontSize: '11px',
                fontWeight: 'bold'
              }}
            >
              <span>{tag.name}</span>
              <button
                onClick={() => handleRemoveTag(tag.id)}
                style={{
                  padding: '2px',
                  backgroundColor: 'rgba(0,0,0,0.2)',
                  border: 'none',
                  borderRadius: '2px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center'
                }}
                title="Remove tag"
              >
                <X size={10} color="#fff" />
              </button>
            </div>
          ))}
        </div>
      )}

      {documentTags.length === 0 && !showAddMenu && (
        <div style={{
          padding: '8px',
          textAlign: 'center',
          color: '#666',
          fontSize: '11px'
        }}>
          No tags yet. Click "Add" to tag this document.
        </div>
      )}

      {/* Add tag menu */}
      {showAddMenu && (
        <div style={{
          marginTop: '8px',
          padding: '8px',
          backgroundColor: '#252526',
          border: '1px solid #333',
          borderRadius: '4px'
        }}>
          {/* Search input */}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tags..."
            autoFocus
            style={{
              width: '100%',
              padding: '6px 8px',
              backgroundColor: '#1e1e1e',
              border: '1px solid #555',
              borderRadius: '3px',
              color: '#d4d4d4',
              fontSize: '11px',
              marginBottom: '8px'
            }}
          />

          {/* Available tags */}
          <div style={{
            maxHeight: '150px',
            overflowY: 'auto'
          }}>
            {availableTags.length === 0 && (
              <div style={{
                padding: '8px',
                textAlign: 'center',
                color: '#666',
                fontSize: '11px'
              }}>
                {searchQuery ? 'No matching tags found.' : 'No more tags available.'}
              </div>
            )}

            {availableTags.map(tag => (
              <button
                key={tag.id}
                onClick={() => handleAddTag(tag.id)}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  marginBottom: '4px',
                  backgroundColor: 'transparent',
                  border: `1px solid ${tag.color}`,
                  borderRadius: '3px',
                  color: tag.color,
                  cursor: 'pointer',
                  fontSize: '11px',
                  textAlign: 'left',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = tag.color;
                  e.currentTarget.style.color = '#fff';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.color = tag.color;
                }}
              >
                <div
                  style={{
                    width: '12px',
                    height: '12px',
                    backgroundColor: tag.color,
                    borderRadius: '2px'
                  }}
                />
                <span>{tag.name}</span>
                {tag.category && (
                  <span style={{
                    marginLeft: 'auto',
                    fontSize: '9px',
                    opacity: 0.7
                  }}>
                    {tag.category}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default DocumentTagBox;
