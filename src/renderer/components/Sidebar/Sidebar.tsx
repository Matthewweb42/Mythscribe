// src/renderer/components/Sidebar/Sidebar.tsx
import React, { useState } from 'react';
import { Folder, Document, TreeItem } from '../../types';
import { ChevronRight, ChevronDown, File, FolderIcon } from 'lucide-react';

interface SidebarProps {
  onDocumentSelect: (doc: Document) => void;
  activeDocumentId?: string;
}

// Mock data for now - we'll replace this with real data later
const mockData: Folder = {
  id: 'root',
  name: 'My Novel',
  type: 'folder',
  children: [
    {
      id: 'ch1',
      name: 'Chapter 1',
      type: 'document',
      content: null,
      docType: 'manuscript'
    },
    {
      id: 'ch2',
      name: 'Chapter 2',
      type: 'document',
      content: null,
      docType: 'manuscript'
    },
    {
      id: 'folder1',
      name: 'Part Two',
      type: 'folder',
      children: [
        {
          id: 'ch3',
          name: 'Chapter 3',
          type: 'document',
          content: null,
          docType: 'manuscript'
        }
      ]
    }
  ]
};

const TreeNode: React.FC<{
  item: TreeItem;
  level: number;
  onSelect: (doc: Document) => void;
  activeId?: string;
}> = ({ item, level, onSelect, activeId }) => {
  const [isOpen, setIsOpen] = useState(true);
  const isFolder = item.type === 'folder';
  const isActive = item.type === 'document' && item.id === activeId;

  const handleClick = () => {
    if (isFolder) {
      setIsOpen(!isOpen);
    } else {
      onSelect(item as Document);
    }
  };

  return (
    <div>
      <div
        onClick={handleClick}
        style={{
          padding: '6px 8px',
          paddingLeft: `${level * 16 + 8}px`,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          backgroundColor: isActive ? '#37373d' : 'transparent',
          borderLeft: isActive ? '2px solid #0e639c' : '2px solid transparent'
        }}
        onMouseEnter={(e) => {
          if (!isActive) e.currentTarget.style.backgroundColor = '#2a2d2e';
        }}
        onMouseLeave={(e) => {
          if (!isActive) e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        {isFolder ? (
          <>
            {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <FolderIcon size={16} color="#dcb67a" />
          </>
        ) : (
          <>
            <div style={{ width: '16px' }} />
            <File size={16} color="#519aba" />
          </>
        )}
        <span style={{ fontSize: '13px' }}>{item.name}</span>
      </div>

      {isFolder && isOpen && (item as Folder).children.map(child => (
        <TreeNode
          key={child.id}
          item={child}
          level={level + 1}
          onSelect={onSelect}
          activeId={activeId}
        />
      ))}
    </div>
  );
};

const Sidebar: React.FC<SidebarProps> = ({ onDocumentSelect, activeDocumentId }) => {
  return (
    <div style={{
      height: '100%',
      overflow: 'auto',
      backgroundColor: '#252526'
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
      <div style={{ padding: '8px 0' }}>
        <TreeNode
          item={mockData}
          level={0}
          onSelect={onDocumentSelect}
          activeId={activeDocumentId}
        />
      </div>

      {/* Add buttons at bottom */}
      <div style={{
        padding: '12px',
        borderTop: '1px solid #333',
        display: 'flex',
        gap: '8px'
      }}>
        <button style={{
          flex: 1,
          padding: '6px',
          backgroundColor: '#0e639c',
          color: '#fff',
          border: 'none',
          borderRadius: '3px',
          cursor: 'pointer',
          fontSize: '12px'
        }}>
          + Document
        </button>
        <button style={{
          flex: 1,
          padding: '6px',
          backgroundColor: '#333',
          color: '#fff',
          border: 'none',
          borderRadius: '3px',
          cursor: 'pointer',
          fontSize: '12px'
        }}>
          + Folder
        </button>
      </div>
    </div>
  );
};

export default Sidebar;