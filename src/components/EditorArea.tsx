// components/EditorArea.tsx
import React from 'react';
import EditorToolbar from './EditorToolbar';

interface EditorAreaProps {
  content: string;
  setContent: (content: string) => void;
  stats: {
    wordCount: number;
    charCount: number;
    lastSaved: string;
  };
}

const EditorArea: React.FC<EditorAreaProps> = ({ content, setContent, stats }) => {
  // Function to handle content changes
  const handleContentChange = (e: React.FormEvent<HTMLDivElement>) => {
    const newContent = e.currentTarget.innerHTML;
    setContent(newContent);
    // In a real app, you would update word count, character count, etc. here
  };

  return (
    <div className="editor-area">
      <EditorToolbar />
      <div className="editor-content">
        <div 
          className="document" 
          contentEditable="true"
          dangerouslySetInnerHTML={{ __html: content }}
          onInput={handleContentChange}
        />
      </div>
      <div className="status-bar">
        <div className="word-count">
          <span>Words: {stats.wordCount}</span>
          <span>Characters: {stats.charCount.toLocaleString()}</span>
        </div>
        <div className="status-info">
          <span>Chapter 1 - The Beginning</span>
          <span>Last saved: {stats.lastSaved}</span>
        </div>
      </div>
    </div>
  );
};

export default EditorArea;