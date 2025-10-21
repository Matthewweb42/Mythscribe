// src/renderer/src/components/DocumentTagBox.tsx
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Tag, Plus, X, Sparkles, Hash, ChevronDown, MapPin, User, Clock, Minimize2 } from 'lucide-react';
import { Descendant } from 'slate';
import { extractInlineTags, inlineTagsToArray } from '../utils/tagParser';
import { DocumentRow } from '../../types/window';

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
  currentDocument?: DocumentRow | null; // The current document being edited
}

const DocumentTagBox: React.FC<DocumentTagBoxProps> = ({ documentId, documentContent, documentNodes, currentDocument }) => {
  const [documentTags, setDocumentTags] = useState<TagRow[]>([]);
  const [allTags, setAllTags] = useState<TagRow[]>([]);

  // Metadata state
  const [location, setLocation] = useState<string>('');
  const [pov, setPov] = useState<string>('');
  const [timelinePosition, setTimelinePosition] = useState<string>('');
  const metadataSaveTimeout = useRef<NodeJS.Timeout | null>(null);

  // Bar collapse state (entire bar toggleable)
  const [isBarCollapsed, setIsBarCollapsed] = useState<boolean>(() => {
    const saved = localStorage.getItem('tagMetadataBarCollapsed');
    return saved ? saved === 'true' : false; // Default expanded
  });

  // Resizable split panel state (horizontal)
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    const saved = localStorage.getItem('tagMetadataSplitRatio');
    return saved ? parseFloat(saved) : 0.6; // Default 60/40 split
  });
  const [isDragging, setIsDragging] = useState(false);

  // Vertical resize state
  const [barHeight, setBarHeight] = useState<number>(() => {
    const saved = localStorage.getItem('tagMetadataBarHeight');
    return saved ? parseInt(saved) : 250; // Default 250px
  });
  const [isResizingHeight, setIsResizingHeight] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

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

  // Load document tags and all available tags
  useEffect(() => {
    if (!documentId) {
      setDocumentTags([]);
      return;
    }

    loadDocumentTags();
    loadAllTags();
    loadMetadata();
  }, [documentId]);

  // Load metadata when document changes
  const loadMetadata = async () => {
    if (!documentId || !currentDocument) {
      setLocation('');
      setPov('');
      setTimelinePosition('');
      return;
    }

    // Load from currentDocument if available
    setLocation(currentDocument.location || '');
    setPov(currentDocument.pov || '');
    setTimelinePosition(currentDocument.timeline_position || '');
  };

  // Update metadata state when currentDocument changes
  useEffect(() => {
    loadMetadata();
  }, [currentDocument]);

  // Persist bar collapsed state to localStorage
  useEffect(() => {
    localStorage.setItem('tagMetadataBarCollapsed', isBarCollapsed.toString());
  }, [isBarCollapsed]);

  // Persist split ratio to localStorage
  useEffect(() => {
    localStorage.setItem('tagMetadataSplitRatio', splitRatio.toString());
  }, [splitRatio]);

  // Persist bar height to localStorage
  useEffect(() => {
    localStorage.setItem('tagMetadataBarHeight', barHeight.toString());
  }, [barHeight]);

  // Toggle entire bar collapse/expand
  const toggleBar = useCallback(() => {
    setIsBarCollapsed(prev => !prev);
  }, []);

  // Handle horizontal drag to resize panels left/right
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !containerRef.current) return;

    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();
    const offsetX = e.clientX - containerRect.left;
    const newRatio = offsetX / containerRect.width;

    // Constrain ratio between 0.3 and 0.7 (30%-70%)
    const constrainedRatio = Math.max(0.3, Math.min(0.7, newRatio));
    setSplitRatio(constrainedRatio);
  }, [isDragging]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Handle vertical drag to resize bar height
  const handleHeightMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingHeight(true);
  }, []);

  const handleHeightMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizingHeight || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const newHeight = e.clientY - containerRect.top;
    const viewportHeight = window.innerHeight;

    // Constrain between 100px and 60% of viewport
    const minHeight = 100;
    const maxHeight = viewportHeight * 0.6;
    const constrainedHeight = Math.max(minHeight, Math.min(maxHeight, newHeight));

    setBarHeight(constrainedHeight);
  }, [isResizingHeight]);

  const handleHeightMouseUp = useCallback(() => {
    setIsResizingHeight(false);
  }, []);

  // Attach/detach mouse event listeners for horizontal dragging
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
    return undefined;
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Attach/detach mouse event listeners for vertical dragging
  useEffect(() => {
    if (isResizingHeight) {
      window.addEventListener('mousemove', handleHeightMouseMove);
      window.addEventListener('mouseup', handleHeightMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleHeightMouseMove);
        window.removeEventListener('mouseup', handleHeightMouseUp);
      };
    }
    return undefined;
  }, [isResizingHeight, handleHeightMouseMove, handleHeightMouseUp]);

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

  // Metadata handlers
  const saveMetadata = useCallback(async (loc: string, p: string, time: string) => {
    if (!documentId) return;

    try {
      await window.api.document.updateMetadata(
        documentId,
        loc || null,
        p || null,
        time || null
      );
    } catch (error) {
      console.error('Error saving metadata:', error);
    }
  }, [documentId]);

  const handleMetadataChange = useCallback((field: 'location' | 'pov' | 'timeline', value: string) => {
    // Update local state immediately
    if (field === 'location') setLocation(value);
    else if (field === 'pov') setPov(value);
    else if (field === 'timeline') setTimelinePosition(value);

    // Debounced save
    if (metadataSaveTimeout.current) {
      clearTimeout(metadataSaveTimeout.current);
    }

    metadataSaveTimeout.current = setTimeout(() => {
      const newLocation = field === 'location' ? value : location;
      const newPov = field === 'pov' ? value : pov;
      const newTimeline = field === 'timeline' ? value : timelinePosition;
      saveMetadata(newLocation, newPov, newTimeline);
    }, 500);
  }, [location, pov, timelinePosition, saveMetadata]);

  // Get setting and character tags for autocomplete
  const settingTags = useMemo(() =>
    allTags.filter(tag => tag.category === 'setting'),
    [allTags]
  );

  const characterTags = useMemo(() =>
    allTags.filter(tag => tag.category === 'character'),
    [allTags]
  );

  // Determine if metadata section should be shown
  const shouldShowMetadata = currentDocument &&
    (currentDocument.hierarchy_level === 'scene' ||
     currentDocument.hierarchy_level === 'chapter' ||
     currentDocument.hierarchy_level === 'part');

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

  // If bar is collapsed, show thin collapsed bar
  if (isBarCollapsed) {
    return (
      <div style={{
        padding: '6px 12px',
        borderBottom: '1px solid #333',
        backgroundColor: '#1e1e1e',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        minHeight: '24px'
      }}>
        <button
          onClick={toggleBar}
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
            gap: '6px',
            fontWeight: 'bold'
          }}
          title="Expand tags and metadata"
        >
          <ChevronDown size={12} />
          Show Tags
        </button>
      </div>
    );
  }

  // Calculate panel widths (swapped: metadata left 40%, tags right 60%)
  const leftPanelWidth = shouldShowMetadata ? `${(1 - splitRatio) * 100}%` : '100%'; // 40% when metadata visible
  const rightPanelWidth = shouldShowMetadata ? `${splitRatio * 100}%` : '100%'; // 60% when metadata visible

  return (
    <div
      ref={containerRef}
      style={{
        padding: '12px',
        paddingBottom: '0', // Remove bottom padding for drag handle
        borderBottom: '1px solid #333',
        backgroundColor: '#1e1e1e',
        display: 'flex',
        gap: '0',
        position: 'relative',
        height: `${barHeight}px`,
        minHeight: '100px',
        maxHeight: '60vh',
        overflow: 'hidden'
      }}
    >
      {/* LEFT PANEL - Metadata Section (40%) */}
      {shouldShowMetadata && (
        <div style={{
          width: leftPanelWidth,
          minWidth: '200px',
          paddingRight: '8px',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width 0.2s ease',
          overflow: 'auto'
        }}>
          {/* Metadata Header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '8px'
          }}>
            <MapPin size={14} color="#888" />
            <span style={{
                fontSize: '11px',
                fontWeight: 'bold',
                color: '#888',
                textTransform: 'uppercase',
                userSelect: 'none',
                flex: 1
              }}
            >
              Metadata
            </span>
          </div>

          {/* Metadata Fields - always expanded */}
          <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }}>
              {/* Location Field */}
              <div>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '10px',
                  color: '#888',
                  marginBottom: '4px',
                  fontWeight: 'bold'
                }}>
                  <MapPin size={10} />
                  LOCATION/SETTING
                </label>
                <input
                  type="text"
                  value={location}
                  onChange={(e) => handleMetadataChange('location', e.target.value)}
                  placeholder="Enter location or select from settings..."
                  list="location-suggestions"
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    backgroundColor: '#252526',
                    border: '1px solid #555',
                    borderRadius: '3px',
                    color: '#d4d4d4',
                    fontSize: '11px'
                  }}
                />
                <datalist id="location-suggestions">
                  {settingTags.map(tag => (
                    <option key={tag.id} value={tag.name} />
                  ))}
                </datalist>
              </div>

              {/* POV Field */}
              <div>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '10px',
                  color: '#888',
                  marginBottom: '4px',
                  fontWeight: 'bold'
                }}>
                  <User size={10} />
                  POV CHARACTER
                </label>
                <input
                  type="text"
                  value={pov}
                  onChange={(e) => handleMetadataChange('pov', e.target.value)}
                  placeholder="Enter POV character..."
                  list="pov-suggestions"
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    backgroundColor: '#252526',
                    border: '1px solid #555',
                    borderRadius: '3px',
                    color: '#d4d4d4',
                    fontSize: '11px'
                  }}
                />
                <datalist id="pov-suggestions">
                  {characterTags.map(tag => (
                    <option key={tag.id} value={tag.name} />
                  ))}
                </datalist>
              </div>

              {/* Timeline Position Field */}
              <div>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '10px',
                  color: '#888',
                  marginBottom: '4px',
                  fontWeight: 'bold'
                }}>
                  <Clock size={10} />
                  TIMELINE POSITION
                </label>
                <input
                  type="text"
                  value={timelinePosition}
                  onChange={(e) => handleMetadataChange('timeline', e.target.value)}
                  placeholder="e.g., Day 3, Morning or Chapter 2 + 3 hours"
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    backgroundColor: '#252526',
                    border: '1px solid #555',
                    borderRadius: '3px',
                    color: '#d4d4d4',
                    fontSize: '11px'
                  }}
                />
                <div style={{
                  fontSize: '9px',
                  color: '#666',
                  marginTop: '4px',
                  fontStyle: 'italic'
                }}>
                  Note: Timeline picker integration coming in Phase 3
                </div>
              </div>
            </div>
        </div>
      )}
      {/* END LEFT PANEL */}

      {/* DRAG DIVIDER */}
      {shouldShowMetadata && (
        <div
          onMouseDown={handleMouseDown}
          style={{
            width: '5px',
            cursor: 'col-resize',
            backgroundColor: isDragging ? '#0e639c' : '#333',
            transition: isDragging ? 'none' : 'background-color 0.2s ease',
            flexShrink: 0,
            userSelect: 'none'
          }}
          onMouseEnter={(e) => {
            if (!isDragging) e.currentTarget.style.backgroundColor = '#555';
          }}
          onMouseLeave={(e) => {
            if (!isDragging) e.currentTarget.style.backgroundColor = '#333';
          }}
        />
      )}

      {/* RIGHT PANEL - Document Tags Section (60%) */}
      <div style={{
        width: rightPanelWidth,
        minWidth: shouldShowMetadata ? '200px' : 'auto',
        paddingLeft: shouldShowMetadata ? '8px' : '0',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 0.2s ease',
        overflow: 'auto'
      }}>
        {/* Document Tags Header */}
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
            flex: 1,
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
        <button
          onClick={toggleBar}
          style={{
            padding: '4px 6px',
            backgroundColor: 'transparent',
            border: '1px solid #555',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            color: '#888',
            fontSize: '10px'
          }}
          title="Minimize bar"
        >
          <Minimize2 size={12} />
        </button>
      </div>

      {/* Document tags - always show content when bar is expanded */}
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

        {/* Inline Tags Section - now in left panel, always expanded */}
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
              <Hash size={14} color="#888" />
              <span style={{
                  fontSize: '11px',
                  fontWeight: 'bold',
                  color: '#888',
                  textTransform: 'uppercase',
                  userSelect: 'none'
                }}
              >
                Inline Tags
              </span>
            </div>
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
          </div>
        )}
      </div>
      {/* END RIGHT PANEL */}

      {/* Horizontal drag handle for vertical resizing */}
      <div
        onMouseDown={handleHeightMouseDown}
        style={{
          height: '5px',
          cursor: 'row-resize',
          backgroundColor: isResizingHeight ? '#0e639c' : '#333',
          transition: isResizingHeight ? 'none' : 'background-color 0.2s ease',
          width: '100%',
          position: 'absolute',
          bottom: 0,
          left: 0,
          flexShrink: 0,
          userSelect: 'none'
        }}
        onMouseEnter={(e) => {
          if (!isResizingHeight) e.currentTarget.style.backgroundColor = '#555';
        }}
        onMouseLeave={(e) => {
          if (!isResizingHeight) e.currentTarget.style.backgroundColor = '#333';
        }}
      />
    </div>
  );
};

export default DocumentTagBox;
