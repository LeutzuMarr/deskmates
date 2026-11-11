import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'
import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/newsreader/opsz-italic.css'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/instrument-sans/wght-italic.css'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import './styles/glass.css'
import './styles/sidebar.css'
import './styles/marks.css'
import { App } from './App'
import { applyTheme, getPrefs } from './lib/prefs'

applyTheme(getPrefs().theme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)