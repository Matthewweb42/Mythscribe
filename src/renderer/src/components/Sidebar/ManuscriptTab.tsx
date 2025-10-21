// src/renderer/src/components/Sidebar/ManuscriptTab.tsx
import React, { useState, useMemo } from 'react';
import { File, FolderIcon, Layers, FileText, Copy, Trash2 } from 'lucide-react';
import { useProject } from '../../contexts/ProjectContext';
import { DocumentRow } from '../../../types/window';
import { TreeNodeComponent } from './TreeNodeComponent';
import { ConfirmModal } from '../ConfirmModal';

interface TreeNode {
  item: DocumentRow;
  children: TreeNode[];
}

const ManuscriptTab: React.FC = () => {
  const { documents, activeDocumentId, setActiveDocument, createDocument, createFolder, deleteDocument, renameDocument, moveDocument, projectMetadata } = useProject();
  const [newItemName, setNewItemName] = useState('');
  const [showInput, setShowInput] = useState<'document' | 'folder' | null>(null);
  const [hierarchyLevel, setHierarchyLevel] = useState<'novel' | 'part' | 'chapter' | 'scene' | null>(null);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [selectedItem, setSelectedItem] = useState<DocumentRow | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: DocumentRow } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draggedItem, setDraggedItem] = useState<DocumentRow | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<DocumentRow | null>(null);

  // Determine label for "Part" based on novel format
  const partLabel = projectMetadata?.novel_format === 'webnovel' ? 'Arc' : 'Part';

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
    const result = buildTree(null);
    console.log('Built tree:', result);
    console.log('All documents:', documents);
    return result;
  }, [documents]);

  const handleSelect = (doc: DocumentRow) => {
    setSelectedItem(doc);
    // Allow both documents AND folders to be set as active
    // Folders (chapters/parts) will show their child scenes stacked in the editor
    setActiveDocument(doc.id);
  };

  const handleContextMenu = (doc: DocumentRow, e: React.MouseEvent) => {
    setContextMenu({ x: e.clientX, y: e.clientY, item: doc });
  };

  const handleRename = async (id: string, name: string) => {
    if (!name.trim()) return;
    await renameDocument(id, name);
    setRenamingId(null);
  };

  const handleDragStart = (doc: DocumentRow) => {
    setDraggedItem(doc);
  };

  const handleDragOver = (doc: DocumentRow, e: React.DragEvent) => {
    e.preventDefault();
    setDragOverId(doc.id);
  };

  const handleDrop = async (targetDoc: DocumentRow) => {
    if (!draggedItem || draggedItem.id === targetDoc.id) {
      setDraggedItem(null);
      setDragOverId(null);
      return;
    }

    // Determine the target parent
    let newParentId: string | null;

    // If target is a Scene, make dragged item a sibling (same parent as scene)
    if (targetDoc.hierarchy_level === 'scene') {
      newParentId = targetDoc.parent_id;
    } else if (targetDoc.type === 'folder') {
      // If target is a folder, make it the parent
      newParentId = targetDoc.id;
    } else {
      // Otherwise make them siblings
      newParentId = targetDoc.parent_id;
    }

    // Get current position of target to insert near it
    const targetPosition = targetDoc.position;

    await moveDocument(draggedItem.id, newParentId, targetPosition + 1);

    setDraggedItem(null);
    setDragOverId(null);
  };

  const handleDuplicate = async (item: DocumentRow) => {
    const duplicateName = `${item.name} (Copy)`;

    // Create the duplicate at the same level (same parent)
    const newId = item.type === 'document'
      ? await createDocument(duplicateName, item.parent_id, item.hierarchy_level || undefined)
      : await createFolder(duplicateName, item.parent_id, item.hierarchy_level as 'novel' | 'part' | 'chapter' | null);

    // If it's a document, copy the content
    if (item.type === 'document' && item.content) {
      await window.api.document.updateContent(newId, item.content);
      if (item.notes) {
        await window.api.document.updateNotes(newId, item.notes);
      }
    }

    // If it's a folder, recursively duplicate children
    if (item.type === 'folder') {
      const children = documents.filter(doc => doc.parent_id === item.id);
      for (const child of children) {
        await duplicateRecursive(child, newId);
      }
    }

    setContextMenu(null);
  };

  const duplicateRecursive = async (item: DocumentRow, newParentId: string) => {
    const duplicateName = item.name;

    const newId = item.type === 'document'
      ? await createDocument(duplicateName, newParentId, item.hierarchy_level || undefined)
      : await createFolder(duplicateName, newParentId, item.hierarchy_level as 'novel' | 'part' | 'chapter' | null);

    if (item.type === 'document' && item.content) {
      await window.api.document.updateContent(newId, item.content);
      if (item.notes) {
        await window.api.document.updateNotes(newId, item.notes);
      }
    }

    if (item.type === 'folder') {
      const children = documents.filter(doc => doc.parent_id === item.id);
      for (const child of children) {
        await duplicateRecursive(child, newId);
      }
    }
  };

  const handleCreate = async (type: 'document' | 'folder', parentId?: string, level?: 'novel' | 'part' | 'chapter' | 'scene' | null) => {
    const parent = parentId || (selectedItem?.hierarchy_level === 'scene' ? selectedItem.parent_id : selectedItem?.id) || null;
    const useLevel = level !== undefined ? level : hierarchyLevel;

    try {
      const defaultName = type === 'document' ? 'Untitled Document' : 'Untitled Folder';
      console.log(`Creating ${type} with name: ${defaultName}, hierarchyLevel: ${useLevel}, parent: ${parent}`);

      if (type === 'document') {
        const id = await createDocument(defaultName, parent, useLevel || undefined);
        console.log(`Document created with id: ${id}`);
        setActiveDocument(id);
        setRenamingId(id); // Auto-focus for rename
      } else {
        const id = await createFolder(defaultName, parent, useLevel as 'novel' | 'part' | 'chapter' | null);
        console.log(`Folder created with id: ${id}`);
        setRenamingId(id); // Auto-focus for rename
      }

      setNewItemName('');
      setShowInput(null);
      setHierarchyLevel(null);
      setShowCreateMenu(false);
      setContextMenu(null);
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
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        backgroundColor: '#252526',
        display: 'flex',
        flexDirection: 'column'
      }}
      onClick={() => setContextMenu(null)}
    >
      {/* Tree */}
      <div style={{ flex: 1, padding: '8px 0', overflow: 'auto' }}>
        {tree.map(node => (
          <TreeNodeComponent
            key={node.item.id}
            node={node}
            level={0}
            onSelect={handleSelect}
            onDelete={deleteDocument}
            onContextMenu={handleContextMenu}
            onRename={handleRename}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            activeId={activeDocumentId || undefined}
            selectedId={selectedItem?.id}
            renamingId={renamingId || undefined}
            dragOverId={dragOverId || undefined}
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
            onKeyDown={(e) => {
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
          padding: '8px',
          borderTop: '1px solid #333',
          display: 'flex',
          gap: '4px'
        }}>
          <button
            onClick={() => handleCreate('document', undefined, 'scene')}
            style={{
              flex: 1,
              padding: '6px 4px',
              backgroundColor: '#252526',
              color: '#4ec9b0',
              border: '1px solid #333',
              borderRadius: '3px',
              cursor: 'pointer',
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
              whiteSpace: 'nowrap'
            }}
            title="New Scene"
          >
            <FileText size={12} />
            Scene
          </button>
          <button
            onClick={() => handleCreate('folder', undefined, 'chapter')}
            style={{
              flex: 1,
              padding: '6px 4px',
              backgroundColor: '#252526',
              color: '#ce9178',
              border: '1px solid #333',
              borderRadius: '3px',
              cursor: 'pointer',
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
              whiteSpace: 'nowrap'
            }}
            title="New Chapter"
          >
            <FolderIcon size={12} />
            Chapter
          </button>
          <button
            onClick={() => handleCreate('folder', undefined, 'part')}
            style={{
              flex: 1,
              padding: '6px 4px',
              backgroundColor: '#252526',
              color: '#569cd6',
              border: '1px solid #333',
              borderRadius: '3px',
              cursor: 'pointer',
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
              whiteSpace: 'nowrap'
            }}
            title={`New ${partLabel}`}
          >
            <Layers size={12} />
            {partLabel}
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
            <span>{partLabel}</span>
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

      {/* Context Menu */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            backgroundColor: '#252526',
            border: '1px solid #333',
            borderRadius: '4px',
            padding: '4px',
            zIndex: 9999,
            minWidth: '180px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: '11px', color: '#888', padding: '6px 8px', textTransform: 'uppercase' }}>
            "{contextMenu.item.name}"
          </div>

          <div style={{ fontSize: '10px', color: '#666', padding: '6px 8px', textTransform: 'uppercase' }}>
            Add to this:
          </div>

          <button
            onClick={() => {
              setSelectedItem(contextMenu.item);
              handleCreate('folder', contextMenu.item.id, 'part');
            }}
            style={{
              ...menuButtonStyle,
              width: '100%',
              justifyContent: 'flex-start'
            }}
          >
            <Layers size={14} color="#569cd6" />
            <span>{partLabel}</span>
          </button>

          <button
            onClick={() => {
              setSelectedItem(contextMenu.item);
              handleCreate('folder', contextMenu.item.id, 'chapter');
            }}
            style={{
              ...menuButtonStyle,
              width: '100%',
              justifyContent: 'flex-start'
            }}
          >
            <FolderIcon size={14} color="#ce9178" />
            <span>Chapter</span>
          </button>

          <button
            onClick={() => {
              setSelectedItem(contextMenu.item);
              handleCreate('document', contextMenu.item.id, 'scene');
            }}
            style={{
              ...menuButtonStyle,
              width: '100%',
              justifyContent: 'flex-start'
            }}
          >
            <FileText size={14} color="#4ec9b0" />
            <span>Scene</span>
          </button>

          <div style={{ borderTop: '1px solid #333', margin: '4px 0' }} />

          <button
            onClick={() => {
              setSelectedItem(contextMenu.item);
              handleCreate('document', contextMenu.item.id, null);
            }}
            style={{
              ...menuButtonStyle,
              width: '100%',
              justifyContent: 'flex-start'
            }}
          >
            <File size={14} color="var(--primary-green)" />
            <span>Generic Document</span>
          </button>

          <button
            onClick={() => {
              setSelectedItem(contextMenu.item);
              handleCreate('folder', contextMenu.item.id, null);
            }}
            style={{
              ...menuButtonStyle,
              width: '100%',
              justifyContent: 'flex-start'
            }}
          >
            <FolderIcon size={14} color="var(--primary-green-light)" />
            <span>Generic Folder</span>
          </button>

          <div style={{ borderTop: '1px solid #333', margin: '4px 0' }} />

          <button
            onClick={() => {
              setRenamingId(contextMenu.item.id);
              setContextMenu(null);
            }}
            style={{
              ...menuButtonStyle,
              width: '100%',
              justifyContent: 'flex-start'
            }}
          >
            <File size={14} color="var(--primary-green)" />
            <span>Rename</span>
          </button>

          <button
            onClick={() => handleDuplicate(contextMenu.item)}
            style={{
              ...menuButtonStyle,
              width: '100%',
              justifyContent: 'flex-start'
            }}
          >
            <Copy size={14} color="#569cd6" />
            <span>Duplicate</span>
          </button>

          <button
            onClick={() => {
              setItemToDelete(contextMenu.item);
              setShowDeleteConfirm(true);
              setContextMenu(null);
            }}
            style={{
              ...menuButtonStyle,
              width: '100%',
              justifyContent: 'flex-start'
            }}
          >
            <Trash2 size={14} color="#f48771" />
            <span>Delete</span>
          </button>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={showDeleteConfirm}
        title="Delete Item"
        message={`Are you sure you want to delete "${itemToDelete?.name}"? This action cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={() => {
          if (itemToDelete) {
            deleteDocument(itemToDelete.id);
          }
          setShowDeleteConfirm(false);
          setItemToDelete(null);
        }}
        onCancel={() => {
          setShowDeleteConfirm(false);
          setItemToDelete(null);
        }}
        danger={true}
      />
    </div>
  );
};

export default ManuscriptTab;
