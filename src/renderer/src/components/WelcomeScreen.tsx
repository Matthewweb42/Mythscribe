// src/renderer/src/components/WelcomeScreen.tsx
import React, { useState } from 'react';
import { FileText, FolderOpen, BookOpen, Library, Globe, ChevronRight } from 'lucide-react';
import { useProject } from '../contexts/ProjectContext';
import logoImage from '../assets/MythScribeTempLogo.jpg';

type NovelFormat = 'novel' | 'epic' | 'webnovel';

const WelcomeScreen: React.FC = () => {
  const { createProject, openProject } = useProject();
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [selectedFormat, setSelectedFormat] = useState<NovelFormat>('novel');
  const [step, setStep] = useState<'name' | 'format'>(
'name');

  const handleCreateProject = async () => {
    if (!projectName.trim()) {
      alert('Please enter a project name');
      return;
    }
    await createProject(projectName, selectedFormat);
  };

  const handleOpenProject = async () => {
    await openProject();
  };

  const handleNext = () => {
    if (!projectName.trim()) {
      alert('Please enter a project name');
      return;
    }
    setStep('format');
  };

  const handleBack = () => {
    setStep('name');
  };

  const handleCancel = () => {
    setShowNewProject(false);
    setProjectName('');
    setSelectedFormat('novel');
    setStep('name');
  };

  const formatOptions: Array<{
    type: NovelFormat;
    icon: React.ReactNode;
    title: string;
    description: string;
    structure: string;
  }> = [
    {
      type: 'novel',
      icon: <BookOpen size={32} color="var(--primary-green)" />,
      title: 'Novel',
      description: 'Standard single-book structure for traditional novels',
      structure: 'Part → Chapter → Scene'
    },
    {
      type: 'epic',
      icon: <Library size={32} color="var(--primary-green)" />,
      title: 'Epic Scale Novel/Series',
      description: 'Multi-book series structure for epic storytelling',
      structure: 'Series → Novel → Part → Chapter → Scene'
    },
    {
      type: 'webnovel',
      icon: <Globe size={32} color="var(--primary-green)" />,
      title: 'Web-novel',
      description: 'Serialized structure optimized for web publishing',
      structure: 'Volume → Arc → Chapter'
    }
  ];

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
          width: step === 'name' ? '400px' : '700px',
          padding: '40px',
          backgroundColor: '#252526',
          borderRadius: '8px',
          border: '1px solid #333',
          transition: 'width 0.3s ease'
        }}>
          <h2 style={{ marginTop: 0, marginBottom: '8px' }}>
            {step === 'name' ? 'New Project' : 'Choose Format'}
          </h2>
          <p style={{ color: '#888', fontSize: '14px', marginBottom: '24px' }}>
            {step === 'name'
              ? 'Create a new Mythscribe project'
              : 'Select the format that best fits your writing style'}
          </p>

          {step === 'name' ? (
            <>
              <label style={{ display: 'block', marginBottom: '8px', fontSize: '14px' }}>
                Project Name
              </label>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleNext()}
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
                  onClick={handleNext}
                  style={{
                    flex: 1,
                    padding: '10px',
                    backgroundColor: 'var(--primary-green-dark)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px'
                  }}
                >
                  Next
                  <ChevronRight size={16} />
                </button>
                <button
                  onClick={handleCancel}
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
            </>
          ) : (
            <>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '16px',
                marginBottom: '24px'
              }}>
                {formatOptions.map((option) => (
                  <div
                    key={option.type}
                    onClick={() => setSelectedFormat(option.type)}
                    style={{
                      padding: '20px',
                      backgroundColor: selectedFormat === option.type ? '#0e639c' : '#1e1e1e',
                      border: `2px solid ${selectedFormat === option.type ? 'var(--primary-green)' : '#333'}`,
                      borderRadius: '8px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      textAlign: 'center'
                    }}
                    onMouseEnter={(e) => {
                      if (selectedFormat !== option.type) {
                        e.currentTarget.style.backgroundColor = '#252526';
                        e.currentTarget.style.borderColor = '#555';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (selectedFormat !== option.type) {
                        e.currentTarget.style.backgroundColor = '#1e1e1e';
                        e.currentTarget.style.borderColor = '#333';
                      }
                    }}
                  >
                    <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'center' }}>
                      {option.icon}
                    </div>
                    <h3 style={{
                      margin: '0 0 8px 0',
                      fontSize: '16px',
                      fontWeight: 'bold'
                    }}>
                      {option.title}
                    </h3>
                    <p style={{
                      margin: '0 0 12px 0',
                      fontSize: '12px',
                      color: '#888',
                      lineHeight: '1.4'
                    }}>
                      {option.description}
                    </p>
                    <div style={{
                      padding: '6px 8px',
                      backgroundColor: 'rgba(0,0,0,0.3)',
                      borderRadius: '4px',
                      fontSize: '11px',
                      color: '#aaa',
                      fontFamily: 'monospace'
                    }}>
                      {option.structure}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  onClick={handleBack}
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
                  Back
                </button>
                <button
                  onClick={handleCreateProject}
                  style={{
                    flex: 2,
                    padding: '10px',
                    backgroundColor: 'var(--primary-green-dark)',
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
              </div>
            </>
          )}
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
          <img
            src={logoImage}
            alt="Mythscribe Logo"
            style={{
              width: '60px',
              height: '60px',
              objectFit: 'contain'
            }}
          />
          <h1 style={{
            margin: 0,
            fontSize: '48px',
            fontWeight: 'bold',
            background: 'linear-gradient(135deg, var(--primary-green-dark) 0%, var(--primary-green-darker) 100%)',
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
            backgroundColor: 'var(--primary-green-dark)',
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
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--primary-green-darker)'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'var(--primary-green-dark)'}
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
