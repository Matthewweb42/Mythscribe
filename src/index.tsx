// index.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Import fonts (you would typically include this in your HTML head or use a solution like react-helmet)
// Note: In a real project, you might want to use a better way to manage fonts like using Next.js built-in font handling
// or other solutions like react-helmet or importing in your CSS file

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);