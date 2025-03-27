// src/components/WritingEnvironment/index.tsx
import React, { useMemo } from 'react';
import { Toolbar } from './Toolbar';
import { TextEditor } from './TextEditor';
import { GoalTracker } from './GoalTracker';
import { useDocumentManager } from './hooks/useDocumentManager';
import { useWritingGoals } from './hooks/useWritingGoals';

export const WritingEnvironment: React.FC = () => {
  const documentManager = useDocumentManager();
  const writingGoals = useWritingGoals();

  // Apply theme and styling
  const environmentStyles = useMemo(() => ({
    fontFamily: documentManager.settings.font,
    fontSize: `${documentManager.settings.fontSize}px`,
    backgroundColor: documentManager.settings.theme === 'dark' ? '#121212' : '#ffffff',
    color: documentManager.settings.theme === 'dark' ? '#ffffff' : '#000000'
  }), [documentManager.settings]);

  // Handle content changes
  const handleContentChange = (newContent: string) => {
    documentManager.updateContent(newContent);
    writingGoals.updateWordCount(newContent);
  };

  return (
    <div 
      className="writing-environment"
      style={environmentStyles}
    >
      <Toolbar 
        settings={documentManager.settings}
        onSettingsUpdate={documentManager.updateSettings}
      />
      
      <TextEditor 
        content={documentManager.document.content}
        onContentChange={handleContentChange}
        settings={documentManager.settings}
      />
      
      <GoalTracker 
        goals={writingGoals.goals}
        onStartSession={writingGoals.startWritingSession}
        onSetGoal={writingGoals.setDailyWordGoal}
      />
    </div>
  );
};

export default WritingEnvironment;