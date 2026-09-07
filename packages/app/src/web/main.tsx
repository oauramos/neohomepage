import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

const root = document.getElementById('neo-root')
if (!root) throw new Error('#neo-root missing from the document')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
