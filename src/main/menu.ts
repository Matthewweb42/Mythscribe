// src/main/menu.ts
import { Menu, MenuItemConstructorOptions, BrowserWindow, app, dialog } from 'electron';

export function createApplicationMenu(mainWindow: BrowserWindow): Menu {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    // App Menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),

    // File Menu
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow.webContents.send('menu:new-project');
          }
        },
        {
          label: 'Open Project',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow.webContents.send('menu:open-project');
          }
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            mainWindow.webContents.send('menu:save');
          }
        },
        { type: 'separator' },
        {
          label: 'Export',
          submenu: [
            {
              label: 'Export as PDF...',
              click: () => {
                mainWindow.webContents.send('menu:export-pdf');
              }
            },
            {
              label: 'Export as DOCX...',
              click: () => {
                mainWindow.webContents.send('menu:export-docx');
              }
            },
            {
              label: 'Export as EPUB...',
              click: () => {
                mainWindow.webContents.send('menu:export-epub');
              }
            },
            {
              label: 'Export as Markdown...',
              click: () => {
                mainWindow.webContents.send('menu:export-markdown');
              }
            }
          ]
        },
        {
          label: 'Import',
          submenu: [
            {
              label: 'Import Document...',
              click: () => {
                mainWindow.webContents.send('menu:import-document');
              }
            },
            {
              label: 'Import Characters...',
              click: () => {
                mainWindow.webContents.send('menu:import-characters');
              }
            }
          ]
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },

    // Edit Menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const },
              { role: 'delete' as const },
              { role: 'selectAll' as const }
            ]
          : [
              { role: 'delete' as const },
              { type: 'separator' as const },
              { role: 'selectAll' as const }
            ]),
        { type: 'separator' },
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl+F',
          click: () => {
            mainWindow.webContents.send('menu:find');
          }
        },
        {
          label: 'Find and Replace',
          accelerator: 'CmdOrCtrl+H',
          click: () => {
            mainWindow.webContents.send('menu:find-replace');
          }
        }
      ]
    },

    // Insert Menu
    {
      label: 'Insert',
      submenu: [
        {
          label: 'New Scene',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => {
            mainWindow.webContents.send('menu:insert-scene');
          }
        },
        {
          label: 'New Chapter',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => {
            mainWindow.webContents.send('menu:insert-chapter');
          }
        },
        {
          label: 'New Part',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => {
            mainWindow.webContents.send('menu:insert-part');
          }
        },
        { type: 'separator' },
        {
          label: 'New Character',
          click: () => {
            mainWindow.webContents.send('menu:insert-character');
          }
        },
        {
          label: 'New Setting',
          click: () => {
            mainWindow.webContents.send('menu:insert-setting');
          }
        },
        {
          label: 'New World Building Note',
          click: () => {
            mainWindow.webContents.send('menu:insert-worldbuilding');
          }
        },
        { type: 'separator' },
        {
          label: 'Scene Break',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => {
            mainWindow.webContents.send('menu:insert-scene-break');
          }
        }
      ]
    },

    // View Menu
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+\\',
          click: () => {
            mainWindow.webContents.send('menu:toggle-sidebar');
          }
        },
        {
          label: 'Toggle Notes Panel',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => {
            mainWindow.webContents.send('menu:toggle-notes');
          }
        },
        {
          label: 'Toggle AI Assistant',
          accelerator: 'CmdOrCtrl+K',
          click: () => {
            mainWindow.webContents.send('menu:toggle-ai');
          }
        },
        { type: 'separator' },
        {
          label: 'Focus Mode',
          accelerator: 'F11',
          click: () => {
            mainWindow.webContents.send('menu:toggle-focus');
          }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },

    // Tools Menu
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Word Count',
          click: () => {
            mainWindow.webContents.send('menu:word-count');
          }
        },
        {
          label: 'Statistics',
          click: () => {
            mainWindow.webContents.send('menu:statistics');
          }
        },
        { type: 'separator' },
        {
          label: 'Goals & Targets',
          click: () => {
            mainWindow.webContents.send('menu:goals');
          }
        },
        {
          label: 'Tags Manager',
          click: () => {
            mainWindow.webContents.send('menu:tags');
          }
        },
        { type: 'separator' },
        {
          label: 'Draft Manager',
          click: () => {
            mainWindow.webContents.send('menu:drafts');
          }
        },
        {
          label: 'Snapshots',
          click: () => {
            mainWindow.webContents.send('menu:snapshots');
          }
        },
        { type: 'separator' },
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            mainWindow.webContents.send('menu:settings');
          }
        }
      ]
    },

    // Help Menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => {
            mainWindow.webContents.send('menu:documentation');
          }
        },
        {
          label: 'Keyboard Shortcuts',
          click: () => {
            mainWindow.webContents.send('menu:shortcuts');
          }
        },
        { type: 'separator' },
        {
          label: 'About MythScribe',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About MythScribe',
              message: 'MythScribe',
              detail: 'A professional novel writing application.\n\nVersion 1.0.0\n\nBuilt with Electron, React, and TypeScript.'
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  return menu;
}
