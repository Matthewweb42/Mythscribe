// src/renderer/src/components/Sidebar/TabbedSidebar.tsx
import React, { useState } from 'react';
import { Book, Users, MapPin, Globe, List, Clock, Tag } from 'lucide-react';
import ManuscriptTab from './ManuscriptTab';
import CharactersTab from './CharactersTab';
import SettingsTab from './SettingsTab';
import WorldBuildingTab from './WorldBuildingTab';
import OutlineTab from './OutlineTab';
import TimelineTab from './TimelineTab';
import TagManagerPanel from '../TagManagerPanel';

type TabId = 'manuscript' | 'characters' | 'settings' | 'world' | 'outline' | 'timeline' | 'tags';

interface Tab {
  id: TabId;
  label: string;
  icon: React.ReactNode;
  component: React.ReactNode;
}

const TabbedSidebar: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId>('manuscript');

  const tabs: Tab[] = [
    {
      id: 'manuscript',
      label: 'Manuscript',
      icon: <Book size={16} />,
      component: <ManuscriptTab />
    },
    {
      id: 'characters',
      label: 'Characters',
      icon: <Users size={16} />,
      component: <CharactersTab />
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: <MapPin size={16} />,
      component: <SettingsTab />
    },
    {
      id: 'world',
      label: 'World',
      icon: <Globe size={16} />,
      component: <WorldBuildingTab />
    },
    {
      id: 'outline',
      label: 'Outline',
      icon: <List size={16} />,
      component: <OutlineTab />
    },
    {
      id: 'timeline',
      label: 'Timeline',
      icon: <Clock size={16} />,
      component: <TimelineTab />
    },
    {
      id: 'tags',
      label: 'Tags',
      icon: <Tag size={16} />,
      component: <TagManagerPanel />
    }
  ];

  const activeTabData = tabs.find(tab => tab.id === activeTab);

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: '#252526'
    }}>
      {/* Tab Navigation */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid #333',
        backgroundColor: '#2d2d2d',
        overflowX: 'auto'
      }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            title={tab.label}
            style={{
              flex: '1 0 auto',
              padding: '10px 8px',
              backgroundColor: activeTab === tab.id ? '#252526' : 'transparent',
              color: activeTab === tab.id ? 'var(--primary-green)' : '#888',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--primary-green)' : '2px solid transparent',
              cursor: 'pointer',
              fontSize: '11px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '4px',
              transition: 'all 0.2s',
              minWidth: '60px'
            }}
            onMouseEnter={(e) => {
              if (activeTab !== tab.id) {
                e.currentTarget.style.backgroundColor = '#333';
                e.currentTarget.style.color = '#d4d4d4';
              }
            }}
            onMouseLeave={(e) => {
              if (activeTab !== tab.id) {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = '#888';
              }
            }}
          >
            {tab.icon}
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%', textAlign: 'center' }}>
              {tab.label}
            </span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        backgroundColor: '#252526'
      }}>
        {activeTabData?.component}
      </div>
    </div>
  );
};

export default TabbedSidebar;
