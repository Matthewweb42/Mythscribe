import React, { useState, useEffect } from 'react';

interface FileExplorerProps {
  onFileSelect: (fileName: string) => void;
}

const FileExplorer: React.FC<FileExplorerProps> = ({ onFileSelect }) => {
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    // Simulate fetching files from a directory
    const mockFiles = ['Document1.txt', 'Document2.txt', 'Notes.md', 'ProjectPlan.docx'];
    setFiles(mockFiles);
  }, []);

  const handleSort = () => {
    setFiles((prevFiles) => [...prevFiles].sort());
  };

  return (
    <div>
      <h2>File Explorer</h2>
      <button onClick={handleSort}>Sort Files</button>
      <ul>
        {files.map((file) => (
          <li key={file} onClick={() => onFileSelect(file)}>
            {file}
          </li>
        ))}
      </ul>
    </div>
  );
};

export default FileExplorer;