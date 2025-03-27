// src/types/document.ts
export interface DocumentState {
    content: string;
    lastSaved: Date;
    versionHistory: Array<{
      content: string;
      timestamp: Date;
    }>;
  }