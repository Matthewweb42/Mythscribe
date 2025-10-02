// src/renderer/src/components/Sidebar/Sidebar.tsx
import React, { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, File, FolderIcon, Trash2 } from 'lucide-react';
import { useProject } from '../contexts/ProjectContext';
import { DocumentRow } from '../../types/window';

interface TreeNode {
  item: DocumentRow;
  children: TreeNode[];
}

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
              <FolderIcon size={16} color="var(--primary-green-light)" />
            </>
          ) : (
            <>
              <div style={{ width: '16px' }} />
              <File size={16} color="var(--primary-green)" />
            </>
          )}
          <span style={{ fontSize: '13px' }}>{node.item.name}</span>
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
        const id = await createDocument(newItemName, null);
        setActiveDocument(id);
      } else {
        await createFolder(newItemName, null);
      }
      setNewItemName('');
      setShowInput(null);
    } catch (error) {
      console.error('Error creating item:', error);
    }
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
      {!showInput && (
        <div style={{
          padding: '12px',
          borderTop: '1px solid #333',
          display: 'flex',
          gap: '8px'
        }}>
          <button
            onClick={() => setShowInput('document')}
            style={{
              flex: 1,
              padding: '6px',
              backgroundColor: 'var(--primary-green)',
              color: '#fff',
              border: 'none',
              borderRadius: '3px',
              cursor: 'pointer',
              fontSize: '12px'
            }}
          >
            + Document
          </button>
          <button
            onClick={() => setShowInput('folder')}
            style={{
              flex: 1,
              padding: '6px',
              backgroundColor: '#333',
              color: '#fff',
              border: 'none',
              borderRadius: '3px',
              cursor: 'pointer',
              fontSize: '12px'
            }}
          >
            + Folder
          </button>
        </div>
      )}
    </div>
  );
};

export default Sidebar;