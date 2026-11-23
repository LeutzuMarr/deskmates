import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { notesPrecache } from './scripts/notes-precache'

/**
 * The phone web app (Deskmates from anywhere): the same renderer as the desktop app, started by
 * src/remote/bootstrap.ts and talking to the PC through the encrypted relay, plus the notes app
 * (notes.html), a page of its own that works offline. Built to dist-remote and deployed to Vercel
 * as static files.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  publicDir: resolve(__dirname, 'src/renderer/remote-public'),
  plugins: [
    react(),
    tailwindcss(),
    notesPrecache({
      entryHtml: 'notes.html',
      pageUrl: '/notes',
      extra: ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png'],
      template: resolve(__dirname, 'src/renderer/sw/sw.js')
    })
  ],
  build: {
    outDir: resolve(__dirname, 'dist-remote'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/remote.html'),
        notes: resolve(__dirname, 'src/renderer/notes.html')
      }
    }
  }
})
