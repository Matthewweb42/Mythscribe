import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { listenForRendererErrors } from './features/diagnostics/rendererErrors'
import { App } from './app/App'
import './styles/app.css'

// F-15.8: an uncaught error or unhandled rejection anywhere in this window goes to main, which
// keeps it only while diagnostics are on. Installed before React mounts, so a failure during the
// first render is reported too.
listenForRendererErrors()

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
