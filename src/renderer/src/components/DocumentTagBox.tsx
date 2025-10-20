// src/renderer/src/components/DocumentTagBox.tsx
import React, { useState, useEffect, useMemo } from 'react';
import { Tag, Plus, X, Sparkles, Hash, ChevronDown, ChevronRight } from 'lucide-react';
import { Descendant } from 'slate';
import { extractInlineTags, inlineTagsToArray, InlineTag } from '../utils/tagParser';

interface TagRow {
  id: string;
  name: string;
  category: string | null;
  color: string;
  usage_count: number;
}

interface DocumentTagBoxProps {
  documentId: string | null;
  documentContent?: string; // Optional: plain text content of the document (for AI)
  documentNodes?: Descendant[]; // Slate nodes for parsing inline tags
}

const DocumentTagBox: React.FC<DocumentTagBoxProps> = ({ documentId, documentContent, documentNodes }) => {
  const [documentTags, setDocumentTags] = useState<TagRow[]>([]);
  const [allTags, setAllTags] = useState<TagRow[]>([]);

  // Parse inline tags from document nodes
  const inlineTags = useMemo(() => {
    if (!documentNodes) return [];
    const tagMap = extractInlineTags(documentNodes);
    return inlineTagsToArray(tagMap);
  }, [documentNodes]);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestedTags, setSuggestedTags] = useState<TagRow[]>([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isDocumentTagsExpanded, setIsDocumentTagsExpanded] = useState(true);
  const [isInlineTagsExpanded, setIsInlineTagsExpanded] = useState(true);

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

    // Check if tag is already on the document (prevent duplicates)
    const isAlreadyAdded = documentTags.some(tag => tag.id === tagId);
    if (isAlreadyAdded) {
      alert('This tag is already on the document');
      setShowAddMenu(false);
      setSearchQuery('');
      return;
    }

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
      console.log('[DocumentTagBox] Attempting to remove tag:', { documentId, tagId });
      await (window.api as any).documentTag.remove(documentId, tagId);
      console.log('[DocumentTagBox] Tag removed successfully');
      await loadDocumentTags();
    } catch (error: any) {
      console.error('[DocumentTagBox] Error removing tag:', error);
      console.error('[DocumentTagBox] Error details:', { documentId, tagId, errorMessage: error?.message, errorStack: error?.stack });
      alert(`Failed to remove tag: ${error?.message || 'Unknown error'}`);
    }
  };

  const handleRecommendTags = async () => {
    if (!documentId || !documentContent) {
      alert('No document content available for tag suggestions');
      return;
    }

    if (documentContent.trim().length < 50) {
      alert('Document is too short for meaningful tag suggestions. Write at least a few sentences.');
      return;
    }

    setIsLoadingSuggestions(true);
    setShowSuggestions(true);
    setSuggestedTags([]);

    try {
      const suggestions = await (window.api as any).ai.suggestTags(documentContent);

      // Filter out tags that are already on the document
      const documentTagIds = new Set(documentTags.map(t => t.id));
      const newSuggestions = suggestions.filter((tag: TagRow) => !documentTagIds.has(tag.id));

      setSuggestedTags(newSuggestions);

      if (newSuggestions.length === 0) {
        alert('No new tag suggestions found. The AI thinks your current tags are perfect!');
        setShowSuggestions(false);
      }
    } catch (error) {
      console.error('Error getting tag suggestions:', error);
      alert('Failed to get tag suggestions. Make sure your OpenAI API key is configured.');
      setShowSuggestions(false);
    } finally {
      setIsLoadingSuggestions(false);
    }
  };

  const handleAcceptSuggestion = async (tagId: string) => {
    await handleAddTag(tagId);
    // Remove from suggestions
    setSuggestedTags(prev => prev.filter(t => t.id !== tagId));
    if (suggestedTags.length <= 1) {
      setShowSuggestions(false);
    }
  };

  const handleAcceptAllSuggestions = async () => {
    if (!documentId) return;

    try {
      for (const tag of suggestedTags) {
        await (window.api as any).documentTag.add(documentId, tag.id, null, null);
      }
      await loadDocumentTags();
      setSuggestedTags([]);
      setShowSuggestions(false);
    } catch (error) {
      console.error('Error accepting all suggestions:', error);
      alert('Failed to add all suggested tags');
    }
  };

  const handleDismissSuggestions = () => {
    setSuggestedTags([]);
    setShowSuggestions(false);
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
        <button
          onClick={() => setIsDocumentTagsExpanded(!isDocumentTagsExpanded)}
          style={{
            padding: '0',
            backgroundColor: 'transparent',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            color: '#888'
          }}
          title={isDocumentTagsExpanded ? 'Collapse' : 'Expand'}
        >
          {isDocumentTagsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <Tag size={14} color="#888" />
        <span
          onClick={() => setIsDocumentTagsExpanded(!isDocumentTagsExpanded)}
          style={{
            fontSize: '11px',
            fontWeight: 'bold',
            color: '#888',
            textTransform: 'uppercase',
            flex: 1,
            cursor: 'pointer',
            userSelect: 'none'
          }}
        >
          Document Tags
        </span>
        <button
          onClick={handleRecommendTags}
          disabled={isLoadingSuggestions || !documentContent || documentContent.trim().length < 50}
          style={{
            padding: '4px 8px',
            backgroundColor: isLoadingSuggestions ? '#555' : '#0e639c',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: isLoadingSuggestions ? 'wait' : 'pointer',
            fontSize: '11px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            opacity: (!documentContent || documentContent.trim().length < 50) ? 0.5 : 1
          }}
          title={isLoadingSuggestions ? 'Loading suggestions...' : 'Get AI tag recommendations'}
        >
          <Sparkles size={12} />
          {isLoadingSuggestions ? 'Loading...' : 'Recommend'}
        </button>
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

      {/* Document tags - only show if expanded */}
      {isDocumentTagsExpanded && (
        <>
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

          {documentTags.length === 0 && !showAddMenu && !showSuggestions && inlineTags.length === 0 && (
            <div style={{
              padding: '8px',
              textAlign: 'center',
              color: '#666',
              fontSize: '11px'
            }}>
              No tags yet. Click "Add" to tag this document or use #tags inline.
            </div>
          )}

          {/* AI Suggestions */}
          {showSuggestions && suggestedTags.length > 0 && (
            <div style={{
              marginTop: documentTags.length > 0 ? '12px' : '0',
              padding: '12px',
              backgroundColor: '#252526',
              border: '1px solid #0e639c',
              borderRadius: '4px'
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '8px'
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '11px',
                  fontWeight: 'bold',
                  color: '#0e639c'
                }}>
                  <Sparkles size={12} />
                  AI Suggested Tags
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    onClick={handleAcceptAllSuggestions}
                    style={{
                      padding: '3px 8px',
                      backgroundColor: 'var(--primary-green)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '10px',
                      fontWeight: 'bold'
                    }}
                    title="Accept all suggestions"
                  >
                    Accept All
                  </button>
                  <button
                    onClick={handleDismissSuggestions}
                    style={{
                      padding: '3px 8px',
                      backgroundColor: '#555',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '10px'
                    }}
                    title="Dismiss suggestions"
                  >
                    Dismiss
                  </button>
                </div>
              </div>

              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px'
              }}>
                {suggestedTags.map(tag => (
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
                      fontWeight: 'bold',
                      opacity: 0.9
                    }}
                  >
                    <span>{tag.name}</span>
                    <button
                      onClick={() => handleAcceptSuggestion(tag.id)}
                      style={{
                        padding: '2px 6px',
                        backgroundColor: 'rgba(255,255,255,0.3)',
                        border: 'none',
                        borderRadius: '2px',
                        cursor: 'pointer',
                        fontSize: '9px',
                        color: '#fff',
                        fontWeight: 'bold'
                      }}
                      title="Accept this tag"
                    >
                      +
                    </button>
                  </div>
                ))}
              </div>
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
        </>
      )}

      {/* Inline Tags Section */}
      {inlineTags.length > 0 && (
        <div style={{
          marginTop: documentTags.length > 0 ? '12px' : '8px',
          paddingTop: '12px',
          borderTop: documentTags.length > 0 ? '1px solid #333' : 'none'
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '8px'
          }}>
            <button
              onClick={() => setIsInlineTagsExpanded(!isInlineTagsExpanded)}
              style={{
                padding: '0',
                backgroundColor: 'transparent',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                color: '#888'
              }}
              title={isInlineTagsExpanded ? 'Collapse' : 'Expand'}
            >
              {isInlineTagsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            <Hash size={14} color="#888" />
            <span
              onClick={() => setIsInlineTagsExpanded(!isInlineTagsExpanded)}
              style={{
                fontSize: '11px',
                fontWeight: 'bold',
                color: '#888',
                textTransform: 'uppercase',
                cursor: 'pointer',
                userSelect: 'none'
              }}
            >
              Inline Tags
            </span>
          </div>
          {isInlineTagsExpanded && (
            <div style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px'
            }}>
              {inlineTags.map(tag => (
                <div
                  key={tag.id}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '4px 8px',
                    backgroundColor: tag.color,
                    opacity: 0.6,
                    color: '#fff',
                    borderRadius: '3px',
                    fontSize: '11px',
                    fontWeight: 'bold'
                  }}
                  title={`Used ${tag.count} time${tag.count > 1 ? 's' : ''} in this document`}
                >
                  <span>{tag.name}</span>
                  {tag.count > 1 && (
                    <span style={{
                      fontSize: '10px',
                      padding: '1px 4px',
                      backgroundColor: 'rgba(255,255,255,0.3)',
                      borderRadius: '2px'
                    }}>
                      {tag.count}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DocumentTagBox;
