import React, { useState, useRef, useEffect } from 'react';
import './WordProcessor.css';

interface WordProcessorProps {
  initialContent?: string;
  onSave?: (content: string) => void;
}

const WordProcessor: React.FC<WordProcessorProps> = ({
  initialContent = '',
  onSave,
}) => {
  const [content, setContent] = useState<string>(initialContent);
  const [isBold, setIsBold] = useState<boolean>(false);
  const [isItalic, setIsItalic] = useState<boolean>(false);
  const [isUnderline, setIsUnderline] = useState<boolean>(false);
  const [fontSize, setFontSize] = useState<number>(16);
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = content;
    }
  }, []);

  const handleContentChange = () => {
    if (editorRef.current) {
      setContent(editorRef.current.innerHTML);
    }
  };

  const toggleBold = () => {
    document.execCommand('bold', false);
    setIsBold(!isBold);
  };

  const toggleItalic = () => {
    document.execCommand('italic', false);
    setIsItalic(!isItalic);
  };

  const toggleUnderline = () => {
    document.execCommand('underline', false);
    setIsUnderline(!isUnderline);
  };

  const increaseFontSize = () => {
    setFontSize(prev => {
      const newSize = prev + 2;
      document.execCommand('fontSize', false, '7');
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const span = document.createElement('span');
        span.style.fontSize = `${newSize}px`;
        range.surroundContents(span);
      }
      return newSize;
    });
  };

  const decreaseFontSize = () => {
    setFontSize(prev => {
      const newSize = Math.max(8, prev - 2);
      document.execCommand('fontSize', false, '1');
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const span = document.createElement('span');
        span.style.fontSize = `${newSize}px`;
        range.surroundContents(span);
      }
      return newSize;
    });
  };

  const handleSave = () => {
    if (onSave) {
      onSave(content);
    }
    alert('Content saved!');
  };

  return (
    <div className="word-processor">
      <div className="toolbar">
        <button 
          className={`tool-button ${isBold ? 'active' : ''}`} 
          onClick={toggleBold} 
          title="Bold"
        >
          B
        </button>
        <button 
          className={`tool-button ${isItalic ? 'active' : ''}`} 
          onClick={toggleItalic} 
          title="Italic"
        >
          I
        </button>
        <button 
          className={`tool-button ${isUnderline ? 'active' : ''}`} 
          onClick={toggleUnderline} 
          title="Underline"
        >
          U
        </button>
        <button 
          className="tool-button" 
          onClick={decreaseFontSize} 
          title="Decrease Font Size"
        >
          A-
        </button>
        <span className="font-size-display">{fontSize}px</span>
        <button 
          className="tool-button" 
          onClick={increaseFontSize} 
          title="Increase Font Size"
        >
          A+
        </button>
        <button 
          className="save-button" 
          onClick={handleSave} 
          title="Save"
        >
          Save
        </button>
      </div>
      <div 
        className="editor"
        ref={editorRef}
        contentEditable={true}
        onInput={handleContentChange}
      />
    </div>
  );
};

export default WordProcessor;