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
  // Create a Map of editor instances keyed by scene ID for stable references
  const sceneEditors = useMemo(() => {
    const editorMap = new Map<string, ReturnType<typeof createEditor>>();
    scenes.forEach(scene => {
      editorMap.set(scene.id, withHistory(withReact(createEditor())));
    });
    return editorMap;
  }, [scenes.map(s => s.id).join(',')]); // Recreate when scene IDs change

  // Initialize content for each scene using Map for stable ID-based tracking
  const [sceneContents, setSceneContents] = useState<Map<string, Descendant[]>>(new Map());

  // Update scene contents when scenes change
  useEffect(() => {
    const contentMap = new Map<string, Descendant[]>();

    scenes.forEach(scene => {
      let parsedContent: Descendant[];

      if (scene.content) {
        try {
          const parsed = JSON.parse(scene.content);
          if (parsed && Array.isArray(parsed) && parsed.length > 0) {
            parsedContent = parsed;
          } else {
            parsedContent = [{ type: 'paragraph', children: [{ text: '' }] }];
          }
        } catch (error) {
          console.error(`[STACKED EDITOR] Error parsing content for scene ${scene.id} (${scene.name}):`, error);
          parsedContent = [{ type: 'paragraph', children: [{ text: '' }] }];
        }
      } else {
        parsedContent = [{ type: 'paragraph', children: [{ text: '' }] }];
      }

      contentMap.set(scene.id, parsedContent);
    });

    setSceneContents(contentMap);
  }, [scenes]);

  // Track save timeouts for each scene
  const saveTimeouts = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Handle content change for a specific scene - now using scene ID directly
  const handleSceneChange = useCallback((sceneId: string, newContent: Descendant[]) => {
    const scene = scenes.find(s => s.id === sceneId);
    if (!scene) {
      console.error('[STACKED EDITOR] Scene not found for ID:', sceneId);
      return;
    }

    // Update local state using Map
    setSceneContents(prev => {
      const updated = new Map(prev);
      updated.set(sceneId, newContent);
      return updated;
    });

    // Debounced save
    const existingTimeout = saveTimeouts.current.get(sceneId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    const timeout = setTimeout(() => {
      const contentStr = JSON.stringify(newContent);
      onSceneChange(sceneId, contentStr);
      saveTimeouts.current.delete(sceneId);
    }, 1000); // 1 second debounce

    saveTimeouts.current.set(sceneId, timeout);
  }, [scenes, onSceneChange]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      saveTimeouts.current.forEach(timeout => clearTimeout(timeout));
      saveTimeouts.current.clear();
    };
  }, []);

  // Don't render until contents are loaded for all scenes
  if (sceneContents.size === 0 || sceneContents.size !== scenes.length) {
    return <div style={{ padding: '40px', textAlign: 'center', color: '#888' }}>Loading scenes...</div>;
  }

  return (
    <div>
      {scenes.map((scene, index) => {
        // Get content and editor by scene ID (not index!)
        const content = sceneContents.get(scene.id) || [{ type: 'paragraph', children: [{ text: '' }] }];
        const editor = sceneEditors.get(scene.id);

        if (!editor) {
          console.error('[STACKED EDITOR] No editor found for scene:', scene.id, scene.name);
          return null;
        }

        // Use scene.id + content hash as key to force remount when content changes externally
        const contentHash = JSON.stringify(content).length;
        const componentKey = `${scene.id}-${contentHash}`;

        return (
          <React.Fragment key={scene.id}>
            {/* Scene Editor */}
            <div style={{
              marginBottom: index < scenes.length - 1 ? '0' : '40px'
            }}>
              <Slate
                key={componentKey}
                editor={editor}
                initialValue={content}
                onChange={(value) => handleSceneChange(scene.id, value)}
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
          {index < scenes.length - 1 && (() => {
            // Check if this is a matter document (front/end matter)
            const isMatterDocument = scene.section === 'front-matter' || scene.section === 'end-matter';

            if (isMatterDocument) {
              // Gray page break for matter documents
              return (
                <div
                  contentEditable={false}
                  style={{
                    height: '1px',
                    backgroundColor: '#555',
                    margin: '40px 0',
                    userSelect: 'none',
                    cursor: 'default'
                  }}
                />
              );
            } else {
              // Traditional scene break for manuscript scenes
              return (
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
              );
            }
          })()}
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default StackedSceneEditor;
