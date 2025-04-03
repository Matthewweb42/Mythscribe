import React from 'react';
import './NavBar.css';

interface NavBarProps {
  onNewFile: () => void;
  onNewFolder: () => void;
  onSave: () => void;
  onOpen: () => void;
}

const NavBar: React.FC<NavBarProps> = ({ onNewFile, onNewFolder, onSave, onOpen }) => {
  return (
    <nav className="nav-bar">
      <ul className="menu">
        <li className="menu-item">
          File
          <ul className="dropdown">
            <li onClick={onNewFile}>New File</li>
            <li onClick={onNewFolder}>New Folder</li>
            <li onClick={onSave}>Save</li>
            <li onClick={onOpen}>Open</li>
          </ul>
        </li>
        <li className="menu-item">
          Edit
          <ul className="dropdown">
            <li>Undo</li>
            <li>Redo</li>
            <li>Cut</li>
            <li>Copy</li>
            <li>Paste</li>
          </ul>
        </li>
        <li className="menu-item">
          Project
          <ul className="dropdown">
            <li>Settings</li>
            <li>Export</li>
            <li>Close Project</li>
          </ul>
        </li>
      </ul>
    </nav>
  );
};

export default NavBar;