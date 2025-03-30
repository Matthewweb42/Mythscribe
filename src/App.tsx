import React from 'react';
import WordProcessor from './components/WordProcessor';
import './App.css';

const App: React.FC = () => {
  const handleSave = (content: string) => {
    console.log('Saved content:', content);
    // Here you could implement saving to localStorage, a database, etc.
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Simple Word Processor</h1>
      </header>
      <main>
        <WordProcessor 
          initialContent="<p>Start typing your document here...</p>" 
          onSave={handleSave} 
        />
      </main>
      <footer className="app-footer">
        <p>Simple Word Processor © {new Date().getFullYear()}</p>
      </footer>
    </div>
  );
};

export default App;