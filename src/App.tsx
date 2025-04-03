// App.tsx - Main Component
import React, { useState } from 'react';
import './Mythscribe.css'; // We'll move all the styles here
import TopNavbar from './components/TopNavbar';
import FileExplorer from './components/FileExplorer';
import EditorArea from './components/EditorArea';

// Define TypeScript interfaces for our data structures
export interface FileItem {
  id: string;
  name: string;
  isActive?: boolean;
}

export interface Folder {
  id: string;
  name: string;
  isOpen: boolean;
  files: FileItem[];
}

const App: React.FC = () => {
  // Sample data - in a real app, you'd likely fetch this from an API or state management
  const [folders, setFolders] = useState<Folder[]>([
    {
      id: 'manuscript',
      name: 'Manuscript',
      isOpen: true,
      files: [
        { id: 'chapter1', name: 'Chapter 1 - The Beginning', isActive: true },
        { id: 'chapter2', name: 'Chapter 2 - Discovery' },
        { id: 'chapter3', name: 'Chapter 3 - Journey' }
      ]
    },
    {
      id: 'characters',
      name: 'Characters',
      isOpen: false,
      files: [
        { id: 'protagonist', name: 'Protagonist' },
        { id: 'antagonist', name: 'Antagonist' },
        { id: 'ally', name: 'Ally' }
      ]
    },
    {
      id: 'settings',
      name: 'Settings',
      isOpen: false,
      files: [
        { id: 'emeraldTower', name: 'The Emerald Tower' },
        { id: 'forestWhispers', name: 'Forest of Whispers' }
      ]
    },
    {
      id: 'research',
      name: 'Research',
      isOpen: false,
      files: [
        { id: 'ancientMyths', name: 'Ancient Myths' },
        { id: 'magicSystems', name: 'Magic Systems' },
        { id: 'historicalRefs', name: 'Historical References' }
      ]
    }
  ]);

  // Sample document content
  const [documentContent, setDocumentContent] = useState<string>(
    `<h1>The Crystal Codex</h1>
    <p>In the shadow of the Emerald Tower, where ancient vines twisted around time-weathered stone, Lyra uncovered the first fragment of the Crystal Codex. Its surface gleamed with an inner light that seemed to pulse in rhythm with her heartbeat. She had searched for three long years, following whispers and half-forgotten legends across the realm of Mythaven.</p>
    
    <p>The tome spoke of realms beyond realms, of powers woven into the very fabric of existence. Such knowledge had been hidden for centuries, sealed away by the Order of Verdant Keepers who feared what might become of the world should its secrets fall into ambitious hands.</p>
    
    <h2>The First Revelation</h2>
    
    <p>"All magic flows from the seven celestial wells," she read aloud, her voice barely above a whisper. The words seemed to hang in the air, shimmering like heat above summer stones. "Those who drink from the wells gain mastery over the elements bound to them, but beware—each sip draws the attention of the Watchers."</p>
    
    <p>Lyra's fingers trembled as she turned the ancient crystalline page. The next passage revealed locations, described in riddles and celestial coordinates that would require careful deciphering. She knew the dangers that lay ahead—the Order still existed, shadows of their former power, but vigilant nonetheless.</p>
    
    <p>A soft chime echoed from the crystal, resonating with something deep within the tower's foundations. Lyra froze, listening intently. The sound came again, more insistent this time. The Codex was reacting to something, perhaps calling to its missing pieces scattered across the realm.</p>
    
    <p>With careful hands, she wrapped the fragment in silk woven with protective sigils. Dawn would break soon, and with it, her journey would truly begin. The Crystal Codex had chosen her as its bearer, and the mysteries of ancient magic awaited discovery.</p>`
  );

  // State for document stats
  const [documentStats, setDocumentStats] = useState({
    wordCount: 258,
    charCount: 1482,
    lastSaved: '2 minutes ago'
  });

  // Toggle folder open/closed
  const toggleFolder = (folderId: string) => {
    setFolders(folders.map(folder => 
      folder.id === folderId ? { ...folder, isOpen: !folder.isOpen } : folder
    ));
  };

  // Activate a file
  const activateFile = (folderId: string, fileId: string) => {
    setFolders(folders.map(folder => ({
      ...folder,
      files: folder.files.map(file => ({
        ...file,
        isActive: folder.id === folderId && file.id === fileId
      }))
    })));
  };

  return (
    <div className="app-container">
      <TopNavbar />
      <div className="content-container">
        <FileExplorer 
          folders={folders} 
          onToggleFolder={toggleFolder} 
          onSelectFile={activateFile} 
        />
        <EditorArea 
          content={documentContent} 
          setContent={setDocumentContent}
          stats={documentStats}
        />
      </div>
    </div>
  );
};

export default App;