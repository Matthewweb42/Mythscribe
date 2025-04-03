// components/EditorToolbar.tsx
import React from 'react';

const EditorToolbar: React.FC = () => {
  return (
    <div className="editor-toolbar">
      <div className="toolbar-group">
        <button className="toolbar-btn">🗂️</button>
        <button className="toolbar-btn">💾</button>
        <button className="toolbar-btn">🖨️</button>
      </div>
      <div className="toolbar-group">
        <button className="toolbar-btn">✂️</button>
        <button className="toolbar-btn">📋</button>
        <button className="toolbar-btn">📝</button>
      </div>
      <div className="toolbar-group">
        <button className="toolbar-btn">↩️</button>
        <button className="toolbar-btn">↪️</button>
      </div>
      <div className="toolbar-group">
        <button className="toolbar-btn">B</button>
        <button className="toolbar-btn">I</button>
        <button className="toolbar-btn">U</button>
      </div>
      <div className="toolbar-group">
        <button className="toolbar-btn">🔍</button>
        <button className="toolbar-btn">🔎</button>
      </div>
    </div>
  );
};

export default EditorToolbar;