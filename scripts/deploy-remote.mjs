// Builds the phone web app and deploys it to Vercel as static files. The Vercel project link is
// kept in .vercel-remote/ (the build folder is wiped on every build), and no .env file is ever
// uploaded with the site.
import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const out = join(root, 'dist-remote')
execSync('npx vite build -c vite.remote.config.ts', { cwd: root, stdio: 'inherit' })
// The page is built from remote.html; served as the site's index.
renameSync(join(out, 'remote.html'), join(out, 'index.html'))
mkdirSync(join(out, '.vercel'), { recursive: true })
cpSync(join(root, '.vercel-remote', 'project.json'), join(out, '.vercel', 'project.json'))
for (const name of readdirSync(out)) if (name.startsWith('.env')) rmSync(join(out, name), { force: true })
execSync('npx --yes vercel@latest deploy --prod --yes', { cwd: out, stdio: 'inherit' })
for (const name of readdirSync(out)) if (name.startsWith('.env')) rmSync(join(out, name), { force: true })
