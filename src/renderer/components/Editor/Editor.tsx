// src/renderer/components/Editor/Editor.tsx
import React, { useState, useMemo, useCallback } from 'react';
import { createEditor, Descendant, Editor as SlateEditor, Transforms, Element as SlateElement } from 'slate';
import { Slate, Editable, withReact, RenderLeafProps, RenderElementProps } from 'slate-react';
import { withHistory } from 'slate-history';
import { Document } from '../../types';
import { Bold, Italic, Underline } from 'lucide-react';

interface EditorProps {
  document: Document | null;
}

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
    Editor: SlateEditor;
    Element: CustomElement;
    Text: CustomText;
  }
}

// Initial empty content
const initialValue: Descendant[] = [
  {
    type: 'paragraph',
    children: [{ text: 'Start writing your story...' }],
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
      const HeadingTag = `h${element.level}` as keyof JSX.IntrinsicElements;
      return <HeadingTag {...attributes}>{children}</HeadingTag>;
    default:
      return <p {...attributes}>{children}</p>;
  }
};

const Editor: React.FC<EditorProps> = ({ document }) => {
  const editor = useMemo(() => withHistory(withReact(createEditor())), []);
  const [value, setValue] = useState<Descendant[]>(initialValue);

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
    }
  }, [toggleFormat]);

  if (!document) {
    return (
      <div style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#888'
      }}>
        Select a document to start writing
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
        gap: '4px'
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

        <div style={{ marginLeft: 'auto', fontSize: '12px', color: '#888', alignSelf: 'center' }}>
          Free Write Mode
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
          onValueChange={setValue}
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