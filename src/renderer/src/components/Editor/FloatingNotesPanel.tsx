// src/renderer/src/components/Editor/FloatingNotesPanel.tsx
import React, { useState, useEffect, useRef } from 'react';
import { X, GripVertical } from 'lucide-react';
import { Slate, Editable, RenderLeafProps } from 'slate-react';
import { Editor } from 'slate';

interface FloatingNotesPanelProps {
  isVisible: boolean;
  onClose: () => void;
  notesEditor: Editor;
  notesValue: any[];
  onNotesChange: (value: any[]) => void;
  renderLeaf: (props: RenderLeafProps) => JSX.Element;
  renderElement: (props: any) => JSX.Element;
}

const FloatingNotesPanel: React.FC<FloatingNotesPanelProps> = ({
  isVisible,
  onClose,
  notesEditor,
  notesValue,
  onNotesChange,
  renderLeaf,
  renderElement
}) => {
  const [position, setPosition] = useState({ top: 20, left: window.innerWidth - 420 });
  const [size, setSize] = useState({ width: 400, height: 500 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0 });

  const panelRef = useRef<HTMLDivElement>(null);

  // Load saved position and size from database
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const savedPosition = await window.api.settings.get('floating_notes_position');
        const savedSize = await window.api.settings.get('floating_notes_size');

        if (savedPosition) {
          const pos = JSON.parse(savedPosition);
          setPosition(pos);
        }
        if (savedSize) {
          const sz = JSON.parse(savedSize);
          setSize(sz);
        }
      } catch (error) {
        console.error('Error loading floating notes settings:', error);
      }
    };

    loadSettings();
  }, []);

  // Save position when changed
  useEffect(() => {
    const savePosition = async () => {
      try {
        await window.api.settings.set('floating_notes_position', JSON.stringify(position));
      } catch (error) {
        console.error('Error saving floating notes position:', error);
      }
    };

    if (position.top !== 20 || position.left !== window.innerWidth - 420) {
      savePosition();
    }
  }, [position]);

  // Save size when changed
  useEffect(() => {
    const saveSize = async () => {
      try {
        await window.api.settings.set('floating_notes_size', JSON.stringify(size));
      } catch (error) {
        console.error('Error saving floating notes size:', error);
      }
    };

    if (size.width !== 400 || size.height !== 500) {
      saveSize();
    }
  }, [size]);

  // Handle drag start
  const handleDragStart = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - position.left, y: e.clientY - position.top });
  };

  // Handle resize start
  const handleResizeStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsResizing(true);
    setResizeStart({
      x: e.clientX,
      y: e.clientY,
      width: size.width,
      height: size.height
    });
  };

  // Handle mouse move
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        const newLeft = e.clientX - dragStart.x;
        const newTop = e.clientY - dragStart.y;

        // Constrain to viewport
        const maxLeft = window.innerWidth - size.width;
        const maxTop = window.innerHeight - size.height;

        setPosition({
          left: Math.max(0, Math.min(newLeft, maxLeft)),
          top: Math.max(0, Math.min(newTop, maxTop))
        });
      } else if (isResizing) {
        const deltaX = e.clientX - resizeStart.x;
        const deltaY = e.clientY - resizeStart.y;

        const newWidth = Math.max(300, Math.min(resizeStart.width + deltaX, window.innerWidth * 0.8));
        const newHeight = Math.max(300, Math.min(resizeStart.height + deltaY, window.innerHeight * 0.8));

        setSize({ width: newWidth, height: newHeight });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setIsResizing(false);
    };

    if (isDragging || isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);

      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, isResizing, dragStart, resizeStart, size]);

  if (!isVisible) return null;

  return (
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        width: size.width,
        height: size.height,
        zIndex: 9999,
        backgroundColor: 'rgba(30, 30, 30, 0.98)',
        border: '1px solid #444',
        borderRadius: '8px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
        backdropFilter: 'blur(10px)'
      }}
    >
      {/* Header - Drag Handle */}
      <div
        onMouseDown={handleDragStart}
        style={{
          padding: '12px 16px',
          backgroundColor: 'rgba(20, 20, 20, 0.9)',
          borderBottom: '1px solid #444',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: isDragging ? 'grabbing' : 'grab',
          userSelect: 'none'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <GripVertical size={16} style={{ color: '#666' }} />
          <span style={{ color: '#fff', fontSize: '14px', fontWeight: 'bold' }}>
            Notes
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: '#888',
            cursor: 'pointer',
            padding: '4px',
            display: 'flex',
            alignItems: 'center'
          }}
          title="Close notes"
        >
          <X size={18} />
        </button>
      </div>

      {/* Content - Notes Editor */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '16px'
        }}
      >
        <Slate
          editor={notesEditor}
          initialValue={notesValue}
          onChange={onNotesChange}
        >
          <Editable
            renderLeaf={renderLeaf}
            renderElement={renderElement}
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

      {/* Resize Handle */}
      <div
        onMouseDown={handleResizeStart}
        style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: '20px',
          height: '20px',
          cursor: 'nwse-resize',
          background: 'linear-gradient(135deg, transparent 0%, transparent 50%, #666 50%, #666 100%)',
          borderBottomRightRadius: '8px'
        }}
      />
    </div>
  );
};

export default FloatingNotesPanel;
