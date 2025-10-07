// src/renderer/src/components/Sidebar/Sidebar.tsx
import React, { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, File, FolderIcon, Trash2, Plus, BookOpen, Layers, FileText } from 'lucide-react';
import { useProject } from '../contexts/ProjectContext';
import { DocumentRow } from '../../types/window';

interface TreeNode {
  item: DocumentRow;
  children: TreeNode[];
}

// Helper to get icon and color based on hierarchy level
const getHierarchyIcon = (level: string | null) => {
  switch (level) {
    case 'novel':
      return { icon: BookOpen, color: 'var(--primary-green)' };
    case 'part':
      return { icon: Layers, color: '#569cd6' };
    case 'chapter':
      return { icon: FolderIcon, color: '#ce9178' };
    case 'scene':
      return { icon: FileText, color: '#4ec9b0' };
    default:
      return { icon: File, color: 'var(--primary-green)' };
  }
};

const TreeNodeComponent: React.FC<{
  node: TreeNode;
  level: number;
  onSelect: (doc: DocumentRow) => void;
  onDelete: (id: string) => void;
  activeId?: string;
}> = ({ node, level, onSelect, onDelete, activeId }) => {
  const [isOpen, setIsOpen] = useState(true);
  const isFolder = node.item.type === 'folder';
  const isActive = node.item.type === 'document' && node.item.id === activeId;

  const handleClick = () => {
    if (isFolder) {
      setIsOpen(!isOpen);
    } else {
      onSelect(node.item);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Delete "${node.item.name}"?`)) {
      onDelete(node.item.id);
    }
  };

  return (
    <div>
      <div
        style={{
          padding: '6px 8px',
          paddingLeft: `${level * 16 + 8}px`,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          backgroundColor: isActive ? '#37373d' : 'transparent',
          borderLeft: isActive ? '2px solid var(--primary-green)' : '2px solid transparent',
          position: 'relative'
        }}
        onMouseEnter={(e) => {
          if (!isActive) e.currentTarget.style.backgroundColor = '#2a2d2e';
        }}
        onMouseLeave={(e) => {
          if (!isActive) e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <div onClick={handleClick} style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1 }}>
          {isFolder ? (
            <>
              {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              {(() => {
                const { icon: Icon, color } = getHierarchyIcon(node.item.hierarchy_level);
                return <Icon size={16} color={color} />;
              })()}
            </>
          ) : (
            <>
              <div style={{ width: '16px' }} />
              {(() => {
                const { icon: Icon, color } = getHierarchyIcon(node.item.hierarchy_level);
                return <Icon size={16} color={color} />;
              })()}
            </>
          )}
          <span style={{ fontSize: '13px' }}>
            {node.item.name}
            {node.item.word_count > 0 && (
              <span style={{ marginLeft: '8px', fontSize: '11px', color: '#888' }}>
                ({node.item.word_count.toLocaleString()} words)
              </span>
            )}
          </span>
        </div>

        {/* Delete button */}
        <button
          onClick={handleDelete}
          style={{
            padding: '2px 4px',
            backgroundColor: 'transparent',
            border: 'none',
            cursor: 'pointer',
            opacity: 0.5,
            display: 'flex',
            alignItems: 'center'
          }}
          onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
          onMouseLeave={(e) => e.currentTarget.style.opacity = '0.5'}
        >
          <Trash2 size={14} color="#f48771" />
        </button>
      </div>

      {isFolder && isOpen && node.children.map(child => (
        <TreeNodeComponent
          key={child.item.id}
          node={child}
          level={level + 1}
          onSelect={onSelect}
          onDelete={onDelete}
          activeId={activeId}
        />
      ))}
    </div>
  );
};

const Sidebar: React.FC = () => {
  const { documents, activeDocumentId, setActiveDocument, createDocument, createFolder, deleteDocument } = useProject();
  const [newItemName, setNewItemName] = useState('');
  const [showInput, setShowInput] = useState<'document' | 'folder' | null>(null);
  const [hierarchyLevel, setHierarchyLevel] = useState<'novel' | 'part' | 'chapter' | 'scene' | null>(null);
  const [showCreateMenu, setShowCreateMenu] = useState(false);

  // Build tree structure from flat document list
  const tree = useMemo(() => {
    const buildTree = (parentId: string | null): TreeNode[] => {
      return documents
        .filter(doc => doc.parent_id === parentId)
        .sort((a, b) => a.position - b.position)
        .map(doc => ({
          item: doc,
          children: doc.type === 'folder' ? buildTree(doc.id) : []
        }));
    };
    return buildTree(null);
  }, [documents]);

  const handleSelect = (doc: DocumentRow) => {
    if (doc.type === 'document') {
      setActiveDocument(doc.id);
    }
  };

  const handleCreate = async (type: 'document' | 'folder') => {
    if (!newItemName.trim()) return;

    try {
      if (type === 'document') {
        const id = await createDocument(newItemName, null, hierarchyLevel || undefined);
        setActiveDocument(id);
      } else {
        await createFolder(newItemName, null, hierarchyLevel as 'novel' | 'part' | 'chapter' | null);
      }
      setNewItemName('');
      setShowInput(null);
      setHierarchyLevel(null);
      setShowCreateMenu(false);
    } catch (error) {
      console.error('Error creating item:', error);
    }
  };

  const openCreateDialog = (type: 'document' | 'folder', level: 'novel' | 'part' | 'chapter' | 'scene' | null) => {
    setShowInput(type);
    setHierarchyLevel(level);
    setShowCreateMenu(false);
  };

  const menuButtonStyle: React.CSSProperties = {
    padding: '8px 10px',
    backgroundColor: '#252526',
    color: '#d4d4d4',
    border: '1px solid #333',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '12px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    transition: 'background-color 0.2s'
  };

  return (
    <div style={{
      height: '100%',
      overflow: 'auto',
      backgroundColor: '#252526',
      display: 'flex',
      flexDirection: 'column'
    }}>
      {/* Header */}
      <div style={{
        padding: '12px',
        borderBottom: '1px solid #333',
        fontWeight: 'bold',
        fontSize: '12px',
        textTransform: 'uppercase',
        color: '#888'
      }}>
        Manuscript
      </div>

      {/* Tree */}
      <div style={{ flex: 1, padding: '8px 0', overflow: 'auto' }}>
        {tree.map(node => (
          <TreeNodeComponent
            key={node.item.id}
            node={node}
            level={0}
            onSelect={handleSelect}
            onDelete={deleteDocument}
            activeId={activeDocumentId || undefined}
          />
        ))}

        {tree.length === 0 && (
          <div style={{ padding: '20px', textAlign: 'center', color: '#888', fontSize: '13px' }}>
            No documents yet.
            <br />
            Create your first document below!
          </div>
        )}
      </div>

      {/* Input for new items */}
      {showInput && (
        <div style={{ padding: '8px', borderTop: '1px solid #333', backgroundColor: '#1e1e1e' }}>
          <input
            type="text"
            value={newItemName}
            onChange={(e) => setNewItemName(e.target.value)}
            onKeyPress={(e) => {
              if (e.key === 'Enter') handleCreate(showInput);
              if (e.key === 'Escape') setShowInput(null);
            }}
            placeholder={`New ${showInput} name...`}
            autoFocus
            style={{
              width: '100%',
              padding: '6px',
              backgroundColor: '#252526',
              border: '1px solid var(--primary-green)',
              borderRadius: '3px',
              color: '#d4d4d4',
              fontSize: '12px',
              marginBottom: '6px'
            }}
          />
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              onClick={() => handleCreate(showInput)}
              style={{
                flex: 1,
                padding: '4px',
                backgroundColor: 'var(--primary-green)',
                color: '#fff',
                border: 'none',
                borderRadius: '3px',
                cursor: 'pointer',
                fontSize: '11px'
              }}
            >
              Create
            </button>
            <button
              onClick={() => setShowInput(null)}
              style={{
                flex: 1,
                padding: '4px',
                backgroundColor: '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '3px',
                cursor: 'pointer',
                fontSize: '11px'
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Add buttons */}
      {!showInput && !showCreateMenu && (
        <div style={{
          padding: '12px',
          borderTop: '1px solid #333',
          display: 'flex',
          gap: '8px'
        }}>
          <button
            onClick={() => setShowCreateMenu(true)}
            style={{
              flex: 1,
              padding: '8px',
              backgroundColor: 'var(--primary-green)',
              color: '#fff',
              border: 'none',
              borderRadius: '3px',
              cursor: 'pointer',
              fontSize: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px'
            }}
          >
            <Plus size={14} />
            New Item
          </button>
        </div>
      )}

      {/* Create menu */}
      {showCreateMenu && (
        <div style={{
          padding: '12px',
          borderTop: '1px solid #333',
          backgroundColor: '#1e1e1e',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px'
        }}>
          <div style={{ fontSize: '11px', color: '#888', marginBottom: '4px', textTransform: 'uppercase' }}>
            Create New:
          </div>

          <button onClick={() => openCreateDialog('folder', 'part')} style={menuButtonStyle}>
            <Layers size={14} color="#569cd6" />
            <span>Part</span>
          </button>

          <button onClick={() => openCreateDialog('folder', 'chapter')} style={menuButtonStyle}>
            <FolderIcon size={14} color="#ce9178" />
            <span>Chapter</span>
          </button>

          <button onClick={() => openCreateDialog('document', 'scene')} style={menuButtonStyle}>
            <FileText size={14} color="#4ec9b0" />
            <span>Scene</span>
          </button>

          <div style={{ borderTop: '1px solid #333', margin: '4px 0' }} />

          <button onClick={() => openCreateDialog('document', null)} style={menuButtonStyle}>
            <File size={14} color="var(--primary-green)" />
            <span>Generic Document</span>
          </button>

          <button onClick={() => openCreateDialog('folder', null)} style={menuButtonStyle}>
            <FolderIcon size={14} color="var(--primary-green-light)" />
            <span>Generic Folder</span>
          </button>

          <button
            onClick={() => setShowCreateMenu(false)}
            style={{
              ...menuButtonStyle,
              backgroundColor: '#333',
              marginTop: '4px'
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};

export default Sidebar;