import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'
import '@fontsource-variable/source-serif-4/opsz.css'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)