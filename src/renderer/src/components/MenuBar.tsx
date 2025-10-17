// src/renderer/src/components/MenuBar.tsx
import React, { useState } from 'react';
import {
  File, Edit, Eye, Settings, HelpCircle, Plus
} from 'lucide-react';

interface MenuBarProps {
  onMenuAction: (action: string) => void;
}

type MenuId = 'file' | 'edit' | 'insert' | 'view' | 'tools' | 'help' | null;

const MenuBar: React.FC<MenuBarProps> = ({ onMenuAction }) => {
  const [activeMenu, setActiveMenu] = useState<MenuId>(null);

  const handleMenuClick = (menuId: MenuId) => {
    setActiveMenu(activeMenu === menuId ? null : menuId);
  };

  const handleMenuItemClick = (action: string) => {
    onMenuAction(action);
    setActiveMenu(null);
  };

  const handleMouseLeave = () => {
    // Close menu when mouse leaves the menu bar area
    setTimeout(() => setActiveMenu(null), 200);
  };

  return (
    <div
      style={{
        height: '32px',
        backgroundColor: '#2d2d30',
        borderBottom: '1px solid #333',
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        position: 'relative',
        zIndex: 1000,
        userSelect: 'none'
      }}
      onMouseLeave={handleMouseLeave}
    >
      {/* File Menu */}
      <MenuButton
        label="File"
        icon={<File size={14} />}
        isActive={activeMenu === 'file'}
        onClick={() => handleMenuClick('file')}
      />
      {activeMenu === 'file' && (
        <Dropdown onClose={() => setActiveMenu(null)}>
          <MenuItem label="New Project" shortcut="Ctrl+N" onClick={() => handleMenuItemClick('menu:new-project')} />
          <MenuItem label="Open Project..." shortcut="Ctrl+O" onClick={() => handleMenuItemClick('menu:open-project')} />
          <MenuDivider />
          <MenuItem label="Save" shortcut="Ctrl+S" onClick={() => handleMenuItemClick('menu:save')} />
          <MenuDivider />
          <MenuItem label="Export PDF..." onClick={() => handleMenuItemClick('menu:export-pdf')} />
          <MenuItem label="Export DOCX..." onClick={() => handleMenuItemClick('menu:export-docx')} />
          <MenuItem label="Export EPUB..." onClick={() => handleMenuItemClick('menu:export-epub')} />
          <MenuItem label="Export Markdown..." onClick={() => handleMenuItemClick('menu:export-markdown')} />
          <MenuDivider />
          <MenuItem label="Import Document..." onClick={() => handleMenuItemClick('menu:import-document')} />
          <MenuItem label="Import Characters..." onClick={() => handleMenuItemClick('menu:import-characters')} />
        </Dropdown>
      )}

      {/* Edit Menu */}
      <MenuButton
        label="Edit"
        icon={<Edit size={14} />}
        isActive={activeMenu === 'edit'}
        onClick={() => handleMenuClick('edit')}
      />
      {activeMenu === 'edit' && (
        <Dropdown onClose={() => setActiveMenu(null)} left={48}>
          <MenuItem label="Undo" shortcut="Ctrl+Z" onClick={() => handleMenuItemClick('menu:undo')} disabled />
          <MenuItem label="Redo" shortcut="Ctrl+Y" onClick={() => handleMenuItemClick('menu:redo')} disabled />
          <MenuDivider />
          <MenuItem label="Find..." shortcut="Ctrl+F" onClick={() => handleMenuItemClick('menu:find')} />
          <MenuItem label="Find & Replace..." shortcut="Ctrl+H" onClick={() => handleMenuItemClick('menu:find-replace')} />
        </Dropdown>
      )}

      {/* Insert Menu */}
      <MenuButton
        label="Insert"
        icon={<Plus size={14} />}
        isActive={activeMenu === 'insert'}
        onClick={() => handleMenuClick('insert')}
      />
      {activeMenu === 'insert' && (
        <Dropdown onClose={() => setActiveMenu(null)} left={96}>
          <MenuItem label="Scene" onClick={() => handleMenuItemClick('menu:insert-scene')} />
          <MenuItem label="Chapter" onClick={() => handleMenuItemClick('menu:insert-chapter')} />
          <MenuItem label="Part" onClick={() => handleMenuItemClick('menu:insert-part')} />
          <MenuDivider />
          <MenuItem label="Character" onClick={() => handleMenuItemClick('menu:insert-character')} />
          <MenuItem label="Setting" onClick={() => handleMenuItemClick('menu:insert-setting')} />
          <MenuItem label="World Building" onClick={() => handleMenuItemClick('menu:insert-worldbuilding')} />
          <MenuDivider />
          <MenuItem label="Scene Break" onClick={() => handleMenuItemClick('menu:insert-scene-break')} />
        </Dropdown>
      )}

      {/* View Menu */}
      <MenuButton
        label="View"
        icon={<Eye size={14} />}
        isActive={activeMenu === 'view'}
        onClick={() => handleMenuClick('view')}
      />
      {activeMenu === 'view' && (
        <Dropdown onClose={() => setActiveMenu(null)} left={152}>
          <MenuItem label="Toggle Sidebar" shortcut="Ctrl+B" onClick={() => handleMenuItemClick('menu:toggle-sidebar')} />
          <MenuItem label="Toggle Notes" onClick={() => handleMenuItemClick('menu:toggle-notes')} />
          <MenuItem label="Toggle AI Assistant" shortcut="Ctrl+K" onClick={() => handleMenuItemClick('menu:toggle-ai')} />
          <MenuDivider />
          <MenuItem label="Focus Mode" shortcut="F11" onClick={() => handleMenuItemClick('menu:toggle-focus')} />
        </Dropdown>
      )}

      {/* Tools Menu */}
      <MenuButton
        label="Tools"
        icon={<Settings size={14} />}
        isActive={activeMenu === 'tools'}
        onClick={() => handleMenuClick('tools')}
      />
      {activeMenu === 'tools' && (
        <Dropdown onClose={() => setActiveMenu(null)} left={200}>
          <MenuItem label="Word Count" onClick={() => handleMenuItemClick('menu:word-count')} />
          <MenuItem label="Statistics" onClick={() => handleMenuItemClick('menu:statistics')} />
          <MenuDivider />
          <MenuItem label="Goals" onClick={() => handleMenuItemClick('menu:goals')} />
          <MenuItem label="Tags" onClick={() => handleMenuItemClick('menu:tags')} />
          <MenuDivider />
          <MenuItem label="Drafts" onClick={() => handleMenuItemClick('menu:drafts')} />
          <MenuItem label="Snapshots" onClick={() => handleMenuItemClick('menu:snapshots')} />
          <MenuDivider />
          <MenuItem label="Settings" onClick={() => handleMenuItemClick('menu:settings')} />
        </Dropdown>
      )}

      {/* Help Menu */}
      <MenuButton
        label="Help"
        icon={<HelpCircle size={14} />}
        isActive={activeMenu === 'help'}
        onClick={() => handleMenuClick('help')}
      />
      {activeMenu === 'help' && (
        <Dropdown onClose={() => setActiveMenu(null)} left={256}>
          <MenuItem label="Documentation" onClick={() => handleMenuItemClick('menu:documentation')} />
          <MenuItem label="Keyboard Shortcuts" onClick={() => handleMenuItemClick('menu:shortcuts')} />
          <MenuDivider />
          <MenuItem label="About MythScribe" onClick={() => handleMenuItemClick('menu:about')} />
        </Dropdown>
      )}
    </div>
  );
};

// Menu Button Component
interface MenuButtonProps {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
}

const MenuButton: React.FC<MenuButtonProps> = ({ label, icon, isActive, onClick }) => {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        padding: '4px 12px',
        backgroundColor: isActive || isHovered ? '#37373d' : 'transparent',
        color: '#d4d4d4',
        border: 'none',
        borderRadius: '3px',
        cursor: 'pointer',
        fontSize: '13px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        transition: 'background-color 0.1s'
      }}
    >
      {icon}
      {label}
    </button>
  );
};

// Dropdown Menu Component
interface DropdownProps {
  children: React.ReactNode;
  onClose: () => void;
  left?: number;
}

const Dropdown: React.FC<DropdownProps> = ({ children, onClose, left = 8 }) => {
  return (
    <div
      style={{
        position: 'absolute',
        top: '32px',
        left: `${left}px`,
        minWidth: '220px',
        backgroundColor: '#252526',
        border: '1px solid #454545',
        borderRadius: '4px',
        boxShadow: '0 4px 8px rgba(0,0,0,0.4)',
        padding: '4px 0',
        zIndex: 1001
      }}
      onMouseLeave={onClose}
    >
      {children}
    </div>
  );
};

// Menu Item Component
interface MenuItemProps {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
}

const MenuItem: React.FC<MenuItemProps> = ({ label, shortcut, onClick, disabled = false }) => {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => !disabled && setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      disabled={disabled}
      style={{
        width: '100%',
        padding: '6px 16px',
        backgroundColor: isHovered && !disabled ? '#0e639c' : 'transparent',
        color: disabled ? '#666' : '#d4d4d4',
        border: 'none',
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '13px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        transition: 'background-color 0.1s',
        opacity: disabled ? 0.5 : 1
      }}
    >
      <span>{label}</span>
      {shortcut && (
        <span style={{
          fontSize: '11px',
          color: disabled ? '#555' : '#888',
          marginLeft: '24px'
        }}>
          {shortcut}
        </span>
      )}
    </button>
  );
};

// Menu Divider Component
const MenuDivider: React.FC = () => {
  return (
    <div style={{
      height: '1px',
      backgroundColor: '#454545',
      margin: '4px 0'
    }} />
  );
};

export default MenuBar;
