// // src/components/WritingEnvironment/hooks/useWritingGoals.ts
// import { useState, useEffect, useCallback } from 'react';

// export const useWritingGoals = () => {
//   const [goals, setGoals] = useState({
//     dailyWordGoal: 1000,
//     sessionStartTime: null as Date | null,
//     wordCount: 0,
//     sessionDuration: 0
//   });

//   // ... (previous implementation of methods)

//   return {
//     goals,
//     startWritingSession,
//     updateWordCount,
//     setDailyWordGoal
//   };
// };