// src/renderer/src/components/WelcomeScreen.tsx
import React, { useState } from 'react';
import { FileText, FolderOpen, Sparkles } from 'lucide-react';
import { useProject } from '../contexts/ProjectContext';

const WelcomeScreen: React.FC = () => {
  const { createProject, openProject } = useProject();
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectName, setProjectName] = useState('');

  const handleCreateProject = async () => {
    if (!projectName.trim()) {
      alert('Please enter a project name');
      return;
    }
    await createProject(projectName);
  };

  const handleOpenProject = async () => {
    await openProject();
  };

  if (showNewProject) {
    return (
      <div style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#1e1e1e',
        color: '#d4d4d4'
      }}>
        <div style={{
          width: '400px',
          padding: '40px',
          backgroundColor: '#252526',
          borderRadius: '8px',
          border: '1px solid #333'
        }}>
          <h2 style={{ marginTop: 0, marginBottom: '8px' }}>New Project</h2>
          <p style={{ color: '#888', fontSize: '14px', marginBottom: '24px' }}>
            Create a new Mythscribe project
          </p>

          <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px' }}>
            Project Name
          </label>
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleCreateProject()}
            placeholder="My Epic Novel"
            autoFocus
            style={{
              width: '100%',
              padding: '10px',
              backgroundColor: '#1e1e1e',
              border: '1px solid #333',
              borderRadius: '4px',
              color: '#d4d4d4',
              fontSize: '14px',
              marginBottom: '24px'
            }}
          />

          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={handleCreateProject}
              style={{
                flex: 1,
                padding: '10px',
                backgroundColor: '#0e639c',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 'bold'
              }}
            >
              Create Project
            </button>
            <button
              onClick={() => setShowNewProject(false)}
              style={{
                flex: 1,
                padding: '10px',
                backgroundColor: '#333',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px'
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#1e1e1e',
      color: '#d4d4d4',
      gap: '20px'
    }}>
      {/* Logo/Title */}
      <div style={{ textAlign: 'center', marginBottom: '20px' }}>
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center', 
          gap: '12px',
          marginBottom: '12px'
        }}>
          <Sparkles size={40} color="#dcb67a" />
          <h1 style={{ 
            margin: 0, 
            fontSize: '48px',
            fontWeight: 'bold',
            background: 'linear-gradient(135deg, #dcb67a 0%, #8b7355 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent'
          }}>
            Mythscribe
          </h1>
        </div>
        <p style={{ margin: 0, color: '#888', fontSize: '16px' }}>
          AI-Powered Novel Writing
        </p>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '300px' }}>
        <button
          onClick={() => setShowNewProject(true)}
          style={{
            padding: '16px 24px',
            backgroundColor: '#0e639c',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '16px',
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            transition: 'background-color 0.2s'
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#1177bb'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#0e639c'}
        >
          <FileText size={20} />
          New Project
        </button>

        <button
          onClick={handleOpenProject}
          style={{
            padding: '16px 24px',
            backgroundColor: '#333',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            transition: 'background-color 0.2s'
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#404040'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#333'}
        >
          <FolderOpen size={20} />
          Open Project
        </button>
      </div>

      {/* Version info */}
      <div style={{ 
        position: 'absolute', 
        bottom: '20px', 
        color: '#666',
        fontSize: '12px'
      }}>
        Version 0.1.0 - MVP
      </div>
    </div>
  );
};

export default WelcomeScreen;