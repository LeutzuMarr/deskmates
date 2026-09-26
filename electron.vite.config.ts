import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src deskmates-preview: http://127.0.0.1:*; connect-src ws://127.0.0.1:*"
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; frame-src deskmates-preview: http://127.0.0.1:* http://localhost:*; connect-src 'self' ws://127.0.0.1:* ws://localhost:* http://localhost:*"

// The dev server needs inline scripts for React Refresh; the packaged app doesn't.
function contentSecurityPolicy(): Plugin {
  return {
    name: 'deskmates-csp',
    transformIndexHtml: {
      order: 'post',
      handler: (html, ctx) => html.replace('%CSP%', ctx.server ? DEV_CSP : PROD_CSP)
    }
  }
}

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss(), contentSecurityPolicy()]
  }
})
