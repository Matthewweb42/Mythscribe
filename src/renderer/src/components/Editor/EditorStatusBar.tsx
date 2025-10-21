// src/renderer/src/components/Editor/EditorStatusBar.tsx
import React from 'react';

interface EditorStatusBarProps {
  wordCount: number;
  sessionWordCount: number;
}

const EditorStatusBar: React.FC<EditorStatusBarProps> = ({
  wordCount,
  sessionWordCount
}) => {
  // Format numbers with commas for readability
  const formatNumber = (num: number): string => {
    return num.toLocaleString();
  };

  // Format session count with + or - prefix
  const formatSessionCount = (num: number): string => {
    if (num === 0) return '±0';
    return num > 0 ? `+${formatNumber(num)}` : formatNumber(num);
  };

  return (
    <div style={{
      height: '28px',
      backgroundColor: '#252526',
      borderTop: '1px solid #333',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 12px',
      fontSize: '11px',
      color: '#888',
      userSelect: 'none',
      flexShrink: 0
    }}>
      <div style={{
        display: 'flex',
        gap: '16px',
        alignItems: 'center'
      }}>
        <span>
          <span style={{ fontWeight: 'bold', color: '#aaa' }}>Words:</span>{' '}
          <span style={{ color: '#d4d4d4' }}>{formatNumber(wordCount)}</span>
        </span>
        <span style={{ color: '#555' }}>|</span>
        <span>
          <span style={{ fontWeight: 'bold', color: '#aaa' }}>Session:</span>{' '}
          <span style={{
            color: sessionWordCount > 0 ? 'var(--primary-green)' : sessionWordCount < 0 ? '#f48771' : '#888'
          }}>
            {formatSessionCount(sessionWordCount)}
          </span>
        </span>
      </div>
    </div>
  );
};

export default EditorStatusBar;
