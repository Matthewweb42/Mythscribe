
// components/TopNavbar.tsx
import React from 'react';

const TopNavbar: React.FC = () => {
  return (
    <nav className="top-navbar">
      <div className="app-logo">
        <div className="logo-icon"></div>
        <h1 className="app-title">Mythscribe</h1>
      </div>
      <div className="main-menu">
        <div className="menu-item active">File</div>
        <div className="menu-item">Edit</div>
        <div className="menu-item">View</div>
        <div className="menu-item">Format</div>
        <div className="menu-item">Tools</div>
        <div className="menu-item">Help</div>
      </div>
      <div className="user-controls">
        <button className="control-btn">Compile</button>
        <button className="control-btn">Export</button>
      </div>
    </nav>
  );
};

export default TopNavbar;