// src/components/WritingEnvironment/hooks/useDocumentManager.ts
import { useState, useEffect, useCallback } from 'react';
import { DocumentState, UserSettings } from '../../../types';

export const useDocumentManager = () => {
  const [document, setDocument] = useState<DocumentState>({
    content: '',
    lastSaved: new Date(),
    versionHistory: []
  });

  const [settings, setSettings] = useState<UserSettings>({
    theme: 'dark',
    font: 'Inter',
    fontSize: 16,
    autoSaveInterval: 5 // minutes
  });

  // ... (previous implementation of save, restore, update methods)

  return {
    document,
    settings,
    saveDocument,
    restoreVersion,
    updateContent,
    updateSettings
  };
};