// src/renderer/src/components/Sidebar/TreeNodeComponent.tsx
import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight, ChevronDown, File, FolderIcon, Trash2, BookOpen, Layers, FileText } from 'lucide-react';
import { DocumentRow } from '../../../types/window';

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

interface TreeNodeComponentProps {
  node: TreeNode;
  level: number;
  onSelect: (doc: DocumentRow) => void;
  onDelete: (id: string) => void;
  onContextMenu: (doc: DocumentRow, e: React.MouseEvent) => void;
  onRename: (id: string, name: string) => void;
  onDragStart: (doc: DocumentRow) => void;
  onDragOver: (doc: DocumentRow, e: React.DragEvent) => void;
  onDrop: (doc: DocumentRow) => void;
  activeId?: string;
  selectedId?: string;
  renamingId?: string;
  dragOverId?: string;
}

export const TreeNodeComponent: React.FC<TreeNodeComponentProps> = ({
  node,
  level,
  onSelect,
  onDelete,
  onContextMenu,
  onRename,
  onDragStart,
  onDragOver,
  onDrop,
  activeId,
  selectedId,
  renamingId,
  dragOverId
}) => {
  const [isOpen, setIsOpen] = useState(true);
  const [editName, setEditName] = useState(node.item.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const isFolder = node.item.type === 'folder';
  const isActive = node.item.type === 'document' && node.item.id === activeId;
  const isSelected = node.item.id === selectedId;
  const isRenaming = node.item.id === renamingId;
  const isDragOver = node.item.id === dragOverId;

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  const handleClick = () => {
    if (!isRenaming) {
      onSelect(node.item);
      if (isFolder) {
        setIsOpen(!isOpen);
      }
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Delete "${node.item.name}"?`)) {
      onDelete(node.item.id);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(node.item, e);
  };

  const handleRenameSubmit = () => {
    if (editName.trim() && editName !== node.item.name) {
      onRename(node.item.id, editName.trim());
    } else {
      setEditName(node.item.name);
    }
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    onDragStart(node.item);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDragOver(node.item, e);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDrop(node.item);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Double-click doesn't trigger rename anymore - use context menu
  };

  return (
    <div>
      <div
        draggable={!isRenaming}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        style={{
          padding: '6px 8px',
          paddingLeft: `${level * 20 + 8}px`,
          cursor: isRenaming ? 'text' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          backgroundColor: isDragOver
            ? 'rgba(78, 201, 176, 0.2)'
            : isActive
            ? '#37373d'
            : isSelected
            ? '#2a2d2e'
            : 'transparent',
          borderLeft: isActive
            ? '2px solid var(--primary-green)'
            : isSelected
            ? '2px solid #569cd6'
            : '2px solid transparent',
          position: 'relative',
          transition: 'background-color 0.15s'
        }}
        onMouseEnter={(e) => {
          if (!isActive && !isSelected && !isDragOver) e.currentTarget.style.backgroundColor = '#2a2d2e';
        }}
        onMouseLeave={(e) => {
          if (!isActive && !isSelected && !isDragOver) e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1 }}>
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

          {isRenaming ? (
            <input
              ref={inputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleRenameSubmit();
                } else if (e.key === 'Escape') {
                  setEditName(node.item.name);
                  onRename(node.item.id, node.item.name);
                }
                e.stopPropagation();
              }}
              onClick={(e) => e.stopPropagation()}
              style={{
                flex: 1,
                fontSize: '13px',
                backgroundColor: '#1e1e1e',
                border: '1px solid var(--primary-green)',
                borderRadius: '2px',
                padding: '2px 4px',
                color: '#d4d4d4',
                outline: 'none'
              }}
            />
          ) : (
            <span style={{ fontSize: '13px' }}>
              {node.item.name}
              {node.item.word_count > 0 && (
                <span style={{ marginLeft: '8px', fontSize: '11px', color: '#888' }}>
                  ({node.item.word_count.toLocaleString()} words)
                </span>
              )}
            </span>
          )}
        </div>

        {!isRenaming && (
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
            onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.5')}
          >
            <Trash2 size={14} color="#f48771" />
          </button>
        )}
      </div>

      {isFolder && isOpen && node.children.map((child) => (
        <TreeNodeComponent
          key={child.item.id}
          node={child}
          level={level + 1}
          onSelect={onSelect}
          onDelete={onDelete}
          onContextMenu={onContextMenu}
          onRename={onRename}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDrop={onDrop}
          activeId={activeId}
          selectedId={selectedId}
          renamingId={renamingId}
          dragOverId={dragOverId}
        />
      ))}
    </div>
  );
};
