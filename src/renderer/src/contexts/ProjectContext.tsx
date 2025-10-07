// src/renderer/src/contexts/ProjectContext.tsx
import React, { createContext, useContext, useState, useCallback } from 'react';
import { DocumentRow, ReferenceRow, ProjectMetadata } from '../../types/window';

interface ProjectContextType {
  // Project state
  isProjectOpen: boolean;
  projectMetadata: ProjectMetadata | null;
  projectPath: string | null;
  
  // Documents
  documents: DocumentRow[];
  activeDocumentId: string | null;
  
  // References
  references: ReferenceRow[];
  
  // Actions
  createProject: (name: string) => Promise<void>;
  openProject: () => Promise<void>;
  closeProject: () => Promise<void>;
  
  loadDocuments: () => Promise<void>;
  setActiveDocument: (id: string | null) => void;
  
  createDocument: (name: string, parentId: string | null, hierarchyLevel?: 'novel' | 'part' | 'chapter' | 'scene' | null) => Promise<string>;
  createFolder: (name: string, parentId: string | null, hierarchyLevel?: 'novel' | 'part' | 'chapter' | null) => Promise<string>;
  updateDocumentContent: (id: string, content: string) => Promise<void>;
  updateDocumentNotes: (id: string, notes: string) => Promise<void>;
  updateDocumentWordCount: (id: string, wordCount: number) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  
  loadReferences: () => Promise<void>;
  createReference: (name: string, category: 'character' | 'setting' | 'worldBuilding') => Promise<string>;
  updateReference: (id: string, content: string) => Promise<void>;
  deleteReference: (id: string) => Promise<void>;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isProjectOpen, setIsProjectOpen] = useState(false);
  const [projectMetadata, setProjectMetadata] = useState<ProjectMetadata | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [references, setReferences] = useState<ReferenceRow[]>([]);

  // ============= PROJECT OPERATIONS =============

  const createProject = useCallback(async (name: string) => {
    try {
      const result = await window.api.project.create(name);
      if (result) {
        setProjectPath(result.projectPath);
        const metadata = await window.api.project.getMetadata();
        setProjectMetadata(metadata);
        setIsProjectOpen(true);
        await loadDocuments();
        await loadReferences();
      }
    } catch (error) {
      console.error('Error creating project:', error);
      alert('Failed to create project');
    }
  }, []);

  const openProject = useCallback(async () => {
    try {
      const result = await window.api.project.open();
      if (result) {
        setProjectPath(result.projectPath);
        setProjectMetadata(result.metadata);
        setIsProjectOpen(true);
        await loadDocuments();
        await loadReferences();
      }
    } catch (error) {
      console.error('Error opening project:', error);
      alert('Failed to open project');
    }
  }, []);

  const closeProject = useCallback(async () => {
    try {
      await window.api.project.close();
      setIsProjectOpen(false);
      setProjectMetadata(null);
      setProjectPath(null);
      setDocuments([]);
      setActiveDocumentId(null);
      setReferences([]);
    } catch (error) {
      console.error('Error closing project:', error);
    }
  }, []);

  // ============= DOCUMENT OPERATIONS =============

  const loadDocuments = useCallback(async () => {
    try {
      const docs = await window.api.document.getAll();
      setDocuments(docs);
    } catch (error) {
      console.error('Error loading documents:', error);
    }
  }, []);

  const createDocument = useCallback(async (name: string, parentId: string | null, hierarchyLevel?: 'novel' | 'part' | 'chapter' | 'scene' | null) => {
    try {
      const id = await window.api.document.create(name, parentId, 'manuscript', hierarchyLevel);
      await loadDocuments();
      return id;
    } catch (error) {
      console.error('Error creating document:', error);
      throw error;
    }
  }, [loadDocuments]);

  const createFolder = useCallback(async (name: string, parentId: string | null, hierarchyLevel?: 'novel' | 'part' | 'chapter' | null) => {
    try {
      const id = await window.api.folder.create(name, parentId, hierarchyLevel);
      await loadDocuments();
      return id;
    } catch (error) {
      console.error('Error creating folder:', error);
      throw error;
    }
  }, [loadDocuments]);

  const updateDocumentContent = useCallback(async (id: string, content: string) => {
    try {
      await window.api.document.updateContent(id, content);
    } catch (error) {
      console.error('Error updating document:', error);
    }
  }, []);

  const updateDocumentNotes = useCallback(async (id: string, notes: string) => {
    try {
      await window.api.document.updateNotes(id, notes);
    } catch (error) {
      console.error('Error updating document notes:', error);
    }
  }, []);

  const updateDocumentWordCount = useCallback(async (id: string, wordCount: number) => {
    try {
      await window.api.document.updateWordCount(id, wordCount);
    } catch (error) {
      console.error('Error updating word count:', error);
    }
  }, []);

  const deleteDocument = useCallback(async (id: string) => {
    try {
      await window.api.document.delete(id);
      await loadDocuments();
      if (activeDocumentId === id) {
        setActiveDocumentId(null);
      }
    } catch (error) {
      console.error('Error deleting document:', error);
    }
  }, [loadDocuments, activeDocumentId]);

  // ============= REFERENCE OPERATIONS =============

  const loadReferences = useCallback(async () => {
    try {
      const refs = await window.api.reference.getAll();
      setReferences(refs);
    } catch (error) {
      console.error('Error loading references:', error);
    }
  }, []);

  const createReference = useCallback(async (name: string, category: 'character' | 'setting' | 'worldBuilding') => {
    try {
      const id = await window.api.reference.create(name, category, '');
      await loadReferences();
      return id;
    } catch (error) {
      console.error('Error creating reference:', error);
      throw error;
    }
  }, [loadReferences]);

  const updateReference = useCallback(async (id: string, content: string) => {
    try {
      await window.api.reference.update(id, content);
      await loadReferences();
    } catch (error) {
      console.error('Error updating reference:', error);
    }
  }, [loadReferences]);

  const deleteReference = useCallback(async (id: string) => {
    try {
      await window.api.reference.delete(id);
      await loadReferences();
    } catch (error) {
      console.error('Error deleting reference:', error);
    }
  }, [loadReferences]);

  const value: ProjectContextType = {
    isProjectOpen,
    projectMetadata,
    projectPath,
    documents,
    activeDocumentId,
    references,
    createProject,
    openProject,
    closeProject,
    loadDocuments,
    setActiveDocument: setActiveDocumentId,
    createDocument,
    createFolder,
    updateDocumentContent,
    updateDocumentNotes,
    updateDocumentWordCount,
    deleteDocument,
    loadReferences,
    createReference,
    updateReference,
    deleteReference
  };

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
};

export const useProject = () => {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProject must be used within ProjectProvider');
  }
  return context;
};