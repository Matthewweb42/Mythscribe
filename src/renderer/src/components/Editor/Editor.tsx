// src/renderer/src/components/Editor/Editor.tsx
import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { createEditor, Descendant, Editor as SlateEditor, Transforms } from 'slate';
import { Slate, Editable, withReact, RenderLeafProps, RenderElementProps } from 'slate-react';
import { withHistory } from 'slate-history';
import { Bold, Italic, Underline } from 'lucide-react';
import { useProject } from '../../contexts/ProjectContext';
import { DocumentRow } from '../../../types/window';
import { File } from 'lucide-react';

// Custom types for Slate
type CustomText = { 
  text: string; 
  bold?: boolean; 
  italic?: boolean; 
  underline?: boolean;
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

// Render leaf (for bold, italic, underline)
const Leaf = ({ attributes, children, leaf }: RenderLeafProps) => {
  if (leaf.bold) {
    children = <strong>{children}</strong>;
  }
  if (leaf.italic) {
    children = <em>{children}</em>;
  }
  if (leaf.underline) {
    children = <u>{children}</u>;
  }
  return <span {...attributes}>{children}</span>;
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
  const { activeDocumentId, documents, updateDocumentContent } = useProject();
  const editor = useMemo(() => withHistory(withReact(createEditor())), []);
  const [value, setValue] = useState<Descendant[]>(initialValue);
  const [currentDoc, setCurrentDoc] = useState<DocumentRow | null>(null);
  const [saveTimeout, setSaveTimeout] = useState<NodeJS.Timeout | null>(null);

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

  // Auto-save with debounce
  const handleChange = useCallback((newValue: Descendant[]) => {
    setValue(newValue);

    if (!currentDoc) return;

    // Clear existing timeout
    if (saveTimeout) {
      clearTimeout(saveTimeout);
    }

    // Set new timeout to save after 1 second of no typing
    const timeout = setTimeout(() => {
      const content = JSON.stringify(newValue);
      updateDocumentContent(currentDoc.id, content);
      console.log('Auto-saved');
    }, 1000);

    setSaveTimeout(timeout);
  }, [currentDoc, saveTimeout, updateDocumentContent]);

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
          console.log('Manually saved');
        }
        break;
    }
  }, [toggleFormat, currentDoc, value, updateDocumentContent]);

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
            backgroundColor: isFormatActive(editor, 'bold') ? 'var(--primary-green)' : '#333',
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
            backgroundColor: isFormatActive(editor, 'italic') ? 'var(--primary-green)' : '#333',
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
            backgroundColor: isFormatActive(editor, 'underline') ? 'var(--primary-green)' : '#333',
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

        <div style={{ marginLeft: 'auto', fontSize: '12px', color: '#888', alignSelf: 'center' }}>
          Free Write Mode | Ctrl+S to save
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
  );
};

export default Editor;