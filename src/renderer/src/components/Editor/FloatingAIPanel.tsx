// src/renderer/src/components/Editor/FloatingAIPanel.tsx
import React, { useState, useEffect, useRef } from 'react';
import { X, GripVertical } from 'lucide-react';
import AIAssistantPanel from '../AIAssistantPanel';

interface FloatingAIPanelProps {
  isVisible: boolean;
  onClose: () => void;
  onInsertText: (text: string) => void;
  onSetGhostText?: (text: string) => void;
  references: Array<{ id: string; name: string; category: string; content: string }>;
  activeDocument?: { id: string; name: string; content: string | null } | null;
}

const FloatingAIPanel: React.FC<FloatingAIPanelProps> = ({
  isVisible,
  onClose,
  onInsertText,
  onSetGhostText,
  references,
  activeDocument
}) => {
  const [position, setPosition] = useState({ top: 20, left: 20 });
  const [size, setSize] = useState({ width: 500, height: 600 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0 });

  const panelRef = useRef<HTMLDivElement>(null);

  // Load saved position and size from database
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const savedPosition = await window.api.settings.get('floating_ai_position');
        const savedSize = await window.api.settings.get('floating_ai_size');

        if (savedPosition) {
          const pos = JSON.parse(savedPosition);
          setPosition(pos);
        }
        if (savedSize) {
          const sz = JSON.parse(savedSize);
          setSize(sz);
        }
      } catch (error) {
        console.error('Error loading floating AI settings:', error);
      }
    };

    loadSettings();
  }, []);

  // Save position when changed
  useEffect(() => {
    const savePosition = async () => {
      try {
        await window.api.settings.set('floating_ai_position', JSON.stringify(position));
      } catch (error) {
        console.error('Error saving floating AI position:', error);
      }
    };

    if (position.top !== 20 || position.left !== 20) {
      savePosition();
    }
  }, [position]);

  // Save size when changed
  useEffect(() => {
    const saveSize = async () => {
      try {
        await window.api.settings.set('floating_ai_size', JSON.stringify(size));
      } catch (error) {
        console.error('Error saving floating AI size:', error);
      }
    };

    if (size.width !== 500 || size.height !== 600) {
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

        const newWidth = Math.max(400, Math.min(resizeStart.width + deltaX, window.innerWidth * 0.8));
        const newHeight = Math.max(400, Math.min(resizeStart.height + deltaY, window.innerHeight * 0.8));

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
            AI Assistant
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
          title="Close AI Assistant"
        >
          <X size={18} />
        </button>
      </div>

      {/* Content - AI Assistant */}
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        <AIAssistantPanel
          onClose={() => {}} // Don't use this close, use the header close button
          onInsertText={onInsertText}
          onSetGhostText={onSetGhostText}
          references={references}
          activeDocument={activeDocument}
        />
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

export default FloatingAIPanel;
