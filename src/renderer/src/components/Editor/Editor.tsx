// src/renderer/src/components/Editor/Editor.tsx
import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { createEditor, Descendant, Editor as SlateEditor, Transforms, Text, Node } from 'slate';
import { Slate, Editable, withReact, RenderLeafProps, RenderElementProps } from 'slate-react';
import { withHistory } from 'slate-history';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
  Bold, Italic, Underline, File, Sparkles,
  Strikethrough, Code, Heading1, Heading2, Heading3,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Quote, Minus, StickyNote, Maximize2, Minimize2
} from 'lucide-react';
import { useProject } from '../../contexts/ProjectContext';
import { DocumentRow } from '../../../types/window';
import aiService from '../../services/aiService';
import DocumentTagBox from '../DocumentTagBox';
import InlineTagAutocomplete from './InlineTagAutocomplete';
import StackedSceneEditor from './StackedSceneEditor';
import EditorStatusBar from './EditorStatusBar';
import BackgroundManager from './BackgroundManager';
import FocusModePanel from './FocusModePanel';
import FloatingNotesPanel from './FloatingNotesPanel';
import FloatingAIPanel from './FloatingAIPanel';

// Custom types for Slate
type CustomText = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  fontSize?: number;
  color?: string;
  backgroundColor?: string;
  ghostSuggestion?: string; // Ghost text to show after this text node
  isTag?: boolean; // Whether this text is a tag
  tagId?: string; // ID of the tag
  tagName?: string; // Name of the tag (for rendering without #)
};

type ParagraphElement = { type: 'paragraph'; align?: 'left' | 'center' | 'right' | 'justify'; children: CustomText[] };
type HeadingElement = { type: 'heading'; level: number; align?: 'left' | 'center' | 'right' | 'justify'; children: CustomText[] };
type BlockQuoteElement = { type: 'blockquote'; children: CustomText[] };
type SceneBreakElement = { type: 'sceneBreak'; children: CustomText[] };
type CustomElement = ParagraphElement | HeadingElement | BlockQuoteElement | SceneBreakElement;

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor & HistoryEditor;
    Element: CustomElement;
    Text: CustomText;
  }
}

// Fix for JSX namespace
declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}

// Import base editor types
import { BaseEditor } from 'slate';
import { ReactEditor } from 'slate-react';
import { HistoryEditor } from 'slate-history';

// Initial empty content
const initialValue: Descendant[] = [
  {
    type: 'paragraph',
    children: [{ text: '' }],
  },
];

// Render leaf (for bold, italic, underline, ghost text, etc.)
const Leaf = ({ attributes, children, leaf }: RenderLeafProps) => {
  let style: React.CSSProperties = {};
  const [isHovering, setIsHovering] = React.useState(false);

  if (leaf.fontSize) {
    style.fontSize = `${leaf.fontSize}px`;
  }
  if (leaf.color) {
    style.color = leaf.color;
  }
  if (leaf.backgroundColor) {
    style.backgroundColor = leaf.backgroundColor;
  }

  // If this is a tag, add interactive styling and hide the # prefix visually
  if (leaf.isTag && leaf.tagName) {
    style.cursor = 'pointer';
    style.borderRadius = '3px';
    style.padding = '2px 6px';
    style.transition = 'opacity 0.2s';
    // Use a pseudo-element approach via className instead
    style.position = 'relative';

    if (isHovering) {
      style.opacity = '0.8';
      style.textDecoration = 'underline';
    }
  }

  if (leaf.bold) {
    children = <strong>{children}</strong>;
  }
  if (leaf.italic) {
    children = <em>{children}</em>;
  }
  if (leaf.underline) {
    children = <u>{children}</u>;
  }
  if (leaf.strikethrough) {
    children = <s>{children}</s>;
  }
  if (leaf.code) {
    children = <code style={{ backgroundColor: '#2d2d30', padding: '2px 4px', borderRadius: '3px', fontFamily: 'monospace' }}>{children}</code>;
  }

  // Add ghost text suggestion after the text if it exists
  if (leaf.ghostSuggestion) {
    children = (
      <>
        {children}
        <span
          contentEditable={false}
          style={{
            color: 'var(--primary-green)',
            opacity: 0.5,
            fontStyle: 'italic',
            pointerEvents: 'none',
            userSelect: 'none'
          }}
        >
          {leaf.ghostSuggestion}
        </span>
      </>
    );
  }

  // Wrap tags to add event handlers and hide # symbol
  if (leaf.isTag && leaf.tagName) {
    return (
      <span
        {...attributes}
        style={style}
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => setIsHovering(false)}
        title={`Tag: ${leaf.tagName}`}
        data-tag-id={leaf.tagId}
        className="inline-tag"
      >
        {children}
      </span>
    );
  }

  return <span {...attributes} style={style}>{children}</span>;
};

// Render element (for paragraphs, headings, blockquotes, scene breaks)
// This will be created inside the Editor component to access formatting settings
const createElementRenderer = (paragraphSpacing: number, paragraphIndent: number, sceneBreakStyle: string) => {
  return ({ attributes, children, element }: RenderElementProps) => {
    const style: React.CSSProperties = {};

    if ('align' in element && element.align) {
      style.textAlign = element.align;
    }

    switch (element.type) {
      case 'heading':
        return React.createElement(`h${element.level}`, { ...attributes, style }, children);
      case 'blockquote':
        return (
          <blockquote {...attributes} style={{
            borderLeft: '3px solid var(--primary-green)',
            paddingLeft: '16px',
            marginLeft: '0',
            fontStyle: 'italic',
            color: '#b0b0b0'
          }}>
            {children}
          </blockquote>
        );
      case 'sceneBreak':
        return (
          <div {...attributes} contentEditable={false} style={{
            textAlign: 'center',
            margin: '20px 0',
            color: '#888',
            fontSize: '20px',
            userSelect: 'none',
            cursor: 'default'
          }}>
            {children}
            <div contentEditable={false}>{sceneBreakStyle}</div>
          </div>
        );
      default:
        // Apply paragraph spacing and indentation
        style.marginBottom = `${paragraphSpacing}em`;
        if (paragraphIndent > 0) {
          style.textIndent = `${paragraphIndent}em`;
        }
        return <p {...attributes} style={style}>{children}</p>;
    }
  };
};

interface EditorProps {
  onInsertTextReady?: (insertFn: (text: string) => void) => void;
  onSetGhostTextReady?: (setGhostTextFn: (text: string) => void) => void;
}

const Editor: React.FC<EditorProps> = ({ onInsertTextReady, onSetGhostTextReady }) => {
  const { activeDocumentId, documents, updateDocumentContent, updateDocumentWordCount, updateDocumentNotes, references } = useProject();
  // Create a new editor instance when the document changes to ensure clean state
  const editor = useMemo(() => withHistory(withReact(createEditor())), [activeDocumentId]);
  const [value, setValue] = useState<Descendant[]>(initialValue);
  const [currentDoc, setCurrentDoc] = useState<DocumentRow | null>(null);
  const [saveTimeout, setSaveTimeout] = useState<NodeJS.Timeout | null>(null);
  const [ghostText, setGhostText] = useState<string>(''); // VibeWrite ghost text
  const [aiAssistantGhostText, setAiAssistantGhostText] = useState<string>(''); // AI Assistant ghost text
  const [isLoadingSuggestion, setIsLoadingSuggestion] = useState(false);
  const [mode, setMode] = useState<'freewrite' | 'vibewrite'>('freewrite');
  const suggestionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastTextRef = useRef<string>(''); // Track the last text to detect what user typed

  // Stats tracking
  const [wordCount, setWordCount] = useState(0);
  const [sessionWordCount, setSessionWordCount] = useState(0);
  const sessionStartWordCount = useRef<number>(0);

  // Editor formatting settings
  const [editorTextSize, setEditorTextSize] = useState(16);
  const [editorLineHeight, setEditorLineHeight] = useState(1.6);
  const [editorParagraphSpacing, setEditorParagraphSpacing] = useState(0);
  const [editorParagraphIndent, setEditorParagraphIndent] = useState(0);
  const [editorMaxWidth, setEditorMaxWidth] = useState(700);
  const [editorSceneBreakStyle, setEditorSceneBreakStyle] = useState('* * *');

  // Notes panel
  const [showNotes, setShowNotes] = useState(false);
  const [notesValue, setNotesValue] = useState<Descendant[]>(initialValue);
  const notesEditor = useMemo(() => withHistory(withReact(createEditor())), []);
  const [notesSaveTimeout, setNotesSaveTimeout] = useState<NodeJS.Timeout | null>(null);

  // Full-screen mode
  const [isFullScreen, setIsFullScreen] = useState(false);

  // Inline tag autocomplete state
  const [showTagAutocomplete, setShowTagAutocomplete] = useState(false);
  const [tagSearchQuery, setTagSearchQuery] = useState('');
  const [tagAutocompletePosition, setTagAutocompletePosition] = useState({ top: 0, left: 0 });
  const [tagSelectedIndex, setTagSelectedIndex] = useState(0);
  const [allTags, setAllTags] = useState<any[]>([]);
  const [hashStartPosition, setHashStartPosition] = useState<{ path: number[]; offset: number } | null>(null);

  // Stacked scene view state (for chapters/parts)
  const [isViewingFolder, setIsViewingFolder] = useState(false);
  const [childScenes, setChildScenes] = useState<DocumentRow[]>([]);

  // Focus mode state
  const [currentBackgroundAssetId, setCurrentBackgroundAssetId] = useState<string | null>(null);
  const [currentBackgroundPath, setCurrentBackgroundPath] = useState<string | null>(null);
  const [showBackgroundManager, setShowBackgroundManager] = useState(false);
  const [focusOverlayOpacity, setFocusOverlayOpacity] = useState(50);
  const [focusWindowWidth, setFocusWindowWidth] = useState(60);
  const [focusWindowOffsetX, setFocusWindowOffsetX] = useState(0);
  const [focusRotationEnabled, setFocusRotationEnabled] = useState(false);
  const [focusRotationInterval, setFocusRotationInterval] = useState(10);
  const [isDraggingWindow, setIsDraggingWindow] = useState(false);
  const [dragStartX, setDragStartX] = useState(0);
  const [showFloatingNotes, setShowFloatingNotes] = useState(false);
  const [showFloatingAI, setShowFloatingAI] = useState(false);

  // Create Element renderer with current formatting settings
  const Element = useMemo(() => createElementRenderer(editorParagraphSpacing, editorParagraphIndent, editorSceneBreakStyle), [editorParagraphSpacing, editorParagraphIndent, editorSceneBreakStyle]);

  // Initialize AI service with API key
  useEffect(() => {
    // Note: API key is now handled securely in the main process via .env file
    // No need to handle API key in renderer process anymore
    console.log('AI Service ready - API key handled by main process');
  }, []);

  // Load editor formatting settings from database
  useEffect(() => {
    const loadEditorSettings = async () => {
      try {
        const textSize = await window.api.settings.get('editor_text_size');
        const lineHeight = await window.api.settings.get('editor_line_height');
        const paragraphSpacing = await window.api.settings.get('editor_paragraph_spacing');
        const paragraphIndent = await window.api.settings.get('editor_paragraph_indent');
        const maxWidth = await window.api.settings.get('editor_max_width');
        const sceneBreakStyle = await window.api.settings.get('editor_scene_break_style');

        if (textSize) setEditorTextSize(parseFloat(textSize));
        if (lineHeight) setEditorLineHeight(parseFloat(lineHeight));
        if (paragraphSpacing) setEditorParagraphSpacing(parseFloat(paragraphSpacing));
        if (paragraphIndent) setEditorParagraphIndent(parseFloat(paragraphIndent));
        if (maxWidth) setEditorMaxWidth(parseFloat(maxWidth));
        if (sceneBreakStyle) setEditorSceneBreakStyle(sceneBreakStyle);
      } catch (error) {
        console.error('Error loading editor settings:', error);
      }
    };

    loadEditorSettings();
  }, []);

  // Load focus mode settings from database
  useEffect(() => {
    const loadFocusSettings = async () => {
      try {
        const settings = await window.api.focus.getFocusSettings();
        if (settings) {
          setFocusOverlayOpacity(settings.focus_overlay_opacity);
          setFocusWindowWidth(settings.focus_window_width);
          setFocusWindowOffsetX(settings.focus_window_offset_x);
          setFocusRotationEnabled(settings.focus_bg_rotation === 1);
          setFocusRotationInterval(settings.focus_bg_rotation_interval);

          // Load current background if set
          if (settings.focus_bg_current) {
            const backgrounds = await window.api.focus.getBackgrounds();
            const bg = backgrounds.find(b => b.id === settings.focus_bg_current);
            if (bg) {
              setCurrentBackgroundAssetId(bg.id);
              setCurrentBackgroundPath(bg.file_path);
            }
          }
        }
      } catch (error) {
        console.error('Error loading focus settings:', error);
      }
    };

    loadFocusSettings();
  }, []);

  // Background rotation timer
  useEffect(() => {
    if (!isFullScreen || !focusRotationEnabled) return;

    const rotationTimer = setInterval(async () => {
      try {
        const backgrounds = await window.api.focus.getBackgrounds();
        if (backgrounds.length === 0) return;

        // Find current background index
        const currentIndex = backgrounds.findIndex(b => b.id === currentBackgroundAssetId);
        const nextIndex = (currentIndex + 1) % backgrounds.length;
        const nextBackground = backgrounds[nextIndex];

        setCurrentBackgroundAssetId(nextBackground.id);
        setCurrentBackgroundPath(nextBackground.file_path);
        await window.api.focus.updateFocusSetting('focus_bg_current', nextBackground.id);
      } catch (error) {
        console.error('Error rotating background:', error);
      }
    }, focusRotationInterval * 60 * 1000); // Convert minutes to milliseconds

    return () => clearInterval(rotationTimer);
  }, [isFullScreen, focusRotationEnabled, focusRotationInterval, currentBackgroundAssetId]);

  // Count words in text
  const countWords = (text: string): number => {
    const trimmed = text.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  };

  // Calculate stats from content
  const calculateStats = useCallback((nodes: Descendant[]) => {
    const text = extractText(nodes);
    const words = countWords(text);
    const chars = text.length;

    setWordCount(words);

    return { words, chars };
  }, []);

  // Load document content when active document changes
  useEffect(() => {
    const loadDocument = async () => {
      if (!activeDocumentId) {
        setCurrentDoc(null);
        setValue(initialValue);
        setNotesValue(initialValue);
        setWordCount(0);
        setSessionWordCount(0);
        // Clear ghost text when switching documents
        setGhostText('');
        setAiAssistantGhostText('');
        return;
      }

      // For single documents, fetch fresh from database to avoid stale cached data
      // For folders, use cached documents array (needed to find children)
      let doc = documents.find(d => d.id === activeDocumentId);
      if (!doc) return;

      // If it's a single document (not folder), fetch fresh from DB
      if (doc.type === 'document') {
        const freshDoc = await window.api.document.get(activeDocumentId);
        if (freshDoc) {
          doc = freshDoc;
        }
      }

      // Clear ghost text when switching documents to prevent stale selections
      setGhostText('');
      setAiAssistantGhostText('');

      setCurrentDoc(doc);

      // Check if this is a folder (chapter/part/front matter/end matter)
      if (doc.type === 'folder') {
        setIsViewingFolder(true);

        // Get fresh data from database (in case scenes were edited)
        // Don't call loadDocuments() as it will trigger infinite loop
        const freshDocs = await window.api.document.getAll();

        // If this is a Part, we need to load chapters and their scenes recursively
        // If this is a Chapter, Front Matter, or End Matter: load direct child documents only
        let childScenesToLoad: DocumentRow[] = [];

        if (doc.hierarchy_level === 'part') {
          // Part: Load all child chapters, then recursively load scenes for each chapter
          const chapters = freshDocs
            .filter(d => d.parent_id === doc.id && d.type === 'folder')
            .sort((a, b) => a.position - b.position);

          // For each chapter, get its child scenes
          chapters.forEach(chapter => {
            const scenes = freshDocs
              .filter(d => d.parent_id === chapter.id && d.type === 'document')
              .sort((a, b) => a.position - b.position);

            childScenesToLoad.push(...scenes);
          });
        } else {
          // Chapter, Front Matter, End Matter, or other folder: Load direct child documents only
          childScenesToLoad = freshDocs
            .filter(d => d.parent_id === doc.id && d.type === 'document')
            .sort((a, b) => a.position - b.position);
        }

        setChildScenes(childScenesToLoad);

        // Calculate combined word count from all child scenes
        const totalWords = childScenesToLoad.reduce((sum, scene) => sum + (scene.word_count || 0), 0);
        setWordCount(totalWords);
        sessionStartWordCount.current = totalWords;
        setSessionWordCount(0);

        // Load folder's notes if any
        if (doc.notes) {
          try {
            const parsedNotes = JSON.parse(doc.notes);
            setNotesValue(parsedNotes);
          } catch {
            setNotesValue(initialValue);
          }
        }

        return; // Skip normal document loading
      }

      // Not a folder - regular document
      setIsViewingFolder(false);
      setChildScenes([]);

      // Parse the content
      try {
        let contentToLoad = initialValue;

        if (doc.content) {
          try {
            const parsed = JSON.parse(doc.content);
            // Ensure content has at least one paragraph
            if (parsed && Array.isArray(parsed) && parsed.length > 0) {
              contentToLoad = parsed;
            }
          } catch (parseError) {
            console.error('Error parsing document content:', parseError);
            contentToLoad = initialValue;
          }
        }

        // Deselect first to clear any stale selection
        Transforms.deselect(editor);

        setValue(contentToLoad);

        // Use setTimeout to ensure selection happens after setValue completes
        setTimeout(() => {
          try {
            // Verify the path exists before selecting
            if (editor.children.length > 0) {
              Transforms.select(editor, {
                anchor: { path: [0, 0], offset: 0 },
                focus: { path: [0, 0], offset: 0 }
              });
            }
          } catch (e) {
            // Ignore selection errors on load
            console.log('Could not set initial selection:', e);
          }
        }, 0);

        // Calculate initial stats
        const { words } = calculateStats(contentToLoad);
        sessionStartWordCount.current = words;
        setSessionWordCount(words > 0 ? 0 : 0);

        if (words === 0) {
          setWordCount(0);
        }

        // Load notes
        if (doc.notes) {
          try {
            const parsedNotes = JSON.parse(doc.notes);
            setNotesValue(parsedNotes);
          } catch {
            setNotesValue(initialValue);
          }
        } else {
          setNotesValue(initialValue);
        }
      } catch (error) {
        console.error('Error parsing document content:', error);
        setValue(initialValue);
        setNotesValue(initialValue);
        setWordCount(0);
        sessionStartWordCount.current = 0;
        setSessionWordCount(0);
      }
    };

    loadDocument();
  }, [activeDocumentId, documents, calculateStats]);

  // Load all tags for autocomplete
  useEffect(() => {
    const loadTags = async () => {
      try {
        const tags = await (window.api as any).tag.getAll();
        setAllTags(tags);
      } catch (error) {
        console.error('Error loading tags:', error);
      }
    };

    if (activeDocumentId) {
      loadTags();
    }
  }, [activeDocumentId]);

  // Extract text from Slate nodes
  const extractText = useCallback((nodes: Descendant[]): string => {
    return nodes.map(n => Node.string(n)).join('\n');
  }, []);

  // Handle scene content change in stacked editor
  const handleSceneContentChange = useCallback(async (sceneId: string, content: string) => {
    try {
      await updateDocumentContent(sceneId, content);

      // Update word count for this scene
      const parsed = JSON.parse(content);
      const text = extractText(parsed);
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;

      await updateDocumentWordCount(sceneId, words);

      // Recalculate total word count without reloading all documents
      // This prevents unnecessary re-renders and content mixing issues
      const updatedDocs = await window.api.document.getAll();
      const updatedChildren = updatedDocs
        .filter(d => d.parent_id === activeDocumentId && d.type === 'document');

      const totalWords = updatedChildren.reduce((sum, scene) => sum + (scene.word_count || 0), 0);
      setWordCount(totalWords);
    } catch (error) {
      console.error('[STACKED SAVE] Error saving scene:', error);
    }
  }, [updateDocumentContent, updateDocumentWordCount, activeDocumentId, extractText]);

  // Get the last N characters of text for context
  const getRecentContext = (nodes: Descendant[], maxChars: number = 500): string => {
    const fullText = extractText(nodes);
    return fullText.slice(-maxChars);
  };

  // Request AI suggestion
  const requestSuggestion = useCallback(async () => {
    if (mode !== 'vibewrite') {
      return;
    }

    if (!aiService.getSettings().enabled) {
      return;
    }

    const settings = aiService.getSettings();

    if (!settings.enabled) {
      return;
    }

    setIsLoadingSuggestion(true);

    try {
      // Get recent text for context
      const recentText = getRecentContext(value, 500);

      // Get reference context
      const characterNotes = references
        .filter(r => r.category === 'character')
        .map(r => `${r.name}: ${r.content}`)
        .join('\n');

      const settingNotes = references
        .filter(r => r.category === 'setting')
        .map(r => `${r.name}: ${r.content}`)
        .join('\n');

      const worldBuildingNotes = references
        .filter(r => r.category === 'worldBuilding')
        .map(r => `${r.name}: ${r.content}`)
        .join('\n');

      const suggestion = await aiService.generateSuggestion(recentText, {
        characterNotes: characterNotes || undefined,
        settingNotes: settingNotes || undefined,
        worldBuildingNotes: worldBuildingNotes || undefined
      });

      setGhostText(suggestion);

    } catch (error) {
      console.error('Error getting AI suggestion:', error);
      setGhostText('');
    } finally {
      setIsLoadingSuggestion(false);
    }
  }, [mode, value, references]);

  // Clear ghost text
  const clearGhostText = useCallback(() => {
    setGhostText('');
  }, []);

  // Accept ghost text suggestion (full)
  const acceptSuggestion = useCallback(() => {
    // AI Assistant ghost text has priority
    const activeGhost = aiAssistantGhostText || ghostText;
    if (!activeGhost) return;

    // Use Editor.withoutNormalizing to batch operations and prevent selection issues
    SlateEditor.withoutNormalizing(editor, () => {
      // Insert the ghost text at the cursor
      editor.insertText(activeGhost);
    });

    // Clear the appropriate ghost text after insertion
    if (aiAssistantGhostText) {
      setAiAssistantGhostText('');
    } else {
      clearGhostText();
    }
  }, [editor, ghostText, aiAssistantGhostText, clearGhostText]);

  // Accept one word from ghost text (partial)
  const acceptOneWord = useCallback(() => {
    // AI Assistant ghost text has priority
    const activeGhost = aiAssistantGhostText || ghostText;
    if (!activeGhost) return;

    // Find the first word in the ghost text
    const match = activeGhost.match(/^\s*\S+/);
    if (match) {
      const firstWord = match[0];

      // Use Editor.withoutNormalizing to batch operations and prevent selection issues
      SlateEditor.withoutNormalizing(editor, () => {
        editor.insertText(firstWord);
      });

      // Remove the accepted word from the appropriate ghost text
      const remaining = activeGhost.slice(firstWord.length);
      if (remaining.trim()) {
        if (aiAssistantGhostText) {
          setAiAssistantGhostText(remaining);
        } else {
          setGhostText(remaining);
        }
      } else {
        // Clear the appropriate ghost text
        if (aiAssistantGhostText) {
          setAiAssistantGhostText('');
        } else {
          clearGhostText();
        }
      }
    }
  }, [editor, ghostText, aiAssistantGhostText, clearGhostText]);

  // Tag autocomplete functions
  const closeTagAutocomplete = useCallback(() => {
    setShowTagAutocomplete(false);
    setTagSearchQuery('');
    setTagSelectedIndex(0);
    setHashStartPosition(null);
  }, []);

  const handleSelectTag = useCallback(async (tag: any) => {
    console.log('[TAG INSERT] Starting tag insertion for:', tag.name);
    const startTime = performance.now();

    if (!hashStartPosition || !activeDocumentId) {
      console.log('[TAG INSERT] Missing hashStartPosition or activeDocumentId, aborting');
      closeTagAutocomplete();
      return;
    }

    try {
      const { selection } = editor;
      if (!selection) {
        console.log('[TAG INSERT] No selection, aborting');
        closeTagAutocomplete();
        return;
      }

      console.log('[TAG INSERT] Initial focus - Editor focused:', document.activeElement?.tagName);
      // Keep focus on editor THROUGHOUT the entire operation
      ReactEditor.focus(editor);
      console.log('[TAG INSERT] After ReactEditor.focus - Focused element:', document.activeElement?.tagName);

      // Convert hex color to rgba with reduced opacity (20% opacity for subtle highlight)
      const hexToRgba = (hex: string, alpha: number) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      };

      const subtleColor = hexToRgba(tag.color, 0.2);
      const tagText = `#${tag.name}`;

      console.log('[TAG INSERT] Closing autocomplete');
      // Close autocomplete BEFORE doing transformations (prevents focus stealing)
      closeTagAutocomplete();

      console.log('[TAG INSERT] Step 1: Deleting # and search query');
      // Step 1: Delete the # and search query
      Transforms.delete(editor, {
        at: {
          anchor: hashStartPosition,
          focus: selection.anchor
        }
      });

      console.log('[TAG INSERT] Step 2: Inserting tag text:', tagText);
      // Step 2: Insert tag as formatted text at the hash position
      Transforms.insertText(editor, tagText, { at: hashStartPosition });

      console.log('[TAG INSERT] Step 3: Applying tag formatting');
      // Step 3: Apply tag formatting to the tag we just inserted
      Transforms.setNodes(
        editor,
        { backgroundColor: subtleColor, isTag: true, tagId: tag.id, tagName: tag.name } as any,
        {
          at: {
            anchor: hashStartPosition,
            focus: {
              path: hashStartPosition.path,
              offset: hashStartPosition.offset + tagText.length
            }
          },
          match: Text.isText,
          split: true
        }
      );

      console.log('[TAG INSERT] Step 4: Getting current selection after tag insertion');
      // Step 4: Get the ACTUAL current selection (where cursor is now)
      const currentSelection = editor.selection;
      if (!currentSelection) {
        console.error('[TAG INSERT] No selection after tag insertion!');
        return;
      }

      console.log('[TAG INSERT] Current selection after tag:', currentSelection.anchor);

      console.log('[TAG INSERT] Step 5: Inserting space at current selection');
      // Step 5: Insert ONE space at the current cursor position
      Transforms.insertText(editor, ' ');

      console.log('[TAG INSERT] Step 6: Getting selection after space insertion');
      // Step 6: Get selection after inserting spaces
      const afterSpacesSelection = editor.selection;
      if (!afterSpacesSelection) {
        console.error('[TAG INSERT] No selection after spaces insertion!');
        return;
      }

      console.log('[TAG INSERT] Selection after spaces:', afterSpacesSelection.anchor);

      console.log('[TAG INSERT] Step 7: Clearing formatting on space');
      // Step 7: Clear formatting on the space we just inserted
      // Go back 1 character and clear formatting
      Transforms.setNodes(
        editor,
        {
          backgroundColor: null,
          isTag: null,
          tagId: null,
          tagName: null,
          bold: null,
          italic: null,
          underline: null,
          strikethrough: null,
          code: null
        } as any,
        {
          at: {
            anchor: {
              path: afterSpacesSelection.anchor.path,
              offset: afterSpacesSelection.anchor.offset - 1
            },
            focus: afterSpacesSelection.anchor
          },
          match: Text.isText,
          split: true
        }
      );

      console.log('[TAG INSERT] Step 8: Clearing all editor marks');
      // Step 8: Clear ALL editor marks to prevent inheritance
      if (editor.marks) {
        Object.keys(editor.marks).forEach(key => {
          delete editor.marks![key];
        });
      }

      console.log('[TAG INSERT] Step 9: Removing individual marks');
      // Step 9: Explicitly remove all mark types
      ['backgroundColor', 'isTag', 'tagId', 'tagName', 'bold', 'italic', 'underline', 'strikethrough', 'code', 'fontSize', 'color'].forEach(mark => {
        try {
          SlateEditor.removeMark(editor, mark);
        } catch (e) {
          // Ignore errors
        }
      });

      console.log('[TAG INSERT] Step 10: Final focus');
      // Step 10: Force focus again after all transformations
      ReactEditor.focus(editor);

      const endTime = performance.now();
      console.log(`[TAG INSERT] ✅ Tag insertion completed in ${(endTime - startTime).toFixed(2)}ms`);
      console.log('[TAG INSERT] Final cursor position:', editor.selection?.anchor);

      // Add tag to document in database (async, but don't wait)
      (window.api as any).documentTag.add(activeDocumentId, tag.id, null, null).catch((err: any) => {
        console.error('[TAG INSERT] Error adding tag to database:', err);
      });

    } catch (error) {
      console.error('[TAG INSERT] ❌ Error during tag insertion:', error);
      closeTagAutocomplete();
    }
  }, [hashStartPosition, activeDocumentId, editor, closeTagAutocomplete]);

  const handleCreateAndInsertTag = useCallback(async (tagName: string) => {
    if (!hashStartPosition || !activeDocumentId) {
      closeTagAutocomplete();
      return;
    }

    try {
      // Create new tag with default color
      const newTagId = await (window.api as any).tag.create(
        tagName,
        'custom',
        '#888888',
        null
      );

      // Get the created tag
      const newTag = await (window.api as any).tag.get(newTagId);

      // Insert it
      await handleSelectTag(newTag);
    } catch (error) {
      console.error('Error creating tag:', error);
      closeTagAutocomplete();
    }
  }, [hashStartPosition, activeDocumentId, closeTagAutocomplete, handleSelectTag]);

  // Auto-save with debounce
  const handleChange = useCallback((newValue: Descendant[]) => {
    // Track tag search query while autocomplete is open
    if (showTagAutocomplete && hashStartPosition) {
      const { selection } = editor;
      if (selection) {
        // Extract text after the # symbol
        try {
          const textAfterHash = SlateEditor.string(editor, {
            anchor: {
              path: hashStartPosition.path,
              offset: hashStartPosition.offset + 1
            },
            focus: selection.anchor
          });
          setTagSearchQuery(textAfterHash);
        } catch (e) {
          // If extraction fails, close autocomplete
          closeTagAutocomplete();
        }
      }
    }

    setValue(newValue);

    // Calculate stats
    const { words } = calculateStats(newValue);
    const sessionWords = Math.max(0, words - sessionStartWordCount.current); // Never go negative
    setSessionWordCount(sessionWords);

    if (!currentDoc) {
      console.log('[SINGLE SCENE] No currentDoc, skipping save');
      return;
    }

    console.log('[SINGLE SCENE] Content changed for:', currentDoc.name);

    // Clear existing save timeout
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      console.log('[SINGLE SCENE] Cleared existing timeout');
    }

    // Set new timeout to save after 1 second of no typing
    const timeout = setTimeout(async () => {
      console.log('[SINGLE SCENE] Debounce complete, saving...');
      const content = JSON.stringify(newValue);
      await updateDocumentContent(currentDoc.id, content);
      console.log('[SINGLE SCENE] Content saved');
      // Update word count in database
      await updateDocumentWordCount(currentDoc.id, words);
      console.log('[SINGLE SCENE] Word count saved:', words);
      // NOTE: We don't reload documents here to avoid infinite loop
      // The save has persisted to DB, and when user switches views, it will reload
    }, 1000);

    setSaveTimeout(timeout);
    console.log('[SINGLE SCENE] Set timeout for save');

    // Get current text to compare with last text
    const currentText = extractText(newValue);
    const lastText = lastTextRef.current;

    // Handle ghost text matching logic
    // Only handle VibeWrite ghost text here - AI Assistant ghost text is controlled separately
    if (ghostText && mode === 'vibewrite' && !aiAssistantGhostText) {
      // Check if user typed something that matches the ghost text
      if (currentText.length > lastText.length) {
        const newChars = currentText.slice(lastText.length);

        // Check if the new characters match the beginning of ghost text
        const ghostLower = ghostText.toLowerCase().trimStart();
        const newCharsLower = newChars.toLowerCase();

        if (ghostLower.startsWith(newCharsLower)) {
          // User is typing matching text - trim the ghost text
          const remainingGhost = ghostText.trimStart().slice(newChars.length);
          setGhostText(remainingGhost);
        } else {
          // User typed something that doesn't match - clear ghost text
          clearGhostText();
        }
      }
    }

    // Update last text reference
    lastTextRef.current = currentText;

    // Handle AI suggestion in vibe write mode
    // Don't generate VibeWrite suggestions if AI Assistant ghost text is active
    if (mode === 'vibewrite' && aiService.getSettings().enabled && !aiAssistantGhostText) {
      // Clear existing suggestion timeout
      if (suggestionTimeoutRef.current) {
        clearTimeout(suggestionTimeoutRef.current);
      }

      // Only clear ghost text if we haven't already handled it above
      if (!ghostText) {
        clearGhostText();
      }

      // Set new timeout for suggestion
      const settings = aiService.getSettings();

      suggestionTimeoutRef.current = setTimeout(() => {
        requestSuggestion();
      }, settings.suggestionDelay);
    }
  }, [currentDoc, saveTimeout, updateDocumentContent, updateDocumentWordCount, mode, requestSuggestion, clearGhostText, ghostText, aiAssistantGhostText, extractText, calculateStats, showTagAutocomplete, hashStartPosition, editor, closeTagAutocomplete]);

  // Toggle format helper
  const toggleFormat = useCallback((format: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code') => {
    const isActive = isFormatActive(editor, format);
    Transforms.setNodes(
      editor,
      { [format]: isActive ? undefined : true } as any,
      { match: (n) => SlateEditor.isBlock(editor, n as any) === false, split: true }
    );
  }, [editor]);

  // Toggle block type
  const toggleBlock = useCallback((format: 'heading' | 'paragraph' | 'blockquote' | 'sceneBreak', level?: number) => {
    const isActive = isBlockActive(editor, format);

    Transforms.setNodes(
      editor,
      {
        type: isActive ? 'paragraph' : format,
        ...(format === 'heading' && level ? { level } : {})
      } as any,
      { match: (n) => SlateEditor.isBlock(editor, n as any) }
    );
  }, [editor]);

  // Set text alignment
  const setAlignment = useCallback((align: 'left' | 'center' | 'right' | 'justify') => {
    Transforms.setNodes(
      editor,
      { align } as any,
      { match: (n) => SlateEditor.isBlock(editor, n as any) }
    );
  }, [editor]);

  // Check if format is active
  const isFormatActive = (editor: SlateEditor, format: string) => {
    try {
      const marks = SlateEditor.marks(editor);
      return marks ? marks[format] === true : false;
    } catch (e) {
      // Selection may be invalid, return false
      return false;
    }
  };

  // Check if block type is active
  const isBlockActive = (editor: SlateEditor, format: string) => {
    try {
      const { selection } = editor;
      if (!selection) return false;

      const [match] = SlateEditor.nodes(editor, {
        at: SlateEditor.unhangRange(editor, selection),
        match: n => !SlateEditor.isEditor(n) && SlateEditor.isBlock(editor, n as any) && (n as any).type === format,
      });

      return !!match;
    } catch (e) {
      // Selection may be invalid, return false
      return false;
    }
  };

  // Insert text from AI assistant
  const handleInsertText = useCallback((text: string) => {
    editor.insertText(text);
  }, [editor]);

  // Set ghost text from external source (like AI Assistant)
  const handleSetGhostText = useCallback((text: string) => {
    setAiAssistantGhostText(text);
  }, []);

  // Expose insert function to parent
  useEffect(() => {
    if (onInsertTextReady) {
      onInsertTextReady(handleInsertText);
    }
  }, [onInsertTextReady, handleInsertText]);

  // Expose setGhostText function to parent
  useEffect(() => {
    if (onSetGhostTextReady) {
      onSetGhostTextReady(handleSetGhostText);
    }
  }, [onSetGhostTextReady, handleSetGhostText]);

  // Handle notes change
  const handleNotesChange = useCallback((newValue: Descendant[]) => {
    setNotesValue(newValue);

    if (!currentDoc) return;

    // Clear existing save timeout
    if (notesSaveTimeout) {
      clearTimeout(notesSaveTimeout);
    }

    // Set new timeout to save after 1 second of no typing
    const timeout = setTimeout(() => {
      const notes = JSON.stringify(newValue);
      updateDocumentNotes(currentDoc.id, notes);
    }, 1000);

    setNotesSaveTimeout(timeout);
  }, [currentDoc, notesSaveTimeout, updateDocumentNotes]);

  // Keyboard shortcuts
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    // Handle tag autocomplete navigation
    if (showTagAutocomplete) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const filteredTags = allTags.filter(tag =>
          tag.name.toLowerCase().includes(tagSearchQuery.toLowerCase())
        );
        setTagSelectedIndex(prev => (prev + 1) % filteredTags.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        const filteredTags = allTags.filter(tag =>
          tag.name.toLowerCase().includes(tagSearchQuery.toLowerCase())
        );
        setTagSelectedIndex(prev => (prev - 1 + filteredTags.length) % filteredTags.length);
        return;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        const filteredTags = allTags.filter(tag =>
          tag.name.toLowerCase().includes(tagSearchQuery.toLowerCase())
        );
        if (filteredTags[tagSelectedIndex]) {
          handleSelectTag(filteredTags[tagSelectedIndex]);
        } else if (tagSearchQuery.trim()) {
          // Create new tag if no match
          handleCreateAndInsertTag(tagSearchQuery);
        }
        return;
      }

      if (event.key === 'Enter') {
        // Enter does nothing in tag autocomplete - just prevent default
        event.preventDefault();
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closeTagAutocomplete();
        return;
      }
    }

    // Detect # keypress to start tag autocomplete
    if (event.key === '#') {
      const { selection } = editor;
      if (selection) {
        // Store the position where # was typed
        setHashStartPosition({
          path: selection.anchor.path,
          offset: selection.anchor.offset
        });
        setTagSearchQuery('');
        setTagSelectedIndex(0);

        // Calculate position for autocomplete dropdown (relative to editor container)
        try {
          const domSelection = window.getSelection();
          if (domSelection && domSelection.rangeCount > 0) {
            const range = domSelection.getRangeAt(0);
            const rangeRect = range.getBoundingClientRect();

            // Get the editor's DOM element to calculate relative position
            const editorElement = ReactEditor.toDOMNode(editor, editor);
            const editorRect = editorElement.getBoundingClientRect();

            // Calculate position relative to the editor container
            // Position dropdown directly below the # character, aligned to its left edge
            setTagAutocompletePosition({
              top: rangeRect.bottom - editorRect.top + 2, // 2px gap below cursor
              left: rangeRect.left - editorRect.left
            });
          }
        } catch (e) {
          console.error('Error calculating autocomplete position:', e);
        }

        setShowTagAutocomplete(true);
      }
    }

    // F11 to toggle full screen
    if (event.key === 'F11') {
      event.preventDefault();
      setIsFullScreen(prev => !prev);
      return;
    }

    // Escape to exit full screen or clear suggestion
    if (event.key === 'Escape') {
      if (isFullScreen) {
        event.preventDefault();
        window.api.window.setFullScreen(false);
        setIsFullScreen(false);
        return;
      }
      // Clear AI Assistant ghost text first (priority), then VibeWrite ghost text
      if (aiAssistantGhostText) {
        event.preventDefault();
        setAiAssistantGhostText('');
        return;
      }
      if (ghostText) {
        event.preventDefault();
        clearGhostText();
        return;
      }
    }

    // Tab to accept suggestion (full or partial)
    // AI Assistant ghost text has priority
    const activeGhost = aiAssistantGhostText || ghostText;
    if (event.key === 'Tab' && activeGhost) {
      event.preventDefault();

      if (event.shiftKey) {
        // Shift+Tab: accept one word
        acceptOneWord();
      } else {
        // Tab: accept full suggestion
        acceptSuggestion();
      }
      return;
    }

    if (!event.ctrlKey && !event.metaKey) return;

    switch (event.key) {
      case 'b':
        event.preventDefault();
        toggleFormat('bold');
        break;
      case 'i':
        event.preventDefault();
        toggleFormat('italic');
        break;
      case 'u':
        event.preventDefault();
        toggleFormat('underline');
        break;
      case 's':
        event.preventDefault();
        // Manual save
        if (currentDoc) {
          const content = JSON.stringify(value);
          updateDocumentContent(currentDoc.id, content);
        }
        break;
    }
  }, [toggleFormat, currentDoc, value, updateDocumentContent, ghostText, acceptSuggestion, acceptOneWord, clearGhostText, isFullScreen, showTagAutocomplete, allTags, tagSearchQuery, tagSelectedIndex, editor, handleSelectTag, handleCreateAndInsertTag, closeTagAutocomplete]);

  // Focus mode handlers
  const handleSelectBackground = async (assetId: string | null) => {
    if (assetId === null) {
      setCurrentBackgroundAssetId(null);
      setCurrentBackgroundPath(null);
      await window.api.focus.updateFocusSetting('focus_bg_current', null);
    } else {
      const backgrounds = await window.api.focus.getBackgrounds();
      const bg = backgrounds.find(b => b.id === assetId);
      if (bg) {
        setCurrentBackgroundAssetId(bg.id);
        setCurrentBackgroundPath(bg.file_path);
        await window.api.focus.updateFocusSetting('focus_bg_current', bg.id);
      }
    }
    setShowBackgroundManager(false);
  };

  const handleOverlayOpacityChange = async (value: number) => {
    setFocusOverlayOpacity(value);
    await window.api.focus.updateFocusSetting('focus_overlay_opacity', value);
  };

  const handleWindowWidthChange = async (value: number) => {
    setFocusWindowWidth(value);
    await window.api.focus.updateFocusSetting('focus_window_width', value);
  };

  const handleRotationToggle = async () => {
    const newValue = !focusRotationEnabled;
    setFocusRotationEnabled(newValue);
    await window.api.focus.updateFocusSetting('focus_bg_rotation', newValue ? 1 : 0);
  };

  const handleWindowDragStart = (e: React.MouseEvent) => {
    setIsDraggingWindow(true);
    setDragStartX(e.clientX);
  };

  const handleWindowDrag = (e: React.MouseEvent) => {
    if (!isDraggingWindow) return;

    const deltaX = e.clientX - dragStartX;
    const windowWidthPx = (window.innerWidth * focusWindowWidth) / 100;
    const maxOffset = (window.innerWidth - windowWidthPx) / 2;

    // Calculate new offset in pixels, constrained to viewport bounds
    let newOffsetPx = focusWindowOffsetX + deltaX;
    newOffsetPx = Math.max(-maxOffset, Math.min(maxOffset, newOffsetPx));

    setFocusWindowOffsetX(newOffsetPx);
    setDragStartX(e.clientX);
  };

  const handleWindowDragEnd = async () => {
    if (isDraggingWindow) {
      setIsDraggingWindow(false);
      await window.api.focus.updateFocusSetting('focus_window_offset_x', focusWindowOffsetX);
    }
  };

  // Render decorator for ghost text - shows inline after cursor
  const decorate = useCallback(([node, path]: [Node, number[]]) => {
    const ranges: any[] = [];

    if (!Text.isText(node)) {
      return ranges;
    }

    // Get the current selection
    const { selection } = editor;
    if (!selection || !selection.focus) {
      return ranges;
    }

    // Safety check: verify the selection path exists in the current document
    try {
      const focusPath = selection.focus.path;
      const nodeAtPath = Node.get(editor, focusPath);
      if (!nodeAtPath) {
        return ranges;
      }
    } catch (e) {
      // Selection path is invalid, return empty ranges
      return ranges;
    }

    // Check if this is the node where the cursor is
    const focusPath = selection.focus.path;
    if (path.length === focusPath.length && path.every((p, i) => p === focusPath[i])) {
      const focusOffset = selection.focus.offset;
      const { text } = node;

      // Determine which ghost text to show
      // AI Assistant ghost text takes priority and shows in all modes
      // VibeWrite ghost text only shows in vibewrite mode
      let activeGhostText = '';
      if (aiAssistantGhostText) {
        activeGhostText = aiAssistantGhostText;
      } else if (mode === 'vibewrite' && ghostText) {
        activeGhostText = ghostText;
      }

      if (activeGhostText) {
        // Split the text node at cursor to show ghost text
        if (focusOffset === text.length) {
          // Cursor is at the end of the text - add ghost suggestion to this range
          ranges.push({
            anchor: { path, offset: 0 },
            focus: { path, offset: text.length },
            ghostSuggestion: activeGhostText
          });
        } else if (focusOffset < text.length) {
          // Cursor is in the middle - split into before and after cursor
          ranges.push(
            {
              anchor: { path, offset: 0 },
              focus: { path, offset: focusOffset },
            },
            {
              anchor: { path, offset: focusOffset },
              focus: { path, offset: text.length },
              ghostSuggestion: activeGhostText
            }
          );
        }
      }
    }

    return ranges;
  }, [ghostText, aiAssistantGhostText, editor, mode]);

  if (!currentDoc) {
    return (
      <div style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#888',
        flexDirection: 'column',
        gap: '12px'
      }}>
        <File size={48} color="#666" />
        <div>Select a document to start writing</div>
      </div>
    );
  }

  return (
    <div
      key={currentDoc?.id || 'no-doc'} // Force remount when document changes
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#1e1e1e',
        position: isFullScreen ? 'fixed' : 'relative',
        top: isFullScreen ? 0 : 'auto',
        left: isFullScreen ? 0 : 'auto',
        right: isFullScreen ? 0 : 'auto',
        bottom: isFullScreen ? 0 : 'auto',
        zIndex: isFullScreen ? 9999 : 'auto'
      }}>
      {/* Formatting toolbar */}
      <div style={{
        padding: '8px 16px',
        borderBottom: '1px solid #333',
        display: isFullScreen ? 'none' : 'flex',
        gap: '4px',
        alignItems: 'center',
        flexWrap: 'wrap'
      }}>
        {/* Text formatting */}
        <button
          onMouseDown={(e) => {
            e.preventDefault();
            toggleFormat('bold');
          }}
          title="Bold (Ctrl+B)"
          style={{
            padding: '6px 10px',
            backgroundColor: isFormatActive(editor, 'bold') ? '#0e639c' : '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <Bold size={16} />
        </button>

        <button
          onMouseDown={(e) => {
            e.preventDefault();
            toggleFormat('italic');
          }}
          title="Italic (Ctrl+I)"
          style={{
            padding: '6px 10px',
            backgroundColor: isFormatActive(editor, 'italic') ? '#0e639c' : '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <Italic size={16} />
        </button>

        <button
          onMouseDown={(e) => {
            e.preventDefault();
            toggleFormat('underline');
          }}
          title="Underline (Ctrl+U)"
          style={{
            padding: '6px 10px',
            backgroundColor: isFormatActive(editor, 'underline') ? '#0e639c' : '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <Underline size={16} />
        </button>

        <button
          onMouseDown={(e) => {
            e.preventDefault();
            toggleFormat('strikethrough');
          }}
          title="Strikethrough"
          style={{
            padding: '6px 10px',
            backgroundColor: isFormatActive(editor, 'strikethrough') ? '#0e639c' : '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <Strikethrough size={16} />
        </button>

        <button
          onMouseDown={(e) => {
            e.preventDefault();
            toggleFormat('code');
          }}
          title="Code"
          style={{
            padding: '6px 10px',
            backgroundColor: isFormatActive(editor, 'code') ? '#0e639c' : '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <Code size={16} />
        </button>

        <div style={{ width: '1px', height: '24px', backgroundColor: '#333', margin: '0 4px' }} />

        {/* Headings */}
        <button
          onMouseDown={(e) => {
            e.preventDefault();
            toggleBlock('heading', 1);
          }}
          title="Heading 1"
          style={{
            padding: '6px 10px',
            backgroundColor: isBlockActive(editor, 'heading') ? '#0e639c' : '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <Heading1 size={16} />
        </button>

        <button
          onMouseDown={(e) => {
            e.preventDefault();
            toggleBlock('heading', 2);
          }}
          title="Heading 2"
          style={{
            padding: '6px 10px',
            backgroundColor: isBlockActive(editor, 'heading') ? '#0e639c' : '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <Heading2 size={16} />
        </button>

        <button
          onMouseDown={(e) => {
            e.preventDefault();
            toggleBlock('heading', 3);
          }}
          title="Heading 3"
          style={{
            padding: '6px 10px',
            backgroundColor: isBlockActive(editor, 'heading') ? '#0e639c' : '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <Heading3 size={16} />
        </button>

        <div style={{ width: '1px', height: '24px', backgroundColor: '#333', margin: '0 4px' }} />

        {/* Alignment */}
        <button
          onMouseDown={(e) => {
            e.preventDefault();
            setAlignment('left');
          }}
          title="Align Left"
          style={{
            padding: '6px 10px',
            backgroundColor: '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <AlignLeft size={16} />
        </button>

        <button
          onMouseDown={(e) => {
            e.preventDefault();
            setAlignment('center');
          }}
          title="Align Center"
          style={{
            padding: '6px 10px',
            backgroundColor: '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <AlignCenter size={16} />
        </button>

        <button
          onMouseDown={(e) => {
            e.preventDefault();
            setAlignment('right');
          }}
          title="Align Right"
          style={{
            padding: '6px 10px',
            backgroundColor: '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <AlignRight size={16} />
        </button>

        <button
          onMouseDown={(e) => {
            e.preventDefault();
            setAlignment('justify');
          }}
          title="Justify"
          style={{
            padding: '6px 10px',
            backgroundColor: '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <AlignJustify size={16} />
        </button>

        <div style={{ width: '1px', height: '24px', backgroundColor: '#333', margin: '0 4px' }} />

        {/* Block types */}
        <button
          onMouseDown={(e) => {
            e.preventDefault();
            toggleBlock('blockquote');
          }}
          title="Block Quote"
          style={{
            padding: '6px 10px',
            backgroundColor: isBlockActive(editor, 'blockquote') ? '#0e639c' : '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <Quote size={16} />
        </button>

        <button
          onMouseDown={(e) => {
            e.preventDefault();
            toggleBlock('sceneBreak');
          }}
          title="Scene Break (***)"
          style={{
            padding: '6px 10px',
            backgroundColor: isBlockActive(editor, 'sceneBreak') ? '#0e639c' : '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center'
          }}
        >
          <Minus size={16} />
        </button>

        <div style={{ width: '1px', height: '24px', backgroundColor: '#333', margin: '0 4px' }} />

        {/* Mode toggle */}
        <button
          onClick={() => setMode(mode === 'freewrite' ? 'vibewrite' : 'freewrite')}
          style={{
            padding: '6px 12px',
            backgroundColor: mode === 'vibewrite' ? '#0e639c' : '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            cursor: 'pointer',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}
        >
          <Sparkles size={14} />
          {mode === 'vibewrite' ? 'Vibe Write' : 'Free Write'}
        </button>

        <div style={{ marginLeft: 'auto', fontSize: '12px', color: '#888', alignSelf: 'center', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span>
            {mode === 'vibewrite' && ghostText && '✨ Tab to accept all | Shift+Tab for one word | Esc to dismiss'}
            {mode === 'vibewrite' && isLoadingSuggestion && '⏳ Generating...'}
            {mode === 'freewrite' && 'Ctrl+S to save'}
          </span>
          <button
            onClick={() => setShowNotes(prev => !prev)}
            title="Toggle Notes Panel"
            style={{
              padding: '6px 10px',
              backgroundColor: showNotes ? '#0e639c' : '#333',
              color: '#fff',
              border: 'none',
              borderRadius: '3px',
              cursor: 'pointer',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <StickyNote size={14} />
            Notes
          </button>
          <button
            onClick={async () => {
              const newState = !isFullScreen;
              await window.api.window.setFullScreen(newState);
              setIsFullScreen(newState);
            }}
            title="Full Screen Mode (F11)"
            style={{
              padding: '6px 10px',
              backgroundColor: isFullScreen ? '#0e639c' : '#333',
              color: '#fff',
              border: 'none',
              borderRadius: '3px',
              cursor: 'pointer',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            {isFullScreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            Focus
          </button>
        </div>
      </div>

      {/* Document Tags */}
      {!isFullScreen && <DocumentTagBox documentId={activeDocumentId} documentContent={extractText(value)} documentNodes={value} currentDocument={currentDoc} />}

      {/* Editor and Notes area */}
      <div style={{
        flex: 1,
        overflow: 'hidden'
      }}>
        <PanelGroup direction="horizontal" autoSaveId="editor-notes-layout">
          {/* Main editor area */}
          <Panel minSize={30}>
            <div
              style={{
                height: '100%',
                overflow: 'auto',
                backgroundImage: currentBackgroundPath && isFullScreen ? `url(file:///${currentBackgroundPath.replace(/\\/g, '/')})` : 'none',
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                backgroundAttachment: 'fixed',
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              onMouseMove={isDraggingWindow ? handleWindowDrag : undefined}
              onMouseUp={handleWindowDragEnd}
            >
              {/* Background Overlay */}
              {isFullScreen && currentBackgroundPath && (
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: `rgba(0, 0, 0, ${focusOverlayOpacity / 100})`,
                  pointerEvents: 'none'
                }} />
              )}

              {/* Adjustable Writing Area Container */}
              <div
                style={{
                  position: 'relative',
                  width: isFullScreen ? `${focusWindowWidth}%` : '100%',
                  maxWidth: isFullScreen ? 'none' : `${editorMaxWidth}px`,
                  height: isFullScreen ? '100%' : 'auto',
                  padding: isFullScreen ? '80px 40px' : '40px 80px',
                  transform: isFullScreen ? `translateX(${focusWindowOffsetX}px)` : 'none',
                  cursor: isDraggingWindow ? 'grabbing' : (isFullScreen ? 'grab' : 'default'),
                  transition: isDraggingWindow ? 'none' : 'width 0.2s ease-in-out, transform 0.2s ease-in-out',
                  zIndex: 1
                }}
                onMouseDown={isFullScreen ? handleWindowDragStart : undefined}
              >
                {/* Folder View (Chapter/Part with child scenes) */}
                {isViewingFolder && currentDoc && (
                  <div style={{
                    maxWidth: `${editorMaxWidth}px`,
                    margin: '0 auto',
                    padding: '0 40px'
                  }}>
                    {childScenes.length > 0 ? (
                      <StackedSceneEditor
                        scenes={childScenes}
                        onSceneChange={handleSceneContentChange}
                        sceneBreakStyle={editorSceneBreakStyle}
                        renderElement={Element}
                        renderLeaf={Leaf}
                        editorTextSize={editorTextSize}
                        editorLineHeight={editorLineHeight}
                      />
                    ) : (
                      <div style={{
                        padding: '60px 40px',
                        textAlign: 'center',
                        color: '#666',
                        fontSize: '16px'
                      }}>
                        <p style={{ marginBottom: '10px', fontSize: '18px', color: '#888' }}>
                          This {currentDoc.hierarchy_level || 'folder'} is empty
                        </p>
                        <p style={{ fontSize: '14px', fontStyle: 'italic' }}>
                          Add scenes to "{currentDoc.name}" to start writing
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Regular Document Editor */}
                {!isViewingFolder && (
                  <div style={{
                    maxWidth: `${editorMaxWidth}px`,
                    margin: '0 auto',
                    padding: '0 40px'
                  }}>
                    <Slate
                    editor={editor}
                    initialValue={value}
                    onChange={handleChange}
                  >
                    <Editable
                      renderLeaf={Leaf}
                      renderElement={Element}
                      decorate={decorate}
                      onKeyDown={handleKeyDown}
                      placeholder="Start writing..."
                      spellCheck
                      style={{
                        minHeight: '100%',
                        fontSize: `${editorTextSize}px`,
                        lineHeight: `${editorLineHeight}`,
                        color: '#d4d4d4',
                        outline: 'none'
                      }}
                    />
                  </Slate>
                </div>
                )}

                {/* Inline Tag Autocomplete */}
                {showTagAutocomplete && (
                  <InlineTagAutocomplete
                    tags={allTags}
                    searchQuery={tagSearchQuery}
                    selectedIndex={tagSelectedIndex}
                    position={tagAutocompletePosition}
                    onSelect={handleSelectTag}
                    onClose={closeTagAutocomplete}
                  />
                )}
              </div>
            </div>
          </Panel>

          {/* Notes panel */}
          {showNotes && !isFullScreen && (
            <>
              <PanelResizeHandle style={{
                width: '4px',
                backgroundColor: '#333',
                cursor: 'col-resize',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => (e.currentTarget as unknown as HTMLElement).style.backgroundColor = 'var(--primary-green)'}
              onMouseLeave={(e) => (e.currentTarget as unknown as HTMLElement).style.backgroundColor = '#333'}
              />

              <Panel
                defaultSize={30}
                minSize={20}
                maxSize={50}
              >
                <div style={{
                  height: '100%',
                  overflow: 'auto',
                  padding: '40px 40px',
                  backgroundColor: '#252526'
                }}>
                  <div style={{
                    marginBottom: '16px',
                    fontSize: '14px',
                    color: '#888',
                    fontWeight: 'bold',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px'
                  }}>
                    Scene Notes
                  </div>
                  <Slate
                    editor={notesEditor}
                    initialValue={notesValue}
                    onChange={handleNotesChange}
                  >
                    <Editable
                      renderLeaf={Leaf}
                      renderElement={Element}
                      placeholder="Add notes for this scene or chapter..."
                      spellCheck
                      style={{
                        minHeight: '100%',
                        fontSize: '14px',
                        lineHeight: '1.6',
                        color: '#b0b0b0',
                        outline: 'none'
                      }}
                    />
                  </Slate>
                </div>
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>

      {/* Status Bar at Bottom */}
      <EditorStatusBar
        wordCount={wordCount}
        sessionWordCount={sessionWordCount}
      />

      {/* Focus Mode Panel */}
      {isFullScreen && (
        <FocusModePanel
          onOpenBackgroundManager={() => setShowBackgroundManager(true)}
          onExit={async () => {
            await window.api.window.setFullScreen(false);
            setIsFullScreen(false);
          }}
          overlayOpacity={focusOverlayOpacity}
          onOverlayOpacityChange={handleOverlayOpacityChange}
          windowWidth={focusWindowWidth}
          onWindowWidthChange={handleWindowWidthChange}
          rotationEnabled={focusRotationEnabled}
          onRotationToggle={handleRotationToggle}
          wordCount={wordCount}
          mode={mode}
          onModeToggle={() => setMode(mode === 'freewrite' ? 'vibewrite' : 'freewrite')}
          notesVisible={showFloatingNotes}
          onNotesToggle={() => setShowFloatingNotes(prev => !prev)}
          aiVisible={showFloatingAI}
          onAIToggle={() => setShowFloatingAI(prev => !prev)}
        />
      )}

      {/* Floating Notes Panel */}
      {isFullScreen && (
        <FloatingNotesPanel
          isVisible={showFloatingNotes}
          onClose={() => setShowFloatingNotes(false)}
          notesEditor={notesEditor}
          notesValue={notesValue}
          onNotesChange={setNotesValue}
          renderLeaf={Leaf}
          renderElement={Element}
        />
      )}

      {/* Floating AI Assistant Panel */}
      {isFullScreen && (
        <FloatingAIPanel
          isVisible={showFloatingAI}
          onClose={() => setShowFloatingAI(false)}
          onInsertText={(text) => {
            const { selection } = editor;
            if (selection) {
              Transforms.insertText(editor, text);
            }
          }}
          onSetGhostText={setAiAssistantGhostText}
          references={[]}
          activeDocument={currentDoc}
        />
      )}

      {/* Background Manager Modal */}
      <BackgroundManager
        isOpen={showBackgroundManager}
        onClose={() => setShowBackgroundManager(false)}
        currentBackgroundId={currentBackgroundAssetId}
        onSelectBackground={handleSelectBackground}
      />

    </div>
  );
};

export default Editor;