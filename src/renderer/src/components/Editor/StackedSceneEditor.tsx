// src/renderer/src/components/Editor/StackedSceneEditor.tsx
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { createEditor, Descendant } from 'slate';
import { Slate, Editable, withReact } from 'slate-react';
import { withHistory } from 'slate-history';
import { DocumentRow } from '../../../types/window';

interface StackedSceneEditorProps {
  scenes: DocumentRow[];
  onSceneChange: (sceneId: string, content: string) => void;
  sceneBreakStyle: string;
  renderElement: any; // Element renderer from parent
  renderLeaf: any; // Leaf renderer from parent
  editorTextSize: number;
  editorLineHeight: number;
}

const StackedSceneEditor: React.FC<StackedSceneEditorProps> = ({
  scenes,
  onSceneChange,
  sceneBreakStyle,
  renderElement,
  renderLeaf,
  editorTextSize,
  editorLineHeight
}) => {
  // Create a separate editor instance for each scene
  const sceneEditors = useMemo(() => {
    return scenes.map(() => withHistory(withReact(createEditor())));
  }, [scenes.length]); // Only recreate when number of scenes changes

  // Initialize content for each scene
  const [sceneContents, setSceneContents] = useState<Descendant[][]>([]);

  // Update scene contents when scenes change
  useEffect(() => {
    const initialContents = scenes.map(scene => {
      if (scene.content) {
        try {
          const parsed = JSON.parse(scene.content);
          if (parsed && Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
          }
        } catch (error) {
          console.error('[STACKED EDITOR] Error parsing scene content:', error);
        }
      }
      return [{ type: 'paragraph', children: [{ text: '' }] }];
    });

    console.log('[STACKED EDITOR] Initializing contents for', scenes.length, 'scenes');
    setSceneContents(initialContents);
  }, [scenes]);

  // Track save timeouts for each scene
  const saveTimeouts = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Handle content change for a specific scene
  const handleSceneChange = useCallback((sceneIndex: number, newContent: Descendant[]) => {
    const scene = scenes[sceneIndex];
    if (!scene) return;

    console.log('[STACKED EDITOR] Scene changed:', scene.name, 'Index:', sceneIndex);

    // Update local state
    setSceneContents(prev => {
      const updated = [...prev];
      updated[sceneIndex] = newContent;
      return updated;
    });

    // Debounced save
    const existingTimeout = saveTimeouts.current.get(scene.id);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      console.log('[STACKED EDITOR] Cleared existing timeout for:', scene.name);
    }

    const timeout = setTimeout(() => {
      console.log('[STACKED EDITOR] Debounce complete, calling onSceneChange for:', scene.name);
      const contentStr = JSON.stringify(newContent);
      onSceneChange(scene.id, contentStr);
      saveTimeouts.current.delete(scene.id);
    }, 1000); // 1 second debounce

    saveTimeouts.current.set(scene.id, timeout);
    console.log('[STACKED EDITOR] Set timeout for:', scene.name);
  }, [scenes, onSceneChange]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      saveTimeouts.current.forEach(timeout => clearTimeout(timeout));
      saveTimeouts.current.clear();
    };
  }, []);

  // Don't render until contents are loaded
  if (sceneContents.length === 0 || sceneContents.length !== scenes.length) {
    return <div style={{ padding: '40px', textAlign: 'center', color: '#888' }}>Loading scenes...</div>;
  }

  return (
    <div>
      {scenes.map((scene, index) => {
        // Ensure we have valid content for this scene
        const content = sceneContents[index] || [{ type: 'paragraph', children: [{ text: '' }] }];

        return (
          <React.Fragment key={scene.id}>
            {/* Scene Editor */}
            <div style={{
              marginBottom: index < scenes.length - 1 ? '0' : '40px'
            }}>
              <Slate
                editor={sceneEditors[index]}
                initialValue={content}
                onChange={(value) => handleSceneChange(index, value)}
              >
              <Editable
                renderLeaf={renderLeaf}
                renderElement={renderElement}
                placeholder={`Scene ${index + 1}: ${scene.name}`}
                spellCheck
                style={{
                  minHeight: '200px',
                  fontSize: `${editorTextSize}px`,
                  lineHeight: `${editorLineHeight}`,
                  color: '#d4d4d4',
                  outline: 'none',
                  paddingBottom: '20px'
                }}
              />
            </Slate>
          </div>

          {/* Scene Break Separator (read-only) */}
          {index < scenes.length - 1 && (
            <div
              contentEditable={false}
              style={{
                textAlign: 'center',
                color: '#666',
                fontSize: '16px',
                padding: '30px 0',
                margin: '0',
                userSelect: 'none',
                cursor: 'default',
                borderTop: '1px solid #333',
                borderBottom: '1px solid #333',
                backgroundColor: 'rgba(30, 30, 30, 0.5)'
              }}
            >
              {sceneBreakStyle}
            </div>
          )}
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default StackedSceneEditor;
