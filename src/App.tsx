import React, { useState } from 'react';
import WordProcessor from './components/WordProcessor';
import FileExplorer from './components/FileExplorer';
import NavBar from './components/NavBar'; // Import the NavBar component
import './App.css';

const App: React.FC = () => {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const handleSave = (content: string) => {
    console.log('Saved content:', content);
    // Implement saving logic here
  };

  const handleFileSelect = (fileName: string) => {
    setSelectedFile(fileName);
    console.log('Selected file:', fileName);
    // Load the file content into the WordProcessor if needed
  };

  const handleNewFile = () => {
    console.log('New File created');
    setSelectedFile(null);
  };

  const handleNewFolder = () => {
    console.log('New Folder created');
  };

  const handleOpen = () => {
    console.log('Open File dialog triggered');
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Mythscribe</h1>
      </header>
      <NavBar
        onNewFile={handleNewFile}
        onNewFolder={handleNewFolder}
        onSave={() => handleSave('')}
        onOpen={handleOpen}
      />

      <main className="app-main">
        <aside className="file-explorer">
          <FileExplorer onFileSelect={handleFileSelect} />
        </aside>
        <section className="word-processor">
          <WordProcessor
            initialContent={selectedFile ? `<p>Editing ${selectedFile}</p>` : "<p>Start typing your document here...</p>"}
            onSave={handleSave}
          />
        </section>
      </main>
      <footer className="app-footer">
        <p>Simple Word Processor © {new Date().getFullYear()}</p>
      </footer>
    </div>
  );
};

export default App;