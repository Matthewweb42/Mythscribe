// src/renderer/src/components/Editor/Editor.tsx
import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { createEditor, Descendant, Editor as SlateEditor, Transforms, Text, Node } from 'slate';
import { Slate, Editable, withReact, RenderLeafProps, RenderElementProps } from 'slate-react';
import { withHistory } from 'slate-history';
import { Bold, Italic, Underline, File, Sparkles } from 'lucide-react';
import { useProject } from '../../contexts/ProjectContext';
import { DocumentRow } from '../../../types/window';
import aiService from '../../services/aiService';

// Custom types for Slate
type CustomText = { 
  text: string; 
  bold?: boolean; 
  italic?: boolean; 
  underline?: boolean;
  ghost?: boolean; // For ghost text suggestions
};

type ParagraphElement = { type: 'paragraph'; children: CustomText[] };
type HeadingElement = { type: 'heading'; level: number; children: CustomText[] };
type CustomElement = ParagraphElement | HeadingElement;

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

// Render leaf (for bold, italic, underline, ghost text)
const Leaf = ({ attributes, children, leaf }: RenderLeafProps) => {
  let style: React.CSSProperties = {};
  
  if (leaf.ghost) {
    style = { 
      ...style, 
      color: 'var(--primary-green)', 
      fontStyle: 'italic',
      opacity: 0.8,
      backgroundColor: 'rgba(78, 222, 128, 0.1)',
      padding: '2px 4px',
      borderRadius: '3px'
    };
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
  
  return <span {...attributes} style={style}>{children}</span>;
};

// Render element (for paragraphs, headings)
const Element = ({ attributes, children, element }: RenderElementProps) => {
  switch (element.type) {
    case 'heading':
      // Use React.createElement for dynamic heading elements
      return React.createElement(`h${element.level}`, attributes, children);
    default:
      return <p {...attributes}>{children}</p>;
  }
};

const Editor: React.FC = () => {
  const { activeDocumentId, documents, updateDocumentContent, references } = useProject();
  const editor = useMemo(() => withHistory(withReact(createEditor())), []);
  const [value, setValue] = useState<Descendant[]>(initialValue);
  const [currentDoc, setCurrentDoc] = useState<DocumentRow | null>(null);
  const [saveTimeout, setSaveTimeout] = useState<NodeJS.Timeout | null>(null);
  const [ghostText, setGhostText] = useState<string>('');
  const [isLoadingSuggestion, setIsLoadingSuggestion] = useState(false);
  const [mode, setMode] = useState<'freewrite' | 'vibewrite'>('freewrite');
  const suggestionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize AI service with API key
  useEffect(() => {
    // Note: API key is now handled securely in the main process via .env file
    // No need to handle API key in renderer process anymore
    console.log('AI Service ready - API key handled by main process');
  }, []);

  // Load document content when active document changes
  useEffect(() => {
    const loadDocument = async () => {
      if (!activeDocumentId) {
        setCurrentDoc(null);
        setValue(initialValue);
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
        } else {
          setValue(initialValue);
        }
      } catch (error) {
        console.error('Error parsing document content:', error);
        setValue(initialValue);
      }
    };

    loadDocument();
  }, [activeDocumentId, documents]);

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
      
      // Add a temporary alert to make it super obvious
      if (suggestion) {
        alert(`AI Suggestion Received: ${suggestion.substring(0, 100)}...`);
      }
      
    } catch (error) {
      console.error('❌ DEBUG: Error getting suggestion:', error);
      setGhostText('');
      alert(`AI Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsLoadingSuggestion(false);
    }
  }, [mode, value, references]);

  // Clear ghost text
  const clearGhostText = useCallback(() => {
    setGhostText('');
  }, []);

  // Accept ghost text suggestion
  const acceptSuggestion = useCallback(() => {
    if (!ghostText) return;

    // Insert the ghost text at the cursor
    editor.insertText(ghostText);
    clearGhostText();
  }, [editor, ghostText, clearGhostText]);

  // Auto-save with debounce
  const handleChange = useCallback((newValue: Descendant[]) => {
    setValue(newValue);

    if (!currentDoc) return;

    // Clear existing save timeout
    if (saveTimeout) {
      clearTimeout(saveTimeout);
    }

    // Set new timeout to save after 1 second of no typing
    const timeout = setTimeout(() => {
      const content = JSON.stringify(newValue);
      updateDocumentContent(currentDoc.id, content);
    }, 1000);

    setSaveTimeout(timeout);

    // Handle AI suggestion in vibe write mode
    console.log('🔍 DEBUG: handleChange - mode =', mode, 'AI enabled =', aiService.getSettings().enabled);
    
    if (mode === 'vibewrite' && aiService.getSettings().enabled) {
      console.log('✅ DEBUG: Setting up AI suggestion timer...');
      
      // Clear existing suggestion timeout
      if (suggestionTimeoutRef.current) {
        clearTimeout(suggestionTimeoutRef.current);
        console.log('🔍 DEBUG: Cleared existing suggestion timeout');
      }

      // Clear current ghost text
      clearGhostText();

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
  }, [currentDoc, saveTimeout, updateDocumentContent, mode, requestSuggestion, clearGhostText]);

  // Toggle format helper
  const toggleFormat = useCallback((format: 'bold' | 'italic' | 'underline') => {
    const isActive = isFormatActive(editor, format);
    Transforms.setNodes(
      editor,
      { [format]: isActive ? undefined : true } as any,
      { match: (n) => SlateEditor.isBlock(editor, n as any) === false, split: true }
    );
  }, [editor]);

  // Check if format is active
  const isFormatActive = (editor: SlateEditor, format: string) => {
    const marks = SlateEditor.marks(editor);
    return marks ? marks[format] === true : false;
  };

  // Keyboard shortcuts
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    // Tab to accept suggestion
    if (event.key === 'Tab' && ghostText) {
      event.preventDefault();
      acceptSuggestion();
      return;
    }

    // Escape to clear suggestion
    if (event.key === 'Escape' && ghostText) {
      event.preventDefault();
      clearGhostText();
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
  }, [toggleFormat, currentDoc, value, updateDocumentContent, ghostText, acceptSuggestion, clearGhostText]);

  // Render decorator for ghost text
  const decorate = useCallback(([node, path]: [Node, number[]]) => {
    const ranges: any[] = [];

    if (!ghostText || !Text.isText(node)) {
      return ranges;
    }

    // Show ghost text at the end of the last text node
    if (path.length === 2 && path[0] === value.length - 1) {
      const { text } = node;
      const lastTextNode = value[value.length - 1];
      const lastChild = (lastTextNode as any).children?.[(lastTextNode as any).children?.length - 1];
      
      if (lastChild === node && text.length > 0) {
        ranges.push({
          anchor: { path, offset: text.length },
          focus: { path, offset: text.length },
          ghost: true,
          text: ghostText
        });
      }
    }

    return ranges;
  }, [ghostText, value]);

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
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#1e1e1e'
    }}>
      {/* Formatting toolbar */}
      <div style={{
        padding: '8px 16px',
        borderBottom: '1px solid #333',
        display: 'flex',
        gap: '4px',
        alignItems: 'center'
      }}>
        <button
          onMouseDown={(e) => {
            e.preventDefault();
            toggleFormat('bold');
          }}
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

        <div style={{ width: '1px', height: '24px', backgroundColor: '#333', margin: '0 8px' }} />

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

        <div style={{ marginLeft: 'auto', fontSize: '12px', color: '#888', alignSelf: 'center' }}>
          {mode === 'vibewrite' && ghostText && '✨ Tab to accept | Esc to dismiss'}
          {mode === 'vibewrite' && isLoadingSuggestion && '⏳ Generating...'}
          {mode === 'freewrite' && 'Ctrl+S to save'}
        </div>
      </div>

      {/* Editor area */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '40px 80px'
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
              fontSize: '16px',
              lineHeight: '1.6',
              color: '#d4d4d4',
              outline: 'none'
            }}
          />
          
          {/* Ghost text display */}
          {ghostText && mode === 'vibewrite' && (
            <div style={{
              position: 'fixed',
              bottom: '80px',
              right: '20px',
              padding: '16px 20px',
              backgroundColor: '#2d3748',
              border: '2px solid var(--primary-green)',
              borderRadius: '8px',
              maxWidth: '450px',
              fontSize: '14px',
              color: '#e2e8f0',
              lineHeight: '1.5',
              zIndex: 1000,
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
            }}>
              <div style={{ 
                marginBottom: '10px', 
                fontSize: '12px', 
                color: 'var(--primary-green)', 
                fontWeight: 'bold',
                textTransform: 'uppercase',
                letterSpacing: '0.5px'
              }}>
                ✨ AI SUGGESTION • Press Tab to Accept
              </div>
              <div style={{ color: '#cbd5e0', fontStyle: 'italic' }}>
                {ghostText}
              </div>
            </div>
          )}
        </Slate>
      </div>
    </div>
  );
};

export default Editor;