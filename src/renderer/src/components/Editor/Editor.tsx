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
  Quote, Minus, StickyNote, Maximize2, Minimize2, Image as ImageIcon, X
} from 'lucide-react';
import { useProject } from '../../contexts/ProjectContext';
import { DocumentRow } from '../../../types/window';
import aiService from '../../services/aiService';

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

  if (leaf.fontSize) {
    style.fontSize = `${leaf.fontSize}px`;
  }
  if (leaf.color) {
    style.color = leaf.color;
  }
  if (leaf.backgroundColor) {
    style.backgroundColor = leaf.backgroundColor;
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

  return <span {...attributes} style={style}>{children}</span>;
};

// Render element (for paragraphs, headings, blockquotes, scene breaks)
const Element = ({ attributes, children, element }: RenderElementProps) => {
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
          <div contentEditable={false}>* * *</div>
        </div>
      );
    default:
      return <p {...attributes} style={style}>{children}</p>;
  }
};

interface EditorProps {
  onInsertTextReady?: (insertFn: (text: string) => void) => void;
  onSetGhostTextReady?: (setGhostTextFn: (text: string) => void) => void;
}

const Editor: React.FC<EditorProps> = ({ onInsertTextReady, onSetGhostTextReady }) => {
  const { activeDocumentId, documents, updateDocumentContent, updateDocumentWordCount, updateDocumentNotes, references } = useProject();
  const editor = useMemo(() => withHistory(withReact(createEditor())), []);
  const [value, setValue] = useState<Descendant[]>(initialValue);
  const [currentDoc, setCurrentDoc] = useState<DocumentRow | null>(null);
  const [saveTimeout, setSaveTimeout] = useState<NodeJS.Timeout | null>(null);
  const [ghostText, setGhostText] = useState<string>('');
  const [isLoadingSuggestion, setIsLoadingSuggestion] = useState(false);
  const [mode, setMode] = useState<'freewrite' | 'vibewrite'>('freewrite');
  const suggestionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastTextRef = useRef<string>(''); // Track the last text to detect what user typed

  // Stats tracking
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [sessionWordCount, setSessionWordCount] = useState(0);
  const sessionStartWordCount = useRef<number>(0);

  // Notes panel
  const [showNotes, setShowNotes] = useState(false);
  const [notesValue, setNotesValue] = useState<Descendant[]>(initialValue);
  const notesEditor = useMemo(() => withHistory(withReact(createEditor())), []);
  const [notesSaveTimeout, setNotesSaveTimeout] = useState<NodeJS.Timeout | null>(null);

  // Full-screen mode
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [backgroundImage, setBackgroundImage] = useState<string | null>(null);
  const [showBgPicker, setShowBgPicker] = useState(false);

  const presetBackgrounds = [
    { name: 'None', url: null },
    { name: 'Cafe', url: 'https://images.unsplash.com/photo-1445116572660-236099ec97a0?w=1600' },
    { name: 'Library', url: 'https://images.unsplash.com/photo-1521587760476-6c12a4b040da?w=1600' },
    { name: 'Forest', url: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1600' },
    { name: 'Cozy', url: 'https://images.unsplash.com/photo-1515694346937-94d85e41e6f0?w=1600' },
  ];

  // Initialize AI service with API key
  useEffect(() => {
    // Note: API key is now handled securely in the main process via .env file
    // No need to handle API key in renderer process anymore
    console.log('AI Service ready - API key handled by main process');
  }, []);

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
    setCharCount(chars);

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
        setCharCount(0);
        setSessionWordCount(0);
        return;
      }

      const doc = documents.find(d => d.id === activeDocumentId);
      if (!doc) return;

      setCurrentDoc(doc);

      // Parse the content
      try {
        if (doc.content) {
          const parsed = JSON.parse(doc.content);
          setValue(parsed);

          // Calculate initial stats
          const { words } = calculateStats(parsed);
          sessionStartWordCount.current = words;
          setSessionWordCount(0);
        } else {
          setValue(initialValue);
          setWordCount(0);
          setCharCount(0);
          sessionStartWordCount.current = 0;
          setSessionWordCount(0);
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
        setCharCount(0);
        sessionStartWordCount.current = 0;
        setSessionWordCount(0);
      }
    };

    loadDocument();
  }, [activeDocumentId, documents, calculateStats]);

  // Extract text from Slate nodes
  const extractText = (nodes: Descendant[]): string => {
    return nodes.map(n => Node.string(n)).join('\n');
  };

  // Get the last N characters of text for context
  const getRecentContext = (nodes: Descendant[], maxChars: number = 500): string => {
    const fullText = extractText(nodes);
    return fullText.slice(-maxChars);
  };

  // Request AI suggestion
  const requestSuggestion = useCallback(async () => {
    console.log('🔍 DEBUG: requestSuggestion called');
    console.log('🔍 DEBUG: mode =', mode);
    
    if (mode !== 'vibewrite') {
      console.log('❌ DEBUG: Not in vibewrite mode, skipping');
      return;
    }
    
    if (!aiService.getSettings().enabled) {
      console.log('❌ DEBUG: AI service not enabled, skipping');
      return;
    }

    const settings = aiService.getSettings();
    console.log('🔍 DEBUG: AI settings =', settings);
    
    if (!settings.enabled) {
      console.log('❌ DEBUG: AI settings disabled, skipping');
      return;
    }

    console.log('✅ DEBUG: Starting AI suggestion request...');
    setIsLoadingSuggestion(true);

    try {
      // Get recent text for context
      const recentText = getRecentContext(value, 500);
      console.log('🔍 DEBUG: Recent text for context:', recentText);
      
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

      console.log('🔍 DEBUG: About to call aiService.generateSuggestion...');
      const suggestion = await aiService.generateSuggestion(recentText, {
        characterNotes: characterNotes || undefined,
        settingNotes: settingNotes || undefined,
        worldBuildingNotes: worldBuildingNotes || undefined
      });

      console.log('✅ DEBUG: Got suggestion from AI:', suggestion);
      setGhostText(suggestion);

    } catch (error) {
      console.error('❌ DEBUG: Error getting suggestion:', error);
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
    if (!ghostText) return;

    // Insert the ghost text at the cursor
    editor.insertText(ghostText);
    clearGhostText();
  }, [editor, ghostText, clearGhostText]);

  // Accept one word from ghost text (partial)
  const acceptOneWord = useCallback(() => {
    if (!ghostText) return;

    // Find the first word in the ghost text
    const match = ghostText.match(/^\s*\S+/);
    if (match) {
      const firstWord = match[0];
      editor.insertText(firstWord);

      // Remove the accepted word from ghost text
      const remaining = ghostText.slice(firstWord.length);
      if (remaining.trim()) {
        setGhostText(remaining);
      } else {
        clearGhostText();
      }
    }
  }, [editor, ghostText, clearGhostText]);

  // Auto-save with debounce
  const handleChange = useCallback((newValue: Descendant[]) => {
    setValue(newValue);

    // Calculate stats
    const { words } = calculateStats(newValue);
    const sessionWords = Math.max(0, words - sessionStartWordCount.current); // Never go negative
    setSessionWordCount(sessionWords);

    if (!currentDoc) return;

    // Clear existing save timeout
    if (saveTimeout) {
      clearTimeout(saveTimeout);
    }

    // Set new timeout to save after 1 second of no typing
    const timeout = setTimeout(() => {
      const content = JSON.stringify(newValue);
      updateDocumentContent(currentDoc.id, content);
      // Update word count in database
      updateDocumentWordCount(currentDoc.id, words);
    }, 1000);

    setSaveTimeout(timeout);

    // Get current text to compare with last text
    const currentText = extractText(newValue);
    const lastText = lastTextRef.current;

    // Handle ghost text matching logic
    if (ghostText && mode === 'vibewrite') {
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
    console.log('🔍 DEBUG: handleChange - mode =', mode, 'AI enabled =', aiService.getSettings().enabled);

    if (mode === 'vibewrite' && aiService.getSettings().enabled) {
      console.log('✅ DEBUG: Setting up AI suggestion timer...');

      // Clear existing suggestion timeout
      if (suggestionTimeoutRef.current) {
        clearTimeout(suggestionTimeoutRef.current);
        console.log('🔍 DEBUG: Cleared existing suggestion timeout');
      }

      // Only clear ghost text if we haven't already handled it above
      if (!ghostText) {
        clearGhostText();
      }

      // Set new timeout for suggestion
      const settings = aiService.getSettings();
      console.log('🔍 DEBUG: Setting timer for', settings.suggestionDelay, 'ms');

      suggestionTimeoutRef.current = setTimeout(() => {
        console.log('⏰ DEBUG: Timer fired! Calling requestSuggestion...');
        requestSuggestion();
      }, settings.suggestionDelay);
    } else {
      console.log('❌ DEBUG: Not setting AI timer - mode:', mode, 'AI enabled:', aiService.getSettings().enabled);
    }
  }, [currentDoc, saveTimeout, updateDocumentContent, updateDocumentWordCount, mode, requestSuggestion, clearGhostText, ghostText, extractText, calculateStats]);

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
    const marks = SlateEditor.marks(editor);
    return marks ? marks[format] === true : false;
  };

  // Check if block type is active
  const isBlockActive = (editor: SlateEditor, format: string) => {
    const { selection } = editor;
    if (!selection) return false;

    const [match] = SlateEditor.nodes(editor, {
      at: SlateEditor.unhangRange(editor, selection),
      match: n => !SlateEditor.isEditor(n) && SlateEditor.isBlock(editor, n as any) && (n as any).type === format,
    });

    return !!match;
  };

  // Insert text from AI assistant
  const handleInsertText = useCallback((text: string) => {
    editor.insertText(text);
  }, [editor]);

  // Set ghost text from external source (like AI Assistant)
  const handleSetGhostText = useCallback((text: string) => {
    setGhostText(text);
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
        setIsFullScreen(false);
        return;
      }
      if (ghostText) {
        event.preventDefault();
        clearGhostText();
        return;
      }
    }

    // Tab to accept suggestion (full or partial)
    if (event.key === 'Tab' && ghostText) {
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
  }, [toggleFormat, currentDoc, value, updateDocumentContent, ghostText, acceptSuggestion, acceptOneWord, clearGhostText, isFullScreen]);

  // Render decorator for ghost text - shows inline after cursor
  const decorate = useCallback(([node, path]: [Node, number[]]) => {
    const ranges: any[] = [];

    if (!ghostText || !Text.isText(node) || mode !== 'vibewrite') {
      return ranges;
    }

    // Get the current selection
    const { selection } = editor;
    if (!selection || !selection.focus) {
      return ranges;
    }

    // Check if this is the node where the cursor is
    const focusPath = selection.focus.path;
    if (path.length === focusPath.length && path.every((p, i) => p === focusPath[i])) {
      const focusOffset = selection.focus.offset;
      const { text } = node;

      // Split the text node at cursor to show ghost text
      if (focusOffset === text.length) {
        // Cursor is at the end of the text - add ghost suggestion to this range
        ranges.push({
          anchor: { path, offset: 0 },
          focus: { path, offset: text.length },
          ghostSuggestion: ghostText
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
            ghostSuggestion: ghostText
          }
        );
      }
    }

    return ranges;
  }, [ghostText, editor, mode]);

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
          {/* Stats */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '4px 12px', backgroundColor: '#252526', borderRadius: '3px' }}>
            <span title="Total word count">
              <strong style={{ color: 'var(--primary-green)' }}>{wordCount.toLocaleString()}</strong> words
            </span>
            <span style={{ color: '#555' }}>|</span>
            <span title="Total character count">
              <strong style={{ color: '#888' }}>{charCount.toLocaleString()}</strong> chars
            </span>
            {sessionWordCount > 0 && (
              <>
                <span style={{ color: '#555' }}>|</span>
                <span title="Words written today" style={{ color: '#4ec9b0' }}>
                  +{sessionWordCount.toLocaleString()} today
                </span>
              </>
            )}
          </div>

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
            onClick={() => setIsFullScreen(prev => !prev)}
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

      {/* Editor and Notes area */}
      <div style={{
        flex: 1,
        overflow: 'hidden'
      }}>
        <PanelGroup direction="horizontal" autoSaveId="editor-notes-layout">
          {/* Main editor area */}
          <Panel minSize={30}>
            <div style={{
              height: '100%',
              overflow: 'auto',
              padding: isFullScreen ? '80px 20%' : '40px 80px',
              backgroundImage: backgroundImage ? `url(${backgroundImage})` : 'none',
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              backgroundAttachment: 'fixed',
              position: 'relative'
            }}>
          {isFullScreen && backgroundImage && (
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.7)',
              pointerEvents: 'none'
            }} />
          )}

          {/* Full-screen controls */}
          {isFullScreen && (
            <div style={{
              position: 'absolute',
              top: 20,
              right: 20,
              zIndex: 10,
              display: 'flex',
              gap: '8px'
            }}>
              <button
                onClick={() => setShowBgPicker(prev => !prev)}
                title="Change Background"
                style={{
                  padding: '8px 12px',
                  backgroundColor: 'rgba(30, 30, 30, 0.9)',
                  color: '#fff',
                  border: '1px solid #333',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <ImageIcon size={14} />
                Background
              </button>
              <button
                onClick={() => setIsFullScreen(false)}
                title="Exit Full Screen (F11 or Esc)"
                style={{
                  padding: '8px 12px',
                  backgroundColor: 'rgba(30, 30, 30, 0.9)',
                  color: '#fff',
                  border: '1px solid #333',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <X size={14} />
                Exit
              </button>
            </div>
          )}

          {/* Background picker */}
          {isFullScreen && showBgPicker && (
            <div style={{
              position: 'absolute',
              top: 70,
              right: 20,
              zIndex: 10,
              backgroundColor: 'rgba(30, 30, 30, 0.95)',
              border: '1px solid #333',
              borderRadius: '8px',
              padding: '16px',
              minWidth: '200px'
            }}>
              <div style={{
                fontSize: '12px',
                color: '#888',
                marginBottom: '12px',
                textTransform: 'uppercase',
                letterSpacing: '0.5px'
              }}>
                Choose Background
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {presetBackgrounds.map((preset) => (
                  <button
                    key={preset.name}
                    onClick={() => {
                      setBackgroundImage(preset.url);
                      setShowBgPicker(false);
                    }}
                    style={{
                      padding: '8px 12px',
                      backgroundColor: backgroundImage === preset.url ? '#0e639c' : '#252526',
                      color: '#fff',
                      border: '1px solid #333',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '12px',
                      textAlign: 'left',
                      transition: 'background-color 0.2s'
                    }}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>
          )}

              <div style={{ position: 'relative', zIndex: 1 }}>
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
                      fontSize: '16px',
                      lineHeight: '1.6',
                      color: '#d4d4d4',
                      outline: 'none'
                    }}
                  />
                </Slate>
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

    </div>
  );
};

export default Editor;