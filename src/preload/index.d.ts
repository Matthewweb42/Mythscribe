import { ElectronAPI } from '@electron-toolkit/preload'

// Type definitions for window.api (MythScribe API)
declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      onMenuEvent: (callback: (event: string) => void) => void
      project: {
        create: (projectName: string) => Promise<{ projectId: string; projectPath: string } | null>
        open: () => Promise<any>
        getMetadata: () => Promise<any>
        close: () => Promise<void>
      }
      document: {
        create: (name: string, parentId: string | null, docType: 'manuscript' | 'note', hierarchyLevel?: 'novel' | 'part' | 'chapter' | 'scene' | null) => Promise<string>
        get: (id: string) => Promise<any>
        getByParent: (parentId: string | null) => Promise<any[]>
        getAll: () => Promise<any[]>
        updateContent: (id: string, content: string) => Promise<void>
        updateName: (id: string, name: string) => Promise<void>
        updateNotes: (id: string, notes: string) => Promise<void>
        updateWordCount: (id: string, wordCount: number) => Promise<void>
        delete: (id: string) => Promise<void>
        move: (id: string, newParentId: string | null, newPosition: number) => Promise<void>
      }
      folder: {
        create: (name: string, parentId: string | null, hierarchyLevel?: 'novel' | 'part' | 'chapter' | null) => Promise<string>
      }
      reference: {
        create: (name: string, category: 'character' | 'setting' | 'worldBuilding', content: string) => Promise<string>
        get: (id: string) => Promise<any>
        getByCategory: (category: 'character' | 'setting' | 'worldBuilding') => Promise<any[]>
        getAll: () => Promise<any[]>
        update: (id: string, content: string) => Promise<void>
        updateName: (id: string, name: string) => Promise<void>
        delete: (id: string) => Promise<void>
      }
      settings: {
        get: (key: string) => Promise<string | undefined>
        set: (key: string, value: string) => Promise<void>
      }
      tag: {
        create: (name: string, category: 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom' | null, color?: string, parentTagId?: string | null) => Promise<string>
        get: (id: string) => Promise<any>
        getAll: () => Promise<any[]>
        getByCategory: (category: 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom') => Promise<any[]>
        update: (id: string, name: string, color: string, category: 'character' | 'setting' | 'worldBuilding' | 'tone' | 'content' | 'plot-thread' | 'custom' | null) => Promise<void>
        delete: (id: string) => Promise<void>
        incrementUsage: (id: string) => Promise<void>
      }
      tagTemplate: {
        create: (name: string, tagsJson: string, isGlobal?: boolean) => Promise<string>
        getAll: () => Promise<any[]>
        delete: (id: string) => Promise<void>
      }
      documentTag: {
        add: (documentId: string, tagId: string, positionStart?: number | null, positionEnd?: number | null) => Promise<string>
        remove: (documentId: string, tagId: string) => Promise<void>
        getForDocument: (documentId: string) => Promise<any[]>
        getDocumentsByTag: (tagId: string) => Promise<any[]>
      }
      ai: {
        generateSuggestion: (recentText: string, context?: {
          characterNotes?: string
          settingNotes?: string
          worldBuildingNotes?: string
        }) => Promise<string>
        testApiKey: () => Promise<{ success: boolean; message: string }>
        generateDirected: (params: {
          instruction: string
          paragraphCount: number
          conversationHistory?: Array<{ role: string; content: string }>
          referencedNotes?: string
        }) => Promise<string>
      }
    }
  }
}
