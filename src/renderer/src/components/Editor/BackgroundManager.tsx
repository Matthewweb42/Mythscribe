// src/renderer/src/components/Editor/BackgroundManager.tsx
import React, { useState, useEffect } from 'react';
import { Upload, Trash2, X } from 'lucide-react';
import { ProjectAsset } from '../../../types/window';

interface BackgroundManagerProps {
  isOpen: boolean;
  onClose: () => void;
  currentBackgroundId: string | null;
  onSelectBackground: (assetId: string | null) => void;
}

const BackgroundManager: React.FC<BackgroundManagerProps> = ({
  isOpen,
  onClose,
  currentBackgroundId,
  onSelectBackground
}) => {
  const [backgrounds, setBackgrounds] = useState<ProjectAsset[]>([]);
  const [loading, setLoading] = useState(false);

  // Load backgrounds on mount
  useEffect(() => {
    if (isOpen) {
      loadBackgrounds();
    }
  }, [isOpen]);

  const loadBackgrounds = async () => {
    try {
      const assets = await window.api.focus.getBackgrounds();
      setBackgrounds(assets);
    } catch (error) {
      console.error('Error loading backgrounds:', error);
    }
  };

  const handleUpload = async () => {
    try {
      setLoading(true);
      const result = await window.api.focus.uploadBackground();
      if (result) {
        await loadBackgrounds();
      }
    } catch (error) {
      console.error('Error uploading background:', error);
      alert('Failed to upload background image');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (assetId: string) => {
    if (!confirm('Are you sure you want to delete this background?')) {
      return;
    }

    try {
      await window.api.focus.deleteBackground(assetId);

      // If this was the current background, clear it
      if (currentBackgroundId === assetId) {
        onSelectBackground(null);
      }

      await loadBackgrounds();
    } catch (error) {
      console.error('Error deleting background:', error);
      alert('Failed to delete background');
    }
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: '#1e1e1e',
          borderRadius: '8px',
          maxWidth: '800px',
          width: '100%',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid #333'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px',
            borderBottom: '1px solid #333',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <h2 style={{ margin: 0, fontSize: '18px', color: '#fff' }}>
            Background Manager
          </h2>
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
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '20px'
          }}
        >
          {/* Upload Button */}
          <button
            onClick={handleUpload}
            disabled={loading}
            style={{
              width: '100%',
              padding: '16px',
              backgroundColor: '#0e639c',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              marginBottom: '20px',
              opacity: loading ? 0.6 : 1
            }}
          >
            <Upload size={16} />
            {loading ? 'Uploading...' : 'Upload New Background'}
          </button>

          {/* No Background Option */}
          <div
            onClick={() => onSelectBackground(null)}
            style={{
              padding: '16px',
              backgroundColor: currentBackgroundId === null ? '#0e639c' : '#252526',
              border: '1px solid #333',
              borderRadius: '4px',
              cursor: 'pointer',
              marginBottom: '12px',
              transition: 'background-color 0.2s'
            }}
          >
            <div style={{ color: '#fff', fontSize: '14px' }}>
              No Background
            </div>
          </div>

          {/* Background Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: '12px'
            }}
          >
            {backgrounds.map((bg) => (
              <div
                key={bg.id}
                style={{
                  position: 'relative',
                  border: currentBackgroundId === bg.id ? '2px solid #0e639c' : '1px solid #333',
                  borderRadius: '8px',
                  overflow: 'hidden',
                  cursor: 'pointer',
                  backgroundColor: '#252526'
                }}
                onClick={() => onSelectBackground(bg.id)}
              >
                {/* Thumbnail */}
                <div
                  style={{
                    width: '100%',
                    height: '150px',
                    backgroundImage: `url(${bg.file_path})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center'
                  }}
                />

                {/* Info */}
                <div
                  style={{
                    padding: '8px',
                    backgroundColor: '#1e1e1e',
                    fontSize: '12px',
                    color: '#ccc',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}
                >
                  <div
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1
                    }}
                    title={bg.file_name}
                  >
                    {bg.file_name.replace(/^\d+-/, '')}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(bg.id);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#888',
                      cursor: 'pointer',
                      padding: '4px',
                      display: 'flex',
                      alignItems: 'center'
                    }}
                    title="Delete background"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                {/* Selected Indicator */}
                {currentBackgroundId === bg.id && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '8px',
                      right: '8px',
                      backgroundColor: '#0e639c',
                      color: '#fff',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 'bold'
                    }}
                  >
                    ACTIVE
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Empty State */}
          {backgrounds.length === 0 && (
            <div
              style={{
                padding: '40px 20px',
                textAlign: 'center',
                color: '#666',
                fontSize: '14px'
              }}
            >
              <p style={{ marginBottom: '8px' }}>No backgrounds uploaded yet</p>
              <p style={{ fontSize: '12px', fontStyle: 'italic' }}>
                Click "Upload New Background" to add custom backgrounds
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BackgroundManager;
