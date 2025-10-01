// src/renderer/src/App.tsx
import MainLayout from './components/Layout/MainLayout';
import { ProjectProvider } from './contexts/ProjectContext';

function App() {
  return (
    <ProjectProvider>
      <MainLayout />
    </ProjectProvider>
  );
}

export default App;