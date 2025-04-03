// components/FileExplorer.tsx
import React from 'react';
import { Folder, FileItem } from '../App';

interface FileExplorerProps {
  folders: Folder[];
  onToggleFolder: (folderId: string) => void;
  onSelectFile: (folderId: string, fileId: string) => void;
}

const FileExplorer: React.FC<FileExplorerProps> = ({ folders, onToggleFolder, onSelectFile }) => {
  return (
    <div className="file-explorer">
      <div className="explorer-header">
        <h3 className="explorer-title">Project Files</h3>
        <button className="add-btn">+</button>
      </div>
      <div className="search-box">
        <input type="text" className="search-input" placeholder="Search files..." />
      </div>
      <div className="file-list">
        {folders.map(folder => (
          <div key={folder.id} className={`project-folder ${folder.isOpen ? 'folder-open' : ''}`}>
            <div className="folder-header" onClick={() => onToggleFolder(folder.id)}>
              <span className="icon">▶</span>
              <span>{folder.name}</span>
            </div>
            <div className="folder-files" style={{ display: folder.isOpen ? 'block' : 'none' }}>
              {folder.files.map(file => (
                <div 
                  key={file.id} 
                  className={`file-item ${file.isActive ? 'active' : ''}`}
                  onClick={() => onSelectFile(folder.id, file.id)}
                >
                  <span className="icon">◆</span>
                  <span>{file.name}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default FileExplorer;
