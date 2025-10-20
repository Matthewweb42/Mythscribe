// src/renderer/src/App.tsx
import MainLayout from './components/Layout/MainLayout';
import { ProjectProvider } from './contexts/ProjectContext';
import { NotificationProvider } from './contexts/NotificationContext';

function App() {
  return (
    <NotificationProvider>
      <ProjectProvider>
        <MainLayout />
      </ProjectProvider>
    </NotificationProvider>
  );
}

export default App;