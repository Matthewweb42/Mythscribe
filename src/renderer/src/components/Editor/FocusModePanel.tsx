// src/renderer/src/components/Editor/FocusModePanel.tsx
import React, { useState, useEffect } from 'react';
import { Image as ImageIcon, X, RotateCw, FileText, Sparkles, StickyNote, MessageSquare } from 'lucide-react';

interface FocusModePanelProps {
  onOpenBackgroundManager: () => void;
  onExit: () => void;
  overlayOpacity: number;
  onOverlayOpacityChange: (value: number) => void;
  windowWidth: number;
  onWindowWidthChange: (value: number) => void;
  rotationEnabled: boolean;
  onRotationToggle: () => void;
  wordCount: number;
  mode: 'freewrite' | 'vibewrite';
  onModeToggle: () => void;
  notesVisible: boolean;
  onNotesToggle: () => void;
  aiVisible: boolean;
  onAIToggle: () => void;
}

const FocusModePanel: React.FC<FocusModePanelProps> = ({
  onOpenBackgroundManager,
  onExit,
  overlayOpacity,
  onOverlayOpacityChange,
  windowWidth,
  onWindowWidthChange,
  rotationEnabled,
  onRotationToggle,
  wordCount,
  mode,
  onModeToggle,
  notesVisible,
  onNotesToggle,
  aiVisible,
  onAIToggle
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [isHoveringPanel, setIsHoveringPanel] = useState(false);
  const [hideTimeout, setHideTimeout] = useState<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // Show panel when mouse is in bottom 100px of screen
      const windowHeight = window.innerHeight;
      const inBottomZone = e.clientY > windowHeight - 100;

      if (inBottomZone || isHoveringPanel) {
        // Clear any pending hide timeout
        if (hideTimeout) {
          clearTimeout(hideTimeout);
          setHideTimeout(null);
        }
        setIsVisible(true);
      } else if (!isHoveringPanel && isVisible) {
        // Mouse left bottom zone and not hovering panel - start hide timer
        if (!hideTimeout) {
          const timeout = setTimeout(() => {
            setIsVisible(false);
            setHideTimeout(null);
          }, 500); // 500ms delay before hiding
          setHideTimeout(timeout);
        }
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (hideTimeout) clearTimeout(hideTimeout);
    };
  }, [isHoveringPanel, isVisible, hideTimeout]);

  const handlePanelMouseEnter = () => {
    setIsHoveringPanel(true);
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      setHideTimeout(null);
    }
  };

  const handlePanelMouseLeave = () => {
    setIsHoveringPanel(false);
    // Start hide timer when mouse leaves panel
    const timeout = setTimeout(() => {
      setIsVisible(false);
      setHideTimeout(null);
    }, 500);
    setHideTimeout(timeout);
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 10000,
        pointerEvents: isVisible ? 'auto' : 'none',
        opacity: isVisible ? 1 : 0,
        transition: 'opacity 0.3s ease-in-out',
        padding: '20px',
        background: 'linear-gradient(to top, rgba(0, 0, 0, 0.9) 0%, rgba(0, 0, 0, 0) 100%)'
      }}
    >
      <div
        onMouseEnter={handlePanelMouseEnter}
        onMouseLeave={handlePanelMouseLeave}
        style={{
          maxWidth: '1200px',
          margin: '0 auto',
          backgroundColor: 'rgba(30, 30, 30, 0.95)',
          border: '1px solid #444',
          borderRadius: '12px',
          padding: '20px',
          backdropFilter: 'blur(10px)'
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            gap: '20px',
            alignItems: 'center'
          }}
        >
          {/* Left: Action Buttons */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={onOpenBackgroundManager}
              title="Manage Backgrounds"
              style={{
                padding: '10px 16px',
                backgroundColor: '#0e639c',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'background-color 0.2s'
              }}
            >
              <ImageIcon size={16} />
              Backgrounds
            </button>

            <button
              onClick={onRotationToggle}
              title={rotationEnabled ? 'Disable rotation' : 'Enable rotation'}
              style={{
                padding: '10px 16px',
                backgroundColor: rotationEnabled ? '#0e639c' : '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'background-color 0.2s'
              }}
            >
              <RotateCw size={16} />
              Rotate
            </button>

            <button
              onClick={onModeToggle}
              title={mode === 'vibewrite' ? 'Disable VibeWrite' : 'Enable VibeWrite'}
              style={{
                padding: '10px 16px',
                backgroundColor: mode === 'vibewrite' ? '#0e639c' : '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'background-color 0.2s'
              }}
            >
              <Sparkles size={16} />
              VibeWrite
            </button>

            <button
              onClick={onNotesToggle}
              title={notesVisible ? 'Hide notes' : 'Show notes'}
              style={{
                padding: '10px 16px',
                backgroundColor: notesVisible ? '#0e639c' : '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'background-color 0.2s'
              }}
            >
              <StickyNote size={16} />
              Notes
            </button>

            <button
              onClick={onAIToggle}
              title={aiVisible ? 'Hide AI Assistant' : 'Show AI Assistant'}
              style={{
                padding: '10px 16px',
                backgroundColor: aiVisible ? '#0e639c' : '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'background-color 0.2s'
              }}
            >
              <MessageSquare size={16} />
              AI Assistant
            </button>
          </div>

          {/* Center: Sliders */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {/* Overlay Opacity Slider */}
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: '6px',
                  fontSize: '11px',
                  color: '#999',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px'
                }}
              >
                <span>Overlay Opacity</span>
                <span>{overlayOpacity}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={overlayOpacity}
                onChange={(e) => onOverlayOpacityChange(parseInt(e.target.value))}
                style={{
                  width: '100%',
                  cursor: 'pointer'
                }}
              />
            </div>

            {/* Window Width Slider */}
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: '6px',
                  fontSize: '11px',
                  color: '#999',
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px'
                }}
              >
                <span>Writing Area Width</span>
                <span>{windowWidth}%</span>
              </div>
              <input
                type="range"
                min="40"
                max="100"
                value={windowWidth}
                onChange={(e) => onWindowWidthChange(parseInt(e.target.value))}
                style={{
                  width: '100%',
                  cursor: 'pointer'
                }}
              />
            </div>
          </div>

          {/* Right: Stats and Exit */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '10px 16px',
                backgroundColor: '#252526',
                borderRadius: '6px',
                fontSize: '13px',
                color: '#ccc'
              }}
            >
              <FileText size={16} />
              <span style={{ fontWeight: 'bold', color: '#fff' }}>
                {wordCount.toLocaleString()}
              </span>
              <span style={{ fontSize: '11px' }}>words</span>
            </div>

            <button
              onClick={onExit}
              title="Exit Focus Mode (Esc)"
              style={{
                padding: '10px 16px',
                backgroundColor: '#d32f2f',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'background-color 0.2s'
              }}
            >
              <X size={16} />
              Exit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FocusModePanel;
