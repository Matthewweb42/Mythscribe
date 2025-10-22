// src/renderer/src/components/Sidebar/MatterTemplateMenu.tsx
import React, { useState } from 'react';
import { FileText, ChevronRight } from 'lucide-react';

interface MatterTemplate {
  type: string;
  displayName: string;
  description: string;
}

interface MatterTemplateMenuProps {
  section: 'front-matter' | 'end-matter';
  onSelectTemplate: (templateType: string, displayName: string) => void;
  menuButtonStyle: React.CSSProperties;
}

// Template definitions
const frontMatterTemplates: MatterTemplate[] = [
  { type: 'title-page', displayName: 'Title Page', description: 'Book title and author' },
  { type: 'copyright-page', displayName: 'Copyright Page', description: 'Copyright and publication info' },
  { type: 'dedication', displayName: 'Dedication', description: 'Short dedication' },
  { type: 'epigraph', displayName: 'Epigraph', description: 'Opening quote' },
  { type: 'foreword', displayName: 'Foreword', description: 'Introduction by another author' },
  { type: 'preface', displayName: 'Preface', description: 'Author\'s introduction' },
  { type: 'table-of-contents', displayName: 'Table of Contents', description: 'Chapter listing' }
];

const endMatterTemplates: MatterTemplate[] = [
  { type: 'acknowledgments', displayName: 'Acknowledgments', description: 'Thank you notes' },
  { type: 'about-the-author', displayName: 'About the Author', description: 'Author biography' },
  { type: 'authors-note', displayName: "Author's Note", description: 'Personal message' },
  { type: 'afterword', displayName: 'Afterword', description: 'Concluding remarks' },
  { type: 'appendix', displayName: 'Appendix', description: 'Supplementary material' },
  { type: 'glossary', displayName: 'Glossary', description: 'Term definitions' },
  { type: 'bibliography', displayName: 'Bibliography', description: 'Source references' }
];

export const MatterTemplateMenu: React.FC<MatterTemplateMenuProps> = ({
  section,
  onSelectTemplate,
  menuButtonStyle
}) => {
  const [showSubmenu, setShowSubmenu] = useState(false);

  const templates = section === 'front-matter' ? frontMatterTemplates : endMatterTemplates;
  const sectionLabel = section === 'front-matter' ? 'Front Matter' : 'End Matter';

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setShowSubmenu(true)}
      onMouseLeave={() => setShowSubmenu(false)}
    >
      <button
        style={{
          ...menuButtonStyle,
          width: '100%',
          justifyContent: 'space-between',
          alignItems: 'center',
          display: 'flex'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <FileText size={14} color="#d4a574" />
          <span>{sectionLabel}</span>
        </div>
        <ChevronRight size={12} color="#888" />
      </button>

      {/* Submenu */}
      {showSubmenu && (
        <div
          style={{
            position: 'absolute',
            left: '100%',
            top: 0,
            backgroundColor: '#252526',
            border: '1px solid #333',
            borderRadius: '4px',
            padding: '4px',
            minWidth: '200px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
            zIndex: 10000,
            marginLeft: '4px'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: '10px', color: '#666', padding: '6px 8px', textTransform: 'uppercase' }}>
            Select Template:
          </div>

          {templates.map((template) => (
            <button
              key={template.type}
              onClick={() => onSelectTemplate(template.type, template.displayName)}
              style={{
                ...menuButtonStyle,
                width: '100%',
                justifyContent: 'flex-start',
                flexDirection: 'column',
                alignItems: 'flex-start',
                padding: '8px'
              }}
            >
              <div style={{ fontWeight: 'bold', fontSize: '12px' }}>
                {template.displayName}
              </div>
              <div style={{ fontSize: '10px', color: '#888', marginTop: '2px' }}>
                {template.description}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
