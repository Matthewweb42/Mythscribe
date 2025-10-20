// src/renderer/src/components/TagManagerPanel.tsx
import React, { useState, useEffect } from 'react';
import { Tag, Plus, Edit2, Trash2, Search, Download } from 'lucide-react';
import { useNotification } from '../contexts/NotificationContext';
import { ConfirmModal } from './ConfirmModal';

type TagCategory = 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom';

interface TagRow {
  id: string;
  name: string;
  category: TagCategory | null;
  parent_tag_id: string | null;
  color: string;
  usage_count: number;
  created: string;
  modified: string;
}

const TagManagerPanel: React.FC = () => {
  const { showSuccess, showError } = useNotification();
  const [tags, setTags] = useState<TagRow[]>([]);
  const [activeCategory, setActiveCategory] = useState<TagCategory | 'all'>('all');
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showNewTagInput, setShowNewTagInput] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#999999');
  const [editingTag, setEditingTag] = useState<TagRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [templates, setTemplates] = useState<any[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [tagToDelete, setTagToDelete] = useState<{ id: string; name: string } | null>(null);
  const [showLoadTemplateConfirm, setShowLoadTemplateConfirm] = useState(false);
  const [templateToLoad, setTemplateToLoad] = useState<any | null>(null);

  // Load tags on mount
  useEffect(() => {
    loadTags();
  }, []);

  const loadTags = async () => {
    try {
      const allTags = await (window.api as any).tag.getAll();
      setTags(allTags);
    } catch (error) {
      console.error('Error loading tags:', error);
    }
  };

  const categories = [
    { key: 'all' as const, label: 'All Tags', color: '#999999' },
    { key: 'character' as TagCategory, label: 'Characters', color: '#ef4444' },
    { key: 'setting' as TagCategory, label: 'Settings', color: '#f97316' },
    { key: 'worldBuilding' as TagCategory, label: 'World Building', color: '#14b8a6' },
    { key: 'tone' as TagCategory, label: 'Tone', color: '#3b82f6' },
    { key: 'content' as TagCategory, label: 'Content', color: '#22c55e' },
    { key: 'plot-thread' as TagCategory, label: 'Plot Threads', color: '#a855f7' },
    { key: 'custom' as TagCategory, label: 'Custom', color: '#999999' }
  ];

  // Filter tags by category and search query
  const filteredTags = tags.filter(tag => {
    const matchesCategory = activeCategory === 'all' || tag.category === activeCategory;
    const matchesSearch = searchQuery === '' ||
      tag.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const selectedTag = tags.find(t => t.id === selectedTagId);

  const handleCreateTag = async () => {
    if (!newTagName.trim()) return;

    try {
      const category = activeCategory === 'all' ? null : activeCategory;
      await (window.api as any).tag.create(newTagName, category, newTagColor, null);
      await loadTags();
      setNewTagName('');
      setNewTagColor('#999999');
      setShowNewTagInput(false);
      showSuccess(`Tag "${newTagName}" created successfully!`);
    } catch (error) {
      console.error('Error creating tag:', error);
      showError('Failed to create tag');
    }
  };

  const handleStartEdit = (tag: TagRow) => {
    setEditingTag(tag);
    setEditName(tag.name);
    setEditColor(tag.color);
  };

  const handleSaveEdit = async () => {
    if (!editingTag || !editName.trim()) return;

    try {
      await (window.api as any).tag.update(editingTag.id, editName, editColor, editingTag.category);
      await loadTags();
      showSuccess(`Tag "${editName}" updated successfully!`);
      setEditingTag(null);
      setEditName('');
      setEditColor('');
    } catch (error) {
      console.error('Error updating tag:', error);
      showError('Failed to update tag');
    }
  };

  const handleDeleteTag = (tagId: string, tagName: string) => {
    setTagToDelete({ id: tagId, name: tagName });
    setShowDeleteConfirm(true);
  };

  const confirmDeleteTag = async () => {
    if (!tagToDelete) return;

    try {
      await (window.api as any).tag.delete(tagToDelete.id);
      await loadTags();
      if (selectedTagId === tagToDelete.id) {
        setSelectedTagId(null);
      }
      showSuccess(`Tag "${tagToDelete.name}" deleted successfully!`);
      setShowDeleteConfirm(false);
      setTagToDelete(null);
    } catch (error) {
      console.error('Error deleting tag:', error);
      showError('Failed to delete tag');
    }
  };

  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const allTemplates = await (window.api as any).tagTemplate.getAll();
      setTemplates(allTemplates);
    } catch (error) {
      console.error('Error loading templates:', error);
      showError('Failed to load templates');
    } finally {
      setLoadingTemplates(false);
    }
  };

  const handleLoadTemplate = (template: any) => {
    setTemplateToLoad(template);
    setShowLoadTemplateConfirm(true);
  };

  const confirmLoadTemplate = async () => {
    if (!templateToLoad) return;

    try {
      const templateData = JSON.parse(templateToLoad.tags_json);

      // Create tags from template
      for (const categoryDef of templateData.categories) {
        const { category, color, tags: tagNames } = categoryDef;

        for (const tagName of tagNames) {
          // Check if tag already exists
          const existingTag = tags.find(t => t.name === tagName && t.category === category);
          if (existingTag) {
            console.log(`Tag "${tagName}" already exists, skipping`);
            continue;
          }

          // Create the tag
          await (window.api as any).tag.create(tagName, category, color, null);
        }
      }

      await loadTags();
      setShowTemplateModal(false);
      setShowLoadTemplateConfirm(false);
      setTemplateToLoad(null);
      showSuccess(`Template "${templateToLoad.name}" loaded successfully!`);
    } catch (error) {
      console.error('Error loading template:', error);
      showError('Failed to load template');
    }
  };

  const handleShowTemplateModal = () => {
    setShowTemplateModal(true);
    loadTemplates();
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
        display: 'flex',
        alignItems: 'center',
        gap: '8px'
      }}>
        <Tag size={16} color="#888" />
        <span style={{
          fontWeight: 'bold',
          fontSize: '12px',
          textTransform: 'uppercase',
          color: '#888',
          flex: 1
        }}>
          Tag Manager
        </span>
        <button
          onClick={handleShowTemplateModal}
          style={{
            padding: '4px 8px',
            backgroundColor: '#0e639c',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '11px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }}
          title="Load tag template"
        >
          <Download size={12} />
          Load Template
        </button>
      </div>

      {/* Search bar */}
      <div style={{ padding: '8px', borderBottom: '1px solid #333' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          backgroundColor: '#1e1e1e',
          border: '1px solid #333',
          borderRadius: '4px',
          padding: '6px 8px'
        }}>
          <Search size={14} color="#888" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tags..."
            style={{
              flex: 1,
              marginLeft: '8px',
              backgroundColor: 'transparent',
              border: 'none',
              color: '#d4d4d4',
              fontSize: '12px',
              outline: 'none'
            }}
          />
        </div>
      </div>

      {/* Category tabs */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        borderBottom: '1px solid #333',
        padding: '4px'
      }}>
        {categories.map(cat => (
          <button
            key={cat.key}
            onClick={() => {
              setActiveCategory(cat.key);
              setSelectedTagId(null);
              setShowNewTagInput(false);
            }}
            style={{
              padding: '6px 10px',
              margin: '2px',
              backgroundColor: activeCategory === cat.key ? '#1e1e1e' : 'transparent',
              color: activeCategory === cat.key ? '#fff' : '#888',
              border: 'none',
              borderBottom: activeCategory === cat.key ? `2px solid ${cat.color}` : 'none',
              cursor: 'pointer',
              fontSize: '11px',
              borderRadius: '3px 3px 0 0'
            }}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Tag list */}
      <div style={{
        flex: selectedTagId ? 0.5 : 1,
        overflow: 'auto',
        padding: '8px'
      }}>
        {filteredTags.length === 0 && !showNewTagInput && (
          <div style={{
            padding: '20px',
            textAlign: 'center',
            color: '#888',
            fontSize: '13px'
          }}>
            {searchQuery ? 'No tags match your search.' : 'No tags yet. Create one below!'}
          </div>
        )}

        {filteredTags.map(tag => (
          <div
            key={tag.id}
            onClick={() => setSelectedTagId(tag.id === selectedTagId ? null : tag.id)}
            style={{
              padding: '10px',
              marginBottom: '4px',
              backgroundColor: tag.id === selectedTagId ? '#37373d' : 'transparent',
              borderRadius: '4px',
              cursor: 'pointer',
              borderLeft: `3px solid ${tag.color}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
            onMouseEnter={(e) => {
              if (tag.id !== selectedTagId) {
                e.currentTarget.style.backgroundColor = '#2a2d2e';
              }
            }}
            onMouseLeave={(e) => {
              if (tag.id !== selectedTagId) {
                e.currentTarget.style.backgroundColor = 'transparent';
              }
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '13px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>{tag.name}</span>
                {tag.usage_count > 0 && (
                  <span style={{
                    fontSize: '10px',
                    color: '#888',
                    backgroundColor: '#1e1e1e',
                    padding: '2px 6px',
                    borderRadius: '10px'
                  }}>
                    {tag.usage_count} uses
                  </span>
                )}
              </div>
              {tag.category && (
                <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>
                  {categories.find(c => c.key === tag.category)?.label}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '4px' }} onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => handleStartEdit(tag)}
                style={{
                  padding: '4px',
                  backgroundColor: 'transparent',
                  border: '1px solid #555',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center'
                }}
                title="Edit tag"
              >
                <Edit2 size={12} color="#888" />
              </button>
              <button
                onClick={() => handleDeleteTag(tag.id, tag.name)}
                style={{
                  padding: '4px',
                  backgroundColor: 'transparent',
                  border: '1px solid #555',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center'
                }}
                title="Delete tag"
              >
                <Trash2 size={12} color="#ef4444" />
              </button>
            </div>
          </div>
        ))}

        {/* New tag input */}
        {showNewTagInput && (
          <div style={{ marginTop: '8px', padding: '8px', backgroundColor: '#1e1e1e', borderRadius: '4px' }}>
            <input
              type="text"
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') handleCreateTag();
                if (e.key === 'Escape') setShowNewTagInput(false);
              }}
              placeholder="Tag name..."
              autoFocus
              style={{
                width: '100%',
                padding: '8px',
                backgroundColor: '#252526',
                border: '1px solid #555',
                borderRadius: '4px',
                color: '#d4d4d4',
                fontSize: '12px',
                marginBottom: '8px'
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <label style={{ fontSize: '11px', color: '#888' }}>Color:</label>
              <input
                type="color"
                value={newTagColor}
                onChange={(e) => setNewTagColor(e.target.value)}
                style={{
                  width: '40px',
                  height: '24px',
                  border: '1px solid #555',
                  borderRadius: '3px',
                  cursor: 'pointer'
                }}
              />
              <div style={{
                flex: 1,
                padding: '4px 8px',
                backgroundColor: newTagColor,
                borderRadius: '3px',
                fontSize: '11px',
                color: '#fff',
                textAlign: 'center'
              }}>
                {newTagName || 'Preview'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                onClick={handleCreateTag}
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
                onClick={() => {
                  setShowNewTagInput(false);
                  setNewTagName('');
                  setNewTagColor('#999999');
                }}
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
        {!showNewTagInput && (
          <button
            onClick={() => {
              setShowNewTagInput(true);
              if (activeCategory !== 'all') {
                const categoryColor = categories.find(c => c.key === activeCategory)?.color;
                if (categoryColor) setNewTagColor(categoryColor);
              }
            }}
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
            New Tag
          </button>
        )}
      </div>

      {/* Edit modal */}
      {editingTag && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            backgroundColor: '#252526',
            padding: '20px',
            borderRadius: '8px',
            border: '1px solid #333',
            minWidth: '300px'
          }}>
            <h3 style={{ marginTop: 0, marginBottom: '16px', fontSize: '14px' }}>
              Edit Tag
            </h3>

            <label style={{ fontSize: '11px', color: '#888', display: 'block', marginBottom: '4px' }}>
              Name:
            </label>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              style={{
                width: '100%',
                padding: '8px',
                backgroundColor: '#1e1e1e',
                border: '1px solid #555',
                borderRadius: '4px',
                color: '#d4d4d4',
                fontSize: '12px',
                marginBottom: '12px'
              }}
            />

            <label style={{ fontSize: '11px', color: '#888', display: 'block', marginBottom: '4px' }}>
              Color:
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
              <input
                type="color"
                value={editColor}
                onChange={(e) => setEditColor(e.target.value)}
                style={{
                  width: '40px',
                  height: '28px',
                  border: '1px solid #555',
                  borderRadius: '3px',
                  cursor: 'pointer'
                }}
              />
              <div style={{
                flex: 1,
                padding: '6px 12px',
                backgroundColor: editColor,
                borderRadius: '3px',
                fontSize: '12px',
                color: '#fff',
                textAlign: 'center'
              }}>
                {editName || 'Preview'}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handleSaveEdit}
                style={{
                  flex: 1,
                  padding: '8px',
                  backgroundColor: '#0e639c',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12px'
                }}
              >
                Save
              </button>
              <button
                onClick={() => {
                  setEditingTag(null);
                  setEditName('');
                  setEditColor('');
                }}
                style={{
                  flex: 1,
                  padding: '8px',
                  backgroundColor: '#333',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12px'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Selected tag detail */}
      {selectedTag && !editingTag && (
        <div style={{
          flex: 0.5,
          borderTop: '1px solid #333',
          padding: '16px',
          overflow: 'auto',
          backgroundColor: '#1e1e1e'
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            marginBottom: '16px'
          }}>
            <div style={{
              width: '40px',
              height: '40px',
              backgroundColor: selectedTag.color,
              borderRadius: '6px'
            }} />
            <div>
              <h3 style={{ margin: 0, fontSize: '16px' }}>{selectedTag.name}</h3>
              <div style={{ fontSize: '11px', color: '#666', marginTop: '4px' }}>
                {selectedTag.category ? categories.find(c => c.key === selectedTag.category)?.label : 'No category'}
              </div>
            </div>
          </div>

          <div style={{ fontSize: '12px', color: '#888', marginBottom: '8px' }}>
            <strong>Usage:</strong> {selectedTag.usage_count} {selectedTag.usage_count === 1 ? 'time' : 'times'}
          </div>

          <div style={{ fontSize: '11px', color: '#666' }}>
            <div>Created: {new Date(selectedTag.created).toLocaleString()}</div>
            <div>Modified: {new Date(selectedTag.modified).toLocaleString()}</div>
          </div>
        </div>
      )}

      {/* Template loading modal */}
      {showTemplateModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            backgroundColor: '#252526',
            padding: '20px',
            borderRadius: '8px',
            border: '1px solid #333',
            minWidth: '400px',
            maxWidth: '600px',
            maxHeight: '70vh',
            overflow: 'auto'
          }}>
            <h3 style={{ marginTop: 0, marginBottom: '16px', fontSize: '16px' }}>
              Load Tag Template
            </h3>

            {loadingTemplates && (
              <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>
                Loading templates...
              </div>
            )}

            {!loadingTemplates && templates.length === 0 && (
              <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>
                No templates available.
              </div>
            )}

            {!loadingTemplates && templates.length > 0 && (
              <div style={{ marginBottom: '16px' }}>
                {templates.map(template => {
                  const templateData = JSON.parse(template.tags_json);
                  const totalTags = templateData.categories.reduce((sum: number, cat: any) => sum + cat.tags.length, 0);

                  return (
                    <div
                      key={template.id}
                      style={{
                        padding: '12px',
                        marginBottom: '8px',
                        backgroundColor: '#1e1e1e',
                        border: '1px solid #333',
                        borderRadius: '6px'
                      }}
                    >
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: '8px'
                      }}>
                        <h4 style={{ margin: 0, fontSize: '14px' }}>{template.name}</h4>
                        <button
                          onClick={() => handleLoadTemplate(template)}
                          style={{
                            padding: '6px 12px',
                            backgroundColor: 'var(--primary-green)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '11px'
                          }}
                        >
                          Load
                        </button>
                      </div>

                      <div style={{ fontSize: '11px', color: '#888', marginBottom: '8px' }}>
                        {totalTags} tags across {templateData.categories.length} categories
                      </div>

                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {templateData.categories.map((cat: any, idx: number) => (
                          <span
                            key={idx}
                            style={{
                              padding: '3px 8px',
                              backgroundColor: cat.color,
                              color: '#fff',
                              borderRadius: '3px',
                              fontSize: '10px',
                              fontWeight: 'bold'
                            }}
                          >
                            {cat.name} ({cat.tags.length})
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <button
              onClick={() => setShowTemplateModal(false)}
              style={{
                width: '100%',
                padding: '8px',
                backgroundColor: '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '12px'
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Delete Tag Confirmation */}
      <ConfirmModal
        isOpen={showDeleteConfirm}
        title="Delete Tag"
        message={`Delete tag "${tagToDelete?.name}"? This will remove it from all tagged items.`}
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={confirmDeleteTag}
        onCancel={() => {
          setShowDeleteConfirm(false);
          setTagToDelete(null);
        }}
        danger={true}
      />

      {/* Load Template Confirmation */}
      <ConfirmModal
        isOpen={showLoadTemplateConfirm}
        title="Load Template"
        message={`Load "${templateToLoad?.name}" template? This will create all tags from this template.`}
        confirmText="Load Template"
        cancelText="Cancel"
        onConfirm={confirmLoadTemplate}
        onCancel={() => {
          setShowLoadTemplateConfirm(false);
          setTemplateToLoad(null);
        }}
        danger={false}
      />
    </div>
  );
};

export default TagManagerPanel;
